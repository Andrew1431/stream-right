export const ROOM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const MAX_NAME_LENGTH = 32;

// Simulcast layers, best first: Realtime's "asciibetical" fallback walks f → h → q.
export const RIDS = ["f", "h", "q"] as const;
export type Rid = (typeof RIDS)[number];

export type TrackName = "video" | "audio";

export type Stream = {
  sessionId: string;
  tracks: TrackName[];
  preset: string;
};

export type Member = {
  id: string;
  name: string;
  joinedAt: number;
  stream: Stream | null;
};

export type SessionDescription = { type: "offer" | "answer"; sdp: string };

export type PullTrack = { sessionId: string; trackName: TrackName; rid?: Rid };

export type SfuOp =
  | { op: "newSession" }
  | { op: "publish"; sessionId: string; sdp: string; tracks: { mid: string; trackName: TrackName }[]; preset: string }
  | { op: "unpublish"; sessionId: string }
  | { op: "pull"; sessionId: string; tracks: PullTrack[] }
  | { op: "renegotiate"; sessionId: string; sdp: string }
  | { op: "setLayer"; sessionId: string; mid: string; track: PullTrack & { rid: Rid } }
  | { op: "close"; sessionId: string; mids: string[]; sdp?: string };

export type ClientMessage =
  | { type: "hello"; token: string; name: string; clientId: string }
  | ({ type: "sfu"; id: number } & SfuOp);

// Subset of the Realtime API response we rely on.
export type SfuTrackResult = {
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
};

export type SfuResponse = {
  sessionId?: string;
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: SfuTrackResult[];
  errorCode?: string;
  errorDescription?: string;
};

export type ServerMessage =
  | { type: "welcome"; you: string; members: Member[] }
  | { type: "join"; member: Member }
  | { type: "update"; member: Member }
  | { type: "leave"; id: string }
  | { type: "reply"; id: number; ok: true; data: SfuResponse }
  | { type: "reply"; id: number; ok: false; error: string };

// WebSocket close codes the client treats as final (no reconnect).
export const CloseCode = {
  BadMessage: 4000,
  TokenRotated: 4001,
  BadToken: 4003,
  NotFound: 4004,
  HelloTimeout: 4008,
  Replaced: 4009,
} as const;

export type CreateRoomRequest = { name: string; rotate?: boolean };
export type CreateRoomResponse = { roomId: string; token: string };
