//! Runs one Go live session: wires the video, audio and sender stages together and reports
//! progress to the UI as `live` events. One session at a time; starting another stops the first.

use super::{audio, video, whip, AudioMode, Clock, LiveEvent, Source, Stage, VideoSettings};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

// About 130 ms of video and 1 s of audio may queue while the sender catches up; beyond that the
// capture side blocks, which is better than drifting further behind.
const VIDEO_QUEUE: usize = 8;
const AUDIO_QUEUE: usize = 50;

struct Running {
    video: Stage,
    audio: Stage,
    sender: Stage,
    target: LiveTarget,
    // The sender gave up on its own; the session stays here until the next start or stop.
    ended: Arc<AtomicBool>,
}

/// The room a session streams into. Outlives a reload of the UI, which forgets everything.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct LiveTarget {
    origin: String,
    room: String,
}

impl Running {
    // Stopping capture closes the sender's inputs, so it ends the WHIP session (DELETE) on its own.
    fn stop(self) {
        self.video.stop();
        self.audio.stop();
        self.sender.stop();
    }
}

#[derive(Default)]
pub struct LiveState(Mutex<Option<Running>>);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoLive {
    endpoint: String,
    token: String,
    source: Source,
    audio: AudioMode,
    settings: VideoSettings,
    target: LiveTarget,
}

#[tauri::command]
pub async fn go_live(app: AppHandle, state: State<'_, LiveState>, request: GoLive) -> Result<(), String> {
    let previous = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(previous) = previous {
        tauri::async_runtime::spawn_blocking(move || previous.stop()).await.map_err(|e| e.to_string())?;
    }

    let running = tauri::async_runtime::spawn_blocking(move || start(app, request))
        .await
        .map_err(|e| e.to_string())??;
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(running);
    Ok(())
}

/// The running session's room, so a reloaded UI can pick it back up (and offer Stop).
#[tauri::command]
pub fn live_status(state: State<'_, LiveState>) -> Option<LiveTarget> {
    let running = state.0.lock().unwrap_or_else(|e| e.into_inner());
    running.as_ref().filter(|r| !r.ended.load(Ordering::Relaxed)).map(|r| r.target.clone())
}

#[tauri::command]
pub async fn stop_live(state: State<'_, LiveState>) -> Result<(), String> {
    let running = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(running) = running {
        tauri::async_runtime::spawn_blocking(move || running.stop()).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn start(app: AppHandle, request: GoLive) -> Result<Running, String> {
    let clock = Clock::start();
    let layers = request.settings.layer_count();
    let (video_tx, video_rx) = sync_channel(VIDEO_QUEUE * layers);
    let (audio_tx, audio_rx) = sync_channel(AUDIO_QUEUE);
    let (keyframe_tx, keyframe_rx) = sync_channel(4 * layers);

    let ended = Arc::new(AtomicBool::new(false));
    let ended_flag = ended.clone();
    let emit = app.clone();
    let _ = app.emit("live", LiveEvent::Connecting);
    let sender = whip::connect(request.endpoint, request.token, clock, layers, video_rx, audio_rx, keyframe_tx, move |event| {
        if matches!(event, LiveEvent::Stopped { .. }) {
            ended_flag.store(true, Ordering::Relaxed);
        }
        let _ = emit.emit("live", event);
    })?;
    // If capture can't start, dropping the sender's stage (and the channels) ends the session.
    let video = video::start(request.source, request.settings, clock, video_tx, keyframe_rx)?;
    let audio = audio::start(request.audio, clock, audio_tx)?;
    Ok(Running { video, audio, sender, target: request.target, ended })
}
