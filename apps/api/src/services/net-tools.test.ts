import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";
import { NetToolsService } from "./net-tools.js";
import { ServerService } from "./servers.js";

const temps: Array<{ root: string; sqlite: Database.Database; server?: http.Server }> = [];

function findRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function tempEnv(lanAllowlist: string[] = []): {
  db: Db;
  config: AppConfig;
  net: NetToolsService;
  servers: ServerService;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-net-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [resolveFixturesRoot(findRepoRoot()), path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const servers = new ServerService(db, config);
  return {
    db,
    config,
    servers,
    net: new NetToolsService(servers, async () => lanAllowlist),
  };
}

afterEach(async () => {
  for (const entry of temps.splice(0)) {
    if (entry.server) {
      await new Promise<void>((resolve) => entry.server!.close(() => resolve()));
    }
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("NetToolsService", () => {
  it("suggests a bindable port", async () => {
    const { net } = tempEnv();
    const suggestion = await net.suggestBind({ preferredPort: 29000 });
    expect(suggestion.available).toBe(true);
    expect(suggestion.port).toBeGreaterThanOrEqual(29000);
  });

  it("fetches a URL into the server jail when loopback is allowlisted", async () => {
    const { net, servers } = tempEnv(["127.0.0.1"]);
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });

    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("payload-from-fetch");
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no_port");
    temps[temps.length - 1]!.server = httpServer;

    const fetched = await net.fetchUrl({
      serverId: server.id,
      url: `http://127.0.0.1:${addr.port}/file.txt`,
      destPath: "game/downloaded.txt",
    });
    expect(fetched.bytes).toBeGreaterThan(0);
    expect(fetched.finalUrl).toContain("127.0.0.1");
    expect(fs.readFileSync(path.join(server.dataPath, "game", "downloaded.txt"), "utf8")).toBe(
      "payload-from-fetch",
    );
  });

  it("follows redirects within the hop limit", async () => {
    const { net, servers } = tempEnv(["127.0.0.1"]);
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });

    const httpServer = http.createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("after-redirect");
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no_port");
    temps[temps.length - 1]!.server = httpServer;

    const fetched = await net.fetchUrl({
      serverId: server.id,
      url: `http://127.0.0.1:${addr.port}/start`,
      destPath: "game/redir.txt",
    });
    expect(fetched.finalUrl).toContain("/final");
    expect(fs.readFileSync(path.join(server.dataPath, "game", "redir.txt"), "utf8")).toBe(
      "after-redirect",
    );
  });

  it("rejects RFC1918 destinations by default", async () => {
    const { net, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await expect(
      net.fetchUrl({
        serverId: server.id,
        url: "http://192.168.1.50/mod.zip",
        destPath: "game/mod.zip",
      }),
    ).rejects.toThrow(/fetch_blocked_destination/);
    await expect(
      net.fetchUrl({
        serverId: server.id,
        url: "http://10.0.0.1/mod.zip",
        destPath: "game/mod.zip",
      }),
    ).rejects.toThrow(/fetch_blocked_destination/);
  });

  it("rejects localhost by default", async () => {
    const { net, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await expect(
      net.fetchUrl({
        serverId: server.id,
        url: "http://127.0.0.1/local.bin",
        destPath: "game/local.bin",
      }),
    ).rejects.toThrow(/fetch_blocked_destination/);
    await expect(
      net.fetchUrl({
        serverId: server.id,
        url: "http://localhost/local.bin",
        destPath: "game/local.bin",
      }),
    ).rejects.toThrow(/fetch_blocked_destination/);
  });

  it("rejects link-local metadata destinations", async () => {
    const { net, servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await expect(
      net.fetchUrl({
        serverId: server.id,
        url: "http://169.254.169.254/latest/meta-data/",
        destPath: "game/meta.txt",
      }),
    ).rejects.toThrow(/fetch_blocked_destination/);
  });

  it("still blocks localhost when only a LAN CIDR is allowlisted", async () => {
    const { net, servers } = tempEnv(["192.168.1.0/24"]);
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await expect(
      net.fetchUrl({
        serverId: server.id,
        url: "http://127.0.0.1/local.bin",
        destPath: "game/local.bin",
      }),
    ).rejects.toThrow(/fetch_blocked_destination/);
  });

  it("fetches when the destination is on the host allowlist", async () => {
    const { net, servers } = tempEnv(["192.168.1.0/24", "127.0.0.1"]);
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });

    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("from-allowlist");
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no_port");
    temps[temps.length - 1]!.server = httpServer;

    const fetched = await net.fetchUrl({
      serverId: server.id,
      url: `http://127.0.0.1:${addr.port}/nas.txt`,
      destPath: "game/nas.txt",
    });
    expect(fs.readFileSync(path.join(server.dataPath, "game", "nas.txt"), "utf8")).toBe(
      "from-allowlist",
    );
    expect(fetched.bytes).toBeGreaterThan(0);
  });

  it("rejects oversized payloads", async () => {
    const { net, servers } = tempEnv(["127.0.0.1"]);
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });

    const chunk = Buffer.alloc(1024 * 1024, 1); // 1 MiB
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      // Stream more than 100 MiB
      let sent = 0;
      const target = 101 * 1024 * 1024;
      const writeMore = () => {
        while (sent < target) {
          const ok = res.write(chunk);
          sent += chunk.length;
          if (!ok) {
            res.once("drain", writeMore);
            return;
          }
        }
        res.end();
      };
      writeMore();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no_port");
    temps[temps.length - 1]!.server = httpServer;

    await expect(
      net.fetchUrl({
        serverId: server.id,
        url: `http://127.0.0.1:${addr.port}/big.bin`,
        destPath: "game/big.bin",
      }),
    ).rejects.toThrow(/fetch_too_large/);
  }, 60_000);
});
