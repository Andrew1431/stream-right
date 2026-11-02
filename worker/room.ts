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
  type Stream,
  type TrackName,
} from "../shared/protocol";
import { randomToken, safeEqual, sha256Hex } from "./crypto";
import { parseOfferTracks } from "./sdp";
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
const BROWSER_RIDS = [...RIDS];

// OBS can vanish without sending DELETE (crash, network loss), so poll the SFU.
const OBS_HEALTH_INTERVAL_MS = 30_000;
const OBS_STARTUP_GRACE_MS = 20_000;
const OBS_KEY_PREFIX = "obskey:";

type Authed = { authed: true; clientId: string; sessions: string[] } & Member;
type Attachment = { authed: false; connectedAt: number } | Authed;

type ObsStream = {
  resourceId: string;
  keyHash: string;
  name: string;
  sessionId: string;
  tracks: TrackName[];
  rids: string[];
  startedAt: number;
};

class BadRequest extends Error {}

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name || "Guest";
}

const isStr = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isSdp = (v: unknown): v is string => isStr(v, MAX_MESSAGE_BYTES);
const isTrackName = (v: unknown): v is TrackName => TRACK_NAMES.includes(v as TrackName);

const toMember = ({ id, name, joinedAt, stream }: Authed): Member => ({ id, name, joinedAt, stream });

const obsMember = (s: ObsStream): Member => ({
  id: `obs-${s.resourceId}`,
  name: `${s.name} (OBS)`,
  joinedAt: s.startedAt,
  stream: { sessionId: s.sessionId, tracks: s.tracks, preset: "obs", rids: s.rids },
  obs: true,
});

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain", ...headers } });

