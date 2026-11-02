// Captures the screenshots in docs/img from a live deployment, with fake game streams.
//   npm i --no-save puppeteer-core sharp
//   node scripts/screenshots/shots.mjs "https://<your-site>/r/<room>#k=<token>" [home|room|all]
// Uses four streamers and one viewer in the room, so use a throwaway room. CHROME_PATH overrides
// the browser.
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOM = process.argv[2];
const OUT = fileURLToPath(new URL("../../docs/img", import.meta.url));
const ORIGIN = new URL(ROOM).origin;
const FAKE = readFileSync(new URL("./fake.js", import.meta.url), "utf8");
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--enable-gpu",
    "--use-angle=d3d11",
  ],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(name, { w = 1440, h = 900, store = {}, url = ROOM } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const init = { displayName: name, ...store };
  await page.evaluateOnNewDocument(
    (init, fake) => {
      for (const [k, v] of Object.entries(init)) localStorage.setItem(k, JSON.stringify(v));
      (0, eval)(fake);
    },
    init,
    FAKE,
  );
  page.on("pageerror", (e) => console.log(name, "pageerror", e.message));
  await page.goto(url, { waitUntil: "networkidle0" });
  return page;
}

async function share(page, kind) {
  await page.evaluate((k) => window.__fake(k), kind);
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Share screen" && !b.disabled), { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Share screen").click());
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.startsWith("Stop sharing")), { timeout: 20000 });
}

const scrub = (page) =>
  page.evaluate((origin) => {
    const host = new URL(origin).host;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const n = walk.currentNode;
      if (n.nodeValue.includes(host)) n.nodeValue = n.nodeValue.replaceAll(host, "stream.example.com");
    }
  }, ORIGIN);

const shot = async (page, file, clip) => {
  await scrub(page);
  const png = await page.screenshot({ ...(clip ? { clip } : {}) });
  await sharp(png).webp({ quality: 82 }).toFile(`${OUT}/${file.replace(".png", ".webp")}`);
  console.log("saved", file.replace(".png", ".webp"));
};

const mode = process.argv[3] ?? "all";

if (mode === "all" || mode === "home") {
  const home = await open("Maya", {
    url: ORIGIN + "/",
    w: 1200,
    h: 760,
    store: {
      creatorKey: "demo",
      myRooms: [
        { roomId: "friday-night", link: ORIGIN + "/r/friday-night#k=demo", createdAt: Date.now() },
        { roomId: "speedrun-club", link: ORIGIN + "/r/speedrun-club#k=demo", createdAt: Date.now() - 1e8 },
      ],
    },
  });
  await sleep(800);
  await shot(home, "home.png");
}

if (mode === "all" || mode === "room") {
  const streamers = [];
  for (const [name, kind] of [["Jonah", "racer"], ["Priya", "shooter"], ["Sam", "strategy"], ["Leo", "space"]]) {
    const p = await open(name, { w: 1280, h: 720, store: { sharePreset: "1080p60", previewCollapsed: true } });
    await share(p, kind);
    streamers.push(p);
  }

  const viewer = await open("Maya", { store: { layout: "focus", previewCollapsed: false } });
  await sleep(6000);
  // Pin the big tile to High so the 2x screenshot is sharp.
  await viewer.hover(".tile");
  await viewer.click(".quality-pill");
  await viewer.evaluate(() => [...document.querySelectorAll(".quality-menu button")].find((b) => b.textContent.startsWith("High")).click());
  await viewer.mouse.move(1430, 890);
  await sleep(8000);
  await shot(viewer, "focus.png");

  await viewer.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.trim() === "Split").click());
  await viewer.mouse.move(1430, 890);
  await sleep(12000);
  await shot(viewer, "split.png");

  // Quality menu on the first split tile.
  await viewer.hover(".tile");
  await viewer.click(".quality-pill");
  await sleep(500);
  await shot(viewer, "quality.png", { x: 0, y: 0, width: 760, height: 475 });
  await viewer.keyboard.press("Escape");
  await viewer.mouse.click(5, 450);

  await viewer.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent.trim() === "Focus").click());
  await share(viewer, "shooter");
  await sleep(6000);
  await viewer.mouse.move(300, 300);
  await shot(viewer, "corner.png", { x: 680, y: 425, width: 760, height: 475 });

  await viewer.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Stream from OBS").click());
  await sleep(2500);
  await shot(viewer, "obs.png");

  for (const p of [...streamers, viewer]) {
    await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Stop sharing"))?.click());
  }
  await sleep(1500);
}

await browser.close();
