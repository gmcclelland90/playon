import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { LLM_PRESETS } from "@playon/shared";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createDb, type Db } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import type { AppConfig } from "./config.js";
import { encryptSecret } from "./services/secrets.js";
import { setSetting, LLM_SETTINGS_KEY } from "./services/settings.js";
import { nodeJobService } from "./services/node-jobs.js";
import { waitForRcon } from "./services/rcon.js";
import { ServerService } from "./services/servers.js";
import { listSkills } from "./services/skills.js";
import { SteamcmdNotFoundError, steamcmdAppUpdate } from "./services/steamcmd.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "./lab-games-root.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Captured at load so the "refuses chat without key" test can clear process.env safely. */
const VENICE_KEY_AT_LOAD =
  process.env.PLAYON_VENICE_API_KEY?.trim() || process.env.VENICE_API_KEY?.trim() || "";

function requireVeniceKey(): string {
  if (!VENICE_KEY_AT_LOAD) {
    throw new Error(
      "llm_api_key_required: set PLAYON_VENICE_API_KEY (or VENICE_API_KEY) for int verify on the lab host",
    );
  }
  return VENICE_KEY_AT_LOAD;
}

/** Chat/agent paths may start Docker without stopping; free host ports before rm temp roots. */
function removeDockerContainersForTempRoot(root: string): void {
  const serversDir = path.join(root, "servers");
  if (!fs.existsSync(serversDir)) return;
  for (const id of fs.readdirSync(serversDir)) {
    if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) continue;
    try {
      execFileSync("docker", ["rm", "-f", `playon-${id}`], { stdio: "ignore" });
    } catch {
      // container may not exist
    }
  }
}

