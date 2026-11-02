// Turns the two Blender renders into the icon files the site uses.
//   npm i --no-save sharp
//   node scripts/icon/resize.mjs <dir with icon-full.png and icon-tile.png>
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const src = process.argv[2] ?? ".";
const out = "public/icons";
mkdirSync(out, { recursive: true });

const jobs = [
  // Rounded tile on transparency: browsers, desktop installs, the tab favicon.
  ["icon-tile.png", "icon-512.png", 512],
  ["icon-tile.png", "icon-192.png", 192],
  ["icon-tile.png", "favicon-32.png", 32],
  // Full-bleed square: Android crops it to its own shape; iOS rounds it.
  ["icon-full.png", "maskable-512.png", 512],
  ["icon-full.png", "apple-touch-icon.png", 180],
];

for (const [from, to, size] of jobs) {
  await sharp(`${src}/${from}`).resize(size, size, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toFile(`${out}/${to}`);
  console.log(to);
}
