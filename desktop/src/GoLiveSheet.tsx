import { useEffect, useState } from "react";
import { QualityPicker, useShareQuality, type ShareQuality } from "../../ui/QualityPicker";
import {
  captureMonitorThumbnail,
  captureThumbnail,
  listMonitors,
  listWindows,
  type CaptureTarget,
  type MonitorTarget,
} from "./native";
import { PRESETS, type PresetId, type ShareSettings } from "../../ui/presets";
import {
  equivalentHeight,
  LAYER_COUNTS,
  listAudioApps,
  liveStatus,
  mbps,
  modifyLive,
  OPUS_UPLOAD_KBPS,
  setLiveMic,
  uploadKbps,
  type AudioApp,
  type LayerCount,
  type LiveAudio,
  type LiveChoices,
  type LiveSource,
  type LiveStatus,
  type SourceChange,
} from "./live";
import { Sheet } from "./Sheet";

const THUMB_WIDTH = 320;
// Previews refresh while the sheet is open, so a game that just went fullscreen shows up.
const REFRESH_MS = 5000;
// The picker's rows, while it's open: apps start and stop playing.
const APPS_MS = 3000;
const BITRATE_STORE = "liveBitrate";
const EXCLUDED_STORE = "liveExcludedApps";
const MIN_MBPS = 0.5;
const MAX_MBPS = 100;

function loadCustomMbps(): number | null {
  const value = Number(localStorage.getItem(BITRATE_STORE) || NaN);
  return Number.isFinite(value) && value > 0 ? value : null;
}
const LAYERS_STORE = "liveLayers";

function loadLayers(): LayerCount {
  const n = Number(localStorage.getItem(LAYERS_STORE));
  return LAYER_COUNTS.includes(n as LayerCount) ? (n as LayerCount) : 3;
}

function saveBitrate(value: number | null) {
  localStorage.setItem(BITRATE_STORE, value === null ? "" : String(value));
}

const clampMbps = (value: number) => Math.min(MAX_MBPS, Math.max(MIN_MBPS, value));

