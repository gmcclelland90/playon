import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../db/client.js";
import { accessTokens } from "../db/schema.js";

const TOKEN_PREFIX = "playon_";

export type AccessTokenRecord = {
  id: string;
  name: string;
  userId: string;
  autoApproveConfirms: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** Present only immediately after create. */
  token?: string;
};

export type AccessTokenPrincipal = {
  id: string;
  name: string;
  userId: string;
  autoApproveConfirms: boolean;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export async function createAccessToken(
  db: Db,
  input: { name: string; userId: string; autoApproveConfirms?: boolean },
): Promise<AccessTokenRecord> {
  const id = nanoid();
  const token = mintToken();
  const now = new Date();
  await db.insert(accessTokens).values({
    id,
    name: input.name.trim() || "MCP token",
    tokenHash: hashToken(token),
    userId: input.userId,
    autoApproveConfirms: Boolean(input.autoApproveConfirms),
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  });
  return {
    id,
    name: input.name.trim() || "MCP token",
    userId: input.userId,
    autoApproveConfirms: Boolean(input.autoApproveConfirms),
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
    token,
  };
}

export async function listAccessTokens(db: Db, userId?: string): Promise<AccessTokenRecord[]> {
  const rows = userId
    ? await db.select().from(accessTokens).where(eq(accessTokens.userId, userId))
    : await db.select().from(accessTokens);
  return rows
    .filter((r) => !r.revokedAt)
    .map((r) => ({
      id: r.id,
      name: r.name,
      userId: r.userId,
      autoApproveConfirms: Boolean(r.autoApproveConfirms),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function revokeAccessToken(db: Db, id: string, userId?: string): Promise<boolean> {
  const rows = await db.select().from(accessTokens).where(eq(accessTokens.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return false;
  if (userId && row.userId !== userId) return false;
  await db
    .update(accessTokens)
    .set({ revokedAt: new Date() })
    .where(eq(accessTokens.id, id));
  return true;
}

export async function authenticateAccessToken(
  db: Db,
  bearer: string | undefined,
): Promise<AccessTokenPrincipal | null> {
  const token = bearer?.trim();
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(accessTokens)
    .where(and(eq(accessTokens.tokenHash, tokenHash), isNull(accessTokens.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // Constant-time compare on hex hashes (defense in depth if query ever loosens).
  const a = Buffer.from(row.tokenHash, "utf8");
  const b = Buffer.from(tokenHash, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  await db
    .update(accessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(accessTokens.id, row.id));

  return {
    id: row.id,
    name: row.name,
    userId: row.userId,
    autoApproveConfirms: Boolean(row.autoApproveConfirms),
  };
}

export function bearerFromAuthorization(header: string | undefined): string | undefined {
  if (!header) return undefined;
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return undefined;
}
