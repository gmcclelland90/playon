/**
 * Minimal pure-JS PNG decode / downscale / encode for game-ready mod assets
 * (#988). No native deps so Home packaging stays unchanged.
 *
 * Decode supports 8-bit, non-interlaced greyscale, RGB, grey+alpha and RGBA,
 * which covers fal image output (flux PNG, BiRefNet cutouts). Anything else
 * throws `PngLiteError` so callers fail closed instead of writing garbage.
 */
import { unzlibSync, zlibSync } from "fflate";

export class PngLiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngLiteError";
  }
}

export type RgbaImage = { width: number; height: number; data: Uint8Array };

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
/** Refuse absurd dimensions before allocating (fal output is ≤ 2048²). */
const MAX_PIXELS = 4096 * 4096;

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE.length) return false;
  return SIGNATURE.every((b, i) => bytes[i] === b);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes)) throw new PngLiteError("png_bad_signature");
  let offset = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new PngLiteError("png_truncated");
    if (type === "IHDR") {
      width = readU32(body, 0);
      height = readU32(body, 4);
      const bitDepth = body[8];
      colorType = body[9]!;
      const interlace = body[12];
      if (bitDepth !== 8 || interlace !== 0 || !(colorType in CHANNELS)) {
        throw new PngLiteError("png_unsupported_format");
      }
      if (!width || !height || width * height > MAX_PIXELS) {
        throw new PngLiteError("png_bad_dimensions");
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (colorType < 0 || idat.length === 0) throw new PngLiteError("png_missing_chunks");

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of idat) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  const raw = unzlibSync(joined);
  const channels = CHANNELS[colorType]!;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new PngLiteError("png_truncated");

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= channels ? prev[x - channels]! : 0;
      const v = src[x]!;
      switch (filter) {
        case 0:
          row[x] = v;
          break;
        case 1:
          row[x] = v + a;
          break;
        case 2:
          row[x] = v + b;
          break;
        case 3:
          row[x] = v + ((a + b) >> 1);
          break;
        case 4:
          row[x] = v + paeth(a, b, c);
          break;
        default:
          throw new PngLiteError("png_bad_filter");
      }
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (colorType === 0) {
      data[o] = data[o + 1] = data[o + 2] = pixels[j]!;
      data[o + 3] = 255;
    } else if (colorType === 4) {
      data[o] = data[o + 1] = data[o + 2] = pixels[j]!;
      data[o + 3] = pixels[j + 1]!;
    } else {
      data[o] = pixels[j]!;
      data[o + 1] = pixels[j + 1]!;
      data[o + 2] = pixels[j + 2]!;
      data[o + 3] = colorType === 6 ? pixels[j + 3]! : 255;
    }
  }
  return { width, height, data };
}

/**
 * Center-crop to a square, then area-average down to `size`×`size`.
 * Colour is averaged alpha-weighted so transparent edges don't go dark.
 * Never upscales: a smaller source keeps its own (square) size.
 */
export function squareDownscale(img: RgbaImage, size: number): RgbaImage {
  const side = Math.min(img.width, img.height);
  const x0 = Math.floor((img.width - side) / 2);
  const y0 = Math.floor((img.height - side) / 2);
  const out = Math.max(1, Math.min(size, side));
  const data = new Uint8Array(out * out * 4);
  const scale = side / out;
  for (let oy = 0; oy < out; oy++) {
    const sy0 = Math.floor(oy * scale);
    const sy1 = Math.max(sy0 + 1, Math.floor((oy + 1) * scale));
    for (let ox = 0; ox < out; ox++) {
      const sx0 = Math.floor(ox * scale);
      const sx1 = Math.max(sx0 + 1, Math.floor((ox + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = ((y0 + sy) * img.width + (x0 + sx)) * 4;
          const alpha = img.data[i + 3]!;
          r += img.data[i]! * alpha;
          g += img.data[i + 1]! * alpha;
          b += img.data[i + 2]! * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (oy * out + ox) * 4;
      if (a > 0) {
        data[o] = Math.round(r / a);
        data[o + 1] = Math.round(g / a);
        data[o + 2] = Math.round(b / a);
      }
      data[o + 3] = Math.round(a / n);
    }
  }
  return { width: out, height: out, data };
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encode RGBA (colour type 6, filter 0). */
export function encodePng(img: RgbaImage): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, img.width);
  view.setUint32(4, img.height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = new Uint8Array(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
