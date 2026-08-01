import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "./app.js";
import { createDb, type Db } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import { snapshots } from "./db/schema.js";
import type { AppConfig } from "./config.js";
import { SkillDraftService } from "./services/skill-drafts.js";
import { ServerService } from "./services/servers.js";
import { SnapshotService } from "./services/snapshots.js";
import { listSkills } from "./services/skills.js";

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

function tempConfig(): { db: Db; config: AppConfig; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const repoRoot = findRepoRoot(process.cwd());
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "mock",
    runtimeMode: "mock",
    advertiseHost: "127.0.0.1",
    skillsRoots: [
      path.join(repoRoot, "skills", "fixtures"),
      path.join(repoRoot, "skills", "games"),
      path.join(root, "skills"),
    ],
  };

  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  return { db, config, root };
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("api integration", () => {
  it("bootstraps owner and chats with mock LLM", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);

    const setup = await app.request("/api/setup");
    expect(await setup.json()).toMatchObject({ needsSetup: true, product: "PlayOn" });

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123", displayName: "LAN Host" }),
    });
    expect(boot.status).toBe(200);
    const cookie = boot.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("playon_session=");

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookie.split(";")[0]!,
      },
      body: JSON.stringify({ message: "spin up a test server" }),
    });
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as { reply: string; llmMode: string };
    expect(body.llmMode).toBe("mock");
    expect(body.reply.length).toBeGreaterThan(0);
  });

  it("installs fake-http fixture via chat and publishes panel blocks", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123", displayName: "LAN Host" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const putLlm = await app.request("/api/settings/llm", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ provider: "mock" }),
    });
    expect(putLlm.status).toBe(200);

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "install fake-http fixture" }),
    });
    expect(chat.status).toBe(200);
    const chatBody = (await chat.json()) as {
      reply: string;
      toolTrace: Array<{ name: string }>;
    };
    expect(chatBody.toolTrace.map((t) => t.name)).toEqual([
      "servers_create_from_skill",
      "panel_publish",
    ]);

    const servers = await app.request("/api/servers", { headers: { cookie } });
    expect(servers.status).toBe(200);
    const serversBody = (await servers.json()) as { servers: Array<{ name: string }> };
    expect(serversBody.servers.length).toBe(1);

    const panel = await app.request("/api/panel");
    expect(panel.status).toBe(200);
    const panelBody = (await panel.json()) as {
      blocks: Array<{ type: string; title: string }>;
      theme?: { id: string };
    };
    expect(panelBody.blocks.some((b) => b.type === "join_info")).toBe(true);
    expect(panelBody.blocks.some((b) => b.type === "server_status")).toBe(true);
    expect(panelBody.theme?.id).toBeTruthy();
    const etag = panel.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await app.request("/api/panel", {
      headers: { "If-None-Match": etag! },
    });
    expect(again.status).toBe(304);
  });

  it("creates baseline snapshot and restores mutated server files", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123", displayName: "LAN Host" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "install fake-http fixture" }),
    });
    expect(chat.status).toBe(200);

    const serversRes = await app.request("/api/servers", { headers: { cookie } });
    const { servers: serverList } = (await serversRes.json()) as {
      servers: Array<{ id: string; dataPath: string }>;
    };
    expect(serverList.length).toBe(1);
    const server = serverList[0]!;

    const baselineRows = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.serverId, server.id));
    expect(baselineRows.some((row) => row.label === "baseline")).toBe(true);

    const markerPath = path.join(server.dataPath, "marker.txt");
    fs.writeFileSync(markerPath, "mutated");

    const baseline = baselineRows.find((row) => row.label === "baseline")!;
    const serverService = new ServerService(db, config);
    const snapshotService = new SnapshotService(db, config, serverService);
    await snapshotService.restore(baseline.id);

    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(path.join(server.dataPath, "skill.json"))).toBe(true);
  });

  it("skill_draft_save creates draft discoverable via skill list", async () => {
    const { config } = tempConfig();
    const drafts = new SkillDraftService(config);

    const saved = drafts.save({
      name: "int-draft-game",
      game: "Int Draft Game",
      description: "Integration draft",
      installGuide: "# Setup\n\nInstall steps.",
    });
    expect(saved.skillName).toBe("drafts.int-draft-game");

    const discovered = listSkills(config.skillsRoots);
    const match = discovered.find((s) => s.metadata.name === "drafts.int-draft-game");
    expect(match).toBeTruthy();
    expect(match?.metadata.tags).toContain("draft");
  });

  it("lists Paper skill and creates/starts it under mock runtime", async () => {
    const { db, config } = tempConfig();
    const skills = listSkills(config.skillsRoots);
    expect(skills.some((s) => s.metadata.name === "games.minecraft-paper")).toBe(true);

    const servers = new ServerService(db, config);
    const created = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
      serverName: "LAN Paper",
    });
    expect(created.game).toContain("Minecraft");
    expect(created.runtimeMode).toBe("mock");
    expect(fs.existsSync(path.join(created.dataPath, "skill.json"))).toBe(true);

    const started = await servers.start(created.id);
    expect(started.status).toBe("running");

    const stopped = await servers.stop(created.id);
    expect(stopped.status).toBe("stopped");
  });

  it("emits server.status and server.log events while starting mock Paper", async () => {
    const { db, config } = tempConfig();
    const { EventHub } = await import("./services/event-hub.js");
    const hub = new EventHub();
    const events: Array<{ type: string; line?: string; status?: string }> = [];
    hub.subscribe((event) => {
      if (event.type === "server.status") {
        events.push({ type: event.type, status: event.status });
      } else if (event.type === "server.log") {
        events.push({ type: event.type, line: event.line });
      }
    });

    const servers = new ServerService(db, config, hub);
    const created = await servers.createFromSkill({
      skillName: "games.minecraft-paper",
      serverName: "WS Paper",
    });
    await servers.start(created.id);
    await new Promise((r) => setTimeout(r, 250));
    await servers.stop(created.id);

    expect(events.some((e) => e.type === "server.status" && e.status === "starting")).toBe(true);
    expect(events.some((e) => e.type === "server.status" && e.status === "running")).toBe(true);
    expect(events.some((e) => e.type === "server.log")).toBe(true);
    expect(events.some((e) => e.type === "server.status" && e.status === "stopped")).toBe(true);
  });

  it("installs Paper via mock chat and reloads conversation messages", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123", displayName: "LAN Host" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "install paper minecraft for the LAN" }),
    });
    expect(chat.status).toBe(200);
    const chatBody = (await chat.json()) as {
      conversationId: string;
      toolTrace: Array<{ name: string }>;
      reply: string;
    };
    expect(chatBody.toolTrace.map((t) => t.name)).toEqual([
      "servers_create_from_skill",
      "panel_publish",
    ]);
    expect(chatBody.reply.toLowerCase()).toContain("paper");

    const history = await app.request(`/api/conversations/${chatBody.conversationId}/messages`, {
      headers: { cookie },
    });
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(historyBody.messages.some((m) => m.role === "user")).toBe(true);
    expect(historyBody.messages.some((m) => m.role === "assistant")).toBe(true);

    const serversRes = await app.request("/api/servers", { headers: { cookie } });
    const { servers: serverList } = (await serversRes.json()) as {
      servers: Array<{ name: string; game: string | null }>;
    };
    expect(serverList.some((s) => /paper|minecraft/i.test(s.name + (s.game ?? "")))).toBe(true);
  });

  it("starts the windows-native stub via process supervisor", async () => {
    const { db, config } = tempConfig();
    const servers = new ServerService(db, config);
    const created = await servers.createFromSkill({
      skillName: "games.windows-native-stub",
      serverName: "Native Stub",
    });
    expect(created.runtimeMode).toBe("native");
    const started = await servers.start(created.id);
    expect(started.status).toBe("running");
    const stopped = await servers.stop(created.id);
    expect(stopped.status).toBe("stopped");
  });

  it("awards agent XP and celebrations after successful tools", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ message: "spin up a test server" }),
    });
    expect(chat.status).toBe(200);
    const chatBody = (await chat.json()) as {
      persona: string;
      agentProgress?: { xp: number; level: number; title: string };
      celebrations?: Array<{ reason: string }>;
    };
    expect(chatBody.agentProgress?.xp).toBeGreaterThan(0);
    expect(chatBody.agentProgress?.title).toBeTruthy();

    const progress = await app.request("/api/agents/progress", { headers: { cookie } });
    expect(progress.status).toBe(200);
    const progressBody = (await progress.json()) as {
      agents: Array<{ persona: string; xp: number }>;
    };
    expect(progressBody.agents.some((a) => a.xp > 0)).toBe(true);
  });

  it("imports a local server path with baseline snapshot", async () => {
    const { db, config, root } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const source = path.join(root, "outside", "legacy");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "server.properties"), "motd=imported\n");
    fs.writeFileSync(path.join(source, "world.dat"), "data");

    const res = await app.request("/api/servers/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        sourcePath: source,
        serverName: "From Disk",
        skillName: "fixtures.fake-http-game",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      import: {
        server: { id: string; name: string };
        skillName: string;
        baselineSnapshotId: string;
        copiedBytes: number;
        followUp: string[];
      };
    };
    expect(body.import.server.name).toBe("From Disk");
    expect(body.import.skillName).toBe("fixtures.fake-http-game");
    expect(body.import.baselineSnapshotId.length).toBeGreaterThan(0);
    expect(body.import.copiedBytes).toBeGreaterThan(0);
    expect(body.import.followUp).toContain("verify_start_and_join");
  });

  it("fans in remote logs/metrics and relocates a server", async () => {
    const { db, config } = tempConfig();
    config.nodeToken = "node-secret";
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    await app.request("/api/nodes/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer node-secret",
      },
      body: JSON.stringify({
        nodeId: "lab-2",
        name: "lab-2",
        os: "linux",
        docker: true,
        freeDiskBytes: 40 * 1024 ** 3,
        agentVersion: "0.1.0",
      }),
    });

    const created = await app.request("/api/servers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        skillName: "fixtures.fake-http-game",
        serverName: "move-me",
        nodeId: "local",
      }),
    });
    expect(created.status).toBe(200);
    const serverBody = (await created.json()) as { server: { id: string; nodeId: string | null } };
    expect(serverBody.server.nodeId).toBe("local");

    const logs = await app.request(`/api/nodes/lab-2/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer node-secret",
      },
      body: JSON.stringify({ serverId: serverBody.server.id, lines: ["[lab-2] hello"] }),
    });
    expect(logs.status).toBe(200);

    const metrics = await app.request(`/api/nodes/lab-2/metrics`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer node-secret",
      },
      body: JSON.stringify({ cpuPercent: 11, freeDiskBytes: 40 * 1024 ** 3 }),
    });
    expect(metrics.status).toBe(200);

    const relocated = await app.request(`/api/servers/${serverBody.server.id}/relocate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ targetNodeId: "lab-2" }),
    });
    expect(relocated.status).toBe(200);
    const relocateBody = (await relocated.json()) as {
      relocate: { fromNodeId: string | null; toNodeId: string; snapshotId: string };
    };
    expect(relocateBody.relocate.fromNodeId).toBe("local");
    expect(relocateBody.relocate.toNodeId).toBe("lab-2");
    expect(relocateBody.relocate.snapshotId.length).toBeGreaterThan(0);
  });

  it("suggests placement and assigns a node on create", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const plan = await app.request(
      `/api/placement?skillName=${encodeURIComponent("fixtures.fake-http-game")}`,
      { headers: { cookie } },
    );
    expect(plan.status).toBe(200);
    const planBody = (await plan.json()) as {
      placement: { recommendedNodeId: string | null; candidates: Array<{ eligible: boolean }> };
    };
    expect(planBody.placement.recommendedNodeId).toBeTruthy();
    expect(planBody.placement.candidates.some((c) => c.eligible)).toBe(true);

    const created = await app.request("/api/servers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        skillName: "fixtures.fake-http-game",
        serverName: "placed",
        nodeId: planBody.placement.recommendedNodeId,
      }),
    });
    expect(created.status).toBe(200);
    const serverBody = (await created.json()) as { server: { nodeId: string | null } };
    expect(serverBody.server.nodeId).toBe(planBody.placement.recommendedNodeId);
  });

  it("requires node token for heartbeat and reports presence status", async () => {
    const { db, config } = tempConfig();
    config.nodeToken = "node-secret";
    const app = createApp(db, config);

    const denied = await app.request("/api/nodes/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "lab-1",
        name: "lab",
        os: "linux",
        docker: true,
        agentVersion: "0.1.0",
      }),
    });
    expect(denied.status).toBe(401);

    const ok = await app.request("/api/nodes/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer node-secret",
      },
      body: JSON.stringify({
        nodeId: "lab-1",
        name: "lab",
        os: "linux",
        docker: true,
        agentVersion: "0.1.0",
      }),
    });
    expect(ok.status).toBe(200);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;
    const list = await app.request("/api/nodes", { headers: { cookie } });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      nodes: Array<{ id: string; status: string }>;
    };
    expect(body.nodes.some((n) => n.id === "lab-1" && n.status === "online")).toBe(true);
  });

  it("lists snapshots and agent activity for the dashboard", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const created = await app.request("/api/servers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ skillName: "fixtures.fake-http-game", serverName: "dash-srv" }),
    });
    expect(created.status).toBe(200);
    const serverBody = (await created.json()) as { server: { id: string } };

    const snapRes = await app.request("/api/snapshots", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ serverId: serverBody.server.id, label: "dashboard-test" }),
    });
    expect(snapRes.status).toBe(200);

    const list = await app.request("/api/snapshots", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      snapshots: Array<{ label: string; serverId: string }>;
    };
    expect(listBody.snapshots.some((s) => s.label === "dashboard-test")).toBe(true);

    await app.request("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ message: "list skills please" }),
    });

    const activity = await app.request("/api/activity?limit=10", { headers: { cookie } });
    expect(activity.status).toBe(200);
    const activityBody = (await activity.json()) as { activity: Array<{ toolName: string }> };
    expect(Array.isArray(activityBody.activity)).toBe(true);
  });

  it("exports and imports a skill zip package", async () => {
    const { db, config, root } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123" }),
    });
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const exportRes = await app.request(
      `/api/skills/${encodeURIComponent("fixtures.fake-http-game")}/export`,
      { headers: { cookie } },
    );
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toContain("application/zip");
    const zipBytes = new Uint8Array(await exportRes.arrayBuffer());
    expect(zipBytes.byteLength).toBeGreaterThan(32);

    const importedName = "imported-fake-http";
    const skillDir = path.join(root, "skills", "staging");
    fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "metadata.yaml"),
      [
        `name: ${importedName}`,
        "version: 9.9.9",
        "game: Imported",
        "description: From zip",
        "tags: [import]",
        "containerSupport: none",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# Imported\n");
    const { SkillPackageService } = await import("./services/skill-packages.js");
    const packed = new SkillPackageService(config).packDirectory(skillDir);

    const importRes = await app.request("/api/skills/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ zipBase64: Buffer.from(packed).toString("base64") }),
    });
    expect(importRes.status).toBe(200);
    const imported = (await importRes.json()) as {
      skill: { skillName: string; version: string };
    };
    expect(imported.skill.skillName).toBe(importedName);
    expect(imported.skill.version).toBe("9.9.9");
    expect(listSkills(config.skillsRoots).some((s) => s.metadata.name === importedName)).toBe(
      true,
    );
  });

  it("enforces operator vs admin capabilities", async () => {
    const { db, config } = tempConfig();
    const app = createApp(db, config);

    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "host", password: "password123", displayName: "LAN Host" }),
    });
    expect(boot.status).toBe(200);
    const ownerCookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const created = await app.request("/api/users", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerCookie,
      },
      body: JSON.stringify({
        username: "ops",
        password: "password123",
        role: "operator",
      }),
    });
    expect(created.status).toBe(200);

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ops", password: "password123" }),
    });
    expect(login.status).toBe(200);
    const opsCookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;

    const servers = await app.request("/api/servers", {
      headers: { cookie: opsCookie },
    });
    expect(servers.status).toBe(200);

    const settings = await app.request("/api/settings/llm", {
      headers: { cookie: opsCookie },
    });
    expect(settings.status).toBe(403);

    const chat = await app.request("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: opsCookie,
      },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(chat.status).toBe(403);

    const confirm = await app.request("/api/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: opsCookie,
      },
      body: JSON.stringify({ requestId: "noop", approved: false }),
    });
    expect(confirm.status).toBe(403);

    const createAsOps = await app.request("/api/users", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: opsCookie,
      },
      body: JSON.stringify({
        username: "another",
        password: "password123",
        role: "operator",
      }),
    });
    expect(createAsOps.status).toBe(403);
  });

  it("promotes a draft skill out of the drafts folder", async () => {

    const { config } = tempConfig();
    const drafts = new SkillDraftService(config);
    drafts.save({
      name: "promote-me",
      game: "Promote Me Game",
      description: "Will be promoted",
      installGuide: "# Install\n\nSteps.",
    });

    const promoted = drafts.promote("promote-me");
    expect(promoted.path).toContain(path.join("skills", "promote-me"));
    expect(fs.existsSync(path.join(promoted.path, "metadata.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(config.dataRoot, "skills", "_drafts", "promote-me"))).toBe(false);

    const discovered = listSkills(config.skillsRoots);
    expect(discovered.some((s) => s.path === promoted.path)).toBe(true);
  });
});

