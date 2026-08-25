import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sha256 } from "../auth/password.js";
import { type AuthUser } from "../auth/session.js";
import {
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
} from "../auth/totp.js";
import type { Db } from "../db/client.js";
import { mfaPending, users } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

export const MFA_PENDING_TTL_MS = 5 * 60 * 1000;
export const MFA_PENDING_MAX_ATTEMPTS = 5;
export const BACKUP_CODE_COUNT = 8;

const BACKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type ResetMethod = "host_file" | "totp";

export type MfaStatus = {
  totpEnabled: boolean;
  hostFileResetEnabled: boolean;
};

function asUser(row: {
  id: string;
  username: string;
  displayName: string;
  role: string;
}): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role as AuthUser["role"],
  };
}

function parseBackupHashes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let out = "";
    for (let j = 0; j < 8; j++) {
      out += BACKUP_ALPHABET[bytes[j]! % BACKUP_ALPHABET.length];
      if (j === 3) out += "-";
    }
    codes.push(out);
  }
  return codes;
}

export function hashBackupCode(code: string): string {
  return sha256(code.toUpperCase().replace(/[^A-Z0-9]/g, ""));
}

function consumeBackupCode(hashes: string[], code: string): string[] | null {
  const target = hashBackupCode(code);
  const idx = hashes.indexOf(target);
  if (idx < 0) return null;
  return hashes.filter((_, i) => i !== idx);
}

async function loadUserById(db: Db, userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0];
}

export function mfaStatusFor(row: {
  totpEnabled: boolean;
  hostFileResetEnabled: boolean;
}): MfaStatus {
  return {
    totpEnabled: Boolean(row.totpEnabled),
    hostFileResetEnabled: row.hostFileResetEnabled !== false,
  };
}

export function resetMethodsFor(row: {
  totpEnabled: boolean;
  hostFileResetEnabled: boolean;
}): ResetMethod[] {
  const methods: ResetMethod[] = [];
  if (row.hostFileResetEnabled !== false) methods.push("host_file");
  if (row.totpEnabled) methods.push("totp");
  return methods.length ? methods : ["host_file"];
}

export async function startTotpEnroll(
  db: Db,
  input: { userId: string; sessionSecret: string; now?: number },
): Promise<{ otpauthUrl: string; secret: string }> {
  const user = await loadUserById(db, input.userId);
  if (!user) throw new Error("unauthorized");
  if (user.totpEnabled) throw new Error("mfa_already_enabled");
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({
      totpSecretEncrypted: encryptSecret(input.sessionSecret, secret),
      totpEnabled: false,
      totpLastStep: null,
      totpEnrolledAt: null,
    })
    .where(eq(users.id, user.id));
  return {
    secret,
    otpauthUrl: otpauthUrl({ secret, account: user.username }),
  };
}

export async function confirmTotpEnroll(
  db: Db,
  input: {
    userId: string;
    sessionSecret: string;
    code: string;
    disableHostFileReset?: boolean;
    now?: number;
  },
): Promise<{ backupCodes: string[]; totpEnabled: true; hostFileResetEnabled: boolean }> {
  const user = await loadUserById(db, input.userId);
  if (!user) throw new Error("unauthorized");
  if (user.totpEnabled) throw new Error("mfa_already_enabled");
  if (!user.totpSecretEncrypted) throw new Error("mfa_enroll_required");
  const secret = decryptSecret(input.sessionSecret, user.totpSecretEncrypted);
  const verified = verifyTotp(secret, input.code, { now: input.now });
  if (!verified.ok) throw new Error("invalid_totp");
  const disableHost = Boolean(input.disableHostFileReset);
  const backupCodes = generateBackupCodes();
  await db
    .update(users)
    .set({
      totpEnabled: true,
      totpEnrolledAt: new Date(input.now ?? Date.now()),
      totpLastStep: verified.step,
      hostFileResetEnabled: !disableHost,
      mfaBackupHashesJson: JSON.stringify(backupCodes.map(hashBackupCode)),
    })
    .where(eq(users.id, user.id));
  return {
    backupCodes,
    totpEnabled: true,
    hostFileResetEnabled: !disableHost,
  };
}

