import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Role } from "@playon/shared";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const SESSION_COOKIE = "playon_session";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const id = nanoid(32);
  const now = new Date();
  await db.insert(sessions).values({
    id,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return id;
}

export async function getUserBySession(db: Db, sessionId: string | undefined): Promise<AuthUser | null> {
  if (!sessionId) return null;
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role as Role,
  };
}

export async function destroySession(db: Db, sessionId: string | undefined) {
  if (!sessionId) return;
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
