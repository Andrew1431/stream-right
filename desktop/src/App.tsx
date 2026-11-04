import { useEffect, useRef, useState, type FormEvent } from "react";
import { SidebarGlyph } from "../../ui/SidebarGlyph";
import { GoLiveSheet } from "./GoLiveSheet";
import { onLiveEvent, startLive, stopLive, type LiveEvent, type Whip } from "./live";
import { inShell } from "./native";
import { NewRoomSheet, RoomMenu, ServerUsage } from "./OwnerTools";
import { Sheet } from "./Sheet";
import {
  addInvite,
  loadServers,
  parseInvite,
  peek,
  putRoom,
  removeRoom,
  roomUrl,
  saveServers,
  serverLabel,
  setCreatorKey,
  type Peek,
  type Room,
  type Server,
} from "./servers";

const PEEK_MS = 30_000;
const SELECTED_STORE = "selected";
const COLLAPSED_STORE = "sidebarCollapsed";
// The oldest room bridge this app understands (BRIDGE_VERSION in src/desktop.ts).
const MIN_BRIDGE = 1;
// A room that hasn't said hello by then is on a server from before the bridge.
const BRIDGE_WAIT_MS = 4000;
// Making a token can take a round trip to the room server.
const WHIP_WAIT_MS = 10_000;

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
  // The one native stream this app runs, and the room it's going into.
  const [live, setLive] = useState<{ origin: string; room: string; event: LiveEvent } | null>(null);
  const [liveError, setLiveError] = useState("");
  const requestWhip = useRef<(() => Promise<Whip>) | null>(null);
  useEffect(
    () =>
      onLiveEvent((event) => {
        if (event.state === "stopped") {
          setLive(null);
          if (event.error) setLiveError(event.error);
          return;
        }
        setLive((l) => (l ? { ...l, event } : l));
      }),
    [],
  );
  async function stopStreaming() {
    setLive(null);
    await stopLive().catch((e) => setLiveError(String(e)));
  }
  const [editingServer, setEditingServer] = useState(false);
  const [makingRoom, setMakingRoom] = useState(false);
  const [menu, setMenu] = useState<{ room: string; x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_STORE) === "true");
  const peeks = usePeeks(servers);

  function toggleSidebar() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_STORE, String(!c));
      } catch {
        // Not remembered; fine.
      }
      return !c;
    });
  }

  // Ctrl+B, like most editors. Keys pressed inside the room frame stay in the frame, so the
  // toggle in the room bar is always there too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const closeMenu = useRef(() => setMenu(null)).current;

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

  function forget(s: Server, r: Room) {
    if (!confirm(`Forget ${r.id}? You'll need its invite link to come back.`)) return;
    update(removeRoom(servers, s.origin, r.id));
    if (r === room) select(null);
  }

  const server = servers.find((s) => s.origin === selected?.origin) ?? servers[0] ?? null;
  const room = server?.rooms.find((r) => r.id === selected?.room) ?? null;
  // Without a room open there's nothing to make room for, and nowhere else to pick one.
  const hidden = collapsed && !!room;
  const menuRoom = server?.rooms.find((r) => r.id === menu?.room) ?? null;
  const liveElsewhere = servers.some((s) => s.rooms.some((r) => r !== room && isLive(peeks[key(s.origin, r)])));

  return (
    <div className={hidden ? "shell collapsed" : "shell"}>
      <nav className="rail" aria-label="Servers" inert={hidden}>
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

      <aside className="rooms" inert={hidden}>
        {server ? (
          <>
            <button type="button" className="rooms-head" title="Server settings" onClick={() => setEditingServer(true)}>
              <span className="server-name">{serverLabel(server.origin)}</span>
              <span className="muted small">
                {server.rooms.length === 1 ? "1 room" : `${server.rooms.length} rooms`}
                {server.creatorKey && " · creator"}
              </span>
            </button>
            <ul className="room-list">
              {server.rooms.map((r) => {
                const p = peeks[key(server.origin, r)];
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={r === room ? "room-row active" : "room-row"}
                      onClick={() => select({ origin: server.origin, room: r.id })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const box = e.currentTarget.getBoundingClientRect();
                        // From the keyboard (the menu key) there's no pointer, so open under the row.
                        setMenu({ room: r.id, x: e.clientX || box.left + 12, y: e.clientY || box.bottom });
                      }}
                    >
                      <span className="hash" aria-hidden="true">#</span>
                      <span className="room-id">{r.id}</span>
                      <RoomStatus peek={p} />
                    </button>
                  </li>
                );
              })}
            </ul>
            {server.creatorKey && (
              <button type="button" className="new-room" onClick={() => setMakingRoom(true)}>
                <span aria-hidden="true">+</span> New room
              </button>
            )}
          </>
        ) : (
          <p className="muted small rooms-empty">No servers yet.</p>
        )}

        <footer className="me">
          <div className="me-name">
            <span className="wordmark">stream</span>
            <span className="muted small">{inShell ? "Desktop" : "Preview in a browser"}</span>
          </div>
        </footer>
      </aside>

      <main className="stage">
        {server && room ? (
          <RoomFrame
            key={key(server.origin, room)}
            src={roomUrl(server.origin, room)}
            title={room.id}
            origin={server.origin}
            creatorKey={server.creatorKey ?? ""}
            sidebarHidden={hidden}
            liveElsewhere={liveElsewhere}
            live={!!live && live.origin === server.origin && live.room === room.id}
            whip={requestWhip}
            onToggleSidebar={toggleSidebar}
            onGoLive={() => setGoLive(true)}
            onStopLive={stopStreaming}
            onLeave={() => select({ origin: server.origin, room: null })}
            onForget={() => forget(server, room)}
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
      {editingServer && server && (
        <ServerSheet
          server={server}
          onClose={() => setEditingServer(false)}
          onSave={(key) => {
            update(setCreatorKey(servers, server.origin, key));
            setEditingServer(false);
          }}
        />
      )}
      {makingRoom && server && (
        <NewRoomSheet
          server={server}
          onClose={() => setMakingRoom(false)}
          onCreated={(made) => {
            update(putRoom(servers, server.origin, made));
            select({ origin: server.origin, room: made.id });
            setMakingRoom(false);
          }}
        />
      )}
      {menu && server && menuRoom && (
        <RoomMenu
          key={menuRoom.id}
          server={server}
          room={menuRoom}
          at={menu}
          onClose={closeMenu}
          onRotated={(next) => setServers((now) => {
            const updated = putRoom(now, server.origin, next);
            saveServers(updated);
            return updated;
          })}
          onForget={() => {
            setMenu(null);
            forget(server, menuRoom);
          }}
        />
      )}
      {goLive && server && room && (
        <GoLiveSheet
          roomName={room.id}
          onClose={() => setGoLive(false)}
          onStart={async (source, audio, settings, sourceHeight) => {
            const ask = requestWhip.current;
            if (!ask) throw new Error("The room is still loading");
            const whip = await ask();
            setLiveError("");
            setLive({ origin: server.origin, room: room.id, event: { state: "connecting" } });
            try {
              await startLive(whip, source, audio, settings, sourceHeight);
            } catch (e) {
              setLive(null);
              throw e;
            }
            setGoLive(false);
          }}
        />
      )}
      {liveError && (
        <div className="live-error" role="alert">
          <span>Streaming stopped: {liveError}</span>
          <button type="button" className="quiet" onClick={() => setLiveError("")}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

const key = (origin: string, room: Room) => `${origin}|${room.id}`;
const isLive = (p: Peek | null | undefined) => !!p?.ok && p.live > 0;
const monogram = (label: string) => label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";

function usePeeks(servers: Server[]): Record<string, Peek | null> {
  const [peeks, setPeeks] = useState<Record<string, Peek | null>>({});
  const all = servers.flatMap((s) => s.rooms.map((r) => ({ origin: s.origin, room: r })));
  const signature = all.map((x) => `${key(x.origin, x.room)}#${x.room.token}`).join(",");
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

function RoomFrame(props: {
  src: string;
  title: string;
  origin: string;
  creatorKey: string;
  sidebarHidden: boolean;
  liveElsewhere: boolean;
  live: boolean;
  // Set to a function that asks the room for its WHIP endpoint and token.
  whip: { current: (() => Promise<Whip>) | null };
  onToggleSidebar: () => void;
  onGoLive: () => void;
  onStopLive: () => void;
  onLeave: () => void;
  onForget: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // "waiting" until the room says hello; "old" for servers from before the bridge or too old for this app.
  const [bridge, setBridge] = useState<"waiting" | "ok" | "old">("waiting");
  const [hello, setHello] = useState(0);
  const latest = useRef(props);
  latest.current = props;
  const whipWaiters = useRef(new Map<number, { resolve: (w: Whip) => void; reject: (e: Error) => void }>());

  useEffect(() => {
    let next = 0;
    props.whip.current = () =>
      new Promise<Whip>((resolve, reject) => {
        const id = ++next;
        whipWaiters.current.set(id, { resolve, reject });
        frame.current?.contentWindow?.postMessage({ source: "stream-shell", type: "get-whip", id }, latest.current.origin);
        setTimeout(() => {
          if (whipWaiters.current.delete(id)) reject(new Error("This server's stream is too old to stream from the app. Its owner can update it."));
        }, WHIP_WAIT_MS);
      });
    return () => {
      props.whip.current = null;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setBridge((b) => (b === "waiting" ? "old" : b)), BRIDGE_WAIT_MS);
    const onMessage = (e: MessageEvent) => {
      // Only the room page in this frame, from the server it belongs to, can ask for anything.
      if (e.source !== frame.current?.contentWindow || e.origin !== latest.current.origin) return;
      if (e.data?.source !== "stream-room") return;
      const p = latest.current;
      switch (e.data.type) {
        case "ready":
          setBridge(Number(e.data.v) >= MIN_BRIDGE ? "ok" : "old");
          setHello((n) => n + 1);
          break;
        case "toggle-sidebar":
          p.onToggleSidebar();
          break;
        case "go-live":
          p.onGoLive();
          break;
        case "stop-live":
          p.onStopLive();
          break;
        case "whip": {
          const waiter = whipWaiters.current.get(e.data.id);
          whipWaiters.current.delete(e.data.id);
          if (!waiter) break;
          if (e.data.error) waiter.reject(new Error(String(e.data.error)));
          else if (typeof e.data.endpoint === "string" && typeof e.data.token === "string" && e.data.endpoint.startsWith(p.origin + "/"))
            waiter.resolve({ endpoint: e.data.endpoint, token: e.data.token });
          else waiter.reject(new Error("The room sent a bad stream address"));
          break;
        }
        case "leave":
          p.onLeave();
          break;
        case "forget":
          p.onForget();
          break;
      }
    };
    addEventListener("message", onMessage);
    return () => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
    };
  }, []);

  // The room renders the app's state in its own bar, so send it on every hello and change.
  useEffect(() => {
    if (bridge !== "ok") return;
    frame.current?.contentWindow?.postMessage(
      { source: "stream-shell", type: "state", sidebarHidden: props.sidebarHidden, liveElsewhere: props.liveElsewhere, creatorKey: props.creatorKey, live: props.live },
      props.origin,
    );
  }, [bridge, hello, props.sidebarHidden, props.liveElsewhere, props.creatorKey, props.origin, props.live]);

  const label = props.sidebarHidden ? "Show servers and rooms (Ctrl+B)" : "Hide servers and rooms (Ctrl+B)";
  return (
    <div className={bridge === "old" ? "room-frame with-bar" : "room-frame"}>
      {bridge === "old" && (
        <div className="frame-bar">
          <div className="row">
            <button type="button" className="sidebar-key" title={label} aria-label={label} aria-pressed={!props.sidebarHidden} onClick={props.onToggleSidebar}>
              <SidebarGlyph open={!props.sidebarHidden} />
              {props.sidebarHidden && props.liveElsewhere && <span className="tally small-tally" aria-label="Someone is live in another room" />}
            </button>
            <span className="frame-title"><span className="hash">#</span>{props.title}</span>
            <span className="muted small" title="Its owner can update it to get the app's layout">This server's stream is older than the app</span>
          </div>
          <div className="row">
            {props.live ? (
              <button type="button" className="danger" onClick={props.onStopLive}>Stop streaming</button>
            ) : (
              <button type="button" className="go-live compact" onClick={props.onGoLive}>
                <span className="rec" aria-hidden="true" />
                Go live
              </button>
            )}
            <button type="button" className="quiet" onClick={props.onLeave}>Leave</button>
            <button type="button" className="quiet" onClick={props.onForget}>Forget room</button>
          </div>
        </div>
      )}
      <iframe
        ref={frame}
        src={props.src}
        title={props.title}
        allow="display-capture; autoplay; fullscreen; clipboard-write"
        allowFullScreen
      />
    </div>
  );
}

function ServerSheet(props: { server: Server; onClose: () => void; onSave: (creatorKey: string) => void }) {
  const [key, setKey] = useState(props.server.creatorKey ?? "");
  return (
    <Sheet title={serverLabel(props.server.origin)} onClose={props.onClose}>
      {props.server.creatorKey && <ServerUsage server={props.server} />}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSave(key.trim());
        }}
      >
        <label className="stack tight">
          <span className="small muted">Creator key</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <p className="small muted">
          Only if you run this server. Its rooms then show streaming usage and owner controls. It's kept on this
          computer and only ever sent to {new URL(props.server.origin).host}.
        </p>
        <div className="row spread">
          {props.server.creatorKey ? (
            <button type="button" className="quiet" onClick={() => props.onSave("")}>Remove key</button>
          ) : (
            <span />
          )}
          <div className="row">
            <button type="button" className="quiet" onClick={props.onClose}>Cancel</button>
            <button type="submit">Save</button>
          </div>
        </div>
      </form>
    </Sheet>
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
