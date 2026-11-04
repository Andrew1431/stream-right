//! Dev-only probe for the native Go live video stage: opens its own animated window (or uses the
//! primary monitor), runs `live::video::start` for a few seconds, writes the Annex B stream to a
//! file and prints frame, keyframe, latency and CPU numbers. Check the file with ffprobe/ffmpeg.
//!
//! cargo run --example video_probe -- <window|monitor|resize|static|close> <out.h264> [seconds] [height] [fps] [kbps]

#[cfg(not(windows))]
fn main() {
    eprintln!("video_probe only runs on Windows");
}

#[cfg(windows)]
fn main() {
    probe::main();
}

#[cfg(windows)]
mod probe {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use stream_desktop_lib::live::{video, Clock, Source, VideoSettings};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, FILETIME, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::Threading::{
        CreateWaitableTimerExW, GetCurrentProcess, GetProcessTimes, SetWaitableTimer, WaitForSingleObject,
        CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE, TIMER_ALL_ACCESS,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;

    static PAINTS: AtomicU32 = AtomicU32::new(0);
    static ANIMATE: AtomicBool = AtomicBool::new(true);
    static QUIT: AtomicBool = AtomicBool::new(false);
    /// Requested window size, (w << 32 | h); 0 = none pending.
    static RESIZE: AtomicU64 = AtomicU64::new(0);

    pub fn main() {
        let args: Vec<String> = std::env::args().collect();
        let mode = args.get(1).map(String::as_str).unwrap_or("window").to_string();
        let out = args.get(2).cloned().unwrap_or_else(|| std::env::temp_dir().join("video_probe.h264").display().to_string());
        let arg = |i: usize, d: u32| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
        let seconds = arg(3, 5);
        let settings = VideoSettings { height: arg(4, 1080), fps: arg(5, 60), bitrate_kbps: arg(6, 8000) };

        let (hwnd_tx, hwnd_rx) = mpsc::channel();
        let window = std::thread::spawn(move || unsafe { window_thread(hwnd_tx) });
        let hwnd = hwnd_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(300)); // let it paint once

        let source = if mode == "monitor" {
            let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
            Source::Monitor { id: monitor.0 as isize }
        } else {
            Source::Window { id: hwnd, pid: std::process::id() }
        };

        let clock = Clock::start();
        let (tx, rx) = mpsc::sync_channel(64);
        let (key_tx, key_rx) = mpsc::sync_channel(4);
        let cpu0 = cpu_time();
        let t0 = Instant::now();
        let stage = match video::start(source, settings, clock, tx, key_rx) {
            Ok(stage) => stage,
            Err(e) => {
                eprintln!("start failed: {e}");
                std::process::exit(1);
            }
        };
        println!("started in {:?} ({mode}, {settings:?})", t0.elapsed());

        let mut file = std::fs::File::create(&out).unwrap();
        let mut frames = 0u32;
        let mut keys: Vec<u64> = Vec::new();
        let mut latencies: Vec<i64> = Vec::new();
        let mut bytes = 0usize;
        let mut sizes: Vec<(u64, u32, u32)> = Vec::new();
        let mut first_pts = None;
        let mut last_pts = 0u64;
        let mut requested_at = None;
        let mut request_answered = None;
        let mut step = 0;
        let deadline = Duration::from_secs(seconds as u64);
        while t0.elapsed() < deadline {
            let elapsed = t0.elapsed().as_secs_f32();
            // Scripted events.
            if step == 0 && elapsed > 1.0 && mode == "static" {
                ANIMATE.store(false, Ordering::Relaxed);
                println!("[{elapsed:.2}s] window stops drawing");
                step = 1;
            }
            if step == 0 && elapsed > 1.5 && mode == "resize" {
                RESIZE.store((1280u64 << 32) | 720, Ordering::Relaxed);
                println!("[{elapsed:.2}s] resize to 1280x720");
                step = 1;
            }
            if step == 1 && elapsed > 3.0 && mode == "resize" {
                RESIZE.store((1000u64 << 32) | 1000, Ordering::Relaxed);
                println!("[{elapsed:.2}s] resize to 1000x1000");
                step = 2;
            }
            if step == 0 && elapsed > 2.0 && mode == "close" {
                QUIT.store(true, Ordering::Relaxed);
                println!("[{elapsed:.2}s] window closes");
                step = 1;
            }
            if requested_at.is_none() && elapsed > 2.7 {
                let _ = key_tx.try_send(());
                requested_at = Some(clock.now_us());
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(frame) => {
                    let now = clock.now_us();
                    if frame.pts_us <= last_pts && frames > 0 {
                        println!("non-increasing pts {} after {last_pts}", frame.pts_us);
                    }
                    last_pts = frame.pts_us;
                    first_pts.get_or_insert(frame.pts_us);
                    latencies.push(now as i64 - frame.pts_us as i64);
                    frames += 1;
                    bytes += frame.data.len();
                    if frame.keyframe {
                        keys.push(frame.pts_us);
                        if let (Some(at), None) = (requested_at, request_answered) {
                            if frame.pts_us >= at {
                                request_answered = Some(now - at);
                            }
                        }
                        if !frame.data.windows(5).any(|w| w[..4] == [0, 0, 0, 1] && w[4] & 0x1f == 7)
                            && !frame.data.windows(4).any(|w| w[..3] == [0, 0, 1] && w[3] & 0x1f == 7)
                        {
                            println!("keyframe at {} without SPS!", frame.pts_us);
                        }
                    }
                    if sizes.last().map(|s| (s.1, s.2)) != Some((frame.width, frame.height)) {
                        sizes.push((frame.pts_us, frame.width, frame.height));
                    }
                    file.write_all(&frame.data).unwrap();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    println!("stage ended by itself");
                    break;
                }
            }
        }
        let wall = t0.elapsed();
        let cpu = cpu_time() - cpu0;
        stage.stop();
        while let Ok(frame) = rx.try_recv() {
            frames += 1;
            bytes += frame.data.len();
            file.write_all(&frame.data).unwrap();
        }
        QUIT.store(true, Ordering::Relaxed);
        let _ = window.join();

