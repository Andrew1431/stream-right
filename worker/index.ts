import {
  ROOM_ID_PATTERN,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type RoomPeek,
} from "../shared/protocol";
import { safeEqual } from "./crypto";
import { getUsage } from "./usage";

export { Room } from "./room";

const json = (body: unknown, status = 200) => Response.json(body, { status });

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const key = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  return !!key && !!env.CREATOR_KEY && (await safeEqual(key, env.CREATOR_KEY));
}

async function createRoom(req: Request, env: Env): Promise<Response> {
  let body: CreateRoomRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const admin = await isAdmin(req, env);
  const rotate = body.rotate === true;
  // Rotation is checked by the room itself: admin or the room's owner key.
  if (!admin && !rotate) return json({ error: "Invalid creator key" }, 401);

  const roomId = slugify(String(body.name ?? ""));
  if (!ROOM_ID_PATTERN.test(roomId)) return json({ error: "Room name needs letters or numbers" }, 400);

  const ownerKey = typeof body.ownerKey === "string" ? body.ownerKey.slice(0, 128) : undefined;
  const result = await env.ROOMS.getByName(roomId).issueToken({ rotate, admin, ownerKey });
  if (!result.ok) {
    return result.reason === "exists"
      ? json({ error: "That room name is taken. Pick another, or rotate its link if it's yours." }, 409)
      : json({ error: "Only the room's creator can rotate its link." }, 403);
  }

  return json({ roomId, token: result.token, ownerKey: result.ownerKey } satisfies CreateRoomResponse, 201);
}

// What a chat app shows for an invite link. The room's token is in the URL fragment, which link
// previews never send, so this can't say whether the room is live and says nothing private.
function withLinkPreview(page: Response, room: string, url: URL, ua: string): Response {
  const tags = [
    ["og:site_name", "stream"],
    ["og:type", "website"],
    ["og:title", `View streams in #${room}`],
    ["og:description", "Friends streaming their screens. Click to watch."],
    ["og:image", `${url.origin}/og.png`],
    ["og:image:width", "1200"],
    ["og:image:height", "630"],
  ].map(([property, content]) => `<meta property="${property}" content="${content}" />`);
  tags.push(`<meta name="twitter:card" content="summary_large_image" />`);

  const rewriter = new HTMLRewriter().on("head", {
    element: (head) => void head.append(tags.join(""), { html: true }),
  });
  // Discord colours the embed's edge from theme-color; browsers would tint their toolbar with it.
  if (ua.includes("Discordbot")) {
    rewriter.on('meta[name="theme-color"]', {
      element: (meta) => void meta.setAttribute("content", "#ff5a4e"),
    });
  }
  return rewriter.transform(page);
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname.startsWith("/r/")) {
      const page = await env.ASSETS.fetch(new URL("/", url));
      const room = pathname.match(/^\/r\/([^/]+)\/?$/)?.[1];
      return room && ROOM_ID_PATTERN.test(room) ? withLinkPreview(page, room, url, req.headers.get("User-Agent") ?? "") : page;
    }

    if (pathname === "/api/usage") {
      if (!(await isAdmin(req, env))) return json({ error: "Invalid creator key" }, 401);
      return json(await getUsage(env));
    }

    if (pathname === "/api/rooms") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return createRoom(req, env);
    }

    const peek = pathname.match(/^\/api\/rooms\/([^/]+)\/peek$/);
    if (peek) {
      // Open to any origin so the desktop app can show live status for rooms on every server it
      // holds links for. The token is the credential, and the answer is just two counts.
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" };
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST" } });
      if (req.method !== "POST" || !ROOM_ID_PATTERN.test(peek[1])) return json({ error: "Not found" }, 404);
      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      const result: RoomPeek =
        typeof body.token === "string" && body.token ? await env.ROOMS.getByName(peek[1]).peek(body.token.slice(0, 128)) : { ok: false };
      return Response.json(result, { headers: cors });
    }

    const ws = pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (ws) {
      if (!ROOM_ID_PATTERN.test(ws[1])) return json({ error: "Not found" }, 404);
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "Expected WebSocket" }, 426);
      return env.ROOMS.getByName(ws[1]).fetch(req);
    }

    const whip = pathname.match(/^\/api\/rooms\/([^/]+)\/whip(?:\/[^/]+)?$/);
    if (whip) {
      if (!ROOM_ID_PATTERN.test(whip[1])) return json({ error: "Not found" }, 404);
      return env.ROOMS.getByName(whip[1]).fetch(req);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
