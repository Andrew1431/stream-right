import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { CLIP_MAX_SECONDS, CLIP_MIN_SECONDS, MAX_NAME_LENGTH, RIDS, type Member, type Rid, type Stream } from "../shared/protocol";
import { Clipper, clipsSupported } from "./clips/clipper";
import { ClipsNotice, clipsBadgeHint, ClipsPanel, playShutter, Toasts, useClipStats, type Toast } from "./ClipsPanel";
import { RoomConnection, type RoomStatus } from "./connection";
import { QualityPicker, useShareQuality } from "../ui/QualityPicker";
import { SidebarGlyph } from "../ui/SidebarGlyph";
import { gb } from "../ui/usage";
import { askShell, inDesktop, useShell, useWhipHandoff } from "./desktop";
import { Publisher, settingsLabel, Subscriber, type Layer } from "./media";
import { ensureObsKey, forgetObsKey, loadObsKey, ObsPanel, obsKeyId } from "./ObsPanel";
import { SelfPreview, useHiddenFor, usePageActive } from "./SelfPreview";
import { rememberRoom } from "./recent";
import { load, save } from "./storage";
import { UsagePanel, useUsage } from "./UsagePanel";

const NAME_STORE = "displayName";
const LAYOUT_STORE = "layout";
const CLIP_BUFFER_STORE = "clipBuffer";
const CLIP_SECONDS_STORE = "clipSeconds";
const NO_CLIPS_STORE = "noClips";
const CLIP_MUTED_STORE = "clipMuted";
const CLIPS_SEEN_STORE = "clipsNoticeSeen";
const VOLUME_STORE = "streamVolumes";
const TOAST_MS = 6_000;
const CLIP_DONE_MS = 4_000;
const CLIP_FAILED_MS = 3_500;

type Quality = "auto" | Rid;
type LayoutMode = "focus" | "split";

const QUALITIES: { id: Quality; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Fits the tile and your connection" },
  { id: "f", label: "High", hint: "Full resolution" },
  { id: "h", label: "Medium", hint: "Smaller copy" },
  { id: "q", label: "Low", hint: "Smallest copy" },
];

const THUMB_LAYER: Layer = { rid: "q", fixed: false };
// After the tab has been hidden this long, stop pulling video and keep only audio.
const HIDDEN_VIDEO_OFF_MS = 15_000;
const DEFAULT_SCALES = [1, 0.5, 0.25];
const LAYER_SETTLE_MS = 4_000;
// Tile sizes are rounded to this many device pixels so small resizes don't switch layers.
const TILE_SIZE_STEP = 40;

type Size = { w: number; h: number };

