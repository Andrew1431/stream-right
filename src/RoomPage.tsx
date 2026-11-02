import { useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "../shared/protocol";
import { load, save } from "./storage";
import { useRoom, type RoomStatus } from "./useRoom";

const NAME_STORE = "displayName";

function readToken(): string {
  return new URLSearchParams(location.hash.slice(1)).get("k") ?? "";
}

export function RoomPage({ roomId }: { roomId: string }) {
  const [token] = useState(readToken);
  const [name, setName] = useState<string | null>(() => load<string | null>(NAME_STORE, null));

  if (!token) {
    return (
      <main className="page">
        <h1>{roomId}</h1>
        <p className="error">This link is missing its invite code. Ask whoever shared it for the full link.</p>
      </main>
    );
  }

  if (!name) {
    return <NamePrompt roomId={roomId} onDone={(n) => { save(NAME_STORE, n); setName(n); }} />;
  }

  return <Room roomId={roomId} token={token} name={name} onRename={() => setName(null)} />;
}

function NamePrompt({ roomId, onDone }: { roomId: string; onDone: (name: string) => void }) {
  const [draft, setDraft] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = draft.trim();
    if (n) onDone(n);
  }

  return (
    <main className="page">
      <h1>{roomId}</h1>
      <form className="card" onSubmit={submit}>
        <label htmlFor="display-name">Your name</label>
        <div className="row">
          <input
            id="display-name"
            value={draft}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={!draft.trim()}>Join</button>
        </div>
      </form>
    </main>
  );
}

function Room(props: { roomId: string; token: string; name: string; onRename: () => void }) {
  const { status, members, you } = useRoom(props.roomId, props.token, props.name);

  return (
    <main className="page">
      <div className="row spread">
        <h1>{props.roomId}</h1>
        <StatusBadge status={status} />
      </div>

      {status.kind === "closed" ? (
        <p className="error">{status.reason}</p>
      ) : (
        <section className="card">
          <h2>In the room ({members.length})</h2>
          <ul className="members">
            {members.map((m) => (
              <li key={m.id}>
                {m.name}
                {m.id === you && <span className="muted"> (you)</span>}
              </li>
            ))}
          </ul>
          <button type="button" className="link small" onClick={props.onRename}>
            Change name
          </button>
        </section>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: RoomStatus }) {
  const label = {
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    closed: "Disconnected",
  }[status.kind];
  return <span className={`badge ${status.kind}`}>{label}</span>;
}
