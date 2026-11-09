import {
  CloseCode,
  type ClientMessage,
  type Member,
  type ServerMessage,
  type SfuOp,
  type SfuResponse,
} from "../shared/protocol";

export type RoomStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "closed"; reason: string };

export type RoomSnapshot = {
  status: RoomStatus;
  members: Member[];
  you: string | null;
  // Bumps on every successful (re)join; SFU sessions don't survive a reconnect.
  epoch: number;
  clipsAllowed: boolean;
};

export type ClipEvent = Extract<ServerMessage, { type: "clip" }>;

const FINAL_REASONS: Record<number, string> = {
  [CloseCode.BadToken]: "This invite link isn't valid. Ask for a new one.",
  [CloseCode.NotFound]: "This room doesn't exist.",
  [CloseCode.TokenRotated]: "The invite link was changed. Ask for the new one.",
  [CloseCode.BadMessage]: "The connection was rejected.",
  [CloseCode.Replaced]: "This room was opened in another tab.",
  [CloseCode.UsageLimit]: "This server reached the monthly streaming limit its owner set. Rooms open again on the 1st (UTC).",
};

// Per tab, so a reload replaces this tab's old member instead of duplicating it.
let memoryClientId: string | null = null;
function tabClientId(): string {
  try {
    let id = sessionStorage.getItem("clientId");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("clientId", id);
    }
    return id;
  } catch {
    return (memoryClientId ??= crypto.randomUUID());
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

// The room answered and refused the request, as opposed to a timeout or a dropped socket.
export class ServerError extends Error {}

type Pending = { resolve: (r: SfuResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class RoomConnection {
  snapshot: RoomSnapshot = { status: { kind: "connecting" }, members: [], you: null, epoch: 0, clipsAllowed: false };

  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<() => void>();
  private clipListeners = new Set<(e: ClipEvent) => void>();

  constructor(
    private roomId: string,
    private token: string,
    private name: string,
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  onClip = (fn: (e: ClipEvent) => void) => {
    this.clipListeners.add(fn);
    return () => {
      this.clipListeners.delete(fn);
    };
  };

  // Leave right away on navigation instead of waiting for the server to notice.
  private onPageHide = () => this.ws?.close(1000);

  start() {
    this.stopped = false;
    addEventListener("pagehide", this.onPageHide);
    this.connect();
  }

  stop() {
    removeEventListener("pagehide", this.onPageHide);
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close(1000);
    this.failPending("Disconnected");
  }

  request(op: SfuOp): Promise<SfuResponse> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.snapshot.status.kind !== "connected") {
      return Promise.reject(new Error("Not connected"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op.op} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "sfu", id, ...op } satisfies ClientMessage));
    });
  }

  private set(patch: Partial<RoomSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }

  private failPending(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${encodeURIComponent(this.roomId)}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({ type: "hello", token: this.token, name: this.name, clientId: tabClientId() } satisfies ClientMessage),
      );
    };

    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);

    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.failPending("Disconnected");
      if (this.stopped) return;

      const final = FINAL_REASONS[e.code];
      if (final) {
        this.set({ status: { kind: "closed", reason: final }, members: [], you: null });
        return;
      }
      this.attempt += 1;
      this.set({ status: { kind: "reconnecting", attempt: this.attempt }, members: [], you: null });
      this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** (this.attempt - 1), 15_000));
    };
  }

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome":
        this.attempt = 0;
        this.set({
          status: { kind: "connected" },
          you: msg.you,
          members: msg.members,
          epoch: this.snapshot.epoch + 1,
          clipsAllowed: msg.clipsAllowed === true,
        });
        break;
      case "clips":
        this.set({ clipsAllowed: msg.allowed });
        break;
      case "clip":
        for (const fn of this.clipListeners) fn(msg);
        break;
      case "join":
      case "update":
        this.set({ members: upsert(this.snapshot.members, msg.member) });
        break;
      case "leave":
        this.set({ members: this.snapshot.members.filter((m) => m.id !== msg.id) });
        break;
      case "reply": {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new ServerError(msg.error));
        break;
      }
    }
  }
}

function upsert(members: Member[], member: Member): Member[] {
  const i = members.findIndex((m) => m.id === member.id);
  if (i === -1) return [...members, member];
  const next = members.slice();
  next[i] = member;
  return next;
}
