import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import { inShell } from "./native";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export type UpdateState =
  | { kind: "none" }
  | { kind: "ready"; version: string }
  | { kind: "installing" }
  | { kind: "failed"; message: string };

// Checks GitHub Releases on launch and every few hours, downloads quietly, and waits for the
// user to restart. Installing never happens on its own, so a live stream is never cut off.
export function useUpdates() {
  const [state, setState] = useState<UpdateState>({ kind: "none" });
  const [version, setVersion] = useState("");
  const pending = useRef<Update | null>(null);

  useEffect(() => {
    if (!inShell) return;
    getVersion().then(setVersion, () => {});
    let stopped = false;
    async function look() {
      if (pending.current) return;
      try {
        const update = await check();
        if (!update || stopped) return;
        await update.download();
        if (stopped) return;
        pending.current = update;
        setState({ kind: "ready", version: update.version });
      } catch {
        // Offline, or no release yet: try again next time.
      }
    }
    look();
    const id = setInterval(look, CHECK_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  async function install() {
    const update = pending.current;
    if (!update) return;
    setState({ kind: "installing" });
    try {
      await update.install();
      await relaunch();
    } catch (e) {
      setState({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { state, version, install };
}
