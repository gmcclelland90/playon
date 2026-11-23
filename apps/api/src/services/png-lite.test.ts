import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng, isPng, PngLiteError, squareDownscale } from "./png-lite.js";

describe("png-lite", () => {
  it("round-trips RGBA through encode/decode", () => {
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
    const png = encodePng({ width: 2, height: 2, data });
    expect(isPng(png)).toBe(true);
    const back = decodePng(png);
    expect(back.width).toBe(2);
    expect(Array.from(back.data)).toEqual(Array.from(data));
  });

  it("decodes RGB with Sub/Up/Average/Paeth filters", () => {
    // Hand-build a 2x4 RGB PNG, one filter type per row, all pixels (10, 20, 30).
    const width = 2;
    const rows: number[][] = [
      [1, 10, 20, 30, 0, 0, 0], // Sub
      [2, 0, 0, 0, 0, 0, 0], // Up
      [3, 5, 10, 15, 0, 0, 0], // Average: floor((left + up) / 2)
      [4, 0, 0, 0, 0, 0, 0], // Paeth picks up
    ];
    const raw = new Uint8Array(rows.flat());
    const ihdr = new Uint8Array([0, 0, 0, width, 0, 0, 0, 4, 8, 2, 0, 0, 0]);
    const png = buildPng(ihdr, zlibSync(raw));
    const img = decodePng(png);
    for (let i = 0; i < 8; i++) {
      expect(Array.from(img.data.subarray(i * 4, i * 4 + 4))).toEqual([10, 20, 30, 255]);
    }
  });

  it("downscales with center crop and alpha-weighted colour", () => {
    // 4x2: left half transparent black, right half opaque white → crop to centre 2x2.
    const data = new Uint8Array(4 * 2 * 4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const o = (y * 4 + x) * 4;
        if (x >= 2) data.set([255, 255, 255, 255], o);
      }
    }
    const out = squareDownscale({ width: 4, height: 2, data }, 1);
    expect(out.width).toBe(1);
    // Half the area is opaque white: colour stays white, alpha halves.
    expect(Array.from(out.data)).toEqual([255, 255, 255, 128]);
  });

  it("never upscales", () => {
    const out = squareDownscale({ width: 8, height: 8, data: new Uint8Array(256) }, 64);
    expect(out.width).toBe(8);
  });

  it("rejects non-PNG and unsupported formats", () => {
    expect(() => decodePng(new Uint8Array([0xff, 0xd8]))).toThrow(PngLiteError);
    const ihdr16 = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 16, 6, 0, 0, 0]);
    expect(() => decodePng(buildPng(ihdr16, zlibSync(new Uint8Array(9))))).toThrow(
      /png_unsupported_format/,
    );
  });
});

function buildPng(ihdr: Uint8Array, idat: Uint8Array): Uint8Array {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const chunk = (type: string, body: Uint8Array) => {
    const len = body.length;
    // CRC is not checked by the decoder; zeros are fine for tests.
    return [
      (len >>> 24) & 255,
      (len >>> 16) & 255,
      (len >>> 8) & 255,
      len & 255,
      ...Array.from(type, (c) => c.charCodeAt(0)),
      ...body,
      0,
      0,
      0,
      0,
    ];
  };
  return new Uint8Array([
    ...sig,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array()),
  ]);
}
