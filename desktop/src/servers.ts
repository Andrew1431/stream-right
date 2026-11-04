// Every stream instance and room this app holds an invite for. An instance is just an
// origin; its rooms are the "channels".

export type Room = { id: string; token: string };
export type Server = { origin: string; rooms: Room[] };

const STORE = "servers";

export function loadServers(): Server[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]") as Server[];
  } catch {
    return [];
  }
}

export function saveServers(servers: Server[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(servers));
  } catch {
    // The app still works for this session.
  }
}

// https://host/r/<room>#k=<token> → its parts, or null if it isn't an invite link.
export function parseInvite(text: string): { origin: string; room: Room } | null {
  try {
    const url = new URL(text.trim());
    const id = url.pathname.match(/^\/r\/([^/]+)\/?$/)?.[1];
    const token = new URLSearchParams(url.hash.slice(1)).get("k");
    if (!id || !token || !/^https?:$/.test(url.protocol)) return null;
    return { origin: url.origin, room: { id: decodeURIComponent(id), token } };
  } catch {
    return null;
  }
}

export function addInvite(servers: Server[], invite: { origin: string; room: Room }): Server[] {
  const existing = servers.find((s) => s.origin === invite.origin);
  if (!existing) return [...servers, { origin: invite.origin, rooms: [invite.room] }];
  const rooms = existing.rooms.filter((r) => r.id !== invite.room.id);
  return servers.map((s) => (s === existing ? { ...s, rooms: [...rooms, invite.room] } : s));
}

export function removeRoom(servers: Server[], origin: string, id: string): Server[] {
  return servers
    .map((s) => (s.origin === origin ? { ...s, rooms: s.rooms.filter((r) => r.id !== id) } : s))
    .filter((s) => s.rooms.length);
}

export const serverLabel = (origin: string) => new URL(origin).hostname.replace(/^stream\./, "");
export const roomUrl = (origin: string, room: Room) => `${origin}/r/${encodeURIComponent(room.id)}#k=${room.token}`;

export type Peek = { ok: false } | { ok: true; people: number; live: number };

// Live status from the instance's peek endpoint; null when it can't be reached.
export async function peek(origin: string, room: Room): Promise<Peek | null> {
  try {
    const res = await fetch(`${origin}/api/rooms/${encodeURIComponent(room.id)}/peek`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: room.token }),
    });
    return res.ok ? ((await res.json()) as Peek) : null;
  } catch {
    return null;
  }
}
