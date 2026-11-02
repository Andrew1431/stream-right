// Just enough H.264 to move WebRTC's Annex B frames into an MP4, which wants AVCC.

export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;
const NAL_AUD = 9;

export const nalType = (nal: Uint8Array) => nal[0] & 0x1f;

// NAL units between 00 00 01 / 00 00 00 01 start codes. Empty when the data isn't Annex B (VP8, say).
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; len: number }[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const four = i > 0 && data[i - 1] === 0;
      starts.push({ at: four ? i - 1 : i, len: four ? 4 : 3 });
      i += 2;
    }
  }
  if (!starts.length || starts[0].at !== 0) return [];
  const nals: Uint8Array[] = [];
  starts.forEach((s, n) => {
    const end = n + 1 < starts.length ? starts[n + 1].at : data.length;
    if (end > s.at + s.len) nals.push(data.subarray(s.at + s.len, end));
  });
  return nals;
}

// Length-prefixed NAL units, minus the parameter sets (they live in the avcC box) and delimiters.
export function toAvcc(nals: Uint8Array[]): Uint8Array {
  const keep = nals.filter((n) => ![NAL_SPS, NAL_PPS, NAL_AUD].includes(nalType(n)));
  const out = new Uint8Array(keep.reduce((sum, n) => sum + 4 + n.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const n of keep) {
    view.setUint32(at, n.length);
    out.set(n, at + 4);
    at += 4 + n.length;
  }
  return out;
}

export function avcDecoderConfig(sps: Uint8Array, pps: Uint8Array) {
  const hex = (b: number) => b.toString(16).padStart(2, "0");
  const description = new Uint8Array([
    1, sps[1], sps[2], sps[3], 0xff, 0xe1,
    sps.length >> 8, sps.length & 0xff, ...sps,
    1, pps.length >> 8, pps.length & 0xff, ...pps,
  ]);
  const { width, height } = spsSize(sps);
  return {
    codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`,
    codedWidth: width,
    codedHeight: height,
    description,
  };
}

class Bits {
  private bit = 0;
  constructor(private data: Uint8Array) {}
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.bit >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0 && zeros < 32) zeros++;
    return (1 << zeros) - 1 + this.u(zeros);
  }
  se(): number {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -v / 2;
  }
}

// Display size from a sequence parameter set (ITU-T H.264 7.3.2.1.1).
export function spsSize(sps: Uint8Array): { width: number; height: number } {
  // Drop emulation prevention bytes (00 00 03 → 00 00).
  const raw: number[] = [];
  for (let i = 1; i < sps.length; i++) {
    if (i >= 3 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    raw.push(sps[i]);
  }
  const b = new Bits(new Uint8Array(raw));
  const profile = b.u(8);
  b.u(16); // constraint flags, level
  b.ue(); // sps id
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = b.ue();
    if (chroma === 3) b.u(1);
    b.ue();
    b.ue();
    b.u(1);
    if (b.u(1)) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!b.u(1)) continue;
        let last = 8;
        let next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64) && next !== 0; j++) {
          next = (last + b.se() + 256) % 256;
          last = next || last;
        }
      }
    }
  }
  b.ue(); // log2_max_frame_num
  const pocType = b.ue();
  if (pocType === 0) b.ue();
  else if (pocType === 1) {
    b.u(1);
    b.se();
    b.se();
    const n = b.ue();
    for (let i = 0; i < n; i++) b.se();
  }
  b.ue(); // max_num_ref_frames
  b.u(1);
  const widthMbs = b.ue() + 1;
  const heightUnits = b.ue() + 1;
  const frameMbsOnly = b.u(1);
  if (!frameMbsOnly) b.u(1);
  b.u(1);
  let [left, right, top, bottom] = [0, 0, 0, 0];
  if (b.u(1)) [left, right, top, bottom] = [b.ue(), b.ue(), b.ue(), b.ue()];
  const unitX = chroma === 1 || chroma === 2 ? 2 : 1;
  const unitY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return {
    width: widthMbs * 16 - (left + right) * unitX,
    height: (2 - frameMbsOnly) * heightUnits * 16 - (top + bottom) * unitY,
  };
}
