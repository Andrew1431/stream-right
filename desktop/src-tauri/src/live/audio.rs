//! Audio stage: WASAPI process loopback (Windows 10 2004+). [`AudioMode::App`] captures one
//! process tree; [`AudioMode::AllExceptVoice`] captures every process with an audio session
//! except [`VOICE_APPS`], stream's own tree and what the user left out, mixing them and picking up
//! apps that start playing later; [`AudioMode::OnlyApps`] captures just the apps the user listed.
//! [`AudioMode::Off`] captures nothing. Output is 48 kHz stereo Opus in 20 ms packets in every
//! mode: the SFU only knows a track once packets flow, and viewers pulling a silent-but-unsent
//! track get "track not found".
//!
//! The microphone is separate from all of that: an ordinary capture stream that only exists while
//! [`MicControl`](super::MicControl) says so, summed in from a bus of its own at the encode step.
//!
//! Timing: every captured packet carries the QPC time WASAPI mixed it at, which places it on the
//! session timeline (in 48 kHz samples). Each source is written into a shared mix buffer at that
//! position, with a one-sample stretch or squeeze per packet when its device clock drifts from
//! QPC. The encoder pulls 20 ms frames off the buffer on the wall clock, a little behind real time
//! so late packets still make it, and encodes silence where nothing played, so `pts_us` advances
//! by exactly 20 000 per packet.
//!
//! Opus comes from `unsafe-libopus`, libopus 1.3 transpiled to Rust: it builds without CMake or a
//! C compiler (the libopus `-sys` crates all need CMake, which isn't on PATH here).

use super::{AudioControls, AudioMode, AudioTx, Clock, Stage};

/// Starts capturing and encoding. Silence is still encoded (not skipped) while nothing is playing,
/// so timestamps stay continuous for the receiver. `controls` changes the sound and switches the
/// mic while it runs.
pub fn start(mode: AudioMode, clock: Clock, tx: AudioTx, controls: AudioControls) -> Result<Stage, String> {
    #[cfg(windows)]
    {
        imp::start(mode, clock, tx, controls)
    }
    #[cfg(not(windows))]
    {
        let _ = (mode, clock, tx, controls);
        Err("native audio capture is only implemented on Windows".into())
    }
}

/// An app the user can choose in the sound picker. Keyed by lowercase exe, because pids change.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct AudioApp {
    pub exe: String,
    pub name: String,
    pub playing: bool,
}

/// Apps with an audio session, merged with windowed apps that have none yet. `windows` is
/// (pid, title).
pub fn audio_apps(windows: Vec<(u32, String)>) -> Result<Vec<AudioApp>, String> {
    #[cfg(windows)]
    {
        imp::audio_apps(windows)
    }
    #[cfg(not(windows))]
    {
        let _ = windows;
        Ok(Vec::new())
    }
}

#[cfg(windows)]
mod imp {
    use super::super::{AudioControls, AudioMode, AudioTx, Clock, EncodedAudio, MicControl, MicState, Stage, VOICE_APPS};
    use super::AudioApp;
    use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use unsafe_libopus as unsafe_opus;
    use windows::core::{implement, w, Interface, Ref, HRESULT, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, S_OK};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    use windows::Win32::System::Threading::THREAD_PRIORITY_HIGHEST;
    use windows::Win32::System::Variant::VT_BLOB;

    const RATE: i64 = 48_000;
    const FRAME: usize = 960; // 20 ms
    const BITRATE: i32 = 128_000;
    /// How far behind real time frames are encoded, so packets that arrive a little late still
    /// land in the mix. Loopback packets show up within ~10 ms of their QPC time.
    const LATENCY: i64 = RATE * 60 / 1000;
    /// If the encoder falls this far behind (a stalled thread), skip ahead instead of bursting.
    const MAX_BEHIND: i64 = RATE / 2;
    /// A source within this many samples of its QPC position is nudged one sample per packet;
    /// further off (a gap or a glitch) it jumps.
    const NUDGE: i64 = RATE / 1000;
    const JUMP: i64 = RATE / 100;
    const RESCAN: Duration = Duration::from_secs(1);
    const POLL: Duration = Duration::from_millis(5);
    /// A Bluetooth headset can take a few seconds to switch profile; past this it isn't coming.
    const MIC_OPEN_LIMIT: Duration = Duration::from_secs(15);
    const FLAG_DISCONTINUITY: u32 = AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32;
    const FLAG_SILENT: u32 = AUDCLNT_BUFFERFLAGS_SILENT.0 as u32;

