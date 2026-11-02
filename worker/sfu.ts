import type { SfuResponse } from "../shared/protocol";

const BASE = "https://rtc.live.cloudflare.com/v1/apps";

export class SfuError extends Error {}

// Thin client for the Realtime SFU HTTPS API. Callers must check ownership first.
export async function sfu(env: Env, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<SfuResponse> {
  if (!env.REALTIME_APP_ID || !env.REALTIME_APP_SECRET) {
    throw new SfuError("Streaming isn't configured on the server yet");
  }

  const res = await fetch(`${BASE}/${env.REALTIME_APP_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.REALTIME_APP_SECRET}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data: SfuResponse;
  try {
    data = await res.json();
  } catch {
    throw new SfuError(`SFU returned ${res.status}`);
  }
  if (!res.ok || data.errorCode) {
    throw new SfuError(data.errorDescription ?? data.errorCode ?? `SFU returned ${res.status}`);
  }
  return data;
}
