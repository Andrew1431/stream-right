import { inviteLink, load, save } from "./storage";

// Rooms this browser has joined, newest first, so the installed app can reopen them without a link.
export type RecentRoom = { roomId: string; link: string; visitedAt: number };

const KEY = "recentRooms";
const MAX = 12;

export const loadRecent = () => load<RecentRoom[]>(KEY, []);

export function rememberRoom(roomId: string, token: string) {
  const room = { roomId, link: inviteLink(roomId, token), visitedAt: Date.now() };
  save(KEY, [room, ...loadRecent().filter((r) => r.roomId !== roomId)].slice(0, MAX));
}

export function forgetRecent(roomId: string) {
  save(KEY, loadRecent().filter((r) => r.roomId !== roomId));
}
