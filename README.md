# stream

A self-hosted replacement for streaming games to your friends on Discord, without the 720p30 cap. Keep your Discord call for voice; watch each other here at whatever quality you send.

![A room with four friends streaming, split view](docs/img/split.webp)

Send friends a link. Everyone in the room can share a screen, a game window or an OBS feed at the same time, at whatever resolution and frame rate they choose, and each viewer picks how they watch: one stream large or several side by side. It runs on your own Cloudflare account, so there's no subscription and no per-seat fee, and most friend groups stay inside Cloudflare's free allowance.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Andrew1431/stream-right)

- **Everyone can stream at once.** Focus on one stream with the others as thumbnails, or split the screen between them.
- **Quality per viewer.** Streams are sent as simulcast (full, half and quarter size). Each tile picks the layer that fits its size, or you choose High, Medium or Low for that tile.
- **Browser, desktop app or OBS.** Share straight from the browser; use the [Windows app](#desktop-app) to stream a game in two clicks with only its sound; or stream from OBS over WHIP. The app and OBS both encode on your graphics card and aren't throttled while your game has focus.
- **Invite links are the keys.** The room token lives in the link's `#fragment`, so it never reaches server logs. Rotate a link to kick everyone and revoke it.
- **No accounts.** Type a name and you're in.
- **Nothing is recorded.** Video goes from the streamer through Cloudflare's relay straight to viewers and is never stored on your server or Cloudflare's. If a room's owner turns on [clips](#clips), viewers can save the last minute or two to their own device, and everyone in the room is told.

## What it costs

You pay Cloudflare directly, only for what's watched.

| | Free each month | After that |
|---|---|---|
| Realtime SFU (the video relay) | 1,000 GB delivered to viewers | $0.05 per GB |
| Workers + Durable Objects (the site and rooms) | Free plan limits are plenty for friends | |

Uploading (streaming) is free. You're charged for what each viewer receives, roughly:

| Watching | Per viewer per hour |
|---|---|
| 1080p60 | ~3 GB |
| 1440p60 | ~4 GB |
| 4K60 | ~8 GB |
| A small thumbnail | ~0.3 GB |
| Tab hidden (audio only) | ~0.05 GB |

Five friends each watching one 1080p60 stream for a 5-hour evening is about 70 GB, so 1,000 GB covers a dozen or so evenings a month. Idle rooms and a stream nobody is watching cost nothing.

To get a heads-up before spending anything, add a **Usage Based Billing** notification under **Notifications** in the Cloudflare dashboard. The site can also show this month's usage on its home page, and close its rooms when a monthly limit is reached; see [See your usage](#see-your-usage) and [Set a monthly limit](#set-a-monthly-limit).

Anyone with a room's invite link can watch and stream in it, and so can anyone they pass it to, so treat links like keys: rotate one to lock everyone out. stream is provided as is, without warranty; you're responsible for your Cloudflare account and its charges.

## Set it up

You need a Cloudflare account (free). Cloudflare asks for a payment method before it turns on Realtime, even though you won't be charged inside the free allowance.

### 1. Create a Realtime app

1. In the [Cloudflare dashboard](https://dash.cloudflare.com), go to **Realtime → Serverless SFU** and create an app.
2. Keep the page open: you need its **App ID** and **App Secret** next.

### 2. Deploy

**One click:** press **Deploy to Cloudflare** above. It copies this repository to your GitHub account, asks for the three secrets below, and deploys. Future pushes to your copy redeploy automatically.

**Or from your computer** (Node 22+):

```bash
git clone https://github.com/Andrew1431/stream-right
cd stream-right
npm install
npx wrangler login
npx wrangler secret put CREATOR_KEY
npx wrangler secret put REALTIME_APP_ID
npx wrangler secret put REALTIME_APP_SECRET
npm run deploy
```

| Secret | What it is |
|---|---|
| `CREATOR_KEY` | A password for making rooms. Use a long random string, e.g. from `openssl rand -base64 32`. |
| `REALTIME_APP_ID` | The App ID from step 1. |
| `REALTIME_APP_SECRET` | The App Secret from step 1. |

Your site is now at `https://stream.<your-subdomain>.workers.dev`.

### 3. Make a room

Open the site, paste your creator key, type a room name and press **Create**. Copy the invite link and send it to your friends. Anyone with the link can join; nobody else can.

**Rotate link** makes a new link and disconnects everyone holding the old one, OBS streams included.

### Use your own domain (optional)

If your domain's DNS is on Cloudflare:

```bash
cp .env.example .env    # set CUSTOM_DOMAIN=stream.example.com
npm run deploy
```

Or add it in the dashboard under your Worker's **Settings → Domains & Routes**.

### Let friends make their own rooms

Give them the creator key. Rooms are never listed anywhere: each browser keeps its own **Your rooms** list, and a room can only be joined with its invite link, so nobody sees anyone else's rooms. Anyone holding the creator key can also rotate any room's link, so share it only with people you trust. Making rooms always needs the key, so a stranger who finds your site's address can't run up your bill.

## Update

New versions land on this repository's `main` branch.

**If you used Deploy to Cloudflare**, Cloudflare made a copy of this repository in your GitHub account and redeploys whenever it changes. To update it:

1. Open your copy on GitHub and go to the **Actions** tab. If GitHub asks, enable workflows.
2. Pick **Update** on the left, press **Run workflow**, then **Run workflow** again.

It pulls in the latest version and Cloudflare deploys it a minute or two later (watch your Worker's **Deployments** tab). Your Worker keeps its name. If you changed files yourself and an update changes the same lines, the update's version wins.

To update automatically every Monday, go to **Settings → Secrets and variables → Actions → Variables** in your copy and add a variable named `AUTO_UPDATE` with the value `true`.

If an update changes the Update workflow itself, GitHub won't let the workflow apply that part. The run finishes with a warning, and everything else is updated. To get the new workflow, copy `.github/workflows/update.yml` from this repository into yours using GitHub's web editor.

Prefer the command line? This does the same:

```bash
git remote add upstream https://github.com/Andrew1431/stream-right   # once
git pull upstream main --allow-unrelated-histories
git push
```

**If you deployed from your computer:**

```bash
git pull
npm install
npm run deploy
```

Updates keep your secrets, rooms and invite links. Anyone in a room when the new version goes live reconnects on their own after a moment.

## See your usage

With the creator key entered, the home page links to your Realtime usage in the Cloudflare dashboard.

To show this month's total right on the home page instead, give the site a read-only Cloudflare API token:

1. In the Cloudflare dashboard, open **Manage account → Account API Tokens** (or **My Profile → API Tokens**) and press **Create Token**, then **Create Custom Token**.
2. Name it, add the permission **Account → Account Analytics → Read**, and press **Continue to summary**, then **Create Token**.
3. Copy the token and add it as a secret named `CF_API_TOKEN`: `npx wrangler secret put CF_API_TOKEN`, or your Worker → **Settings → Variables and Secrets → Add** (type **Secret**).

The home page then shows how much of the free 1,000 GB has gone to viewers this month and, past that, roughly what it's costing. Inside a room, a **GB used** button in the top bar opens a card with the last hour's usage, what an hour costs once the free amount is gone (or now, if it is), how long the free amount lasts at that pace, and how much your own browser is receiving. The figure lags a few minutes behind and is an estimate; your Cloudflare bill is exact. Only people with the creator key see it. If your token can see more than one account, also add a `CF_ACCOUNT_ID` secret with your account ID (shown on your account's overview page).

## Set a monthly limit

With `CF_API_TOKEN` set (above), you can have rooms close themselves when the month's usage reaches a limit, so a busy month, or a link that got around, can't run up a bill. Add a secret named `USAGE_LIMIT_GB`:

```bash
npx wrangler secret put USAGE_LIMIT_GB
```

- `free`: stop just before the free 1,000 GB runs out (at 950 GB).
- A number, such as `1500`: stop at that many gigabytes. Each 100 GB past the free amount is about $5.

When the limit is reached, every room ends its streams within five minutes and tells everyone the server reached its monthly limit; nobody can join until the 1st of next month (UTC). Raise or remove the secret to open rooms again sooner. Cloudflare's numbers trail real traffic by a few minutes, so usage can pass the limit by a little. If the usage can't be read (an expired token, say), rooms stay open rather than cutting everyone off.

## Lost or leaked keys

**Creator key.** Set a new one; the old key stops working straight away. Rooms and invite links are unaffected.

```bash
npx wrangler secret put CREATOR_KEY
```

Or in the dashboard: your Worker → **Settings → Variables and Secrets** → edit `CREATOR_KEY`. Anyone who saved the old key in their browser is asked for the new one next time they make a room.

**An invite link leaked.** Press **Rotate link** on the home page in the browser that made the room. Everyone is disconnected and only the new link works.

**Lost an invite link** (cleared the browser, or made the room on another device). With the creator key entered, create a room with the same name and confirm the prompt to rotate it. You get a fresh link; the old one stops working.

**An OBS token leaked.** In the room, open **Stream from OBS** and press **Make a new token**. The old token stops working straight away, and a stream using it leaves the room. To revoke every OBS token in a room at once, rotate the room's link.

**Realtime App Secret leaked.** Make a new secret for the app in **Realtime → Serverless SFU**, then run `npx wrangler secret put REALTIME_APP_SECRET` (or edit it in the dashboard).

## Desktop app

For Windows 10 and 11. [Download the latest release](https://github.com/Andrew1431/stream-right/releases/latest) and run the `-setup.exe`. Windows may say it "protected your PC" the first time, because the installer isn't code-signed yet: choose **More info → Run anyway**. The app updates itself after that.

- **All your rooms in one window.** Paste invite links from any stream server; each server gets an icon down the side, with its rooms underneath and a red dot when someone is live. Ctrl+B hides the sidebar.
- **Go live in two clicks.** Pick a game window (fullscreen games are listed first, with previews) or a whole screen. It's captured with Windows Graphics Capture and encoded on your graphics card, so it stays smooth while the game has focus.
- **Only the sound you mean.** A window share sends just that game's sound. A screen share sends everything you hear except Discord, TeamSpeak, Mumble, Slack, Teams and Zoom.
- **Any resolution and frame rate**, the same presets and custom choices as the browser.
- **Creator tools.** Add your creator key for a server to make rooms, rotate links and see the month's usage from the app.

The app uses the room's OBS token behind the scenes, so the server needs nothing extra. Servers older than the app still open, with a simpler bar. To release a new version, bump `version` in `desktop/src-tauri/tauri.conf.json` and push a matching `desktop-v<version>` tag; GitHub Actions builds and publishes it, and installed apps offer the update.

## Install it as an app

The site installs like an app, with its own window and icon and no address bar:

- **Chrome or Edge on a computer:** the install icon at the right of the address bar.
- **Android:** the browser menu → **Install app** (or **Add to Home screen**).
- **iPhone and iPad:** Safari's Share button → **Add to Home Screen**.

The app opens on your rooms: the ones you made, and every room you've joined, each showing who's there and who's streaming. Links that were rotated say so. Paste an invite link under **Join a room** to add a new one, and press **stream** at the top left of a room to get back.

Clicking an invite link (in Discord, say) opens:

- **Android:** in the installed app.
- **Chrome or Edge on a computer:** in the browser, unless you turn on **Open supported links** in the app's settings (the app's menu → **App info** or **Settings**). Either way, the room is added to the app's list once you've joined it in that browser.
- **iPhone and iPad:** in Safari. The home-screen app keeps its own storage, so paste the link into it once and it remembers the room.

## Streaming from OBS

Browser sharing works anywhere, but Chrome throttles capture when the game has focus and can't use your GPU encoder as well as OBS can. OBS 30 or newer streams straight into a room over WHIP.

1. In the room, click **Stream from OBS** to get your server URL and token.
2. **Settings → Stream:** Service **WHIP**, paste the **Server** and **Bearer Token**. On OBS 32+, set **Simulcast → Total Layers: 3** so viewers can get smaller copies.
3. **Settings → Output** (Output Mode: Advanced → Streaming):
   - **Video Encoder:** NVIDIA NVENC H.264, AMD HW H.264 or QuickSync H.264. Not HEVC or AV1; not every browser can play those over WebRTC.
   - **Rate Control:** CBR, **Bitrate** about 8000 Kbps for 1080p60, 12000 for 1440p60, 20000 for 4K60.
   - **Keyframe Interval:** 1 s, so viewers who join or switch quality see the picture straight away.
   - **Max B-frames:** 0. WebRTC doesn't support them.
4. **Settings → Video:** set the output resolution and FPS you want to send (1440p at 120 works if your upload can carry it).
5. Add a **Game Capture** source and press **Start Streaming**. Your stream shows up in the room as "*your name* (OBS)".

**Or import a setup file.** In the room's **Stream from OBS** panel, switch to **Import a setup file**, pick a quality and your graphics card, and press **Download setup**. The zip has an OBS profile (server, token, encoder, resolution) and a scene collection with one Game Capture that sends only the game's sound. In OBS, **Profile → Import** the folder and **Scene Collection → Import** the `.json`, switch to both, start your game in fullscreen or borderless, and press **Start Streaming**. The zip holds your token, so treat it like one.

**Keep voice chat out of the stream:** in **Settings → Audio**, set **Desktop Audio** to Disabled, then add an **Application Audio Capture** source for the game (Windows 10 2004+). Discord and music stay off the stream without extra software.

Each person gets their own token from their room's OBS panel. A token stops working when the room's link is rotated; **Make a new token** in the panel replaces just yours.

## Clips

Clips let someone save the last 30 to 120 seconds of what they were watching as an MP4, like an instant replay. They're built so that nobody is ever recorded without knowing it.

- **Off by default.** The room's owner turns them on with **Clips off → Allow clips in this room**. The owner is the browser that made the room (it keeps the room's owner key) or anyone with the creator key. The server rejects the setting from anyone else.
- **Everyone can see it.** While clips are on, the top bar shows a **Clips on** badge, and people get a one-time notice when they join or when clips are switched on.
- **You can see who's buffering.** Viewers opt in to keeping a buffer, and a dot appears next to their name in the people list while they do.
- **Every clip is announced.** Saving a clip tells the whole room, e.g. "Maya clipped the last 60s (Jonah, Priya)", with a short shutter sound. You can mute the sound, but the notice always shows. The room sends the announcement before the file is made, so a clip the room didn't announce isn't saved.
- **Streamers can opt out.** **Don't allow clips of my stream** (in the clips panel or the notice) keeps everyone's buffer off your stream, and your tile shows "No clips". It also covers your OBS stream when you set it in the browser that holds your OBS token.

**How it works.** Nothing extra is uploaded and the server stores no media. Each viewer's browser keeps a copy of the H.264 video and Opus audio it already receives, using WebRTC encoded transforms in a background worker, and saves it as an MP4 without re-encoding. One file is saved per stream, named like `jonah-friday-night-21-04-37.mp4`. It needs Chrome, Edge, Firefox or Safari; streams sent as VP8 (browsers without H.264) can't be clipped. Starting a buffer briefly reconnects the streams you're watching.

**Memory.** The buffer lives in memory: roughly 45 MB a minute for a 1080p60 stream at full quality, times the number of streams you watch. The clips panel shows how much each buffer holds and warns above about 500 MB.

**It's what you received.** A clip is the copy your browser was getting, so a stream you had as a thumbnail is clipped at thumbnail size, and a tab that was hidden long enough to drop to audio only has no video for that stretch. Watch a stream large at High quality for the best clip. When the quality changes mid-buffer, the clip starts at the change.

**This isn't DRM.** The app enforces these rules for itself. Anyone can still record their screen with other software, and a modified browser could skip the announcements. Clips make the honest path visible; they can't stop a determined person from recording.

## Troubleshooting

**Stuck on "Reconnecting".** A browser extension (ad or privacy blockers especially) may be blocking WebSockets. Try a private window; if that works, allow the site in the extension.

**"Streaming isn't configured on the server yet."** `REALTIME_APP_ID` or `REALTIME_APP_SECRET` is missing. Set both and deploy again.

**A stream is choppy at high resolution.** Check upload speed first: the sender needs a bit more upload than the bitrate. 4K60 needs about 25 Mbps. In the browser, pick a lower resolution, or use OBS with a hardware encoder.

**High/Medium/Low don't change an OBS stream.** That stream has one layer. Set **Total Layers: 3** in OBS (version 32+) and restart the stream.

**Quality drops when the viewer switches tabs.** By design: after 15 seconds hidden, a tab drops to audio only to save bandwidth, and comes back when you return.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in the same three secrets
npm run dev                       # http://localhost:5173
```

Run `npm run cf-typegen` after changing `wrangler.jsonc` or `.dev.vars`.

The app icon is rendered in Blender (Cycles): `blender -b -P scripts/icon/render.py -- <out_dir>`, then `node scripts/icon/resize.mjs <out_dir>` writes the sizes into `public/icons` (needs `npm i --no-save sharp`).

How it fits together: a Worker serves the React app and an API, each room is a Durable Object holding the members list and a WebSocket per person, and Cloudflare Realtime relays the media. Browsers publish to and pull from the SFU directly; the room only brokers which tracks exist. OBS talks to the room's WHIP endpoint, which creates the SFU session on its behalf.

```
shared/protocol.ts   messages between browser and room
worker/index.ts      HTTP routes: create room, WebSocket, WHIP
worker/room.ts       the Room Durable Object
src/RoomPage.tsx     the room UI
src/media.ts         publishing and subscribing over WebRTC
```

## License

[MIT](LICENSE)
