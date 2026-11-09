//! Program icons for the Go-live sheet: the large shell icon of an executable as a PNG data URL.

/// Cached by path: the window list asks again every few seconds, often for many windows of one exe.
#[cfg(windows)]
pub fn exe_icon(path: &str) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    // Far more programs than anyone has open; past it, start over rather than track use.
    const MAX: usize = 128;
    static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

    if path.is_empty() {
        return None;
    }
    if let Some(icon) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|c| c.get(path)) {
        return icon.clone();
    }
    let icon = load(path);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);
    if cache.len() >= MAX {
        cache.clear();
    }
    cache.insert(path.to_string(), icon.clone());
    icon
}

#[cfg(windows)]
fn load(path: &str) -> Option<String> {
    use base64::Engine;
    use image::{ImageBuffer, Rgba};
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    if path.is_empty() {
        return None;
    }
    let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
    unsafe {
        let mut info = SHFILEINFOW::default();
        let ok = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if ok == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let icon = info.hIcon;
        let mut parts = ICONINFO::default();
        let got = GetIconInfo(icon, &mut parts).is_ok();
        let _ = DestroyIcon(icon);
        if !got {
            return None;
        }
        let color = parts.hbmColor;
        let mask = parts.hbmMask;
        let release = || {
            let _ = DeleteObject(HGDIOBJ(color.0));
            let _ = DeleteObject(HGDIOBJ(mask.0));
        };
        if color.is_invalid() {
            release();
            return None; // monochrome icons; rare for programs
        }

        let mut bitmap = BITMAP::default();
        GetObjectW(HGDIOBJ(color.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bitmap as *mut _ as *mut _));
        let (w, h) = (bitmap.bmWidth.max(1) as u32, bitmap.bmHeight.max(1) as u32);
        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let dc = CreateCompatibleDC(None);
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        let rows = GetDIBits(dc, color, 0, h, Some(bgra.as_mut_ptr() as *mut _), &mut header, DIB_RGB_COLORS);
        let mut mask_bits = vec![0u8; (w * h * 4) as usize];
        // Old-style icons carry transparency in the mask instead of the alpha channel.
        let has_alpha = bgra.chunks_exact(4).any(|p| p[3] != 0);
        if !has_alpha {
            GetDIBits(dc, mask, 0, h, Some(mask_bits.as_mut_ptr() as *mut _), &mut header, DIB_RGB_COLORS);
        }
        let _ = DeleteDC(dc);
        release();
        if rows == 0 {
            return None;
        }

        let mut rgba = Vec::with_capacity(bgra.len());
        for (i, p) in bgra.chunks_exact(4).enumerate() {
            let alpha = if has_alpha { p[3] } else if mask_bits[i * 4] == 0 { 255 } else { 0 };
            rgba.extend_from_slice(&[p[2], p[1], p[0], alpha]);
        }
        let img: ImageBuffer<Rgba<u8>, _> = ImageBuffer::from_raw(w, h, rgba)?;
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
    }
}

#[cfg(not(windows))]
pub fn exe_icon(_path: &str) -> Option<String> {
    None
}
