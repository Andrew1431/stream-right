export const ROOM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const MAX_NAME_LENGTH = 32;

export type Member = {
  id: string;
  name: string;
  joinedAt: number;
};

export type ClientMessage = { type: "hello"; token: string; name: string };

export type ServerMessage =
  | { type: "welcome"; you: string; members: Member[] }
  | { type: "join"; member: Member }
  | { type: "leave"; id: string };

// WebSocket close codes the client treats as final (no reconnect).
export const CloseCode = {
  BadMessage: 4000,
  TokenRotated: 4001,
  BadToken: 4003,
  NotFound: 4004,
  HelloTimeout: 4008,
} as const;

export type CreateRoomRequest = { name: string; rotate?: boolean };
export type CreateRoomResponse = { roomId: string; token: string };
