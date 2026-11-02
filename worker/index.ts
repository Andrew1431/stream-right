import { ROOM_ID_PATTERN, type CreateRoomRequest, type CreateRoomResponse } from "../shared/protocol";
import { safeEqual } from "./crypto";

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

async function createRoom(req: Request, env: Env): Promise<Response> {
  const key = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.CREATOR_KEY || !(await safeEqual(key, env.CREATOR_KEY))) {
    return json({ error: "Invalid creator key" }, 401);
  }

  let body: CreateRoomRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const roomId = slugify(String(body.name ?? ""));
  if (!ROOM_ID_PATTERN.test(roomId)) return json({ error: "Room name needs letters or numbers" }, 400);

  const token = await env.ROOMS.getByName(roomId).issueToken(body.rotate === true);
  if (!token) return json({ error: "Room already exists. Rotate its link to get a new one." }, 409);

  return json({ roomId, token } satisfies CreateRoomResponse, 201);
}

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/api/rooms") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return createRoom(req, env);
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
