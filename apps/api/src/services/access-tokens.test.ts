import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { users } from "../db/schema.js";
import {
  authenticateAccessToken,
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from "./access-tokens.js";

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

describe("access tokens", () => {
  it("mints, authenticates, lists, and revokes", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "playon-pat-"));
    temps.push(dataRoot);
    const dbPath = path.join(dataRoot, "playon.db");
    applyBootstrap(dbPath);
    const { db } = createDb(dbPath);
    await db.insert(users).values({
      id: "u1",
      username: "owner",
      displayName: "Owner",
      passwordHash: "x",
      role: "owner",
      createdAt: new Date(),
    });

    const created = await createAccessToken(db, {
      name: "Cursor",
      userId: "u1",
      autoApproveConfirms: true,
    });
    expect(created.token?.startsWith("playon_")).toBe(true);

    const principal = await authenticateAccessToken(db, created.token);
    expect(principal).toMatchObject({
      id: created.id,
      userId: "u1",
      autoApproveConfirms: true,
    });

    const listed = await listAccessTokens(db, "u1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.token).toBeUndefined();

    expect(await revokeAccessToken(db, created.id, "u1")).toBe(true);
    expect(await authenticateAccessToken(db, created.token)).toBeNull();
  });
});
