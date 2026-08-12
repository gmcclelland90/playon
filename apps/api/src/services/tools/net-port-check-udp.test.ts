import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.js";
import { createControlPlane } from "../../control-plane.js";
import { createDb } from "../../db/client.js";
import { applyBootstrap } from "../../db/migrate.js";
import { nodeJobService } from "../node-jobs.js";
import { createPlayOnToolRegistry } from "../tools.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function testConfig(dataRoot: string): AppConfig {
  return {
    port: 0,
    advertiseHost: "127.0.0.1",
    dataRoot,
    dbPath: path.join(dataRoot, "playon.sqlite"),
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [path.join(process.cwd(), "skills")],
    llmMode: "openai_compatible",
    runtimeMode: "docker",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Close SQLite first; on Windows WAL/shm can stay locked briefly after close. */
async function rmTempRoot(root: string): Promise<void> {
  const attempts = process.platform === "win32" ? 8 : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw err;
      if (i === attempts - 1) return;
      await sleep(25 * (i + 1));
    }
  }
}

afterEach(async () => {
  nodeJobService.forgetJobKinds("playon-win-1");
  while (temps.length) {
    const entry = temps.pop();
    if (!entry) break;
    try {
      entry.sqlite.close();
    } catch {
      /* already closed */
    }
    await rmTempRoot(entry.root);
  }
});

describe("net_port_check UDP", () => {
  it("proves a local UDP bind via ss and does not invent open for a closed port", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-udp-check-"));
    applyBootstrap(path.join(dataRoot, "playon.sqlite"));
    const { db, sqlite } = createDb(path.join(dataRoot, "playon.sqlite"));
    temps.push({ root: dataRoot, sqlite });
    const { registry } = createPlayOnToolRegistry(
      createControlPlane(db, testConfig(dataRoot)),
      {},
    );

    const socket = dgram.createSocket("udp4");
    const port = await new Promise<number>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => {
        const addr = socket.address();
        resolve(typeof addr === "string" ? 0 : addr.port);
      });
    });
    try {
      const open = (await registry.invoke("net_port_check", {
        port,
        protocol: "udp",
      })) as { state: string; listening: boolean; protocol: string; probe: string };
      expect(open.protocol).toBe("udp");
      expect(open.state).toBe("open");
      expect(open.listening).toBe(true);
      expect(open.probe).toMatch(/^(ss|netstat)$/);
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }

    const closed = (await registry.invoke("net_port_check", {
      port,
      protocol: "udp",
    })) as { state: string; listening: boolean };
    expect(closed.state).toBe("closed");
    expect(closed.listening).toBe(false);
  });

  it("returns unavailable (not open) when the node does not advertise net_udp_listen", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-udp-old-node-"));
    applyBootstrap(path.join(dataRoot, "playon.sqlite"));
    const { db, sqlite } = createDb(path.join(dataRoot, "playon.sqlite"));
    temps.push({ root: dataRoot, sqlite });
    const { registry } = createPlayOnToolRegistry(
      createControlPlane(db, testConfig(dataRoot)),
      {},
    );

    nodeJobService.advertiseJobKinds("playon-win-1", ["ping", "fs_list"]);
    const res = (await registry.invoke("net_port_check", {
      port: 27015,
      protocol: "udp",
      nodeId: "playon-win-1",
    })) as { state: string; listening: boolean; probe: string };
    expect(res.state).toBe("closed");
    expect(res.listening).toBe(false);
    expect(res.probe).toBe("unavailable");
  });
});
