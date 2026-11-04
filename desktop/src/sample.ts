// Stand-in previews and icons for running the UI outside the Tauri shell (browser dev and the
// website's screenshots), drawn as SVG so no real windows are ever shown.

const svg = (w: number, h: number, body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`)}`;

const lines = (n: number, x: number, y: number, step: number, color: string, seed: number) =>
  Array.from({ length: n }, (_, i) => {
    const w = 60 + ((seed * (i + 3) * 37) % 140);
    const indent = ((seed + i) % 4) * 14;
    return `<rect x="${x + indent}" y="${y + i * step}" width="${w}" height="6" rx="3" fill="${color}"/>`;
  }).join("");

const SCENES: Record<number, string> = {
  // A cave lit by flares.
  1: svg(320, 180, `<defs><radialGradient id="g" cx="0.62" cy="0.55" r="0.7"><stop offset="0" stop-color="#ffb347"/><stop offset="0.35" stop-color="#8a3b12"/><stop offset="1" stop-color="#140806"/></radialGradient></defs>
    <rect width="320" height="180" fill="url(#g)"/>
    <path d="M0 140 L40 120 L80 132 L130 110 L170 128 L220 104 L270 126 L320 112 L320 180 L0 180Z" fill="#2a1208"/>
    <path d="M0 0 L320 0 L320 34 L280 50 L240 30 L190 56 L140 28 L90 48 L40 26 L0 44Z" fill="#1d0b05"/>
    <circle cx="198" cy="98" r="6" fill="#fff3c4"/><circle cx="96" cy="118" r="3" fill="#7fe3ff"/>
    <rect x="12" y="150" width="70" height="8" rx="2" fill="#e8ebee" opacity="0.7"/><rect x="250" y="12" width="58" height="10" rx="2" fill="#e8ebee" opacity="0.5"/>`),
  // A factory floor seen from above.
  2: svg(320, 180, `<rect width="320" height="180" fill="#3b3326"/>
    ${Array.from({ length: 9 }, (_, i) => `<rect x="${12 + i * 34}" y="${20 + (i % 3) * 46}" width="26" height="26" rx="2" fill="${["#6d6a5f", "#8c6d3f", "#5f7a52"][i % 3]}"/>`).join("")}
    <path d="M0 64 H320 M0 112 H320 M150 0 V180" stroke="#c9a14a" stroke-width="5" stroke-dasharray="10 6"/>
    <rect x="232" y="128" width="76" height="40" rx="3" fill="#1d1a14" opacity="0.8"/><rect x="240" y="138" width="40" height="5" fill="#7fd1a5"/><rect x="240" y="150" width="56" height="5" fill="#e2b25a"/>`),
  // A chat app.
  3: svg(320, 180, `<rect width="320" height="180" fill="#313338"/><rect width="22" height="180" fill="#1e1f22"/><rect x="22" width="70" height="180" fill="#2b2d31"/>
    ${[18, 46, 74].map((y) => `<circle cx="11" cy="${y}" r="7" fill="#5865f2"/>`).join("")}
    ${lines(8, 30, 16, 14, "#4e5058", 3)}${lines(7, 106, 24, 20, "#b5bac1", 5)}
    <rect x="102" y="158" width="206" height="14" rx="4" fill="#383a40"/>`),
  // A code editor.
  4: svg(320, 180, `<rect width="320" height="180" fill="#1e1e1e"/><rect width="18" height="180" fill="#333"/><rect x="18" width="64" height="180" fill="#252526"/>
    ${lines(9, 24, 14, 16, "#4d4d4d", 7)}
    ${["#569cd6", "#ce9178", "#9cdcfe", "#c586c0", "#dcdcaa", "#6a9955", "#9cdcfe", "#ce9178", "#569cd6"].map((c, i) => lines(1, 92, 14 + i * 17, 0, c, i + 2)).join("")}`),
  // A music player.
  5: svg(320, 180, `<rect width="320" height="180" fill="#121212"/><rect x="12" y="12" width="96" height="96" rx="4" fill="#1db954"/><circle cx="60" cy="60" r="26" fill="#121212"/><circle cx="60" cy="60" r="6" fill="#1db954"/>
    ${lines(4, 124, 22, 18, "#b3b3b3", 4)}<rect x="12" y="150" width="296" height="4" rx="2" fill="#404040"/><rect x="12" y="150" width="120" height="4" rx="2" fill="#e8ebee"/>`),
};

const desktop = (w: number, h: number, hue: number) =>
  svg(w, h, `<defs><linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 32%)"/><stop offset="1" stop-color="hsl(${hue + 50} 50% 14%)"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#d)"/>
    <rect x="${w * 0.08}" y="${h * 0.12}" width="${w * 0.5}" height="${h * 0.56}" rx="4" fill="#1c1f24" opacity="0.92"/>
    <rect x="${w * 0.44}" y="${h * 0.3}" width="${w * 0.46}" height="${h * 0.5}" rx="4" fill="#2a2f37" opacity="0.95"/>
    <rect y="${h - h * 0.07}" width="${w}" height="${h * 0.07}" fill="#000" opacity="0.45"/>`);

export function sampleThumbnail(id: number): string | null {
  return SCENES[id] ?? null;
}

export function sampleMonitorThumbnail(id: number, width: number, height: number): string {
  return desktop(320, Math.round((320 * height) / width), id === 1 ? 205 : 280);
}

const ICON_COLORS: Record<number, string> = { 1: "#e8812c", 2: "#c9a14a", 3: "#5865f2", 4: "#2f80d1", 5: "#1db954" };

export function sampleIcon(id: number, title: string): string {
  return svg(32, 32, `<rect width="32" height="32" rx="8" fill="${ICON_COLORS[id] ?? "#98a1ab"}"/>
    <text x="16" y="22" font-family="Segoe UI, sans-serif" font-size="17" font-weight="700" text-anchor="middle" fill="#fff">${title.slice(0, 1)}</text>`);
}
