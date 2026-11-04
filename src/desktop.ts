import { useEffect, useRef, useState } from "react";

// When the stream desktop app shows a room, it loads this page in a frame with ?embed=desktop.
// The room keeps its own top bar and talks to the app over postMessage: the app owns the
// sidebar, native Go live and leaving rooms; the room asks for them.

export const inDesktop =
  new URLSearchParams(location.search).get("embed") === "desktop" && window.parent !== window;

// The desktop app is Windows only. Browsers can't tell whether it's installed, so the link is
// always offered there, with a download link beside it.
export const offerDesktopApp = !inDesktop && navigator.userAgent.includes("Windows");
export const DESKTOP_DOWNLOAD = "https://github.com/Andrew1431/stream-right/releases/latest";

// Handled by desktop/src/deeplink.ts: the app opens its join sheet with this invite filled in.
export const desktopAppLink = (invite: string) => `stream-desktop://join?url=${encodeURIComponent(invite)}`;

// Bumped only for breaking changes, so the app can tell an out-of-date server apart.
export const BRIDGE_VERSION = 1;

export type ShellRequest = "ready" | "toggle-sidebar" | "go-live" | "stop-live" | "leave" | "forget";

export type ShellState = {
  sidebarHidden: boolean;
  // Someone is live in a room you aren't looking at, possibly on another server.
  liveElsewhere: boolean;
  // The creator key the app holds for this server, if any.
  creatorKey: string;
  // The app is streaming natively into this room.
  live: boolean;
  // Measured upload of that stream in kbps; 0 until known, and from apps that don't send it.
  uploadKbps: number;
};

export function askShell(type: ShellRequest) {
  // Requests carry nothing secret, and the app's origin differs between dev and release builds.
  if (inDesktop) window.parent.postMessage({ source: "stream-room", v: BRIDGE_VERSION, type }, "*");
}

// Say hello as soon as the page loads, before a name is picked, so the app knows this server
// speaks the bridge; the room says it again once it can take the app's state.
askShell("ready");

// The app asks for the room's WHIP endpoint and OBS token when you press Go live in it. Anyone who
// can frame this page already has the invite link, which lets them share anyway.
export function useWhipHandoff(getToken: () => Promise<string>, whipUrl: string) {
  const latest = useRef(getToken);
  latest.current = getToken;
  useEffect(() => {
    if (!inDesktop) return;
    const onMessage = async (e: MessageEvent) => {
      if (e.source !== window.parent || e.data?.source !== "stream-shell" || e.data.type !== "get-whip") return;
      const reply = (body: object) =>
        (e.source as Window).postMessage({ source: "stream-room", v: BRIDGE_VERSION, type: "whip", id: e.data.id, ...body }, e.origin);
      try {
        reply({ endpoint: whipUrl, token: await latest.current() });
      } catch (err) {
        reply({ error: err instanceof Error ? err.message : String(err) });
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [whipUrl]);
}

export function useShell(): ShellState | null {
  const [state, setState] = useState<ShellState | null>(null);
  useEffect(() => {
    if (!inDesktop) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.data?.source !== "stream-shell" || e.data.type !== "state") return;
      const { sidebarHidden, liveElsewhere, creatorKey, live, uploadKbps } = e.data;
      setState({
        sidebarHidden: !!sidebarHidden,
        liveElsewhere: !!liveElsewhere,
        creatorKey: String(creatorKey ?? ""),
        live: !!live,
        uploadKbps: Number(uploadKbps) > 0 ? Number(uploadKbps) : 0,
      });
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
