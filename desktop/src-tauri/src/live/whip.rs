//! Sender: a WHIP client (RFC 9725) that publishes one H.264 video track and one Opus audio
//! track to a stream server's room, the same endpoint OBS uses:
//! `POST {endpoint}` with `Authorization: Bearer {token}` and an SDP offer, then RTP over the
//! negotiated ICE/DTLS-SRTP connection, and `DELETE {Location}` on stop.

use super::{AudioTx, Clock, EncodedAudio, EncodedVideo, LiveEvent, Stage, VideoTx};
use std::sync::mpsc::{Receiver, SyncSender};

/// Connects and starts sending. `video`/`audio` are the receiving ends of the stages' channels;
/// when both close, the sender ends the session (DELETE) and reports `Stopped`. A PLI or FIR from
/// the SFU becomes a `()` on `keyframes`. Connection drops are retried with backoff, reporting
/// `Reconnecting`, and a keyframe is requested on every reconnect.
pub fn connect(
    endpoint: String,
    token: String,
    clock: Clock,
    video: Receiver<EncodedVideo>,
    audio: Receiver<EncodedAudio>,
    keyframes: SyncSender<()>,
    events: impl Fn(LiveEvent) + Send + 'static,
) -> Result<Stage, String> {
    let _ = (endpoint, token, clock, video, audio, keyframes, events);
    Err("the WHIP sender isn't built yet".into())
}

#[allow(dead_code)]
fn _types(_: VideoTx, _: AudioTx) {}
