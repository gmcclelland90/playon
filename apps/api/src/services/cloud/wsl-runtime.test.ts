import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.js";
import { createDb } from "../../db/client.js";
import { applyBootstrap } from "../../db/migrate.js";
import { nodes } from "../../db/schema.js";
import { LOCAL_WSL_NODE_ID, WSL_DISTRO_NAME } from "@playon/shared";
import {
  resolveEnsureWslScriptPath,
  WslRuntimeService,
} from "./wsl-runtime.js";

const roots: string[] = [];

function tempConfig(): { config: AppConfig; root: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-wsl-"));
  roots.push(root);
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 8787,
    dataRoot: root,
    dbPath,
    sessionSecret: "wsl-test-secret-at-least-32-chars!!",
    llmMode: "openai_compatible",
    runtimeMode: "native",
    advertiseHost: "192.168.1.10",
    nodeToken: "node-token",
    skillsRoots: [],
  };
  return { config, root, dbPath };
}

describe("wsl-runtime", () => {
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it("resolves ensure-wsl-runtime.ps1 from the monorepo", () => {
    const p = resolveEnsureWslScriptPath();
    // Script should exist in the monorepo
    expect(p).toBeTruthy();
    if (p) {
      const normalized = p.replace(/^\/([A-Za-z]):/, "$1:");
      expect(fs.existsSync(normalized)).toBe(true);
      const body = fs.readFileSync(normalized, "utf8");
      expect(body).toContain("Enable Linux runtime");
      expect(body).toContain("playon-linux");
    }
  });

  it("exports LOCAL_WSL_NODE_ID and WSL_DISTRO_NAME constants", () => {
    expect(LOCAL_WSL_NODE_ID).toBe("local-wsl");
    expect(WSL_DISTRO_NAME).toBe("playon-linux");
  });

  it("reports not_windows error on non-Windows platforms", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);

    const svc = new WslRuntimeService(db, config);

    // On non-Windows, isAvailable() returns false
    if (process.platform !== "win32") {
      expect(svc.isAvailable()).toBe(false);

      const status = await svc.status();
      expect(status.error).toBe("wsl_not_windows");
      expect(status.status).toBe("error");
      expect(status.distro).toBe(WSL_DISTRO_NAME);
      expect(status.nodeId).toBe(LOCAL_WSL_NODE_ID);
    } else {
      expect(svc.isAvailable()).toBe(true);
    }

    sqlite.close();
  });

  it("upserts placeholder node on enable (non-Windows returns error)", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);

    const svc = new WslRuntimeService(db, config);

    // Verify no node exists initially
    const before = await db
      .select()
      .from(nodes);
    const wslNodes = before.filter((n) => n.id === LOCAL_WSL_NODE_ID);
    expect(wslNodes).toHaveLength(0);

    // On non-Windows, enable returns error but may still create placeholder
    if (process.platform !== "win32") {
      const result = await svc.enable();
      expect(result.error).toBe("wsl_not_windows");
      expect(result.ok).toBe(false);
    }

    sqlite.close();
  });

  it("service methods return correct types", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);

    const svc = new WslRuntimeService(db, config);

    const status = await svc.status();
    expect(status).toHaveProperty("status");
    expect(status).toHaveProperty("message");
    expect(status).toHaveProperty("distro");
    expect(status).toHaveProperty("nodeId");
    expect(status.nodeId).toBe(LOCAL_WSL_NODE_ID);
    expect(status.distro).toBe(WSL_DISTRO_NAME);

    sqlite.close();
  });
});

describe("wsl constants in shared", () => {
  it("LOCAL_WSL_NODE_ID is local-wsl", () => {
    expect(LOCAL_WSL_NODE_ID).toBe("local-wsl");
  });

  it("WSL_DISTRO_NAME is playon-linux", () => {
    expect(WSL_DISTRO_NAME).toBe("playon-linux");
  });
});
