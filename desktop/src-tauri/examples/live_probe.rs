//! Dev harness for the whole native Go live video path: opens its own animated window, captures
//! it with `live::video::start` and publishes it with `live::whip::connect` (no audio), the same
//! wiring as `live::session`. Use it to check simulcast end to end against a local server.
//!
//! ```text
//! WHIP_URL=http://[::1]:5173/api/rooms/<room>/whip WHIP_TOKEN_FILE=<file holding the key> \
//!   cargo run --example live_probe -- [seconds] [height] [fps] [layers]
//! ```

#[cfg(not(windows))]
fn main() {
    eprintln!("live_probe only runs on Windows");
}

#[cfg(windows)]
fn main() {
    probe::main();
}

#[cfg(windows)]
mod probe {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use stream_desktop_lib::live::{bitrate_kbps, video, whip, Clock, LiveEvent, Source, VideoSettings};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::Threading::{CreateWaitableTimerExW, SetWaitableTimer, WaitForSingleObject, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE, TIMER_ALL_ACCESS};
    use windows::Win32::UI::WindowsAndMessaging::*;

    static PAINTS: AtomicU32 = AtomicU32::new(0);
    static QUIT: AtomicBool = AtomicBool::new(false);

    pub fn main() {
        let url = std::env::var("WHIP_URL").expect("WHIP_URL");
        let token = std::fs::read_to_string(std::env::var("WHIP_TOKEN_FILE").expect("WHIP_TOKEN_FILE")).expect("token file");
        let args: Vec<String> = std::env::args().collect();
        let arg = |i: usize, d: u32| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
        let seconds = arg(1, 60);
        let (height, fps) = (arg(2, 1080), arg(3, 60));
        let settings = VideoSettings { height, fps, bitrate_kbps: bitrate_kbps(height, fps), layers: arg(4, 3) };

        let (hwnd_tx, hwnd_rx) = mpsc::channel();
        let window = std::thread::spawn(move || unsafe { window_thread(hwnd_tx) });
        let hwnd = hwnd_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let clock = Clock::start();
        let t0 = Instant::now();
        let layers = settings.layer_count();
        let (vtx, vrx) = mpsc::sync_channel(8 * layers);
        let (_atx, arx) = mpsc::sync_channel(50);
        let (ktx, krx) = mpsc::sync_channel(4 * layers);
        let sender = whip::connect(url, token.trim().to_string(), clock, layers, vrx, arx, ktx, move |e| {
            println!("[{:6.2}] {e:?}", t0.elapsed().as_secs_f32());
            if matches!(e, LiveEvent::Stopped { .. }) {
                QUIT.store(true, Ordering::Relaxed);
            }
        })
        .expect("connect");
        let video = video::start(Source::Window { id: hwnd, pid: std::process::id() }, settings, clock, vtx, krx).expect("video");
        println!("live: {settings:?}");
        while t0.elapsed() < Duration::from_secs(seconds as u64) && !QUIT.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(100));
        }
        video.stop();
        sender.stop();
        QUIT.store(true, Ordering::Relaxed);
        let _ = window.join();
    }

    unsafe fn window_thread(hwnd_tx: mpsc::Sender<isize>) {
        let class = WNDCLASSW { lpfnWndProc: Some(wndproc), lpszClassName: w!("stream_live_probe"), hbrBackground: HBRUSH::default(), ..Default::default() };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, w!("stream_live_probe"), w!("stream live probe"), WS_POPUP | WS_VISIBLE, 40, 40, 1920, 1080, None, None, None, None).unwrap();
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        hwnd_tx.send(hwnd.0 as isize).unwrap();
        let timer = CreateWaitableTimerExW(None, PCWSTR::null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0).unwrap();
        let mut msg = MSG::default();
        while !QUIT.load(Ordering::Relaxed) {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = InvalidateRect(Some(hwnd), None, false);
            let due = -80_000i64; // 8 ms
            let _ = SetWaitableTimer(timer, &due, 0, None, None, false);
            WaitForSingleObject(timer, INFINITE);
        }
        let _ = DestroyWindow(hwnd);
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_PAINT {
            let n = PAINTS.fetch_add(1, Ordering::Relaxed);
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            let bg = CreateSolidBrush(COLORREF(0x00302010 | ((n % 256) << 8)));
            FillRect(dc, &rc, bg);
            let _ = DeleteObject(bg.into());
            let x = (n as i32 * 7) % (rc.right - 200).max(1);
            let fg = CreateSolidBrush(COLORREF(0x0000c0ff));
            FillRect(dc, &RECT { left: x, top: rc.bottom / 3, right: x + 200, bottom: rc.bottom / 3 + 200 }, fg);
            let _ = DeleteObject(fg.into());
            let text: Vec<u16> = format!("live probe {n}").encode_utf16().collect();
            let _ = TextOutW(dc, 20, 20, &text);
            let _ = EndPaint(hwnd, &ps);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}