export async function cancelTotpEnroll(db: Db, userId: string): Promise<void> {
  const user = await loadUserById(db, userId);
  if (!user || user.totpEnabled) return;
  await db
    .update(users)
    .set({
      totpSecretEncrypted: null,
      totpEnrolledAt: null,
      totpLastStep: null,
    })
    .where(eq(users.id, userId));
}

export async function disableTotp(
  db: Db,
  input: { userId: string; sessionSecret: string; code: string; now?: number },
): Promise<MfaStatus> {
  const user = await loadUserById(db, input.userId);
  if (!user) throw new Error("unauthorized");
  if (!user.totpEnabled || !user.totpSecretEncrypted) throw new Error("mfa_not_enabled");
  const secret = decryptSecret(input.sessionSecret, user.totpSecretEncrypted);
  const verified = verifyTotp(secret, input.code, {
    now: input.now,
    lastStep: user.totpLastStep,
  });
  const backupNext = consumeBackupCode(parseBackupHashes(user.mfaBackupHashesJson), input.code);
  if (!verified.ok && !backupNext) throw new Error("invalid_totp");
  await db
    .update(users)
    .set({
      totpSecretEncrypted: null,
      totpEnabled: false,
      totpEnrolledAt: null,
      totpLastStep: null,
      hostFileResetEnabled: true,
      mfaBackupHashesJson: null,
    })
    .where(eq(users.id, user.id));
  return { totpEnabled: false, hostFileResetEnabled: true };
}

export async function setHostFileResetEnabled(
  db: Db,
  input: {
    userId: string;
    sessionSecret: string;
    enabled: boolean;
    code: string;
    now?: number;
  },
): Promise<MfaStatus> {
  const user = await loadUserById(db, input.userId);
  if (!user) throw new Error("unauthorized");
  if (!input.enabled && !user.totpEnabled) throw new Error("mfa_required");
  if (!user.totpEnabled || !user.totpSecretEncrypted) throw new Error("mfa_required");
  const secret = decryptSecret(input.sessionSecret, user.totpSecretEncrypted);
  const verified = verifyTotp(secret, input.code, {
    now: input.now,
    lastStep: user.totpLastStep,
  });
  if (!verified.ok) throw new Error("invalid_totp");
  await db
    .update(users)
    .set({
      hostFileResetEnabled: input.enabled,
      totpLastStep: verified.step,
    })
    .where(eq(users.id, user.id));
  return { totpEnabled: true, hostFileResetEnabled: input.enabled };
}

export async function createMfaPending(
  db: Db,
  input: { userId: string; now?: number },
): Promise<string> {
  const now = input.now ?? Date.now();
  const token = nanoid(32);
  await db.insert(mfaPending).values({
    tokenHash: sha256(token),
    userId: input.userId,
    expiresAt: new Date(now + MFA_PENDING_TTL_MS),
    attempts: 0,
    createdAt: new Date(now),
  });
  return token;
}

