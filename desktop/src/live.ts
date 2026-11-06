import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ShareSettings } from "../../ui/presets";
import { inShell } from "./native";

// Mirrors desktop/src-tauri/src/live/mod.rs.
export type LiveSource = { kind: "window"; id: number; pid: number } | { kind: "monitor"; id: number };
export type LiveAudio = { kind: "app"; pid: number } | { kind: "allExceptVoice"; except: string[] } | { kind: "onlyApps"; only: string[] } | { kind: "off" };
export type MicState = "off" | "opening" | "on";
export type LiveVideoSettings = { height: number; fps: number; bitrate_kbps: number; total_kbps: number; layers: number };
export type LiveEvent =
  | { state: "connecting" }
  | { state: "live" }
  | { state: "reconnecting"; attempt: number }
  | { state: "stats"; video_kbps: number; audio_kbps: number; fps: number }
  | { state: "mic"; mic: MicState; error: string | null }
  | { state: "stopped"; error: string | null };

export type Whip = { endpoint: string; token: string };
export type LiveTarget = { origin: string; room: string };
export type LiveConfig = { source: LiveSource; sourceLabel: string; sourceExe: string; audio: LiveAudio; settings: LiveVideoSettings };
export type SourceChange = { source: LiveSource; sourceLabel: string; sourceExe: string };
export type LiveStatus = { target: LiveTarget; config: LiveConfig; mic: MicState };
// `exe` is lowercase: it's the key that outlives a pid.
export type AudioApp = { exe: string; name: string; playing: boolean };

const SAMPLE_APPS: AudioApp[] = [
  { exe: "emberdepths-win64-shipping.exe", name: "Ember Depths", playing: true },
  { exe: "spotify.exe", name: "Spotify Premium", playing: true },
  { exe: "code.exe", name: "stream – Visual Studio Code", playing: false },
];

// Roughly what the browser share asks for at the same size and rate: 6 Mbps at 1080p60.
export function bitrateKbps(height: number, fps: number): number {
  const pixels = (height / 1080) ** 2;
  return Math.round(Math.min(30000, Math.max(300, 6000 * pixels ** 0.8 * (fps / 60) ** 0.6)));
}

// Simulcast copies sent alongside the full picture, so viewers can pick a smaller one.
export type LayerCount = 1 | 2 | 3;
export const LAYER_COUNTS: LayerCount[] = [1, 2, 3];

// Matches layer_size / layer_fps in desktop/src-tauri/src/live/mod.rs: evenly spaced sizes
// (3 layers: full, 2/3, 1/3), lower layers at most 60fps.
// The 16:9 height with the same picture area, which is what the encoder sizes its bitrate by.
export const equivalentHeight = (width: number, height: number) => Math.round(Math.sqrt((width * height * 9) / 16));

export function uploadKbps(height: number, fps: number, layers: LayerCount): number {
  let total = OPUS_UPLOAD_KBPS;
  for (let i = 0; i < layers; i++) {
    const h = Math.round((height * (layers - i)) / layers) & ~1;
    total += i === 0 ? bitrateKbps(h, fps) : Math.min(bitrateKbps(h, Math.min(fps, 60)), bitrateKbps(height, fps));
  }
  return total;
}

export const OPUS_UPLOAD_KBPS = 128;

export const mbps = (kbps: number) => `${(kbps / 1000).toFixed(1)} Mbps`;

// What Go live or Modify sends about the picture. No bitrate: the encoder picks it from the size it
// really encodes, and follows resizes.
const videoSettings = (settings: ShareSettings, layers: number, totalKbps: number) => ({
  height: settings.height,
  fps: settings.fps,
  bitrate_kbps: 0,
  layers,
  total_kbps: totalKbps,
});

export type LiveChoices = {
  source: LiveSource;
  // Shown as "Showing <label>" when modifying the stream.
  sourceLabel: string;
  sourceExe: string;
  audio: LiveAudio;
  settings: ShareSettings;
  layers: LayerCount;
  totalKbps: number;
  mic: boolean;
};

export async function startLive(whip: Whip, target: LiveTarget, choices: LiveChoices) {
  if (!inShell) throw new Error("Native streaming needs the desktop app");
  const { source, sourceLabel, sourceExe, audio, settings, layers, totalKbps, mic } = choices;
  await invoke("go_live", {
    request: { ...whip, source, sourceLabel, sourceExe, audio, target, mic, settings: videoSettings(settings, layers, totalKbps) },
  });
}

// The stream the app is already running, if any: it keeps going when the UI reloads.
export async function liveStatus(): Promise<LiveStatus | null> {
  return inShell ? invoke<LiveStatus | null>("live_status") : null;
}

// Changes the running stream. Rejects, with the stream still on its old settings, if they don't work.
export async function modifyLive(audio: LiveAudio, settings: ShareSettings, layers: number, totalKbps: number, source: SourceChange | null) {
  await invoke("modify_live", { audio, settings: videoSettings(settings, layers, totalKbps), source });
}

// The result comes back as "mic" events: it's only on once the device is really open.
export async function setLiveMic(on: boolean) {
  await invoke("set_live_mic", { on });
}

export async function listAudioApps(): Promise<AudioApp[]> {
  return inShell ? invoke<AudioApp[]>("list_audio_apps") : SAMPLE_APPS;
}

export async function stopLive() {
  if (inShell) await invoke("stop_live");
}

export function onLiveEvent(handler: (e: LiveEvent) => void): () => void {
  if (!inShell) return () => {};
  const off = listen<LiveEvent>("live", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}
