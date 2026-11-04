import { useEffect, useState, type FormEvent } from "react";
import type { CreateRoomResponse, RoomPeek, UsageResponse } from "../shared/protocol";
import { DASHBOARD, UsageCard } from "../ui/usage";
import { forgetRecent, loadRecent, type RecentRoom } from "./recent";
import { inviteLink, load, remove, save } from "./storage";

type SavedRoom = { roomId: string; link: string; createdAt: number; ownerKey?: string };

const KEY_STORE = "creatorKey";
const ROOMS_STORE = "myRooms";
const PEEK_REFRESH_MS = 30_000;

const tokenOf = (link: string) => new URLSearchParams(link.split("#")[1] ?? "").get("k") ?? "";

// Live status for each saved link: whether it still works and who's in the room.
function usePeeks(rooms: { roomId: string; link: string }[]): Record<string, RoomPeek | undefined> {
  const [peeks, setPeeks] = useState<Record<string, RoomPeek>>({});
  const key = rooms.map((r) => `${r.roomId} ${r.link}`).join("\n");
  useEffect(() => {
    const list = key ? key.split("\n").map((line) => line.split(" ")) : [];
    if (!list.length) return;
    let stopped = false;
    const poll = () => {
      if (document.hidden) return;
      for (const [roomId, link] of list) {
        fetch(`/api/rooms/${encodeURIComponent(roomId)}/peek`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenOf(link) }),
        })
          .then((res) => (res.ok ? (res.json() as Promise<RoomPeek>) : null))
          .then((p) => p && !stopped && setPeeks((prev) => ({ ...prev, [roomId]: p })))
          .catch(() => {});
      }
    };
    poll();
    const id = setInterval(poll, PEEK_REFRESH_MS);
    addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      clearInterval(id);
      removeEventListener("visibilitychange", poll);
    };
  }, [key]);
  return peeks;
}

