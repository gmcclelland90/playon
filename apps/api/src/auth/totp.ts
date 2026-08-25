import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;
const DIGITS = 6;
const WINDOW = 1;

export const TOTP_ISSUER = "PlayOn";

export function generateTotpSecret(bytes = randomBytes(20)): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("invalid_totp_secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, step: number): string {
  const key = decodeBase32(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function currentTotpStep(now = Date.now()): number {
  return Math.floor(now / STEP_MS);
}

function digitsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a.padStart(DIGITS, "0"));
  const right = Buffer.from(b.padStart(DIGITS, "0"));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function normalizeTotpCode(code: string): string {
  return code.replace(/\s+/g, "");
}

export function verifyTotp(
  secret: string,
  code: string,
  opts: { now?: number; lastStep?: number | null } = {},
): { ok: true; step: number } | { ok: false } {
  const submitted = normalizeTotpCode(code);
  if (!/^\d{6}$/.test(submitted)) return { ok: false };
  const now = opts.now ?? Date.now();
  const current = currentTotpStep(now);
  let matched: number | undefined;
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const step = current + delta;
    if (opts.lastStep != null && step <= opts.lastStep) continue;
    if (digitsMatch(totpAt(secret, step), submitted)) matched = step;
  }
  if (matched == null) return { ok: false };
  return { ok: true, step: matched };
}

export function otpauthUrl(input: { secret: string; account: string; issuer?: string }): string {
  const issuer = input.issuer ?? TOTP_ISSUER;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
