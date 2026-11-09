import type { PullTrack, Rid, SfuResponse, Stream, TrackName } from "../shared/protocol";
import { needsInsertableStreams, type Clipper } from "./clips/clipper";
import { ServerError, type RoomConnection } from "./connection";

import { settingsId, type ShareSettings } from "../ui/presets";

export { FPS_CHOICES, HEIGHT_CHOICES, heightLabel, PRESETS, settingsId, settingsLabel } from "../ui/presets";
export type { PresetId, ShareSettings } from "../ui/presets";

const MAX_BITRATE = 30_000_000;
const REFERENCE_BITRATE = 6_000_000; // 1080p60 16:9
const REFERENCE_PIXELS = 1920 * 1080;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const ICE_GATHER_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 15_000;
const DISCONNECT_GRACE_MS = 5_000;
const RECOVER_MIN_MS = 1_000;
const RECOVER_MAX_MS = 30_000;
// A recovery this long after the last one starts the backoff over.
const RECOVER_RESET_MS = 60_000;

// `insertable` is Chrome's flag for createEncodedStreams, only set while clips need it.
function newPeerConnection(insertable = false) {
  return new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    bundlePolicy: "max-bundle",
    ...(insertable ? { encodedInsertableStreams: true } : {}),
  } as RTCConfiguration);
}

// The SFU wants the full candidate list in the SDP; stop waiting after a short bound.
function gatherIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function waitConnected(pc: RTCPeerConnection): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Couldn't connect to the stream server")), CONNECT_TIMEOUT_MS);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", check);
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      if (pc.connectionState === "connected") finish();
      else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        finish(new Error("Connection to the stream server failed"));
      }
    };
    pc.addEventListener("connectionstatechange", check);
  });
}

// Scale from 6 Mbps at 1080p60 by the real capture size and the requested frame rate.
// Sub-linear exponents: bigger frames and higher rates compress better per pixel and per frame.
function bitrateFor(settings: ShareSettings, video: MediaStreamTrack): number {
  const { width = 1920, height = 1080 } = video.getSettings();
  const pixels = (width * height) / REFERENCE_PIXELS;
  const bitrate = REFERENCE_BITRATE * pixels ** 0.8 * (settings.fps / 60) ** 0.6;
  return Math.round(Math.min(MAX_BITRATE, Math.max(1_000_000, bitrate)));
}

// H.264 usually has a hardware encoder (NVENC, Quick Sync, AMF), which keeps up at
// high resolutions while a game is using the CPU. Falls back to VP8 if unsupported.
function preferH264(transceiver: RTCRtpTransceiver) {
  try {
    const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    const h264 = codecs.filter((c) => c.mimeType === "video/H264");
    if (h264.length) transceiver.setCodecPreferences([...h264, ...codecs.filter((c) => c.mimeType !== "video/H264")]);
  } catch {
    // Keep the browser default.
  }
}

function checkTracks(res: SfuResponse) {
  const failed = res.tracks?.find((t) => t.errorCode);
  if (failed) throw new Error(failed.errorDescription ?? failed.errorCode);
}

export class Publisher {
  stream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;

  constructor(
    private conn: RoomConnection,
    private onEnded: (reason?: string) => void,
  ) {}

