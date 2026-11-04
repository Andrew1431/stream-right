//! Sender: a WHIP client (RFC 9725) that publishes one H.264 video track (simulcast, when the
//! video stage encodes more than one layer) and one Opus audio track to a stream server's room, the same endpoint OBS uses:
//! `POST {endpoint}` with `Authorization: Bearer {token}` and an SDP offer, then RTP over the
//! negotiated ICE/DTLS-SRTP connection, and `DELETE {Location}` on stop.
//!
//! WebRTC is str0m (sans-IO): one thread owns the `Rtc` and is fed by a single channel that
//! carries encoded media, UDP datagrams (from a reader thread per connection) and "input closed"
//! notices. str0m does the H.264 (STAP-A/FU-A) and Opus payloading, RTCP sender reports and
//! NACK retransmission over RTX; PLI/FIR arrive as `Event::KeyframeRequest`.

use super::{AudioTx, Clock, EncodedAudio, EncodedVideo, LiveEvent, Stage, VideoTx, MAX_LAYERS, RIDS};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use str0m::change::SdpAnswer;
use str0m::format::Codec;
use str0m::media::{Direction, MediaKind, MediaTime, Mid, Pt, Rid, Simulcast, SimulcastLayer};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc, RtcConfig};

const DEFAULT_STUN: &str = "stun.cloudflare.com:3478";
/// How long a new connection may take from POST to ICE+DTLS up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Silence from the SFU (no STUN, RTCP or anything) for this long means the path is gone.
const RX_SILENCE_LIMIT: Duration = Duration::from_secs(5);
/// ICE `Disconnected` may recover by itself; give it this long before starting over.
const DISCONNECT_GRACE: Duration = Duration::from_secs(3);
/// Consecutive failed connection attempts before giving up.
const MAX_ATTEMPTS: u32 = 10;
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Connects and starts sending. `video`/`audio` are the receiving ends of the stages' channels;
/// when both close, the sender ends the session (DELETE) and reports `Stopped`. A PLI or FIR from
/// the SFU becomes a request on `keyframes` for the layer it names. `layers` is how many simulcast
/// layers the video stage sends (1 for none). Connection drops are retried with backoff,
/// reporting `Reconnecting`, and a keyframe is requested on every reconnect.
#[allow(clippy::too_many_arguments)]
pub fn connect(
    endpoint: String,
    token: String,
    clock: Clock,
    layers: usize,
    video: Receiver<EncodedVideo>,
    audio: Receiver<EncodedAudio>,
    keyframes: SyncSender<Option<usize>>,
    events: impl Fn(LiveEvent) + Send + 'static,
) -> Result<Stage, String> {
    if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
        return Err(format!("not a WHIP URL: {endpoint}"));
    }
    if token.trim().is_empty() {
        return Err("missing stream key".into());
    }
    let (tx, rx) = mpsc::channel();
    forward(video, tx.clone(), Msg::Video, Msg::VideoClosed)?;
    forward(audio, tx.clone(), Msg::Audio, Msg::AudioClosed)?;
    Stage::spawn("live-whip", move |stop| {
        let layers = layers.clamp(1, MAX_LAYERS);
        let mut sender = Sender_ { endpoint, token, clock, layers, rx, tx, keyframes, events: &events, stop };
        let error = sender.run().err();
        events(LiveEvent::Stopped { error });
    })
    .map_err(|e| e.to_string())
}

#[allow(dead_code)]
fn _types(_: VideoTx, _: AudioTx) {}

enum Msg {
    Video(EncodedVideo),
    Audio(EncodedAudio),
    VideoClosed,
    AudioClosed,
    /// A datagram read by connection `conn`'s reader thread.
    Packet { conn: u32, source: SocketAddr, data: Vec<u8> },
}

