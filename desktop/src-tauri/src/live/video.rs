//! Video stage: continuous Windows Graphics Capture of a window or monitor, GPU conversion to
//! NV12 (scaled to the requested height), and the hardware H.264 encoder (NVENC / AMF / Quick
//! Sync through Media Foundation), producing [`EncodedVideo`] for the sender.
//!
//! Everything stays on the GPU: WGC hands us BGRA textures, the D3D11 video processor scales and
//! converts them straight into the encoder's input textures, and the async hardware MFT encodes
//! from those. One thread runs capture, pacing and encoder input; a second one services the
//! encoder's events and sends its output.
//!
//! Pacing: frames go out at most `fps` times a second. A frame that arrives early is held and
//! replaced by newer ones until its slot comes; when the source stops drawing (WGC only delivers
//! on change), the last frame is sent again each slot so the stream never stalls.
//!
//! Simulcast layers are scaled from the captured frame by their own video processor pass and
//! encoded by their own encoder; lower layers take a subset of the full layer's frames.
//!
//! The encoded size is fixed per encoder. When the source is resized, the new picture is fitted
//! (letterboxed) into the old size at once, and the encoder is rebuilt at the new size once the
//! size has held still for [`RESIZE_SETTLE`].

use super::{Clock, EncodedVideo, KeyframeRequests, Source, Stage, VideoSettings, VideoTx};
#[cfg(windows)]
use super::{bitrate_kbps, layer_fps, layer_size};

/// Starts capturing and encoding, one encoder per simulcast layer. Encoded frames go to `tx`; an
/// IDR frame is produced on the requested layer (or all) as soon as possible after each message on
/// `keyframes`, and at least every 2 seconds regardless.
/// Errors before the thread starts (bad source, no encoder) are returned here; later failures
/// end the stage and drop `tx`, which the sender sees as the stream ending.
pub fn start(source: Source, settings: VideoSettings, clock: Clock, tx: VideoTx, keyframes: KeyframeRequests) -> Result<Stage, String> {
    if settings.fps == 0 || settings.bitrate_kbps == 0 {
        return Err("video settings need a frame rate and a bitrate".into());
    }
    imp::start(source, settings, clock, tx, keyframes)
}

/// H.264 encoders top out at 4096 on either side.
const MAX_SIDE: u32 = 4096;
const MIN_SIDE: u32 = 64;
/// How long a new source size must hold before the encoder is rebuilt for it.
#[cfg_attr(not(windows), allow(dead_code))]
const RESIZE_SETTLE: std::time::Duration = std::time::Duration::from_millis(500);
/// Longest gap between IDR frames.
#[cfg_attr(not(windows), allow(dead_code))]
const IDR_INTERVAL_US: u64 = 2_000_000;

/// Encoded size for a source of `w`×`h`: `target_h` tall (0, or taller than the source, means the
/// source height; never upscaled), the source's aspect ratio, even sides, within encoder limits.
fn output_size(w: u32, h: u32, target_h: u32) -> (u32, u32) {
    let (w, h) = (w.max(1) as u64, h.max(1) as u64);
    let mut oh = if target_h == 0 { h } else { (target_h as u64).min(h) };
    let mut ow = (w * oh + h / 2) / h;
    let max = MAX_SIDE as u64;
    if ow > max {
        oh = oh * max / ow;
        ow = max;
    }
    if oh > max {
        ow = ow * max / oh;
        oh = max;
    }
    let even = |v: u64| ((v as u32) & !1).clamp(MIN_SIDE, MAX_SIDE);
    (even(ow), even(oh))
}

/// Where a `w`×`h` picture lands when fitted, aspect kept and centred, into `ow`×`oh`:
/// (left, top, right, bottom).
#[cfg_attr(not(windows), allow(dead_code))]
fn fit(w: u32, h: u32, ow: u32, oh: u32) -> (i32, i32, i32, i32) {
    let (w, h) = (w.max(1) as u64, h.max(1) as u64);
    let (ow64, oh64) = (ow as u64, oh as u64);
    let (dw, dh) = if w * oh64 > h * ow64 { (ow64, (h * ow64 / w).max(2)) } else { ((w * oh64 / h).max(2), oh64) };
    let x = ((ow64 - dw) / 2) & !1;
    let y = ((oh64 - dh) / 2) & !1;
    (x as i32, y as i32, (x + dw) as i32, (y + dh) as i32)
}