    pub fn start(mode: AudioMode, clock: Clock, tx: AudioTx, controls: AudioControls) -> Result<Stage, String> {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let stage = Stage::spawn("audio", move |stop| run(mode, clock, tx, controls, &stop, ready_tx)).map_err(|e| e.to_string())?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(stage),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("audio capture stopped while starting".into()),
        }
    }

    fn run(mode: AudioMode, clock: Clock, tx: AudioTx, controls: AudioControls, stop: &AtomicBool, ready: SyncSender<Result<(), String>>) {
        // The engine polls every 5 ms and encodes on the wall clock; a CPU-bound game at normal
        // priority would otherwise starve it into gaps and skips.
        let _boost = super::super::boost_thread(Some(w!("Pro Audio")), THREAD_PRIORITY_HIGHEST);
        let _com = match Com::init() {
            Ok(com) => com,
            Err(e) => return drop(ready.send(Err(e))),
        };
        let mut engine = match Engine::new(mode, clock, controls) {
            Ok(engine) => engine,
            Err(e) => return drop(ready.send(Err(e))),
        };
        let _ = ready.send(Ok(()));
        if let Err(e) = engine.run(&tx, stop) {
            eprintln!("[audio] stopped: {e}");
        }
        engine.report();
        let mic = engine.mic.control.clone();
        drop(engine);
        mic.report(MicState::Off);
    }

    struct Com;
    impl Com {
        fn init() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok().map_err(|e| format!("COM init failed: {e}"))?;
            Ok(Com)
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct Engine {
        clock: Clock,
        mode: AudioMode,
        captures: Vec<Capture>,
        sessions: Option<Sessions>,
        mixer: Mixer,
        // Kept out of `captures` so a rescan can't close it, and out of `mixer` because what's
        // summed there can't be taken back when the mic goes off.
        mic: Mic,
        modes: Receiver<AudioMode>,
        encoder: Encoder,
        failed: HashMap<u32, Instant>,
        last_scan: Instant,
        last_plan: String,
        stats: Stats,
    }

    #[derive(Default)]
    struct Stats {
        packets: u64,
        max_lag: i64,
        late_samples: u64,
        dropped_full: u64,
        skipped: u64,
    }

    impl Engine {
        fn new(mode: AudioMode, clock: Clock, controls: AudioControls) -> Result<Self, String> {
            // Sound off captures no apps, so it doesn't need process loopback.
            if mode != AudioMode::Off {
                check_windows_version()?;
            }
            let now = samples(clock.now_us() as i64);
            let base = now.div_euclid(FRAME as i64) * FRAME as i64 + FRAME as i64;
            let mut engine = Engine {
                clock,
                mode: mode.clone(),
                captures: Vec::new(),
                sessions: None,
                mixer: Mixer::new(base),
                mic: Mic { control: controls.mic, device: MicDevice::Closed, bus: Mixer::new(base) },
                modes: controls.modes,
                encoder: Encoder::new()?,
                failed: HashMap::new(),
                last_scan: Instant::now(),
                last_plan: String::new(),
                stats: Stats::default(),
            };
            match mode {
                AudioMode::App { pid } => {
                    let table = processes();
                    let name = table.get(&pid).map(|p| p.name.clone()).ok_or("that app isn't running anymore")?;
                    eprintln!("[audio] capturing: {name} ({pid})");
                    engine.captures.push(Capture::open(pid, name)?);
                }
                AudioMode::AllExceptVoice { .. } | AudioMode::OnlyApps { .. } => {
                    engine.sessions = Some(Sessions::new()?);
                    engine.rescan();
                }
                AudioMode::Off => {}
            }
            Ok(engine)
        }

        fn run(&mut self, tx: &AudioTx, stop: &AtomicBool) -> Result<(), String> {
            let mut pcm = vec![0f32; FRAME * 2];
            while !stop.load(Ordering::Relaxed) {
                let now = samples(self.clock.now_us() as i64);
                // First thing each pass, so a mic switched off while a rescan held this thread up
                // is closed and cleared before anything else gets encoded.
                self.mic.step(&self.clock, now, &mut self.stats);
                let mut i = 0;
                while i < self.captures.len() {
                    match self.captures[i].drain(&self.clock, &mut self.mixer, now, &mut self.stats) {
                        Ok(()) => i += 1,
                        Err(e) => {
                            let cap = self.captures.remove(i);
                            eprintln!("[audio] lost {} ({}): {e}", cap.name, cap.pid);
                            self.failed.insert(cap.pid, Instant::now());
                        }
                    }
                }

                if now - LATENCY - self.mixer.base > MAX_BEHIND {
                    let target = (now - LATENCY).div_euclid(FRAME as i64) * FRAME as i64;
                    self.stats.skipped += (target - self.mixer.base) as u64;
                    self.mixer.skip_to(target);
                    self.mic.bus.skip_to(target);
                }
                while now - LATENCY >= self.mixer.base + FRAME as i64 {
                    let pts_us = (self.mixer.base * 1_000_000 / RATE) as u64;
                    self.mixer.take(&mut self.mic.bus, &mut pcm);
                    let data = self.encoder.encode(&pcm)?;
                    match tx.try_send(EncodedAudio { data, pts_us }) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => self.stats.dropped_full += 1,
                        Err(TrySendError::Disconnected(_)) => return Ok(()),
                    }
                }

                let dirty = self.sessions.as_ref().is_some_and(|s| s.dirty.swap(false, Ordering::Relaxed));
                if dirty || self.last_scan.elapsed() >= RESCAN {
                    self.rescan();
                }
                std::thread::sleep(POLL);
            }
            Ok(())
        }

        /// Works out which process trees to capture and opens or closes captures to match.
        fn rescan(&mut self) {
            self.last_scan = Instant::now();
            while let Ok(mode) = self.modes.try_recv() {
                self.set_mode(mode);
            }
            let table = processes();
            let plan = match (&self.mode, &mut self.sessions) {
                (AudioMode::App { pid }, _) => {
                    if self.captures.is_empty() && table.contains_key(pid) {
                        Plan { capture: vec![*pid], left_out: Vec::new() }
                    } else {
                        return;
                    }
                }
                (AudioMode::AllExceptVoice { except }, Some(sessions)) => plan(&table, &sessions.pids(), std::process::id(), &Rules::except(except)),
                (AudioMode::OnlyApps { only }, Some(sessions)) => plan(&table, &sessions.pids(), std::process::id(), &Rules::only(only)),
                _ => return,
            };

            self.captures.retain(|c| plan.capture.contains(&c.pid));
            self.failed.retain(|_, at| at.elapsed() < Duration::from_secs(10));
            for &pid in &plan.capture {
                if self.captures.iter().any(|c| c.pid == pid) || self.failed.contains_key(&pid) {
                    continue;
                }
                let name = table.get(&pid).map(|p| p.name.clone()).unwrap_or_default();
                match Capture::open(pid, name.clone()) {
                    Ok(cap) => self.captures.push(cap),
                    Err(e) => {
                        eprintln!("[audio] couldn't capture {name} ({pid}): {e}");
                        self.failed.insert(pid, Instant::now());
                    }
                }
            }

            let name = |pid: &u32| table.get(pid).map_or("?", |p| p.name.as_str()).to_string();
            let mut capturing: Vec<String> = self.captures.iter().map(|c| format!("{} ({})", c.name, c.pid)).collect();
            capturing.sort();
            let mut left_out: Vec<String> = plan.left_out.iter().map(|(pid, why)| format!("{} ({pid}, {why})", name(pid))).collect();
            left_out.sort();
            let text = format!("capturing: {}; leaving out: {}", list(&capturing), list(&left_out));
            if text != self.last_plan {
                eprintln!("[audio] {text}");
                self.last_plan = text;
            }
        }

        /// Switches to new sound choices. `rescan`, which called this, opens what they need.
        fn set_mode(&mut self, mode: AudioMode) {
            match &mode {
                AudioMode::App { pid } => {
                    self.captures.retain(|c| c.pid == *pid);
                    self.sessions = None;
                }
                AudioMode::Off => {
                    self.captures.clear();
                    self.sessions = None;
                }
                AudioMode::AllExceptVoice { .. } | AudioMode::OnlyApps { .. } => {
                    if self.sessions.is_none() {
                        match Sessions::new() {
                            Ok(sessions) => self.sessions = Some(sessions),
                            Err(e) => {
                                eprintln!("[audio] keeping the old sound choices: {e}");
                                return;
                            }
                        }
                    }
                }
            }
            self.mode = mode;
            self.failed.clear();
        }

        fn report(&self) {
            let s = &self.stats;
            eprintln!(
                "[audio] {} packets, max packet lag {} ms, {} ms arrived too late, {} frames dropped (channel full), {} ms skipped",
                s.packets,
                s.max_lag * 1000 / RATE,
                s.late_samples as i64 * 1000 / RATE,
                s.dropped_full,
                s.skipped as i64 * 1000 / RATE
            );
        }
    }

    fn list(items: &[String]) -> String {
        if items.is_empty() {
            "nothing".into()
        } else {
            items.join(", ")
        }
    }

    /// Microseconds on the session timeline to 48 kHz samples.
    fn samples(us: i64) -> i64 {
        us * RATE / 1_000_000
    }

    fn check_windows_version() -> Result<(), String> {
        let mut buf = [0u16; 16];
        let mut size = (buf.len() * 2) as u32;
        let err = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
                w!("CurrentBuildNumber"),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        let build: u32 = if err.is_ok() {
            String::from_utf16_lossy(&buf[..(size as usize / 2).saturating_sub(1)]).trim().parse().unwrap_or(0)
        } else {
            0
        };
        // Process loopback arrived in Windows 10 2004 (build 19041). An unreadable build number
        // falls through and lets activation decide.
        if build != 0 && build < 19041 {
            return Err("Sharing app sound needs Windows 10 version 2004 or later".into());
        }
        Ok(())
    }

    // ---- Capture -------------------------------------------------------------------------------

    /// One process-loopback stream (a process and everything it started), converted by WASAPI to
    /// 48 kHz stereo.
    struct Capture {
        pid: u32,
        name: String,
        client: IAudioClient,
        capture: IAudioCaptureClient,
        float: bool,
        next: Option<i64>,
        scratch: Vec<[f32; 2]>,
        stretched: Vec<[f32; 2]>,
        /// Packets, packets Windows flagged silent, and the loudest sample: tells a silent mic from a broken path.
        heard: (u64, u64, f32),
    }

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Activated(SyncSender<()>);

    impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
        fn ActivateCompleted(&self, _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            let _ = self.0.try_send(());
            Ok(())
        }
    }

    impl Capture {
        fn open(pid: u32, name: String) -> Result<Self, String> {
            let client = activate(pid).map_err(|e| format!("process loopback activation failed ({e}); it needs Windows 10 version 2004 or later"))?;
            let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            Self::begin(client, flags, pid, name).map_err(|e| format!("couldn't open the capture stream: {e}"))
        }

        /// The default microphone, on the console role: the device Windows' sound settings show
        /// as the input. The communications role can be a different device, and streams on it
        /// are what Windows ducks other sounds for.
        fn open_mic() -> Result<Self, windows::core::Error> {
            let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }?;
            let device = unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eConsole) }?;
            let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }?;
            Self::begin(client, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 0, "microphone".into())
        }

        fn begin(client: IAudioClient, flags: u32, pid: u32, name: String) -> Result<Self, windows::core::Error> {
            let mut float = true;
            let init = |float: bool| {
                let bits = if float { 32 } else { 16 };
                let format = WAVEFORMATEX {
                    wFormatTag: if float { 3 } else { 1 }, // WAVE_FORMAT_IEEE_FLOAT / WAVE_FORMAT_PCM
                    nChannels: 2,
                    nSamplesPerSec: RATE as u32,
                    nAvgBytesPerSec: RATE as u32 * 2 * bits / 8,
                    nBlockAlign: (2 * bits / 8) as u16,
                    wBitsPerSample: bits as u16,
                    cbSize: 0,
                };
                // 200 ms of buffer: plenty of slack for a 5 ms poll.
                unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &format, None) }
            };
            if init(true).is_err() {
                float = false;
                init(false)?;
            }
            let capture: IAudioCaptureClient = unsafe { client.GetService() }?;
            unsafe { client.Start() }?;
            Ok(Capture { pid, name, client, capture, float, next: None, scratch: Vec::new(), stretched: Vec::new(), heard: (0, 0, 0.0) })
        }

        /// Moves every waiting packet into the mix.
        fn drain(&mut self, clock: &Clock, mixer: &mut Mixer, now: i64, stats: &mut Stats) -> Result<(), String> {
            loop {
                let size = unsafe { self.capture.GetNextPacketSize() }.map_err(|e| e.to_string())?;
                if size == 0 {
                    return Ok(());
                }
                let (mut data, mut frames, mut flags, mut qpc) = (std::ptr::null_mut(), 0u32, 0u32, 0u64);
                unsafe { self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc)) }.map_err(|e| e.to_string())?;
                let n = frames as usize;
                self.scratch.clear();
                if flags & FLAG_SILENT != 0 || data.is_null() {
                    self.scratch.resize(n, [0.0; 2]);
                } else if self.float {
                    let src = unsafe { std::slice::from_raw_parts(data as *const f32, n * 2) };
                    self.scratch.extend(src.as_chunks::<2>().0.iter().copied());
                } else {
                    let src = unsafe { std::slice::from_raw_parts(data as *const i16, n * 2) };
                    self.scratch.extend(src.as_chunks::<2>().0.iter().map(|s| [s[0] as f32 / 32768.0, s[1] as f32 / 32768.0]));
                }
                unsafe { self.capture.ReleaseBuffer(frames) }.map_err(|e| e.to_string())?;
                if n == 0 {
                    continue;
                }
                self.heard.0 += 1;
                self.heard.1 += u64::from(flags & FLAG_SILENT != 0);
                self.heard.2 = self.scratch.iter().fold(self.heard.2, |peak, s| peak.max(s[0].abs()).max(s[1].abs()));

                let at = samples(clock.hns_to_us(qpc as i64) as i64);
                let (pos, len) = place(&mut self.next, at, n, flags & FLAG_DISCONTINUITY != 0);
                let frames = if len == n {
                    &self.scratch
                } else {
                    stretch(&self.scratch, len, &mut self.stretched);
                    &self.stretched
                };
                stats.packets += 1;
                stats.max_lag = stats.max_lag.max(now - (at + n as i64));
                stats.late_samples += mixer.add(pos, frames);
            }
        }
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
            }
        }
    }

    fn activate(pid: u32) -> windows::core::Result<IAudioClient> {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        // PROPVARIANT's Drop calls PropVariantClear, which would free the borrowed blob.
        let mut prop = std::mem::ManuallyDrop::new(PROPVARIANT::default());
        unsafe {
            let inner = &mut *prop.Anonymous.Anonymous;
            inner.vt = VT_BLOB;
            inner.Anonymous.blob = BLOB { cbSize: size_of_val(&params) as u32, pBlobData: &params as *const _ as *mut u8 };
        }
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let handler: IActivateAudioInterfaceCompletionHandler = Activated(done_tx).into();
        let op = unsafe { ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*prop), &handler) }?;
        done_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| windows::core::Error::new(HRESULT(0x8000_000Au32 as i32), "activation timed out"))?;
        let (mut hr, mut unknown) = (S_OK, None);
        unsafe { op.GetActivateResult(&mut hr, &mut unknown) }?;
        hr.ok()?;
        unknown.ok_or_else(|| windows::core::Error::from(HRESULT(0x8000_4005u32 as i32)))?.cast()
    }

    /// Where a packet captured at session sample `at` goes, and how many samples it should
    /// fill there. Packets follow on from the previous one; when that drifts from the QPC time
    /// the packet is stretched or squeezed by one sample, and when it's far off it jumps.
    fn place(next: &mut Option<i64>, at: i64, n: usize, discontinuity: bool) -> (i64, usize) {
        let (pos, len) = match *next {
            Some(expected) if !discontinuity && (at - expected).abs() <= JUMP => {
                let drift = at - expected;
                if drift > NUDGE {
                    (expected, n + 1) // falling behind QPC: stretch to catch up
                } else if drift < -NUDGE && n > 1 {
                    (expected, n - 1)
                } else {
                    (expected, n)
                }
            }
            _ => (at, n),
        };
        *next = Some(pos + len as i64);
        (pos, len)
    }

    /// Linear resample of `src` to `len` frames.
    fn stretch(src: &[[f32; 2]], len: usize, out: &mut Vec<[f32; 2]>) {
        out.clear();
        let last = src.len() - 1;
        let step = if len > 1 { last as f64 / (len - 1) as f64 } else { 0.0 };
        out.extend((0..len).map(|i| {
            let x = i as f64 * step;
            let j = (x as usize).min(last);
            let t = (x - j as f64) as f32;
            let (a, b) = (src[j], src[(j + 1).min(last)]);
            [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        }));
    }

    // ---- Microphone ----------------------------------------------------------------------------

    /// Opening can take seconds (Bluetooth), so it happens off the engine loop.
    struct OpenedMic(Capture);
    // Core Audio objects are free-threaded within the MTA, and both the helper thread and the
    // engine thread are in it. GetBuffer and ReleaseBuffer, which must stay on one thread, only
    // ever run on the engine thread.
    unsafe impl Send for OpenedMic {}

    enum MicDevice {
        Closed,
        Opening(Receiver<Result<OpenedMic, String>>, Instant),
        Open(Capture),
    }

    struct Mic {
        control: Arc<MicControl>,
        device: MicDevice,
        bus: Mixer,
    }

    impl Mic {
        /// Follows the switch, then moves what the mic has captured onto the bus.
        fn step(&mut self, clock: &Clock, now: i64, stats: &mut Stats) {
            let wanted = self.control.wanted();
            match &mut self.device {
                MicDevice::Closed => {
                    if wanted {
                        match open_mic_on_helper() {
                            Ok(opening) => {
                                self.device = MicDevice::Opening(opening, Instant::now());
                                self.control.report(MicState::Opening);
                            }
                            Err(e) => self.control.fail(format!("Couldn't open it ({e}).")),
                        }
                    }
                }
                MicDevice::Opening(opening, since) => {
                    let since = *since;
                    match opening.try_recv() {
                        // Switched off while it was opening: nothing was read from it.
                        Ok(_) if !wanted => {
                            self.device = MicDevice::Closed;
                            self.control.report(MicState::Off);
                        }
                        Ok(Ok(mic)) => {
                            self.device = MicDevice::Open(mic.0);
                            self.control.report(MicState::On);
                        }
                        Ok(Err(e)) => {
                            self.device = MicDevice::Closed;
                            self.control.fail(e);
                        }
                        Err(TryRecvError::Disconnected) => {
                            self.device = MicDevice::Closed;
                            self.control.fail("Couldn't open it.".into());
                        }
                        Err(TryRecvError::Empty) if wanted && since.elapsed() >= MIC_OPEN_LIMIT => {
                            // Dropping the receiver makes the helper close it if it ever opens.
                            self.device = MicDevice::Closed;
                            self.control.fail("It took too long to open.".into());
                        }
                        Err(TryRecvError::Empty) => self.control.report(if wanted { MicState::Opening } else { MicState::Off }),
                    }
                }
                MicDevice::Open(capture) => {
                    if !wanted {
                        eprintln!("[audio] mic closed: {} packets, {} flagged silent, peak {:.4}", capture.heard.0, capture.heard.1, capture.heard.2);
                        self.bus.clear();
                        self.device = MicDevice::Closed;
                        self.control.report(MicState::Off);
                    } else if let Err(e) = capture.drain(clock, &mut self.bus, now, stats) {
                        eprintln!("[audio] lost the microphone: {e}");
                        self.bus.clear();
                        self.device = MicDevice::Closed;
                        self.control.fail("It was unplugged or stopped responding.".into());
                    }
                }
            }
        }
    }

    fn open_mic_on_helper() -> std::io::Result<Receiver<Result<OpenedMic, String>>> {
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::Builder::new().name("audio-mic-open".into()).spawn(move || {
            let com = Com::init();
            let opened = match &com {
                Ok(_) => Capture::open_mic().map(OpenedMic).map_err(|e| mic_error(&e)),
                Err(e) => Err(e.clone()),
            };
            // If the engine has given up the send fails and the device closes right here, still
            // inside this thread's COM init.
            let _ = tx.send(opened);
            drop(com);
        })?;
        Ok(rx)
    }

    fn mic_error(e: &windows::core::Error) -> String {
        match e.code().0 as u32 {
            0x8007_0005 => "Windows is blocking microphone access. You can allow it in Settings, under Privacy and security, Microphone.".into(),
            0x8007_0490 => "Windows has no microphone set up.".into(),
            0x8889_000A => "Another app has the microphone to itself.".into(),
            _ => format!("Couldn't open it ({e})."),
        }
    }

    // ---- Mix and encode ------------------------------------------------------------------------

    /// Stereo samples on the session timeline from `base` on, summed across sources.
    struct Mixer {
        base: i64,
        buf: VecDeque<[f32; 2]>,
    }

    impl Mixer {
        fn new(base: i64) -> Self {
            Mixer { base, buf: VecDeque::new() }
        }

        /// Adds frames starting at sample `pos`; returns how many fell before `base` (too late).
        fn add(&mut self, pos: i64, frames: &[[f32; 2]]) -> u64 {
            let mut late = 0;
            for (i, f) in frames.iter().enumerate() {
                let idx = pos + i as i64 - self.base;
                if idx < 0 {
                    late += 1;
                    continue;
                }
                if idx >= RATE * 2 {
                    break; // nonsense timestamp; don't grow without bound
                }
                let idx = idx as usize;
                if self.buf.len() <= idx {
                    self.buf.resize(idx + 1, [0.0; 2]);
                }
                let s = &mut self.buf[idx];
                s[0] += f[0];
                s[1] += f[1];
            }
            late
        }

        /// Takes the next 20 ms of this and `bus`, which share a timeline, as interleaved stereo:
        /// summed, then clamped, silence where nothing played.
        fn take(&mut self, bus: &mut Mixer, pcm: &mut [f32]) {
            for out in pcm.as_chunks_mut::<2>().0 {
                let s = self.buf.pop_front().unwrap_or([0.0; 2]);
                let b = bus.buf.pop_front().unwrap_or([0.0; 2]);
                out[0] = (s[0] + b[0]).clamp(-1.0, 1.0);
                out[1] = (s[1] + b[1]).clamp(-1.0, 1.0);
            }
            self.base += FRAME as i64;
            bus.base += FRAME as i64;
        }

        /// Forgets everything waiting, staying on the timeline.
        fn clear(&mut self) {
            self.buf.clear();
        }

        fn skip_to(&mut self, base: i64) {
            let n = ((base - self.base).max(0) as usize).min(self.buf.len());
            self.buf.drain(..n);
            self.base = base;
        }
    }

    struct Encoder(*mut unsafe_opus::OpusEncoder);

    impl Encoder {
        fn new() -> Result<Self, String> {
            let mut err = 0;
            let st = unsafe { unsafe_opus::opus_encoder_create(RATE as i32, 2, unsafe_opus::OPUS_APPLICATION_AUDIO, &mut err) };
            if st.is_null() || err != unsafe_opus::OPUS_OK {
                return Err(format!("couldn't create the Opus encoder ({err})"));
            }
            let enc = Encoder(st);
            let ret = unsafe { unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_BITRATE_REQUEST, BITRATE) };
            if ret != unsafe_opus::OPUS_OK {
                return Err(format!("couldn't set the Opus bitrate ({ret})"));
            }
            Ok(enc)
        }

        fn encode(&mut self, pcm: &[f32]) -> Result<Vec<u8>, String> {
            let mut out = vec![0u8; 1500];
            let n = unsafe { unsafe_opus::opus_encode_float(self.0, pcm.as_ptr(), FRAME as i32, out.as_mut_ptr(), out.len() as i32) };
            if n < 0 {
                return Err(format!("Opus encoding failed ({n})"));
            }
            out.truncate(n as usize);
            Ok(out)
        }
    }

    impl Drop for Encoder {
        fn drop(&mut self) {
            unsafe { unsafe_opus::opus_encoder_destroy(self.0) };
        }
    }

    // ---- Which processes to capture ------------------------------------------------------------

    /// Audio sessions on every active output device, plus a flag set when a new one starts.
    struct Sessions {
        enumerator: IMMDeviceEnumerator,
        managers: HashMap<String, IAudioSessionManager2>,
        notify: IAudioSessionNotification,
        dirty: Arc<AtomicBool>,
    }

    #[implement(IAudioSessionNotification)]
    struct SessionCreated(Arc<AtomicBool>);

    impl IAudioSessionNotification_Impl for SessionCreated_Impl {
        fn OnSessionCreated(&self, _session: Ref<'_, IAudioSessionControl>) -> windows::core::Result<()> {
            self.0.store(true, Ordering::Relaxed);
            Ok(())
        }
    }

    impl Sessions {
        fn new() -> Result<Self, String> {
            let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| format!("couldn't list audio devices: {e}"))?;
            let dirty = Arc::new(AtomicBool::new(false));
            let notify: IAudioSessionNotification = SessionCreated(dirty.clone()).into();
            let mut sessions = Sessions { enumerator, managers: HashMap::new(), notify, dirty };
            sessions.refresh_devices();
            Ok(sessions)
        }

        /// Picks up output devices plugged in since the last call.
        fn refresh_devices(&mut self) {
            let Ok(devices) = (unsafe { self.enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }) else { return };
            let count = unsafe { devices.GetCount() }.unwrap_or(0);
            for i in 0..count {
                let Ok(device) = (unsafe { devices.Item(i) }) else { continue };
                let Ok(id) = (unsafe { device.GetId() }) else { continue };
                let key = unsafe { pwstr_to_string(id) };
                if self.managers.contains_key(&key) {
                    continue;
                }
                let Ok(manager) = (unsafe { device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) }) else { continue };
                // Notifications only start flowing once the sessions have been enumerated.
                let _ = unsafe { manager.GetSessionEnumerator() };
                let _ = unsafe { manager.RegisterSessionNotification(&self.notify) };
                self.managers.insert(key, manager);
            }
        }

        fn pids(&mut self) -> HashSet<u32> {
            self.playing().into_keys().collect()
        }

        /// Processes that have a live (not expired) audio session on any output device, and
        /// whether any of their sessions is playing right now.
        fn playing(&mut self) -> HashMap<u32, bool> {
            self.refresh_devices();
            let mut pids = HashMap::new();
            for manager in self.managers.values() {
                let Ok(list) = (unsafe { manager.GetSessionEnumerator() }) else { continue };
                let count = unsafe { list.GetCount() }.unwrap_or(0);
                for i in 0..count {
                    let Ok(control) = (unsafe { list.GetSession(i) }) else { continue };
                    let Ok(control) = control.cast::<IAudioSessionControl2>() else { continue };
                    if unsafe { control.IsSystemSoundsSession() } == S_OK {
                        continue;
                    }
                    let state = unsafe { control.GetState() };
                    if state.as_ref().is_ok_and(|s| *s == AudioSessionStateExpired) {
                        continue;
                    }
                    if let Ok(pid) = unsafe { control.GetProcessId() } {
                        if pid != 0 {
                            *pids.entry(pid).or_insert(false) |= state.is_ok_and(|s| s == AudioSessionStateActive);
                        }
                    }
                }
            }
            pids
        }
    }

    impl Drop for Sessions {
        fn drop(&mut self) {
            for manager in self.managers.values() {
                let _ = unsafe { manager.UnregisterSessionNotification(&self.notify) };
            }
        }
    }

    unsafe fn pwstr_to_string(s: PWSTR) -> String {
        let out = s.to_string().unwrap_or_default();
        CoTaskMemFree(Some(s.0 as *const _));
        out
    }

    struct Proc {
        parent: u32,
        name: String,
    }

    fn processes() -> HashMap<u32, Proc> {
        let mut table = HashMap::new();
        let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return table };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = unsafe { Process32FirstW(snap, &mut entry) }.is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            table.insert(entry.th32ProcessID, Proc { parent: entry.th32ParentProcessID, name: String::from_utf16_lossy(&entry.szExeFile[..len]) });
            ok = unsafe { Process32NextW(snap, &mut entry) }.is_ok();
        }
        unsafe {
            let _ = CloseHandle(snap);
        }
        table
    }

    /// `pid` and its ancestors, nearest first. Stops at a loop or a parent that has exited.
    fn lineage(table: &HashMap<u32, Proc>, pid: u32) -> Vec<u32> {
        let mut out = vec![pid];
        let mut cur = pid;
        while let Some(p) = table.get(&cur) {
            if p.parent == 0 || out.contains(&p.parent) || !table.contains_key(&p.parent) || out.len() > 64 {
                break;
            }
            out.push(p.parent);
            cur = p.parent;
        }
        out
    }

    struct Plan {
        capture: Vec<u32>,
        left_out: Vec<(u32, &'static str)>,
    }

    /// What the user chose on top of what always stays out, as lowercase exe names.
    enum Rules {
        Except(HashSet<String>),
        Only(HashSet<String>),
    }

    fn lowercase(names: &[String]) -> HashSet<String> {
        names.iter().map(|n| n.to_lowercase()).collect()
    }

    impl Rules {
        fn except(names: &[String]) -> Self {
            Rules::Except(lowercase(names))
        }

        fn only(names: &[String]) -> Self {
            Rules::Only(lowercase(names))
        }

        fn allows(&self, exe: &str) -> bool {
            match self {
                Rules::Except(names) => !names.contains(&exe.to_lowercase()),
                Rules::Only(names) => names.contains(&exe.to_lowercase()),
            }
        }
    }

    fn is_voice(table: &HashMap<u32, Proc>, pid: u32) -> bool {
        table.get(&pid).is_some_and(|p| VOICE_APPS.iter().any(|v| v.eq_ignore_ascii_case(&p.name)))
    }

    /// Process loopback captures a whole process tree, so: leave out voice apps and stream's own
    /// tree (which includes its WebView2 processes, children of the app), leave out any process
    /// with one of those beneath it (capturing it would capture them too), and capture only the
    /// topmost of what's left so no tree is heard twice.
    ///
    /// `rules` work on each process's own exe, never its descendants: leaving out steam.exe must
    /// not silence every game it started. Only the tree rule carries over: a process with
    /// something the rules keep out beneath it can't be captured either, though what's beneath a
    /// left out process still can.
    fn plan(table: &HashMap<u32, Proc>, sessions: &HashSet<u32>, own_pid: u32, rules: &Rules) -> Plan {
        let is_voice = |pid: u32| is_voice(table, pid);
        // Every running process that must not be heard, with why.
        let mut excluded: HashMap<u32, &'static str> = HashMap::new();
        for &pid in table.keys() {
            let up = lineage(table, pid);
            if up.contains(&own_pid) {
                excluded.insert(pid, "stream");
            } else if up.iter().any(|&p| is_voice(p)) {
                excluded.insert(pid, "voice chat");
            }
        }
        // Processes with something excluded running under them.
        let mut covers_excluded = HashSet::new();
        for &pid in excluded.keys() {
            covers_excluded.extend(lineage(table, pid).into_iter().skip(1));
        }
        // Processes with something the rules keep out running under them. Anything left out by
        // name counts even while silent, like voice apps. For a list of apps to include, only
        // what has a session counts: every helper process (crash handlers, consoles) isn't on the
        // list, and counting them would silence the very app the user ticked.
        let disallowed = |pid: &u32| table.get(pid).is_some_and(|p| !rules.allows(&p.name));
        let kept_out: Vec<u32> = match rules {
            Rules::Except(_) => table.keys().copied().filter(|pid| disallowed(pid)).collect(),
            Rules::Only(_) => sessions.iter().copied().filter(|pid| disallowed(pid)).collect(),
        };
        let mut covers_kept_out = HashSet::new();
        for pid in kept_out {
            covers_kept_out.extend(lineage(table, pid).into_iter().skip(1));
        }

        let mut left_out = Vec::new();
        let mut ok = HashSet::new();
        for &pid in sessions {
            if !table.contains_key(&pid) {
                continue;
            }
            if let Some(&why) = excluded.get(&pid) {
                left_out.push((pid, why));
            } else if covers_excluded.contains(&pid) {
                left_out.push((pid, "voice chat or stream runs under it"));
            } else if disallowed(&pid) {
                left_out.push((pid, "left out by your choice of apps"));
            } else if covers_kept_out.contains(&pid) {
                left_out.push((pid, "an app you left out runs under it"));
            } else {
                ok.insert(pid);
            }
        }
        let mut capture: Vec<u32> = ok.iter().copied().filter(|&pid| !lineage(table, pid).iter().skip(1).any(|a| ok.contains(a))).collect();
        capture.sort_unstable();
        Plan { capture, left_out }
    }

    pub fn audio_apps(windows: Vec<(u32, String)>) -> Result<Vec<AudioApp>, String> {
        let _com = Com::init()?;
        let playing = Sessions::new()?.playing();
        Ok(merge_apps(&processes(), &playing, &windows, std::process::id()))
    }

    /// One row per lowercase exe, leaving out what can never be heard. A window's title names an
    /// app better than its exe does.
    fn merge_apps(table: &HashMap<u32, Proc>, playing: &HashMap<u32, bool>, windows: &[(u32, String)], own_pid: u32) -> Vec<AudioApp> {
        let hidden = |pid: u32| lineage(table, pid).iter().any(|&p| p == own_pid || is_voice(table, p));
        let mut rows: BTreeMap<String, AudioApp> = BTreeMap::new();
        let row = |pid: u32, rows: &mut BTreeMap<String, AudioApp>| -> Option<String> {
            let name = &table.get(&pid)?.name;
            if hidden(pid) {
                return None;
            }
            let exe = name.to_lowercase();
            let stem = name.rsplit_once('.').map_or(name.as_str(), |(stem, _)| stem).to_string();
            rows.entry(exe.clone()).or_insert(AudioApp { exe: exe.clone(), name: stem, playing: false });
            Some(exe)
        };
        for (&pid, &on) in playing {
            if let Some(exe) = row(pid, &mut rows) {
                rows.get_mut(&exe).unwrap().playing |= on;
            }
        }
        for (pid, title) in windows {
            if let Some(exe) = row(*pid, &mut rows) {
                rows.get_mut(&exe).unwrap().name = title.clone();
            }
        }
        let mut apps: Vec<AudioApp> = rows.into_values().collect();
        apps.sort_by_key(|a| (!a.playing, a.name.to_lowercase()));
        apps
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn encodes_silence_and_tone() {
            let mut enc = Encoder::new().unwrap();
            let mut pcm = vec![0f32; FRAME * 2];
            for k in 0..50 {
                for i in 0..FRAME {
                    let v = ((k * FRAME + i) as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.3;
                    pcm[2 * i] = v;
                    pcm[2 * i + 1] = v;
                }
                assert!(!enc.encode(&pcm).unwrap().is_empty());
            }
        }

        #[test]
        fn packets_follow_on_nudge_and_jump() {
            let mut next = None;
            assert_eq!(place(&mut next, 1000, 480, false), (1000, 480));
            assert_eq!(place(&mut next, 1480 + 10, 480, false), (1480, 480)); // jitter: follow on
            assert_eq!(place(&mut next, 1960 + 100, 480, false), (1960, 481)); // drifting: stretch
            assert_eq!(place(&mut next, 2441 - 100, 480, false), (2441, 479)); // other way: squeeze
            assert_eq!(place(&mut next, 9000, 480, false), (9000, 480)); // gap: jump
            assert_eq!(place(&mut next, 9480, 480, true), (9480, 480));
        }

        #[test]
        fn mixer_sums_and_pads_with_silence() {
            let mut m = Mixer::new(960);
            assert_eq!(m.add(900, &[[0.5, 0.5]; 100]), 60);
            m.add(960, &[[0.25, -0.25]; 10]);
            let mut pcm = vec![0f32; FRAME * 2];
            m.take(&mut Mixer::new(960), &mut pcm);
            assert_eq!(&pcm[..2], &[0.75, 0.25]);
            assert_eq!(&pcm[80..82], &[0.0, 0.0]);
            assert_eq!(m.base, 1920);
        }

        #[test]
        fn mic_bus_combines_before_clamping_and_stays_in_step() {
            let (mut sound, mut bus) = (Mixer::new(960), Mixer::new(960));
            sound.add(960, &[[0.75, -0.75], [1.5, 0.5], [-1.5, 0.25]]);
            bus.add(960, &[[0.5, -0.5], [-1.0, 0.25], [0.25, 0.25]]);
            let mut pcm = vec![0f32; FRAME * 2];
            sound.take(&mut bus, &mut pcm);
            assert_eq!(&pcm[..6], &[1.0, -1.0, 0.5, 0.75, -1.0, 0.5]);
            assert_eq!((sound.base, bus.base), (1920, 1920));

            bus.add(1920, &[[0.5, 0.5]; 3000]);
            sound.skip_to(1920 + 960);
            bus.skip_to(1920 + 960);
            sound.take(&mut bus, &mut pcm);
            assert_eq!(&pcm[..2], &[0.5, 0.5]);
            assert_eq!(bus.buf.len(), 3000 - 960 - 960);
            assert_eq!(sound.base, bus.base);
        }

        #[test]
        fn clearing_the_mic_bus_leaves_nothing_to_encode() {
            let (mut sound, mut bus) = (Mixer::new(960), Mixer::new(960));
            sound.add(960, &[[0.25, 0.25]; 960]);
            bus.add(960, &[[0.5, 0.5]; 2880]);
            bus.clear();
            assert_eq!(bus.base, 960);
            let mut pcm = vec![0f32; FRAME * 2];
            sound.take(&mut bus, &mut pcm);
            assert!(pcm.chunks(2).all(|s| s == [0.25, 0.25]));
            assert_eq!(bus.base, sound.base);
        }

        fn sample_table() -> HashMap<u32, Proc> {
            let p = |parent: u32, name: &str| Proc { parent, name: name.into() };
            [
                (1, p(0, "explorer.exe")),
                (2, p(1, "Discord.exe")),
                (3, p(2, "Discord.exe")),
                (10, p(1, "steam.exe")),
                (11, p(10, "game.exe")),
                (12, p(11, "crash_handler.exe")),
                (20, p(1, "stream-desktop.exe")),
                (21, p(20, "msedgewebview2.exe")),
                (22, p(21, "msedgewebview2.exe")),
                (30, p(1, "chrome.exe")),
                (31, p(30, "chrome.exe")),
            ]
            .into_iter()
            .collect()
        }

        fn names(list: &[&str]) -> Vec<String> {
            list.iter().map(|s| s.to_string()).collect()
        }

        #[test]
        fn excluding_steam_keeps_its_game() {
            let sessions: HashSet<u32> = [10, 11, 31].into_iter().collect();
            let plan = plan(&sample_table(), &sessions, 20, &Rules::except(&names(&["STEAM.exe"])));
            assert_eq!(plan.capture, vec![11, 31]);
            assert_eq!(plan.left_out, vec![(10, "left out by your choice of apps")]);
        }

        #[test]
        fn excluding_a_child_keeps_its_parent_out_of_the_capture() {
            let sessions: HashSet<u32> = [10, 11, 31].into_iter().collect();
            let plan = plan(&sample_table(), &sessions, 20, &Rules::except(&names(&["game.exe"])));
            assert_eq!(plan.capture, vec![31]);
            let mut out = plan.left_out.clone();
            out.sort();
            assert_eq!(out, vec![(10, "an app you left out runs under it"), (11, "left out by your choice of apps")]);

            // Silent right now, but capturing the tree would catch it the moment it plays.
            let sessions: HashSet<u32> = [10].into_iter().collect();
            let silent = super::plan(&sample_table(), &sessions, 20, &Rules::except(&names(&["game.exe"])));
            assert!(silent.capture.is_empty());
        }

        #[test]
        fn only_these_captures_only_what_was_asked() {
            let sessions: HashSet<u32> = [1, 10, 11, 31].into_iter().collect();
            let only = |list: &[&str]| plan(&sample_table(), &sessions, 20, &Rules::only(&names(list))).capture;
            assert_eq!(only(&["chrome.exe"]), vec![31]);
            assert_eq!(only(&["GAME.EXE"]), vec![11]); // its silent crash handler doesn't stop it
            assert_eq!(only(&["steam.exe"]), Vec::<u32>::new()); // game.exe is playing under it
            assert_eq!(only(&["steam.exe", "game.exe"]), vec![10]); // the tree, once
            assert_eq!(only(&[]), Vec::<u32>::new());
        }

        #[test]
        fn voice_and_stream_stay_out_even_if_listed() {
            let sessions: HashSet<u32> = [3, 22, 31].into_iter().collect();
            let plan_only = plan(&sample_table(), &sessions, 20, &Rules::only(&names(&["discord.exe", "msedgewebview2.exe", "chrome.exe"])));
            assert_eq!(plan_only.capture, vec![31]);
            let mut out = plan_only.left_out.clone();
            out.sort();
            assert_eq!(out, vec![(3, "voice chat"), (22, "stream")]);
            // A listed parent can't be captured over a voice app beneath it.
            let sessions: HashSet<u32> = [1].into_iter().collect();
            assert!(plan(&sample_table(), &sessions, 20, &Rules::only(&names(&["explorer.exe"]))).capture.is_empty());
        }

        #[test]
        fn rows_merge_by_exe_and_hide_what_can_never_be_heard() {
            let table = sample_table();
            let playing: HashMap<u32, bool> = [(3, true), (22, true), (30, false), (31, true), (11, false)].into_iter().collect();
            let windows = vec![(11, "Ember Depths".to_string()), (2, "Discord".to_string()), (10, "Steam".to_string())];
            let apps = merge_apps(&table, &playing, &windows, 20);
            let row = |exe: &str, name: &str, playing| AudioApp { exe: exe.into(), name: name.into(), playing };
            assert_eq!(apps, vec![row("chrome.exe", "chrome", true), row("game.exe", "Ember Depths", false), row("steam.exe", "Steam", false)]);
        }

        #[test]
        fn plan_leaves_out_voice_and_own_tree() {
            let p = |parent: u32, name: &str| Proc { parent, name: name.into() };
            let table: HashMap<u32, Proc> = [
                (1, p(0, "explorer.exe")),
                (2, p(1, "Discord.exe")),
                (3, p(2, "Discord.exe")),
                (10, p(1, "steam.exe")),
                (11, p(10, "game.exe")),
                (20, p(1, "stream-desktop.exe")),
                (21, p(20, "msedgewebview2.exe")),
                (22, p(21, "msedgewebview2.exe")),
                (30, p(1, "chrome.exe")),
                (31, p(30, "chrome.exe")),
            ]
            .into_iter()
            .collect();
            let sessions: HashSet<u32> = [1, 3, 10, 11, 22, 31].into_iter().collect();
            let plan = plan(&table, &sessions, 20, &Rules::except(&[]));
            assert_eq!(plan.capture, vec![10, 31]);
            let mut out = plan.left_out.clone();
            out.sort();
            assert_eq!(out, vec![(1, "voice chat or stream runs under it"), (3, "voice chat"), (22, "stream")]);
        }
    }
}
