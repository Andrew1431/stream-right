import { useEffect, useState } from "react";
import { QualityPicker, useShareQuality } from "../../ui/QualityPicker";
import {
  captureMonitorThumbnail,
  captureThumbnail,
  listMonitors,
  listWindows,
  type CaptureTarget,
  type MonitorTarget,
} from "./native";
import { Sheet } from "./Sheet";

const THUMB_WIDTH = 320;
// Previews refresh while the sheet is open, so a game that just went fullscreen shows up.
const REFRESH_MS = 5000;

type Pick = { kind: "monitor"; id: number } | { kind: "window"; id: number };

export function GoLiveSheet(props: { roomName: string; onClose: () => void }) {
  const [monitors, setMonitors] = useState<MonitorTarget[]>([]);
  const [windows, setWindows] = useState<CaptureTarget[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string | "blank" | null>>({});
  const [picked, setPicked] = useState<Pick | null>(null);
  const [sound, setSound] = useState(true);
  const quality = useShareQuality();
  const [note, setNote] = useState("");

  useEffect(() => {
    let stopped = false;
    async function refresh() {
      const [ms, ws] = await Promise.all([listMonitors(), listWindows()]);
      if (stopped) return;
      // Fullscreen apps are almost always the game you mean.
      const sorted = [...ws].sort((a, b) => Number(b.fullscreen) - Number(a.fullscreen));
      setMonitors(ms);
      setWindows(sorted);
      setPicked((p) => p ?? (sorted[0] ? { kind: "window", id: sorted[0].id } : ms[0] ? { kind: "monitor", id: ms[0].id } : null));
      // One at a time: the Rust side captures through a single device anyway.
      for (const m of ms) {
        const t = await captureMonitorThumbnail(m.id, THUMB_WIDTH);
        if (stopped) return;
        setThumbs((prev) => ({ ...prev, [`m${m.id}`]: t }));
      }
      for (const w of sorted) {
        const t = await captureThumbnail(w.id, THUMB_WIDTH);
        if (stopped) return;
        setThumbs((prev) => ({ ...prev, [`w${w.id}`]: t }));
      }
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

  return (
    <Sheet title={`Go live in #${props.roomName}`} onClose={props.onClose} wide>
      <div className="stack">
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
                    onClick={() => setPicked({ kind: "monitor", id: m.id })}
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
                    onClick={() => setPicked({ kind: "window", id: t.id })}
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

        <label className="check">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
          {pickedMonitor ? (
            <span>
              Include sound
              <span className="muted small"> · everything you hear except Discord and other voice chat</span>
            </span>
          ) : (
            <span>
              Only {pickedWindow?.title ?? "this app"}'s sound
              <span className="muted small"> · Discord, music and everything else stay out of the stream</span>
            </span>
          )}
        </label>

        <div className="row spread">
          <div className="row">
            <QualityPicker quality={quality} />
          </div>
          <button
            type="button"
            className="go-live"
            disabled={!picked}
            onClick={() => setNote("Native streaming is being built; this sheet is its UI.")}
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

