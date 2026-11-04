import { useState } from "react";
import { FPS_CHOICES, HEIGHT_CHOICES, heightLabel, PRESETS, settingsLabel, type PresetId, type ShareSettings } from "./presets";

const PRESET_STORE = "sharePreset";
const CUSTOM_STORE = "customShare";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered; fine.
  }
}

// The chosen preset (or custom resolution and frame rate), remembered on this device.
export function useShareQuality() {
  const [preset, setPresetState] = useState<PresetId | "custom">(() => {
    const p = load<string>(PRESET_STORE, "1080p60");
    return p === "custom" || p in PRESETS ? (p as PresetId | "custom") : "1080p60";
  });
  const [custom, setCustomState] = useState<ShareSettings>(() => load(CUSTOM_STORE, { height: 1080, fps: 120 }));
  return {
    preset,
    custom,
    settings: preset === "custom" ? custom : PRESETS[preset],
    setPreset(next: PresetId | "custom") {
      setPresetState(next);
      save(PRESET_STORE, next);
    },
    setCustom(next: ShareSettings) {
      setCustomState(next);
      save(CUSTOM_STORE, next);
    },
  };
}

export type ShareQuality = ReturnType<typeof useShareQuality>;

// Preset menu, plus resolution and frame rate menus when "Custom…" is picked.
export function QualityPicker({ quality }: { quality: ShareQuality }) {
  const { preset, custom } = quality;
  return (
    <>
      <select aria-label="Share quality" value={preset} onChange={(e) => quality.setPreset(e.target.value as PresetId | "custom")}>
        {Object.entries(PRESETS).map(([id, p]) => (
          <option key={id} value={id}>{p.height ? settingsLabel(p) : "Source (no cap)"}</option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {preset === "custom" && (
        <>
          <select aria-label="Resolution" value={custom.height} onChange={(e) => quality.setCustom({ ...custom, height: Number(e.target.value) })}>
            {HEIGHT_CHOICES.map((h) => (
              <option key={h} value={h}>{heightLabel(h)}</option>
            ))}
          </select>
          <select aria-label="Frame rate" value={custom.fps} onChange={(e) => quality.setCustom({ ...custom, fps: Number(e.target.value) })}>
            {FPS_CHOICES.map((f) => (
              <option key={f} value={f}>{f}fps</option>
            ))}
          </select>
        </>
      )}
    </>
  );
}
