import { invoke, isTauri } from "@tauri-apps/api/core";
import { sampleIcon, sampleMonitorThumbnail, sampleThumbnail } from "./sample";

// A window the Rust core can capture. `pid` is what app-only audio hooks into.
export type CaptureTarget = {
  id: number;
  title: string;
  exe: string;
  pid: number;
  fullscreen: boolean;
  // The program's icon as a PNG data URL.
  icon?: string | null;
};

// A whole screen; `id` is the monitor handle the capture side takes.
export type MonitorTarget = { id: number; width: number; height: number; primary: boolean };

// Outside the Tauri shell (plain `npm run dev` in a browser) the UI runs on sample data.
export const inShell = isTauri();

const SAMPLE: CaptureTarget[] = [
  { id: 1, title: "Ember Depths", exe: "EmberDepths-Win64-Shipping.exe", pid: 4120, fullscreen: true },
  { id: 2, title: "Cogworks 1.4", exe: "cogworks.exe", pid: 9184, fullscreen: false },
  { id: 3, title: "Discord", exe: "Discord.exe", pid: 2210, fullscreen: false },
  { id: 4, title: "stream – Visual Studio Code", exe: "Code.exe", pid: 7764, fullscreen: false },
  { id: 5, title: "Spotify Premium", exe: "Spotify.exe", pid: 6650, fullscreen: false },
];

export async function listWindows(): Promise<CaptureTarget[]> {
  if (!inShell) return SAMPLE.map((w) => ({ ...w, icon: sampleIcon(w.id, w.title) }));
  return invoke<CaptureTarget[]>("list_windows");
}

export async function listMonitors(): Promise<MonitorTarget[]> {
  if (!inShell) return [{ id: 1, width: 2560, height: 1440, primary: true }, { id: 2, width: 1920, height: 1080, primary: false }];
  return invoke<MonitorTarget[]>("list_monitors");
}

// A JPEG data URL of the window at most `maxWidth` wide; "blank" when the window draws nothing
// (fully transparent or black, so it isn't worth listing); null outside the shell or when no frame
// came (minimized windows don't render).
export async function captureThumbnail(id: number, maxWidth: number): Promise<string | "blank" | null> {
  if (!inShell) return sampleThumbnail(id);
  try {
    return (await invoke<string | null>("capture_thumbnail", { id, maxWidth })) ?? "blank";
  } catch {
    return null;
  }
}

// Opens a web page in the user's browser (the app's own window only shows rooms).
export async function openExternal(url: string) {
  if (!inShell) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function captureMonitorThumbnail(id: number, maxWidth: number): Promise<string | "blank" | null> {
  if (!inShell) return id === 1 ? sampleMonitorThumbnail(1, 2560, 1440) : sampleMonitorThumbnail(2, 1920, 1080);
  try {
    return (await invoke<string | null>("capture_monitor_thumbnail", { id, maxWidth })) ?? "blank";
  } catch {
    return null;
  }
}
