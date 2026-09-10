import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { nodes as nodesTable, servers as serversTable } from "../db/schema.js";
import { ServerService } from "./servers.js";
import {
  REMOTE_NODE_ID,
  cleanupRuntimeHandleTemps,
  fake,
  host,
  node,
  placeOnRemoteNode,
  remoteNativeServer,
  resetRuntimeHandleFakes,
  tempEnv,
  writeFoundrySkill,
} from "./servers-runtime-handle-fakes.js";

vi.mock("./node-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-runtime.js")>();
  return {
    ...actual,
    dispatchNodeJob: (opts: { kind: string; args?: Record<string, unknown> }) =>
      node.dispatch(opts),
  };
});

vi.mock("./node-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-sync.js")>();
  return { ...actual, pushServerDirToNode: async () => undefined };
});

vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  const { unitRuntimeDockerStubs } = await import("../test/unit-runtime-mocks.js");
  return {
    ...actual,
    ...unitRuntimeDockerStubs(actual),
    createRuntime: async () => ({
      docker: fake.docker as never,
      process: host.supervisor,
      mode: "docker" as const,
    }),
  };
});

/**
 * Split from servers-runtime-handle.test.ts so Windows CI does not pack ~177s
 * of SQLite/fs work into one vitest file near the birpc onTaskUpdate cliff
 * (#912 / vitest#6511).
 */

beforeEach(() => {
  resetRuntimeHandleFakes();
});

afterEach(() => {
  cleanupRuntimeHandleTemps();
});

describe("remote native lifecycle through ServerRuntimeHandle", () => {
  const processKinds = (): string[] => node.kinds().filter((k) => k.startsWith("process_"));

  it("exposes a native/remote handle from the runtime choke point", async () => {
    const { servers, id } = await remoteNativeServer();

    const handle = await servers.runtime(id);

    expect(handle.mode).toBe("native");
    expect(handle.locality).toBe("remote");
  });

  it("starts the process on the node, never on Home's supervisor or docker", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    expect(processKinds()).toEqual(["process_status", "process_status", "process_start"]);
    // Home runs neither the process nor a container for a server it does not host.
    expect(host.calls).toEqual([]);
    expect(fake.calls).toEqual([]);

    expect(node.jobs.find((j) => j.kind === "process_start")!.args).toEqual({
      name: procName,
      command: "/bin/bash",
      args: ["start.sh"],
      cwd,
      env: { PLAYON_SERVER_ID: id },
      serverId: id,
      // keepStdin omitted when false — older agents reject unrecognized keys.
      // Jail-relative, so the node writes the console under its own data root.
      logRel: `servers/${id}/logs/console.log`,
    });
  });

  it("passes PLAYON_MANAGED_FROM to the process env when skill marker has managedFrom", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();
    const { writeSkillMarker, readSkillMarker } = await import("./skill-marker.js");
    const server = (await servers.get(id))!;
    const marker = readSkillMarker(server.dataPath);
    if (!marker) throw new Error("skill marker missing");
    // Simulate a managed server by adding managedFrom to the skill marker.
    writeSkillMarker(server.dataPath, { ...marker, managedFrom: "/opt/pzserver" } as never);

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    const startArgs = node.jobs.find((j) => j.kind === "process_start")!.args;
    expect(startArgs).toEqual({
      name: procName,
      command: "/bin/bash",
      args: ["start.sh"],
      cwd,
      env: { PLAYON_SERVER_ID: id, PLAYON_MANAGED_FROM: "/opt/pzserver" },
      serverId: id,
      logRel: `servers/${id}/logs/console.log`,
    });
  });

  it("re-resolves the node's process on start instead of stacking a second one", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;

    await servers.start(id);

    expect(processKinds()).toEqual([
      "process_status",
      "process_status",
      "process_stop",
      "process_stop",
      "process_status",
      "process_start",
    ]);
    expect(node.jobs.find((j) => j.kind === "process_stop")!.args).toEqual({
      id: `native-${procName}-1`,
      name: procName,
      cwd,
      serverId: id,
    });
  });

  it("stop is mode-correct: the node's process only, no container_stop", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;

    const stopped = await servers.stop(id);

    expect(stopped.status).toBe("stopped");
    expect(node.kinds()).toEqual(["process_status", "process_stop"]);
    expect(node.jobs.at(-1)!.args).toEqual({
      id: `native-${procName}-1`,
      name: procName,
      cwd,
      serverId: id,
    });
    expect(fake.calls).toEqual([]);
  });

  it("restart cycles the same identity on the node", async () => {
    const { servers, id } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;

    const restarted = await servers.restart(id);

    expect(restarted.status).toBe("running");
    expect(processKinds()).toEqual([
      "process_status",
      "process_stop",
      "process_status",
      "process_status",
      "process_start",
    ]);
  });

  it("status reconciliation follows the node's process, by identity", async () => {
    const { servers, id, procName, cwd } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;

    expect((await servers.get(id))!.status).toBe("running");
    expect(node.jobs.at(-1)).toEqual({ kind: "process_status", args: { name: procName, cwd } });

    // The game exits on the node; Home learns it from the next re-resolve.
    node.processes.clear();
    expect((await servers.get(id))!.status).toBe("stopped");
  });

  it("a fresh control plane re-resolves the node's process from identity alone", async () => {
    const { db, config, servers, id } = await remoteNativeServer();
    await servers.start(id);

    // No durable process map survives a restart, and none is needed.
    const reborn = new ServerService(db, config);
    expect((await reborn.get(id))!.status).toBe("running");
  });

  it("does not question an offline node, and does not read its silence as stopped", async () => {
    const { db, servers, id } = await remoteNativeServer();
    await servers.start(id);
    node.jobs.length = 0;
    await db
      .update(nodesTable)
      .set({ lastSeenAt: new Date(Date.now() - 3_600_000) })
      .where(eq(nodesTable.id, REMOTE_NODE_ID));

    expect((await servers.get(id))!.status).toBe("running");
    expect(node.jobs).toEqual([]);
  });

  it("starts Foundry on Windows as the PE, not cmd /c start.bat (#958)", async () => {
    const { db, config, servers } = tempEnv();
    writeFoundrySkill(path.join(config.dataRoot!, "skills"));
    const created = await servers.createFromSkill({ skillName: "games.foundry" });
    await db
      .update(serversTable)
      .set({ runtimeMode: "native" })
      .where(eq(serversTable.id, created.id));
    await placeOnRemoteNode(db, created.id, { os: "windows" });
    node.jobs.length = 0;

    const started = await servers.start(created.id);

    expect(started.status).toBe("running");
    const start = node.jobs.find((j) => j.kind === "process_start");
    expect(start?.args).toMatchObject({
      command: "FoundryDedicatedServer.exe",
      args: ["-log", "-batchmode", "-nographics"],
      cwd: `servers/${created.id}/game`,
    });
    expect(String(start?.args.command)).not.toMatch(/cmd\.exe/i);
    expect(start?.args.env).toMatchObject({
      SteamAppId: "983870",
      SteamGameId: "983870",
    });
    const cfgWrite = node.jobs.find(
      (j) => j.kind === "fs_write_text" && String(j.args.path).endsWith("game/app.cfg"),
    );
    expect(String(cfgWrite?.args.content ?? "")).toMatch(/server_is_public=false/);
  });
});
