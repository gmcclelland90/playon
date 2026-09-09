import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { probeUdpListen } from "@playon/runtime";
import { servers as serversTable } from "../db/schema.js";
import { HealthService } from "./health.js";
import { NetToolsService } from "./net-tools.js";
import { ServerService } from "./servers.js";
import {
  bindUdp,
  cleanupRuntimeHandleTemps,
  fake,
  host,
  nativeServer,
  node,
  pzNativeServer,
  resetRuntimeHandleFakes,
  udpSockets,
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

describe("local native lifecycle through ServerRuntimeHandle", () => {
  const startScript = process.platform === "win32" ? "start.bat" : "start.sh";

  it("exposes a native/local handle from the runtime choke point", async () => {
    const { servers, id } = await nativeServer();

    const handle = await servers.runtime(id);

    expect(handle.mode).toBe("native");
    expect(handle.locality).toBe("local");
  });

  it("start launches the resolved process under the handle-owned identity", async () => {
    const { servers, id, gameDir, dataPath } = await nativeServer();

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    expect(host.calls).toEqual([
      `find:server-${id}:${gameDir}`,
      `find:server-${id}:${gameDir}`,
      `start:server-${id}:${gameDir}`,
    ]);
    const spec = host.specs[0]!;
    expect(spec.args?.join(" ")).toContain(startScript);
    expect(spec.env?.PLAYON_SERVER_ID).toBe(id);
    expect(spec.logFile).toBe(path.join(dataPath, "logs", "console.log"));
    // A native server never touches the container path.
    expect(fake.calls).toEqual([]);
  });

  it("passes PLAYON_MANAGED_FROM to the process env when skill marker has managedFrom", async () => {
    const { servers, id } = await nativeServer();
    const { writeSkillMarker, readSkillMarker } = await import("./skill-marker.js");
    const server = (await servers.get(id))!;
    const marker = readSkillMarker(server.dataPath);
    if (!marker) throw new Error("skill marker missing");
    // Simulate a managed server by adding managedFrom to the skill marker.
    writeSkillMarker(server.dataPath, { ...marker, managedFrom: "/opt/pzserver" } as never);

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    const spec = host.specs[0]!;
    expect(spec.env?.PLAYON_SERVER_ID).toBe(id);
    expect(spec.env?.PLAYON_MANAGED_FROM).toBe("/opt/pzserver");
  });

  it("start refuses a game dir with nothing to launch, and reports the error", async () => {
    const { servers, id } = await nativeServer({ startable: false });

    await expect(servers.start(id)).rejects.toThrow(/native_binaries_missing/);
    expect(host.specs).toEqual([]);
    // Nothing was launched, so the next re-resolve answers stopped over the error flag.
    expect((await servers.get(id))!.status).toBe("stopped");
  });

  it("start stops a process it re-resolved instead of stacking a second one", async () => {
    const { servers, id, gameDir } = await nativeServer();
    await servers.start(id);
    host.calls.length = 0;

    await servers.start(id);

    expect(host.calls).toEqual([
      `find:server-${id}:${gameDir}`,
      `find:server-${id}:${gameDir}`,
      `reclaim:server-${id}:${gameDir}`,
      `reclaim:server-${id}:${gameDir}`,
      `find:server-${id}:${gameDir}`,
      `start:server-${id}:${gameDir}`,
    ]);
    expect(host.specs).toHaveLength(2);
  });

  it("start reaps a leftover PID and launches exactly one new instance", async () => {
    const { servers, id, gameDir } = await nativeServer();
    host.plantLeftover({
      id: "native-orphan-99",
      name: `server-${id}`,
      pid: 99,
      status: "running",
    });
    servers.portsBoundOverride = async () => false;

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    expect(host.calls).toEqual([
      `find:server-${id}:${gameDir}`,
      `find:server-${id}:${gameDir}`,
      `reclaim:server-${id}:${gameDir}`,
      `reclaim:server-${id}:${gameDir}`,
      `find:server-${id}:${gameDir}`,
      `start:server-${id}:${gameDir}`,
    ]);
    expect(host.specs).toHaveLength(1);
    expect(host.running?.pid).not.toBe(99);
  });

  it("start does not spawn a second process when a healthy instance already exists", async () => {
    const { servers, id, gameDir } = await nativeServer();
    await servers.start(id);
    host.calls.length = 0;
    host.specs.length = 0;
    servers.portsBoundOverride = async () => true;

    const again = await servers.start(id);

    expect(again.status).toBe("running");
    expect(host.calls).toEqual([`find:server-${id}:${gameDir}`]);
    expect(host.specs).toHaveLength(0);
    expect(host.running).not.toBeNull();
  });

  it("first-see already-running + unbound ports is dead immediately (no 15 min keep)", async () => {
    const { db, servers, id } = await nativeServer();
    host.plantLeftover({
      id: "native-orphan-99",
      name: `server-${id}`,
      pid: 99,
      status: "running",
    });
    servers.portsBoundOverride = async () => false;
    servers.autoRestartOnDeadInstance = false;
    await db
      .update(serversTable)
      .set({ status: "running" })
      .where(eq(serversTable.id, id));

    const row = await servers.get(id);

    expect(row!.status).toBe("error");
    expect(host.running).toBeNull();
  });

  it("persisted start time keeps grace after a new ServerService (Home restart)", async () => {
    const { db, config, servers, id } = await nativeServer();
    await servers.start(id);
    servers.autoRestartOnDeadInstance = false;

    const restarted = new ServerService(db, config);
    restarted.portsBoundOverride = async () => false;
    restarted.autoRestartOnDeadInstance = false;

    const row = await restarted.get(id);

    expect(row!.status).toBe("running");
    expect(host.running).not.toBeNull();
  });

  it("alive process with advertised ports unbound is reaped and not reported running", async () => {
    const { servers, id, gameDir } = await nativeServer();
    await servers.start(id);
    servers.portsBoundOverride = async () => false;
    servers.portDeadGraceMs = 0;
    servers.autoRestartOnDeadInstance = false;
    host.calls.length = 0;

    const row = await servers.get(id);

    expect(row!.status).toBe("error");
    expect(host.calls).toContain(`reclaim:server-${id}:${gameDir}`);
    expect(host.running).toBeNull();
  });

  it("does not reap a live PZ instance when skill default 16261 is unbound but DefaultPort is bound", async () => {
    const prevSkip = process.env.PLAYON_SKIP_HOST_PORT_PROBE;
    delete process.env.PLAYON_SKIP_HOST_PORT_PROBE;
    try {
      const bound = await bindUdp();
      const { servers, id, gameDir } = await pzNativeServer({ defaultPort: bound.port });
      await servers.start(id);
      servers.portDeadGraceMs = 0;
      servers.autoRestartOnDeadInstance = false;
      host.calls.length = 0;

      const row = await servers.get(id);
      const join = await servers.joinInfoFor(row!);

      expect(servers.gamePortForSkill("games.project-zomboid")).toBe(16261);
      expect(join.port).toBe(bound.port);
      expect(join.port).not.toBe(16261);
      expect(row!.status).toBe("running");
      expect(host.running).not.toBeNull();
      expect(host.calls).not.toContain(`reclaim:server-${id}:${gameDir}`);
    } finally {
      if (prevSkip == null) delete process.env.PLAYON_SKIP_HOST_PORT_PROBE;
      else process.env.PLAYON_SKIP_HOST_PORT_PROBE = prevSkip;
    }
  });

  it("reaps a live PZ instance when its own DefaultPort is unbound after grace", async () => {
    const prevSkip = process.env.PLAYON_SKIP_HOST_PORT_PROBE;
    delete process.env.PLAYON_SKIP_HOST_PORT_PROBE;
    try {
      const parked = await bindUdp();
      const defaultPort = parked.port;
      parked.socket.close();
      const idx = udpSockets.indexOf(parked.socket);
      if (idx >= 0) udpSockets.splice(idx, 1);

      const { servers, id, gameDir } = await pzNativeServer({ defaultPort });
      await servers.start(id);
      servers.portDeadGraceMs = 0;
      servers.autoRestartOnDeadInstance = false;
      if (probeUdpListen(defaultPort).probe === "unavailable") return;
      host.calls.length = 0;

      const row = await servers.get(id);

      expect(row!.status).toBe("error");
      expect(host.calls).toContain(`reclaim:server-${id}:${gameDir}`);
      expect(host.running).toBeNull();
    } finally {
      if (prevSkip == null) delete process.env.PLAYON_SKIP_HOST_PORT_PROBE;
      else process.env.PLAYON_SKIP_HOST_PORT_PROBE = prevSkip;
    }
  });

  it("health restart reaps a leftover and starts exactly one instance", async () => {
    const { db, config, servers, id } = await nativeServer();
    host.plantLeftover({
      id: "native-orphan-99",
      name: `server-${id}`,
      pid: 99,
      status: "running",
    });
    // Leftover is unbound; the instance health-restart launches is healthy.
    servers.portsBoundOverride = async () => host.running?.pid !== 99;
    servers.portDeadGraceMs = 0;
    servers.autoRestartOnDeadInstance = false;
    await db
      .update(serversTable)
      .set({ status: "running" })
      .where(eq(serversTable.id, id));

    const health = new HealthService(servers, new NetToolsService(servers), config);
    const report = await health.checkServer(id, { remediate: true });

    expect(report.checks.some((c) => c.remediated === "restart")).toBe(true);
    expect(host.specs).toHaveLength(1);
    expect(host.running).not.toBeNull();
    expect(host.running?.pid).not.toBe(99);
  });

  it("stop reclaims by identity, never by a stored process id", async () => {
    const { servers, id, gameDir } = await nativeServer();
    await servers.start(id);
    host.calls.length = 0;

    const stopped = await servers.stop(id);

    expect(stopped.status).toBe("stopped");
    expect(host.calls).toEqual([`find:server-${id}:${gameDir}`, `reclaim:server-${id}:${gameDir}`]);
    expect(host.calls.some((c) => c.startsWith("stop:"))).toBe(false);
    expect(host.running).toBeNull();
  });

  it("stop is mode-correct on Home native: no docker dual-fire after handle.stop", async () => {
    const { servers, id } = await nativeServer();
    await servers.start(id);
    fake.calls.length = 0;

    await servers.stop(id);

    expect(fake.calls).toEqual([]);
  });

  it("restart cycles the same identity", async () => {
    const { servers, id, gameDir } = await nativeServer();
    await servers.start(id);
    host.calls.length = 0;

    const restarted = await servers.restart(id);

    expect(restarted.status).toBe("running");
    expect(host.calls).toEqual([
      `find:server-${id}:${gameDir}`,
      `reclaim:server-${id}:${gameDir}`,
      `find:server-${id}:${gameDir}`,
      `find:server-${id}:${gameDir}`,
      `start:server-${id}:${gameDir}`,
    ]);
  });

  it("status reconciliation follows the process, not a remembered id", async () => {
    const { servers, id } = await nativeServer();
    await servers.start(id);

    expect((await servers.get(id))!.status).toBe("running");

    host.exited();
    expect((await servers.get(id))!.status).toBe("stopped");
  });

  it("a fresh control plane re-resolves the running process from identity", async () => {
    const { db, config, servers, id } = await nativeServer();
    await servers.start(id);

    // No durable process map: a new service must still see the running server.
    const reborn = new ServerService(db, config);
    expect((await reborn.get(id))!.status).toBe("running");
  });
});
