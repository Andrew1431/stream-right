import { useEffect, useState } from "react";
import { CLIP_MAX_SECONDS, CLIP_MIN_SECONDS, type Member } from "../shared/protocol";
import type { BufferStats, Clipper } from "./clips/clipper";

const RAM_WARNING_BYTES = 500e6;
const STATS_MS = 1_000;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0)} MB`;

export const clipsBadgeHint = `Anyone here can save up to the last ${CLIP_MAX_SECONDS} seconds of what they're watching, on their own device`;

// Buffer stats from the clip worker, polled while `active`.
export function useClipStats(clipper: Clipper, active: boolean): Record<string, BufferStats> {
  const [stats, setStats] = useState<Record<string, BufferStats>>({});
  useEffect(() => {
    if (!active) return setStats({});
    let stopped = false;
    const poll = () => clipper.stats().then((s) => !stopped && setStats(s));
    poll();
    const id = setInterval(poll, STATS_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [clipper, active]);
  return stats;
}

export function ClipsPanel(props: {
  isOwner: boolean;
  allowed: boolean;
  onAllow: (allowed: boolean) => void;
  ownerError: string;
  supported: boolean;
  buffering: boolean;
  onBuffering: (on: boolean) => void;
  seconds: number;
  onSeconds: (s: number) => void;
  streams: { member: Member; key: string | null }[];
  stats: Record<string, BufferStats>;
  noClips: boolean;
  onNoClips: (v: boolean) => void;
  muted: boolean;
  onMuted: (v: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const total = props.streams.reduce((sum, s) => sum + (s.key ? (props.stats[s.key]?.bytes ?? 0) : 0), 0);

  return (
    <aside className="card usage-panel clips-panel" aria-label="Clips">
      <div className="row spread">
        <h2>Clips</h2>
        <button type="button" className="link small" onClick={props.onClose}>Close</button>
      </div>

      {props.isOwner && (
        <label className="check">
          <input type="checkbox" checked={props.allowed} onChange={(e) => props.onAllow(e.target.checked)} />
          <span>
            Allow clips in this room
            <span className="muted small"> · You own this room. Everyone sees a Clips on badge, who's buffering, and every clip saved.</span>
          </span>
        </label>
      )}
      {props.ownerError && <p className="error small">{props.ownerError}</p>}

      {!props.allowed ? (
        <p className="muted small">Clips are off. Nobody in this room can keep a buffer or save clips.</p>
      ) : (
        <>
          {!props.supported ? (
            <p className="muted small">This browser can't keep clips. Chrome, Edge, Firefox and Safari can.</p>
          ) : (
            <>
              <label className="check">
                <input type="checkbox" checked={props.buffering} onChange={(e) => props.onBuffering(e.target.checked)} />
                <span>Keep the last {props.seconds}s of each stream I watch, so I can save it</span>
              </label>
              <label className="clip-length small">
                <span className="muted">Length</span>
                <input
                  type="range"
                  min={CLIP_MIN_SECONDS}
                  max={CLIP_MAX_SECONDS}
                  step={15}
                  value={props.seconds}
                  onChange={(e) => props.onSeconds(Number(e.target.value))}
                />
                <span>{props.seconds}s</span>
              </label>
            </>
          )}

          {props.buffering && (
            <dl className="usage-stats small">
              {props.streams.length === 0 && (
                <>
                  <dt>Streams</dt>
                  <dd className="muted">Nobody else is sharing</dd>
                </>
              )}
              {props.streams.map(({ member, key }) => {
                const s = key ? props.stats[key] : undefined;
                return (
                  <div key={member.id} className="clip-stat">
                    <dt>{member.name}</dt>
                    <dd>
                      {!key ? (
                        <span className="muted">Clips off for this stream</span>
                      ) : s?.unsupported ? (
                        <span className="muted">Not H.264, can't be clipped</span>
                      ) : !s || s.seconds < 0.5 ? (
                        <span className="muted">Waiting for video…</span>
                      ) : (
                        <>
                          {Math.round(s.seconds)}s
                          <span className="muted">
                            {" "}· {s.width ? `${s.width}×${s.height}` : "audio only"} · {mb(s.bytes)}
                          </span>
                        </>
                      )}
                    </dd>
                  </div>
                );
              })}
              <dt>Memory</dt>
              <dd className={total > RAM_WARNING_BYTES ? "warn" : undefined}>
                ~{mb(total)}
                {total > RAM_WARNING_BYTES && <span> · That's a lot; shorten the length or watch fewer streams.</span>}
              </dd>
            </dl>
          )}

          <label className="check">
            <input type="checkbox" checked={props.muted} onChange={(e) => props.onMuted(e.target.checked)} />
            <span>Mute the clip sound <span className="muted small">(the notice still shows)</span></span>
          </label>
        </>
      )}

      <NoClipsToggle checked={props.noClips} onChange={props.onNoClips} />

      <p className="muted small">
        Clips are cut from the video you receive and saved only on your device; nothing is recorded on the server. The app
        enforces these rules, but anyone can still record their screen with other tools.
      </p>
    </aside>
  );
}

export function NoClipsToggle(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>Don't allow clips of my stream</span>
    </label>
  );
}

// Shown once when you join a room with clips on, and whenever they get switched on while you're here.
export function ClipsNotice(props: { noClips: boolean; onNoClips: (v: boolean) => void; onDone: () => void }) {
  return (
    <div className="card clips-notice" role="alertdialog" aria-labelledby="clips-notice-title">
      <h2 id="clips-notice-title">Clips are on in this room</h2>
      <p className="small">
        Anyone here can keep the last {CLIP_MIN_SECONDS}–{CLIP_MAX_SECONDS} seconds of the streams they watch and save them
        as video files on their own device. You'll see a dot next to whoever is keeping a buffer, and a notice every time
        someone saves a clip.
      </p>
      <NoClipsToggle checked={props.noClips} onChange={props.onNoClips} />
      <div className="row">
        <button type="button" onClick={props.onDone} autoFocus>Got it</button>
      </div>
    </div>
  );
}

export type Toast = { id: number; text: string };

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">{t.text}</div>
      ))}
    </div>
  );
}

let audio: AudioContext | null = null;

// A soft camera shutter: two short filtered noise clicks, made on the fly.
export function playShutter() {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const length = Math.round(ctx.sampleRate * 0.05);
    const noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    for (const [delay, freq] of [[0, 3200], [0.07, 2200]]) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = freq;
      filter.Q.value = 0.9;
      const gain = ctx.createGain();
      gain.gain.value = 0.25;
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start(ctx.currentTime + delay);
    }
  } catch {
    // No audio output; the toast still shows.
  }
}
