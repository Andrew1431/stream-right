import { useEffect, useState, type FormEvent } from "react";
import type { CreateRoomResponse, UsageResponse } from "../shared/protocol";
import { inviteLink, load, remove, save } from "./storage";
import { DASHBOARD, gb } from "./UsagePanel";

type SavedRoom = { roomId: string; link: string; createdAt: number; ownerKey?: string };

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
        <KeyForm draft={keyDraft} setDraft={setKeyDraft} onSubmit={submitKey} />
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

      {creatorKey && <Usage creatorKey={creatorKey} />}

      {rooms.length > 0 && (
        <section>
          <h2>Your rooms</h2>
          <ul className="rooms">
            {rooms.map((r) => (
              <RoomRow
                key={r.roomId}
                room={r}
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
    </main>
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

  if (!usage?.configured || "error" in usage) {
    return (
      <p className="muted small usage-note">
        {usage && "error" in usage ? `Couldn't read usage: ${usage.error} ` : "See how much of the free 1,000 GB you've used: "}
        {link}
      </p>
    );
  }

  const share = usage.egressBytes / usage.freeBytes;
  const month = new Date(usage.since + "T00:00:00Z").toLocaleString(undefined, { month: "long", timeZone: "UTC" });
  return (
    <section className="card usage">
      <div className="row spread">
        <h2>Streaming this month</h2>
        <span className="muted small">since {month} 1</span>
      </div>
      <div
        className={`usage-bar${share >= 1 ? " over" : share >= 0.8 ? " near" : ""}`}
        role="img"
        aria-label={`${gb(usage.egressBytes)} of ${gb(usage.freeBytes)} free gigabytes used`}
      >
        <span style={{ width: `${Math.min(share, 1) * 100}%` }} />
      </div>
      <p className="small">
        <strong>{gb(usage.egressBytes)} GB</strong> <span className="muted">of {gb(usage.freeBytes)} GB free.</span>{" "}
        {share >= 1 && <span>Past the free amount: about ${((usage.egressBytes - usage.freeBytes) / 1e9 * 0.05).toFixed(2)} so far. </span>}
        <span className="muted">Updated every few minutes; your Cloudflare bill is exact.</span>
      </p>
      {link}
    </section>
  );
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