        let span = (last_pts - first_pts.unwrap_or(0)) as f64 / 1e6;
        latencies.sort_unstable();
        let pct = |p: f64| latencies.get(((latencies.len() as f64 - 1.0) * p) as usize).copied().unwrap_or(0) as f64 / 1000.0;
        let gaps: Vec<f64> = keys.windows(2).map(|k| (k[1] - k[0]) as f64 / 1e6).collect();
        println!("frames: {frames} over {span:.2}s of pts = {:.1} fps (window painted {} times)", frames as f64 / span.max(0.001), PAINTS.load(Ordering::Relaxed));
        println!("bitrate: {:.0} kbps", bytes as f64 * 8.0 / span.max(0.001) / 1000.0);
        println!("keyframes: {} at pts(s) {:?}", keys.len(), keys.iter().map(|k| format!("{:.2}", *k as f64 / 1e6)).collect::<Vec<_>>());
        println!("max keyframe gap: {:.2}s", gaps.iter().cloned().fold(0.0, f64::max));
        println!("keyframe request answered in: {:?} ms", request_answered.map(|us| us as f64 / 1000.0));
        println!("capture→encoded latency ms: p50 {:.1} p95 {:.1} max {:.1}", pct(0.5), pct(0.95), pct(1.0));
        println!("sizes: {sizes:?}");
        println!("process CPU: {:.1}% of one core", cpu.as_secs_f64() / wall.as_secs_f64() * 100.0);
        println!("wrote {out}");
    }

    fn cpu_time() -> Duration {
        let (mut a, mut b, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe {
            let _ = GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut k, &mut u);
        }
        let ticks = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
        Duration::from_nanos((ticks(k) + ticks(u)) * 100)
    }

    unsafe fn window_thread(hwnd_tx: mpsc::Sender<isize>) {
        let class = WNDCLASSW { lpfnWndProc: Some(wndproc), lpszClassName: w!("stream_video_probe"), hbrBackground: HBRUSH::default(), ..Default::default() };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            w!("stream_video_probe"),
            w!("stream video probe"),
            WS_POPUP | WS_VISIBLE,
            40,
            40,
            1920,
            1080,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        hwnd_tx.send(hwnd.0 as isize).unwrap();
        let timer = CreateWaitableTimerExW(None, PCWSTR::null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0).unwrap();
        let mut msg = MSG::default();
        while !QUIT.load(Ordering::Relaxed) {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let size = RESIZE.swap(0, Ordering::Relaxed);
            if size != 0 {
                let _ = SetWindowPos(hwnd, None, 0, 0, (size >> 32) as i32, size as u32 as i32, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
            if ANIMATE.load(Ordering::Relaxed) {
                let _ = InvalidateRect(Some(hwnd), None, false);
            }
            let due = -40_000i64; // 4 ms
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
            let shade = (n % 256) as u32;
            let bg = CreateSolidBrush(COLORREF(0x00302010 | (shade << 8)));
            FillRect(dc, &rc, bg);
            let _ = DeleteObject(bg.into());
            let x = (n as i32 * 7) % (rc.right - 200).max(1);
            let fg = CreateSolidBrush(COLORREF(0x0000c0ff));
            FillRect(dc, &RECT { left: x, top: rc.bottom / 3, right: x + 200, bottom: rc.bottom / 3 + 200 }, fg);
            let _ = DeleteObject(fg.into());
            let text: Vec<u16> = format!("paint {n}").encode_utf16().collect();
            let _ = TextOutW(dc, 20, 20, &text);
            let _ = EndPaint(hwnd, &ps);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}
