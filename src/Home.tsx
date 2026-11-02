import { useState, type FormEvent } from "react";
import type { CreateRoomResponse } from "../shared/protocol";
import { inviteLink, load, remove, save } from "./storage";

type SavedRoom = { roomId: string; link: string; createdAt: number };

const KEY_STORE = "creatorKey";
const ROOMS_STORE = "myRooms";

export function Home() {
  const [creatorKey, setCreatorKey] = useState(() => load(KEY_STORE, ""));
  const [keyDraft, setKeyDraft] = useState("");
  const [rooms, setRooms] = useState<SavedRoom[]>(() => load(ROOMS_STORE, []));
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function storeRooms(next: SavedRoom[]) {
    setRooms(next);
    save(ROOMS_STORE, next);
  }

  async function request(roomName: string, rotate: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { Authorization: `Bearer ${creatorKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: roomName, rotate }),
      });
      const body = await res.json();
      if (res.status === 401) {
        remove(KEY_STORE);
        setCreatorKey("");
      }
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);

      const { roomId, token } = body as CreateRoomResponse;
      const room = { roomId, link: inviteLink(roomId, token), createdAt: Date.now() };
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
  }

  function submitRoom(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) request(name, false);
  }

  return (
    <main className="page">
      <h1 className="brand">stream</h1>
      <p className="muted">Rooms for watching each other's games. Join with an invite link.</p>

      {!creatorKey ? (
        <form className="card" onSubmit={submitKey}>
          <label htmlFor="key">Creator key</label>
          <p className="muted small">Only needed to create rooms. Saved in this browser.</p>
          <div className="row">
            <input
              id="key"
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              autoComplete="off"
            />
            <button type="submit">Save</button>
          </div>
        </form>
      ) : (
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
      )}

      {error && <p className="error">{error}</p>}

      {rooms.length > 0 && (
        <section>
          <h2>Your rooms</h2>
          <ul className="rooms">
            {rooms.map((r) => (
              <RoomRow
                key={r.roomId}
                room={r}
                canRotate={!!creatorKey && !busy}
                onRotate={() => {
                  if (confirm(`Rotate the link for "${r.roomId}"? The old link stops working and everyone in the room is disconnected.`)) {
                    request(r.roomId, true);
                  }
                }}
                onForget={() => storeRooms(rooms.filter((x) => x.roomId !== r.roomId))}
              />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function RoomRow(props: { room: SavedRoom; canRotate: boolean; onRotate: () => void; onForget: () => void }) {
  const [copied, setCopied] = useState(false);
  const { room } = props;

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
    <li className="card">
      <div className="row spread">
        <strong>{room.roomId}</strong>
        <div className="row">
          <button type="button" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
          <a className="button" href={room.link}>Open</a>
        </div>
      </div>
      <div className="row small">
        <button type="button" className="link" disabled={!props.canRotate} onClick={props.onRotate}>
          Rotate link
        </button>
        <button type="button" className="link" onClick={props.onForget}>
          Remove from list
        </button>
      </div>
    </li>
  );
}
