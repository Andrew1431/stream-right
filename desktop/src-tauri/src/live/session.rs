//! Runs one Go live session: wires the video, audio and sender stages together and reports
//! progress to the UI as `live` events. One session at a time; starting another stops the first,
//! and a stop that arrives while one is starting cancels that start.

use super::{audio, video, whip, AudioControls, AudioMode, Clock, LiveEvent, MicControl, MicState, Source, Stage, VideoCommand, VideoSettings};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, sync_channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

// About 130 ms of video and 1 s of audio may queue while the sender catches up; beyond that the
// capture side blocks, which is better than drifting further behind.
const VIDEO_QUEUE: usize = 8;
const AUDIO_QUEUE: usize = 50;
// Rebuilding takes seconds at worst: each old encoder gets up to 2 s to stop, and a change that
// fails has to go back through the same again.
const MODIFY_WAIT: Duration = Duration::from_secs(30);

struct Running {
    video: Stage,
    audio: Stage,
    sender: Stage,
    target: LiveTarget,
    config: LiveConfig,
    mic: Arc<MicControl>,
    video_commands: Sender<VideoCommand>,
    audio_modes: Sender<AudioMode>,
    // The sender gave up on its own; the session stays here until the next start or stop.
    ended: Arc<AtomicBool>,
}

/// What a session is sending, so a reloaded UI can fill the Modify sheet from it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConfig {
    source: Source,
    source_label: String,
    /// The shared window's exe, empty for a screen.
    source_exe: String,
    audio: AudioMode,
    /// `layers` in here is the number of qualities, which can't change while live.
    settings: VideoSettings,
}

#[derive(serde::Serialize)]
pub struct LiveStatus {
    target: LiveTarget,
    config: LiveConfig,
    mic: MicState,
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
        self.mic.set_wanted(false);
        // Before capture closes, so the sender doesn't take that for the picture failing.
        self.sender.signal();
        self.video.stop();
        self.audio.stop();
        self.sender.stop();
    }
}

/// A new window or screen for a running stream.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceChange {
    source: Source,
    source_label: String,
    #[serde(default)]
    source_exe: String,
}

#[derive(Default)]
pub struct LiveState {
    running: Mutex<Option<Running>>,
    // Held for the whole of a go_live, so starts never overlap.
    starting: tauri::async_runtime::Mutex<()>,
    // Bumped by every stop. A start that began before the bump is torn down instead of stored.
    stops: AtomicU64,
}

