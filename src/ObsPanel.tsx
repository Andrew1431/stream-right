import { useEffect, useState } from "react";
import type { RoomConnection } from "./connection";
import { detectGpu, GPUS, OBS_QUALITIES, obsSetupZip, type Gpu, type ObsQuality } from "./obsSetup";
import { load, remove, save } from "./storage";

const OBS_DOWNLOAD = "https://obsproject.com/download";
const QUALITY_STORE = "obsSetupQuality";
const MODE_STORE = "obsSetupMode";
type SetupMode = "manual" | "file";

const keyStore = (roomId: string) => `obsKey:${roomId}`;

export const loadObsKey = (roomId: string) => load(keyStore(roomId), "");
export const forgetObsKey = (roomId: string) => remove(keyStore(roomId));

// SHA-256 prefix the server shows on OBS members, so we can tell which OBS stream is ours.
export async function obsKeyId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// Shows the WHIP server and bearer token to paste into OBS. The key is kept per room in
// this browser so OBS settings stay valid; rotating the room's invite link revokes it.
export function ObsPanel(props: {
  conn: RoomConnection;
  roomId: string;
  connected: boolean;
  obsKey: string;
  // The streamer's clip opt-out, carried by the key into their OBS stream.
  noClips: boolean;
  onKey: (key: string) => void;
  onClose: () => void;
}) {
  const key = props.obsKey;
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const server = `${location.origin}/api/rooms/${props.roomId}/whip`;
  const [quality, setQuality] = useState<ObsQuality>(() => {
    const saved = load<string>(QUALITY_STORE, "1080p60");
    return saved in OBS_QUALITIES ? (saved as ObsQuality) : "1080p60";
  });
  const [gpu, setGpu] = useState<Gpu>(detectGpu);
  const [mode, setMode] = useState<SetupMode>(() => (load<string>(MODE_STORE, "manual") === "file" ? "file" : "manual"));

  function changeMode(next: SetupMode) {
    setMode(next);
    save(MODE_STORE, next);
  }

  function downloadSetup() {
    const blob = obsSetupZip({ roomId: props.roomId, server, token: key, quality, gpu });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Stream ${props.roomId} OBS setup.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  async function newKey() {
    if (key && !confirm("Make a new token? The current one stops working, and an OBS stream using it ends.")) return;
    setError("");
    try {
      const res = await props.conn.request({ op: "obsKey", noClips: props.noClips, replaces: props.obsKey || undefined });
      if (!res.obsKey) throw new Error("No key returned");
      save(keyStore(props.roomId), res.obsKey);
      props.onKey(res.obsKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!key && props.connected) newKey();
  }, [props.connected]);

  return (
    <section className="obs-panel card">
      <div className="row spread">
        <h2>Stream from OBS</h2>
        <button type="button" className="link" onClick={props.onClose}>Close</button>
      </div>
      <p className="muted small">
        OBS encodes on your graphics card and captures games directly, so it holds quality and frame rate much
        better than sharing from the browser. Your OBS stream shows up here as its own member.
      </p>

      <div className="row obs-modes">
        <div className="segmented" role="tablist" aria-label="Setup method">
          <button type="button" role="tab" aria-selected={mode === "manual"} className={mode === "manual" ? "active" : ""} onClick={() => changeMode("manual")}>
            Enter settings
          </button>
          <button type="button" role="tab" aria-selected={mode === "file"} className={mode === "file" ? "active" : ""} onClick={() => changeMode("file")}>
            Import a setup file
          </button>
        </div>
        <a className="small" href={OBS_DOWNLOAD} target="_blank" rel="noreferrer">Download OBS Studio</a>
      </div>

      {mode === "manual" ? (
        <>
          <h3>1. Settings → Stream</h3>
          <dl className="obs-fields">
            <dt>Service</dt>
            <dd><code>WHIP</code></dd>
            <dt>Server</dt>
            <dd className="row">
              <code className="grow">{server}</code>
              <CopyButton value={server} />
            </dd>
            <dt>Bearer Token</dt>
            <dd className="row">
              <code className="grow">{key ? (reveal ? key : "•".repeat(24)) : "…"}</code>
              <button type="button" className="chip" onClick={() => setReveal((r) => !r)} disabled={!key}>
                {reveal ? "Hide" : "Show"}
              </button>
              <CopyButton value={key} />
            </dd>
            <dt>Simulcast</dt>
            <dd>
              <code>Total Layers: 3</code>{" "}
              <span className="muted small">(OBS 32+). Viewers' quality buttons and smaller tiles then get a smaller copy.</span>
            </dd>
          </dl>
          <p className="muted small">
            The token works until you make a new one or the room's invite link is rotated. Anyone with it can stream into this room as you.{" "}
            <button
              type="button"
              className="link"
              disabled={!props.connected}
              onClick={newKey}
            >
              Make a new token
            </button>
          </p>

          <h3>2. Settings → Output (Output Mode: Advanced → Streaming)</h3>
          <ul className="small obs-list">
            <li><strong>Video Encoder:</strong> NVIDIA NVENC H.264, AMD HW H.264 or QuickSync H.264 (not HEVC/AV1; browsers can't all play those over WebRTC)</li>
            <li><strong>Rate Control:</strong> CBR</li>
            <li><strong>Bitrate:</strong> about 8000 Kbps for 1080p60, 12000 for 1440p60, 20000 for 4K60 (your upload must handle it)</li>
            <li><strong>Keyframe Interval:</strong> 1 s, so viewers who join or switch quality see the picture right away</li>
            <li><strong>Max B-frames:</strong> 0 (WebRTC doesn't support them)</li>
          </ul>

          <h3>3. Settings → Video, then Sources</h3>
          <ul className="small obs-list">
            <li><strong>Output (Scaled) Resolution</strong> and <strong>FPS</strong>: whatever you want to send, e.g. 1440p at 60 or 120</li>
            <li>Add a <strong>Game Capture</strong> source (or Display Capture), then click <strong>Start Streaming</strong></li>
            <li>
              To keep Discord out of the stream: <strong>Settings → Audio → Desktop Audio: Disabled</strong>, then add an{" "}
              <strong>Application Audio Capture</strong> source for the game
            </li>
          </ul>

          <p className="muted small">
            With 1 layer (or older OBS) everyone gets the full stream and the High/Medium/Low buttons do nothing for it.
            With 3 layers OBS also sends 2/3 and 1/3 size copies; the bitrate you set is for the full-size one.
          </p>
        </>
      ) : (
        <>
          <p className="muted small">
            One file with your server, token, encoder and a game capture already set. If OBS offers its
            auto-configuration wizard on first launch, you can skip it.
          </p>
          <ol className="small obs-list">
            <li>
              Download your setup file, made for this room:
              <div className="row obs-setup">
                <select aria-label="Stream quality" value={quality} onChange={(e) => {
                  setQuality(e.target.value as ObsQuality);
                  save(QUALITY_STORE, e.target.value);
                }}>
                  {Object.entries(OBS_QUALITIES).map(([id, q]) => (
                    <option key={id} value={id}>{q.label} · {(q.kbps / 1000).toLocaleString()} Mbps</option>
                  ))}
                </select>
                <select aria-label="Graphics card" value={gpu} onChange={(e) => setGpu(e.target.value as Gpu)}>
                  {Object.entries(GPUS).map(([id, label]) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
                </select>
                <button type="button" disabled={!key} onClick={downloadSetup}>Download setup</button>
              </div>
            </li>
            <li>
              Unzip it. In OBS, <strong>Profile → Import</strong> the folder inside, and{" "}
              <strong>Scene Collection → Import</strong> the <code>.json</code> file, then pick both from those menus.
              The <code>Read me</code> file in the zip has the same steps.
            </li>
            <li>Start your game in fullscreen or borderless, then click <strong>Start Streaming</strong>.</li>
          </ol>
          <p className="muted small">
            Only the game's sound is streamed, so your Discord call and other apps stay out of it. The file holds your
            token, so don't share it.
          </p>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="chip"
      disabled={!value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          prompt("Copy:", value);
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