  async start(settings: ShareSettings, noClips = false): Promise<MediaStream> {
    const options = {
      video: {
        frameRate: { ideal: settings.fps, max: settings.fps },
        ...(settings.height ? { height: { max: settings.height } } : {}),
      },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chrome-only hints; other browsers ignore them.
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    } as DisplayMediaStreamOptions;

    const media = await navigator.mediaDevices.getDisplayMedia(options);
    this.stream = media;
    const [video] = media.getVideoTracks();
    const [audio] = media.getAudioTracks();
    video.contentHint = "motion";
    video.addEventListener("ended", () => {
      this.stop();
      this.onEnded();
    });

    try {
      const pc = newPeerConnection();
      this.pc = pc;
      const tracks: { mid: string; trackName: TrackName }[] = [];

      const bitrate = bitrateFor(settings, video);
      const vt = pc.addTransceiver(video, {
        direction: "sendonly",
        sendEncodings: [
          { rid: "f", maxBitrate: bitrate, maxFramerate: settings.fps },
          { rid: "h", scaleResolutionDownBy: 2, maxBitrate: Math.round(bitrate / 4), maxFramerate: Math.min(settings.fps, 60) },
          { rid: "q", scaleResolutionDownBy: 4, maxBitrate: Math.max(200_000, Math.round(bitrate / 16)), maxFramerate: 30 },
        ],
      });
      preferH264(vt);
      const at = audio ? pc.addTransceiver(audio, { direction: "sendonly" }) : null;

      await pc.setLocalDescription(await pc.createOffer());
      await gatherIce(pc);
      tracks.push({ mid: vt.mid!, trackName: "video" });
      if (at) tracks.push({ mid: at.mid!, trackName: "audio" });

      const { sessionId } = await this.conn.request({ op: "newSession" });
      this.sessionId = sessionId!;
      const res = await this.conn.request({
        op: "publish",
        sessionId: this.sessionId,
        sdp: pc.localDescription!.sdp,
        tracks,
        preset: settingsId(settings),
        height: video.getSettings().height,
        noClips,
      });
      checkTracks(res);
      await pc.setRemoteDescription(res.sessionDescription!);
      await waitConnected(pc);
      // Lost later while the room socket stays up: end the share so the room stops listing a
      // dead stream. "disconnected" is left alone: it often recovers, and turns "failed" if not.
      pc.addEventListener("connectionstatechange", () => {
        if (pc !== this.pc || pc.connectionState !== "failed") return;
        this.stop();
        this.onEnded("Lost the connection to the stream server, so sharing stopped. Share again to resume.");
      });
      return media;
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  stop() {
    if (this.sessionId) {
      this.conn.request({ op: "unpublish", sessionId: this.sessionId }).catch(() => {});
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    this.stream = null;
    this.pc = null;
    this.sessionId = null;
  }
}

type Pulled = { mid: string; track: PullTrack };

// `fixed` pins the layer; otherwise the SFU may drop to lower layers when bandwidth is short.
export type Layer = { rid: Rid; fixed: boolean };
const keyOf = (t: { sessionId: string; trackName: TrackName }) => `${t.sessionId}:${t.trackName}`;

// One receiving PeerConnection for every stream in the room. All SFU mutations
// on its session are serialized through `queue`.
export class Subscriber {
  streams = new Map<string, MediaStream>();
  private pc!: RTCPeerConnection;
  private sessionId: string | null = null;
  private pulled = new Map<string, Pulled>();
  private midToKey = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  // Whether this PeerConnection's receivers go through the clip worker. Fixed per connection.
  private clipping = false;
  private lastWant = new Map<Stream, Layer | null>();
  private syncQueued = false;
  // Tracks refused on this connection, with why. Not asked for again until the next sync
  // runs, so one bad track can't fail every attempt.
  private rejected = new Map<string, string>();
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private recoverTimer: ReturnType<typeof setTimeout> | undefined;
  private recoverDelay = RECOVER_MIN_MS;
  private lastRecover = 0;

  constructor(
    private conn: RoomConnection,
    private onChange: () => void,
    private onError: (e: Error | null) => void,
    private clipper: Clipper | null = null,
  ) {
    this.reset(false);
  }

  // Bring pulled tracks in line with `want` (publisher stream → preferred video layer).
  // A null layer pulls audio only (used while the tab is hidden).
  // Calls that queue up behind a running one collapse into one apply of the latest want.
  sync(want: Map<Stream, Layer | null>) {
    this.lastWant = want;
    if (this.syncQueued) return;
    this.syncQueued = true;
    this.queue = this.queue
      .then(() => {
        this.syncQueued = false;
        this.rejected.clear();
        return this.apply(this.lastWant);
      })
      .then(() => this.report())
      .catch(async (e) => {
        if (this.closed) return;
        // A failed exchange leaves the PeerConnection mid-negotiation; start clean and retry once.
        this.reset();
        try {
          await this.apply(this.lastWant);
          this.report();
        } catch (e2) {
          if (!this.closed) this.onError(e2 instanceof Error ? e2 : new Error(String(e ?? e2)));
        }
      });
  }

  // Call after the clipper's keys change. Transforms only take effect on receivers made after
  // them, so starting to buffer means pulling everything again on a new PeerConnection. Turning
  // clips off leaves this one alone: the worker just passes frames through until the next reset.
  updateClips() {
    if (!this.clipper?.keys.size || this.clipping) return;
    this.queue = this.queue
      .then(() => {
        if (this.closed || this.clipping) return;
        this.reset();
        return this.apply(this.lastWant);
      })
      .catch((e) => {
        if (!this.closed) this.onError(e instanceof Error ? e : new Error(String(e)));
      });
  }

  close() {
    this.closed = true;
    clearTimeout(this.graceTimer);
    clearTimeout(this.recoverTimer);
    this.pc.close();
    this.streams.clear();
  }

  // Total media bytes received on the current connection (restarts from 0 after a reset).
  async bytesReceived(): Promise<number> {
    let total = 0;
    (await this.pc.getStats()).forEach((s) => {
      if (s.type === "inbound-rtp") total += s.bytesReceived ?? 0;
    });
    return total;
  }

  // Fresh PeerConnection and SFU session. The old session is abandoned and expires on its own.
  private reset(notify = true) {
    this.pc?.close();
    this.clipping = !!this.clipper?.keys.size;
    this.pc = newPeerConnection(this.clipping && needsInsertableStreams);
    this.sessionId = null;
    this.pulled.clear();
    this.midToKey.clear();
    this.streams.clear();
    this.rejected.clear();
    clearTimeout(this.graceTimer);
    if (notify) this.onChange();

    const pc = this.pc;
    // ICE can fail long after connecting while the room socket stays up (network change, NAT
    // rebinding). "disconnected" often recovers by itself, so give it a moment first.
    pc.addEventListener("connectionstatechange", () => {
      if (pc !== this.pc) return;
      clearTimeout(this.graceTimer);
      if (pc.connectionState === "failed") this.recover(pc);
      else if (pc.connectionState === "disconnected") this.graceTimer = setTimeout(() => this.recover(pc), DISCONNECT_GRACE_MS);
    });
    pc.addEventListener("track", (e) => {
      if (pc !== this.pc) return;
      const key = this.midToKey.get(e.transceiver.mid ?? "");
      if (!key) return;
      const publisher = key.split(":")[0];
      const existing = this.streams.get(publisher)?.getTracks() ?? [];
      this.streams.set(publisher, new MediaStream([...existing.filter((t) => t.kind !== e.track.kind), e.track]));
      if (this.clipping) this.clipper!.attach(e.receiver, publisher, e.track.kind as TrackName, needsInsertableStreams);
      this.onChange();
    });
  }

  // Start over on a new PeerConnection and pull the current want again, backing off when
  // recoveries come close together so a connection that keeps failing can't spin.
  private recover(pc: RTCPeerConnection) {
    if (this.closed || pc !== this.pc || this.recoverTimer) return;
    this.recoverDelay =
      Date.now() - this.lastRecover < RECOVER_RESET_MS ? Math.min(this.recoverDelay * 2, RECOVER_MAX_MS) : RECOVER_MIN_MS;
    this.onError(new Error("Lost the connection to the stream server. Reconnecting…"));
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = undefined;
      this.queue = this.queue
        .then(async () => {
          if (this.closed || pc !== this.pc) return;
          this.lastRecover = Date.now();
          this.reset();
          await this.apply(this.lastWant);
          this.report();
        })
        .catch(() => this.recover(this.pc));
    }, this.recoverDelay);
  }

  // After an apply that went through: clear the banner, or name a track that was refused.
  // Skipped when a newer sync is waiting, which is usually the member update explaining it.
  private report() {
    if (this.syncQueued) return;
    const reason = this.rejected.values().next().value;
    this.onError(reason ? new Error(reason) : null);
  }

  private async apply(want: Map<Stream, Layer | null>) {
    if (this.closed) return;

    // Only what the room lists as live right now: `want` can be older than the latest member
    // update, and the room refuses a whole pull over one stream that has stopped.
    const live = (t: PullTrack) =>
      this.conn.snapshot.members.some((m) => m.stream?.sessionId === t.sessionId && m.stream.tracks.includes(t.trackName));
    const desired = new Map<string, PullTrack>();
    for (const [stream, layer] of want) {
      for (const trackName of stream.tracks) {
        if (trackName === "video" && !layer) continue;
        const t: PullTrack = { sessionId: stream.sessionId, trackName, ...(trackName === "video" ? layer : {}) };
        const k = keyOf(t);
        if (!live(t) || (this.rejected.has(k) && !this.pulled.has(k))) continue;
        desired.set(k, t);
      }
    }

    const toClose = [...this.pulled.entries()].filter(([k]) => !desired.has(k));
    if (toClose.length) await this.closeTracks(toClose.map(([k]) => k));

    const toPull = [...desired.entries()].filter(([k]) => !this.pulled.has(k)).map(([, t]) => t);
    if (toPull.length) await this.pull(toPull);

    for (const [k, t] of desired) {
      const p = this.pulled.get(k);
      if (p && t.rid && !this.rejected.has(k) && (p.track.rid !== t.rid || !!p.track.fixed !== !!t.fixed)) {
        try {
          await this.conn.request({ op: "setLayer", sessionId: this.sessionId!, mid: p.mid, track: { ...t, rid: t.rid } });
          p.track = t;
        } catch (e) {
          // Refused without touching the connection: keep the layer it has.
          if (!(e instanceof ServerError)) throw e;
          this.rejected.set(k, e.message);
        }
      }
    }
  }

  private async ensureSession(): Promise<string> {
    if (!this.sessionId) this.sessionId = (await this.conn.request({ op: "newSession" })).sessionId!;
    return this.sessionId;
  }

  private async pull(tracks: PullTrack[]) {
    const sessionId = await this.ensureSession();
    let res: SfuResponse;
    try {
      res = await this.conn.request({ op: "pull", sessionId, tracks });
    } catch (e) {
      // Refused before anything changed on this connection, usually over one stream that just
      // stopped. Pull the rest one by one so the good ones still come through.
      if (!(e instanceof ServerError)) throw e;
      if (tracks.length === 1) this.rejected.set(keyOf(tracks[0]), e.message);
      else for (const t of tracks) await this.pull([t]);
      return;
    }

    for (const r of res.tracks ?? []) {
      if (r.errorCode || !r.mid || !r.sessionId || !r.trackName) continue;
      const track = tracks.find((t) => t.sessionId === r.sessionId && t.trackName === r.trackName);
      if (!track) continue;
      const key = keyOf(track);
      this.pulled.set(key, { mid: r.mid, track });
      this.midToKey.set(r.mid, key);
    }

    if (res.sessionDescription?.type === "offer") {
      await this.pc.setRemoteDescription(res.sessionDescription);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await gatherIce(this.pc);
      await this.conn.request({ op: "renegotiate", sessionId, sdp: this.pc.localDescription!.sdp });
    }
    // Tracks the SFU refused are set aside; the ones it accepted stay.
    const failed = res.tracks?.find((t) => t.errorCode);
    for (const t of tracks) {
      if (!this.pulled.has(keyOf(t))) this.rejected.set(keyOf(t), failed?.errorDescription ?? failed?.errorCode ?? "Couldn't load that stream");
    }
    if (this.pulled.size) await waitConnected(this.pc);
  }

  private async closeTracks(keys: string[]) {
    // Closing every m-line leaves an SDP with no BUNDLE group, which the browser rejects
    // under max-bundle. When nothing would remain, just start over with a new session.
    if (keys.length === this.pulled.size) {
      const sessionId = this.sessionId;
      const mids = keys.map((k) => this.pulled.get(k)!.mid);
      this.reset();
      if (sessionId) this.conn.request({ op: "close", sessionId, mids }).catch(() => {});
      return;
    }

    const mids = keys.map((k) => this.pulled.get(k)!.mid);
    for (const k of keys) {
      const { mid } = this.pulled.get(k)!;
      this.pulled.delete(k);
      this.midToKey.delete(mid);
      const publisher = k.split(":")[0];
      if (![...this.pulled.keys()].some((x) => x.startsWith(`${publisher}:`))) this.streams.delete(publisher);
    }
    this.onChange();

    for (const t of this.pc.getTransceivers()) if (t.mid && mids.includes(t.mid)) t.stop();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gatherIce(this.pc);
    const res = await this.conn.request({ op: "close", sessionId: this.sessionId!, mids, sdp: this.pc.localDescription!.sdp });
    if (res.sessionDescription) await this.pc.setRemoteDescription(res.sessionDescription);
  }
}
