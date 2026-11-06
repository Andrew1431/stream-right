import { getCurrentWindow } from "@tauri-apps/api/window";
import { inShell } from "./native";

const CHECK_MS = 5000;

// Asks the window itself: focus events are unreliable once a room's iframe holds the focus.
async function focused(): Promise<boolean> {
  if (!inShell) return !document.hidden;
  return getCurrentWindow().isFocused().catch(() => true);
}

// Runs `run` now, then every `everyMs` while the window has focus, so an app left in the background
// makes no requests. Coming back catches up within a few seconds. Returns the stop function.
export function everyWhileFocused(run: () => void, everyMs: number): () => void {
  let last = Date.now();
  let stopped = false;
  run();
  const id = setInterval(async () => {
    if (Date.now() - last < everyMs || !(await focused()) || stopped) return;
    last = Date.now();
    run();
  }, CHECK_MS);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
