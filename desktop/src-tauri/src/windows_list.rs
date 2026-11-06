//! What the user could stream: top-level windows (visible, titled, not cloaked hidden UWP shells
//! or other virtual desktops, not tool windows) and whole monitors.

use serde::Serialize;

#[derive(Serialize)]
pub struct CaptureTarget {
    id: isize,
    title: String,
    exe: String,
    pid: u32,
    fullscreen: bool,
    /// The program's icon as a PNG data URL.
    icon: Option<String>,
}

#[derive(Serialize)]
pub struct MonitorTarget {
    id: isize,
    width: i32,
    height: i32,
    primary: bool,
}

#[tauri::command]
pub async fn list_windows() -> Vec<CaptureTarget> {
    // Icon extraction touches the shell; keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(imp::list).await.unwrap_or_default()
}

#[tauri::command]
pub fn list_monitors() -> Vec<MonitorTarget> {
    imp::monitors()
}

/// Apps for the sound picker: those with an audio session, plus windowed ones that have none yet.
#[tauri::command]
pub async fn list_audio_apps() -> Result<Vec<crate::live::audio::AudioApp>, String> {
    tauri::async_runtime::spawn_blocking(|| crate::live::audio::audio_apps(imp::windowed_apps())).await.map_err(|e| e.to_string())?
}

#[cfg(windows)]
mod imp {
    use super::{CaptureTarget, MonitorTarget};
    use windows::core::{BOOL, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
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
        // Streaming stream itself (this copy or another one running) only makes a hall of mirrors.
        let own = std::process::id();
        let own_exe = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
        out.retain(|t| t.pid != own && Some(t.exe.to_lowercase()) != own_exe);
        out
    }

    /// (pid, title) of the same windows as `list`, without the slow part (icons).
    pub fn windowed_apps() -> Vec<(u32, String)> {
        let mut out: Vec<(u32, String)> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect_plain), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }

    pub fn monitors() -> Vec<MonitorTarget> {
        let mut out: Vec<MonitorTarget> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(collect_monitor), LPARAM(&mut out as *mut _ as isize));
        }
        // Main screen first, then left to right as Windows enumerates them.
        out.sort_by_key(|m| !m.primary);
        out
    }

    unsafe extern "system" fn collect_monitor(monitor: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<MonitorTarget>);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let r = info.rcMonitor;
            // MONITORINFOF_PRIMARY
            out.push(MonitorTarget { id: monitor.0 as isize, width: r.right - r.left, height: r.bottom - r.top, primary: info.dwFlags & 1 != 0 });
        }
        true.into()
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<CaptureTarget>);
        if let Some((mut target, path)) = describe(hwnd) {
            target.icon = crate::icons::exe_icon(&path);
            out.push(target);
        }
        true.into()
    }

    unsafe extern "system" fn collect_plain(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<(u32, String)>);
        if let Some((target, _)) = describe(hwnd) {
            out.push((target.pid, target.title));
        }
        true.into()
    }

    /// The window as a target with no icon yet, and its exe's path.
    unsafe fn describe(hwnd: HWND) -> Option<(CaptureTarget, String)> {
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

        let path = exe_path(pid);
        let exe = path.rsplit('\\').next().unwrap_or_default().to_string();
        Some((CaptureTarget { id: hwnd.0 as isize, title, exe, pid, fullscreen: covers_monitor(hwnd), icon: None }, path))
    }

    unsafe fn exe_path(pid: u32) -> String {
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
        String::from_utf16_lossy(&buf[..size as usize])
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

    pub fn monitors() -> Vec<super::MonitorTarget> {
        Vec::new()
    }

    pub fn windowed_apps() -> Vec<(u32, String)> {
        Vec::new()
    }
}
