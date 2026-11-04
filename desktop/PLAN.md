# stream desktop — plan

One small Windows app that holds every stream server you've been invited to, shows who's live across all of them, and goes live with a game in two clicks: game picture plus that game's sound only, encoded on the graphics card. The web app stays for hopping in from a link and simple screen shares; OBS stays for people who want scenes and overlays.

## What it fixes

| Problem today | Browser | OBS | Desktop |
| --- | --- | --- | --- |
| Capture drops to a few fps while the game has focus | yes | no | no, native capture plus GPU priority |
| Fullscreen game missing from the window picker | yes | no | no, lists running games, borderless and exclusive |
| Discord voice leaks into the stream | yes | only with setup | no, the app's own audio by default |
| Setup | none | server, token, encoder, sources | paste an invite once |
| Several friend groups | one tab per link | one profile each | one sidebar, live dots |

## Shape

```
┌──────┬──────────────────┬────────────────────────────────────────┐
│ ◉ HW │ hartwigdev       │                                        │
│ ◉ JK │  # bro       ● 3 │   the room: the same web UI, embedded  │
│      │  # late-night    │   (watching, volume, clips, chat-less) │
│  +   │                  │                                        │
│      │ ──────────────── │                                        │
│      │ Andrew   [Go live]│                                       │
└──────┴──────────────────┴────────────────────────────────────────┘
```

- **Server rail:** one icon per stream instance (an origin like `stream.hartwigdev.ca`). Add one by pasting any invite link; the app splits it into server, room and token.
- **Rooms column:** the rooms you hold links for on that server, each with its live status from the existing `/api/rooms/:id/peek` endpoint (people, who's live). This is the "channels" part; there's no new server concept.
- **Main pane:** the room itself, the existing web UI loaded from that instance in an embedded frame, so watching, quality, volume and clips keep working and stay in one codebase.
- **Go live:** a native sheet, not the browser picker. It lists screens and running games and windows with thumbnails, the same quality presets and custom resolution/frame rate as the web app, and one button.
- **Sound:** a window share sends only that app's sound by default. A screen share sends everything you hear except voice chat and stream itself, the way Discord's screen share leaves out Discord. Either can be switched to no sound.
- **Sidebar:** collapses with Ctrl+B or the room bar toggle, so watching several streams gets the whole window.

## Architecture

```
Tauri 2 shell (Rust + WebView2, ~10 MB)
├─ shell UI (React, this folder)        servers, rooms, go-live sheet
├─ room frame (https://<instance>/r/…)  the web app, unchanged, told it's inside the desktop app
└─ Rust core
   ├─ capture   Windows Graphics Capture (window or monitor), D3D11 textures
   ├─ audio     WASAPI process loopback (Windows 10 2004+): one app's sound for a window share;
   │            for a screen share, every active audio session except voice apps and stream, mixed
   ├─ encode    Media Foundation hardware H.264 (NVENC / AMF / QSV), Opus
   └─ publish   WHIP to the instance's /api/rooms/:id/whip, same as OBS
```

- **Why Tauri:** watching needs WebRTC playback, which WebView2 already has. A pure-Rust UI would mean writing a WebRTC player too. Tauri keeps the binary small and lets the room UI be shared with the web.
- **Token handoff:** the room frame already knows how to get an OBS token (`obsKey`). Inside the desktop app it posts `{ server, room, token }` to the shell over `postMessage`, and the Rust core publishes with it. The stream shows up as "*name* (OBS)" today; it can get its own label later.
- **Shared UI:** the desktop app is an npm workspace of the repo root. Components and data both apps need live in `ui/` (quality presets and picker, the palette in `ui/tokens.css`; usage stats next), so the web app and the desktop app can't drift apart.
- **No server changes needed for the first milestones,** except CORS on `peek` so the shell can read live status, and a `frame-ancestors` allowance if the instance ever sets one.

## Milestones

1. **Shell prototype.** Server rail, rooms with live status, join by invite link, room embedded, go-live sheet with a native window list. *Started here.*
2. **Capture preview.** Pick a window, see it in the sheet from Windows Graphics Capture.
3. **Go live.** Hardware encode plus app-only audio, published over WHIP; stop and reconnect.
4. **Ship it.** Tray icon, start-with-Windows, auto-update from GitHub Releases, signed installer built by a GitHub Action on each tag.
5. **Creator tools in the app.** Per-server creator key, the usage meter and panel (moved into `ui/`), making rooms and rotating links, all without opening the browser.
6. **Nice to have.** "Friend went live" notifications across all servers, a push-to-go-live hotkey, `stream://` links that open in the app.

## Open questions

- Code signing: Azure Trusted Signing (~$10/month) or ship unsigned and accept the SmartScreen warning at first.
- Mac: ScreenCaptureKit makes per-app audio easy; worth doing after Windows works.
- Whether native streams should carry the clip opt-out and name the same way the web app does (likely yes, through the token).
