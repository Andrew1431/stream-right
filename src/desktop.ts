import { useEffect, useState } from "react";

// When the stream desktop app shows a room, it loads this page in a frame with ?embed=desktop.
// The room keeps its own top bar and talks to the app over postMessage: the app owns the
// sidebar, native Go live and leaving rooms; the room asks for them.

export const inDesktop =
  new URLSearchParams(location.search).get("embed") === "desktop" && window.parent !== window;

// Bumped only for breaking changes, so the app can tell an out-of-date server apart.
export const BRIDGE_VERSION = 1;

export type ShellRequest = "ready" | "toggle-sidebar" | "go-live" | "leave" | "forget";

export type ShellState = {
  sidebarHidden: boolean;
  // Someone is live in a room you aren't looking at, possibly on another server.
  liveElsewhere: boolean;
  // The creator key the app holds for this server, if any.
  creatorKey: string;
};

export function askShell(type: ShellRequest) {
  // Requests carry nothing secret, and the app's origin differs between dev and release builds.
  if (inDesktop) window.parent.postMessage({ source: "stream-room", v: BRIDGE_VERSION, type }, "*");
}

// Say hello as soon as the page loads, before a name is picked, so the app knows this server
// speaks the bridge; the room says it again once it can take the app's state.
askShell("ready");

export function useShell(): ShellState | null {
  const [state, setState] = useState<ShellState | null>(null);
  useEffect(() => {
    if (!inDesktop) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.data?.source !== "stream-shell" || e.data.type !== "state") return;
      const { sidebarHidden, liveElsewhere, creatorKey } = e.data;
      setState({ sidebarHidden: !!sidebarHidden, liveElsewhere: !!liveElsewhere, creatorKey: String(creatorKey ?? "") });
    };
    // Keys pressed in the room never reach the app window, so the room forwards its shortcut.
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        askShell("toggle-sidebar");
      }
    };
    addEventListener("message", onMessage);
    addEventListener("keydown", onKey);
    askShell("ready");
    return () => {
      removeEventListener("message", onMessage);
      removeEventListener("keydown", onKey);
    };
  }, []);
  return state;
}
