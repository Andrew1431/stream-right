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

export async function startLive(whip: Whip, source: LiveSource, audio: LiveAudio, settings: ShareSettings, sourceHeight: number) {
  if (!inShell) throw new Error("Native streaming needs the desktop app");
  const height = settings.height || sourceHeight;
  await invoke("go_live", {
    request: {
      ...whip,
      source,
      audio,
      settings: { height: settings.height, fps: settings.fps, bitrate_kbps: bitrateKbps(height, settings.fps) },
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