/// The NAL units of an Annex B buffer, each without its start code.
#[cfg_attr(not(windows), allow(dead_code))]
fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new(); // (start code position, payload position)
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            let code = if i > 0 && data[i - 1] == 0 { i - 1 } else { i };
            starts.push((code, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut units = Vec::with_capacity(starts.len());
    for (n, &(_, payload)) in starts.iter().enumerate() {
        let end = starts.get(n + 1).map_or(data.len(), |&(code, _)| code);
        if end > payload {
            units.push(&data[payload..end]);
        }
    }
    units
}

/// Normalizes one encoder output into the access unit the contract promises: every IDR is
/// preceded by SPS and PPS (cached from the last time the encoder emitted them, or from the
/// output type's sequence header). Returns the data and whether it holds an IDR.
#[cfg_attr(not(windows), allow(dead_code))]
fn annex_b(data: Vec<u8>, params: &mut Vec<u8>) -> (Vec<u8>, bool) {
    let units = nal_units(&data);
    let types = || units.iter().map(|u| u[0] & 0x1f);
    let idr = types().any(|t| t == 5);
    let has_sps = types().any(|t| t == 7);
    if has_sps {
        let fresh = parameter_sets(&data);
        if !fresh.is_empty() {
            *params = fresh;
        }
        return (data, idr);
    }
    if idr && !params.is_empty() {
        let mut out = Vec::with_capacity(params.len() + data.len());
        out.extend_from_slice(params);
        out.extend_from_slice(&data);
        return (out, idr);
    }
    (data, idr)
}

/// The SPS and PPS NAL units of an Annex B buffer, re-joined with 4-byte start codes.
#[cfg_attr(not(windows), allow(dead_code))]
fn parameter_sets(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for unit in nal_units(data) {
        if matches!(unit[0] & 0x1f, 7 | 8) {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(unit);
        }
    }
    out
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::mem::ManuallyDrop;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::mpsc::{self, TrySendError};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};
    use windows::core::{factory, Interface, GUID, PCWSTR, PWSTR};
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Capture::{
        Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind, GraphicsCaptureItem,
        GraphicsCaptureSession,
    };
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Graphics::SizeInt32;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, HWND, RECT, VARIANT_BOOL};
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN};
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_RATIONAL};
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIDevice, IDXGIFactory1};
    use windows::Win32::Graphics::Gdi::HMONITOR;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        CreateEventW, CreateWaitableTimerExW, SetEvent, SetWaitableTimer, WaitForMultipleObjects, WaitForSingleObject,
        CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS,
    };
    use windows::Win32::System::Variant::{VARIANT, VT_BOOL, VT_UI4};
    use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    type WinResult<T> = windows::core::Result<T>;

    /// Frame pool depth: one frame is held for pacing/repeats, the rest keep WGC drawing.
    const POOL_BUFFERS: i32 = 3;
    const PIXEL_FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;

    /// Moves a COM pointer to another thread. Media Foundation and D3D11 (multithread-protected)
    /// objects are free-threaded; windows-rs just can't know that.
    struct Unsend<T>(T);
    unsafe impl<T> Send for Unsend<T> {}

    /// A Win32 event or timer handle, shareable with event handlers and the encoder thread.
    #[derive(Clone, Copy)]
    struct Handle(usize);
    impl Handle {
        fn get(self) -> HANDLE {
            HANDLE(self.0 as _)
        }
    }

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn err(what: &str) -> impl Fn(windows::core::Error) -> String + '_ {
        move |e| format!("{what}: {}", e.message().trim_end().to_owned() + &format!(" ({:#010x})", e.code().0))
    }

    pub fn start(source: Source, settings: VideoSettings, clock: Clock, tx: VideoTx, keyframes: KeyframeRequests) -> Result<Stage, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
        let stage = Stage::spawn("live-video", move |stop| {
            let mut ready = Some(ready_tx);
            if let Err(e) = unsafe { run(source, settings, clock, tx, keyframes, &stop, &mut ready) } {
                match ready.take() {
                    Some(ready) => {
                        let _ = ready.send(Err(e));
                    }
                    None => eprintln!("live video: {e}"),
                }
            }
        })
        .map_err(|e| e.to_string())?;
        match ready_rx.recv() {
            Ok(Ok(_encoder)) => Ok(stage),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("the video stage stopped while starting".into()),
        }
    }

    unsafe fn run(
        source: Source,
        settings: VideoSettings,
        clock: Clock,
        tx: VideoTx,
        keyframes: KeyframeRequests,
        stop: &AtomicBool,
        ready: &mut Option<mpsc::Sender<Result<String, String>>>,
    ) -> Result<(), String> {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_LITE).map_err(err("Media Foundation"))?;
        // Every COM object lives inside `pipeline`, so all are released before MFShutdown.
        let result = pipeline(source, settings, clock, tx, keyframes, stop, ready);
        let _ = MFShutdown();
        result
    }

    unsafe fn pipeline(
        source: Source,
        settings: VideoSettings,
        clock: Clock,
        tx: VideoTx,
        keyframes: KeyframeRequests,
        stop: &AtomicBool,
        ready: &mut Option<mpsc::Sender<Result<String, String>>>,
    ) -> Result<(), String> {
        request_borderless();
        let wake = OwnedHandle(CreateEventW(None, false, false, PCWSTR::null()).map_err(err("event"))?);
        let timer = OwnedHandle(
            CreateWaitableTimerExW(None, PCWSTR::null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0)
                .or_else(|_| CreateWaitableTimerExW(None, PCWSTR::null(), 0, TIMER_ALL_ACCESS.0))
                .map_err(err("timer"))?,
        );
        let wake_h = Handle(wake.0 .0 as usize);

        let item = capture_item(source)?;
        let size = item.Size().map_err(err("capture item size"))?;
        let initial = output_size(size.Width as u32, size.Height as u32, settings.height);

        // The first hardware encoder that accepts our settings wins; the D3D device is created on
        // its adapter so capture, conversion and encoding share one GPU.
        let encoders = hardware_encoders()?;
        if encoders.is_empty() {
            return Err("No hardware H.264 encoder (NVENC, AMF or Quick Sync) is available on this PC.".into());
        }
        let mut failures = Vec::new();
        let mut chosen = None;
        for candidate in encoders {
            let gpu = match Gpu::new(candidate.luid) {
                Ok(gpu) => gpu,
                Err(e) => {
                    failures.push(format!("{}: {e}", candidate.name));
                    continue;
                }
            };
            match Encoder::new(candidate.activate.clone(), &gpu, initial, settings, 0, clock, tx.clone(), wake_h) {
                Ok(encoder) => {
                    chosen = Some((candidate, gpu, encoder));
                    break;
                }
                Err(e) => failures.push(format!("{}: {e}", candidate.name)),
            }
        }
        let Some((candidate, gpu, encoder)) = chosen else {
            return Err(format!("No hardware H.264 encoder could be started ({})", failures.join("; ")));
        };
        let count = settings.layer_count();
        let mut layers: Vec<Layer> = (0..count).map(|i| Layer::new(i, layer_fps(settings.fps, i))).collect();
        layers[0].encoder = Some(encoder);
        for layer in &mut layers[1..] {
            layer.start_lower(&candidate, &gpu, initial, settings, count, clock, &tx, wake_h);
        }
        let mut capture = Capture::new(item, &gpu, size, source, wake_h)?;
        if let Some(ready) = ready.take() {
            let _ = ready.send(Ok(candidate.name.clone()));
        }

        let fps = settings.fps as u64;
        let interval = 1_000_000 / fps;
        let early = interval / 4; // a fresh frame may go this much before its slot
        let grace = interval / 2; // wait this long past a slot for a fresh frame before repeating

        let mut held: Option<Held> = None;
        let mut dirty = false; // `held` hasn't been sent yet
        let mut slot = 0u64; // session time of the last sent slot
        let mut sent_any = false;
        let mut last_pts = 0u64;
        let mut pending_size: Option<((u32, u32), Instant)> = None;

        let result = 'main: loop {
            if stop.load(Ordering::Relaxed) {
                break Ok(());
            }
            if capture.closed() {
                break Ok(());
            }
            let ended = layers.iter().filter_map(|l| l.encoder.as_ref()).find_map(|e| match e.failure() {
                Some(error) => Some(Err(error)),
                None => e.shared.closed.load(Ordering::Relaxed).then_some(Ok(())),
            });
            if let Some(ended) = ended {
                break ended;
            }

            // Newest frame wins; older ones go straight back to the pool.
            let mut newest = None;
            while let Ok(frame) = capture.pool.TryGetNextFrame() {
                if let Some(old) = newest.replace(frame) {
                    let _ = old.Close();
                }
            }
            if let Some(frame) = newest {
                match Held::new(frame, &clock) {
                    Ok(frame) => {
                        if let Err(e) = capture.fit_pool(frame.content) {
                            break Err(e);
                        }
                        if let Some(old) = held.replace(frame) {
                            let _ = old.frame.Close();
                        }
                        dirty = true;
                    }
                    Err(e) => eprintln!("live video: dropped a frame: {e}"),
                }
            }
            while let Ok(request) = keyframes.try_recv() {
                for layer in &mut layers {
                    if request.is_none_or(|i| i == layer.index) {
                        layer.want_key = true;
                    }
                }
            }

            let mut blocked = false;
            if let Some(frame) = &held {
                // Follow the source size: letterbox at once, re-encode at the new size once it settles.
                let wanted = output_size(frame.content.0, frame.content.1, settings.height);
                if Some(wanted) != layers[0].size() {
                    let settled = match pending_size {
                        Some((size, since)) if size == wanted => since.elapsed() >= RESIZE_SETTLE,
                        _ => {
                            pending_size = Some((wanted, Instant::now()));
                            false
                        }
                    };
                    if settled || !sent_any {
                        // All old encoders go first: drivers cap how many can run at once.
                        for layer in &mut layers {
                            layer.stop();
                        }
                        let encoder = match Encoder::new(candidate.activate.clone(), &gpu, wanted, settings, 0, clock, tx.clone(), wake_h) {
                            Ok(encoder) => encoder,
                            Err(e) => return Err(format!("restarting the encoder at {}x{}: {e}", wanted.0, wanted.1)),
                        };
                        layers[0].encoder = Some(encoder);
                        for layer in &mut layers[1..] {
                            layer.start_lower(&candidate, &gpu, wanted, settings, count, clock, &tx, wake_h);
                        }
                        pending_size = None;
                    }
                } else {
                    pending_size = None;
                }

                let now = clock.now_us();
                let due = if dirty { (slot + interval).saturating_sub(early) } else { slot + interval + grace };
                if !sent_any || now >= due {
                    let pts = if dirty { frame.pts } else { now }.max(last_pts + 1);
                    let (full, lower) = layers.split_at_mut(1);
                    match full[0].submit(&gpu, frame, pts) {
                        Ok(true) => {
                            dirty = false;
                            slot = if !sent_any || now > slot + 2 * interval { now } else { slot + interval };
                            sent_any = true;
                            last_pts = pts;
                            // Lower layers take every frame their own rate has room for.
                            for layer in lower.iter_mut().filter(|l| l.interval <= interval || pts + interval / 2 >= l.next_due) {
                                match layer.submit(&gpu, frame, pts) {
                                    Ok(true) => {
                                        layer.next_due = if pts > layer.next_due + layer.interval { pts + layer.interval } else { layer.next_due + layer.interval };
                                    }
                                    Ok(false) => {} // busy; it skips this frame
                                    Err(e) => break 'main Err(e),
                                }
                            }
                        }
                        Ok(false) => blocked = true, // encoder busy; NeedInput will wake us
                        Err(e) => break Err(e),
                    }
                }
            }

            // Sleep until the next slot, a new frame, or the encoder asking for input.
            if blocked {
                WaitForSingleObject(wake.0, 5);
                continue;
            }
            let wait_ms = match &held {
                Some(_) => {
                    let due = if dirty { (slot + interval).saturating_sub(early) } else { slot + interval + grace };
                    let wait_us = due.saturating_sub(clock.now_us()).max(1) as i64;
                    let rel = -(wait_us * 10);
                    let _ = SetWaitableTimer(timer.0, &rel, 0, None, None, false);
                    100
                }
                None => {
                    let rel = -(100 * 10_000i64);
                    let _ = SetWaitableTimer(timer.0, &rel, 0, None, None, false);
                    100
                }
            };
            WaitForMultipleObjects(&[wake.0, timer.0], false, wait_ms);
        };

        if let Some(frame) = held.take() {
            let _ = frame.frame.Close();
        }
        drop(capture);
        drop(layers); // drains what's in flight
        let _ = candidate.activate.ShutdownObject();
        result
    }

    /// One simulcast layer: the converter that scales into it, its encoder (rebuilt at each new
    /// source size) and its own keyframe and frame-rate bookkeeping.
    struct Layer {
        index: usize,
        fps: u32,
        interval: u64,
        converter: Option<Converter>,
        /// None while restarting, and for a lower layer whose encoder couldn't start.
        encoder: Option<Encoder>,
        sent_any: bool,
        want_key: bool,
        last_forced: u64,
        /// Lower layers: session time from which the next frame may go.
        next_due: u64,
    }

    impl Layer {
        fn new(index: usize, fps: u32) -> Layer {
            let interval = 1_000_000 / fps.max(1) as u64;
            Layer { index, fps, interval, converter: None, encoder: None, sent_any: false, want_key: false, last_forced: 0, next_due: 0 }
        }

        fn size(&self) -> Option<(u32, u32)> {
            self.encoder.as_ref().map(|e| e.size)
        }

        fn stop(&mut self) {
            self.converter = None;
            self.encoder = None;
            self.sent_any = false;
            self.last_forced = 0;
            self.next_due = 0;
        }

        /// Starts a lower layer's encoder for a full layer of `full`. A layer that can't start
        /// (some drivers cap concurrent encoders) is left out; viewers asking for it get another.
        #[allow(clippy::too_many_arguments)]
        unsafe fn start_lower(&mut self, candidate: &Candidate, gpu: &Gpu, full: (u32, u32), settings: VideoSettings, count: usize, clock: Clock, tx: &VideoTx, wake: Handle) {
            let size = layer_size(full, self.index, count);
            let size = (size.0.max(MIN_SIDE), size.1.max(MIN_SIDE));
            let layer_settings = VideoSettings { fps: self.fps, bitrate_kbps: bitrate_kbps(size.1, self.fps).min(settings.bitrate_kbps), ..settings };
            let started = twin(candidate).and_then(|activate| Encoder::new(activate, gpu, size, layer_settings, self.index, clock, tx.clone(), wake));
            match started {
                Ok(encoder) => self.encoder = Some(encoder),
                Err(e) => eprintln!("live video: layer {} ({}x{}) is off: {e}", self.index, size.0, size.1),
            }
        }

        /// Converts `frame` into this layer's encoder. `Ok(false)` when the encoder isn't ready
        /// for more input yet.
        unsafe fn submit(&mut self, gpu: &Gpu, frame: &Held, pts: u64) -> Result<bool, String> {
            let Some(encoder) = &mut self.encoder else { return Ok(false) };
            let since_idr = pts.saturating_sub(encoder.shared.last_idr_us.load(Ordering::Relaxed).max(self.last_forced));
            let force = self.want_key || (self.sent_any && since_idr + self.interval / 2 >= IDR_INTERVAL_US);
            let conv = match &mut self.converter {
                Some(c) if c.matches(&frame.texture_size, encoder.size) => c,
                _ => self.converter.insert(Converter::new(gpu, frame.texture_size, encoder.size, self.fps)?),
            };
            let queued = encoder.submit(gpu, conv, frame, pts, self.interval, force)?;
            if queued {
                if force {
                    self.want_key = false;
                    self.last_forced = pts;
                }
                self.sent_any = true;
            }
            Ok(queued)
        }
    }

    /// A separate activation object for the same encoder: activating one object twice hands back
    /// the same MFT, and every layer needs one of its own.
    unsafe fn twin(candidate: &Candidate) -> Result<IMFActivate, String> {
        hardware_encoders()?
            .into_iter()
            .find(|c| c.name == candidate.name && c.luid == candidate.luid)
            .map(|c| c.activate)
            .ok_or_else(|| format!("{} is no longer available", candidate.name))
    }

    // Windows only honours `IsBorderRequired = false` once borderless access has been requested;
    // unpackaged desktop apps are granted it without a prompt.
    fn request_borderless() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            if let Ok(op) = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
                let _ = op.get();
            }
        });
    }

    unsafe fn capture_item(source: Source) -> Result<GraphicsCaptureItem, String> {
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(err("capture"))?;
        match source {
            Source::Window { id, .. } => {
                let hwnd = HWND(id as _);
                if !IsWindow(Some(hwnd)).as_bool() {
                    return Err("That window has closed.".into());
                }
                interop.CreateForWindow(hwnd).map_err(err("capturing the window"))
            }
            Source::Monitor { id } => interop.CreateForMonitor(HMONITOR(id as _)).map_err(err("capturing the screen")),
        }
    }

    /// The D3D11 device everything runs on, multithread-protected because the encoder uses it
    /// from its own threads.
    struct Gpu {
        // Held so the device outlives everything created from it.
        #[allow(dead_code)]
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        winrt: IDirect3DDevice,
        manager: IMFDXGIDeviceManager,
        video: ID3D11VideoDevice,
        video_context: ID3D11VideoContext1,
    }

    impl Gpu {
        unsafe fn new(luid: Option<u64>) -> Result<Gpu, String> {
            let adapter = luid.and_then(|luid| adapter_for(luid));
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                adapter.as_ref(),
                if adapter.is_some() { D3D_DRIVER_TYPE_UNKNOWN } else { D3D_DRIVER_TYPE_HARDWARE },
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(err("creating the D3D11 device"))?;
            let (device, context): (ID3D11Device, ID3D11DeviceContext) = (device.unwrap(), context.unwrap());
            let _ = context.cast::<ID3D11Multithread>().map_err(err("D3D11 multithreading"))?.SetMultithreadProtected(true);
            let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>().map_err(err("DXGI device"))?)
                .and_then(|d| d.cast())
                .map_err(err("WinRT device"))?;
            let mut token = 0u32;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager).map_err(err("DXGI device manager"))?;
            let manager = manager.unwrap();
            manager.ResetDevice(&device, token).map_err(err("DXGI device manager"))?;
            let video = device.cast::<ID3D11VideoDevice>().map_err(err("D3D11 video device"))?;
            let video_context = context.cast::<ID3D11VideoContext1>().map_err(err("D3D11 video context"))?;
            Ok(Gpu { device, context, winrt, manager, video, video_context })
        }
    }

    unsafe fn adapter_for(luid: u64) -> Option<IDXGIAdapter> {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        for i in 0.. {
            let adapter = factory.EnumAdapters1(i).ok()?;
            let desc = adapter.GetDesc1().ok()?;
            let id = ((desc.AdapterLuid.HighPart as u32 as u64) << 32) | desc.AdapterLuid.LowPart as u64;
            if id == luid {
                return adapter.cast().ok();
            }
        }
        None
    }

    struct Candidate {
        activate: IMFActivate,
        name: String,
        luid: Option<u64>,
    }

    unsafe fn hardware_encoders() -> Result<Vec<Candidate>, String> {
        let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
        let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &mut list,
            &mut count,
        )
        .map_err(err("listing H.264 encoders"))?;
        if list.is_null() {
            return Ok(Vec::new());
        }
        let found = std::slice::from_raw_parts_mut(list, count as usize)
            .iter_mut()
            .filter_map(|a| a.take())
            .map(|activate| {
                let name = attribute_string(&activate, &MFT_FRIENDLY_NAME_Attribute).unwrap_or_else(|| "hardware encoder".into());
                let luid = activate.GetUINT64(&MFT_ENUM_ADAPTER_LUID).ok();
                Candidate { activate, name, luid }
            })
            .collect();
        CoTaskMemFree(Some(list as _));
        Ok(found)
    }

    unsafe fn attribute_string(attrs: &IMFActivate, key: &GUID) -> Option<String> {
        let mut value = PWSTR::null();
        let mut len = 0u32;
        attrs.GetAllocatedString(key, &mut value, &mut len).ok()?;
        let s = value.to_string().ok();
        CoTaskMemFree(Some(value.0 as _));
        s
    }

    /// The continuous capture session; `FrameArrived` and `Closed` just poke the stage's wake event.
    struct Capture {
        item: GraphicsCaptureItem,
        pool: Direct3D11CaptureFramePool,
        session: GraphicsCaptureSession,
        winrt: IDirect3DDevice,
        pool_size: SizeInt32,
        hwnd: Option<HWND>,
        closed: Arc<AtomicBool>,
        tokens: (i64, i64),
    }

    impl Capture {
        unsafe fn new(item: GraphicsCaptureItem, gpu: &Gpu, size: SizeInt32, source: Source, wake: Handle) -> Result<Capture, String> {
            let size = SizeInt32 { Width: size.Width.max(1), Height: size.Height.max(1) };
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&gpu.winrt, PIXEL_FORMAT, POOL_BUFFERS, size).map_err(err("frame pool"))?;
            let arrived = pool
                .FrameArrived(&TypedEventHandler::new(move |_, _| {
                    let _ = SetEvent(wake.get());
                    Ok(())
                }))
                .map_err(err("frame pool"))?;
            let closed = Arc::new(AtomicBool::new(false));
            let flag = closed.clone();
            let closed_token = item
                .Closed(&TypedEventHandler::new(move |_, _| {
                    flag.store(true, Ordering::Relaxed);
                    let _ = SetEvent(wake.get());
                    Ok(())
                }))
                .map_err(err("capture item"))?;
            let session = pool.CreateCaptureSession(&item).map_err(err("capture session"))?;
            let _ = session.SetIsBorderRequired(false);
            let _ = session.SetIsCursorCaptureEnabled(true);
            // WGC throttles to 50 fps unless told otherwise (Windows 11); pacing happens here instead.
            let _ = session.SetMinUpdateInterval(windows::Foundation::TimeSpan { Duration: 10_000 });
            // Menus and dialogs the app opens show up in a window share too (Windows 11).
            let _ = session.SetIncludeSecondaryWindows(true);
            session.StartCapture().map_err(err("starting capture"))?;
            let hwnd = match source {
                Source::Window { id, .. } => Some(HWND(id as _)),
                Source::Monitor { .. } => None,
            };
            Ok(Capture { item, pool, session, winrt: gpu.winrt.clone(), pool_size: size, hwnd, closed, tokens: (arrived, closed_token) })
        }

        fn closed(&self) -> bool {
            self.closed.load(Ordering::Relaxed) || self.hwnd.is_some_and(|hwnd| unsafe { !IsWindow(Some(hwnd)).as_bool() })
        }

        /// Resizes the pool's buffers to the window's new size, so the next frames are whole.
        fn fit_pool(&mut self, content: (u32, u32)) -> Result<(), String> {
            let size = SizeInt32 { Width: content.0 as i32, Height: content.1 as i32 };
            if size == self.pool_size {
                return Ok(());
            }

            self.pool.Recreate(&self.winrt, PIXEL_FORMAT, POOL_BUFFERS, size).map_err(err("resizing the frame pool"))?;
            self.pool_size = size;
            Ok(())
        }
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            let _ = self.pool.RemoveFrameArrived(self.tokens.0);
            let _ = self.item.RemoveClosed(self.tokens.1);
            let _ = self.session.Close();
            let _ = self.pool.Close();
        }
    }

    /// The newest captured frame, kept (out of the pool) until it's replaced, so it can be sent
    /// when its slot comes and sent again while the source is still.
    struct Held {
        frame: Direct3D11CaptureFrame,
        texture: ID3D11Texture2D,
        texture_size: (u32, u32),
        /// The drawn part of the texture (smaller or larger than it while a window is resizing).
        content: (u32, u32),
        pts: u64,
    }

    impl Held {
        fn new(frame: Direct3D11CaptureFrame, clock: &Clock) -> Result<Held, String> {
            let result = (|| unsafe {
                let content = frame.ContentSize()?;
                let texture: ID3D11Texture2D = frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                let pts = clock.hns_to_us(frame.SystemRelativeTime()?.Duration);
                Ok::<_, windows::core::Error>((content, texture, desc, pts))
            })();
            match result {
                Ok((content, texture, desc, pts)) => Ok(Held {
                    frame,
                    texture,
                    texture_size: (desc.Width, desc.Height),
                    content: (content.Width.max(1) as u32, content.Height.max(1) as u32),
                    pts,
                }),
                Err(e) => {
                    let _ = frame.Close();
                    Err(err("reading a frame")(e))
                }
            }
        }
    }

    /// BGRA (any size) → NV12 (encoder size) on the GPU's video processor.
    struct Converter {
        processor: ID3D11VideoProcessor,
        enumerator: ID3D11VideoProcessorEnumerator,
        input_size: (u32, u32),
        output_size: (u32, u32),
        inputs: HashMap<usize, ID3D11VideoProcessorInputView>,
        outputs: HashMap<(usize, u32), ID3D11VideoProcessorOutputView>,
    }

    impl Converter {
        unsafe fn new(gpu: &Gpu, input_size: (u32, u32), output_size: (u32, u32), fps: u32) -> Result<Converter, String> {
            let rate = DXGI_RATIONAL { Numerator: fps, Denominator: 1 };
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: input_size.0,
                InputHeight: input_size.1,
                OutputFrameRate: rate,
                OutputWidth: output_size.0,
                OutputHeight: output_size.1,
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
            };
            let enumerator = gpu.video.CreateVideoProcessorEnumerator(&desc).map_err(err("video processor"))?;
            let processor = gpu.video.CreateVideoProcessor(&enumerator, 0).map_err(err("video processor"))?;
            let vc = &gpu.video_context;
            vc.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            vc.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            vc.VideoProcessorSetStreamColorSpace1(&processor, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
            vc.VideoProcessorSetOutputColorSpace1(&processor, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
            let black = D3D11_VIDEO_COLOR { Anonymous: D3D11_VIDEO_COLOR_0 { RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.0, G: 0.0, B: 0.0, A: 1.0 } } };
            vc.VideoProcessorSetOutputBackgroundColor(&processor, false, &black);
            let full = RECT { left: 0, top: 0, right: output_size.0 as i32, bottom: output_size.1 as i32 };
            vc.VideoProcessorSetOutputTargetRect(&processor, true, Some(&full));
            Ok(Converter { processor, enumerator, input_size, output_size, inputs: HashMap::new(), outputs: HashMap::new() })
        }

        fn matches(&self, input_size: &(u32, u32), output_size: (u32, u32)) -> bool {
            self.input_size == *input_size && self.output_size == output_size
        }

        unsafe fn convert(&mut self, gpu: &Gpu, frame: &Held, target: &ID3D11Texture2D, subresource: u32) -> Result<(), String> {
            let key = frame.texture.as_raw() as usize;
            if !self.inputs.contains_key(&key) {
                if self.inputs.len() >= 8 {
                    self.inputs.clear(); // the pool was recreated; drop views of its old buffers
                }
                let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    FourCC: 0,
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
                };
                let mut view = None;
                gpu.video.CreateVideoProcessorInputView(&frame.texture, &self.enumerator, &desc, Some(&mut view)).map_err(err("video processor input"))?;
                self.inputs.insert(key, view.unwrap());
            }
            let okey = (target.as_raw() as usize, subresource);
            if !self.outputs.contains_key(&okey) {
                let mut tdesc = D3D11_TEXTURE2D_DESC::default();
                target.GetDesc(&mut tdesc);
                let desc = if tdesc.ArraySize > 1 {
                    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
                        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                            Texture2DArray: D3D11_TEX2D_ARRAY_VPOV { MipSlice: 0, FirstArraySlice: subresource, ArraySize: 1 },
                        },
                    }
                } else {
                    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
                    }
                };
                let mut view = None;
                gpu.video.CreateVideoProcessorOutputView(target, &self.enumerator, &desc, Some(&mut view)).map_err(err("video processor output"))?;
                self.outputs.insert(okey, view.unwrap());
            }
            let input = &self.inputs[&key];
            let output = &self.outputs[&okey];

            let (cw, ch) = (frame.content.0.min(frame.texture_size.0), frame.content.1.min(frame.texture_size.1));
            let vc = &gpu.video_context;
            let source = RECT { left: 0, top: 0, right: cw as i32, bottom: ch as i32 };
            let (l, t, r, b) = fit(cw, ch, self.output_size.0, self.output_size.1);
            let dest = RECT { left: l, top: t, right: r, bottom: b };
            vc.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&source));
            vc.VideoProcessorSetStreamDestRect(&self.processor, 0, true, Some(&dest));
            let stream = D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: ManuallyDrop::new(Some(input.clone())), ..Default::default() };
            let streams = [stream];
            let result = vc.VideoProcessorBlt(&self.processor, output, 0, &streams);
            let [mut stream] = streams;
            ManuallyDrop::drop(&mut stream.pInputSurface);
            result.map_err(err("converting a frame"))?;
            gpu.context.Flush();
            Ok(())
        }
    }

    /// State shared between the stage thread and the encoder's event thread.
    struct Shared {
        credits: AtomicU32,
        last_idr_us: AtomicU64,
        closed: AtomicBool,
        stop: AtomicBool,
        error: Mutex<Option<String>>,
    }

    /// One async hardware H.264 MFT at a fixed size, plus the thread that answers its events.
    struct Encoder {
        mft: IMFTransform,
        codec: ICodecAPI,
        allocator: IMFVideoSampleAllocatorEx,
        input_id: u32,
        size: (u32, u32),
        shared: Arc<Shared>,
        events: Option<JoinHandle<()>>,
        done: mpsc::Receiver<()>,
        activate: IMFActivate,
    }

    unsafe fn set_u32(codec: &ICodecAPI, key: &GUID, value: u32) -> WinResult<()> {
        let mut v = VARIANT::default();
        (*v.Anonymous.Anonymous).vt = VT_UI4;
        (*v.Anonymous.Anonymous).Anonymous.ulVal = value;
        codec.SetValue(key, &v)
    }

    unsafe fn set_bool(codec: &ICodecAPI, key: &GUID, value: bool) -> WinResult<()> {
        let mut v = VARIANT::default();
        (*v.Anonymous.Anonymous).vt = VT_BOOL;
        (*v.Anonymous.Anonymous).Anonymous.boolVal = VARIANT_BOOL(if value { -1 } else { 0 });
        codec.SetValue(key, &v)
    }

    unsafe fn video_type(subtype: &GUID, size: (u32, u32), fps: u32) -> WinResult<IMFMediaType> {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, ((size.0 as u64) << 32) | size.1 as u64)?;
        t.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1)?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        Ok(t)
    }

    impl Encoder {
        #[allow(clippy::too_many_arguments)]
        unsafe fn new(
            activate: IMFActivate,
            gpu: &Gpu,
            size: (u32, u32),
            settings: VideoSettings,
            layer: usize,
            clock: Clock,
            tx: VideoTx,
            wake: Handle,
        ) -> Result<Encoder, String> {
            let mft: IMFTransform = activate.ActivateObject().map_err(err("starting the encoder"))?;
            let result = Self::configure(mft.clone(), activate.clone(), gpu, size, settings, layer, clock, tx, wake);
            if result.is_err() {
                let _ = activate.ShutdownObject();
            }
            result
        }

        #[allow(clippy::too_many_arguments)]
        unsafe fn configure(
            mft: IMFTransform,
            activate: IMFActivate,
            gpu: &Gpu,
            size: (u32, u32),
            settings: VideoSettings,
            layer: usize,
            clock: Clock,
            tx: VideoTx,
            wake: Handle,
        ) -> Result<Encoder, String> {
            let attrs = mft.GetAttributes().map_err(err("encoder attributes"))?;
            if attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 0 {
                return Err("not an asynchronous hardware encoder".into());
            }
            attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(err("unlocking the encoder"))?;
            let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
            mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, gpu.manager.as_raw() as usize).map_err(err("giving the encoder our GPU"))?;

            let codec: ICodecAPI = mft.cast().map_err(err("encoder settings"))?;
            let fps = settings.fps;
            let bps = settings.bitrate_kbps.saturating_mul(1000);
            set_u32(&codec, &CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR.0 as u32).map_err(err("CBR rate control"))?;
            set_u32(&codec, &CODECAPI_AVEncCommonMeanBitRate, bps).map_err(err("bitrate"))?;
            let _ = set_bool(&codec, &CODECAPI_AVLowLatencyMode, true);
            let _ = set_u32(&codec, &CODECAPI_AVEncMPVGOPSize, fps * 2);
            let _ = set_u32(&codec, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
            // A one-frame-ish VBV keeps CBR frames even-sized, which is what a real-time sender wants.
            let _ = set_u32(&codec, &CODECAPI_AVEncCommonBufferSize, bps / fps.max(1) * 2);

            let (mut input_id, mut output_id) = (0u32, 0u32);
            let _ = mft.GetStreamIDs(std::slice::from_mut(&mut input_id), std::slice::from_mut(&mut output_id));

            let out_type = video_type(&MFVideoFormat_H264, size, fps).map_err(err("output type"))?;
            out_type.SetUINT32(&MF_MT_AVG_BITRATE, bps).map_err(err("output type"))?;
            let mut set = Err(String::new());
            for profile in [eAVEncH264VProfile_ConstrainedBase, eAVEncH264VProfile_Base, eAVEncH264VProfile_Main] {
                out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, profile.0 as u32).map_err(err("output type"))?;
                set = mft.SetOutputType(output_id, &out_type, 0).map_err(err(&format!("H.264 {}x{} at {fps} fps", size.0, size.1)));
                if set.is_ok() {
                    break;
                }
            }
            set?;
            let in_type = video_type(&MFVideoFormat_NV12, size, fps).map_err(err("input type"))?;
            mft.SetInputType(input_id, &in_type, 0).map_err(err("NV12 input"))?;

            let mut params = Vec::new();
            if let Ok(t) = mft.GetOutputCurrentType(output_id) {
                if let Ok(len) = t.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                    let mut blob = vec![0u8; len as usize];
                    if t.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, None).is_ok() {
                        params = parameter_sets(&blob);
                    }
                }
            }

            // Input textures come from a pool the encoder hands back as it finishes with them.
            let mut ptr = std::ptr::null_mut();
            MFCreateVideoSampleAllocatorEx(&IMFVideoSampleAllocatorEx::IID, &mut ptr).map_err(err("sample allocator"))?;
            let allocator = IMFVideoSampleAllocatorEx::from_raw(ptr);
            allocator.SetDirectXManager(&gpu.manager).map_err(err("sample allocator"))?;
            let mut pool_attrs = None;
            MFCreateAttributes(&mut pool_attrs, 2).map_err(err("sample allocator"))?;
            let pool_attrs = pool_attrs.unwrap();
            pool_attrs.SetUINT32(&MF_SA_D3D11_BINDFLAGS, (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32).map_err(err("sample allocator"))?;
            if allocator.InitializeSampleAllocatorEx(4, 12, &pool_attrs, &in_type).is_err() {
                pool_attrs.SetUINT32(&MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET.0 as u32).map_err(err("sample allocator"))?;
                allocator.InitializeSampleAllocatorEx(4, 12, &pool_attrs, &in_type).map_err(err("encoder input textures"))?;
            }

            let info = mft.GetOutputStreamInfo(output_id).map_err(err("encoder output"))?;
            let provides = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0) as u32 != 0;

            mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0).map_err(err("encoder flush"))?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(err("encoder start"))?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(err("encoder start"))?;

            let shared = Arc::new(Shared {
                credits: AtomicU32::new(0),
                last_idr_us: AtomicU64::new(0),
                closed: AtomicBool::new(false),
                stop: AtomicBool::new(false),
                error: Mutex::new(None),
            });
            let generator: IMFMediaEventGenerator = mft.cast().map_err(err("encoder events"))?;
            let output = Output {
                mft: mft.clone(),
                id: output_id,
                provides,
                buffer_size: info.cbSize.max(1 << 20),
                params,
                layer,
                size,
                tx,
                shared: shared.clone(),
                _clock: clock,
            };
            let (done_tx, done) = mpsc::channel();
            let moved = Unsend((generator, output));
            let events = std::thread::Builder::new()
                .name("live-video-encoder".into())
                .spawn(move || {
                    let moved = moved;
                    let (generator, mut output) = moved.0;
                    output.run(&generator, wake);
                    let _ = done_tx.send(());
                })
                .map_err(|e| e.to_string())?;

            Ok(Encoder { mft, codec, allocator, input_id, size, shared, events: Some(events), done, activate })
        }

        fn failure(&self) -> Option<String> {
            self.shared.error.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }

        /// Converts `frame` into a fresh input texture and queues it. `Ok(false)` when the encoder
        /// isn't ready for more input yet (the frame stays held and is retried).
        unsafe fn submit(&mut self, gpu: &Gpu, converter: &mut Converter, frame: &Held, pts: u64, duration: u64, force_key: bool) -> Result<bool, String> {
            if self.shared.credits.load(Ordering::Acquire) == 0 {
                return Ok(false);
            }
            let sample = match self.allocator.AllocateSample() {
                Ok(sample) => sample,
                Err(e) if e.code() == MF_E_SAMPLEALLOCATOR_EMPTY => return Ok(false),
                Err(e) => return Err(err("encoder input texture")(e)),
            };
            let buffer = sample.GetBufferByIndex(0).map_err(err("encoder input texture"))?;
            let dxgi: IMFDXGIBuffer = buffer.cast().map_err(err("encoder input texture"))?;
            let mut ptr = std::ptr::null_mut();
            dxgi.GetResource(&ID3D11Texture2D::IID, &mut ptr).map_err(err("encoder input texture"))?;
            let texture = ID3D11Texture2D::from_raw(ptr);
            let subresource = dxgi.GetSubresourceIndex().unwrap_or(0);
            converter.convert(gpu, frame, &texture, subresource)?;
            if let Ok(len) = buffer.cast::<IMF2DBuffer>().and_then(|b| b.GetContiguousLength()) {
                let _ = buffer.SetCurrentLength(len);
            }
            sample.SetSampleTime(pts as i64 * 10).map_err(err("sample time"))?;
            sample.SetSampleDuration(duration as i64 * 10).map_err(err("sample time"))?;
            if force_key {
                let _ = set_u32(&self.codec, &CODECAPI_AVEncVideoForceKeyFrame, 1);
            }
            self.shared.credits.fetch_sub(1, Ordering::AcqRel);
            self.mft.ProcessInput(self.input_id, &sample, 0).map_err(err("encoding a frame"))?;
            Ok(true)
        }
    }

    impl Drop for Encoder {
        fn drop(&mut self) {
            unsafe {
                // Let what's in flight come out, but don't hang on a misbehaving driver.
                let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                let drained = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0).is_ok() && self.done.recv_timeout(Duration::from_millis(1000)).is_ok();
                self.shared.stop.store(true, Ordering::Relaxed);
                let _ = self.activate.ShutdownObject(); // also unblocks the event thread's GetEvent
                if drained || self.done.recv_timeout(Duration::from_millis(1000)).is_ok() {
                    if let Some(thread) = self.events.take() {
                        let _ = thread.join();
                    }
                }
                let _ = self.allocator.UninitializeSampleAllocator();
            }
        }
    }

    /// The encoder's event loop: counts input requests and turns output into [`EncodedVideo`].
    struct Output {
        mft: IMFTransform,
        id: u32,
        provides: bool,
        buffer_size: u32,
        /// Last SPS+PPS seen, in Annex B, for IDRs that come without them.
        params: Vec<u8>,
        layer: usize,
        size: (u32, u32),
        tx: VideoTx,
        shared: Arc<Shared>,
        _clock: Clock,
    }

    impl Output {
        unsafe fn run(&mut self, generator: &IMFMediaEventGenerator, wake: Handle) {
            loop {
                let Ok(event) = generator.GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0)) else { break };
                let kind = MF_EVENT_TYPE(event.GetType().unwrap_or(0) as i32);
                if kind == METransformNeedInput {
                    self.shared.credits.fetch_add(1, Ordering::AcqRel);
                    let _ = SetEvent(wake.get());
                } else if kind == METransformHaveOutput {
                    if let Err(e) = self.pull() {
                        self.fail(err("encoder output")(e), wake);
                        break;
                    }
                    if self.shared.closed.load(Ordering::Relaxed) {
                        let _ = SetEvent(wake.get());
                        break;
                    }
                } else if kind == METransformDrainComplete {
                    break;
                } else if kind == MEError {
                    let status = event.GetStatus().unwrap_or_default();
                    self.fail(format!("the encoder failed ({:#010x})", status.0), wake);
                    break;
                }
            }
        }

        fn fail(&self, message: String, wake: Handle) {
            *self.shared.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
            unsafe {
                let _ = SetEvent(wake.get());
            }
        }

        unsafe fn pull(&mut self) -> WinResult<()> {
            let sample = if self.provides {
                None
            } else {
                let sample = MFCreateSample()?;
                sample.AddBuffer(&MFCreateMemoryBuffer(self.buffer_size)?)?;
                Some(sample)
            };
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: self.id, pSample: ManuallyDrop::new(sample), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
            let mut status = 0u32;
            let result = self.mft.ProcessOutput(0, &mut buffers, &mut status);
            let sample = ManuallyDrop::take(&mut buffers[0].pSample);
            drop(ManuallyDrop::take(&mut buffers[0].pEvents));
            match result {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    let t = self.mft.GetOutputAvailableType(self.id, 0)?;
                    self.mft.SetOutputType(self.id, &t, 0)?;
                    return Ok(());
                }
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
                Err(e) => return Err(e),
            }
            let Some(sample) = sample else { return Ok(()) };
            let time = sample.GetSampleTime().unwrap_or(0).max(0) as u64;
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut data = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut data, None, Some(&mut len))?;
            let bytes = std::slice::from_raw_parts(data, len as usize).to_vec();
            let _ = buffer.Unlock();
            if bytes.is_empty() {
                return Ok(());
            }
            let (data, keyframe) = annex_b(bytes, &mut self.params);
            let pts_us = time / 10;
            if keyframe {
                self.shared.last_idr_us.store(pts_us, Ordering::Relaxed);
            }
            self.send(EncodedVideo { data, pts_us, keyframe, layer: self.layer, width: self.size.0, height: self.size.1 });
            Ok(())
        }

        /// Blocks while the sender's queue is full (backpressure reaches the encoder, which then
        /// stops asking for input), unless the stage is stopping.
        fn send(&self, mut frame: EncodedVideo) {
            loop {
                match self.tx.try_send(frame) {
                    Ok(()) => return,
                    Err(TrySendError::Full(back)) => {
                        if self.shared.stop.load(Ordering::Relaxed) {
                            return;
                        }
                        frame = back;
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        self.shared.closed.store(true, Ordering::Relaxed);
                        return;
                    }
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn start(_: Source, _: VideoSettings, _: Clock, _: VideoTx, _: KeyframeRequests) -> Result<Stage, String> {
        Err("native capture is only implemented on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(output_size(2560, 1440, 1080), (1920, 1080));
        assert_eq!(output_size(1920, 1080, 0), (1920, 1080));
        assert_eq!(output_size(1280, 720, 1080), (1280, 720)); // never upscaled
        assert_eq!(output_size(1001, 601, 0), (1000, 600));
        assert_eq!(output_size(7680, 2160, 2160), (4096, 1152));
        assert_eq!(output_size(10, 10, 0), (64, 64));
    }

    #[test]
    fn fitting() {
        assert_eq!(fit(1920, 1080, 1920, 1080), (0, 0, 1920, 1080));
        assert_eq!(fit(1080, 1080, 1920, 1080), (420, 0, 1500, 1080));
        assert_eq!(fit(1920, 540, 1920, 1080), (0, 270, 1920, 810));
    }

    #[test]
    fn parameter_sets_before_idr() {
        let sps_pps = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3];
        let idr = [0, 0, 0, 1, 0x65, 9, 9];
        let p = [0, 0, 1, 0x41, 7];
        let mut params = Vec::new();
        let (first, key) = annex_b([&sps_pps[..], &idr[..]].concat(), &mut params);
        assert!(key);
        assert_eq!(first, [&sps_pps[..], &idr[..]].concat());
        assert_eq!(params, [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3]);
        assert_eq!(annex_b(p.to_vec(), &mut params), (p.to_vec(), false));
        let (later, key) = annex_b(idr.to_vec(), &mut params);
        assert!(key);
        assert_eq!(later, [&params[..], &idr[..]].concat());
    }
}