// Apps left out of "Everything except", by lowercase exe.
function loadExcluded(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(EXCLUDED_STORE) ?? "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Only on Go live or Apply, so trying the picker out and closing the sheet changes nothing.
function rememberExcluded(audio: LiveAudio) {
  if (audio.kind !== "allExceptVoice") return;
  try {
    localStorage.setItem(EXCLUDED_STORE, JSON.stringify(audio.except));
  } catch {
    // Not remembered; fine.
  }
}

type AppListMode = "except" | "only";
// A shared window's sound stays that one app's until the user edits the list (`edited`).
type SoundDraft = { on: boolean; edited: boolean; mode: AppListMode; except: string[]; only: string[] };

const newSound = (): SoundDraft => ({ on: true, edited: false, mode: "except", except: loadExcluded(), only: [] });

function soundFrom(audio: LiveAudio): SoundDraft {
  const fresh = newSound();
  switch (audio.kind) {
    case "off":
      return { ...fresh, on: false };
    case "app":
      return fresh;
    case "allExceptVoice":
      return { ...fresh, edited: true, except: audio.except };
    case "onlyApps":
      return { ...fresh, edited: true, mode: "only", only: audio.only };
  }
}

function soundToAudio(sound: SoundDraft, windowPid: number | undefined): LiveAudio {
  if (!sound.on) return { kind: "off" };
  if (windowPid !== undefined && !sound.edited) return { kind: "app", pid: windowPid };
  return sound.mode === "except" ? { kind: "allExceptVoice", except: sound.except } : { kind: "onlyApps", only: sound.only };
}

// The list the picker shows. A window nobody has edited reads as "only this window's app".
function listView(sound: SoundDraft, windowExe: string | undefined): { mode: AppListMode; list: string[] } {
  if (windowExe !== undefined && !sound.edited) return { mode: "only", list: windowExe ? [windowExe] : [] };
  return { mode: sound.mode, list: sound.mode === "except" ? sound.except : sound.only };
}

function SoundRow(props: { sound: SoundDraft; onChange: (next: SoundDraft) => void; windowExe?: string; windowTitle?: string }) {
  const { sound, onChange, windowExe } = props;
  const [choosing, setChoosing] = useState(false);
  const view = listView(sound, windowExe);
  const count = view.list.length;
  const apps = count === 1 ? "1 app" : `${count} apps`;

  function setMode(mode: AppListMode) {
    if (mode === view.mode) return;
    const only = mode === "only" && !sound.only.length && windowExe ? [windowExe] : sound.only;
    onChange({ ...sound, edited: true, mode, only });
  }

  function toggle(exe: string) {
    const list = view.list.includes(exe) ? view.list.filter((x) => x !== exe) : [...view.list, exe];
    onChange({ ...sound, edited: true, mode: view.mode, ...(view.mode === "except" ? { except: list } : { only: list }) });
  }

  return (
    <div className="stack tight">
      <div className="row spread">
        <label className="check">
          <input type="checkbox" checked={sound.on} onChange={(e) => onChange({ ...sound, on: e.target.checked })} />
          {windowExe !== undefined && !sound.edited ? (
            <span>
              Only {props.windowTitle ?? "this app"}'s sound
              <span className="muted small"> · Discord, music and everything else stay out of the stream</span>
            </span>
          ) : view.mode === "only" ? (
            <span>
              Include sound
              <span className="muted small"> · only the {apps} you chose</span>
            </span>
          ) : (
            <span>
              Include sound
              <span className="muted small"> · everything you hear except Discord{count ? `, other voice chat and ${apps} you chose` : " and other voice chat"}</span>
            </span>
          )}
        </label>
        {sound.on && (
          <button type="button" className="link" aria-expanded={choosing} onClick={() => setChoosing((c) => !c)}>
            Choose apps
          </button>
        )}
      </div>
      {sound.on && choosing && <AppPicker mode={view.mode} list={view.list} onMode={setMode} onToggle={toggle} />}
    </div>
  );
}

function AppPicker(props: { mode: AppListMode; list: string[]; onMode: (mode: AppListMode) => void; onToggle: (exe: string) => void }) {
  const [apps, setApps] = useState<AudioApp[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    const refresh = () =>
      listAudioApps().then(
        (next) => {
          if (stopped) return;
          setApps(next);
          setFailed(false);
        },
        () => !stopped && setFailed(true),
      );
    refresh();
    const id = setInterval(refresh, APPS_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const running = apps ?? [];
  // A listed app that isn't running right now stays in view, or it could never be unlisted.
  const absent = props.list.filter((exe) => !running.some((a) => a.exe === exe));
  const except = props.mode === "except";
  return (
    <div className="stack tight">
      <div className="segmented picker-modes" role="radiogroup" aria-label="Which apps">
        <button type="button" role="radio" aria-checked={except} className={except ? "active" : ""} onClick={() => props.onMode("except")}>
          Everything except
        </button>
        <button type="button" role="radio" aria-checked={!except} className={!except ? "active" : ""} onClick={() => props.onMode("only")}>
          Only these
        </button>
      </div>
      <ul className="app-rows" aria-label="Apps">
        {apps === null && !failed && <li className="muted small">Looking for apps…</li>}
        {failed && <li className="small warn">Couldn't list the apps playing sound.</li>}
        {apps?.length === 0 && absent.length === 0 && <li className="muted small">No apps found.</li>}
        {running.map((a) => (
          <AppRow key={a.exe} name={a.name} exe={a.exe} state={a.playing ? "Playing" : "Idle"} checked={except !== props.list.includes(a.exe)} onToggle={props.onToggle} />
        ))}
        {absent.map((exe) => (
          <AppRow key={exe} name={exe.replace(/\.exe$/, "")} exe={exe} state="Not running" checked={except !== props.list.includes(exe)} onToggle={props.onToggle} />
        ))}
      </ul>
      <p className="muted small footnote">
        {except ? "New apps are included as they start." : "New apps stay out until you tick them."} Discord and other voice chat always stay out.
      </p>
    </div>
  );
}

function AppRow(props: { name: string; exe: string; state: string; checked: boolean; onToggle: (exe: string) => void }) {
  return (
    <li>
      <label className="app-row small" title={props.exe}>
        <input type="checkbox" checked={props.checked} onChange={() => props.onToggle(props.exe)} />
        <span className="app-name">{props.name}</span>
        <span className={props.state === "Playing" ? "app-state playing" : "app-state muted"}>{props.state}</span>
      </label>
    </li>
  );
}

function MicRow(props: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="stack tight">
      <label className="check">
        <input type="checkbox" checked={props.on} onChange={(e) => props.onChange(e.target.checked)} />
        <span>Include my microphone</span>
      </label>
      {props.on && <p className="muted small footnote">Use headphones, or viewers will hear your speakers through the mic</p>}
    </div>
  );
}

function BitrateRow(props: { customMbps: number | null; autoUpload: number; onChoose: (value: number | null) => void }) {
  const { customMbps, autoUpload, onChoose } = props;
  return (
    <div className="row">
      <span className="small">Video bitrate</span>
      <div className="segmented" role="radiogroup" aria-label="Video bitrate">
        <button type="button" role="radio" aria-checked={customMbps === null} className={customMbps === null ? "active" : ""} onClick={() => onChoose(null)}>
          Auto
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={customMbps !== null}
          className={customMbps !== null ? "active" : ""}
          onClick={() => onChoose(customMbps ?? Math.max(MIN_MBPS, Math.round((autoUpload - OPUS_UPLOAD_KBPS) / 1000)))}
        >
          Custom
        </button>
      </div>
      {customMbps !== null ? (
        <label className="row small">
          <input
            type="number"
            className="bitrate-input"
            aria-label="Video bitrate in Mbps"
            min={MIN_MBPS}
            max={MAX_MBPS}
            step={0.5}
            value={customMbps}
            onChange={(e) => e.target.value !== "" && onChoose(Number(e.target.value))}
          />
          Mbps
        </label>
      ) : (
        <span className="muted small">Set from the size and frame rate of what you're streaming</span>
      )}
    </div>
  );
}

// Windows don't report their size here, so they're estimated at 1080p.
function autoUploadKbps(settings: ShareSettings, layers: LayerCount, monitor: MonitorTarget | undefined): number {
  const sourceHeight = monitor?.height ?? 1080;
  const sourceWidth = monitor?.width ?? 1920;
  const outHeight = settings.height ? Math.min(settings.height, sourceHeight) : sourceHeight;
  return uploadKbps(equivalentHeight((sourceWidth * outHeight) / sourceHeight, outHeight), settings.fps, layers);
}

type Pick = { kind: "monitor"; id: number } | { kind: "window"; id: number };
type Thumbs = Record<string, string | "blank" | null>;

// One at a time: the Rust side captures through a single device anyway.
async function loadThumbs(ms: MonitorTarget[], ws: CaptureTarget[], stopped: () => boolean, onThumb: (key: string, thumb: string | "blank" | null) => void) {
  for (const m of ms) {
    const t = await captureMonitorThumbnail(m.id, THUMB_WIDTH);
    if (stopped()) return;
    onThumb(`m${m.id}`, t);
  }
  for (const w of ws) {
    const t = await captureThumbnail(w.id, THUMB_WIDTH);
    if (stopped()) return;
    onThumb(`w${w.id}`, t);
  }
}

// Fullscreen apps are almost always the game you mean.
const sortWindows = (ws: CaptureTarget[]) => [...ws].sort((a, b) => Number(b.fullscreen) - Number(a.fullscreen));

function SourcePicker(props: { monitors: MonitorTarget[]; windows: CaptureTarget[] | null; thumbs: Thumbs; picked: Pick | null; onPick: (pick: Pick) => void }) {
  const { monitors, windows: shown, thumbs, picked } = props;
  return (
    <>
      {monitors.length > 0 && (
        <section className="stack tight" aria-label="Screens">
          <span className="small muted">Screens</span>
          <div className="screens" role="listbox" aria-label="Screens">
            {monitors.map((m, i) => {
              const active = picked?.kind === "monitor" && picked.id === m.id;
              const thumb = thumbs[`m${m.id}`];
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={active ? "screen active" : "screen"}
                  onClick={() => props.onPick({ kind: "monitor", id: m.id })}
                >
                  <span className="screen-well">{typeof thumb === "string" && thumb !== "blank" && <img src={thumb} alt="" />}</span>
                  <span className="small">
                    Screen {i + 1}
                    <span className="muted"> · {m.width}×{m.height}{m.primary ? " · main" : ""}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="stack tight" aria-label="Windows">
        <span className="small muted">Windows</span>
        <ul className="targets" role="listbox" aria-label="Windows">
          {shown === null && <li className="muted small">Looking for windows…</li>}
          {shown?.map((t) => {
            const active = picked?.kind === "window" && picked.id === t.id;
            const thumb = thumbs[`w${t.id}`];
            return (
              <li key={t.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={active ? "target active" : "target"}
                  onClick={() => props.onPick({ kind: "window", id: t.id })}
                >
                  {t.icon ? (
                    <img className="target-icon" src={t.icon} alt="" />
                  ) : (
                    <span className="target-icon" aria-hidden="true">{t.title.slice(0, 1)}</span>
                  )}
                  <span className="target-text">
                    <span className="target-title">{t.title}</span>
                    <span className="muted small">{t.exe}</span>
                  </span>
                  {t.fullscreen && <span className="tag">Fullscreen</span>}
                  <span className="target-thumb">{typeof thumb === "string" && <img src={thumb} alt="" />}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

export function GoLiveSheet(props: {
  roomName: string;
  onClose: () => void;
  onStart: (choices: LiveChoices) => Promise<void>;
}) {
  const [monitors, setMonitors] = useState<MonitorTarget[]>([]);
  const [windows, setWindows] = useState<CaptureTarget[] | null>(null);
  const [thumbs, setThumbs] = useState<Thumbs>({});
  const [picked, setPicked] = useState<Pick | null>(null);
  const [sound, setSound] = useState(newSound);
  // Always starts off, and isn't remembered: a forgotten hot mic is the worse failure.
  const [mic, setMic] = useState(false);
  const quality = useShareQuality();
  const [layers, setLayersState] = useState(loadLayers);
  // Mbps of video the user chose, or null for Auto.
  const [customMbps, setCustomMbps] = useState(loadCustomMbps);
  const [note, setNote] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let stopped = false;
    async function refresh() {
      const [ms, ws] = await Promise.all([listMonitors(), listWindows()]);
      if (stopped) return;
      const sorted = sortWindows(ws);
      setMonitors(ms);
      setWindows(sorted);
      setPicked((p) => p ?? (sorted[0] ? { kind: "window", id: sorted[0].id } : ms[0] ? { kind: "monitor", id: ms[0].id } : null));
      await loadThumbs(ms, sorted, () => stopped, (key, t) => setThumbs((prev) => ({ ...prev, [key]: t })));
    }
    refresh().catch((e) => setNote(String(e)));
    const id = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  // Windows that draw nothing (helper windows, empty overlays) aren't worth offering.
  const shown = windows?.filter((w) => thumbs[`w${w.id}`] !== "blank") ?? null;
  const pickedWindow = picked?.kind === "window" ? windows?.find((w) => w.id === picked.id) : undefined;
  const pickedMonitor = picked?.kind === "monitor" ? monitors.find((m) => m.id === picked.id) : undefined;

  function setLayers(n: LayerCount) {
    setLayersState(n);
    localStorage.setItem(LAYERS_STORE, String(n));
  }

  const { height } = quality.settings;
  const autoUpload = autoUploadKbps(quality.settings, layers, pickedMonitor);
  const custom = customMbps === null ? 0 : clampMbps(customMbps);
  const upload = custom ? custom * 1000 + OPUS_UPLOAD_KBPS : autoUpload;

  function chooseBitrate(value: number | null) {
    setCustomMbps(value);
    saveBitrate(value);
  }

  async function start() {
    let source: LiveSource;
    let sourceLabel: string;
    if (pickedMonitor) {
      source = { kind: "monitor", id: pickedMonitor.id };
      sourceLabel = `Screen ${monitors.indexOf(pickedMonitor) + 1}`;
    } else if (pickedWindow) {
      source = { kind: "window", id: pickedWindow.id, pid: pickedWindow.pid };
      sourceLabel = pickedWindow.title;
    } else return;
    const audio = soundToAudio(sound, pickedWindow?.pid);
    setStarting(true);
    setNote("");
    try {
      await props.onStart({
        source,
        sourceLabel,
        sourceExe: pickedWindow?.exe.toLowerCase() ?? "",
        audio,
        settings: quality.settings,
        layers,
        totalKbps: Math.round(custom * 1000),
        mic,
      });
      rememberExcluded(audio);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Sheet title={`Go live in #${props.roomName}`} onClose={props.onClose} wide>
      <div className="stack">
        <SourcePicker monitors={monitors} windows={shown} thumbs={thumbs} picked={picked} onPick={setPicked} />

        <SoundRow sound={sound} onChange={setSound} windowExe={pickedMonitor ? undefined : (pickedWindow?.exe.toLowerCase() ?? "")} windowTitle={pickedWindow?.title} />
        <MicRow on={mic} onChange={setMic} />

        <div className="row">
          <span className="small">Viewer quality options</span>
          <div className="segmented" role="radiogroup" aria-label="Viewer quality options">
            {LAYER_COUNTS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={layers === n} className={layers === n ? "active" : ""} onClick={() => setLayers(n)}>
                {n}
              </button>
            ))}
          </div>
          <span className="muted small">
            {layers === 1 ? "Everyone gets the full picture" : "Lets viewers on slow connections pick a smaller version"}
          </span>
        </div>

        <BitrateRow customMbps={customMbps} autoUpload={autoUpload} onChoose={chooseBitrate} />

        <div className="row spread">
          <div className="row">
            <QualityPicker quality={quality} />
            <span className="muted small">
              About {mbps(upload)} upload{custom || pickedMonitor ? "" : height ? ", less for a small window" : " at 1080p, follows the window size"}
            </span>
          </div>
          <button
            type="button"
            className="go-live"
            disabled={(!pickedWindow && !pickedMonitor) || starting}
            onClick={start}
          >
            <span className="rec" aria-hidden="true" />
            {starting ? "Starting…" : "Go live"}
          </button>
        </div>
        {note && <p className="small warn">{note}</p>}
      </div>
    </Sheet>
  );
}

// Same shape as useShareQuality, but saves nothing: Modify only touches the saved defaults on Apply.
function useDraftQuality(initial: ShareSettings): ShareQuality {
  const match = Object.entries(PRESETS).find(([, p]) => p.height === initial.height && p.fps === initial.fps);
  const [preset, setPreset] = useState<PresetId | "custom">(match ? (match[0] as PresetId) : "custom");
  const [custom, setCustom] = useState<ShareSettings>({ height: initial.height, fps: initial.fps });
  return { preset, custom, settings: preset === "custom" ? custom : PRESETS[preset], setPreset, setCustom };
}

// The running stream's settings. Reads them back from the app each time it opens, so it works after
// a reload too. Thumbnails only load if you ask to change what's showing, and only once: the
// encoder is busy.
export function ModifySheet(props: { room: string; onClose: () => void }) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    liveStatus()
      .then((s) => (s ? setStatus(s) : setFailed("The stream is still starting.")))
      .catch((e) => setFailed(String(e)));
  }, []);
  const title = `Modify stream in #${props.room}`;
  if (!status) {
    return (
      <Sheet title={title} onClose={props.onClose} wide>
        <p className={failed ? "small warn" : "small muted"}>{failed || "Reading the stream's settings…"}</p>
      </Sheet>
    );
  }
  return <ModifyForm title={title} status={status} onClose={props.onClose} />;
}

function ModifyForm(props: { title: string; status: LiveStatus; onClose: () => void }) {
  const { source: currentSource, sourceLabel: currentLabel, sourceExe: currentExe, audio: currentAudio, settings: current } = props.status.config;
  const saved = useShareQuality();
  const quality = useDraftQuality(current);
  const [sound, setSound] = useState(() => soundFrom(currentAudio));
  const micWas = props.status.mic !== "off";
  const [mic, setMic] = useState(micWas);
  const [customMbps, setCustomMbps] = useState<number | null>(current.total_kbps ? current.total_kbps / 1000 : null);
  const [monitors, setMonitors] = useState<MonitorTarget[]>([]);
  const [changing, setChanging] = useState(false);
  const [windows, setWindows] = useState<CaptureTarget[] | null>(null);
  const [thumbs, setThumbs] = useState<Thumbs>({});
  const [picked, setPicked] = useState<Pick>(currentSource);
  const [note, setNote] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    listMonitors().then(setMonitors).catch(() => {});
  }, []);

  useEffect(() => {
    if (!changing) return;
    let stopped = false;
    (async () => {
      const [ms, ws] = await Promise.all([listMonitors(), listWindows()]);
      if (stopped) return;
      const sorted = sortWindows(ws);
      setMonitors(ms);
      setWindows(sorted);
      await loadThumbs(ms, sorted, () => stopped, (key, t) => setThumbs((prev) => ({ ...prev, [key]: t })));
    })().catch((e) => setNote(String(e)));
    return () => {
      stopped = true;
    };
  }, [changing]);

  const shown = windows?.filter((w) => thumbs[`w${w.id}`] !== "blank") ?? null;
  const sourceChanged = picked.kind !== currentSource.kind || picked.id !== currentSource.id;
  const nextWindow = sourceChanged && picked.kind === "window" ? windows?.find((w) => w.id === picked.id) : undefined;
  const nextScreen = picked.kind === "monitor" ? monitors.findIndex((m) => m.id === picked.id) : -1;
  const monitor = monitors[nextScreen];
  const windowPid = sourceChanged ? nextWindow?.pid : currentSource.kind === "window" ? currentSource.pid : undefined;
  const windowExe = sourceChanged ? nextWindow?.exe.toLowerCase() : currentSource.kind === "window" ? currentExe : undefined;
  const windowTitle = sourceChanged ? nextWindow?.title : currentLabel;
  const sourceLabel = !sourceChanged ? currentLabel : nextWindow ? nextWindow.title : `Screen ${nextScreen + 1}`;

  function pick(next: Pick) {
    setPicked(next);
    // A new picture starts with that window's own sound, or a screen's usual sound.
    setSound((s) => ({ ...s, edited: false }));
  }

  function sourceChange(): SourceChange | null {
    if (!sourceChanged) return null;
    if (nextWindow) return { source: { kind: "window", id: nextWindow.id, pid: nextWindow.pid }, sourceLabel, sourceExe: nextWindow.exe.toLowerCase() };
    if (picked.kind === "monitor") return { source: { kind: "monitor", id: picked.id }, sourceLabel, sourceExe: "" };
    return null;
  }

  const layers = current.layers as LayerCount;
  const totalKbps = customMbps === null ? 0 : Math.round(clampMbps(customMbps) * 1000);
  const audio = soundToAudio(sound, windowPid);
  const qualityChanged = quality.settings.height !== current.height || quality.settings.fps !== current.fps;
  const bitrateChanged = totalKbps !== current.total_kbps;
  const rebuilds = qualityChanged || bitrateChanged;
  const changed = rebuilds || sourceChanged || mic !== micWas || JSON.stringify(audio) !== JSON.stringify(currentAudio);
  const autoUpload = autoUploadKbps(quality.settings, layers, monitor);
  const upload = totalKbps ? totalKbps + OPUS_UPLOAD_KBPS : autoUpload;

  async function apply() {
    setApplying(true);
    setNote("");
    try {
      await modifyLive(audio, quality.settings, layers, totalKbps, sourceChange());
      if (mic !== micWas) await setLiveMic(mic);
      rememberExcluded(audio);
      if (qualityChanged) {
        saved.setPreset(quality.preset);
        if (quality.preset === "custom") saved.setCustom(quality.custom);
      }
      if (bitrateChanged) saveBitrate(customMbps);
      props.onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  }

  return (
    <Sheet title={props.title} onClose={props.onClose} wide>
      <div className="stack">
        <div className="row spread">
          <span className="small">Showing {sourceLabel}</span>
          <button type="button" className="link" aria-expanded={changing} onClick={() => setChanging((c) => !c)}>
            {changing ? "Hide" : "Change"}
          </button>
        </div>
        {changing && <SourcePicker monitors={monitors} windows={shown} thumbs={thumbs} picked={picked} onPick={pick} />}

        <SoundRow sound={sound} onChange={setSound} windowExe={picked.kind === "window" ? (windowExe ?? "") : undefined} windowTitle={windowTitle} />
        <MicRow on={mic} onChange={setMic} />

        <div className="row">
          <span className="small">Viewer quality options</span>
          <div className="segmented" role="radiogroup" aria-label="Viewer quality options">
            {LAYER_COUNTS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={layers === n} className={layers === n ? "active" : ""} disabled>
                {n}
              </button>
            ))}
          </div>
          <span className="muted small">Set before going live</span>
        </div>

        <BitrateRow customMbps={customMbps} autoUpload={autoUpload} onChoose={setCustomMbps} />

        <div className="row spread">
          <div className="row">
            <QualityPicker quality={quality} />
            <span className="muted small">About {mbps(upload)} upload</span>
          </div>
          <div className="row">
            {(rebuilds || sourceChanged) && <span className="muted small">Picture blips briefly</span>}
            <button type="button" disabled={!changed || applying} onClick={apply}>
              {applying ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
        {note && <p className="small warn">{note}</p>}
      </div>
    </Sheet>
  );
}
