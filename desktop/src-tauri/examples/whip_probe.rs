//! Dev harness for the native Go live sender: publishes a synthetic H.264 test pattern
//! (openh264) and a 440 Hz Opus tone over `live::whip::connect` to a real WHIP endpoint.
//!
//! ```text
//! WHIP_URL=https://<server>/api/rooms/<room>/whip WHIP_TOKEN_FILE=<file holding the key> \
//!   cargo run --example whip_probe -- [seconds] [width]x[height]
//! ```
//!
//! The key is read from a file so it never lands in shell history or logs. In debug builds,
//! `STREAM_WHIP_BLACKHOLE_AFTER=<secs>` makes the first connection go silent after that long,
//! which exercises the sender's loss detection and reconnect.

#[allow(dead_code)]
#[path = "../src/live/mod.rs"]
mod live;

use live::{Clock, EncodedAudio, EncodedVideo, LiveEvent};
use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode};
use openh264::formats::YUVBuffer;
use openh264::OpenH264API;
use std::sync::mpsc::{sync_channel, TryRecvError};
use std::time::{Duration, Instant};

const FPS: u32 = 30;

fn main() {
    let url = std::env::var("WHIP_URL").expect("WHIP_URL");
    let token = std::fs::read_to_string(std::env::var("WHIP_TOKEN_FILE").expect("WHIP_TOKEN_FILE")).expect("token file");
    let mut args = std::env::args().skip(1);
    let secs: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(30);
    let (width, height) = args
        .next()
        .and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?))))
        .unwrap_or((1280usize, 720usize));

    let clock = Clock::start();
    let t0 = Instant::now();
    let (vtx, vrx) = sync_channel::<EncodedVideo>(8);
    let (atx, arx) = sync_channel::<EncodedAudio>(32);
    let (ktx, krx) = sync_channel::<()>(4);
    let (done_tx, done_rx) = sync_channel::<()>(1);

    let stage = live::whip::connect(url, token.trim().to_string(), clock, vrx, arx, ktx, move |e| {
        let at = t0.elapsed().as_secs_f32();
        match &e {
            LiveEvent::Stats { .. } => println!("[{at:6.2}] {e:?}"),
            _ => println!("[{at:6.2}] EVENT {e:?}"),
        }
        if matches!(e, LiveEvent::Stopped { .. }) {
            let _ = done_tx.try_send(());
        }
    })
    .expect("connect");

    let audio = std::thread::spawn(move || {
        let mut enc = opus1::OpusEncoder::new(opus1::SampleRate::Hz48000, opus1::Channels::Stereo, opus1::Application::Audio).expect("opus");
        let mut out = vec![0u8; 4000];
        let mut phase = 0f32;
        let start = Instant::now();
        for n in 0u64.. {
            let due = start + Duration::from_millis(20 * n);
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            if start.elapsed() > Duration::from_secs(secs) {
                break;
            }
            let mut pcm = Vec::with_capacity(960 * 2);
            for _ in 0..960 {
                let s = (phase * std::f32::consts::TAU).sin() * 0.2;
                phase = (phase + 440.0 / 48_000.0).fract();
                pcm.extend([s, s]);
            }
            let len = enc.encode(&pcm, 960, &mut out).expect("opus encode");
            let packet = EncodedAudio { data: out[..len].to_vec(), pts_us: clock.now_us() };
            if atx.send(packet).is_err() {
                break;
            }
        }
    });

    let config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(2_500_000))
        .max_frame_rate(FrameRate::from_hz(FPS as f32))
        .rate_control_mode(RateControlMode::Bitrate)
        .intra_frame_period(IntraFramePeriod::from_num_frames(FPS * 10));
    let mut enc = Encoder::with_api_config(OpenH264API::from_source(), config).expect("openh264");
    let mut yuv = vec![0u8; width * height * 3 / 2];
    let (mut keyframes_sent, mut requests) = (0u32, 0u32);
    let start = Instant::now();
    for n in 0u64.. {
        let due = start + Duration::from_micros(n * 1_000_000 / FPS as u64);
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        if start.elapsed() > Duration::from_secs(secs) {
            break;
        }
        loop {
            match krx.try_recv() {
                Ok(()) => {
                    requests += 1;
                    enc.force_intra_frame();
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        draw(&mut yuv, width, height, n);
        let frame = YUVBuffer::from_vec(yuv.clone(), width, height);
        let pts_us = clock.now_us();
        let bits = enc.encode(&frame).expect("encode");
        let keyframe = matches!(bits.frame_type(), FrameType::IDR);
        let data = bits.to_vec();
        if data.is_empty() {
            continue;
        }
        keyframes_sent += keyframe as u32;
        if vtx.send(EncodedVideo { data, pts_us, keyframe, width: width as u32, height: height as u32 }).is_err() {
            break;
        }
    }
    println!("video done: {keyframes_sent} IDR frames, {requests} keyframe requests");
    drop(vtx);
    let _ = audio.join();
    let _ = done_rx.recv_timeout(Duration::from_secs(15));
    stage.stop();
}

/// Moving bars on a gradient, with a block that changes colour each second.
fn draw(yuv: &mut [u8], w: usize, h: usize, n: u64) {
    let (y, uv) = yuv.split_at_mut(w * h);
    let shift = (n as usize * 8) % w;
    for row in 0..h {
        for col in 0..w {
            let bar = ((col + shift) / (w / 8)) % 2 == 0;
            y[row * w + col] = if bar { 200 } else { (row * 160 / h) as u8 + 30 };
        }
    }
    let (u, v) = uv.split_at_mut(w * h / 4);
    let tint = ((n / FPS as u64) % 4) as u8;
    for row in 0..h / 2 {
        for col in 0..w / 2 {
            let in_box = row < h / 6 && col < w / 6;
            u[row * w / 2 + col] = if in_box { 60 + tint * 50 } else { 128 };
            v[row * w / 2 + col] = if in_box { 220 - tint * 50 } else { 128 };
        }
    }
}
