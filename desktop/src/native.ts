import { invoke, isTauri } from "@tauri-apps/api/core";

// A window the Rust core can capture. `pid` is what app-only audio hooks into.
export type CaptureTarget = {
  id: number;
  title: string;
  exe: string;
  pid: number;
  fullscreen: boolean;
};

// Outside the Tauri shell (plain `npm run dev` in a browser) the UI runs on sample data.
export const inShell = isTauri();

const SAMPLE: CaptureTarget[] = [
  { id: 1, title: "Deep Rock Galactic", exe: "FSD-Win64-Shipping.exe", pid: 4120, fullscreen: true },
  { id: 2, title: "Factorio 2.0.41", exe: "factorio.exe", pid: 9184, fullscreen: false },
  { id: 3, title: "Discord", exe: "Discord.exe", pid: 2210, fullscreen: false },
  { id: 4, title: "stream – Visual Studio Code", exe: "Code.exe", pid: 7764, fullscreen: false },
  { id: 5, title: "Spotify Premium", exe: "Spotify.exe", pid: 6650, fullscreen: false },
];

export async function listWindows(): Promise<CaptureTarget[]> {
  if (!inShell) return SAMPLE;
  return invoke<CaptureTarget[]>("list_windows");
}

// A JPEG data URL of the window at most `maxWidth` wide; "blank" when the window draws nothing
// (fully transparent or black, so it isn't worth listing); null outside the shell or when no frame
// came (minimized windows don't render).
export async function captureThumbnail(id: number, maxWidth: number): Promise<string | "blank" | null> {
  if (!inShell) return null;
  try {
    return (await invoke<string | null>("capture_thumbnail", { id, maxWidth })) ?? "blank";
  } catch {
    return null;
  }
}
