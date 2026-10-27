import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NEVER_AUTO_START_MARKER_REL } from "@playon/shared";
import { servers as serversTable } from "../db/schema.js";
import { buildManagedStartEnv } from "./manage-suggest.js";
import {
  cleanupRuntimeHandleTemps,
  fake,
  host,
  nativeServer,
  pzNativeServer,
  resetRuntimeHandleFakes,
  tempEnv,
  writePzIni,
  writePzSkill,
} from "./servers-runtime-handle-fakes.js";

vi.mock("./node-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-runtime.js")>();
  return {
    ...actual,
    dispatchNodeJob: () => {
      throw new Error("remote_only");
    },
  };
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

/** Linux reads start.sh; Windows resolveScriptLaunch only accepts start.bat / run.bat. */
function writeNativeStartScripts(gameDir: string): void {
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\nsleep 30\n");
  fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\n");
}

beforeEach(() => {
  resetRuntimeHandleFakes();
});

afterEach(() => {
  cleanupRuntimeHandleTemps();
  delete process.env.PLAYON_NEVER_AUTO_START;
  delete process.env.PLAYON_DISABLE_DESIRED_STATE_RESTORE;
});

describe("desired state across a control-plane restart (#1038)", () => {
  it("records running on start and stopped on an explicit stop", async () => {
    const { servers, id } = await nativeServer();
    servers.portsBoundOverride = async () => true;

    const started = await servers.start(id);
    expect(started.desiredState).toBe("running");
    expect(started.autoStart).toBe(true);

    const stopped = await servers.stop(id);
    expect(stopped.desiredState).toBe("stopped");
    expect(stopped.status).toBe("stopped");
  });

  it("re-adopts a surviving native PID without launching a second copy", async () => {
    const { servers, id, gameDir } = await nativeServer();
    servers.portsBoundOverride = async () => true;
    await servers.start(id);
    host.calls.length = 0;
    host.specs.length = 0;
    host.plantLeftover({
      id: "native-orphan-77",
      name: `server-${id}`,
      pid: 77,
      status: "running",
    });

    const report = await servers.restoreAfterControlPlaneRestart();
    expect(report).toContainEqual({
      serverId: id,
      action: "adopt",
      reason: "process_alive",
    });
    expect((await servers.get(id))!.status).toBe("running");
    expect(host.specs).toHaveLength(0);
    expect(host.calls.some((c) => c.startsWith(`find:server-${id}:${gameDir}`))).toBe(true);
  });

  it("starts a desired-running server that is no longer alive", async () => {
    const { servers, id } = await nativeServer();
    servers.portsBoundOverride = async () => true;
    await servers.start(id);
    host.exited();
    host.calls.length = 0;
    host.specs.length = 0;

    const report = await servers.restoreAfterControlPlaneRestart();
    expect(report).toContainEqual({
      serverId: id,
      action: "start",
      reason: "desired_running",
    });
    expect(host.specs).toHaveLength(1);
    expect((await servers.get(id))!.status).toBe("running");
  });

  it("relaunches a desired-running Hub (#1045)", async () => {
    const { db, servers, id } = await pzNativeServer({ defaultPort: 16271 });
    servers.portsBoundOverride = async () => true;
    await db
      .update(serversTable)
      .set({ desiredState: "running", autoStart: true })
      .where(eq(serversTable.id, id));

    const report = await servers.restoreAfterControlPlaneRestart();
    expect(report).toContainEqual({
      serverId: id,
      action: "start",
      reason: "desired_running",
    });
    expect(host.specs).toHaveLength(1);
    expect((await servers.get(id))!.name).toBe("Hub");
    expect((await servers.get(id))!.status).toBe("running");
  });

  it("relaunches a lab soak whose name used to be treated as sacred (#1045)", async () => {
    const { db, servers, id } = await nativeServer();
    servers.portsBoundOverride = async () => true;
    await db
      .update(serversTable)
      .set({ name: "lab-soak-teeworlds", game: "Frontier", desiredState: "running" })
      .where(eq(serversTable.id, id));
    await servers.start(id);
    host.exited();
    host.calls.length = 0;
    host.specs.length = 0;

    const report = await servers.restoreAfterControlPlaneRestart();
    expect(report).toContainEqual({
      serverId: id,
      action: "start",
      reason: "desired_running",
    });
    expect(host.specs).toHaveLength(1);
  });

  it("does not relaunch a Frontier clone that reuses NZL's launch name (#1016)", async () => {
    const { db, config, servers } = tempEnv();
    writePzSkill(path.join(config.dataRoot, "skills"));
    const nzl = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "NewZombieLand3",
    });
    writePzIni(nzl.dataPath, "NewZombieLand3", 16261);
    const nzlGame = path.join(nzl.dataPath, "game");
    writeNativeStartScripts(nzlGame);
    fs.writeFileSync(
      path.join(nzlGame, ".playon-start.env"),
      buildManagedStartEnv({
        playonHome: path.join(nzl.dataPath, "home"),
        serverName: "NewZombieLand3",
      }),
    );

    const clone = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "NZL-Clone-Frontier-RD",
    });
    writePzIni(clone.dataPath, "NewZombieLand3", 16361);
    const cloneGame = path.join(clone.dataPath, "game");
    writeNativeStartScripts(cloneGame);
    fs.writeFileSync(
      path.join(cloneGame, ".playon-start.env"),
      buildManagedStartEnv({
        playonHome: path.join(clone.dataPath, "home"),
        serverName: "NewZombieLand3",
      }),
    );

    await db
      .update(serversTable)
      .set({ runtimeMode: "native", desiredState: "running", autoStart: true })
      .where(eq(serversTable.id, nzl.id));
    await db
      .update(serversTable)
      .set({ runtimeMode: "native", desiredState: "running", autoStart: true })
      .where(eq(serversTable.id, clone.id));
    servers.portsBoundOverride = async () => true;
    fake.reset();
    host.reset();
    // The shared native fake reports one process for every find(). A clone
    // must not inherit NZL's liveness or restore would adopt it.
    const originalFind = host.supervisor.find.bind(host.supervisor);
    host.supervisor.find = async (name: string, cwd: string) => {
      if (name.includes(clone.id)) return null;
      return originalFind(name, cwd);
    };

    let report;
    try {
      report = await servers.restoreAfterControlPlaneRestart();
    } finally {
      host.supervisor.find = originalFind;
    }
    expect(report).toContainEqual({
      serverId: nzl.id,
      action: "start",
      reason: "desired_running",
    });
    const cloneRow = report.find((row) => row.serverId === clone.id);
    expect(cloneRow?.action).toBe("skip");
    expect(cloneRow?.reason).toMatch(/start_identity_collision/);
    expect(host.specs).toHaveLength(1);
    expect(host.specs.some((spec) => spec.name?.includes(clone.id))).toBe(false);
  });

  it("honours per-server autoStart opt-out and a never-auto-start marker", async () => {
    const { servers, id, dataPath } = await nativeServer();
    servers.portsBoundOverride = async () => true;
    await servers.start(id);
    host.exited();
    await servers.patch(id, { autoStart: false });
    host.specs.length = 0;

    expect(await servers.restoreAfterControlPlaneRestart()).toContainEqual({
      serverId: id,
      action: "skip",
      reason: "auto_start_opt_out",
    });
    expect(host.specs).toHaveLength(0);

    await servers.patch(id, { autoStart: true });
    const marker = path.join(dataPath, ...NEVER_AUTO_START_MARKER_REL.split("/"));
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "1\n");
    expect(await servers.restoreAfterControlPlaneRestart()).toContainEqual({
      serverId: id,
      action: "skip",
      reason: "protected_from_auto_start",
    });
    expect(host.specs).toHaveLength(0);
  });

  it("does not start a server the user explicitly stopped", async () => {
    const { servers, id } = await nativeServer();
    servers.portsBoundOverride = async () => true;
    await servers.start(id);
    await servers.stop(id);
    host.specs.length = 0;

    expect(await servers.restoreAfterControlPlaneRestart()).toContainEqual({
      serverId: id,
      action: "skip",
      reason: "desired_stopped",
    });
    expect(host.specs).toHaveLength(0);
  });
});
