import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { MAX_NAME_LENGTH, type Member, type Rid, type Stream } from "../shared/protocol";
import { RoomConnection, type RoomStatus } from "./connection";
import { PRESETS, Publisher, Subscriber, type PresetId } from "./media";
import { load, save } from "./storage";

const NAME_STORE = "displayName";
const PRESET_STORE = "sharePreset";

const LAYERS: { rid: Rid; label: string }[] = [
  { rid: "f", label: "High" },
  { rid: "h", label: "Medium" },
  { rid: "q", label: "Low" },
];

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

function useConnection(roomId: string, token: string, name: string) {
  const conn = useMemo(() => new RoomConnection(roomId, token, name), [roomId, token, name]);
  useEffect(() => {
    conn.start();
    return () => conn.stop();
  }, [conn]);
  const snapshot = useSyncExternalStore(conn.subscribe, conn.getSnapshot);
  return { conn, ...snapshot };
}

function Room(props: { roomId: string; token: string; name: string; onRename: () => void }) {
  const { conn, status, members, you, epoch } = useConnection(props.roomId, props.token, props.name);
  const [error, setError] = useState("");
  const [viewError, setViewError] = useState("");

  // Publishing
  const [preset, setPreset] = useState<PresetId>(() => {
    const p = load<string>(PRESET_STORE, "1080p60");
    return p in PRESETS ? (p as PresetId) : "1080p60";
  });
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [starting, setStarting] = useState(false);
  const publisher = useMemo(() => new Publisher(conn, () => setLocalStream(null)), [conn]);

  // Receiving
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusRid, setFocusRid] = useState<Rid>("f");

  // SFU sessions don't survive a reconnect: drop everything and start over on each epoch.
  useEffect(() => {
    if (status.kind !== "connected") return;
    const sub = new Subscriber(
      conn,
      () => setRemoteStreams(new Map(sub.streams)),
      (e) => setViewError(e?.message ?? ""),
    );
    setSubscriber(sub);
    return () => {
      sub.close();
      publisher.stop();
      setLocalStream(null);
      setRemoteStreams(new Map());
      setSubscriber(null);
    };
  }, [conn, epoch, status.kind === "connected"]);

  const streaming = members.filter((m) => m.stream);
  const focused =
    streaming.find((m) => m.id === focusId) ?? streaming.find((m) => m.id !== you) ?? streaming[0] ?? null;

  // Pull every remote stream: the focused one at the chosen layer, the rest as low-res thumbnails.
  useEffect(() => {
    if (!subscriber) return;
    const want = new Map<Stream, Rid>();
    for (const m of streaming) {
      if (m.id === you || !m.stream) continue;
      want.set(m.stream, m.id === focused?.id ? focusRid : "q");
    }
    subscriber.sync(want);
  }, [subscriber, streamingKey(streaming), focused?.id, focusRid, you]);

  async function startShare() {
    setError("");
    setStarting(true);
    try {
      setLocalStream(await publisher.start(preset));
    } catch (e) {
      const err = e as Error;
      if (err.name !== "NotAllowedError") setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  function stopShare() {
    publisher.stop();
    setLocalStream(null);
  }

  const streamFor = (m: Member) => (m.id === you ? localStream : (m.stream && remoteStreams.get(m.stream.sessionId)) ?? null);

  return (
    <main className="page wide">
      <div className="row spread">
        <h1>{props.roomId}</h1>
        <StatusBadge status={status} />
      </div>

      {status.kind === "closed" ? (
        <p className="error">{status.reason}</p>
      ) : (
        <>
          <section className="card row spread">
            {localStream ? (
              <>
                <span>
                  Sharing at <strong>{PRESETS[preset].label}</strong>
                </span>
                <button type="button" className="danger" onClick={stopShare}>Stop sharing</button>
              </>
            ) : (
              <>
                <select
                  value={preset}
                  onChange={(e) => {
                    setPreset(e.target.value as PresetId);
                    save(PRESET_STORE, e.target.value);
                  }}
                >
                  {Object.entries(PRESETS).map(([id, p]) => (
                    <option key={id} value={id}>{p.label}</option>
                  ))}
                </select>
                <button type="button" disabled={status.kind !== "connected" || starting} onClick={startShare}>
                  {starting ? "Starting…" : "Share screen"}
                </button>
              </>
            )}
          </section>

          {error && <p className="error">{error}</p>}
          {viewError && <p className="error">{viewError}</p>}

          {focused && (
            <section className="stage">
              <VideoTile
                member={focused}
                stream={streamFor(focused)}
                isYou={focused.id === you}
                large
              />
              {focused.id !== you && (
                <div className="row small">
                  Quality:
                  {LAYERS.map((l) => (
                    <button
                      key={l.rid}
                      type="button"
                      className={focusRid === l.rid ? "chip active" : "chip"}
                      onClick={() => setFocusRid(l.rid)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {streaming.length > 1 && (
            <section className="thumbs">
              {streaming
                .filter((m) => m.id !== focused?.id)
                .map((m) => (
                  <button key={m.id} type="button" className="thumb" onClick={() => setFocusId(m.id)}>
                    <VideoTile member={m} stream={streamFor(m)} isYou={m.id === you} />
                  </button>
                ))}
            </section>
          )}

          <section className="card">
            <h2>In the room ({members.length})</h2>
            <ul className="members">
              {members.map((m) => (
                <li key={m.id}>
                  {m.name}
                  {m.id === you && <span className="muted"> (you)</span>}
                  {m.stream && <span className="live">LIVE</span>}
                </li>
              ))}
            </ul>
            <button type="button" className="link small" onClick={props.onRename}>
              Change name
            </button>
          </section>
        </>
      )}
    </main>
  );
}

// Stable dependency for the pull effect: changes only when the set of live streams does.
function streamingKey(members: Member[]): string {
  return members.map((m) => `${m.id}:${m.stream?.sessionId}:${m.stream?.tracks.join(",")}`).join("|");
}

function VideoTile(props: { member: Member; stream: MediaStream | null; isYou: boolean; large?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const stats = useVideoStats(ref, props.stream);

  useEffect(() => {
    if (ref.current && ref.current.srcObject !== props.stream) ref.current.srcObject = props.stream;
  }, [props.stream]);

  const hasAudio = !props.isYou && !!props.stream?.getAudioTracks().length;

  return (
    <div className={props.large ? "tile large" : "tile"}>
      <video ref={ref} autoPlay playsInline muted={props.isYou || muted} />
      {!props.stream && <div className="tile-empty">Connecting…</div>}
      <div className="tile-label">
        {props.member.name}
        {props.isYou && " (you)"}
        {stats && <span className="muted"> · {stats}</span>}
      </div>
      {props.large && hasAudio && (
        <button type="button" className="tile-mute" onClick={() => setMuted((m) => !m)}>
          {muted ? "Unmute" : "Mute"}
        </button>
      )}
    </div>
  );
}

function useVideoStats(ref: React.RefObject<HTMLVideoElement | null>, stream: MediaStream | null) {
  const [stats, setStats] = useState("");
  useEffect(() => {
    if (!stream) return setStats("");
    let lastFrames = -1;
    let lastTime = performance.now();
    const id = setInterval(() => {
      const v = ref.current;
      if (!v || !v.videoWidth) return;
      const frames = v.getVideoPlaybackQuality().totalVideoFrames;
      const now = performance.now();
      const fps = lastFrames < 0 ? 0 : Math.round(((frames - lastFrames) * 1000) / (now - lastTime));
      lastFrames = frames;
      lastTime = now;
      setStats(`${v.videoWidth}×${v.videoHeight}${fps ? ` ${fps}fps` : ""}`);
    }, 1000);
    return () => clearInterval(id);
  }, [ref, stream]);
  return stats;
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
