import { invoke } from "@tauri-apps/api/core";
import type { CreateRoomResponse, UsageResponse } from "../../shared/protocol";
import { inShell } from "./native";
import type { Room, Server } from "./servers";

// Owner requests: make a room, rotate a link, read usage. The servers allow these from their own
// pages only, so the Rust core sends them (server_request in src-tauri/src/admin.rs), and only
// ever to the server the creator key was saved for.

type Reply = { status: number; body: unknown };

export class OwnerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function send(server: Server, path: "/api/rooms" | "/api/usage", body?: unknown): Promise<unknown> {
  if (!inShell) throw new OwnerError("Owner tools need the desktop app; a browser can't reach other servers' admin endpoints.", 0);
  const reply = await invoke<Reply>("server_request", {
    origin: server.origin,
    path,
    creatorKey: server.creatorKey ?? null,
    body: body ?? null,
  }).catch((e) => {
    throw new OwnerError(String(e), 0);
  });
  if (reply.status >= 200 && reply.status < 300) return reply.body;
  const said = (reply.body as { error?: unknown } | null)?.error;
  const host = new URL(server.origin).host;
  if (reply.status === 401) throw new OwnerError(`${host} didn't accept the creator key. Check it in the server settings.`, 401);
  throw new OwnerError(typeof said === "string" ? said : `${host} answered ${reply.status}`, reply.status);
}

// A new room. Fails with status 409 when the name is taken.
export async function createRoom(server: Server, name: string): Promise<Room> {
  const r = (await send(server, "/api/rooms", { name })) as CreateRoomResponse;
  return { id: r.roomId, token: r.token, ownerKey: r.ownerKey };
}

// A new link for a room; the old one stops working and everyone in it is disconnected. Works with
// the room's owner key or the server's creator key.
export async function rotateRoom(server: Server, room: Pick<Room, "id" | "ownerKey">): Promise<Room> {
  const r = (await send(server, "/api/rooms", { name: room.id, rotate: true, ownerKey: room.ownerKey })) as CreateRoomResponse;
  return { id: r.roomId, token: r.token, ownerKey: r.ownerKey ?? room.ownerKey };
}

export async function fetchUsage(server: Server): Promise<UsageResponse> {
  return (await send(server, "/api/usage")) as UsageResponse;
}