export async function completeMfaPending(
  db: Db,
  input: { sessionSecret: string; mfaToken: string; code: string; now?: number },
): Promise<AuthUser> {
  const now = input.now ?? Date.now();
  const tokenHash = sha256(input.mfaToken);
  const rows = await db.select().from(mfaPending).where(eq(mfaPending.tokenHash, tokenHash)).limit(1);
  const pending = rows[0];
  if (!pending) throw new Error("invalid_totp");
  if (pending.expiresAt.getTime() <= now || pending.attempts >= MFA_PENDING_MAX_ATTEMPTS) {
    await db.delete(mfaPending).where(eq(mfaPending.tokenHash, tokenHash));
    throw new Error("invalid_totp");
  }
  const user = await loadUserById(db, pending.userId);
  if (!user?.totpEnabled || !user.totpSecretEncrypted) {
    await db.delete(mfaPending).where(eq(mfaPending.tokenHash, tokenHash));
    throw new Error("invalid_totp");
  }
  const secret = decryptSecret(input.sessionSecret, user.totpSecretEncrypted);
  const verified = verifyTotp(secret, input.code, { now, lastStep: user.totpLastStep });
  const backupNext = consumeBackupCode(parseBackupHashes(user.mfaBackupHashesJson), input.code);
  if (!verified.ok && !backupNext) {
    const nextAttempts = pending.attempts + 1;
    if (nextAttempts >= MFA_PENDING_MAX_ATTEMPTS) {
      await db.delete(mfaPending).where(eq(mfaPending.tokenHash, tokenHash));
    } else {
      await db
        .update(mfaPending)
        .set({ attempts: nextAttempts })
        .where(eq(mfaPending.tokenHash, tokenHash));
    }
    throw new Error("invalid_totp");
  }
  await db.delete(mfaPending).where(eq(mfaPending.tokenHash, tokenHash));
  await db
    .update(users)
    .set({
      totpLastStep: verified.ok ? verified.step : user.totpLastStep,
      mfaBackupHashesJson: backupNext ? JSON.stringify(backupNext) : user.mfaBackupHashesJson,
    })
    .where(eq(users.id, user.id));
  return asUser(user);
}

export async function verifyUserTotpOrBackup(
  db: Db,
  input: {
    userId: string;
    sessionSecret: string;
    totpCode?: string;
    backupCode?: string;
    now?: number;
  },
): Promise<void> {
  const user = await loadUserById(db, input.userId);
  if (!user?.totpEnabled || !user.totpSecretEncrypted) throw new Error("invalid_reset");
  if (input.totpCode) {
    const secret = decryptSecret(input.sessionSecret, user.totpSecretEncrypted);
    const verified = verifyTotp(secret, input.totpCode, {
      now: input.now,
      lastStep: user.totpLastStep,
    });
    if (!verified.ok) throw new Error("invalid_reset");
    await db.update(users).set({ totpLastStep: verified.step }).where(eq(users.id, user.id));
    return;
  }
  if (input.backupCode) {
    const next = consumeBackupCode(parseBackupHashes(user.mfaBackupHashesJson), input.backupCode);
    if (!next) throw new Error("invalid_reset");
    await db.update(users).set({ mfaBackupHashesJson: JSON.stringify(next) }).where(eq(users.id, user.id));
    return;
  }
  throw new Error("invalid_reset");
}

export async function clearMfaAfterHostFileReset(db: Db, userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      totpSecretEncrypted: null,
      totpEnabled: false,
      totpEnrolledAt: null,
      totpLastStep: null,
      hostFileResetEnabled: true,
      mfaBackupHashesJson: null,
    })
    .where(eq(users.id, userId));
}

/** Test helper: force-enable TOTP with a known secret. */
export async function seedTotpForTests(
  db: Db,
  input: { userId: string; sessionSecret: string; secret?: string; hostFileResetEnabled?: boolean },
): Promise<{ secret: string; backupCodes: string[] }> {
  const secret = input.secret ?? generateTotpSecret();
  const backupCodes = generateBackupCodes();
  await db
    .update(users)
    .set({
      totpSecretEncrypted: encryptSecret(input.sessionSecret, secret),
      totpEnabled: true,
      totpEnrolledAt: new Date(),
      totpLastStep: null,
      hostFileResetEnabled: input.hostFileResetEnabled ?? true,
      mfaBackupHashesJson: JSON.stringify(backupCodes.map(hashBackupCode)),
    })
    .where(eq(users.id, input.userId));
  return { secret, backupCodes };
}
