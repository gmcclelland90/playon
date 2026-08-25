import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { count, eq } from "drizzle-orm";
import { PASSWORD_RESET_FILE_NAME } from "@playon/shared";
import { hashPassword } from "../auth/password.js";
import { destroySessionsForUser, type AuthUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import {
  clearMfaAfterHostFileReset,
  resetMethodsFor,
  verifyUserTotpOrBackup,
  type ResetMethod,
} from "./mfa.js";

export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_MAX_ATTEMPTS = 5;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type PasswordResetStartResult = {
  ok: true;
  methods: ResetMethod[];
  fileName?: typeof PASSWORD_RESET_FILE_NAME;
  expiresAt?: string;
  dataRoot?: string;
};

type ResetFileRecord = {
  username: string;
  expiresAt: string;
  code: string;
  attempts: number;
};

export function passwordResetFilePath(dataRoot: string): string {
  return path.join(dataRoot, PASSWORD_RESET_FILE_NAME);
}

export function requestIsOnBox(requestUrl: string): boolean {
  try {
    const host = new URL(requestUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function generateResetCode(bytes = randomBytes(16)): string {
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}

export function normalizeResetCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function codesMatch(submitted: string, expected: string): boolean {
  const a = Buffer.from(normalizeResetCode(submitted));
  const b = Buffer.from(normalizeResetCode(expected));
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function formatResetFile(record: ResetFileRecord): string {
  return [
    "PlayOn password reset",
    "",
    "Reading this file on the PlayOn host is how you prove you administer this box.",
    "Paste the code on the sign-in screen. It expires and is single-use.",
    "",
    `Username: ${record.username}`,
    `Expires:  ${record.expiresAt}`,
    `Attempts: ${record.attempts}`,
    `Code:     ${record.code}`,
    "",
  ].join("\n");
}

export function parseResetFile(text: string): ResetFileRecord | null {
  const username = /^Username:\s+(\S+)\s*$/m.exec(text)?.[1];
  const expiresAt = /^Expires:\s+(\S+)\s*$/m.exec(text)?.[1];
  const attemptsRaw = /^Attempts:\s+(\d+)\s*$/m.exec(text)?.[1];
  const code = /^Code:\s+(\S+)\s*$/m.exec(text)?.[1];
  if (!username || !expiresAt || !code) return null;
  const attempts = attemptsRaw ? Number(attemptsRaw) : 0;
  if (!Number.isFinite(attempts) || attempts < 0) return null;
  return { username, expiresAt, code, attempts };
}

function readResetFile(dataRoot: string): ResetFileRecord | null {
  const file = passwordResetFilePath(dataRoot);
  if (!fs.existsSync(file)) return null;
  try {
    return parseResetFile(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeResetFile(dataRoot: string, record: ResetFileRecord): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  const file = passwordResetFilePath(dataRoot);
  fs.writeFileSync(file, formatResetFile(record), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
}

export function clearPasswordResetFile(dataRoot: string): void {
  const file = passwordResetFilePath(dataRoot);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

function publicStartView(
  methods: ResetMethod[],
  expiresAt: string | undefined,
  dataRoot: string,
  onBox: boolean,
  wroteFile: boolean,
): PasswordResetStartResult {
  return {
    ok: true,
    methods,
    ...(wroteFile
      ? {
          fileName: PASSWORD_RESET_FILE_NAME,
          expiresAt,
          ...(onBox ? { dataRoot } : {}),
        }
      : {}),
  };
}

export async function startPasswordReset(input: {
  db: Db;
  dataRoot: string;
  username: string;
  onBox: boolean;
  now?: number;
  code?: string;
}): Promise<PasswordResetStartResult> {
  const now = input.now ?? Date.now();
  const expiresAt = new Date(now + PASSWORD_RESET_TTL_MS).toISOString();
  const [{ value }] = await input.db.select({ value: count() }).from(users);
  if (value === 0) throw new Error("not_setup");

  const username = input.username.trim();
  const rows = await input.db.select().from(users).where(eq(users.username, username)).limit(1);
  const user = rows[0];
  if (!user) {
    return publicStartView(["host_file"], expiresAt, input.dataRoot, input.onBox, false);
  }

  const methods = resetMethodsFor(user);
  const writeFile = methods.includes("host_file");
  if (writeFile) {
    writeResetFile(input.dataRoot, {
      username: user.username,
      expiresAt,
      code: input.code ?? generateResetCode(),
      attempts: 0,
    });
  }
  return publicStartView(methods, expiresAt, input.dataRoot, input.onBox, writeFile);
}

export async function completePasswordReset(input: {
  db: Db;
  dataRoot: string;
  username: string;
  password: string;
  sessionSecret: string;
  hostFileCode?: string;
  totpCode?: string;
  backupCode?: string;
  now?: number;
}): Promise<AuthUser> {
  const now = input.now ?? Date.now();
  const username = input.username.trim();
  const hostFileCode = input.hostFileCode?.trim();
  const proofs = [hostFileCode, input.totpCode?.trim(), input.backupCode?.trim()].filter(Boolean);
  if (proofs.length !== 1) throw new Error("invalid_reset");

  const rows = await input.db.select().from(users).where(eq(users.username, username)).limit(1);
  const user = rows[0];
  if (!user) throw new Error("invalid_reset");

  if (hostFileCode) {
    if (user.hostFileResetEnabled === false) throw new Error("invalid_reset");
    await consumeHostFileCode({
      dataRoot: input.dataRoot,
      username,
      code: hostFileCode,
      now,
    });
    await clearMfaAfterHostFileReset(input.db, user.id);
  } else {
    await verifyUserTotpOrBackup(input.db, {
      userId: user.id,
      sessionSecret: input.sessionSecret,
      totpCode: input.totpCode,
      backupCode: input.backupCode,
      now,
    });
  }

  await input.db
    .update(users)
    .set({ passwordHash: hashPassword(input.password) })
    .where(eq(users.id, user.id));
  await destroySessionsForUser(input.db, user.id);
  if (hostFileCode) clearPasswordResetFile(input.dataRoot);

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role as AuthUser["role"],
  };
}

async function consumeHostFileCode(input: {
  dataRoot: string;
  username: string;
  code: string;
  now: number;
}): Promise<void> {
  const record = readResetFile(input.dataRoot);
  if (!record) throw new Error("invalid_reset");

  if (record.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
    clearPasswordResetFile(input.dataRoot);
    throw new Error("invalid_reset");
  }
  if (Date.parse(record.expiresAt) <= input.now) {
    clearPasswordResetFile(input.dataRoot);
    throw new Error("invalid_reset");
  }
  if (record.username !== input.username || !codesMatch(input.code, record.code)) {
    const next = { ...record, attempts: record.attempts + 1 };
    if (next.attempts >= PASSWORD_RESET_MAX_ATTEMPTS) {
      clearPasswordResetFile(input.dataRoot);
    } else {
      writeResetFile(input.dataRoot, next);
    }
    throw new Error("invalid_reset");
  }
}
