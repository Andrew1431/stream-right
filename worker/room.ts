import { DurableObject } from "cloudflare:workers";
import {
  CloseCode,
  MAX_NAME_LENGTH,
  type ClientMessage,
  type Member,
  type ServerMessage,
} from "../shared/protocol";
import { randomToken, safeEqual, sha256Hex } from "./crypto";

const HELLO_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_BYTES = 4_096;

type Attachment = { authed: false; connectedAt: number } | ({ authed: true } & Member);

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name || "Guest";
}

export class Room extends DurableObject<Env> {
  // Returns the new invite token, or null when the room exists and rotate is false.
  async issueToken(rotate: boolean): Promise<string | null> {
    const existing = await this.ctx.storage.get<string>("tokenHash");
    if (existing && !rotate) return null;

    const token = randomToken();
    await this.ctx.storage.put("tokenHash", await sha256Hex(token));
    if (existing) {
      for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.TokenRotated, "Invite link was rotated");
    }
    return token;
  }

  async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authed: false, connectedAt: Date.now() } satisfies Attachment);

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) {
      return ws.close(CloseCode.BadMessage, "Bad message");
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return ws.close(CloseCode.BadMessage, "Bad message");
    }

    const att = ws.deserializeAttachment() as Attachment;
    if (!att.authed) return this.hello(ws, msg);
  }

  private async hello(ws: WebSocket, msg: ClientMessage): Promise<void> {
    if (msg.type !== "hello") return ws.close(CloseCode.BadMessage, "Expected hello");

    const tokenHash = await this.ctx.storage.get<string>("tokenHash");
    if (!tokenHash) return ws.close(CloseCode.NotFound, "Room not found");
    if (!(await safeEqual(await sha256Hex(String(msg.token ?? "")), tokenHash))) {
      return ws.close(CloseCode.BadToken, "Invalid invite link");
    }

    const member: Member = { id: crypto.randomUUID(), name: cleanName(msg.name), joinedAt: Date.now() };
    ws.serializeAttachment({ authed: true, ...member } satisfies Attachment);

    this.send(ws, { type: "welcome", you: member.id, members: this.members() });
    this.broadcast({ type: "join", member }, ws);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.leave(ws);
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - HELLO_TIMEOUT_MS;
    let pending = false;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.authed) continue;
      if (att.connectedAt <= cutoff) ws.close(CloseCode.HelloTimeout, "Hello timeout");
      else pending = true;
    }
    if (pending) await this.ctx.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
  }

  private leave(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.authed) this.broadcast({ type: "leave", id: att.id }, ws);
  }

  private members(): Member[] {
    const out: Member[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.authed) out.push({ id: att.id, name: att.name, joinedAt: att.joinedAt });
    }
    return out.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket is closing; its own close handler will clean up.
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      if ((ws.deserializeAttachment() as Attachment).authed) this.send(ws, msg);
    }
  }
}
