import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { UsageResponse } from "../../shared/protocol";
import { UsageCard } from "../../ui/usage";
import { createRoom, fetchUsage, OwnerError, rotateRoom } from "./owner";
import { inviteLink, serverLabel, type Room, type Server } from "./servers";
import { Sheet } from "./Sheet";
import { everyWhileFocused } from "./whileFocused";

const USAGE_REFRESH_MS = 60_000;
const host = (origin: string) => new URL(origin).host;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Make a room on a server you hold the creator key for.
export function NewRoomSheet(props: { server: Server; onClose: () => void; onCreated: (room: Room) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const wanted = name.trim();
    if (!wanted) return;
    setBusy(true);
    setError("");
    try {
      props.onCreated(await createRoom(props.server, wanted));
    } catch (err) {
      // The creator key can take back a room whose link was lost (another computer, a cleared browser).
      if (
        err instanceof OwnerError &&
        err.status === 409 &&
        confirm(`"${wanted}" already exists on ${host(props.server.origin)}. Rotate its link to get a new one? Anyone using the old link is disconnected.`)
      ) {
        try {
          // Keep the owner key if this app already holds the room; the server only sends a new one
          // when the room never had one.
          const held = props.server.rooms.find((r) => r.id === wanted);
          props.onCreated(await rotateRoom(props.server, { id: wanted, ownerKey: held?.ownerKey }));
          return;
        } catch (again) {
          setError(message(again));
        }
      } else {
        setError(message(err));
      }
      setBusy(false);
    }
  }

  return (
    <Sheet title={`New room on ${serverLabel(props.server.origin)}`} onClose={props.onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="stack tight">
          <span className="small muted">Name</span>
          <input autoFocus value={name} maxLength={40} placeholder="friends" onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        <p className="small muted">
          Becomes the room's address, in lowercase with dashes. You get its invite link to send people from the room's
          menu (right-click it on the left).
        </p>
        {error && <p className="small warn">{error}</p>}
        <div className="row end">
          <button type="button" className="quiet" onClick={props.onClose}>Cancel</button>
          <button type="submit" disabled={busy || !name.trim()}>{busy ? "Making…" : "Make room"}</button>
        </div>
      </form>
    </Sheet>
  );
}

// Right-click menu for a room: copy its link, rotate it (with the creator or owner key), forget it.
export function RoomMenu(props: {
  server: Server;
  room: Room;
  at: { x: number; y: number };
  onClose: () => void;
  onRotated: (room: Room) => void;
  onForget: () => void;
}) {
  const { server, room } = props;
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(props.at);
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // A confirm dialog takes focus from the window; that blur isn't the user leaving the menu.
  const holding = useRef(false);
  const canRotate = !!server.creatorKey || !!room.ownerKey;

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const r = menu.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.min(props.at.x, innerWidth - r.width - 8), y: Math.min(props.at.y, innerHeight - r.height - 8) });
    menu.current?.querySelector("button")?.focus();
  }, [props.at.x, props.at.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && props.onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    // Clicks in the room frame never reach this window, but they do take its focus.
    const onBlur = () => !holding.current && props.onClose();
    addEventListener("blur", onBlur);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
      removeEventListener("blur", onBlur);
    };
  }, [props.onClose]);

  async function copy(link: string, done = "Copied the invite link") {
    try {
      await navigator.clipboard.writeText(link);
      setNote({ text: done });
      setTimeout(props.onClose, 900);
    } catch {
      holding.current = true;
      prompt("Copy the invite link:", link);
      props.onClose();
    }
  }

  async function rotate() {
    holding.current = true;
    if (!confirm(`Rotate the link for #${room.id}? The old link stops working and everyone in the room is disconnected.`)) {
      holding.current = false;
      menu.current?.querySelector("button")?.focus();
      return;
    }
    setBusy(true);
    try {
      const next = await rotateRoom(server, room);
      props.onRotated(next);
      await copy(inviteLink(server.origin, next), "New link copied");
    } catch (e) {
      setNote({ text: message(e), warn: true });
      setBusy(false);
    }
  }

  return (
    <div ref={menu} className="menu" role="menu" aria-label={`#${room.id}`} style={{ left: pos.x, top: pos.y }}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => copy(inviteLink(server.origin, room))}>
        Copy invite link
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy || !canRotate}
        title={canRotate ? undefined : "Needs this server's creator key, or the room to have been made in this app"}
        onClick={rotate}
      >
        {busy ? "Rotating…" : "Rotate link…"}
      </button>
      <hr />
      <button type="button" role="menuitem" className="danger" disabled={busy} onClick={props.onForget}>
        Forget room
      </button>
      {note && <p className={note.warn ? "menu-note small warn" : "menu-note small muted"}>{note.text}</p>}
    </div>
  );
}

// This month's streaming for a server, refreshed while it's on screen.
export function ServerUsage({ server }: { server: Server }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    const poll = () =>
      fetchUsage(server)
        .then((u) => {
          if (stopped) return;
          setUsage(u);
          setError("");
        })
        .catch((e) => !stopped && setError(message(e)));
    const stop = everyWhileFocused(poll, USAGE_REFRESH_MS);
    return () => {
      stopped = true;
      stop();
    };
  }, [server.origin, server.creatorKey]);

  if (error && !usage) return <p className="small warn usage-note">Couldn't read usage: {error}</p>;
  return <UsageCard usage={usage} />;
}
