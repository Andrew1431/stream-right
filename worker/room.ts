import { DurableObject } from "cloudflare:workers";
import {
  CLIP_MAX_SECONDS,
  CloseCode,
  MAX_NAME_LENGTH,
  RIDS,
  type ClientMessage,
  type Member,
  type PullTrack,
  type RoomPeek,
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
// Matches the publisher's sendEncodings: full, half, quarter.
const BROWSER_SCALES = [1, 0.5, 0.25];

// OBS spaces simulcast layers evenly: with 3 layers they are full, 2/3 and 1/3 size.
const obsScales = (n: number) => Array.from({ length: n }, (_, i) => (n - i) / n);

// OBS can vanish without sending DELETE (crash, network loss), so poll the SFU.
const OBS_HEALTH_INTERVAL_MS = 30_000;
const OBS_STARTUP_GRACE_MS = 20_000;
const OBS_KEY_PREFIX = "obskey:";
// Prefix of the key's SHA-256, shared with the room so the key holder can spot their own stream.
const OBS_KEY_ID_LENGTH = 16;

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
  noClips?: boolean;
};

// clientId is the browser that made the token, so renaming there renames the OBS stream too.
type ObsKeyRecord = { name: string; createdAt: number; noClips?: boolean; clientId?: string };
const LAST_NAME_PREFIX = "lastname:";

class BadRequest extends Error {}

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name || "Guest";
}

const isStr = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isSdp = (v: unknown): v is string => isStr(v, MAX_MESSAGE_BYTES);
const isTrackName = (v: unknown): v is TrackName => TRACK_NAMES.includes(v as TrackName);

const toMember = ({ id, name, joinedAt, stream, buffering }: Authed): Member => ({
  id,
  name,
  joinedAt,
  stream,
  ...(buffering ? { buffering } : {}),
});

const obsMember = (s: ObsStream): Member => ({
  id: `obs-${s.resourceId}`,
  name: `${s.name} (OBS)`,
  joinedAt: s.startedAt,
  stream: {
    sessionId: s.sessionId,
    tracks: s.tracks,
    preset: "obs",
    rids: s.rids,
    scales: obsScales(s.rids.length),
    ...(s.noClips ? { noClips: true } : {}),
  },
  obs: true,
  obsKeyId: s.keyHash.slice(0, OBS_KEY_ID_LENGTH),
});

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain", ...headers } });

