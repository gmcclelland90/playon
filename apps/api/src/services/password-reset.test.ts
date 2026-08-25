import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { createSession } from "../auth/session.js";
import { currentTotpStep, totpAt } from "../auth/totp.js";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { sessions, users } from "../db/schema.js";
import { seedTotpForTests } from "./mfa.js";
import {
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_TTL_MS,
  codesMatch,
  completePasswordReset,
  formatResetFile,
  generateResetCode,
  normalizeResetCode,
  parseResetFile,
  passwordResetFilePath,
  requestIsOnBox,
  startPasswordReset,
} from "./password-reset.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function seedOwner(dataRoot: string, password = "password123") {
  temps.push(dataRoot);
  const dbPath = path.join(dataRoot, "playon.db");
  applyBootstrap(dbPath);
  const { db } = createDb(dbPath);
  await db.insert(users).values({
    id: "owner-1",
    username: "host",
    displayName: "LAN Host",
    passwordHash: hashPassword(password),
    role: "owner",
    createdAt: new Date(),
  });
  return db;
}

describe("password reset file challenge", () => {
  it("round-trips the host file and ignores dashes in the code", () => {
    const code = generateResetCode();
    const text = formatResetFile({
      username: "host",
      expiresAt: "2026-08-25T00:00:00.000Z",
      attempts: 0,
      code,
    });
    expect(text).toContain("prove you administer this box");
    expect(parseResetFile(text)).toEqual({
      username: "host",
      expiresAt: "2026-08-25T00:00:00.000Z",
      attempts: 0,
      code,
    });
    expect(codesMatch(code.toLowerCase().replaceAll("-", " "), code)).toBe(true);
    expect(codesMatch("AAAA-AAAA-AAAA-AAAA", "BBBB-BBBB-BBBB-BBBB")).toBe(false);
    expect(normalizeResetCode("ab12-cd34")).toBe("AB12CD34");
  });

  it("treats loopback Host as on-box and LAN hosts as off-box", () => {
    expect(requestIsOnBox("http://127.0.0.1:8787/api/auth/password-reset/start")).toBe(true);
    expect(requestIsOnBox("http://localhost:5173/login")).toBe(true);
    expect(requestIsOnBox("http://172.16.0.156:8787/api/auth/password-reset/start")).toBe(false);
    expect(requestIsOnBox("http://playon.local/login")).toBe(false);
  });

  it("writes a host-only code file and never returns the code", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-reset-"));
    const db = await seedOwner(dataRoot);
    const started = await startPasswordReset({
      db,
      dataRoot,
      username: "host",
      onBox: false,
      code: "ABCD-EFGH-IJKL-MNOP",
    });
    expect(started).toEqual({
      ok: true,
      methods: ["host_file"],
      fileName: "password-reset.txt",
      expiresAt: started.expiresAt,
    });
    expect(JSON.stringify(started)).not.toContain("ABCD");
    const file = passwordResetFilePath(dataRoot);
    const body = readFileSync(file, "utf8");
    expect(body).toContain("ABCD-EFGH-IJKL-MNOP");
    expect(body).toContain("Username: host");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("includes dataRoot only for on-box callers", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-reset-"));
    const db = await seedOwner(dataRoot);
    const lan = await startPasswordReset({ db, dataRoot, username: "host", onBox: false });
    expect(lan.dataRoot).toBeUndefined();
    const local = await startPasswordReset({ db, dataRoot, username: "host", onBox: true });
    expect(local.dataRoot).toBe(dataRoot);
  });

  it("does not write a file for an unknown username and does not clobber an in-flight reset", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-reset-"));
    const db = await seedOwner(dataRoot);
    await startPasswordReset({
      db,
      dataRoot,
      username: "host",
      onBox: false,
      code: "KEEP-THIS-CODE-FILE",
    });
    const unknown = await startPasswordReset({
      db,
      dataRoot,
      username: "nobody",
      onBox: false,
      code: "SHOULD-NOT-WRITE",
    });
    expect(unknown.ok).toBe(true);
    expect(readFileSync(passwordResetFilePath(dataRoot), "utf8")).toContain("KEEP-THIS-CODE-FILE");
    expect(readFileSync(passwordResetFilePath(dataRoot), "utf8")).not.toContain("SHOULD-NOT-WRITE");
  });

  it("rejects start before owner bootstrap", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-reset-"));
    temps.push(dataRoot);
    const dbPath = path.join(dataRoot, "playon.db");
    applyBootstrap(dbPath);
    const { db } = createDb(dbPath);
    await expect(
      startPasswordReset({ db, dataRoot, username: "host", onBox: false }),
    ).rejects.toThrow(/not_setup/);
  });

  it("sets a new password when the host file code matches and drops other sessions", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-reset-"));
    const db = await seedOwner(dataRoot, "old-password");
    await createSession(db, "owner-1");
    await startPasswordReset({
      db,
      dataRoot,
      username: "host",
      onBox: false,
      code: "ZZZZ-YYYY-XXXX-WWWW",
    });

    const user = await completePasswordReset({
      db,
      dataRoot,
      username: "host",
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      hostFileCode: "zzzz yyyy xxxx wwww",
      password: "new-password",
    });
    expect(user).toEqual({
      id: "owner-1",
      username: "host",
      displayName: "LAN Host",
      role: "owner",
    });
    expect(existsSync(passwordResetFilePath(dataRoot))).toBe(false);

    const rows = await db.select().from(users).where(eq(users.username, "host"));
    expect(verifyPassword("new-password", rows[0]!.passwordHash)).toBe(true);
    expect(verifyPassword("old-password", rows[0]!.passwordHash)).toBe(false);
    expect(await db.select().from(sessions)).toEqual([]);
  });

  it("fails closed on a wrong code without changing the password", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-reset-"));
    const db = await seedOwner(dataRoot, "old-password");
    await startPasswordReset({
      db,
      dataRoot,
      username: "host",
      onBox: false,
      code: "RIGHT-CODE-RIGHT-NOW",
    });
    await expect(
      completePasswordReset({
        db,
        dataRoot,
        username: "host",
        sessionSecret: "test-session-secret-at-least-32-chars!!",
        hostFileCode: "WRONG-CODE-WRONG-NOW",
        password: "new-password",
      }),
    ).rejects.toThrow(/invalid_reset/);
    const rows = await db.select().from(users).where(eq(users.username, "host"));
    expect(verifyPassword("old-password", rows[0]!.passwordHash)).toBe(true);
    expect(readFileSync(passwordResetFilePath(dataRoot), "utf8")).toContain("Attempts: 1");
  });

  it("expires the challenge and locks out after too many guesses", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-reset-"));
    const db = await seedOwner(dataRoot);
    const t0 = Date.parse("2026-08-25T00:00:00.000Z");
    await startPasswordReset({
      db,
      dataRoot,
      username: "host",
      onBox: false,
      now: t0,
      code: "LIVE-CODE-LIVE-CODE",
    });
    await expect(
      completePasswordReset({
        db,
        dataRoot,
        username: "host",
        sessionSecret: "test-session-secret-at-least-32-chars!!",
        hostFileCode: "LIVE-CODE-LIVE-CODE",
        password: "new-password",
        now: t0 + PASSWORD_RESET_TTL_MS + 1,
      }),
    ).rejects.toThrow(/invalid_reset/);

    await startPasswordReset({
      db,
      dataRoot,
      username: "host",
      onBox: false,
      now: t0,
      code: "LOCK-THIS-CODE-NOW",
    });
    for (let i = 0; i < PASSWORD_RESET_MAX_ATTEMPTS; i++) {
      await expect(
        completePasswordReset({
          db,
          dataRoot,
          username: "host",
          sessionSecret: "test-session-secret-at-least-32-chars!!",
          hostFileCode: "NOPE-NOPE-NOPE-NOPE",
          password: "new-password",
          now: t0,
        }),
      ).rejects.toThrow(/invalid_reset/);
    }
    expect(existsSync(passwordResetFilePath(dataRoot))).toBe(false);
  });

  it("resets via TOTP when host-file recovery is disabled and does not write a file", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-reset-"));
    const db = await seedOwner(dataRoot, "old-password");
    const seeded = await seedTotpForTests(db, {
      userId: "owner-1",
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      hostFileResetEnabled: false,
    });
    const started = await startPasswordReset({ db, dataRoot, username: "host", onBox: false });
    expect(started.methods).toEqual(["totp"]);
    expect(started.fileName).toBeUndefined();
    expect(existsSync(passwordResetFilePath(dataRoot))).toBe(false);

    const now = Date.parse("2026-08-25T00:00:00.000Z");
    const user = await completePasswordReset({
      db,
      dataRoot,
      username: "host",
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      totpCode: totpAt(seeded.secret, currentTotpStep(now)),
      password: "new-password",
      now,
    });
    expect(user.username).toBe("host");
    const rows = await db.select().from(users).where(eq(users.username, "host"));
    expect(verifyPassword("new-password", rows[0]!.passwordHash)).toBe(true);
    expect(rows[0]!.totpEnabled).toBe(true);
  });
});