/// Moves a stage's output into the sender's single inbox, so one thread can wait on everything.
fn forward<T: Send + 'static>(rx: Receiver<T>, tx: Sender<Msg>, wrap: fn(T) -> Msg, closed: Msg) -> Result<(), String> {
    std::thread::Builder::new()
        .name("live-whip-in".into())
        .spawn(move || {
            while let Ok(item) = rx.recv() {
                if tx.send(wrap(item)).is_err() {
                    return;
                }
            }
            let _ = tx.send(closed);
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

enum Fail {
    /// Worth another POST (network, 5xx, ICE never came up).
    Retry(String),
    /// Retrying can't help (bad key, room gone, offer rejected).
    Fatal(String),
}

/// One WHIP resource: a POSTed offer, its UDP socket and the `Rtc` driving it.
struct Conn {
    id: u32,
    rtc: Rtc,
    socket: UdpSocket,
    local: SocketAddr,
    reader_stop: Arc<AtomicBool>,
    location: String,
    video: (Mid, Pt),
    audio: (Mid, Pt),
    started: Instant,
    last_rx: Instant,
    connected: bool,
    disconnected_at: Option<Instant>,
    /// Per layer: delta frames are useless to a viewer until the next IDR; hold them back after
    /// (re)connecting.
    need_keyframe: [bool; MAX_LAYERS],
    last_keyframe_request: Option<Instant>,
    last_audio_ts: Option<u64>,
    /// Dev-only fault injection (debug builds): drop all traffic from this instant on.
    blackhole_at: Option<Instant>,
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.reader_stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct Counters {
    video_bytes: u64,
    audio_bytes: u64,
    frames: u32,
}

#[allow(non_camel_case_types)]
struct Sender_<'a, F: Fn(LiveEvent)> {
    endpoint: String,
    token: String,
    clock: Clock,
    layers: usize,
    rx: Receiver<Msg>,
    tx: Sender<Msg>,
    keyframes: SyncSender<Option<usize>>,
    events: &'a F,
    stop: Arc<AtomicBool>,
}

impl<F: Fn(LiveEvent)> Sender_<'_, F> {
    fn stopping(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn run(&mut self) -> Result<(), String> {
        let agent = http_agent();
        // Session time zero as an Instant, so str0m's wallclock lines up audio and video.
        let epoch = Instant::now() - Duration::from_micros(self.clock.now_us());
        let (mut video_open, mut audio_open) = (true, true);
        let mut next_id = 0u32;
        let mut attempt = 0u32;
        let mut conn: Option<Conn> = None;
        let mut counters = Counters::default();
        let mut stats_at = Instant::now() + Duration::from_secs(1);
        let mut fault_used = false;

        (self.events)(LiveEvent::Connecting);
        loop {
            if self.stopping() || !(video_open || audio_open) {
                break;
            }

            if conn.is_none() {
                if attempt > 0 {
                    if attempt > MAX_ATTEMPTS {
                        return Err("couldn't reach the stream server".into());
                    }
                    (self.events)(LiveEvent::Reconnecting { attempt });
                    let backoff = Duration::from_millis(500 * (1 << (attempt - 1).min(4))).min(Duration::from_secs(8));
                    if !self.idle(backoff, &mut video_open, &mut audio_open) {
                        continue;
                    }
                }
                next_id += 1;
                match self.open(&agent, next_id) {
                    Ok(mut c) => {
                        if cfg!(debug_assertions) && !fault_used {
                            if let Some(secs) = std::env::var("STREAM_WHIP_BLACKHOLE_AFTER").ok().and_then(|v| v.parse::<u64>().ok()) {
                                fault_used = true;
                                c.blackhole_at = Some(Instant::now() + Duration::from_secs(secs));
                            }
                        }
                        conn = Some(c);
                    }
                    Err(Fail::Fatal(e)) => return Err(e),
                    Err(Fail::Retry(e)) => {
                        eprintln!("whip: connect failed: {e}");
                        attempt += 1;
                        continue;
                    }
                }
            }
            let c = conn.as_mut().expect("connection");

            // Drain str0m until it only has a timeout for us.
            let deadline = match self.drain(c) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("whip: {e}");
                    self.drop_conn(&agent, conn.take());
                    attempt += 1;
                    continue;
                }
            };

            let now = Instant::now();
            if let Some(why) = c.health(now) {
                eprintln!("whip: connection lost ({why})");
                let was_live = c.connected;
                self.drop_conn(&agent, conn.take());
                attempt = if was_live { 1 } else { attempt + 1 };
                continue;
            }
            if c.connected && c.need_keyframe[..self.layers].contains(&true) && c.last_keyframe_request.is_none_or(|t| now - t > Duration::from_secs(1)) {
                c.last_keyframe_request = Some(now);
                for layer in (0..self.layers).filter(|&i| c.need_keyframe[i]) {
                    let _ = self.keyframes.try_send(Some(layer));
                }
            }
            if now >= stats_at {
                let secs = (now - stats_at + Duration::from_secs(1)).as_secs_f32();
                if c.connected {
                    (self.events)(LiveEvent::Stats {
                        video_kbps: (counters.video_bytes as f32 * 8.0 / 1000.0 / secs) as u32,
                        audio_kbps: (counters.audio_bytes as f32 * 8.0 / 1000.0 / secs) as u32,
                        fps: counters.frames as f32 / secs,
                    });
                }
                counters = Counters::default();
                stats_at = now + Duration::from_secs(1);
            }

            // str0m packetizes queued frames only in handle_timeout, so it has to run whenever its
            // deadline passes, even with messages waiting: with simulcast they always are, and its
            // queue would overflow.
            if deadline <= now {
                if let Err(e) = c.rtc.handle_input(Input::Timeout(now)) {
                    eprintln!("whip: {e}");
                    self.drop_conn(&agent, conn.take());
                    attempt += 1;
                }
                continue;
            }

            let wait = deadline.min(stats_at).saturating_duration_since(now).clamp(Duration::from_millis(1), Duration::from_millis(100));
            let msg = match self.rx.recv_timeout(wait) {
                Ok(m) => m,
                Err(RecvTimeoutError::Timeout) => {
                    if let Err(e) = c.rtc.handle_input(Input::Timeout(Instant::now())) {
                        eprintln!("whip: {e}");
                        self.drop_conn(&agent, conn.take());
                        attempt += 1;
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            };

            let blackholed = c.blackhole_at.is_some_and(|t| Instant::now() >= t);
            let result = match msg {
                Msg::VideoClosed => {
                    video_open = false;
                    Ok(())
                }
                Msg::AudioClosed => {
                    audio_open = false;
                    Ok(())
                }
                Msg::Packet { conn: id, .. } if id != c.id || blackholed => Ok(()),
                Msg::Packet { source, data, .. } => {
                    c.last_rx = Instant::now();
                    match data.as_slice().try_into() {
                        Ok(contents) => c.rtc.handle_input(Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: c.local, contents })),
                        Err(_) => Ok(()), // not STUN/DTLS/RTP
                    }
                }
                Msg::Video(frame) => {
                    let layer = frame.layer;
                    if !c.connected || layer >= self.layers || (c.need_keyframe[layer] && !frame.keyframe) {
                        Ok(())
                    } else {
                        c.need_keyframe[layer] = false;
                        counters.video_bytes += frame.data.len() as u64;
                        if layer == 0 {
                            counters.frames += 1;
                        }
                        let (mid, pt) = c.video;
                        let ts = MediaTime::new(frame.pts_us * 9 / 100, str0m::media::Frequency::NINETY_KHZ);
                        let simulcast = self.layers > 1;
                        match c.rtc.writer(mid) {
                            Some(w) => {
                                let w = if simulcast { w.rid(Rid::from(RIDS[layer])) } else { w };
                                w.write(pt, epoch + Duration::from_micros(frame.pts_us), ts, frame.data)
                            }
                            None => Ok(()),
                        }
                    }
                }
                Msg::Audio(packet) => {
                    if !c.connected {
                        Ok(())
                    } else {
                        counters.audio_bytes += packet.data.len() as u64;
                        let (mid, pt) = c.audio;
                        // Keep RTP time strictly increasing even if capture timestamps wobble.
                        let mut ts = packet.pts_us * 48 / 1000;
                        if let Some(prev) = c.last_audio_ts {
                            ts = ts.max(prev + 1);
                        }
                        c.last_audio_ts = Some(ts);
                        let ts = MediaTime::new(ts, str0m::media::Frequency::FORTY_EIGHT_KHZ);
                        match c.rtc.writer(mid) {
                            Some(w) => w.write(pt, epoch + Duration::from_micros(packet.pts_us), ts, packet.data),
                            None => Ok(()),
                        }
                    }
                }
            };
            if let Err(e) = result {
                eprintln!("whip: {e}");
                self.drop_conn(&agent, conn.take());
                attempt += 1;
            }
        }

        // Both inputs closed or we were stopped: end the WHIP session.
        if let Some(c) = conn.take() {
            delete(&agent, &c.location, &self.token);
        }
        Ok(())
    }

    /// Sleeps for `dur` while keeping the inbox drained (media is dropped while disconnected).
    /// Returns false if the session should end instead.
    fn idle(&self, dur: Duration, video_open: &mut bool, audio_open: &mut bool) -> bool {
        let until = Instant::now() + dur;
        while Instant::now() < until {
            if self.stopping() || !(*video_open || *audio_open) {
                return false;
            }
            match self.rx.recv_timeout(until.saturating_duration_since(Instant::now()).min(Duration::from_millis(100))) {
                Ok(Msg::VideoClosed) => *video_open = false,
                Ok(Msg::AudioClosed) => *audio_open = false,
                Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return false,
            }
        }
        true
    }

    fn drop_conn(&self, agent: &ureq::Agent, conn: Option<Conn>) {
        if let Some(c) = conn {
            // The server would replace it on the next POST anyway; this just ends it sooner.
            delete(agent, &c.location, &self.token);
        }
    }

    /// Runs str0m's output to completion: transmits datagrams, handles events, returns the next
    /// deadline.
    fn drain(&self, c: &mut Conn) -> Result<Instant, String> {
        loop {
            match c.rtc.poll_output().map_err(|e| e.to_string())? {
                Output::Timeout(t) => return Ok(t),
                Output::Transmit(t) => {
                    if c.blackhole_at.is_none_or(|at| Instant::now() < at) {
                        let _ = c.socket.send_to(&t.contents, t.destination);
                    }
                }
                Output::Event(e) => match e {
                    Event::Connected => {
                        c.connected = true;
                        c.need_keyframe = [true; MAX_LAYERS];
                        c.last_keyframe_request = None;
                        (self.events)(LiveEvent::Live);
                    }
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                        c.disconnected_at.get_or_insert(Instant::now());
                    }
                    Event::IceConnectionStateChange(IceConnectionState::Connected | IceConnectionState::Completed) => {
                        c.disconnected_at = None;
                    }
                    Event::KeyframeRequest(r) if r.mid == c.video.0 => {
                        let layer = r.rid.and_then(|rid| RIDS[..self.layers].iter().position(|&name| Rid::from(name) == rid));
                        let _ = self.keyframes.try_send(layer);
                    }
                    Event::Closed => return Err("connection closed".into()),
                    _ => {}
                },
            }
        }
    }

    /// POSTs a fresh offer and starts the ICE/DTLS handshake (completion arrives as `Event::Connected`).
    fn open(&self, agent: &ureq::Agent, id: u32) -> Result<Conn, Fail> {
        let stun = resolve_v4(DEFAULT_STUN).map_err(Fail::Retry)?;
        // The interface that routes to the internet; binding to it gives a usable host candidate.
        let local_ip = {
            let probe = UdpSocket::bind("0.0.0.0:0").map_err(|e| Fail::Retry(e.to_string()))?;
            probe.connect(stun).map_err(|e| Fail::Retry(format!("no network: {e}")))?;
            probe.local_addr().map_err(|e| Fail::Retry(e.to_string()))?.ip()
        };
        let socket = UdpSocket::bind(SocketAddr::new(local_ip, 0)).map_err(|e| Fail::Retry(e.to_string()))?;
        let local = socket.local_addr().map_err(|e| Fail::Retry(e.to_string()))?;

        let mut config = RtcConfig::new()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .clear_codecs()
            .enable_opus(true, false)
            .set_send_buffer_video(2000);
        // One H.264 entry: constrained baseline 3.1, packetization-mode=1, RTX for NACKs.
        // level-asymmetry-allowed lets the encoder go above 3.1.
        config.codec_config().add_h264(102.into(), Some(103.into()), true, 0x42e01f);
        let mut rtc = config.build(Instant::now());

        let host = Candidate::host(local, "udp").map_err(|e| Fail::Retry(e.to_string()))?;
        rtc.add_local_candidate(host);
        // Our public address via STUN, if reachable. Not needed for an ICE-lite SFU (it learns the
        // peer-reflexive address from our checks) but it makes the offer honest without trickle.
        if let Some(mapped) = stun_binding(&socket, stun) {
            if mapped != local {
                if let Ok(srflx) = Candidate::server_reflexive(mapped, local, "udp") {
                    rtc.add_local_candidate(srflx);
                }
            }
        }

        let mut change = rtc.sdp_api();
        let audio_mid = change.add_media(MediaKind::Audio, Direction::SendOnly, Some("stream".into()), Some("audio".into()), None);
        // Layers listed best first: the server maps viewers' f/h/q onto them in this order.
        let simulcast = (self.layers > 1).then(|| {
            let mut s = Simulcast::new();
            for rid in &RIDS[..self.layers] {
                s.add_send_layer(SimulcastLayer::new(rid));
            }
            s
        });
        let video_mid = change.add_media(MediaKind::Video, Direction::SendOnly, Some("stream".into()), Some("video".into()), simulcast);
        let (offer, pending) = change.apply().ok_or_else(|| Fail::Fatal("couldn't build an offer".into()))?;
        let offer = offer.to_sdp_string();

        let mut res = agent
            .post(&self.endpoint)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Content-Type", "application/sdp")
            .send(offer.as_str())
            .map_err(|e| Fail::Retry(format!("POST {}: {e}", self.endpoint)))?;
        let status = res.status().as_u16();
        let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let location = header("location");
        let link = header("link");
        let body = res.body_mut().read_to_string().unwrap_or_default();
        if status != 201 && status != 200 {
            let msg = format!("stream server said {status}: {}", body.trim());
            return Err(if status >= 500 || status == 429 { Fail::Retry(msg) } else { Fail::Fatal(msg) });
        }
        let location = resolve_location(&self.endpoint, &location.ok_or_else(|| Fail::Fatal("WHIP answer has no Location".into()))?);
        let close = |msg: String| {
            delete(agent, &location, &self.token);
            msg
        };

        // A STUN server from the Link header gets a second chance at our public address.
        if let Some(server) = link.as_deref().and_then(stun_from_link).filter(|s| s != DEFAULT_STUN) {
            if let Some(mapped) = resolve_v4(&server).ok().and_then(|addr| stun_binding(&socket, addr)) {
                if let Ok(srflx) = Candidate::server_reflexive(mapped, local, "udp") {
                    rtc.add_local_candidate(srflx);
                }
            }
        }

        let answer = SdpAnswer::from_sdp_string(&body).map_err(|e| Fail::Fatal(close(format!("bad SDP answer: {e}"))))?;
        rtc.sdp_api().accept_answer(pending, answer).map_err(|e| Fail::Fatal(close(format!("answer rejected: {e}"))))?;

        let pt_for = |rtc: &mut Rtc, mid: Mid, codec: Codec| -> Option<Pt> {
            rtc.writer(mid)?.payload_params().find(|p| p.spec().codec == codec).map(|p| p.pt())
        };
        let video_pt = pt_for(&mut rtc, video_mid, Codec::H264).ok_or_else(|| Fail::Fatal(close("server didn't accept H.264".into())))?;
        // Audio may be refused while video goes through; then audio is simply not sent.
        let audio_pt = pt_for(&mut rtc, audio_mid, Codec::Opus).unwrap_or(Pt::from(111));

        let reader_stop = Arc::new(AtomicBool::new(false));
        spawn_reader(&socket, id, self.tx.clone(), reader_stop.clone()).map_err(|e| Fail::Retry(close(e)))?;

        let now = Instant::now();
        Ok(Conn {
            id,
            rtc,
            socket,
            local,
            reader_stop,
            location,
            video: (video_mid, video_pt),
            audio: (audio_mid, audio_pt),
            started: now,
            last_rx: now,
            connected: false,
            disconnected_at: None,
            need_keyframe: [true; MAX_LAYERS],
            last_keyframe_request: None,
            last_audio_ts: None,
            blackhole_at: None,
        })
    }
}

