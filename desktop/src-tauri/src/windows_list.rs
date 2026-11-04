//! Top-level windows the user could stream: visible, titled, not cloaked (hidden UWP shells,
//! other virtual desktops) and not tool windows.

use serde::Serialize;

#[derive(Serialize)]
pub struct CaptureTarget {
    id: isize,
    title: String,
    exe: String,
    pid: u32,
    fullscreen: bool,
}

#[tauri::command]
pub fn list_windows() -> Vec<CaptureTarget> {
    imp::list()
}

#[cfg(windows)]
mod imp {
    use super::CaptureTarget;
    use windows::core::{BOOL, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
    };

    pub fn list() -> Vec<CaptureTarget> {
        let mut out: Vec<CaptureTarget> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut out as *mut _ as isize));
        }
        let own = std::process::id();
        out.retain(|t| t.pid != own);
        out
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<CaptureTarget>);
        if let Some(target) = describe(hwnd) {
            out.push(target);
        }
        true.into()
    }

    unsafe fn describe(hwnd: HWND) -> Option<CaptureTarget> {
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        // The Alt+Tab rule: owned popups and no-activate or click-through overlays aren't apps, unless they ask to be.
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0) != 0 {
            return None;
        }
        let owned = GetWindow(hwnd, GW_OWNER).map_or(false, |owner| !owner.is_invalid());
        if owned && ex & WS_EX_APPWINDOW.0 == 0 {
            return None;
        }
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4);
        if cloaked != 0 {
            return None;
        }

        // Overlay helpers (Steam's "[blur]", tray popups) are visible but tiny or empty.
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() || rect.right - rect.left < 200 || rect.bottom - rect.top < 150 {
            return None;
        }

        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..n as usize]);
        if title == "Program Manager" {
            return None;
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        Some(CaptureTarget { id: hwnd.0 as isize, title, exe: exe_name(pid), pid, fullscreen: covers_monitor(hwnd) })
    }

    unsafe fn exe_name(pid: u32) -> String {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 260];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        path.rsplit('\\').next().unwrap_or_default().to_string()
    }

    // Exclusive and borderless fullscreen both leave the window exactly covering its monitor.
    unsafe fn covers_monitor(hwnd: HWND) -> bool {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        let m = info.rcMonitor;
        rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn list() -> Vec<super::CaptureTarget> {
        Vec::new()
    }
}
