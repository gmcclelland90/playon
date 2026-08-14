import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.js";
import { createControlPlane } from "../../control-plane.js";
import { createDb } from "../../db/client.js";
import { applyBootstrap } from "../../db/migrate.js";
import { nodes, servers as serversTable } from "../../db/schema.js";
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

afterEach(async () => {
  nodeJobService.forgetJobKinds("playon-win-1-wsl");
  while (temps.length) {
    const entry = temps.pop();
    if (!entry) break;
    try {
      entry.sqlite.close();
    } catch {
      /* already closed */
    }
    rmSync(entry.root, { recursive: true, force: true });
  }
});

async function listen(host: string, port = 0): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("listen_failed");
  }
  return { server, port: address.port };
}

describe("net_port_check TCP loopback", () => {
  it("does not report Home soak as open without nodeId", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-tcp-check-"));
    applyBootstrap(path.join(dataRoot, "playon.sqlite"));
    const { db, sqlite } = createDb(path.join(dataRoot, "playon.sqlite"));
    temps.push({ root: dataRoot, sqlite });
    const { registry } = createPlayOnToolRegistry(
      createControlPlane(db, testConfig(dataRoot)),
      {},
    );

    const { server, port } = await listen("127.0.0.1");
    try {
      const res = (await registry.invoke("net_port_check", {
        host: "127.0.0.1",
        port,
      })) as { state: string; error?: string };
      expect(res.state).toBe("closed");
      expect(res.error).toBe("loopback_requires_nodeId");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("probes a bound workspace server's remote node, not Home", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-tcp-ws-"));
    applyBootstrap(path.join(dataRoot, "playon.sqlite"));
    const { db, sqlite } = createDb(path.join(dataRoot, "playon.sqlite"));
    temps.push({ root: dataRoot, sqlite });

    await db.insert(nodes).values({
      id: "playon-win-1-wsl",
      name: "wsl",
      os: "linux",
      docker: true,
      native: true,
      steamcmd: true,
      freeDiskBytes: 1e11,
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });
    await db.insert(serversTable).values({
      id: "srv-wsl",
      name: "Small Minecraft",
      game: "Paper",
      nodeId: "playon-win-1-wsl",
      runtimeMode: "docker",
      status: "running",
      dataPath: path.join(dataRoot, "servers", "srv-wsl"),
      createdAt: new Date(),
    });

    const plane = createControlPlane(db, testConfig(dataRoot));
    const { registry } = createPlayOnToolRegistry(plane, { workspaceServerId: "srv-wsl" });

    const { server, port } = await listen("127.0.0.1");
    try {
      nodeJobService.advertiseJobKinds("playon-win-1-wsl", ["net_tcp_connect"]);
      const pending = registry.invoke("net_port_check", { host: "127.0.0.1", port });
      const started = Date.now();
      let job = nodeJobService.claimNext("playon-win-1-wsl");
      while (!job && Date.now() - started < 2_000) {
        await new Promise((r) => setTimeout(r, 20));
        job = nodeJobService.claimNext("playon-win-1-wsl");
      }
      expect(job?.kind).toBe("net_tcp_connect");
      nodeJobService.complete(job!.id, { host: "127.0.0.1", port, state: "closed" });
      const res = (await pending) as { state: string; scope?: string; error?: string };
      expect(res.state).toBe("closed");
      expect(res.scope).toBe("node");
      expect(res.error).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("still probes a non-loopback advertised host from Home", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-tcp-lan-"));
    applyBootstrap(path.join(dataRoot, "playon.sqlite"));
    const { db, sqlite } = createDb(path.join(dataRoot, "playon.sqlite"));
    temps.push({ root: dataRoot, sqlite });
    const { registry } = createPlayOnToolRegistry(
      createControlPlane(db, testConfig(dataRoot)),
      {},
    );

    const res = (await registry.invoke("net_port_check", {
      host: "172.16.0.94",
      port: 25565,
    })) as { state: string; scope?: string; error?: string; protocol?: string };
    expect(res.scope).toBe("home");
    expect(res.protocol).toBe("tcp");
    expect(res.error).toBeUndefined();
    expect(["open", "closed"]).toContain(res.state);
  });
});