impl Conn {
    /// Why this connection should be abandoned, if it should.
    fn health(&self, now: Instant) -> Option<&'static str> {
        if !self.connected {
            return (now - self.started > CONNECT_TIMEOUT).then_some("ICE/DTLS didn't come up");
        }
        if now - self.last_rx > RX_SILENCE_LIMIT {
            return Some("nothing heard from the SFU");
        }
        self.disconnected_at.filter(|t| now - *t > DISCONNECT_GRACE).map(|_| "ICE disconnected")
    }
}

fn spawn_reader(socket: &UdpSocket, conn: u32, tx: Sender<Msg>, stop: Arc<AtomicBool>) -> Result<(), String> {
    let socket = socket.try_clone().map_err(|e| e.to_string())?;
    socket.set_read_timeout(Some(Duration::from_millis(200))).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("live-whip-udp".into())
        .spawn(move || {
            let mut buf = vec![0u8; 2048];
            while !stop.load(Ordering::Relaxed) {
                match socket.recv_from(&mut buf) {
                    Ok((n, source)) => {
                        if tx.send(Msg::Packet { conn, source, data: buf[..n].to_vec() }).is_err() {
                            return;
                        }
                    }
                    // Timeouts, and on Windows the ICMP-driven WSAECONNRESET: keep reading.
                    Err(_) => {}
                }
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(HTTP_TIMEOUT))
        .build()
        .into()
}

fn delete(agent: &ureq::Agent, location: &str, token: &str) {
    let res = agent.delete(location).header("Authorization", format!("Bearer {token}")).call();
    if let Err(e) = res {
        eprintln!("whip: DELETE {location}: {e}");
    }
}

/// `Location` may be a path; resolve it against the endpoint's origin.
fn resolve_location(endpoint: &str, location: &str) -> String {
    if location.contains("://") {
        return location.into();
    }
    let after_scheme = endpoint.find("://").map(|i| i + 3).unwrap_or(0);
    let origin_end = endpoint[after_scheme..].find('/').map(|i| i + after_scheme).unwrap_or(endpoint.len());
    format!("{}{}", &endpoint[..origin_end], location)
}

/// First `stun:` URL in a `Link: <stun:host:port>; rel="ice-server"` header, as `host:port`.
fn stun_from_link(link: &str) -> Option<String> {
    link.split(',').find_map(|entry| {
        if !entry.contains("ice-server") {
            return None;
        }
        let url = entry.split('<').nth(1)?.split('>').next()?;
        let host = url.strip_prefix("stun:")?;
        let host = host.split('?').next()?;
        Some(if host.contains(':') { host.to_string() } else { format!("{host}:3478") })
    })
}

fn resolve_v4(host: &str) -> Result<SocketAddr, String> {
    host.to_socket_addrs()
        .map_err(|e| format!("resolving {host}: {e}"))?
        .find(SocketAddr::is_ipv4)
        .ok_or_else(|| format!("no IPv4 address for {host}"))
}

/// A plain RFC 5389 Binding request; returns the XOR-MAPPED-ADDRESS. Runs before the reader
/// thread exists, so it can read the socket directly.
fn stun_binding(socket: &UdpSocket, server: SocketAddr) -> Option<SocketAddr> {
    const MAGIC: u32 = 0x2112_A442;
    let mut txid = [0u8; 12];
    let seed = Instant::now().elapsed().as_nanos() ^ (std::process::id() as u128) << 64 ^ socket.local_addr().ok()?.port() as u128;
    let seed = seed ^ std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    txid.copy_from_slice(&seed.to_le_bytes()[..12]);
    let mut req = vec![0x00, 0x01, 0x00, 0x00];
    req.extend_from_slice(&MAGIC.to_be_bytes());
    req.extend_from_slice(&txid);

    let old = socket.read_timeout().ok()?;
    socket.set_read_timeout(Some(Duration::from_millis(400))).ok()?;
    let mut found = None;
    let mut buf = [0u8; 1024];
    'tries: for _ in 0..3 {
        socket.send_to(&req, server).ok()?;
        let until = Instant::now() + Duration::from_millis(400);
        while Instant::now() < until {
            let Ok((n, _)) = socket.recv_from(&mut buf) else { continue };
            let msg = &buf[..n];
            if n < 20 || msg[0..2] != [0x01, 0x01] || msg[8..20] != txid {
                continue;
            }
            let mut i = 20;
            while i + 4 <= n {
                let kind = u16::from_be_bytes([msg[i], msg[i + 1]]);
                let len = u16::from_be_bytes([msg[i + 2], msg[i + 3]]) as usize;
                let value = msg.get(i + 4..i + 4 + len)?;
                if kind == 0x0020 && len >= 8 && value[1] == 0x01 {
                    let port = u16::from_be_bytes([value[2], value[3]]) ^ (MAGIC >> 16) as u16;
                    let ip = u32::from_be_bytes([value[4], value[5], value[6], value[7]]) ^ MAGIC;
                    found = Some(SocketAddr::new(std::net::Ipv4Addr::from(ip).into(), port));
                    break 'tries;
                }
                i += 4 + len.div_ceil(4) * 4;
            }
        }
    }
    let _ = socket.set_read_timeout(old);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_header() {
        assert_eq!(stun_from_link(r#"<stun:stun.cloudflare.com:3478>; rel="ice-server""#).as_deref(), Some("stun.cloudflare.com:3478"));
        assert_eq!(stun_from_link(r#"<turn:t.example>; rel="ice-server", <stun:s.example>; rel="ice-server""#).as_deref(), Some("s.example:3478"));
        assert_eq!(stun_from_link("<https://x>; rel=next"), None);
    }

    #[test]
    fn location() {
        assert_eq!(resolve_location("https://a.b/api/rooms/r/whip", "/api/rooms/r/whip/x"), "https://a.b/api/rooms/r/whip/x");
        assert_eq!(resolve_location("https://a.b/w", "https://c.d/y"), "https://c.d/y");
    }
}
