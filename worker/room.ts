import { DurableObject } from "cloudflare:workers";
import {
  CloseCode,
  MAX_NAME_LENGTH,
  RIDS,
  type ClientMessage,
  type Member,
  type PullTrack,
  type ServerMessage,
  type SfuOp,
  type SfuResponse,
  type TrackName,
} from "../shared/protocol";
import { randomToken, safeEqual, sha256Hex } from "./crypto";
import { sfu, SfuError } from "./sfu";

const HELLO_TIMEOUT_MS = 5_000;
const MAX_HELLO_BYTES = 4_096;
const MAX_MESSAGE_BYTES = 128 * 1024;
// Oldest sessions roll off; the subscriber makes a new one each time it resets.
const MAX_SESSIONS_PER_MEMBER = 8;
const MAX_PULL_TRACKS = 32;
const TRACK_NAMES: readonly TrackName[] = ["video", "audio"];
// Display-only label from the sharer, e.g. "1080p100" or "source60".
const PRESET_PATTERN = /^(?:\d{3,4}p|source)\d{2,3}$/;

type Authed = { authed: true; clientId: string; sessions: string[] } & Member;
type Attachment = { authed: false; connectedAt: number } | Authed;

class BadRequest extends Error {}

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name || "Guest";
}

const isStr = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isSdp = (v: unknown): v is string => isStr(v, MAX_MESSAGE_BYTES);
const isTrackName = (v: unknown): v is TrackName => TRACK_NAMES.includes(v as TrackName);

