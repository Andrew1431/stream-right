// Share quality presets, shared by the web app and the desktop app so both offer the same choices.

// height 0 means the source resolution, uncapped.
export type ShareSettings = { height: number; fps: number };

export const PRESETS = {
  "720p30": { height: 720, fps: 30 },
  "1080p60": { height: 1080, fps: 60 },
  "1440p60": { height: 1440, fps: 60 },
  "2160p60": { height: 2160, fps: 60 },
  source: { height: 0, fps: 60 },
} satisfies Record<string, ShareSettings>;
export type PresetId = keyof typeof PRESETS;

export const HEIGHT_CHOICES = [720, 1080, 1440, 2160, 0];
export const FPS_CHOICES = [30, 60, 90, 100, 120, 144, 165, 240];

export function heightLabel(height: number): string {
  if (!height) return "Source";
  return height === 2160 ? "4K" : `${height}p`;
}

export const settingsLabel = (s: ShareSettings) => `${heightLabel(s.height)} ${s.fps}fps`;

// Compact id the room shows to others, e.g. "1080p100" or "source60".
export const settingsId = (s: ShareSettings) => (s.height ? `${s.height}p${s.fps}` : `source${s.fps}`);
