import { useEffect, useState } from "react";
import { CloseCode, type ClientMessage, type Member, type ServerMessage } from "../shared/protocol";

export type RoomStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "closed"; reason: string };

const FINAL_REASONS: Record<number, string> = {
  [CloseCode.BadToken]: "This invite link isn't valid. Ask for a new one.",
  [CloseCode.NotFound]: "This room doesn't exist.",
  [CloseCode.TokenRotated]: "The invite link was changed. Ask for the new one.",
  [CloseCode.BadMessage]: "The connection was rejected.",
};

export function useRoom(roomId: string, token: string, name: string | null) {
  const [status, setStatus] = useState<RoomStatus>({ kind: "connecting" });
  const [members, setMembers] = useState<Member[]>([]);
  const [you, setYou] = useState<string | null>(null);

  useEffect(() => {
    if (!name) return;

    let ws: WebSocket | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/rooms/${encodeURIComponent(roomId)}/ws`);

      ws.onopen = () => {
        ws!.send(JSON.stringify({ type: "hello", token, name } satisfies ClientMessage));
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        switch (msg.type) {
          case "welcome":
            attempt = 0;
            setYou(msg.you);
            setMembers(msg.members);
            setStatus({ kind: "connected" });
            break;
          case "join":
            setMembers((m) => [...m.filter((x) => x.id !== msg.member.id), msg.member]);
            break;
          case "leave":
            setMembers((m) => m.filter((x) => x.id !== msg.id));
            break;
        }
      };

      ws.onclose = (e) => {
        if (stopped) return;
        setMembers([]);
        setYou(null);
        const final = FINAL_REASONS[e.code];
        if (final) {
          setStatus({ kind: "closed", reason: final });
          return;
        }
        attempt += 1;
        setStatus({ kind: "reconnecting", attempt });
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), 15_000));
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      ws?.close(1000);
    };
  }, [roomId, token, name]);

  return { status, members, you };
}
