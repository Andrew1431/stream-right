// Every stream instance and room this app holds an invite for. An instance is just an
// origin; its rooms are the "channels".

// ownerKey is kept for rooms this app made, so their links can be rotated without the creator key.
export type Room = { id: string; token: string; ownerKey?: string };
// creatorKey is this server's room-creation password, if you hold it; the app hands it to the
// server's room pages so they show usage and owner controls.
export type Server = { origin: string; rooms: Room[]; creatorKey?: string };

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
    // Plain http would send the token in the clear, so only a machine's own address may use it.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!id || !token || !(url.protocol === "https:" || (url.protocol === "http:" && local))) return null;
    return { origin: url.origin, room: { id: decodeURIComponent(id), token } };
  } catch {
    return null;
  }
}

export function addInvite(servers: Server[], invite: { origin: string; room: Room }): Server[] {
  const existing = servers.find((s) => s.origin === invite.origin);
  if (!existing) return [...servers, { origin: invite.origin, rooms: [invite.room] }];
  // A room already held keeps its place and its other fields (the owner key); only the token is new.
  if (existing.rooms.some((r) => r.id === invite.room.id)) {
    const rooms = existing.rooms.map((r) => (r.id === invite.room.id ? { ...r, token: invite.room.token } : r));
    return servers.map((s) => (s === existing ? { ...s, rooms } : s));
  }
  return servers.map((s) => (s === existing ? { ...s, rooms: [...existing.rooms, invite.room] } : s));
}

// Swaps in a room's new link (after a rotation) where it was, or adds it if it's new.
export function putRoom(servers: Server[], origin: string, room: Room): Server[] {
  const existing = servers.find((s) => s.origin === origin);
  if (!existing?.rooms.some((r) => r.id === room.id)) return addInvite(servers, { origin, room });
  return servers.map((s) => (s === existing ? { ...s, rooms: s.rooms.map((r) => (r.id === room.id ? room : r)) } : s));
}

export function removeRoom(servers: Server[], origin: string, id: string): Server[] {
  return servers
    .map((s) => (s.origin === origin ? { ...s, rooms: s.rooms.filter((r) => r.id !== id) } : s))
    .filter((s) => s.rooms.length);
}

export const serverLabel = (origin: string) => new URL(origin).hostname.replace(/^stream\./, "");
// embed=desktop switches the room into its desktop layout and the bridge in src/desktop.ts.
export const roomUrl = (origin: string, room: Room) =>
  `${origin}/r/${encodeURIComponent(room.id)}?embed=desktop#k=${room.token}`;

// The link to send people; the same shape the web app's Copy link gives.
export const inviteLink = (origin: string, room: Room) => `${origin}/r/${encodeURIComponent(room.id)}#k=${room.token}`;

export function setCreatorKey(servers: Server[], origin: string, creatorKey: string): Server[] {
  return servers.map((s) => (s.origin === origin ? { ...s, creatorKey: creatorKey || undefined } : s));
}

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
