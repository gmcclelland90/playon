/** Short badge text for a game id: "project-zomboid" → "PZ", "valheim" → "VA". */
export function gameBadgeText(game: string | null | undefined): string {
  const words = (game ?? "").split(/[^a-z0-9]+/i).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Hand-picked hues for common LAN games, matched by id prefix. */
const KNOWN_HUES: Array<[prefix: string, hue: number]> = [
  ["project-zomboid", 40],
  ["minecraft", 145],
  ["rust", 25],
  ["valheim", 235],
  ["terraria", 165],
  ["factorio", 60],
  ["satisfactory", 55],
  ["palworld", 200],
  ["ark", 95],
  ["7-days", 30],
  ["stormworks", 220],
];

const BRAND_HUE = 353;

/**
 * Stable OKLCH hue per game so the same game keeps its color everywhere.
 * Unknown games hash to a hue, pushed away from brand rose so a game badge
 * never reads as a primary action.
 */
export function gameHue(game: string | null | undefined): number {
  const key = (game ?? "").toLowerCase();
  if (!key) return BRAND_HUE;
  const known = KNOWN_HUES.find(([prefix]) => key.startsWith(prefix));
  if (known) return known[1];
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const nearBrand = Math.min(Math.abs(hue - BRAND_HUE), 360 - Math.abs(hue - BRAND_HUE)) < 30;
  return nearBrand ? (hue + 180) % 360 : hue;
}

/** OKLCH → 0xRRGGBB for Pixi, which only takes sRGB numbers. Out-of-gamut channels clamp. */
export function oklchToHex(l: number, c: number, h: number): number {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const [r, g, bl] = lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    const srgb = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  });
  return (r! << 16) | (g! << 8) | bl!;
}
