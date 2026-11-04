import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { inShell, listWindows, type CaptureTarget } from "./native";
import {
  addInvite,
  loadServers,
  parseInvite,
  peek,
  removeRoom,
  roomUrl,
  saveServers,
  serverLabel,
  type Peek,
  type Room,
  type Server,
} from "./servers";

const PEEK_MS = 30_000;
const SELECTED_STORE = "selected";

type Selection = { origin: string; room: string | null };

export function App() {
  const [servers, setServers] = useState<Server[]>(loadServers);
  const [selected, setSelected] = useState<Selection | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(SELECTED_STORE) ?? "null");
    } catch {
      return null;
    }
  });
  const [joining, setJoining] = useState(servers.length === 0);
  const [goLive, setGoLive] = useState(false);
  const peeks = usePeeks(servers);

  function update(next: Server[]) {
    setServers(next);
    saveServers(next);
  }

  function select(next: Selection | null) {
    setSelected(next);
    try {
      localStorage.setItem(SELECTED_STORE, JSON.stringify(next));
    } catch {
      // Not remembered; fine.
    }
  }

  const server = servers.find((s) => s.origin === selected?.origin) ?? servers[0] ?? null;
  const room = server?.rooms.find((r) => r.id === selected?.room) ?? null;

  return (
    <div className="shell">
      <nav className="rail" aria-label="Servers">
        {servers.map((s) => {
          const live = s.rooms.some((r) => isLive(peeks[key(s.origin, r)]));
          return (
            <button
              key={s.origin}
              type="button"
              className={s === server ? "coin active" : "coin"}
              title={serverLabel(s.origin)}
              onClick={() => select({ origin: s.origin, room: s === server ? (room?.id ?? null) : null })}
            >
              {monogram(serverLabel(s.origin))}
              {live && <span className="tally" aria-label="Someone is live" />}
            </button>
          );
        })}
        <button type="button" className="coin add" title="Join a room" aria-label="Join a room" onClick={() => setJoining(true)}>
          +
        </button>
      </nav>

      <aside className="rooms">
        {server ? (
          <>
            <header className="rooms-head">
              <span className="server-name">{serverLabel(server.origin)}</span>
              <span className="muted small">{server.rooms.length === 1 ? "1 room" : `${server.rooms.length} rooms`}</span>
            </header>
            <ul className="room-list">
              {server.rooms.map((r) => {
                const p = peeks[key(server.origin, r)];
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={r === room ? "room-row active" : "room-row"}
                      onClick={() => select({ origin: server.origin, room: r.id })}
                    >
                      <span className="hash" aria-hidden="true">#</span>
                      <span className="room-id">{r.id}</span>
                      <RoomStatus peek={p} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="muted small rooms-empty">No servers yet.</p>
        )}

        <footer className="me">
          <div className="me-name">
            <span className="wordmark">stream</span>
            <span className="muted small">{inShell ? "Desktop" : "Preview in a browser"}</span>
          </div>
          <button type="button" className="go-live" disabled={!room} onClick={() => setGoLive(true)}>
            <span className="rec" aria-hidden="true" />
            Go live
          </button>
        </footer>
      </aside>

      <main className="stage">
        {server && room ? (
          <RoomFrame
            key={key(server.origin, room)}
            src={roomUrl(server.origin, room)}
            title={room.id}
            onLeave={() => select({ origin: server.origin, room: null })}
            onForget={() => {
              update(removeRoom(servers, server.origin, room.id));
              select(null);
            }}
          />
        ) : (
          <div className="stage-empty">
            <p className="stage-title">{server ? "Pick a room to join it." : "Paste an invite link to get started."}</p>
            <p className="muted small">
              Rooms you've been sent links for show up on the left, grouped by server, with a red dot when someone is live.
            </p>
          </div>
        )}
      </main>

      {joining && (
        <JoinSheet
          onClose={() => setJoining(false)}
          onJoin={(invite) => {
            update(addInvite(servers, invite));
            select({ origin: invite.origin, room: invite.room.id });
            setJoining(false);
          }}
        />
      )}
      {goLive && room && <GoLiveSheet roomName={room.id} onClose={() => setGoLive(false)} />}
    </div>
  );
}

const key = (origin: string, room: Room) => `${origin}|${room.id}`;
const isLive = (p: Peek | null | undefined) => !!p?.ok && p.live > 0;
const monogram = (label: string) => label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";

function usePeeks(servers: Server[]): Record<string, Peek | null> {
  const [peeks, setPeeks] = useState<Record<string, Peek | null>>({});
  const all = servers.flatMap((s) => s.rooms.map((r) => ({ origin: s.origin, room: r })));
  const signature = all.map((x) => key(x.origin, x.room)).join(",");
  useEffect(() => {
    let stopped = false;
    const poll = () =>
      Promise.all(all.map(async (x) => [key(x.origin, x.room), await peek(x.origin, x.room)] as const)).then(
        (entries) => !stopped && setPeeks(Object.fromEntries(entries)),
      );
    poll();
    const id = setInterval(poll, PEEK_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [signature]);
  return peeks;
}

function RoomStatus({ peek }: { peek: Peek | null | undefined }) {
  if (peek === undefined) return null;
  if (peek === null) return <span className="room-meta muted" title="Couldn't reach this server">–</span>;
  if (!peek.ok) return <span className="room-meta warn" title="This invite link no longer works">Expired</span>;
  return (
    <span className="room-meta">
      {peek.live > 0 && <span className="live-pill">Live</span>}
      {peek.people > 0 && <span className="muted">{peek.people}</span>}
    </span>
  );
}

function RoomFrame(props: { src: string; title: string; onLeave: () => void; onForget: () => void }) {
  return (
    <div className="room-frame">
      <div className="frame-bar">
        <span className="frame-title"><span className="hash">#</span>{props.title}</span>
        <div className="row">
          <button type="button" className="quiet" onClick={props.onLeave}>Leave</button>
          <button
            type="button"
            className="quiet"
            onClick={() => confirm(`Forget ${props.title}? You'll need its invite link to come back.`) && props.onForget()}
          >
            Forget room
          </button>
        </div>
      </div>
      <iframe
        src={props.src}
        title={props.title}
        allow="display-capture; autoplay; fullscreen; clipboard-write"
        allowFullScreen
      />
    </div>
  );
}

function JoinSheet(props: { onClose: () => void; onJoin: (invite: NonNullable<ReturnType<typeof parseInvite>>) => void }) {
  const [text, setText] = useState("");
  const invite = parseInvite(text);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (invite) props.onJoin(invite);
  }

  return (
    <Sheet title="Join a room" onClose={props.onClose}>
      <form onSubmit={submit} className="stack">
        <label className="stack tight">
          <span className="small muted">Invite link</span>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://stream.example.com/r/room#k=…"
            spellCheck={false}
          />
        </label>
        {text && !invite && <p className="warn small">That isn't an invite link. They look like https://…/r/room-name#k=…</p>}
        {invite && (
          <p className="small muted">
            Joins <strong className="plain">#{invite.room.id}</strong> on <strong className="plain">{serverLabel(invite.origin)}</strong>.
            Links from any stream server work; each one gets its own icon on the left.
          </p>
        )}
        <div className="row end">
          <button type="button" className="quiet" onClick={props.onClose}>Cancel</button>
          <button type="submit" disabled={!invite}>Join</button>
        </div>
      </form>
    </Sheet>
  );
}

const QUALITIES = ["720p 60", "1080p 60", "1440p 60", "4K 60"] as const;

function GoLiveSheet(props: { roomName: string; onClose: () => void }) {
  const [targets, setTargets] = useState<CaptureTarget[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [appAudio, setAppAudio] = useState(true);
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>("1080p 60");
  const [note, setNote] = useState("");

  useEffect(() => {
    listWindows()
      .then((list) => {
        // Fullscreen apps are almost always the game you mean.
        const sorted = [...list].sort((a, b) => Number(b.fullscreen) - Number(a.fullscreen));
        setTargets(sorted);
        setPicked(sorted[0]?.id ?? null);
      })
      .catch((e) => setNote(String(e)));
  }, []);

  const target = targets?.find((t) => t.id === picked);

  return (
    <Sheet title={`Go live in #${props.roomName}`} onClose={props.onClose} wide>
      <div className="stack">
        <ul className="targets" role="listbox" aria-label="What to stream">
          {targets === null && <li className="muted small">Looking for windows…</li>}
          {targets?.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={t.id === picked}
                className={t.id === picked ? "target active" : "target"}
                onClick={() => setPicked(t.id)}
              >
                <span className="target-icon" aria-hidden="true">{t.title.slice(0, 1)}</span>
                <span className="target-text">
                  <span className="target-title">{t.title}</span>
                  <span className="muted small">{t.exe}</span>
                </span>
                {t.fullscreen && <span className="tag">Fullscreen</span>}
              </button>
            </li>
          ))}
        </ul>

        <label className="check">
          <input type="checkbox" checked={appAudio} onChange={(e) => setAppAudio(e.target.checked)} />
          <span>
            Only {target?.title ?? "this app"}'s sound
            <span className="muted small"> · Discord, music and everything else stay out of the stream</span>
          </span>
        </label>

        <div className="row spread">
          <div className="segmented" role="radiogroup" aria-label="Quality">
            {QUALITIES.map((q) => (
              <button key={q} type="button" role="radio" aria-checked={q === quality} className={q === quality ? "active" : ""} onClick={() => setQuality(q)}>
                {q}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="go-live"
            disabled={!target}
            onClick={() => setNote("Native capture isn't built yet. It's the next milestone; this sheet is the UI for it.")}
          >
            <span className="rec" aria-hidden="true" />
            Go live
          </button>
        </div>
        {note && <p className="small warn">{note}</p>}
      </div>
    </Sheet>
  );
}

function Sheet(props: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <section className={props.wide ? "sheet wide" : "sheet"} role="dialog" aria-label={props.title}>
        <header className="row spread">
          <h2>{props.title}</h2>
          <button type="button" className="quiet" onClick={props.onClose}>Close</button>
        </header>
        {props.children}
      </section>
    </div>
  );
}
