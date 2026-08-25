import { describe, expect, it } from "vitest";
import {
  currentTotpStep,
  generateTotpSecret,
  otpauthUrl,
  totpAt,
  verifyTotp,
} from "./totp.js";

describe("TOTP", () => {
  it("round-trips a 6-digit code in the current window", () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    const step = currentTotpStep(now);
    const code = totpAt(secret, step);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code, { now })).toEqual({ ok: true, step });
    expect(verifyTotp(secret, "000000", { now }).ok).toBe(false);
  });

  it("accepts an adjacent 30s step and rejects a reused step", () => {
    const secret = generateTotpSecret();
    const now = Date.parse("2026-08-25T00:00:15.000Z");
    const prev = totpAt(secret, currentTotpStep(now) - 1);
    const verified = verifyTotp(secret, prev, { now });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verifyTotp(secret, prev, { now, lastStep: verified.step }).ok).toBe(false);
  });

  it("builds an otpauth URI for authenticator apps", () => {
    const url = otpauthUrl({ secret: "MFRGGZDFMZTWQ2LK", account: "host" });
    expect(url.startsWith("otpauth://totp/PlayOn:host?")).toBe(true);
    expect(url).toContain("secret=MFRGGZDFMZTWQ2LK");
    expect(url).toContain("issuer=PlayOn");
  });
});
