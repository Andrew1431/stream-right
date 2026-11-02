import type { BufferStats } from "./buffer";
import type { Kind, WorkerIn, WorkerOut } from "./worker";

export type { BufferStats };

const hasScriptTransform = typeof RTCRtpScriptTransform !== "undefined";
const hasEncodedStreams = typeof RTCRtpReceiver !== "undefined" && "createEncodedStreams" in RTCRtpReceiver.prototype;
export const clipsSupported = hasScriptTransform || hasEncodedStreams;
// Chrome's older createEncodedStreams needs a flag on the PeerConnection before any track arrives.
export const needsInsertableStreams = !hasScriptTransform && hasEncodedStreams;

type EncodedStreamsReceiver = RTCRtpReceiver & {
  createEncodedStreams(): { readable: ReadableStream; writable: WritableStream };
};

// Owns the clip worker for a room. Keys are publisher session ids; only those are buffered.
// Nothing is created until the first stream is buffered.
export class Clipper {
  keys = new Set<string>();
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (msg: WorkerOut) => void>();
  private attached = new WeakSet<RTCRtpReceiver>();

  configure(keys: Set<string>, seconds: number) {
    this.keys = keys;
    if (keys.size || this.worker) this.post({ type: "config", keys: [...keys], seconds });
  }

  // Routes a new receiver's frames through the worker, which keeps copies only for `keys`.
  // Chrome only delivers frames to a transform set as the track arrives, and removing one
  // stalls the track, so this is done once per receiver and never undone.
  attach(receiver: RTCRtpReceiver, key: string, kind: Kind, insertable: boolean) {
    if (this.attached.has(receiver)) return;
    this.attached.add(receiver);
    if (insertable) {
      const { readable, writable } = (receiver as EncodedStreamsReceiver).createEncodedStreams();
      this.post({ type: "streams", key, kind, readable, writable }, [readable, writable]);
    } else if (hasScriptTransform) {
      receiver.transform = new RTCRtpScriptTransform(this.getWorker(), { key, kind });
    }
  }

  async stats(): Promise<Record<string, BufferStats>> {
    if (!this.worker) return {};
    const reply = await this.ask({ type: "stats", id: this.nextId++ });
    return reply.type === "stats" ? reply.stats : {};
  }

  async save(keys: string[], seconds: number): Promise<{ key: string; data: ArrayBuffer | null }[]> {
    if (!this.worker) return [];
    const reply = await this.ask({ type: "save", id: this.nextId++, keys, seconds });
    return reply.type === "saved" ? reply.files : [];
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const resolve of this.pending.values()) resolve({ type: "stats", id: 0, stats: {} });
    this.pending.clear();
  }

  private ask(msg: Extract<WorkerIn, { id: number }>): Promise<WorkerOut> {
    return new Promise((resolve) => {
      this.pending.set(msg.id, resolve);
      this.post(msg);
    });
  }

  private post(msg: WorkerIn, transfer: Transferable[] = []) {
    this.getWorker().postMessage(msg, transfer);
  }

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "clips" });
      this.worker.onmessage = ({ data }: MessageEvent<WorkerOut>) => {
        this.pending.get(data.id)?.(data);
        this.pending.delete(data.id);
      };
    }
    return this.worker;
  }
}
