//! Video stage: continuous Windows Graphics Capture of a window or monitor, GPU conversion to
//! NV12 (scaled to the requested height), and the hardware H.264 encoder (NVENC / AMF / Quick
//! Sync through Media Foundation), producing [`EncodedVideo`] for the sender.

use super::{Clock, EncodedVideo, KeyframeRequests, Source, Stage, VideoSettings, VideoTx};

/// Starts capturing and encoding. Encoded frames go to `tx`; an IDR frame is produced as soon as
/// possible after each message on `keyframes`, and at least every 2 seconds regardless.
/// Errors before the thread starts (bad source, no encoder) are returned here; later failures
/// end the stage and drop `tx`, which the sender sees as the stream ending.
pub fn start(source: Source, settings: VideoSettings, clock: Clock, tx: VideoTx, keyframes: KeyframeRequests) -> Result<Stage, String> {
    let _ = (source, settings, clock, tx, keyframes);
    Err("native video capture isn't built yet".into())
}

// Keeps the stub's imports honest until the stage is implemented.
#[allow(dead_code)]
fn _types(_: EncodedVideo) {}