export class Room extends DurableObject<Env> {
  private obs = new Map<string, ObsStream>();
  private clipsAllowed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const s of (await ctx.storage.get<ObsStream[]>("obsStreams")) ?? []) this.obs.set(s.resourceId, s);
      this.clipsAllowed = (await ctx.storage.get<boolean>("clipsAllowed")) === true;
    });
  }

  // Makes the room, or rotates its link when rotate is set and the caller is the server admin
  // (creator key) or the room's owner. Rooms made before owner keys existed get one on their
  // next admin rotation.
  async issueToken(opts: { rotate: boolean; admin: boolean; ownerKey?: string }): Promise<
    { ok: true; token: string; ownerKey?: string } | { ok: false; reason: "exists" | "forbidden" }
  > {
    const existing = await this.ctx.storage.get<string>("tokenHash");
    if (existing && !opts.rotate) return { ok: false, reason: "exists" };

    const ownerHash = await this.ctx.storage.get<string>("ownerHash");
    if (existing) {
      const isOwner = !!ownerHash && !!opts.ownerKey && (await safeEqual(await sha256Hex(opts.ownerKey), ownerHash));
      if (!opts.admin && !isOwner) return { ok: false, reason: "forbidden" };
    }

    const token = randomToken();
    await this.ctx.storage.put("tokenHash", await sha256Hex(token));
    let ownerKey: string | undefined;
    if (!ownerHash) {
      ownerKey = randomToken();
      await this.ctx.storage.put("ownerHash", await sha256Hex(ownerKey));
    }
    if (existing) {
      for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.TokenRotated, "Invite link was rotated");
      // OBS keys were handed out to holders of the old link; revoke them too.
      const keys = await this.ctx.storage.list({ prefix: OBS_KEY_PREFIX });
      await this.ctx.storage.delete([...keys.keys()]);
      for (const s of [...this.obs.values()]) await this.endObs(s);
    }
    return { ok: true, token, ownerKey };
  }

  async peek(token: string): Promise<RoomPeek> {
    const tokenHash = await this.ctx.storage.get<string>("tokenHash");
    if (!tokenHash || !(await safeEqual(await sha256Hex(token), tokenHash))) return { ok: false };
    const members = this.members();
    return { ok: true, people: members.length, live: members.filter((m) => m.stream).length };
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
    const owner = key ? await this.ctx.storage.get<ObsKeyRecord>(OBS_KEY_PREFIX + keyHash) : undefined;
    if (!owner) return text("Invalid stream key. Get a new one from the room's Stream from OBS panel.", 401);

    if (req.method === "POST" && !resourceId) {
      if (!(req.headers.get("Content-Type") ?? "").includes("application/sdp")) return text("Expected application/sdp", 415);
      const offer = await req.text();
      if (!offer || offer.length > MAX_MESSAGE_BYTES) return text("Bad offer", 400);
      return this.startObs(offer, keyHash, owner, pathname);
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

  private async startObs(offer: string, keyHash: string, owner: ObsKeyRecord, whipPath: string): Promise<Response> {
    const tracks = parseOfferTracks(offer);
    // Simulcast layout differs between encoders; log it so layer mapping can be checked.
    console.log("whip offer", {
      tracks,
      simulcast: offer.match(/^a=(?:simulcast|rid):.*$/gm),
    });
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
      name: owner.name,
      sessionId,
      tracks: published,
      rids: tracks.find((t) => t.trackName === "video")!.rids,
      startedAt: Date.now(),
      noClips: owner.noClips === true,
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

    const name = cleanName(msg.name);
    const lastName = await this.ctx.storage.get<string>(LAST_NAME_PREFIX + clientId);
    if (lastName !== name) await this.ctx.storage.put(LAST_NAME_PREFIX + clientId, name);
    // Tokens made before clientId was recorded fall back to matching this browser's previous name.
    await this.renameObs(name, clientId, (r) => r.clientId === clientId || (!r.clientId && !!lastName && r.name === lastName));

    const member: Authed = {
      authed: true,
      clientId,
      id: crypto.randomUUID(),
      name,
      joinedAt: Date.now(),
      stream: null,
      sessions: [],
    };
    ws.serializeAttachment(member);

    this.send(ws, { type: "welcome", you: member.id, members: this.members(), clipsAllowed: this.clipsAllowed });
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
          const height = Number.isInteger(op.height) && op.height! >= 100 && op.height! <= 8640 ? op.height : undefined;
          const updated = this.patch(ws, {
            stream: {
              sessionId,
              tracks: published,
              preset,
              rids: BROWSER_RIDS,
              scales: BROWSER_SCALES,
              height,
              ...(op.noClips === true ? { noClips: true } : {}),
            },
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

      case "obsKey": {
        // A new token replaces this browser's old ones, the one it says it held, and tokens from
        // before tokens recorded their browser that carry this name. They stop working and any
        // stream using them leaves the room.
        const replaced = isStr(op.replaces) ? await sha256Hex(op.replaces) : null;
        const records = await this.ctx.storage.list<ObsKeyRecord>({ prefix: OBS_KEY_PREFIX });
        const revoked = [...records]
          .filter(([key, r]) => r.clientId === me.clientId || key === OBS_KEY_PREFIX + replaced || (!r.clientId && r.name === me.name))
          .map(([key]) => key);
        if (revoked.length) {
          await this.ctx.storage.delete(revoked);
          for (const s of [...this.obs.values()]) {
            if (revoked.includes(OBS_KEY_PREFIX + s.keyHash)) await this.endObs(s);
          }
        }

        const key = randomToken();
        await this.ctx.storage.put(OBS_KEY_PREFIX + (await sha256Hex(key)), {
          name: me.name,
          createdAt: Date.now(),
          noClips: op.noClips === true,
          clientId: me.clientId,
        } satisfies ObsKeyRecord);
        return { obsKey: key };
      }

      case "revokeObs": {
        if (!(await this.isOwner(op))) throw new BadRequest("Only the room's owner can revoke OBS tokens");
        const keys = await this.ctx.storage.list({ prefix: OBS_KEY_PREFIX });
        await this.ctx.storage.delete([...keys.keys()]);
        for (const s of [...this.obs.values()]) await this.endObs(s);
        return {};
      }

      case "allowClips": {
        if (typeof op.allowed !== "boolean") throw new BadRequest("Bad request");
        if (!(await this.isOwner(op))) throw new BadRequest("Only the room's owner can change clips");
        if (op.allowed !== this.clipsAllowed) {
          this.clipsAllowed = op.allowed;
          await this.ctx.storage.put("clipsAllowed", op.allowed);
          this.broadcast({ type: "clips", allowed: op.allowed });
          // Clients drop their buffers when told; clear the flags too so nobody still shows as buffering.
          if (!op.allowed) {
            for (const other of this.ctx.getWebSockets()) {
              const att = other.deserializeAttachment() as Attachment;
              if (!att.authed || !att.buffering) continue;
              this.broadcast({ type: "update", member: toMember(this.patch(other, { buffering: false })) });
            }
          }
        }
        return {};
      }

      case "buffering": {
        const on = op.on === true;
        if (on && !this.clipsAllowed) throw new BadRequest("Clips are off in this room");
        if (!!me.buffering !== on) this.broadcast({ type: "update", member: toMember(this.patch(ws, { buffering: on })) });
        return {};
      }

      case "clip": {
        if (!this.clipsAllowed) throw new BadRequest("Clips are off in this room");
        if (!me.buffering) throw new BadRequest("Turn on your clip buffer first");
        const seconds = Math.round(Number(op.seconds));
        if (!(seconds >= 1 && seconds <= CLIP_MAX_SECONDS) || !Array.isArray(op.of) || op.of.length === 0) {
          throw new BadRequest("Bad clip");
        }
        // Names come from the room, not the client, so an announcement can't be dressed up.
        const members = this.members();
        const of = [...new Set(op.of)].map((id) => {
          const m = members.find((x) => x.id === id && x.id !== me.id && x.stream && !x.stream.noClips);
          if (!m) throw new BadRequest("That stream can't be clipped");
          return m.name;
        });
        this.broadcast({ type: "clip", by: me.id, name: me.name, seconds, of });
        return {};
      }

      // Proves ownership of an OBS token (from another browser, say) and puts this name on it.
      case "claimObs": {
        if (!isStr(op.obsKey)) throw new BadRequest("Bad request");
        const keyHash = await sha256Hex(op.obsKey);
        await this.renameObs(me.name, me.clientId, (_, hash) => hash === keyHash);
        return {};
      }

      case "clipPrefs": {
        const noClips = op.noClips === true;
        if (me.stream && !!me.stream.noClips !== noClips) {
          const { noClips: _, ...stream } = me.stream;
          const updated = this.patch(ws, { stream: noClips ? { ...stream, noClips } : stream });
          this.broadcast({ type: "update", member: toMember(updated) });
        }
        if (isStr(op.obsKey)) {
          const keyHash = await sha256Hex(op.obsKey);
          const record = await this.ctx.storage.get<ObsKeyRecord>(OBS_KEY_PREFIX + keyHash);
          if (record) await this.ctx.storage.put(OBS_KEY_PREFIX + keyHash, { ...record, noClips });
          for (const s of this.obs.values()) {
            if (s.keyHash !== keyHash || !!s.noClips === noClips) continue;
            s.noClips = noClips;
            await this.saveObs();
            this.broadcast({ type: "update", member: obsMember(s) });
          }
        }
        return {};
      }

      default:
        throw new BadRequest("Unknown op");
    }
  }

  private async renameObs(name: string, clientId: string, matches: (r: ObsKeyRecord, keyHash: string) => boolean) {
    const records = await this.ctx.storage.list<ObsKeyRecord>({ prefix: OBS_KEY_PREFIX });
    const renamed: ObsStream[] = [];
    for (const [key, record] of records) {
      const keyHash = key.slice(OBS_KEY_PREFIX.length);
      if (!matches(record, keyHash) || (record.name === name && record.clientId === clientId)) continue;
      await this.ctx.storage.put(key, { ...record, name, clientId });
      for (const s of this.obs.values()) {
        if (s.keyHash === keyHash && s.name !== name) {
          s.name = name;
          renamed.push(s);
        }
      }
    }
    if (!renamed.length) return;
    await this.saveObs();
    for (const s of renamed) this.broadcast({ type: "update", member: obsMember(s) });
  }

  // Same proof as link rotation: the server's creator key, or the owner key handed out at creation.
  private async isOwner(op: { ownerKey?: unknown; creatorKey?: unknown }): Promise<boolean> {
    if (isStr(op.creatorKey) && this.env.CREATOR_KEY && (await safeEqual(op.creatorKey, this.env.CREATOR_KEY))) return true;
    const ownerHash = await this.ctx.storage.get<string>("ownerHash");
    return !!ownerHash && isStr(op.ownerKey) && (await safeEqual(await sha256Hex(op.ownerKey), ownerHash));
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
