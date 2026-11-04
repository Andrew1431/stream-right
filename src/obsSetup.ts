import { zip } from "./zip";

// Builds a ready-made OBS profile (stream settings, encoder, canvas) and scene collection
// (one game capture with its own audio, desktop audio and mic muted) for one room.

export const OBS_QUALITIES = {
  "720p60": { label: "720p 60fps", width: 1280, height: 720, fps: 60, kbps: 4500 },
  "1080p60": { label: "1080p 60fps", width: 1920, height: 1080, fps: 60, kbps: 8000 },
  "1440p60": { label: "1440p 60fps", width: 2560, height: 1440, fps: 60, kbps: 12000 },
  "2160p60": { label: "4K 60fps", width: 3840, height: 2160, fps: 60, kbps: 20000 },
} as const;
export type ObsQuality = keyof typeof OBS_QUALITIES;

export const GPUS = {
  nvidia: "NVIDIA",
  amd: "AMD",
  intel: "Intel",
  cpu: "Other (encode on the processor)",
} as const;
export type Gpu = keyof typeof GPUS;

// OBS encoder ids and their settings; WHIP needs H.264 without B-frames.
function encoder(gpu: Gpu, kbps: number): { id: string; settings: Record<string, unknown> } {
  const base = { rate_control: "CBR", bitrate: kbps, keyint_sec: 1 };
  switch (gpu) {
    case "nvidia":
      return { id: "obs_nvenc_h264_tex", settings: { ...base, bf: 0, preset2: "p5", tune: "ll", multipass: "disabled", lookahead: false } };
    case "amd":
      return { id: "h264_texture_amf", settings: { ...base, bf: 0, preset: "quality" } };
    case "intel":
      return { id: "obs_qsv11_v2", settings: { ...base, bframes: 0, target_usage: "TU4" } };
    case "cpu":
      return { id: "obs_x264", settings: { ...base, preset: "veryfast", tune: "zerolatency" } };
  }
}

// Best guess from the graphics card the browser renders with.
export function detectGpu(): Gpu {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = String((info && gl?.getParameter(info.UNMASKED_RENDERER_WEBGL)) ?? "");
    if (/nvidia|geforce|quadro|rtx/i.test(renderer)) return "nvidia";
    if (/amd|radeon/i.test(renderer)) return "amd";
    if (/intel/i.test(renderer)) return "intel";
  } catch {
    // Fall through.
  }
  return "nvidia";
}

const ini = (sections: Record<string, Record<string, string | number | boolean>>) =>
  Object.entries(sections)
    .map(([name, values]) => `[${name}]\r\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\r\n")}\r\n`)
    .join("\r\n");

function source(id: string, name: string, settings: Record<string, unknown>, muted = false) {
  return {
    id,
    versioned_id: id,
    name,
    uuid: crypto.randomUUID(),
    settings,
    enabled: true,
    muted,
    volume: 1,
    balance: 0.5,
    mixers: 255,
    sync: 0,
    flags: 0,
    monitoring_type: 0,
    hotkeys: {},
    private_settings: {},
  };
}

export function obsSetupZip(opts: { roomId: string; server: string; token: string; quality: ObsQuality; gpu: Gpu }): Blob {
  const q = OBS_QUALITIES[opts.quality];
  const name = `Stream ${opts.roomId}`;
  const enc = encoder(opts.gpu, q.kbps);

  const profile = ini({
    General: { Name: name },
    Output: { Mode: "Advanced", Reconnect: true, RetryDelay: 2, MaxRetries: 25 },
    Stream1: { WHIPSimulcastTotalLayers: 3 },
    AdvOut: { ApplyServiceSettings: true, Encoder: enc.id, UseRescale: false, TrackIndex: 1, AudioEncoder: "ffmpeg_opus", Track1Bitrate: 160 },
    // The canvas is the stream size; the game is scaled to fit it.
    Video: {
      BaseCX: q.width,
      BaseCY: q.height,
      OutputCX: q.width,
      OutputCY: q.height,
      FPSType: 1,
      FPSInt: q.fps,
      ScaleType: "bicubic",
      ColorFormat: "NV12",
      ColorSpace: "709",
      ColorRange: "Partial",
    },
    Audio: { SampleRate: 48000, ChannelSetup: "Stereo" },
  });

  const game = source("game_capture", "Game", { capture_mode: "any_fullscreen", capture_audio: true, capture_cursor: true });
  const scene = source("scene", "Scene", {
    id_counter: 1,
    custom_size: false,
    items: [
      {
        name: game.name,
        source_uuid: game.uuid,
        visible: true,
        locked: false,
        rot: 0,
        pos: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        align: 5,
        bounds_type: 2, // Scale to inner bounds: fit the game into the canvas
        bounds_align: 0,
        bounds: { x: q.width, y: q.height },
        id: 1,
      },
    ],
  });
  const collection = {
    name,
    // Only the game's own audio goes out; unmute these in OBS to add them.
    DesktopAudioDevice1: source("wasapi_output_capture", "Desktop Audio", { device_id: "default" }, true),
    AuxAudioDevice1: source("wasapi_input_capture", "Mic/Aux", { device_id: "default" }, true),
    sources: [game, scene],
    groups: [],
    scene_order: [{ name: scene.name }],
    current_scene: scene.name,
    current_program_scene: scene.name,
    transitions: [],
    current_transition: "Fade",
    transition_duration: 300,
    quick_transitions: [],
    saved_projectors: [],
    modules: {},
    version: 2,
  };

  const readme = [
    `OBS setup for the "${opts.roomId}" room`,
    "",
    "1. Unzip this folder.",
    `2. In OBS: Profile > Import, and pick the "${name}" folder.`,
    `   Then Profile > ${name} to switch to it.`,
    `3. Scene Collection > Import, click "...", pick "${name}.json", then Import.`,
    `   Then Scene Collection > ${name} to switch to it.`,
    "4. Start your game in fullscreen or borderless fullscreen, then click Start Streaming.",
    "",
    "Only the game's sound is streamed. Desktop Audio and Mic/Aux are muted; unmute them in OBS if you want them.",
    "If the game runs in a window, double-click the Game source and set Mode to \"Capture specific window\".",
    "",
    "The profile contains your stream token: anyone with this file can stream into the room as you.",
    "Making a new token in the room's OBS panel stops this one working.",
    "",
  ].join("\r\n");

  return zip([
    { path: `${name}/${name}/basic.ini`, content: profile },
    {
      path: `${name}/${name}/service.json`,
      content: JSON.stringify({ type: "whip_custom", settings: { service: "WHIP", server: opts.server, bearer_token: opts.token } }),
    },
    { path: `${name}/${name}/streamEncoder.json`, content: JSON.stringify(enc.settings) },
    { path: `${name}/${name}.json`, content: JSON.stringify(collection, null, 2) },
    { path: `${name}/Read me.txt`, content: readme },
  ]);
}
