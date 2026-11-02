import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { MAX_NAME_LENGTH, type Member, type Rid, type Stream } from "../shared/protocol";
import { RoomConnection, type RoomStatus } from "./connection";
import {
  FPS_CHOICES,
  HEIGHT_CHOICES,
  heightLabel,
  PRESETS,
  Publisher,
  settingsLabel,
  Subscriber,
  type Layer,
  type PresetId,
  type ShareSettings,
} from "./media";
import { loadObsKey, ObsPanel, obsKeyId } from "./ObsPanel";
import { SelfPreview, useHiddenFor, usePageActive } from "./SelfPreview";
import { load, save } from "./storage";

const NAME_STORE = "displayName";
const PRESET_STORE = "sharePreset";
const LAYOUT_STORE = "layout";
const CUSTOM_STORE = "customShare";

type Quality = "auto" | Rid;
type LayoutMode = "focus" | "split";

const QUALITIES: { id: Quality; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "f", label: "High" },
  { id: "h", label: "Medium" },
  { id: "q", label: "Low" },
];

const THUMB_LAYER: Layer = { rid: "q", fixed: false };
// After the tab has been hidden this long, stop pulling video and keep only audio.
const HIDDEN_VIDEO_OFF_MS = 15_000;

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
  const [preset, setPreset] = useState<PresetId | "custom">(() => {
    const p = load<string>(PRESET_STORE, "1080p60");
    return p === "custom" || p in PRESETS ? (p as PresetId | "custom") : "1080p60";
  });
  const [custom, setCustom] = useState<ShareSettings>(() => load(CUSTOM_STORE, { height: 1080, fps: 120 }));
  const settings = preset === "custom" ? custom : PRESETS[preset];
  // What the browser actually delivers, which can be lower than requested.
  const [captured, setCaptured] = useState("");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [starting, setStarting] = useState(false);
  const publisher = useMemo(() => new Publisher(conn, () => setLocalStream(null)), [conn]);

  // Receiving
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [quality, setQuality] = useState<Quality>("auto");
  const [showObs, setShowObs] = useState(false);
  const [obsKey, setObsKey] = useState(() => loadObsKey(props.roomId));
  const [myObsKeyId, setMyObsKeyId] = useState("");
  const [obsPreview, setObsPreview] = useState(false);
  const { active: pageActive } = usePageActive();
  const tabHidden = useHiddenFor(HIDDEN_VIDEO_OFF_MS);

  useEffect(() => {
    let current = true;
    if (obsKey) obsKeyId(obsKey).then((id) => current && setMyObsKeyId(id));
    else setMyObsKeyId("");
    return () => {
      current = false;
    };
  }, [obsKey]);
  const [layout, setLayout] = useState<LayoutMode>(() => (load<string>(LAYOUT_STORE, "focus") === "split" ? "split" : "focus"));

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
  // Your own streams (browser share and OBS) stay in a small corner preview: showing them full
  // size recaptures your screen in a feedback loop, and pulling your own OBS stream costs bandwidth.
  // OBS streams match by token fingerprint, or by name when this browser no longer has the
  // token (incognito, cleared storage, another device): "<your name> (OBS)".
  const isMine = (m: Member) =>
    m.id === you ||
    (!!m.obs && ((!!myObsKeyId && m.obsKeyId === myObsKeyId) || m.name === `${props.name} (OBS)`));
  const watching = streaming.filter((m) => !isMine(m));
  const myObs = streaming.find((m) => m.obs && isMine(m)) ?? null;
  const focused = watching.find((m) => m.id === focusId) ?? watching[0] ?? null;
  const split = layout === "split" && watching.length > 1;
  const remoteCount = watching.length;
  const me = members.find((m) => m.id === you);

  // Big tiles get the chosen quality; Auto prefers the top layer but lets the SFU step down.
  // In split view with 3+ streams each tile is small, so Auto starts at the medium layer.
  const bigLayer: Layer =
    quality === "auto" ? { rid: split && remoteCount > 2 ? "h" : "f", fixed: false } : { rid: quality, fixed: true };

  useEffect(() => {
    if (!subscriber) return;
    const want = new Map<Stream, Layer | null>();
    for (const m of watching) {
      if (!m.stream) continue;
      // Hidden tab: keep the audio, drop the video so an idle tab doesn't burn bandwidth.
      want.set(m.stream, tabHidden ? null : split || m.id === focused?.id ? bigLayer : THUMB_LAYER);
    }
    if (myObs?.stream && obsPreview && pageActive) want.set(myObs.stream, THUMB_LAYER);
    subscriber.sync(want);
  }, [subscriber, streamingKey(streaming), myObsKeyId, focused?.id, split, bigLayer.rid, bigLayer.fixed, tabHidden, obsPreview, pageActive]);

  async function startShare() {
    setError("");
    setStarting(true);
    try {
      const media = await publisher.start(settings);
      const s = media.getVideoTracks()[0]?.getSettings() ?? {};
      setCaptured(s.width && s.height ? `${s.width}×${s.height} @ ${Math.round(s.frameRate ?? settings.fps)}fps` : "");
      setLocalStream(media);
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

  function updateCustom(next: ShareSettings) {
    setCustom(next);
    save(CUSTOM_STORE, next);
  }

  function changeLayout(next: LayoutMode) {
    setLayout(next);
    save(LAYOUT_STORE, next);
  }

  const streamFor = (m: Member) => (m.id === you ? localStream : (m.stream && remoteStreams.get(m.stream.sessionId)) ?? null);
  const tile = (m: Member, kind: "big" | "thumb") => (
    <VideoTile key={m.id} member={m} stream={streamFor(m)} isYou={m.id === you} big={kind === "big"} />
  );

  if (status.kind === "closed") {
    return (
      <main className="page">
        <h1>{props.roomId}</h1>
        <p className="error">{status.reason}</p>
      </main>
    );
  }

  return (
    <main className="room">
      <header className="topbar">
        <div className="row">
          <strong className="room-name">{props.roomId}</strong>
          <StatusBadge status={status} />
          <ul className="people">
            {members.map((m) => (
              <li key={m.id} className={m.stream ? "live" : ""} title={m.stream ? "Sharing" : undefined}>
                {m.name}
                {m.id === you && <span className="muted"> (you)</span>}
              </li>
            ))}
          </ul>
          <button type="button" className="link small" onClick={props.onRename}>Rename</button>
        </div>

        <div className="row">
          {remoteCount > 0 && (
            <div className="segmented" title="Quality of the streams you're watching">
              {QUALITIES.map((q) => (
                <button key={q.id} type="button" className={quality === q.id ? "active" : ""} onClick={() => setQuality(q.id)}>
                  {q.label}
                </button>
              ))}
            </div>
          )}
          {watching.length > 1 && (
            <div className="segmented">
              <button type="button" className={layout === "focus" ? "active" : ""} onClick={() => changeLayout("focus")}>
                Focus
              </button>
              <button type="button" className={layout === "split" ? "active" : ""} onClick={() => changeLayout("split")}>
                Split
              </button>
            </div>
          )}
          {localStream ? (
            <button type="button" className="danger" onClick={stopShare}>
              Stop sharing ({captured || settingsLabel(settings)})
            </button>
          ) : (
            <>
              <select
                value={preset}
                onChange={(e) => {
                  setPreset(e.target.value as PresetId | "custom");
                  save(PRESET_STORE, e.target.value);
                }}
              >
                {Object.entries(PRESETS).map(([id, p]) => (
                  <option key={id} value={id}>{p.height ? settingsLabel(p) : "Source (no cap)"}</option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {preset === "custom" && (
                <>
                  <select
                    aria-label="Resolution"
                    value={custom.height}
                    onChange={(e) => updateCustom({ ...custom, height: Number(e.target.value) })}
                  >
                    {HEIGHT_CHOICES.map((h) => (
                      <option key={h} value={h}>{heightLabel(h)}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Frame rate"
                    value={custom.fps}
                    onChange={(e) => updateCustom({ ...custom, fps: Number(e.target.value) })}
                  >
                    {FPS_CHOICES.map((f) => (
                      <option key={f} value={f}>{f}fps</option>
                    ))}
                  </select>
                </>
              )}
              <button type="button" disabled={status.kind !== "connected" || starting} onClick={startShare}>
                {starting ? "Starting…" : "Share screen"}
              </button>
            </>
          )}
          <button type="button" className={showObs ? "chip active" : "chip"} onClick={() => setShowObs((s) => !s)}>
            Stream from OBS
          </button>
        </div>
      </header>

      {showObs && (
        <ObsPanel
          conn={conn}
          roomId={props.roomId}
          connected={status.kind === "connected"}
          obsKey={obsKey}
          onKey={setObsKey}
          onClose={() => setShowObs(false)}
        />
      )}

      {(error || viewError) && <p className="error banner">{error || viewError}</p>}

      {((localStream && me) || myObs) && (
        <SelfPreview title={localStream && myObs ? "You're live (browser + OBS)" : myObs ? "You're live from OBS" : "You're sharing"}>
          {localStream && me && (
            <VideoTile member={me} stream={localStream} isYou paused={!pageActive} />
          )}
          {myObs &&
            (obsPreview ? (
              <VideoTile member={myObs} stream={streamFor(myObs)} isYou paused={!pageActive} />
            ) : (
              <div className="obs-live-card small">
                <span className="muted">Your OBS stream is live. Previewing it pulls it back down, which uses bandwidth.</span>
                <button type="button" className="chip" onClick={() => setObsPreview(true)}>Show preview</button>
              </div>
            ))}
          {myObs && obsPreview && (
            <button type="button" className="link small" onClick={() => setObsPreview(false)}>Hide OBS preview</button>
          )}
        </SelfPreview>
      )}

      {watching.length === 0 ? (
        <div className="stage empty muted">
          {localStream ? "You're sharing. Nobody else is sharing yet." : "Nobody is sharing yet. Click Share screen to start."}
        </div>
      ) : split ? (
        <div className="stage split" style={splitGrid(watching.length)}>
          {watching.map((m) => tile(m, "big"))}
        </div>
      ) : (
        <div className={watching.length > 1 ? "stage focus with-thumbs" : "stage focus"}>
          {focused && tile(focused, "big")}
          {watching.length > 1 && (
            <div className="thumbs">
              {watching
                .filter((m) => m.id !== focused?.id)
                .map((m) => (
                  <button key={m.id} type="button" className="thumb" onClick={() => setFocusId(m.id)} title="Watch this stream">
                    {tile(m, "thumb")}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

// Near-square grid: 2 → 2×1, 3–4 → 2×2, 5–6 → 3×2, …
function splitGrid(n: number): React.CSSProperties {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` };
}

// Stable dependency for the pull effect: changes only when the set of live streams does.
function streamingKey(members: Member[]): string {
  return members.map((m) => `${m.id}:${m.stream?.sessionId}:${m.stream?.tracks.join(",")}`).join("|");
}

function VideoTile(props: { member: Member; stream: MediaStream | null; isYou: boolean; big?: boolean; paused?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(true);

  // Detaching the stream while paused stops the element from compositing frames; the
  // track itself keeps feeding the encoder, so viewers are unaffected.
  const shown = props.paused ? null : props.stream;
  const stats = useVideoStats(ref, shown);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== shown) ref.current.srcObject = shown;
  }, [shown]);

  const hasAudio = !props.isYou && !!props.stream?.getAudioTracks().length;

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else boxRef.current?.requestFullscreen().catch(() => {});
  }

  return (
    <div ref={boxRef} className={props.big ? "tile big" : "tile"} onDoubleClick={props.big ? toggleFullscreen : undefined}>
      <video ref={ref} autoPlay playsInline muted={props.isYou || muted} />
      {props.paused ? (
        <div className="tile-empty small">Preview paused while this window isn't focused</div>
      ) : (
        !props.stream && <div className="tile-empty">Connecting…</div>
      )}
      <div className="tile-label">
        {props.member.name}
        {props.isYou && " (you)"}
        {stats && <span className="muted"> · {stats}</span>}
      </div>
      {props.big && (
        <div className="tile-actions">
          {hasAudio && (
            <button type="button" onClick={() => setMuted((m) => !m)}>{muted ? "Unmute" : "Mute"}</button>
          )}
          <button type="button" onClick={toggleFullscreen} title="Fullscreen (or double-click)">⛶</button>
        </div>
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