export class Room extends DurableObject<Env> {
  private obs = new Map<string, ObsStream>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const s of (await ctx.storage.get<ObsStream[]>("obsStreams")) ?? []) this.obs.set(s.resourceId, s);
    });
  }

  // Returns the new invite token, or null when the room exists and rotate is false.
  async issueToken(rotate: boolean): Promise<string | null> {
    const existing = await this.ctx.storage.get<string>("tokenHash");
    if (existing && !rotate) return null;

    const token = randomToken();
    await this.ctx.storage.put("tokenHash", await sha256Hex(token));
    if (existing) {
      for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.TokenRotated, "Invite link was rotated");
      // OBS keys were handed out to holders of the old link; revoke them too.
      const keys = await this.ctx.storage.list({ prefix: OBS_KEY_PREFIX });
      await this.ctx.storage.delete([...keys.keys()]);
      for (const s of [...this.obs.values()]) await this.endObs(s);
    }
    return token;
  }

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname.endsWith("/ws")) return this.acceptSocket();
    return this.whip(req, pathname);
  }

  private async acceptSocket(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authed: false, connectedAt: Date.now() } satisfies Attachment);
    await this.scheduleAlarm(HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  // WHIP (RFC 9725): POST an SDP offer to start, DELETE the returned Location to stop.
  private async whip(req: Request, pathname: string): Promise<Response> {
    const match = pathname.match(/\/whip(?:\/([0-9a-f-]{36}))?$/);
    if (!match) return text("Not found", 404);
    const resourceId = match[1];

    const key = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const keyHash = await sha256Hex(key);
    const owner = key ? await this.ctx.storage.get<{ name: string }>(OBS_KEY_PREFIX + keyHash) : undefined;
    if (!owner) return text("Invalid stream key. Get a new one from the room's Stream from OBS panel.", 401);

    if (req.method === "POST" && !resourceId) {
      if (!(req.headers.get("Content-Type") ?? "").includes("application/sdp")) return text("Expected application/sdp", 415);
      const offer = await req.text();
      if (!offer || offer.length > MAX_MESSAGE_BYTES) return text("Bad offer", 400);
      return this.startObs(offer, keyHash, owner.name, pathname);
    }

    const stream = resourceId ? this.obs.get(resourceId) : undefined;
    if (!stream || stream.keyHash !== keyHash) return text("Not found", 404);

    if (req.method === "DELETE") {
      await this.endObs(stream);
      return new Response(null, { status: 200 });
    }
    // No trickle ICE: the SFU answer already carries its candidates.
    return text("Method not allowed", 405, { Allow: "POST, DELETE" });
  }

  private async startObs(offer: string, keyHash: string, name: string, whipPath: string): Promise<Response> {
    const tracks = parseOfferTracks(offer);
    if (!tracks.some((t) => t.trackName === "video")) return text("Offer has no video", 400);

    let answer: string;
    let published: TrackName[];
    let sessionId: string;
    try {
      const session = await sfu(this.env, "POST", "/sessions/new");
      sessionId = session.sessionId!;
      const res = await sfu(this.env, "POST", `/sessions/${sessionId}/tracks/new`, {
        sessionDescription: { type: "offer", sdp: offer },
        tracks: tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.trackName })),
      });
      published = (res.tracks ?? []).filter((t) => !t.errorCode && isTrackName(t.trackName)).map((t) => t.trackName as TrackName);
      if (!published.includes("video") || !res.sessionDescription) throw new SfuError("SFU rejected the video track");
      answer = res.sessionDescription.sdp;
    } catch (e) {
      console.error("whip publish failed", e);
      return text(e instanceof SfuError ? e.message : "Server error", 502);
    }

    // Restarting the stream in OBS replaces the previous one from the same key.
    for (const s of [...this.obs.values()]) if (s.keyHash === keyHash) await this.endObs(s);

    const stream: ObsStream = {
      resourceId: crypto.randomUUID(),
      keyHash,
      name,
      sessionId,
      tracks: published,
      rids: tracks.find((t) => t.trackName === "video")!.rids,
      startedAt: Date.now(),
    };
    this.obs.set(stream.resourceId, stream);
    await this.saveObs();
    await this.scheduleAlarm(OBS_HEALTH_INTERVAL_MS);
    this.broadcast({ type: "join", member: obsMember(stream) });

    return new Response(answer, {
      status: 201,
      headers: {
        "Content-Type": "application/sdp",
        Location: `${whipPath}/${stream.resourceId}`,
        Link: '<stun:stun.cloudflare.com:3478>; rel="ice-server"',
      },
    });
  }

  private async endObs(stream: ObsStream): Promise<void> {
    if (!this.obs.delete(stream.resourceId)) return;
    await this.saveObs();
    this.broadcast({ type: "leave", id: obsMember(stream).id });
  }

  private saveObs() {
    return this.ctx.storage.put("obsStreams", [...this.obs.values()]);
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
          const preset = PRESET_PATTERN.test(String(op.preset)) ? op.preset : "custom";
          const updated = this.patch(ws, { stream: { sessionId, tracks: published, preset, rids: BROWSER_RIDS } });
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

      case "obsKey": {
        const key = randomToken();
        await this.ctx.storage.put(OBS_KEY_PREFIX + (await sha256Hex(key)), { name: me.name, createdAt: Date.now() });
        return { obsKey: key };
      }

      default:
        throw new BadRequest("Unknown op");
    }
  }

  // Only tracks currently published by someone in this room can be pulled.
  private remoteTrack(t: PullTrack) {
    if (!isStr(t?.sessionId) || !isTrackName(t.trackName)) throw new BadRequest("Bad track");
    const stream = this.members().find(
      (m) => m.stream?.sessionId === t.sessionId && m.stream.tracks.includes(t.trackName),
    )?.stream;
    if (!stream) throw new BadRequest("That stream isn't live");

    const base = { location: "remote", sessionId: t.sessionId, trackName: t.trackName };
    const rid = publisherRid(stream, t.rid);
    if (t.trackName !== "video" || !rid) return base;
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

  // One alarm serves both jobs: closing sockets that never said hello, and checking OBS streams.
  async alarm(): Promise<void> {
    const cutoff = Date.now() - HELLO_TIMEOUT_MS;
    let pendingHello = false;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.authed) continue;
      if (att.connectedAt <= cutoff) ws.close(CloseCode.HelloTimeout, "Hello timeout");
      else pendingHello = true;
    }

    for (const s of [...this.obs.values()]) {
      if (Date.now() - s.startedAt < OBS_STARTUP_GRACE_MS) continue;
      if (!(await this.obsAlive(s))) await this.endObs(s);
    }

    if (pendingHello) await this.scheduleAlarm(HELLO_TIMEOUT_MS);
    else if (this.obs.size) await this.scheduleAlarm(OBS_HEALTH_INTERVAL_MS);
  }

  private async obsAlive(s: ObsStream): Promise<boolean> {
    try {
      const res = await sfu(this.env, "GET", `/sessions/${s.sessionId}`);
      return (res.tracks ?? []).some((t) => t.status === "active");
    } catch (e) {
      // Only drop the stream when the SFU answered; a network blip shouldn't end it.
      return !(e instanceof SfuError);
    }
  }

  // Moves the alarm earlier if needed, never later.
  private async scheduleAlarm(inMs: number): Promise<void> {
    const at = Date.now() + inMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
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
    const out: Member[] = [...this.obs.values()].map(obsMember);
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

// Map the viewer's logical layer (f/h/q) onto the publisher's own RIDs, best first.
// Returns undefined for single-layer publishers, which must be pulled without simulcast.
function publisherRid(stream: Stream, logical: PullTrack["rid"]): string | undefined {
  const rids = stream.rids ?? BROWSER_RIDS;
  if (!rids.length) return undefined;
  const index = Math.max(0, RIDS.indexOf(logical ?? "f"));
  return rids[Math.min(index, rids.length - 1)];
}
