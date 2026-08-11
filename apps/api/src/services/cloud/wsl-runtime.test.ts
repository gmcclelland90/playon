import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.js";
import { createDb } from "../../db/client.js";
import { applyBootstrap } from "../../db/migrate.js";
import { nodes } from "../../db/schema.js";
import {
  LOCAL_NODE_ID,
  LOCAL_WSL_NODE_ID,
  WSL_DISTRO_NAME,
  wslSiblingNodeId,
} from "@playon/shared";
import {
  clearWslStateForTests,
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
    clearWslStateForTests();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it("resolves ensure-wsl-runtime.ps1 from the monorepo", () => {
    const p = resolveEnsureWslScriptPath();
    expect(p).toBeTruthy();
    if (p) {
      const normalized = p.replace(/^\/([A-Za-z]):/, "$1:");
      expect(fs.existsSync(normalized)).toBe(true);
      const body = fs.readFileSync(normalized, "utf8");
      expect(body).toContain("Enable Linux runtime");
      expect(body).toContain("playon-linux");
      expect(body).toContain("NodeId");
    }
  });

  it("exports LOCAL_WSL_NODE_ID and WSL_DISTRO_NAME constants", () => {
    expect(LOCAL_WSL_NODE_ID).toBe("local-wsl");
    expect(WSL_DISTRO_NAME).toBe("playon-linux");
    expect(wslSiblingNodeId("win-lab")).toBe("win-lab-wsl");
  });

  it("rejects non-windows nodes", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);
    try {
      await db.insert(nodes).values({
        id: "linux-1",
        name: "linux-1",
        os: "linux",
        docker: true,
        native: true,
        steamcmd: false,
        freeDiskBytes: null,
        agentVersion: "0.2.1",
        lastSeenAt: new Date(),
        kind: "lan",
        tunnelStatus: "none",
      });
      const svc = new WslRuntimeService(db, config);
      await expect(svc.status("linux-1")).rejects.toThrow(/wsl_not_windows/);
    } finally {
      sqlite.close();
    }
  });

  it("issues token one-liner for remote Windows nodes (any Home OS)", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);
    try {
      await db.insert(nodes).values({
        id: "win-1",
        name: "playon-win-1",
        os: "windows",
        docker: false,
        native: true,
        steamcmd: false,
        freeDiskBytes: null,
        agentVersion: "0.2.1",
        lastSeenAt: new Date(),
        kind: "lan",
        tunnelStatus: "none",
      });
      const svc = new WslRuntimeService(db, config);
      const status = await svc.status("win-1");
      expect(status.windowsNodeId).toBe("win-1");
      expect(status.nodeId).toBe("win-1-wsl");
      expect(status.status).toBe("not_installed");
      expect(status.canRunLocally).toBe(false);

      const enabled = await svc.enable("win-1");
      expect(enabled.ok).toBe(true);
      expect(enabled.mode).toBe("token");
      expect(enabled.oneLiner).toContain("/api/nodes/win-1/wsl/");
      expect(enabled.nodeId).toBe("win-1-wsl");

      const placeholder = await db.select().from(nodes);
      expect(placeholder.some((n) => n.id === "win-1-wsl")).toBe(true);

      const tok = await svc.createToken("win-1", { repair: false });
      const script = await svc.scriptForToken("win-1", tok.token);
      expect(script).toContain("FromBase64String");
      expect(script).toContain("-NodeId");
      await expect(svc.scriptForToken("win-1", tok.token)).rejects.toThrow(/wsl_token_invalid/);
    } finally {
      sqlite.close();
    }
  });

  it("does not spawn PowerShell for unit tests on Windows local", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);
    try {
      await db.insert(nodes).values({
        id: LOCAL_NODE_ID,
        name: "Local",
        os: "windows",
        docker: false,
        native: true,
        steamcmd: false,
        freeDiskBytes: null,
        agentVersion: "0.2.1",
        lastSeenAt: new Date(),
        kind: "local",
        tunnelStatus: "none",
      });
      const svc = new WslRuntimeService(db, config);
      if (process.platform === "win32") {
        expect(svc.isAvailable()).toBe(true);
        // Avoid elevating / probing real WSL in CI — only check token path helpers.
        const tok = await svc.createToken(LOCAL_NODE_ID);
        expect(tok.nodeId).toBe(LOCAL_WSL_NODE_ID);
        expect(tok.oneLiner).toContain("/api/nodes/local/wsl/");
        return;
      }
      expect(svc.isAvailable()).toBe(false);
      const enabled = await svc.enable(LOCAL_NODE_ID);
      expect(enabled.mode).toBe("token");
      expect(enabled.oneLiner).toBeTruthy();
    } finally {
      sqlite.close();
    }
  });
});
