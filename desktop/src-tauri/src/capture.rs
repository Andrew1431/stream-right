//! One-shot window capture through Windows Graphics Capture, for thumbnails in the Go-live sheet.
//! The same device → item → frame pool path is what live publishing will stream from.

/// JPEG data URL of the window scaled to at most `max_width`, or `None` when the window rendered
/// nothing visible (every pixel transparent or black), so callers can drop invisible helper windows.
/// Errors when no frame arrives, e.g. for minimized windows.
#[tauri::command]
pub async fn capture_thumbnail(id: isize, max_width: u32) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || imp::thumbnail(id, max_width))
        .await
        .map_err(|e| e.to_string())?
}

/// A captured frame already box-shrunk to roughly the thumbnail size, as packed RGB.
struct Frame {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
    /// No pixel was both opaque and non-black.
    blank: bool,
}

impl Frame {
    fn thumbnail_jpeg(self, max_width: u32) -> Result<String, String> {
        use base64::Engine;
        use image::{imageops, ImageBuffer, Rgb};

        let img: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_raw(self.width, self.height, self.rgb).ok_or("bad frame size")?;
        let img = if max_width > 0 && self.width > max_width {
            let h = ((self.height as u64 * max_width as u64) / self.width as u64).max(1) as u32;
            imageops::resize(&img, max_width, h, imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
            .encode_image(&img)
            .map_err(|e| e.to_string())?;
        Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)))
    }
}

#[cfg(windows)]
mod imp {
    use super::Frame;
    use std::sync::{Mutex, Once};
    use std::time::{Duration, Instant};
    use windows::core::{factory, Interface};
    use windows::Graphics::Capture::{
        Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind, GraphicsCaptureItem,
    };
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Win32::Foundation::{HMODULE, HWND};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
        D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    const FIRST_FRAME_TIMEOUT: Duration = Duration::from_millis(1000);

    pub fn thumbnail(id: isize, max_width: u32) -> Result<Option<String>, String> {
        let frame = grab(id, max_width)?;
        if frame.blank {
            return Ok(None);
        }
        frame.thumbnail_jpeg(max_width).map(Some)
    }

    // One device for the app's lifetime; the lock also serializes use of its immediate context.
    static DEVICE: Mutex<Option<ID3D11Device>> = Mutex::new(None);

    fn grab(id: isize, max_width: u32) -> Result<Frame, String> {
        let mut device = DEVICE.lock().unwrap_or_else(|e| e.into_inner());
        let result = unsafe { grab_inner(&mut device, HWND(id as _), max_width) };
        if result.is_err() {
            *device = None; // could be a removed device (driver reset); rebuild next time
        }
        result.map_err(|e| e.to_string())
    }

    unsafe fn create_device() -> windows::core::Result<ID3D11Device> {
        let mut device = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;
        Ok(device.unwrap())
    }

    // Windows only honours `IsBorderRequired = false` once borderless access has been requested;
    // unpackaged desktop apps are granted it without a prompt.
    fn request_borderless() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            if let Ok(op) = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
                let _ = op.get();
            }
        });
    }

    unsafe fn grab_inner(cached: &mut Option<ID3D11Device>, hwnd: HWND, max_width: u32) -> windows::core::Result<Frame> {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err(windows::core::Error::new(windows::Win32::Foundation::E_INVALIDARG, "not a window"));
        }
        // Blocking-pool threads have no apartment yet; an already-initialized one returns an ignorable error.
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
        request_borderless();

        if cached.is_none() {
            *cached = Some(create_device()?);
        }
        let device = cached.as_ref().unwrap();
        let context = device.GetImmediateContext()?;
        let winrt_device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()?;

        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            item.Size()?,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(false);
        session.StartCapture()?;

        let started = Instant::now();
        let frame = loop {
            if let Ok(frame) = pool.TryGetNextFrame() {
                break Ok(frame);
            }
            if started.elapsed() > FIRST_FRAME_TIMEOUT {
                break Err(windows::core::Error::new(
                    windows::Win32::Foundation::E_FAIL,
                    "no frame (window minimized or not rendering)",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let result = frame.and_then(|frame| {
            let size = frame.ContentSize()?;
            let texture: ID3D11Texture2D = frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()?;
            let pixels = read_texture(device, &context, &texture, size.Width as u32, size.Height as u32, max_width);
            let _ = frame.Close();
            pixels
        });
        let _ = session.Close();
        let _ = pool.Close();
        result
    }

    // The pool texture is sized to the window when capture started; ContentSize is what's actually drawn.
    unsafe fn read_texture(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
        max_width: u32,
    ) -> windows::core::Result<Frame> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        let width = width.min(desc.Width).max(1);
        let height = height.min(desc.Height).max(1);

        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: desc.Format,
            SampleDesc: desc.SampleDesc,
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        device.CreateTexture2D(&staging_desc, None, Some(&mut staging))?;
        let staging = staging.unwrap();
        let region = D3D11_BOX { left: 0, top: 0, front: 0, right: width, bottom: height, back: 1 };
        context.CopySubresourceRegion(&staging, 0, 0, 0, 0, texture, 0, Some(&region));

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let base = mapped.pData as *const u8;
        let pitch = mapped.RowPitch as usize;
        let frame = shrink(width, height, max_width, |y| std::slice::from_raw_parts(base.add(y * pitch), width as usize * 4));
        context.Unmap(&staging, 0);
        Ok(frame)
    }

    /// Averages k-by-k blocks (k = the whole-number part of width / max_width) straight out of the
    /// mapped texture, checking for visible pixels on the way, so the encoder only sees a small image.
    fn shrink<'a>(width: u32, height: u32, max_width: u32, row: impl Fn(usize) -> &'a [u8]) -> Frame {
        let k = if max_width == 0 { 1 } else { (width / max_width).max(1) as usize };
        let (w, h) = (width as usize / k, height as usize / k);
        let mut sums = vec![0u32; w * 3];
        let mut rgb = Vec::with_capacity(w * h * 3);
        let mut blank = true;
        for by in 0..h {
            sums.fill(0);
            for y in by * k..by * k + k {
                let src = row(y);
                for (bx, sum) in sums.chunks_exact_mut(3).enumerate() {
                    for p in src[bx * k * 4..(bx + 1) * k * 4].chunks_exact(4) {
                        sum[0] += p[2] as u32;
                        sum[1] += p[1] as u32;
                        sum[2] += p[0] as u32;
                        blank &= p[3] == 0 || (p[0] | p[1] | p[2]) == 0;
                    }
                }
            }
            let n = (k * k) as u32;
            rgb.extend(sums.iter().map(|s| (s / n) as u8));
        }
        Frame { width: w as u32, height: h as u32, rgb, blank }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn thumbnail(_id: isize, _max_width: u32) -> Result<Option<String>, String> {
        Err("window capture is only implemented on Windows".into())
    }
}
