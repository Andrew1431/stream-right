# stream.hartwigdev.ca — plan

A small Screego-style site for the friend group: you share a link with a token, people join a room, anyone can share a screen or game, everyone else can watch any stream at a quality they pick. It runs entirely on Cloudflare (hartwigdev.ca already uses Cloudflare nameservers).

## Architecture

```
browser ──HTTPS/WS──> Worker (stream.hartwigdev.ca)
                        ├─ static site (Vite build, Workers static assets)
                        ├─ /api/*  → proxies Cloudflare Realtime API (app secret stays server-side)
                        └─ Room Durable Object (one per room)
                              - checks the token, tracks members and published tracks
                              - WebSocket fan-out: "X started sharing track T", "Y left"
browser ──WebRTC────> Cloudflare Realtime SFU  (the central server that forwards each stream)
browser ──TURN──────> Cloudflare Realtime TURN (short-lived credentials minted by the Worker)
```

- **SFU, not mesh.** Each sharer uploads one copy and Cloudflare sends it to every viewer. Upload cost no longer grows with the number of viewers the way it does in Screego.
- **Pull only what you watch.** A viewer pulls tracks only for the streams on screen: a thumbnail at the low layer, the focused stream at the high layer. This is the main lever for staying in the free tier.
- **Stack:** TypeScript everywhere. Worker + Durable Objects (SQLite-backed, WebSocket hibernation) and a Vite + React (or Svelte) frontend, deployed with Wrangler.

## Rooms and the token link

- Link format: `https://stream.hartwigdev.ca/r/<roomId>#k=<token>`. The token sits in the URL fragment, so browsers never send it to servers or write it to logs. The client sends it in the WebSocket handshake.
- Token = 32 random bytes. The Durable Object stores only its SHA-256 hash. Anyone holding the link is in, which is the security model you asked for.
- **Room creation is gated** by a creator key only you hold (a Worker secret, entered once in the site and kept in localStorage). Otherwise anyone who finds the site can open rooms and use up your bandwidth.
- Owner controls: rotate the token (old links stop working), kick, close the room. Rooms expire after N days without activity.

## Quality

- **Sender presets:** 720p30 / 1080p60 / 1440p60 / source. These are applied through `getDisplayMedia` constraints, `track.contentHint = "motion"` for games or `"detail"` for text, and `RTCRtpSender.setParameters` (maxBitrate, maxFramerate). Codec order uses `setCodecPreferences` (AV1 › VP9 › H.264), limited to the codecs the SFU accepts.
- **Simulcast:** the sender encodes 3 layers (e.g. full / ½ / ¼). Each viewer picks auto/high/med/low, and the SFU forwards only that layer. *Check how Realtime currently exposes simulcast layer selection.*
- **Stats overlay:** resolution, fps, bitrate, RTT and packet loss from `getStats()`, so everyone can see what they're actually getting.

## Native games — does web-based work?

Mostly, yes:
- **Browser capture** (`getDisplayMedia`) captures game windows and whole screens fine at 60fps. Borderless or windowed works best; exclusive fullscreen can capture as black. Chrome or Edge on Windows can include system audio when sharing a whole screen; audio from a single window is unreliable. The browser's hardware encoder is good, but not as good as OBS with NVENC at the same bitrate.
- **Expected latency** is about 150–400 ms through the SFU. That's fine for watching, but not for remote play.
- **Phase 2, OBS WHIP ingest:** OBS 30+ can stream over WebRTC (WHIP). Cloudflare Realtime accepts WHIP, so the site hands out a per-room WHIP URL and friends stream from OBS with NVENC or AV1 at much better quality, and viewers watch in the same room UI. This is the best answer for native-quality game streaming.
- **Out of scope:** controlling each other's games (that's Sunshine/Moonlight or Parsec).

## Cost (Cloudflare Realtime)

- 1,000 GB/month free, **shared** between SFU and TURN, then $0.05/GB. Only egress (Cloudflare → viewers) counts; uploads are free.
- 1080p60 at ~6 Mbps ≈ **2.7 GB per viewer-hour**.
  - You → brother, 1 viewer: ~370 h/month free.
  - 4 friends each sharing, everyone watching everyone at high: 12 streams ≈ 32 GB/h → ~30 h/month. Low-layer thumbnails plus one focused stream per viewer cut this to roughly a third.
- **Guardrails:** the Durable Object estimates egress (bitrate × viewer-time from client stats reports) and enforces a monthly soft cap that downgrades to low layers, then a hard cap. Also set a billing alert in the Cloudflare dashboard.
- Workers and Durable Objects free plans cover the signaling at this scale.

## How complicated

An MVP is about 1–2 weekends, roughly 1.5–2.5k lines. The hard parts:
- Realtime session/track lifecycle and renegotiation: start/stop sharing, a viewer arriving mid-stream, reconnects.
- Simulcast layer switching and adapting to bandwidth.
- Browser quirks: Safari/iOS can watch but not share, and audio capture differs between browsers.

## Milestones

1. Worker + Room Durable Object + static page; create room, token link, presence list.
2. One sharer publishes through Realtime, one viewer pulls it.
3. Several sharers: grid + focus view, start/stop, join mid-stream.
4. Quality presets, simulcast, per-viewer layer select, stats overlay.
5. TURN credentials, reconnect handling, egress cap.
6. OBS WHIP ingest.
7. Polish: per-stream volume, token rotation and kick, room expiry.

## Open questions

- Only you create rooms, or anyone with the creator key?
- Persistent named rooms (e.g. `/r/friends`) or throwaway rooms?
- Stream audio needed at launch, or rely on Discord voice and game audio later?
- React or Svelte?
