import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ShareSettings } from "../../ui/presets";
import { inShell } from "./native";

// Mirrors desktop/src-tauri/src/live/mod.rs.
export type LiveSource = { kind: "window"; id: number; pid: number } | { kind: "monitor"; id: number };
export type LiveAudio = { kind: "app"; pid: number } | { kind: "allExceptVoice" } | { kind: "off" };
export type LiveEvent =
  | { state: "connecting" }
  | { state: "live" }
  | { state: "reconnecting"; attempt: number }
  | { state: "stats"; video_kbps: number; audio_kbps: number; fps: number }
  | { state: "stopped"; error: string | null };

export type Whip = { endpoint: string; token: string };

// Roughly what the browser share asks for at the same size and rate: 6 Mbps at 1080p60.
export function bitrateKbps(height: number, fps: number): number {
  const pixels = (height / 1080) ** 2;
  return Math.round(Math.min(30000, Math.max(1000, 6000 * pixels ** 0.8 * (fps / 60) ** 0.6)));
}

// Simulcast copies sent alongside the full picture, so viewers can pick a smaller one.
export type LayerCount = 1 | 2 | 3;
export const LAYER_COUNTS: LayerCount[] = [1, 2, 3];

// Matches layer_size / layer_fps in desktop/src-tauri/src/live/mod.rs: evenly spaced sizes
// (3 layers: full, 2/3, 1/3), lower layers at most 60fps.
export function uploadKbps(height: number, fps: number, layers: LayerCount): number {
  let total = OPUS_KBPS;
  for (let i = 0; i < layers; i++) {
    const h = Math.round((height * (layers - i)) / layers) & ~1;
    total += i === 0 ? bitrateKbps(h, fps) : Math.min(bitrateKbps(h, Math.min(fps, 60)), bitrateKbps(height, fps));
  }
  return total;
}

const OPUS_KBPS = 128;

export const mbps = (kbps: number) => `${(kbps / 1000).toFixed(1)} Mbps`;

export async function startLive(
  whip: Whip,
  source: LiveSource,
  audio: LiveAudio,
  settings: ShareSettings,
  sourceHeight: number,
  layers: LayerCount,
) {
  if (!inShell) throw new Error("Native streaming needs the desktop app");
  const height = settings.height || sourceHeight;
  await invoke("go_live", {
    request: {
      ...whip,
      source,
      audio,
      settings: { height: settings.height, fps: settings.fps, bitrate_kbps: bitrateKbps(height, settings.fps), layers },
    },
  });
}

export async function stopLive() {
  if (inShell) await invoke("stop_live");
}

export function onLiveEvent(handler: (e: LiveEvent) => void): () => void {
  if (!inShell) return () => {};
  const off = listen<LiveEvent>("live", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}