const toMember = ({ id, name, joinedAt, stream }: Authed): Member => ({ id, name, joinedAt, stream });

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
    const att = ws.deserializeAttachment() as Attachment;
    const limit = att.authed ? MAX_MESSAGE_BYTES : MAX_HELLO_BYTES;
    if (typeof data !== "string" || data.length > limit) {
      return ws.close(CloseCode.BadMessage, "Bad message");
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return ws.close(CloseCode.BadMessage, "Bad message");
    }

    if (!att.authed) return this.hello(ws, msg);
    if (msg.type !== "sfu" || typeof msg.id !== "number") return;

    try {
      const result = await this.handleSfu(ws, msg);
      this.send(ws, { type: "reply", id: msg.id, ok: true, data: result });
    } catch (e) {
      const known = e instanceof BadRequest || e instanceof SfuError;
      if (!known) console.error("sfu op failed", msg.op, e);
      this.send(ws, { type: "reply", id: msg.id, ok: false, error: known ? e.message : "Server error" });
    }
  }

  private async hello(ws: WebSocket, msg: ClientMessage): Promise<void> {
    if (msg.type !== "hello") return ws.close(CloseCode.BadMessage, "Expected hello");

    const tokenHash = await this.ctx.storage.get<string>("tokenHash");
    if (!tokenHash) return ws.close(CloseCode.NotFound, "Room not found");
    if (!(await safeEqual(await sha256Hex(String(msg.token ?? "")), tokenHash))) {
      return ws.close(CloseCode.BadToken, "Invalid invite link");
    }

    // A tab that reconnects (reload, back/forward) replaces its old socket, which may
    // not have sent a close frame yet and would otherwise linger as a duplicate member.
    const clientId = isStr(msg.clientId, 64) ? msg.clientId : crypto.randomUUID();
    for (const other of this.ctx.getWebSockets()) {
      const att = other.deserializeAttachment() as Attachment;
      if (other !== ws && att.authed && att.clientId === clientId) {
        this.leave(other);
        other.close(CloseCode.Replaced, "Replaced by a newer connection");
      }
    }

    const member: Authed = {
      authed: true,
      clientId,
      id: crypto.randomUUID(),
      name: cleanName(msg.name),
      joinedAt: Date.now(),
      stream: null,
      sessions: [],
    };
    ws.serializeAttachment(member);

    this.send(ws, { type: "welcome", you: member.id, members: this.members() });
    this.broadcast({ type: "join", member: toMember(member) }, ws);
  }

  private async handleSfu(ws: WebSocket, op: SfuOp): Promise<SfuResponse> {
    const me = ws.deserializeAttachment() as Authed;
    const own = (sessionId: unknown): string => {
      if (!isStr(sessionId) || !me.sessions.includes(sessionId)) throw new BadRequest("Unknown session");
      return sessionId;
    };

    switch (op.op) {
      case "newSession": {
        const res = await sfu(this.env, "POST", "/sessions/new");
        if (!res.sessionId) throw new SfuError("SFU did not return a session");
        // Re-read: other messages may have updated the attachment while we awaited.
        const { sessions } = ws.deserializeAttachment() as Authed;
        this.patch(ws, { sessions: [...sessions, res.sessionId].slice(-MAX_SESSIONS_PER_MEMBER) });
        return { sessionId: res.sessionId };
      }

      case "publish": {
        const sessionId = own(op.sessionId);
        if (!isSdp(op.sdp) || !Array.isArray(op.tracks) || op.tracks.length === 0 || op.tracks.length > 2) {
          throw new BadRequest("Bad publish request");
        }
        for (const t of op.tracks) {
          if (!isStr(t?.mid, 16) || !isTrackName(t.trackName)) throw new BadRequest("Bad track");
        }
        const res = await sfu(this.env, "POST", `/sessions/${sessionId}/tracks/new`, {
          sessionDescription: { type: "offer", sdp: op.sdp },
          tracks: op.tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.trackName })),
        });

        const published = (res.tracks ?? [])
          .filter((t) => !t.errorCode && isTrackName(t.trackName))
          .map((t) => t.trackName as TrackName);
        if (published.includes("video")) {
          const updated = this.patch(ws, {
            stream: { sessionId, tracks: published, preset: PRESET_PATTERN.test(String(op.preset)) ? op.preset : "custom" },
          });
          this.broadcast({ type: "update", member: toMember(updated) });
        }
        return res;
      }

      case "unpublish": {
        if (me.stream?.sessionId === op.sessionId) {
          const updated = this.patch(ws, { stream: null });
          this.broadcast({ type: "update", member: toMember(updated) });
        }
        return {};
      }

      case "pull": {
        const sessionId = own(op.sessionId);
        if (!Array.isArray(op.tracks) || op.tracks.length === 0 || op.tracks.length > MAX_PULL_TRACKS) {
          throw new BadRequest("Bad pull request");
        }
        return sfu(this.env, "POST", `/sessions/${sessionId}/tracks/new`, {
          tracks: op.tracks.map((t) => this.remoteTrack(t)),
        });
      }

      case "setLayer": {
        const sessionId = own(op.sessionId);
        if (!isStr(op.mid, 16)) throw new BadRequest("Bad mid");
        return sfu(this.env, "PUT", `/sessions/${sessionId}/tracks/update`, {
          tracks: [{ ...this.remoteTrack(op.track), mid: op.mid }],
        });
      }

      case "renegotiate": {
        const sessionId = own(op.sessionId);
        if (!isSdp(op.sdp)) throw new BadRequest("Bad SDP");
        return sfu(this.env, "PUT", `/sessions/${sessionId}/renegotiate`, {
          sessionDescription: { type: "answer", sdp: op.sdp },
        });
      }

      case "close": {
        const sessionId = own(op.sessionId);
        if (!Array.isArray(op.mids) || op.mids.length === 0 || !op.mids.every((m) => isStr(m, 16))) {
          throw new BadRequest("Bad close request");
        }
        if (op.sdp !== undefined && !isSdp(op.sdp)) throw new BadRequest("Bad SDP");
        return sfu(this.env, "PUT", `/sessions/${sessionId}/tracks/close`, {
          tracks: op.mids.map((mid) => ({ mid })),
          ...(op.sdp ? { sessionDescription: { type: "offer", sdp: op.sdp }, force: false } : { force: true }),
        });
      }

      default:
        throw new BadRequest("Unknown op");
    }
  }

  // Only tracks currently published by someone in this room can be pulled.
  private remoteTrack(t: PullTrack) {
    if (!isStr(t?.sessionId) || !isTrackName(t.trackName)) throw new BadRequest("Bad track");
    const published = this.members().some(
      (m) => m.stream?.sessionId === t.sessionId && m.stream.tracks.includes(t.trackName),
    );
    if (!published) throw new BadRequest("That stream isn't live");

    const base = { location: "remote", sessionId: t.sessionId, trackName: t.trackName };
    if (t.trackName !== "video") return base;
    const rid = RIDS.includes(t.rid as never) ? t.rid : "f";
    // Fixed: hold the chosen layer even when bandwidth is short. Auto: let the SFU step down.
    const priorityOrdering = t.fixed === true ? "none" : "asciibetical";
    return { ...base, simulcast: { preferredRid: rid, priorityOrdering, ridNotAvailable: "asciibetical" } };
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

  private patch(ws: WebSocket, changes: Partial<Authed>): Authed {
    const next = { ...(ws.deserializeAttachment() as Authed), ...changes };
    ws.serializeAttachment(next);
    return next;
  }

  private leave(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.authed) return;
    ws.serializeAttachment({ authed: false, connectedAt: 0 } satisfies Attachment);
    this.broadcast({ type: "leave", id: att.id }, ws);
  }

  private members(): Member[] {
    const out: Member[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.authed) out.push(toMember(att));
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
