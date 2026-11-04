//! Native Go live: capture → encode → publish over WHIP.
//!
//! Three stages run on their own threads and meet only through the types in this file:
//!
//! ```text
//!  video::start ──EncodedVideo──┐
//!                               ├──> whip::connect ──> https://<server>/api/rooms/<id>/whip
//!  audio::start ──EncodedAudio──┘         │
//!        ▲                                │ keyframe requests (PLI/FIR from the SFU)
//!        └─────────── KeyframeRequests ◄──┘
//! ```
//!
//! Every stage takes the same [`Clock`], so timestamps from the capture APIs (which report
//! QueryPerformanceCounter time) line up between audio and video. Stages stop when their
//! [`Stage`] handle is stopped or dropped, or when the channel they send into closes.

pub mod audio;
pub mod video;
pub mod whip;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;

/// What to capture. Ids come from `list_windows` (an HWND) and, later, `list_monitors` (an HMONITOR).
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Source {
    Window { id: isize, pid: u32 },
    Monitor { id: isize },
}

/// Which sound goes out with the picture.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AudioMode {
    /// Only this process tree's sound (a window share).
    App { pid: u32 },
    /// Everything playing except voice chat apps and stream itself (a screen share).
    AllExceptVoice,
    Off,
}

/// Process names left out of [`AudioMode::AllExceptVoice`], matched case-insensitively against
/// the executable file name. stream's own process tree (and its WebView2 children) is always left
/// out too, so viewers never hear the streams you're watching.
pub const VOICE_APPS: &[&str] = &["Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe", "ts3client_win64.exe", "TeamSpeak.exe", "mumble.exe", "Slack.exe", "Teams.exe", "ms-teams.exe", "Zoom.exe"];

/// Same shape as the web app's `ShareSettings` (ui/presets.ts): `height` 0 means the source size.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct VideoSettings {
    pub height: u32,
    pub fps: u32,
    /// Target bitrate; the encoder runs CBR at this rate.
    pub bitrate_kbps: u32,
}

/// One H.264 access unit in Annex B form (start codes, SPS/PPS repeated before every IDR),
/// constrained baseline or main profile, no B-frames, so browsers can all decode it.
pub struct EncodedVideo {
    pub data: Vec<u8>,
    pub pts_us: u64,
    pub keyframe: bool,
    pub width: u32,
    pub height: u32,
}

/// One Opus packet: 48 kHz stereo, 20 ms per packet.
pub struct EncodedAudio {
    pub data: Vec<u8>,
    pub pts_us: u64,
}

pub type VideoTx = SyncSender<EncodedVideo>;
pub type AudioTx = SyncSender<EncodedAudio>;
/// The sender asks the video encoder for an IDR frame by sending `()`.
pub type KeyframeRequests = Receiver<()>;

/// The session's shared timeline: microseconds since Go live, from QueryPerformanceCounter.
#[derive(Clone, Copy, Debug)]
pub struct Clock {
    start_qpc: i64,
    qpc_per_sec: i64,
}

impl Clock {
    pub fn start() -> Self {
        let (now, freq) = qpc();
        Clock { start_qpc: now, qpc_per_sec: freq }
    }

    pub fn now_us(&self) -> u64 {
        self.qpc_to_us(qpc().0)
    }

    /// Converts a raw QueryPerformanceCounter tick count to session time.
    pub fn qpc_to_us(&self, qpc: i64) -> u64 {
        let delta = (qpc - self.start_qpc).max(0) as i128;
        (delta * 1_000_000 / self.qpc_per_sec as i128) as u64
    }

    /// Converts a QPC-based time in 100 ns units (WGC's `SystemRelativeTime`, WASAPI's QPC
    /// position) to session time.
    pub fn hns_to_us(&self, hns: i64) -> u64 {
        let start_hns = self.start_qpc as i128 * 10_000_000 / self.qpc_per_sec as i128;
        ((hns as i128 - start_hns).max(0) / 10) as u64
    }
}

#[cfg(windows)]
fn qpc() -> (i64, i64) {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let (mut now, mut freq) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut now);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    (now, freq.max(1))
}

#[cfg(not(windows))]
fn qpc() -> (i64, i64) {
    let ns = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    (ns as i64, 1_000_000_000)
}

/// Progress of a live session, reported to the UI.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LiveEvent {
    Connecting,
    Live,
    /// The connection dropped and the sender is retrying.
    Reconnecting { attempt: u32 },
    /// Once a second while live.
    Stats { video_kbps: u32, audio_kbps: u32, fps: f32 },
    Stopped { error: Option<String> },
}

/// A running stage: a worker thread plus a stop flag it checks. Stopping (or dropping) the handle
/// asks the thread to finish and waits for it.
pub struct Stage {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Stage {
    /// Runs `work` on a named thread; `work` should return soon after the flag turns true.
    pub fn spawn(name: &str, work: impl FnOnce(Arc<AtomicBool>) + Send + 'static) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new().name(name.into()).spawn(move || work(flag))?;
        Ok(Stage { stop, thread: Some(thread) })
    }

    pub fn stop(mut self) {
        self.finish();
    }

    fn finish(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        self.finish();
    }
}