impl LiveState {
    fn running(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Cancels any start in flight and takes the session, if there is one, for stopping.
    fn cancel(&self) -> Option<Running> {
        // Before the take: a start that stores after this has already seen the bump and won't.
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.running().take()
    }
}

/// Stops the session and cancels any start, so viewers aren't left on a frozen picture when the
/// app quits. Gives up after `wait` so quitting never hangs on a stuck encoder or server.
pub fn shutdown(app: &AppHandle, wait: Duration) {
    let app = app.clone();
    let (done, finished) = sync_channel(1);
    std::thread::spawn(move || {
        let state = app.state::<LiveState>();
        if let Some(running) = state.cancel() {
            running.stop();
        }
        // A start in flight sees the cancel when it returns, stops itself, then lets go of this.
        drop(state.starting.blocking_lock());
        let _ = done.send(());
    });
    let _ = finished.recv_timeout(wait);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoLive {
    endpoint: String,
    token: String,
    source: Source,
    source_label: String,
    #[serde(default)]
    source_exe: String,
    audio: AudioMode,
    settings: VideoSettings,
    target: LiveTarget,
    /// Off unless the user ticked it for this session: it's never remembered.
    #[serde(default)]
    mic: bool,
}

#[tauri::command]
pub async fn go_live(app: AppHandle, state: State<'_, LiveState>, request: GoLive) -> Result<(), String> {
    // Read before waiting for the turn, so a stop pressed while an earlier start finishes cancels this one too.
    let stops = state.stops.load(Ordering::SeqCst);
    let _turn = state.starting.lock().await;
    let cancelled = || state.stops.load(Ordering::SeqCst) != stops;
    if cancelled() {
        return Err("cancelled".into());
    }

    let previous = state.running().take();
    if let Some(previous) = previous {
        tauri::async_runtime::spawn_blocking(move || previous.stop()).await.map_err(|e| e.to_string())?;
    }
    if cancelled() {
        return Err("cancelled".into());
    }

    let running = match tauri::async_runtime::spawn_blocking(move || start(app, request)).await.map_err(|e| e.to_string())? {
        Ok(running) => running,
        Err(_) if cancelled() => return Err("cancelled".into()),
        Err(e) => return Err(e),
    };
    let unwanted = {
        let mut slot = state.running();
        if cancelled() {
            Some(running)
        } else {
            *slot = Some(running);
            None
        }
    };
    if let Some(running) = unwanted {
        tauri::async_runtime::spawn_blocking(move || running.stop()).await.map_err(|e| e.to_string())?;
        return Err("cancelled".into());
    }
    Ok(())
}

/// The running session, so a reloaded UI can pick it back up (and offer Stop and Modify).
#[tauri::command]
pub fn live_status(state: State<'_, LiveState>) -> Option<LiveStatus> {
    let running = state.running();
    running.as_ref().filter(|r| !r.ended.load(Ordering::Relaxed)).map(|r| LiveStatus { target: r.target.clone(), config: r.config.clone(), mic: r.mic.state() })
}

/// Flips the mic switch. The audio stage reports what really happened as `live` events, so this
/// answers before the device is open (or closed).
#[tauri::command]
pub fn set_live_mic(state: State<'_, LiveState>, on: bool) -> Result<(), String> {
    let running = state.running();
    let running = running.as_ref().filter(|r| !r.ended.load(Ordering::Relaxed)).ok_or("You're not streaming")?;
    running.mic.set_wanted(on);
    Ok(())
}

/// Changes a running session without touching its source or its connection. If the encoder won't
/// take the new settings, the stream goes back to the old ones and nothing changes.
#[tauri::command]
pub async fn modify_live(state: State<'_, LiveState>, audio: AudioMode, settings: VideoSettings, source: Option<SourceChange>) -> Result<(), String> {
    let commands = {
        let running = state.running();
        running.as_ref().filter(|r| !r.ended.load(Ordering::Relaxed)).ok_or("You're not streaming")?.video_commands.clone()
    };
    let switched = source.is_some();
    if let Some(change) = source {
        let (reply, answer) = sync_channel(1);
        commands.send(VideoCommand::Source { source: change.source, reply }).map_err(|_| "The stream has stopped")?;
        let answer = tauri::async_runtime::spawn_blocking(move || answer.recv_timeout(MODIFY_WAIT)).await.map_err(|e| e.to_string())?;
        match answer {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(format!("Couldn't switch to {}, so the stream stayed where it was. ({e})", change.source_label)),
            Err(_) => return Err("The stream didn't switch in time.".into()),
        }
        let mut running = state.running();
        if let Some(running) = running.as_mut() {
            running.config.source = change.source;
            running.config.source_label = change.source_label;
            running.config.source_exe = change.source_exe;
            // The picture has moved, so the sound follows even if the settings below are refused.
            running.config.audio = audio.clone();
            let _ = running.audio_modes.send(audio.clone());
        }
    }
    let (reply, answer) = sync_channel(1);
    commands.send(VideoCommand::Apply { settings, reply }).map_err(|_| "The stream has stopped")?;
    let answer = tauri::async_runtime::spawn_blocking(move || answer.recv_timeout(MODIFY_WAIT)).await.map_err(|e| e.to_string())?;
    match answer {
        Ok(Ok(())) => {}
        Ok(Err(e)) if switched => return Err(format!("The stream switched, but those settings didn't work, so it kept its old ones. ({e})")),
        Ok(Err(e)) => return Err(format!("Those settings didn't work, so the stream kept its old ones. ({e})")),
        Err(_) => return Err("The stream didn't take those settings in time.".into()),
    }
    let mut running = state.running();
    if let Some(running) = running.as_mut() {
        running.config.settings = video::retarget(running.config.settings, settings);
        running.config.audio = audio.clone();
        let _ = running.audio_modes.send(audio);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_live(state: State<'_, LiveState>) -> Result<(), String> {
    // A start in flight stops itself and answers "cancelled" without waiting on this.
    let running = state.cancel();
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
    let (video_commands, video_commands_rx) = channel();
    let (audio_modes, audio_modes_rx) = channel();

    let ended = Arc::new(AtomicBool::new(false));
    let ended_flag = ended.clone();
    let emit = app.clone();
    let emit_mic = app.clone();
    let mic = Arc::new(MicControl::new(request.mic, move |mic, error| {
        let _ = emit_mic.emit("live", LiveEvent::Mic { mic, error });
    }));
    let _ = app.emit("live", LiveEvent::Connecting);
    let sender = whip::connect(request.endpoint, request.token, clock, layers, video_rx, audio_rx, keyframe_tx, move |event| {
        if matches!(event, LiveEvent::Stopped { .. }) {
            ended_flag.store(true, Ordering::Relaxed);
        }
        let _ = emit.emit("live", event);
    })?;
    // If capture can't start, dropping the sender's stage (and the channels) ends the session.
    let video = video::start(request.source, request.settings, clock, video_tx, keyframe_rx, video_commands_rx)?;
    let audio = audio::start(request.audio.clone(), clock, audio_tx, AudioControls { mic: mic.clone(), modes: audio_modes_rx })?;
    let config = LiveConfig { source: request.source, source_label: request.source_label, source_exe: request.source_exe, audio: request.audio, settings: request.settings };
    Ok(Running { video, audio, sender, target: request.target, config, mic, video_commands, audio_modes, ended })
}
