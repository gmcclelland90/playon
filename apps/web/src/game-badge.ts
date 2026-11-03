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
