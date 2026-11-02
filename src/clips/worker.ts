// Sees every received frame of the streams being buffered, keeps a copy, and passes the frame on
// untouched. Muxing happens here too, so frames never cross back to the page.
import { StreamBuffer, type BufferStats } from "./buffer";

export type Kind = "audio" | "video";

export type WorkerIn =
  | { type: "config"; keys: string[]; seconds: number }
  // Chrome's older createEncodedStreams path: streams arrive by message and are always piped.
  | { type: "streams"; key: string; kind: Kind; readable: ReadableStream; writable: WritableStream }
  | { type: "stats"; id: number }
  | { type: "save"; id: number; keys: string[]; seconds: number };

export type WorkerOut =
  | { type: "stats"; id: number; stats: Record<string, BufferStats> }
  | { type: "saved"; id: number; files: { key: string; data: ArrayBuffer | null }[] };

type EncodedFrame = {
  data: ArrayBuffer;
  type?: "key" | "delta" | "empty";
  timestamp: number;
  getMetadata(): { rtpTimestamp?: number };
};

type Transformer = {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
  options: { key: string; kind: Kind };
  sendKeyFrameRequest?: () => Promise<void>;
};

// WebRTC senders only send keyframes when asked, and a buffer can only start at one.
const KEYFRAME_EVERY_S = 10;
const TRIM_EVERY_MS = 1_000;

const scope = self as unknown as {
  onmessage: (e: MessageEvent<WorkerIn>) => void;
  onrtctransform: (e: { transformer: Transformer }) => void;
  postMessage: (msg: WorkerOut, transfer?: Transferable[]) => void;
};

let seconds = 60;
const enabled = new Set<string>();
const buffers = new Map<string, StreamBuffer>();
const now = () => performance.now() / 1000;

function handle(t: Omit<Transformer, "options"> & { key: string; kind: Kind }) {
  let lastRequest = -Infinity;
  const passThrough = new TransformStream<EncodedFrame, EncodedFrame>({
    transform(frame, controller) {
      if (enabled.has(t.key)) {
        try {
          record(t.key, t.kind, frame);
          const buffer = buffers.get(t.key)!;
          const at = now();
          if (t.kind === "video" && t.sendKeyFrameRequest && at - buffer.lastKeyAt > KEYFRAME_EVERY_S && at - lastRequest > KEYFRAME_EVERY_S) {
            lastRequest = at;
            t.sendKeyFrameRequest().catch(() => {});
          }
        } catch {
          // Never let buffering get in the way of playback.
        }
      }
      controller.enqueue(frame);
    },
  });
  t.readable.pipeThrough(passThrough).pipeTo(t.writable).catch(() => {});
}

function record(key: string, kind: Kind, frame: EncodedFrame) {
  if (frame.type === "empty" || !frame.data.byteLength) return;
  let buffer = buffers.get(key);
  if (!buffer) buffers.set(key, (buffer = new StreamBuffer()));
  const rtp = frame.getMetadata().rtpTimestamp ?? frame.timestamp;
  const data = new Uint8Array(frame.data);
  if (kind === "video") buffer.pushVideo(data, frame.type === "key", rtp, now());
  else buffer.pushAudio(data, rtp, now());
}

scope.onrtctransform = ({ transformer: t }) =>
  handle({
    readable: t.readable,
    writable: t.writable,
    key: t.options.key,
    kind: t.options.kind,
    sendKeyFrameRequest: t.sendKeyFrameRequest && (() => t.sendKeyFrameRequest!()),
  });

scope.onmessage = async ({ data: msg }) => {
  switch (msg.type) {
    case "config":
      seconds = msg.seconds;
      enabled.clear();
      for (const k of msg.keys) enabled.add(k);
      for (const k of buffers.keys()) if (!enabled.has(k)) buffers.delete(k);
      break;
    case "streams":
      handle(msg);
      break;
    case "stats": {
      const stats: Record<string, BufferStats> = {};
      for (const [k, b] of buffers) stats[k] = b.stats(now());
      scope.postMessage({ type: "stats", id: msg.id, stats });
      break;
    }
    case "save": {
      const at = now();
      const files = await Promise.all(
        msg.keys.map(async (key) => ({ key, data: (await buffers.get(key)?.mux(msg.seconds, at).catch(() => null)) ?? null })),
      );
      scope.postMessage({ type: "saved", id: msg.id, files }, files.flatMap((f) => (f.data ? [f.data] : [])));
      break;
    }
  }
};

setInterval(() => {
  for (const b of buffers.values()) b.trim(seconds, now());
}, TRIM_EVERY_MS);
