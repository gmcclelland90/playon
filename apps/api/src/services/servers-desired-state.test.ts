import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NEVER_AUTO_START_MARKER_REL } from "@playon/shared";
import { servers as serversTable } from "../db/schema.js";
import {
  cleanupRuntimeHandleTemps,
  fake,
  host,
  nativeServer,
  pzNativeServer,
  resetRuntimeHandleFakes,
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

  it("does not auto-start a sacred Hub even when desiredState is running", async () => {
    const { db, servers, id } = await pzNativeServer({ defaultPort: 16271 });
    servers.portsBoundOverride = async () => false;
    await db
      .update(serversTable)
      .set({ desiredState: "running", autoStart: true })
      .where(eq(serversTable.id, id));

    const report = await servers.restoreAfterControlPlaneRestart();
    expect(report).toContainEqual({
      serverId: id,
      action: "skip",
      reason: "protected_from_auto_start",
    });
    expect(host.specs).toHaveLength(0);
    expect((await servers.get(id))!.name).toBe("Hub");
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