// Smallest layer whose height reaches ~85% of what the tile shows; slight upscaling is
// invisible. Null until we know both the tile size and the source resolution.
function autoLayerIndex(stream: Stream, tile: Size | undefined, source: { height: number; aspect: number } | undefined) {
  const sourceHeight = stream.height ?? source?.height;
  if (!tile || !sourceHeight) return null;
  const aspect = source?.aspect ?? 16 / 9;
  const shown = Math.min(tile.h, tile.w / aspect);
  const scales = stream.scales ?? DEFAULT_SCALES;
  for (let i = scales.length - 1; i > 0; i--) if (sourceHeight * scales[i] >= shown * 0.85) return i;
  return 0;
}

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
        <a className="link" href="/">Back to your rooms</a>
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
  const { conn, status, members, you, epoch, clipsAllowed } = useConnection(props.roomId, props.token, props.name);
  useEffect(() => {
    if (status.kind === "connected") rememberRoom(props.roomId, props.token);
  }, [status.kind, props.roomId, props.token]);
  const [error, setError] = useState("");
  const [viewError, setViewError] = useState("");

  // Publishing
  const quality = useShareQuality();
  const { settings } = quality;
  // What the browser actually delivers, which can be lower than requested.
  const [captured, setCaptured] = useState("");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [starting, setStarting] = useState(false);
  const publisher = useMemo(() => new Publisher(conn, () => setLocalStream(null)), [conn]);

  // Receiving
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const closeUsage = useCallback(() => setShowUsage(false), []);
  const shell = useShell();
  const storedKey = useMemo(() => load("creatorKey", ""), []);
  // Inside the desktop app, the app holds the creator key for each server.
  const creatorKey = inDesktop ? (shell?.creatorKey ?? "") : storedKey;
  // Only for whoever saved the creator key on this browser, and only if the server has an API token.
  const usage = useUsage(creatorKey);
  const [focusId, setFocusId] = useState<string | null>(null);
  // Quality is chosen per stream, from the menu on that stream's tile.
  const [qualities, setQualities] = useState<Record<string, Quality>>({});
  // Keyed by name so a streamer's volume survives reconnects and visits. Unmuting isn't
  // remembered: a reload would then try to autoplay with sound, which browsers block.
  const [volumes, setVolumes] = useState<Record<string, number>>(() => load(VOLUME_STORE, {}));
  const [unmuted, setUnmuted] = useState<Record<string, boolean>>({});
  const [showObs, setShowObs] = useState(false);
  const [obsKey, setObsKey] = useState(() => loadObsKey(props.roomId));
  const [myObsKeyId, setMyObsKeyId] = useState("");
  const [obsPreview, setObsPreview] = useState(false);
  // The corner preview is blown up to the overlay or fullscreen.
  const [previewLarge, setPreviewLarge] = useState(false);
  // Device-pixel size of each big tile, and each source's real resolution once seen.
  const [tileSizes, setTileSizes] = useState<Record<string, Size>>({});
  const [sources, setSources] = useState<Record<string, { height: number; aspect: number }>>({});
  const requested = useRef(new Map<string, { index: number; at: number }>());
  const { active: pageActive } = usePageActive();
  const tabHidden = useHiddenFor(HIDDEN_VIDEO_OFF_MS);

  // Clips
  const clipper = useMemo(() => new Clipper(), []);
  useEffect(() => () => clipper.dispose(), [clipper]);
  const ownerKey = useMemo(
    () => load<{ roomId: string; ownerKey?: string }[]>("myRooms", []).find((r) => r.roomId === props.roomId)?.ownerKey ?? "",
    [props.roomId],
  );
  const isOwner = !!ownerKey || !!creatorKey;
  const [ownerError, setOwnerError] = useState("");
  const [clipBuffer, setClipBuffer] = useState(() => load<unknown>(CLIP_BUFFER_STORE, false) === true);
  const [clipSeconds, setClipSeconds] = useState(() => {
    const s = Number(load(CLIP_SECONDS_STORE, 60));
    return Number.isFinite(s) ? Math.min(CLIP_MAX_SECONDS, Math.max(CLIP_MIN_SECONDS, s)) : 60;
  });
  const [noClips, setNoClips] = useState(() => load<unknown>(NO_CLIPS_STORE, false) === true);
  const [clipMuted, setClipMuted] = useState(() => load<unknown>(CLIP_MUTED_STORE, false) === true);
  const [showClips, setShowClips] = useState(false);
  const closeClips = useCallback(() => setShowClips(false), []);
  const [clipNotice, setClipNotice] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [clipStatus, setClipStatus] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "done"; count: number } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const [showMenu, setShowMenu] = useState(false);
  const closeMenu = useCallback(() => setShowMenu(false), []);
  const buffering = clipsAllowed && clipBuffer && clipsSupported;
  const clipStats = useClipStats(clipper, buffering && showClips);
  const seenAllowed = useRef<boolean | null>(null);
  const iToggled = useRef(false);

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
      clipper,
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
  // Keep the OBS stream under your current name, even if its token came from another browser.
  useEffect(() => {
    if (status.kind === "connected" && obsKey) conn.request({ op: "claimObs", obsKey }).catch(() => {});
  }, [conn, status.kind, epoch, obsKey]);

  useWhipHandoff(async () => {
    if (status.kind !== "connected") throw new Error("Not connected to the room yet");
    const key = await ensureObsKey(conn, props.roomId, noClips);
    if (key !== obsKey) setObsKey(key);
    return key;
  }, `${location.origin}/api/rooms/${props.roomId}/whip`);

  const isMine = (m: Member) =>
    m.id === you ||
    (!!m.obs && ((!!myObsKeyId && m.obsKeyId === myObsKeyId) || m.name === `${props.name} (OBS)`));
  const watching = streaming.filter((m) => !isMine(m));
  const myObs = streaming.find((m) => m.obs && isMine(m)) ?? null;
  const clippable = watching.filter((m) => m.stream && !m.stream.noClips);
  const focused = watching.find((m) => m.id === focusId) ?? watching[0] ?? null;
  const split = layout === "split" && watching.length > 1;
  const remoteCount = watching.length;
  const me = members.find((m) => m.id === you);
  // The desktop app streams into the room over WHIP, so its stream shows up as your OBS member.
  const appLive = inDesktop && !!shell?.live;

  // Big tiles get the chosen quality. Auto picks the smallest layer that still fills the tile,
  // and lets the SFU step down further when bandwidth is short.
  const layerFor = (m: Member): Layer => {
    const quality = qualities[m.id] ?? "auto";
    if (quality !== "auto" || !m.stream) return { rid: quality === "auto" ? "f" : quality, fixed: quality !== "auto" };
    const fallback = split && remoteCount > 2 ? 1 : 0;
    const index = autoLayerIndex(m.stream, tileSizes[m.id], sources[m.stream.sessionId]) ?? fallback;
    return { rid: RIDS[Math.min(index, RIDS.length - 1)], fixed: false };
  };
  const bigLayers = new Map(watching.map((m) => [m.id, layerFor(m)]));
  // Your own OBS/app stream: the thumbnail layer in the corner; enlarged, the layer that fits it,
  // picked like Auto on a big tile, so you see what viewers at that size see.
  const obsIndex = myObs?.stream && previewLarge
    ? (autoLayerIndex(myObs.stream, tileSizes[myObs.id], sources[myObs.stream.sessionId]) ?? 0)
    : null;
  const obsLayer: Layer = obsIndex === null ? THUMB_LAYER : { rid: RIDS[Math.min(obsIndex, RIDS.length - 1)], fixed: false };
  const layersKey = [...bigLayers].map(([id, l]) => `${id}:${l.rid}:${l.fixed}`).join("|");

  // Learn each source's real resolution from what arrives, given the layer we asked for.
  // Skip readings right after a layer change: the old layer can still be on screen.
  function onRemoteVideo(m: Member, width: number, height: number) {
    const stream = m.stream;
    if (!stream || !width || !height) return;
    const req = requested.current.get(stream.sessionId);
    if (!req || performance.now() - req.at < LAYER_SETTLE_MS) return;
    const scales = stream.scales ?? DEFAULT_SCALES;
    const sourceHeight = Math.round(height / scales[Math.min(req.index, scales.length - 1)]);
    const aspect = width / height;
    setSources((prev) => {
      const old = prev[stream.sessionId];
      if (old && old.height >= sourceHeight && Math.abs(old.aspect - aspect) < 0.02) return prev;
      return { ...prev, [stream.sessionId]: { height: Math.max(old?.height ?? 0, sourceHeight), aspect } };
    });
  }

  function onTileSize(id: string, w: number, h: number) {
    setTileSizes((prev) => (prev[id]?.w === w && prev[id]?.h === h ? prev : { ...prev, [id]: { w, h } }));
  }

  // Which streams this browser keeps a clip buffer of: everything it watches, minus opt-outs.
  // Before the pull effect: starting to buffer rebuilds the connection, best done before pulling.
  const clipKeys = buffering ? watching.flatMap((m) => (m.stream && !m.stream.noClips ? [m.stream.sessionId] : [])) : [];
  useEffect(() => {
    clipper.configure(new Set(clipKeys), clipSeconds);
    subscriber?.updateClips();
  }, [clipper, subscriber, clipKeys.join("|"), clipSeconds]);

  useEffect(() => {
    if (!subscriber) return;
    const want = new Map<Stream, Layer | null>();
    for (const m of watching) {
      if (!m.stream) continue;
      // Hidden tab: keep the audio, drop the video so an idle tab doesn't burn bandwidth.
      const layer = tabHidden ? null : split || m.id === focused?.id ? bigLayers.get(m.id)! : THUMB_LAYER;
      want.set(m.stream, layer);
      if (layer) {
        const index = RIDS.indexOf(layer.rid);
        const prev = requested.current.get(m.stream.sessionId);
        if (prev?.index !== index) requested.current.set(m.stream.sessionId, { index, at: performance.now() });
      }
    }
    if (myObs?.stream && obsPreview && pageActive) {
      want.set(myObs.stream, obsLayer);
      const index = RIDS.indexOf(obsLayer.rid);
      const prev = requested.current.get(myObs.stream.sessionId);
      if (prev?.index !== index) requested.current.set(myObs.stream.sessionId, { index, at: performance.now() });
    }
    subscriber.sync(want);
  }, [subscriber, streamingKey(streaming), myObsKeyId, focused?.id, split, layersKey, tabHidden, obsPreview, pageActive, obsLayer.rid]);

  // Everyone sees who keeps a buffer. Re-sent on every (re)join: presence is per connection.
  useEffect(() => {
    if (status.kind === "connected") conn.request({ op: "buffering", on: buffering }).catch(() => {});
  }, [conn, epoch, status.kind === "connected", buffering]);

  // The notice: the first time this browser sees clips on in this room, or when they're switched on.
  useEffect(() => {
    if (status.kind !== "connected") return;
    const prev = seenAllowed.current;
    seenAllowed.current = clipsAllowed;
    const seen = load<string[]>(CLIPS_SEEN_STORE, []);
    if (!clipsAllowed) {
      setClipNotice(false);
      if (seen.includes(props.roomId)) save(CLIPS_SEEN_STORE, seen.filter((r) => r !== props.roomId));
    } else if (iToggled.current) {
      if (!seen.includes(props.roomId)) save(CLIPS_SEEN_STORE, [...seen, props.roomId]);
    } else if (prev === false || !seen.includes(props.roomId)) {
      setClipNotice(true);
    }
    iToggled.current = false;
  }, [clipsAllowed, status.kind === "connected"]);

  function dismissNotice() {
    setClipNotice(false);
    const seen = load<string[]>(CLIPS_SEEN_STORE, []);
    if (!seen.includes(props.roomId)) save(CLIPS_SEEN_STORE, [...seen, props.roomId]);
  }

  // Every saved clip is announced to the whole room, with a shutter sound unless muted here.
  const mutedRef = useRef(clipMuted);
  mutedRef.current = clipMuted;
  useEffect(
    () =>
      conn.onClip((e) => {
        const who = e.by === conn.snapshot.you ? "You" : e.name;
        const toast = { id: Math.random(), text: `${who} clipped the last ${e.seconds}s (${e.of.join(", ")})` };
        setToasts((t) => [...t, toast]);
        setTimeout(() => setToasts((t) => t.filter((x) => x !== toast)), TOAST_MS);
        if (!mutedRef.current) playShutter();
      }),
    [conn],
  );

  async function allowClips(allowed: boolean) {
    setOwnerError("");
    iToggled.current = true;
    try {
      await conn.request({ op: "allowClips", allowed, ownerKey: ownerKey || undefined, creatorKey: creatorKey || undefined });
    } catch (e) {
      iToggled.current = false;
      setOwnerError((e as Error).message);
    }
  }

  async function revokeAllObs() {
    if (!confirm("Revoke every OBS token in this room? All OBS streams here leave the room, and everyone needs a new token to stream from OBS.")) return;
    try {
      await conn.request({ op: "revokeObs", ownerKey: ownerKey || undefined, creatorKey: creatorKey || undefined });
      forgetObsKey(props.roomId);
      setObsKey("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function changeNoClips(v: boolean) {
    setNoClips(v);
    save(NO_CLIPS_STORE, v);
    if (status.kind === "connected") conn.request({ op: "clipPrefs", noClips: v, obsKey: obsKey || undefined }).catch(() => {});
  }

  async function saveClip() {
    setError("");
    setClipStatus({ kind: "saving" });
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, "-");
    try {
      const stats = await clipper.stats();
      const targets = watching.filter((m) => {
        const s = m.stream && !m.stream.noClips ? stats[m.stream.sessionId] : undefined;
        return !!s && !s.unsupported && s.seconds >= 1;
      });
      if (!targets.length) throw new Error("Nothing to clip yet. The buffer fills as you watch.");
      const longest = Math.max(...targets.map((m) => stats[m.stream!.sessionId].seconds));
      // Announce first: if the room won't announce it, no file is made.
      await conn.request({ op: "clip", seconds: Math.min(clipSeconds, Math.round(longest)), of: targets.map((m) => m.id) });
      const files = await clipper.save(targets.map((m) => m.stream!.sessionId), clipSeconds);
      let count = 0;
      for (const f of files) {
        const m = targets.find((t) => t.stream!.sessionId === f.key);
        if (!f.data || !m) continue;
        download(new Blob([f.data], { type: "video/mp4" }), `${fileSafe(m.name)}-${fileSafe(props.roomId)}-${time}.mp4`);
        count++;
      }
      if (!count) throw new Error("Couldn't save the clip");
      setClipStatus({ kind: "done", count });
      setTimeout(() => setClipStatus({ kind: "idle" }), CLIP_DONE_MS);
    } catch (e) {
      // Shown on the button itself and cleared after a moment, not in the sticky error banner.
      setClipStatus({ kind: "failed", message: (e as Error).message });
      setTimeout(() => setClipStatus({ kind: "idle" }), CLIP_FAILED_MS);
    }
  }

  async function startShare() {
    setError("");
    setStarting(true);
    try {
      const media = await publisher.start(settings, noClips);
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


  function changeLayout(next: LayoutMode) {
    setLayout(next);
    save(LAYOUT_STORE, next);
  }

  const streamFor = (m: Member) => (m.id === you ? localStream : (m.stream && remoteStreams.get(m.stream.sessionId)) ?? null);
  const tile = (m: Member, kind: "big" | "thumb") => (
    <VideoTile
      key={m.id}
      member={m}
      stream={streamFor(m)}
      isYou={m.id === you}
      big={kind === "big"}
      onSize={kind === "big" ? (w, h) => onTileSize(m.id, w, h) : undefined}
      onVideoSize={(w, h) => onRemoteVideo(m, w, h)}
      quality={kind === "big" && m.id !== you ? (qualities[m.id] ?? "auto") : undefined}
      clipsOff={clipsAllowed && !!m.stream?.noClips}
      onQuality={(q) => setQualities((prev) => ({ ...prev, [m.id]: q }))}
      volume={volumes[m.name] ?? 1}
      muted={!unmuted[m.name]}
      onVolume={(v) => {
        const next = { ...volumes, [m.name]: v };
        setVolumes(next);
        save(VOLUME_STORE, next);
        setUnmuted((prev) => ({ ...prev, [m.name]: v > 0 }));
      }}
      onMuted={(muted) => setUnmuted((prev) => ({ ...prev, [m.name]: !muted }))}
    />
  );

  if (status.kind === "closed") {
    return (
      <main className="page">
        <h1>{props.roomId}</h1>
        <p className="error">{status.reason}</p>
        <a className="link" href="/">Back to your rooms</a>
      </main>
    );
  }

  return (
    <main className="room">
      <header className="topbar">
        <div className="row">
          {inDesktop && (
            <button
              type="button"
              className="sidebar-key"
              title={shell?.sidebarHidden ? "Show servers and rooms (Ctrl+B)" : "Hide servers and rooms (Ctrl+B)"}
              aria-label={shell?.sidebarHidden ? "Show servers and rooms" : "Hide servers and rooms"}
              aria-pressed={!shell?.sidebarHidden}
              onClick={() => askShell("toggle-sidebar")}
            >
              <SidebarGlyph open={!shell?.sidebarHidden} />
              {shell?.sidebarHidden && shell.liveElsewhere && <span className="live-elsewhere" aria-label="Someone is live in another room" />}
            </button>
          )}
          <div className="masthead">
            {inDesktop ? <span className="home-link">stream</span> : <a className="home-link" href="/" title="All rooms">stream</a>}
            <StatusBadge status={status} />
          </div>
          <strong className="room-name">
            {inDesktop && <span className="room-hash">#</span>}
            {props.roomId}
          </strong>
          {clipsAllowed && (
            <button
              type="button"
              className={showClips ? "clips-badge active" : "clips-badge"}
              title={clipsBadgeHint}
              onClick={() => setShowClips((s) => !s)}
            >
              Clips on
            </button>
          )}
          <Participants members={members} you={you} />
        </div>

        <div className="controls">
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
          ) : inDesktop && shell?.live ? (
            <button type="button" className="danger" onClick={() => askShell("stop-live")}>
              Stop streaming
            </button>
          ) : inDesktop ? (
            // The app's native Go live replaces the browser picker; it's still in the ⋮ menu.
            !myObs && (
              <button type="button" className="go-live" disabled={status.kind !== "connected"} onClick={() => askShell("go-live")}>
                <span className="rec-led" aria-hidden="true" />
                Go live
              </button>
            )
          ) : (
            // Live from OBS already: browser sharing would be a second copy of the same screen.
            !myObs && (
              <div className="share-group">
                <QualityPicker quality={quality} />
                <button type="button" disabled={status.kind !== "connected" || starting} onClick={startShare}>
                  {starting ? "Starting…" : "Share screen"}
                </button>
              </div>
            )
          )}

          {buffering && (
            <button
              type="button"
              className={`clip-key ${clipStatus.kind}`}
              disabled={clipStatus.kind === "saving" || !clippable.length}
              title={
                clipStatus.kind === "failed"
                  ? clipStatus.message
                  : clippable.length
                    ? `Saves the last ${clipSeconds}s of each stream you're watching, on this device. Everyone in the room is told.`
                    : "Nobody else is streaming yet. Clips are of other people's streams."
              }
              onClick={saveClip}
            >
              <span className="rec-led" aria-hidden="true" />
              {clipStatus.kind === "saving"
                ? "Saving…"
                : clipStatus.kind === "done"
                  ? `Saved ${clipStatus.count}`
                  : clipStatus.kind === "failed"
                    ? "Nothing yet"
                    : `Clip ${clipSeconds}s`}
            </button>
          )}

          {usage && (
            <button
              type="button"
              className={showUsage ? "meter-key active" : "meter-key"}
              title={`${gb(usage.egressBytes)} of ${gb(usage.freeBytes)} free GB used this month`}
              onClick={() => setShowUsage((s) => !s)}
            >
              {gb(usage.egressBytes)} GB
              <span className="meter-track" aria-hidden="true">
                <span style={{ width: `${(1 - Math.min(usage.egressBytes / usage.freeBytes, 1)) * 100}%` }} />
              </span>
            </button>
          )}

          {!inDesktop && (
            <button
              type="button"
              className={`obs-key${showObs ? " active" : ""}${myObs ? " live" : ""}`}
              title={myObs ? "You're live from OBS. Stream settings" : "Stream from OBS"}
              aria-label="Stream from OBS"
              onClick={() => setShowObs((s) => !s)}
            >
              <ObsGlyph />
            </button>
          )}

          <div className="menu-wrap">
            <button
              type="button"
              className={showMenu ? "more-key active" : "more-key"}
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              onClick={() => setShowMenu((s) => !s)}
            >
              <svg viewBox="0 0 4 16" width="4" height="16" aria-hidden="true">
                <circle cx="2" cy="2" r="1.6" fill="currentColor" />
                <circle cx="2" cy="8" r="1.6" fill="currentColor" />
                <circle cx="2" cy="14" r="1.6" fill="currentColor" />
              </svg>
            </button>
            {showMenu && (
              <RoomMenu
                onClose={closeMenu}
                items={[
                  ...(clipsAllowed || isOwner
                    ? [{
                        label: "Clips",
                        hint: !clipsAllowed ? "Off in this room" : buffering ? `Keeping the last ${clipSeconds}s` : "On in this room",
                        onSelect: () => setShowClips(true),
                      }]
                    : []),
                  ...(usage
                    ? [{
                        label: "Streaming usage",
                        hint: `${gb(usage.egressBytes)} of ${gb(usage.freeBytes)} GB this month`,
                        onSelect: () => setShowUsage(true),
                      }]
                    : []),
                  { label: "Stream from OBS", hint: myObs && !appLive ? "You're live" : "Server and token", onSelect: () => setShowObs(true) },
                  ...(inDesktop && !localStream && !myObs
                    ? [{ label: "Share with the browser picker", hint: settingsLabel(settings), onSelect: startShare }]
                    : []),
                  { label: "Change your name", hint: me?.name ?? props.name, onSelect: props.onRename },
                  ...(isOwner
                    ? [{ label: "Revoke all OBS tokens", hint: "Ends every OBS stream in this room", onSelect: revokeAllObs }]
                    : []),
                  ...(inDesktop
                    ? [
                        { label: "Leave room", hint: "Stays in your list", onSelect: () => askShell("leave") },
                        { label: "Forget room", hint: "Removes it from the app", onSelect: () => askShell("forget") },
                      ]
                    : []),
                ]}
              />
            )}
          </div>
        </div>
      </header>

      {showUsage && usage && <UsagePanel usage={usage} subscriber={subscriber} onClose={closeUsage} />}

      {showClips && (clipsAllowed || isOwner) && (
        <ClipsPanel
          isOwner={isOwner}
          allowed={clipsAllowed}
          onAllow={allowClips}
          ownerError={ownerError}
          supported={clipsSupported}
          buffering={buffering}
          onBuffering={(on) => {
            setClipBuffer(on);
            save(CLIP_BUFFER_STORE, on);
          }}
          seconds={clipSeconds}
          onSeconds={(s) => {
            setClipSeconds(s);
            save(CLIP_SECONDS_STORE, s);
          }}
          streams={watching.map((m) => ({ member: m, key: m.stream && !m.stream.noClips ? m.stream.sessionId : null }))}
          stats={clipStats}
          noClips={noClips}
          onNoClips={changeNoClips}
          muted={clipMuted}
          onMuted={(v) => {
            setClipMuted(v);
            save(CLIP_MUTED_STORE, v);
          }}
          onClose={closeClips}
        />
      )}

      {clipNotice && clipsAllowed && <ClipsNotice noClips={noClips} onNoClips={changeNoClips} onDone={dismissNotice} />}
      <Toasts toasts={toasts} />

      {showObs && (
        <ObsPanel
          conn={conn}
          roomId={props.roomId}
          connected={status.kind === "connected"}
          obsKey={obsKey}
          noClips={noClips}
          onKey={setObsKey}
          onClose={() => setShowObs(false)}
        />
      )}

      {(error || viewError) && (
        <p className="error banner">
          <span>{error || viewError}</span>
          <button type="button" className="banner-close" aria-label="Dismiss" onClick={() => { setError(""); setViewError(""); }}>×</button>
        </p>
      )}

      {((localStream && me) || myObs) && (
        <SelfPreview
          title={
            localStream && myObs
              ? `You're live (browser + ${appLive ? "app" : "OBS"})`
              : myObs
                ? appLive ? "You're live from the app" : "You're live from OBS"
                : "You're sharing"
          }
          onLargeChange={setPreviewLarge}
        >
          {localStream && me && (
            <VideoTile member={me} stream={localStream} isYou paused={!pageActive} />
          )}
          {myObs &&
            (obsPreview ? (
              <VideoTile
                member={myObs}
                label={appLive ? (me?.name ?? props.name) : undefined}
                stream={streamFor(myObs)}
                isYou
                paused={!pageActive}
                onSize={(w, h) => onTileSize(myObs.id, w, h)}
                onVideoSize={(w, h) => onRemoteVideo(myObs, w, h)}
              />
            ) : (
              <div className="obs-live-card small">
                <span className="muted">
                  {appLive ? "You're streaming from the app." : "Your OBS stream is live."} Previewing it pulls it back down, which uses bandwidth.
                </span>
                <button type="button" className="chip" onClick={() => setObsPreview(true)}>Show preview</button>
              </div>
            ))}
          {myObs && obsPreview && (
            <button type="button" className="link small" onClick={() => setObsPreview(false)}>{appLive ? "Hide preview" : "Hide OBS preview"}</button>
          )}
        </SelfPreview>
      )}

      {watching.length === 0 ? (
        <div className="stage empty muted">
          {localStream ? "You're sharing. Nobody else is sharing yet." : `Nobody is sharing yet. Click ${inDesktop ? "Go live" : "Share screen"} to start.`}
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

function VideoTile(props: {
  member: Member;
  // Shown instead of the member's name.
  label?: string;
  stream: MediaStream | null;
  isYou: boolean;
  big?: boolean;
  paused?: boolean;
  onSize?: (w: number, h: number) => void;
  onVideoSize?: (w: number, h: number) => void;
  // Set on big remote tiles: the quality menu for this stream.
  quality?: Quality;
  onQuality?: (q: Quality) => void;
  // The room allows clips but this streamer opted out.
  clipsOff?: boolean;
  // Unset on your own preview, which is always silent.
  volume?: number;
  muted?: boolean;
  onVolume?: (v: number) => void;
  onMuted?: (muted: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const muted = props.isYou || props.muted !== false;

  // Latest callbacks without re-subscribing the observers on every render.
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !props.onSize) return;
    const ro = new ResizeObserver(([entry]) => {
      const dpr = devicePixelRatio || 1;
      const round = (v: number) => Math.round((v * dpr) / TILE_SIZE_STEP) * TILE_SIZE_STEP;
      callbacks.current.onSize?.(round(entry.contentRect.width), round(entry.contentRect.height));
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [!!props.onSize]);

  useEffect(() => {
    if (!props.stream || !props.onVideoSize) return;
    const id = setInterval(() => {
      const v = ref.current;
      if (v?.videoWidth) callbacks.current.onVideoSize?.(v.videoWidth, v.videoHeight);
    }, 2000);
    return () => clearInterval(id);
  }, [props.stream, !!props.onVideoSize]);

  // Detaching the stream while paused stops the element from compositing frames; the
  // track itself keeps feeding the encoder, so viewers are unaffected.
  const shown = props.paused ? null : props.stream;
  const stats = useVideoStats(ref, shown);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== shown) ref.current.srcObject = shown;
  }, [shown]);

  const hasAudio = !props.isYou && !!props.stream?.getAudioTracks().length;
  useEffect(() => {
    if (ref.current) ref.current.volume = props.volume ?? 1;
  }, [props.volume, shown]);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else boxRef.current?.requestFullscreen().catch(() => {});
  }

  return (
    <div ref={boxRef} className={props.big ? "tile big" : "tile"} onDoubleClick={props.big ? toggleFullscreen : undefined}>
      <video ref={ref} autoPlay playsInline muted={muted} />
      {props.paused ? (
        <div className="tile-empty small">Preview paused while this window isn't focused</div>
      ) : (
        !props.stream && <div className="tile-empty">Connecting…</div>
      )}
      <div className="tile-label">
        {props.label ?? props.member.name}
        {props.isYou && " (you)"}
        {stats && <span className="muted"> · {stats}</span>}
        {props.clipsOff && <span className="muted" title="This streamer doesn't allow clips of their stream"> · No clips</span>}
        {!props.big && hasAudio && !muted && <span className="muted" title="You're hearing this stream"> · 🔊</span>}
      </div>
      {props.big && (
        <div className="tile-actions">
          {props.quality && props.onQuality && (
            <QualityMenu
              name={props.member.name}
              value={props.quality}
              layered={(props.member.stream?.rids?.length ?? 3) > 1}
              onChange={props.onQuality}
            />
          )}
          {hasAudio && props.onVolume && props.onMuted && (
            <VolumeControl
              name={props.member.name}
              volume={props.volume ?? 1}
              muted={muted}
              onVolume={props.onVolume}
              onMuted={props.onMuted}
            />
          )}
          <button type="button" onClick={toggleFullscreen} title="Fullscreen (or double-click)">⛶</button>
        </div>
      )}
    </div>
  );
}

// Mute toggle plus a slider that slides out on hover; the level is per streamer.
function VolumeControl(props: {
  name: string;
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMuted: (muted: boolean) => void;
}) {
  const silent = props.muted || props.volume === 0;
  const level = silent ? 0 : props.volume;
  return (
    <div className="volume">
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={level}
        aria-label={`${props.name}'s volume`}
        style={{ "--level": `${level * 100}%` } as CSSProperties}
        onChange={(e) => props.onVolume(Number(e.target.value))}
      />
      <button
        type="button"
        aria-label={silent ? `Unmute ${props.name}` : `Mute ${props.name}`}
        title={silent ? "Unmute" : `Mute (${Math.round(level * 100)}%)`}
        onClick={() => (silent && props.volume === 0 ? props.onVolume(1) : props.onMuted(!silent))}
      >
        <SpeakerGlyph level={level} />
      </button>
    </div>
  );
}

function SpeakerGlyph({ level }: { level: number }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor" />
      {level === 0 ? (
        <path d="M13.5 8l4 4M17.5 8l-4 4" />
      ) : (
        <>
          <path d="M13 7.5a3.5 3.5 0 0 1 0 5" />
          {level > 0.5 && <path d="M15.5 5a7 7 0 0 1 0 10" />}
        </>
      )}
    </svg>
  );
}

// Per-stream quality picker that lives on the tile it controls.
function QualityMenu(props: { name: string; value: Quality; layered: boolean; onChange: (q: Quality) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!props.layered) {
    return (
      <span className="quality-pill fixed" title={`${props.name} sends a single quality, set in their OBS`}>
        Source
      </span>
    );
  }

  const current = QUALITIES.find((q) => q.id === props.value)!;
  return (
    <div className="quality" ref={root}>
      <button
        type="button"
        className="quality-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Quality for ${props.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        {current.label} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="quality-menu" role="menu" aria-label={`Quality for ${props.name}`}>
          <div className="quality-menu-title">Quality for {props.name}</div>
          {QUALITIES.map((q) => (
            <button
              key={q.id}
              type="button"
              role="menuitemradio"
              aria-checked={q.id === props.value}
              className={q.id === props.value ? "active" : ""}
              onClick={() => {
                props.onChange(q.id);
                setOpen(false);
              }}
            >
              <span>{q.label}</span>
              <span className="muted">{q.hint}</span>
            </button>
          ))}
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

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

const fileSafe = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "stream";

function StatusBadge({ status }: { status: RoomStatus }) {
  const label = {
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    closed: "Disconnected",
  }[status.kind];
  return <span className={`badge ${status.kind}`}>{label}</span>;
}

// A head-and-shoulders count of who's here; the names show on hover or focus.
function Participants({ members, you }: { members: Member[]; you: string | null }) {
  const people = members.filter((m) => !m.obs).length;
  return (
    <div className="participants" tabIndex={0} aria-label={`${people} ${people === 1 ? "person" : "people"} in the room`}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="8" cy="5" r="3" fill="currentColor" />
        <path d="M2 14.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" fill="currentColor" />
      </svg>
      <span className="participants-count">{people}</span>
      <div className="participants-pop" role="tooltip">
        <ul className="people">
          {members.map((m) => (
            <li key={m.id} className={m.stream ? "live" : ""}>
              <span className="person-name">{m.name}</span>
              {m.id === you && <span className="muted"> (you)</span>}
              {m.buffering && (
                <span className="buffering" role="img" title="Keeping a clip buffer of the streams they watch" aria-label="keeping a clip buffer" />
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// The OBS Studio logo, path from Simple Icons.
const OBS_LOGO = "M12,24C5.383,24,0,18.617,0,12S5.383,0,12,0s12,5.383,12,12S18.617,24,12,24z M12,1.109 C5.995,1.109,1.11,5.995,1.11,12C1.11,18.005,5.995,22.89,12,22.89S22.89,18.005,22.89,12C22.89,5.995,18.005,1.109,12,1.109z M6.182,5.99c0.352-1.698,1.503-3.229,3.05-3.996c-0.269,0.273-0.595,0.483-0.844,0.78c-1.02,1.1-1.48,2.692-1.199,4.156 c0.355,2.235,2.455,4.06,4.732,4.028c1.765,0.079,3.485-0.937,4.348-2.468c1.848,0.063,3.645,1.017,4.7,2.548 c0.54,0.799,0.962,1.736,0.991,2.711c-0.342-1.295-1.202-2.446-2.375-3.095c-1.135-0.639-2.529-0.802-3.772-0.425 c-1.56,0.448-2.849,1.723-3.293,3.293c-0.377,1.25-0.216,2.628,0.377,3.772c-0.825,1.429-2.315,2.449-3.932,2.756 c-1.244,0.261-2.551,0.059-3.709-0.464c1.036,0.302,2.161,0.355,3.191-0.011c1.381-0.457,2.522-1.567,3.024-2.935 c0.556-1.49,0.345-3.261-0.591-4.54c-0.7-1.007-1.803-1.717-3.002-1.969c-0.38-0.068-0.764-0.098-1.148-0.134 c-0.611-1.231-0.834-2.66-0.528-3.996L6.182,5.99z";

function ObsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d={OBS_LOGO} fill="currentColor" />
    </svg>
  );
}

type MenuItem = { label: string; hint?: string; onSelect: () => void };

function RoomMenu(props: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = props;

  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      // The ⋮ button toggles the menu itself.
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    addEventListener("keydown", onKey);
    addEventListener("pointerdown", onDown);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  return (
    <div className="room-menu" role="menu" ref={ref}>
      {props.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          <span>{item.label}</span>
          {item.hint && <span className="menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