/** Paper/Docker may leave root-owned files under game/.cache — force-remove via a helper container. */
function rmTempRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
  }
  try {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${root}:/playon-rm`,
        "alpine:3.20",
        "sh",
        "-c",
        "rm -rf /playon-rm/* /playon-rm/.[!.]* /playon-rm/..?*",
      ],
      { stdio: "ignore" },
    );
  } catch {
    // ignore — test already finished; leftover /tmp is preferable to a red bar
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function tempConfig(): { db: Db; config: AppConfig; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const repoRoot = findRepoRoot(process.cwd());
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test-session-secret",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [resolveFixturesRoot(repoRoot), path.join(root, "skills")],
  };

  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  return { db, config, root };
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    removeDockerContainersForTempRoot(entry.root);
    entry.sqlite.close();
    rmTempRoot(entry.root);
  }
});

async function bootstrapOwner(app: ReturnType<typeof createApp>) {
  const boot = await app.request("/api/setup/owner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "host", password: "password123", displayName: "LAN Host" }),
  });
  expect(boot.status).toBe(200);
  return (boot.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function seedVenice(db: Db, config: AppConfig) {
  const apiKey = requireVeniceKey();
  await setSetting(db, LLM_SETTINGS_KEY, {
    provider: "openai_compatible",
    baseUrl: process.env.PLAYON_VENICE_BASE_URL?.trim() || "https://api.venice.ai/api/v1",
    // PLAYON_VENICE_MODEL overrides; otherwise Settings Venice default (grok-4-5).
    model: process.env.PLAYON_VENICE_MODEL?.trim() || LLM_PRESETS.venice.defaultModel,
    apiKeyEncrypted: encryptSecret(config.sessionSecret, apiKey),
  });
}

describe("api integration (real Venice + Docker)", () => {
  it("bootstraps owner and lists lab docker fixture skill", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);
    const cookie = await bootstrapOwner(app);
    expect(cookie).toContain("playon_session=");

    const skills = listSkills(config.skillsRoots);
    expect(skills.some((s) => s.metadata.name === LAB_DOCKER_SKILL)).toBe(true);
    expect(skills.some((s) => s.metadata.name.includes("fake-http"))).toBe(false);
  });

  it("creates Paper server on real Docker and starts/stops it", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "LAN Paper",
    });
    expect(created.runtimeMode).toBe("docker");
    expect(fs.existsSync(path.join(created.dataPath, "skill.json"))).toBe(true);

    const started = await servers.start(created.id);
    expect(started.status).toBe("running");

    const stopped = await servers.stop(created.id);
    expect(stopped.status).toBe("stopped");
  }, 300_000);

  it("unbound install chat via Venice creates a Paper server", async () => {
    const { db, config } = tempConfig();
    await seedVenice(db, config);
    const app = createApp(db, config);
    const cookie = await bootstrapOwner(app);

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        message:
          "Create a lab docker server named Venice Lab using servers_create_from_skill with skillName fixtures.lab-docker-server, then publish a join panel. Do not ask questions.",
      }),
    });
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as {
      serverId?: string;
      toolTrace?: Array<{ name: string; result?: { error?: string; serverId?: string } }>;
      reply: string;
      llmMode: string;
    };
    expect(body.llmMode).toBe("openai_compatible");
    const createTrace = body.toolTrace?.find((t) => t.name === "servers_create_from_skill") as
      | { name: string; result?: { error?: string; serverId?: string } }
      | undefined;
    expect(createTrace, `toolTrace=${JSON.stringify(body.toolTrace)} reply=${body.reply}`).toBeTruthy();
    expect(createTrace?.result?.error, JSON.stringify(createTrace?.result)).toBeFalsy();
    expect(body.serverId, `reply=${body.reply}`).toBeTruthy();

    const list = await app.request("/api/servers", { headers: { cookie } });
    const { servers: serverList } = (await list.json()) as { servers: Array<{ id: string }> };
    expect(serverList.some((s) => s.id === body.serverId)).toBe(true);
  }, 180_000);

  it("bound maintain chat does not create a sibling server", async () => {
    const { db, config } = tempConfig();
    await seedVenice(db, config);
    const app = createApp(db, config);
    const cookie = await bootstrapOwner(app);

    const created = await app.request("/api/servers", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        skillName: LAB_DOCKER_SKILL,
        serverName: "Maintain Me",
      }),
    });
    expect(created.status).toBe(200);
    const { server } = (await created.json()) as { server: { id: string } };

    const before = await app.request("/api/servers", { headers: { cookie } });
    const beforeBody = (await before.json()) as { servers: unknown[] };
    const countBefore = beforeBody.servers.length;

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        message: "Publish an updated player panel join block for this server only. Do not create another server.",
        serverId: server.id,
      }),
    });
    expect(chat.status).toBe(200);
    const chatBody = (await chat.json()) as {
      serverId: string;
      toolTrace?: Array<{ name: string; result?: { error?: string } }>;
    };
    expect(chatBody.serverId).toBe(server.id);
    expect(
      chatBody.toolTrace?.some(
        (t) => t.name === "servers_create_from_skill" && !t.result?.error,
      ),
    ).toBe(false);

    const after = await app.request("/api/servers", { headers: { cookie } });
    const afterBody = (await after.json()) as { servers: unknown[] };
    expect(afterBody.servers.length).toBe(countBefore);
  }, 180_000);

  it("refuses chat without a Venice API key", async () => {
    const prev = process.env.PLAYON_VENICE_API_KEY;
    const prev2 = process.env.VENICE_API_KEY;
    delete process.env.PLAYON_VENICE_API_KEY;
    delete process.env.VENICE_API_KEY;
    try {
      const { db, config } = tempConfig();
      const app = createApp(db, config);
      const cookie = await bootstrapOwner(app);
      const chat = await app.request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(chat.status).toBeGreaterThanOrEqual(400);
      const body = (await chat.json()) as { error?: string };
      expect(body.error ?? "").toMatch(/llm_api_key_required|chat_failed|LLM/);
    } finally {
      if (prev !== undefined) process.env.PLAYON_VENICE_API_KEY = prev;
      if (prev2 !== undefined) process.env.VENICE_API_KEY = prev2;
    }
  });

  it("runs RCON against a live Paper server", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "RCON Paper",
    });
    const started = await servers.start(created.id);
    expect(started.status).toBe("running");

    const endpoint = await servers.getRconEndpoint(created.id);
    expect(endpoint).toBeTruthy();
    expect(endpoint!.password).toBeTruthy();

    const result = await waitForRcon(endpoint!, {
      timeoutMs: 240_000,
      intervalMs: 4_000,
      command: "list",
    });
    expect(result.ok).toBe(true);

    const say = await waitForRcon(endpoint!, {
      timeoutMs: 30_000,
      intervalMs: 2_000,
      command: "say PlayOn RCON ok",
    });
    expect(say.ok).toBe(true);

    await servers.stop(created.id);
  }, 360_000);

  it("fails honestly when SteamCMD is missing", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const created = await servers.createFromSkill({
      skillName: LAB_DOCKER_SKILL,
      serverName: "Steam Jail",
    });
    await expect(
      steamcmdAppUpdate({
        serverDataPath: created.dataPath,
        appId: 90,
        env: {
          PATH: "",
          Path: "",
          PLAYON_STEAMCMD: "",
          STEAMCMD: "",
          STEAMCMD_PATH: "",
          PLAYON_STEAMCMD_AUTO: "0",
        },
      }),
    ).rejects.toBeInstanceOf(SteamcmdNotFoundError);
  });

  it("round-trips a real node-agent job", async () => {
    const { db, config, root } = tempConfig();
    config.nodeToken = "lab-node-token";
    const app = createApp(db, config);
    const cookie = await bootstrapOwner(app);

    const server = http.createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no_listen_port");
    const apiBase = `http://127.0.0.1:${address.port}`;

    const agentData = path.join(root, "node-data");
    fs.mkdirSync(agentData, { recursive: true });
    fs.writeFileSync(path.join(agentData, "marker.txt"), "hello-node");

    const repoRoot = findRepoRoot(process.cwd());
    const child: ChildProcess = spawn(
      "pnpm",
      ["exec", "tsx", "src/index.ts"],
      {
        cwd: path.join(repoRoot, "apps", "node-agent"),
        env: {
          ...process.env,
          PLAYON_API_URL: apiBase,
          PLAYON_NODE_ID: "lab-node",
          PLAYON_NODE_NAME: "lab-node",
          PLAYON_DATA_ROOT: agentData,
          PLAYON_NODE_TOKEN: "lab-node-token",
          PLAYON_HEARTBEAT_MS: "2000",
          PLAYON_JOB_POLL_MS: "300",
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );

    try {
      // Wait until heartbeat registers the node.
      const deadline = Date.now() + 20_000;
      let online = false;
      while (Date.now() < deadline) {
        const nodes = await app.request("/api/nodes", { headers: { cookie } });
        if (nodes.status === 200) {
          const body = (await nodes.json()) as { nodes?: Array<{ id: string }> };
          if (body.nodes?.some((n) => n.id === "lab-node")) {
            online = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      expect(online).toBe(true);

      const enqueued = await app.request("/api/nodes/lab-node/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ kind: "fs_list", args: { path: "." } }),
      });
      expect(enqueued.status).toBe(201);
      const { job } = (await enqueued.json()) as { job: { id: string } };

      const done = await nodeJobService.waitFor(job.id, { timeoutMs: 15_000 });
      expect(done.status).toBe("done");
      const result = done.result as { entries?: Array<{ name: string }> };
      expect(result.entries?.some((e) => e.name === "marker.txt")).toBe(true);

      const pingJob = nodeJobService.enqueue("lab-node", "ping");
      const pingDone = await nodeJobService.waitFor(pingJob.id, { timeoutMs: 15_000 });
      expect(pingDone.status).toBe("done");
      expect((pingDone.result as { pong?: boolean }).pong).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 60_000);
});