export function Home() {
  const [creatorKey, setCreatorKey] = useState(() => load(KEY_STORE, ""));
  const [keyDraft, setKeyDraft] = useState("");
  const [rooms, setRooms] = useState<SavedRoom[]>(() => load(ROOMS_STORE, []));
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [recent, setRecent] = useState<RecentRoom[]>(loadRecent);
  const visited = recent.filter((r) => !rooms.some((own) => own.roomId === r.roomId));
  const peeks = usePeeks([...rooms, ...visited]);

  function storeRooms(next: SavedRoom[]) {
    setRooms(next);
    save(ROOMS_STORE, next);
  }

  async function request(roomName: string, rotate: boolean, ownerKey?: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          ...(creatorKey ? { Authorization: `Bearer ${creatorKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: roomName, rotate, ownerKey }),
      });
      const body = await res.json();
      if (res.status === 401) {
        remove(KEY_STORE);
        setCreatorKey("");
      }
      // The creator key can take back a room whose link was lost (cleared browser, other device).
      if (res.status === 409 && !rotate && confirm(`"${roomName}" already exists. Rotate its link to get a new one? Anyone using the old link is disconnected.`)) {
        setBusy(false);
        return request(roomName, true, ownerKey);
      }
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);

      const created = body as CreateRoomResponse;
      const { roomId } = created;
      const room = {
        roomId,
        link: inviteLink(roomId, created.token),
        createdAt: Date.now(),
        ownerKey: created.ownerKey ?? ownerKey,
      };
      storeRooms([room, ...rooms.filter((r) => r.roomId !== roomId)]);
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function submitKey(e: FormEvent) {
    e.preventDefault();
    const key = keyDraft.trim();
    if (!key) return;
    save(KEY_STORE, key);
    setCreatorKey(key);
    setKeyDraft("");
    setShowKeyForm(false);
  }

  function submitRoom(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) request(name, false);
  }

  return (
    <main className="page">
      <h1 className="brand">stream</h1>
      <p className="muted">Rooms for watching each other's games.</p>

      {rooms.length > 0 && (
        <section>
          <h2>Your rooms</h2>
          <ul className="rooms">
            {rooms.map((r) => (
              <RoomRow
                key={r.roomId}
                room={r}
                peek={peeks[r.roomId]}
                canRotate={(!!creatorKey || !!r.ownerKey) && !busy}
                onRotate={() => {
                  if (confirm(`Rotate the link for "${r.roomId}"? The old link stops working and everyone in the room is disconnected.`)) {
                    request(r.roomId, true, r.ownerKey);
                  }
                }}
                onForget={() => storeRooms(rooms.filter((x) => x.roomId !== r.roomId))}
              />
            ))}
          </ul>
        </section>
      )}

      {visited.length > 0 && (
        <section>
          <h2>Recent rooms</h2>
          <ul className="rooms">
            {visited.map((r) => (
              <RoomRow
                key={r.roomId}
                room={r}
                peek={peeks[r.roomId]}
                onForget={() => {
                  forgetRecent(r.roomId);
                  setRecent(loadRecent());
                }}
              />
            ))}
          </ul>
        </section>
      )}

      <JoinForm />

      {creatorKey ? (
        <form className="card" onSubmit={submitRoom}>
          <label htmlFor="name">New room</label>
          <div className="row">
            <input
              id="name"
              placeholder="friends"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" disabled={busy || !name.trim()}>
              Create
            </button>
          </div>
          <button
            type="button"
            className="link small"
            onClick={() => {
              remove(KEY_STORE);
              setCreatorKey("");
            }}
          >
            Forget creator key
          </button>
        </form>
      ) : showKeyForm ? (
        <KeyForm draft={keyDraft} setDraft={setKeyDraft} onSubmit={submitKey} />
      ) : (
        <button type="button" className="link small key-toggle" onClick={() => setShowKeyForm(true)}>
          I have the creator key
        </button>
      )}

      {error && <p className="error">{error}</p>}

      {creatorKey && <Usage creatorKey={creatorKey} />}
    </main>
  );
}

// The installed app has no address bar, so invite links can be pasted here.
function JoinForm() {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const url = new URL(link.trim(), location.origin);
      const room = url.pathname.match(/^\/r\/([^/]+)\/?$/);
      if (!room || !tokenOf(url.href)) throw new Error("not an invite link");
      location.assign(url.origin === location.origin ? `/r/${room[1]}${url.hash}` : url.href);
    } catch {
      setError("That isn't an invite link. It looks like https://…/r/room-name#k=…");
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <label htmlFor="join">Join a room</label>
      <div className="row">
        <input
          id="join"
          className="grow"
          placeholder="Paste an invite link"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setError("");
          }}
          autoComplete="off"
        />
        <button type="submit" disabled={!link.trim()}>Join</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

function Usage({ creatorKey }: { creatorKey: string }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  useEffect(() => {
    fetch("/api/usage", { headers: { Authorization: `Bearer ${creatorKey}` } })
      .then((r) => (r.ok ? (r.json() as Promise<UsageResponse>) : null))
      .then(setUsage)
      .catch(() => setUsage(null));
  }, [creatorKey]);

  const link = (
    <a className="link" href={DASHBOARD} target="_blank" rel="noreferrer">
      Open the Cloudflare dashboard
    </a>
  );

  return <UsageCard usage={usage} link={link} />;
}

function KeyForm(props: {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <form className="card" onSubmit={props.onSubmit}>
      <label htmlFor="key">Creator key</label>
      <p className="muted small">
        Only needed to make rooms. Ask whoever runs this server. Saved in this browser.
      </p>
      <div className="row">
        <input
          id="key"
          type="password"
          value={props.draft}
          onChange={(e) => props.setDraft(e.target.value)}
          autoComplete="off"
        />
        <button type="submit">Save</button>
      </div>
    </form>
  );
}

function RoomRow(props: {
  room: { roomId: string; link: string };
  peek?: RoomPeek;
  canRotate?: boolean;
  onRotate?: () => void;
  onForget: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { room, peek } = props;
  const expired = peek?.ok === false;

  async function copy() {
    try {
      await navigator.clipboard.writeText(room.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt("Copy the invite link:", room.link);
    }
  }

  return (
    <li className={expired ? "card expired" : "card"}>
      <div className="row spread">
        <div className="room-title">
          <strong>{room.roomId}</strong>
          <RoomStatus peek={peek} />
        </div>
        {!expired && (
          <div className="row">
            <button type="button" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
            <a className="button" href={room.link}>Open</a>
          </div>
        )}
      </div>
      <div className="row small">
        {props.onRotate && (
          <button type="button" className="link" disabled={!props.canRotate} onClick={props.onRotate}>
            Rotate link
          </button>
        )}
        <button type="button" className="link" onClick={props.onForget}>
          Remove from list
        </button>
      </div>
    </li>
  );
}

function RoomStatus({ peek }: { peek?: RoomPeek }) {
  if (!peek) return null;
  if (!peek.ok) return <span className="room-status muted small">This link no longer works</span>;
  if (!peek.people) return <span className="room-status muted small">Empty</span>;
  return (
    <span className={peek.live ? "room-status live small" : "room-status muted small"}>
      {peek.people} here{peek.live ? `, ${peek.live} streaming` : ""}
    </span>
  );
}
