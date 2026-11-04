//! Audio stage: WASAPI process loopback (Windows 10 2004+). [`AudioMode::App`] captures one
//! process tree; [`AudioMode::AllExceptVoice`] captures every process with an active audio
//! session except [`VOICE_APPS`] and stream's own tree, mixing them and picking up apps that start
//! playing later. Output is 48 kHz stereo Opus in 20 ms packets.

use super::{AudioMode, AudioTx, Clock, EncodedAudio, Stage};

#[allow(unused_imports)]
use super::VOICE_APPS;

/// Starts capturing and encoding. `AudioMode::Off` returns a stage that sends nothing.
/// Silence is still encoded (not skipped) while a captured app is quiet, so timestamps stay
/// continuous for the receiver.
pub fn start(mode: AudioMode, clock: Clock, tx: AudioTx) -> Result<Stage, String> {
    let _ = (mode, clock, tx);
    Err("native audio capture isn't built yet".into())
}

#[allow(dead_code)]
fn _types(_: EncodedAudio) {}
