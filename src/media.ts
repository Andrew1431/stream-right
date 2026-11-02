import type { PullTrack, Rid, SfuResponse, Stream, TrackName } from "../shared/protocol";
import type { RoomConnection } from "./connection";

export const PRESETS = {
  "720p30": { label: "720p 30fps", height: 720, fps: 30, bitrate: 2_500_000 },
  "1080p60": { label: "1080p 60fps", height: 1080, fps: 60, bitrate: 6_000_000 },
  "1440p60": { label: "1440p 60fps", height: 1440, fps: 60, bitrate: 10_000_000 },
  source: { label: "Source (no cap)", height: 0, fps: 60, bitrate: 15_000_000 },
} as const;
export type PresetId = keyof typeof PRESETS;

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

  async start(presetId: PresetId): Promise<MediaStream> {
    const preset = PRESETS[presetId];
    const options = {
      video: {
        frameRate: { ideal: preset.fps, max: preset.fps },
        ...(preset.height ? { height: { max: preset.height } } : {}),
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

      const vt = pc.addTransceiver(video, {
        direction: "sendonly",
        sendEncodings: [
          { rid: "f", maxBitrate: preset.bitrate, maxFramerate: preset.fps },
          { rid: "h", scaleResolutionDownBy: 2, maxBitrate: Math.round(preset.bitrate / 4), maxFramerate: preset.fps },
          { rid: "q", scaleResolutionDownBy: 4, maxBitrate: Math.max(200_000, Math.round(preset.bitrate / 16)), maxFramerate: 30 },
        ],
      });
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
        preset: presetId,
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
const keyOf = (t: { sessionId: string; trackName: TrackName }) => `${t.sessionId}:${t.trackName}`;

// One receiving PeerConnection for every stream in the room. All SFU mutations
// on its session are serialized through `queue`.
export class Subscriber {
  streams = new Map<string, MediaStream>();
  private pc = newPeerConnection();
  private sessionId: string | null = null;
  private pulled = new Map<string, Pulled>();
  private midToKey = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private conn: RoomConnection,
    private onChange: () => void,
    private onError: (e: Error) => void,
  ) {
    this.pc.addEventListener("track", (e) => {
      const key = this.midToKey.get(e.transceiver.mid ?? "");
      if (!key) return;
      const publisher = key.split(":")[0];
      const existing = this.streams.get(publisher)?.getTracks() ?? [];
      this.streams.set(publisher, new MediaStream([...existing.filter((t) => t.kind !== e.track.kind), e.track]));
      this.onChange();
    });
  }

  // Bring pulled tracks in line with `want` (publisher stream → preferred video layer).
  sync(want: Map<Stream, Rid>) {
    this.queue = this.queue.then(() => this.apply(want)).catch((e) => {
      if (!this.closed) this.onError(e instanceof Error ? e : new Error(String(e)));
    });
  }

  close() {
    this.closed = true;
    this.pc.close();
    this.streams.clear();
  }

  private async apply(want: Map<Stream, Rid>) {
    if (this.closed) return;

    const desired = new Map<string, PullTrack>();
    for (const [stream, rid] of want) {
      for (const trackName of stream.tracks) {
        const t: PullTrack = { sessionId: stream.sessionId, trackName, ...(trackName === "video" ? { rid } : {}) };
        desired.set(keyOf(t), t);
      }
    }

    const toClose = [...this.pulled.entries()].filter(([k]) => !desired.has(k));
    if (toClose.length) await this.closeTracks(toClose.map(([k]) => k));

    const toPull = [...desired.entries()].filter(([k]) => !this.pulled.has(k)).map(([, t]) => t);
    if (toPull.length) await this.pull(toPull);

    for (const [k, t] of desired) {
      const p = this.pulled.get(k);
      if (p && t.rid && p.track.rid !== t.rid) {
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
