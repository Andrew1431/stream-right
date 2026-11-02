import type { PullTrack, Rid, SfuResponse, Stream, TrackName } from "../shared/protocol";
import type { RoomConnection } from "./connection";

// height 0 means the source resolution, uncapped.
export type ShareSettings = { height: number; fps: number };

export const PRESETS = {
  "720p30": { height: 720, fps: 30 },
  "1080p60": { height: 1080, fps: 60 },
  "1440p60": { height: 1440, fps: 60 },
  "2160p60": { height: 2160, fps: 60 },
  source: { height: 0, fps: 60 },
} satisfies Record<string, ShareSettings>;
export type PresetId = keyof typeof PRESETS;

export const HEIGHT_CHOICES = [720, 1080, 1440, 2160, 0];
export const FPS_CHOICES = [30, 60, 90, 100, 120, 144, 165, 240];

export function heightLabel(height: number): string {
  if (!height) return "Source";
  return height === 2160 ? "4K" : `${height}p`;
}

export const settingsLabel = (s: ShareSettings) => `${heightLabel(s.height)} ${s.fps}fps`;

// Compact id the room shows to others, e.g. "1080p100" or "source60".
export const settingsId = (s: ShareSettings) => (s.height ? `${s.height}p${s.fps}` : `source${s.fps}`);

const MAX_BITRATE = 30_000_000;
const REFERENCE_BITRATE = 6_000_000; // 1080p60 16:9
const REFERENCE_PIXELS = 1920 * 1080;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const ICE_GATHER_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 15_000;

function newPeerConnection() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: "max-bundle" });
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
    private onEnded: () => void,
  ) {}

  async start(settings: ShareSettings): Promise<MediaStream> {
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
      });
      checkTracks(res);
      await pc.setRemoteDescription(res.sessionDescription!);
      await waitConnected(pc);
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

  constructor(
    private conn: RoomConnection,
    private onChange: () => void,
    private onError: (e: Error | null) => void,
  ) {
    this.reset(false);
  }

  // Bring pulled tracks in line with `want` (publisher stream → preferred video layer).
  // A null layer pulls audio only (used while the tab is hidden).
  sync(want: Map<Stream, Layer | null>) {
    this.queue = this.queue
      .then(() => this.apply(want))
      .then(() => this.onError(null))
      .catch(async (e) => {
        if (this.closed) return;
        // A failed exchange leaves the PeerConnection mid-negotiation; start clean and retry once.
        this.reset();
        try {
          await this.apply(want);
          this.onError(null);
        } catch (e2) {
          if (!this.closed) this.onError(e2 instanceof Error ? e2 : new Error(String(e ?? e2)));
        }
      });
  }

  close() {
    this.closed = true;
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
    this.pc = newPeerConnection();
    this.sessionId = null;
    this.pulled.clear();
    this.midToKey.clear();
    this.streams.clear();
    if (notify) this.onChange();

    const pc = this.pc;
    pc.addEventListener("track", (e) => {
      if (pc !== this.pc) return;
      const key = this.midToKey.get(e.transceiver.mid ?? "");
      if (!key) return;
      const publisher = key.split(":")[0];
      const existing = this.streams.get(publisher)?.getTracks() ?? [];
      this.streams.set(publisher, new MediaStream([...existing.filter((t) => t.kind !== e.track.kind), e.track]));
      this.onChange();
    });
  }

  private async apply(want: Map<Stream, Layer | null>) {
    if (this.closed) return;

    const desired = new Map<string, PullTrack>();
    for (const [stream, layer] of want) {
      for (const trackName of stream.tracks) {
        if (trackName === "video" && !layer) continue;
        const t: PullTrack = { sessionId: stream.sessionId, trackName, ...(trackName === "video" ? layer : {}) };
        desired.set(keyOf(t), t);
      }
    }

    const toClose = [...this.pulled.entries()].filter(([k]) => !desired.has(k));
    if (toClose.length) await this.closeTracks(toClose.map(([k]) => k));

    const toPull = [...desired.entries()].filter(([k]) => !this.pulled.has(k)).map(([, t]) => t);
    if (toPull.length) await this.pull(toPull);

    for (const [k, t] of desired) {
      const p = this.pulled.get(k);
      if (p && t.rid && (p.track.rid !== t.rid || !!p.track.fixed !== !!t.fixed)) {
        await this.conn.request({ op: "setLayer", sessionId: this.sessionId!, mid: p.mid, track: { ...t, rid: t.rid } });
        p.track = t;
      }
    }
  }

  private async ensureSession(): Promise<string> {
    if (!this.sessionId) this.sessionId = (await this.conn.request({ op: "newSession" })).sessionId!;
    return this.sessionId;
  }

  private async pull(tracks: PullTrack[]) {
    const sessionId = await this.ensureSession();
    const res = await this.conn.request({ op: "pull", sessionId, tracks });

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
    await waitConnected(this.pc);
    checkTracks(res);
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
