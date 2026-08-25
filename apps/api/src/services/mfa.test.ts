import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { currentTotpStep, totpAt } from "../auth/totp.js";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { users } from "../db/schema.js";
import {
  completeMfaPending,
  confirmTotpEnroll,
  createMfaPending,
  disableTotp,
  seedTotpForTests,
  setHostFileResetEnabled,
  startTotpEnroll,
} from "./mfa.js";

const temps: string[] = [];
const SESSION_SECRET = "test-session-secret-at-least-32-chars!!";

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function seedOwner() {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-mfa-"));
  temps.push(dataRoot);
  const dbPath = path.join(dataRoot, "playon.db");
  applyBootstrap(dbPath);
  const { db } = createDb(dbPath);
  await db.insert(users).values({
    id: "owner-1",
    username: "host",
    displayName: "LAN Host",
    passwordHash: hashPassword("password123"),
    role: "owner",
    createdAt: new Date(),
  });
  return db;
}

describe("authenticator MFA", () => {
  it("enrolls after a confirming TOTP and can disable host-file reset", async () => {
    const db = await seedOwner();
    const started = await startTotpEnroll(db, { userId: "owner-1", sessionSecret: SESSION_SECRET });
    expect(started.otpauthUrl).toContain("otpauth://totp/PlayOn:host");
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    const code = totpAt(started.secret, currentTotpStep(now));
    const confirmed = await confirmTotpEnroll(db, {
      userId: "owner-1",
      sessionSecret: SESSION_SECRET,
      code,
      disableHostFileReset: true,
      now,
    });
    expect(confirmed.totpEnabled).toBe(true);
    expect(confirmed.hostFileResetEnabled).toBe(false);
    expect(confirmed.backupCodes).toHaveLength(8);
    expect(confirmed.backupCodes[0]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("rejects a wrong enroll code and does not enable MFA", async () => {
    const db = await seedOwner();
    await startTotpEnroll(db, { userId: "owner-1", sessionSecret: SESSION_SECRET });
    await expect(
      confirmTotpEnroll(db, {
        userId: "owner-1",
        sessionSecret: SESSION_SECRET,
        code: "000000",
      }),
    ).rejects.toThrow(/invalid_totp/);
    const [row] = await db.select().from(users);
    expect(row?.totpEnabled).toBe(false);
  });

  it("completes a pending login with TOTP or a backup code", async () => {
    const db = await seedOwner();
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    const seeded = await seedTotpForTests(db, { userId: "owner-1", sessionSecret: SESSION_SECRET });
    const token = await createMfaPending(db, { userId: "owner-1", now });
    const user = await completeMfaPending(db, {
      sessionSecret: SESSION_SECRET,
      mfaToken: token,
      code: totpAt(seeded.secret, currentTotpStep(now)),
      now,
    });
    expect(user.username).toBe("host");

    const token2 = await createMfaPending(db, { userId: "owner-1", now: now + 60_000 });
    const viaBackup = await completeMfaPending(db, {
      sessionSecret: SESSION_SECRET,
      mfaToken: token2,
      code: seeded.backupCodes[0]!,
      now: now + 60_000,
    });
    expect(viaBackup.id).toBe("owner-1");
    await expect(
      completeMfaPending(db, {
        sessionSecret: SESSION_SECRET,
        mfaToken: token2,
        code: seeded.backupCodes[0]!,
        now: now + 60_000,
      }),
    ).rejects.toThrow(/invalid_totp/);
  });

  it("refuses to disable host-file reset without TOTP, and disabling MFA turns it back on", async () => {
    const db = await seedOwner();
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    await expect(
      setHostFileResetEnabled(db, {
        userId: "owner-1",
        sessionSecret: SESSION_SECRET,
        enabled: false,
        code: "123456",
        now,
      }),
    ).rejects.toThrow(/mfa_required/);
    const seeded = await seedTotpForTests(db, { userId: "owner-1", sessionSecret: SESSION_SECRET });
    const code = totpAt(seeded.secret, currentTotpStep(now));
    const toggled = await setHostFileResetEnabled(db, {
      userId: "owner-1",
      sessionSecret: SESSION_SECRET,
      enabled: false,
      code,
      now,
    });
    expect(toggled).toEqual({ totpEnabled: true, hostFileResetEnabled: false });
    const later = now + 60_000;
    const disabled = await disableTotp(db, {
      userId: "owner-1",
      sessionSecret: SESSION_SECRET,
      code: totpAt(seeded.secret, currentTotpStep(later)),
      now: later,
    });
    expect(disabled).toEqual({ totpEnabled: false, hostFileResetEnabled: true });
  });
});
