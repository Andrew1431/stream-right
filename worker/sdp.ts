import type { TrackName } from "../shared/protocol";

export type OfferTrack = { mid: string; trackName: TrackName; rids: string[] };

// Pull the first audio and video m-sections out of a WHIP offer (OBS sends one of each).
export function parseOfferTracks(sdp: string): OfferTrack[] {
  const out: OfferTrack[] = [];
  for (const section of sdp.split(/\r?\nm=/).slice(1)) {
    const kind = section.startsWith("video") ? "video" : section.startsWith("audio") ? "audio" : null;
    if (!kind || out.some((t) => t.trackName === kind)) continue;
    if (/^a=inactive|^a=recvonly/m.test(section)) continue;

    const mid = section.match(/^a=mid:(\S+)/m)?.[1];
    if (!mid) continue;

    // a=simulcast:send lists layers in the sender's priority order; ";" separates
    // layers, "," separates alternatives, "~" marks a paused layer.
    const order = section.match(/^a=simulcast:send (\S+)/m)?.[1];
    const rids = order
      ? order.split(";").map((alt) => alt.split(",")[0].replace(/^~/, "")).filter(Boolean)
      : [...section.matchAll(/^a=rid:(\S+) send/gm)].map((m) => m[1]);

    out.push({ mid, trackName: kind, rids });
  }
  return out;
}
