// stream-desktop://join?url=<invite link>, from a room page's "Open in the desktop app".
import { inShell } from "./native";
import { parseInvite } from "./servers";

export type Invite = NonNullable<ReturnType<typeof parseInvite>>;

export function parseDeepLink(link: string): Invite | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "stream-desktop:") return null;
    // Windows may hand over stream-desktop://join/?url=..., so the host is checked, not the path.
    if (url.hostname !== "join") return null;
    const invite = url.searchParams.get("url");
    return invite ? parseInvite(invite) : null;
  } catch {
    return null;
  }
}

// Calls onInvite for the link that launched the app and for each one that arrives while it
// runs. Returns the unsubscribe.
export function onDeepLink(onInvite: (invite: Invite) => void): () => void {
  if (!inShell) return () => {};
  let stopped = false;
  let unlisten: (() => void) | null = null;
  const handle = (urls: string[] | null) => {
    if (stopped) return;
    const invite = urls?.map(parseDeepLink).find((i) => i !== null);
    if (invite) onInvite(invite);
  };
  void import("@tauri-apps/plugin-deep-link").then(async ({ getCurrent, onOpenUrl }) => {
    const fn = await onOpenUrl(handle);
    if (stopped) fn();
    else unlisten = fn;
    handle(await getCurrent().catch(() => null));
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
