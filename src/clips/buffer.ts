import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { avcDecoderConfig, NAL_IDR, NAL_PPS, NAL_SPS, nalType, splitAnnexB, toAvcc } from "./h264";

// `at` is seconds on the worker's clock. Video data is already AVCC.
type Frame = { data: Uint8Array; key: boolean; at: number };

export type BufferStats = {
  seconds: number;
  bytes: number;
  width: number;
  height: number;
  audio: boolean;
  // The stream isn't H.264 (VP8 fallback), so there's nothing we can mux.
  unsupported: boolean;
};

const VIDEO_CLOCK = 90_000;
const OPUS_CLOCK = 48_000;
// Re-anchor a track's RTP timeline to the clock when they drift this far apart (gaps, re-pulls).
const MAX_DRIFT_S = 0.5;
// Without fresh keyframes a buffer can't be trimmed; past this much extra it starts over.
const MAX_EXTRA_S = 60;

// RTP timestamps → seconds on a shared clock, so audio and video line up.
class Timeline {
  private last: number | null = null;
  private unwrapped = 0;
  private anchor: { at: number; rtp: number } | null = null;
  private prev = -Infinity;

  constructor(private rate: number) {}

  at(rtp: number, now: number): number {
    // RTP timestamps are 32-bit and wrap; the int32 difference is the true step.
    if (this.last !== null) this.unwrapped += (rtp - this.last) | 0;
    this.last = rtp;
    let t = this.anchor ? this.anchor.at + (this.unwrapped - this.anchor.rtp) / this.rate : NaN;
    if (!(Math.abs(t - now) <= MAX_DRIFT_S)) {
      this.anchor = { at: now, rtp: this.unwrapped };
      t = now;
    }
    // Keep decode order strictly increasing even across a re-anchor.
    t = Math.max(t, this.prev + 0.001);
    this.prev = t;
    return t;
  }
}

export class StreamBuffer {
  private video: Frame[] = [];
  private audio: Frame[] = [];
  private videoBytes = 0;
  private audioBytes = 0;
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private videoTime = new Timeline(VIDEO_CLOCK);
  private audioTime = new Timeline(OPUS_CLOCK);
  private unsupported = false;
  lastKeyAt = -Infinity;

  pushVideo(data: Uint8Array, key: boolean, rtp: number, now: number) {
    const nals = splitAnnexB(data);
    if (!nals.length) {
      this.unsupported = true;
      return;
    }
    this.unsupported = false;
    const at = this.videoTime.at(rtp, now);
    key ||= nals.some((n) => nalType(n) === NAL_IDR);
    if (key) {
      const sps = nals.find((n) => nalType(n) === NAL_SPS);
      const pps = nals.find((n) => nalType(n) === NAL_PPS);
      // A new resolution or simulcast layer can't share a track with the old one: start over here.
      if (sps && this.sps && !same(sps, this.sps)) this.dropBefore(at);
      if (sps) this.sps = sps.slice();
      if (pps) this.pps = pps.slice();
      if (!this.sps || !this.pps) return;
      this.lastKeyAt = at;
    } else if (!this.video.length) {
      return; // Undecodable until the next keyframe.
    }
    const frame = { data: toAvcc(nals), key, at };
    this.video.push(frame);
    this.videoBytes += frame.data.length;
  }

  pushAudio(data: Uint8Array, rtp: number, now: number) {
    const frame = { data: data.slice(), key: true, at: this.audioTime.at(rtp, now) };
    this.audio.push(frame);
    this.audioBytes += frame.data.length;
  }

  // Keep the last `seconds`, starting at the keyframe at or before the cut.
  trim(seconds: number, now: number) {
    const cut = now - seconds;
    let start = 0;
    for (let i = 0; i < this.video.length && this.video[i].at <= cut; i++) if (this.video[i].key) start = i;
    if (this.video.length && this.video[start].at < cut - MAX_EXTRA_S) {
      // No keyframe since; drop the stale run and wait for the next one.
      const next = this.video.findIndex((f, i) => i > start && f.key);
      start = next === -1 ? this.video.length : next;
    }
    if (start) this.video.splice(0, start).forEach((f) => (this.videoBytes -= f.data.length));

    const audioCut = this.video.length ? Math.min(cut, this.video[0].at) : cut;
    const drop = this.audio.findIndex((f) => f.at >= audioCut);
    const n = drop === -1 ? this.audio.length : drop;
    if (n) this.audio.splice(0, n).forEach((f) => (this.audioBytes -= f.data.length));
  }

  stats(now: number): BufferStats {
    const first = Math.min(this.video[0]?.at ?? Infinity, this.audio[0]?.at ?? Infinity);
    const size = this.sps && this.video.length ? avcDecoderConfig(this.sps, this.pps!) : null;
    return {
      seconds: first === Infinity ? 0 : Math.max(0, now - first),
      bytes: this.videoBytes + this.audioBytes,
      width: size?.codedWidth ?? 0,
      height: size?.codedHeight ?? 0,
      audio: this.audio.length > 0,
      unsupported: this.unsupported,
    };
  }

  // MP4 of the last `seconds`, or null when nothing usable is buffered.
  async mux(seconds: number, now: number): Promise<ArrayBuffer | null> {
    const cut = now - seconds;
    let start = 0;
    for (let i = 0; i < this.video.length && this.video[i].at <= cut; i++) if (this.video[i].key) start = i;
    const video = this.video.slice(start);
    // Frames between the keyframe and the cut get negative times: decoded, but not shown.
    const t0 = Math.max(cut, video[0]?.at ?? this.audio[0]?.at ?? cut);
    const audio = this.audio.filter((f) => f.at >= t0);
    if (!video.length && !audio.length) return null;

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const videoSource = video.length ? new EncodedVideoPacketSource("avc") : null;
    const audioSource = audio.length ? new EncodedAudioPacketSource("opus") : null;
    if (videoSource) output.addVideoTrack(videoSource);
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    if (videoSource) {
      const decoderConfig = avcDecoderConfig(this.sps!, this.pps!);
      for (const [i, f] of video.entries()) {
        const packet = new EncodedPacket(f.data, f.key ? "key" : "delta", f.at - t0, duration(video, i, 1 / 30));
        await videoSource.add(packet, i === 0 ? { decoderConfig } : undefined);
      }
    }
    if (audioSource) {
      const decoderConfig = { codec: "opus", numberOfChannels: 2, sampleRate: OPUS_CLOCK };
      for (const [i, f] of audio.entries()) {
        await audioSource.add(new EncodedPacket(f.data, "key", f.at - t0, duration(audio, i, 0.02)), i === 0 ? { decoderConfig } : undefined);
      }
    }
    await output.finalize();
    return output.target.buffer;
  }

  private dropBefore(at: number) {
    this.video = [];
    this.videoBytes = 0;
    const keep = this.audio.findIndex((f) => f.at >= at);
    this.audio = keep === -1 ? [] : this.audio.slice(keep);
    this.audioBytes = this.audio.reduce((sum, f) => sum + f.data.length, 0);
  }
}

function duration(frames: Frame[], i: number, fallback: number) {
  if (i + 1 < frames.length) return frames[i + 1].at - frames[i].at;
  return i > 0 ? Math.min(frames[i].at - frames[i - 1].at, fallback * 4) : fallback;
}

function same(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
