import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { LAB_DOCKER_SKILL } from "../lab-games-root.js";
import { nodes as nodesTable } from "../db/schema.js";
import {
  REMOTE_NODE_ID,
  cleanupRuntimeHandleTemps,
  fake,
  host,
  nativeServer,
  node,
  remoteNativeServer,
  remoteServer,
  resetRuntimeHandleFakes,
  tempEnv,
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

describe("logs through ServerRuntimeHandle", () => {
  /** Write the console file a native server's runtime tails on this host. */
  function writeLocalConsole(dataPath: string, text: string): void {
    const file = path.join(dataPath, "logs", "console.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  it("local docker: tails the container Home runs", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    fake.calls.length = 0;

    const tail = await servers.tailLogs(server.id, 25);

    expect(tail).toEqual({ status: "running", runtime: "docker", lines: ["fake-log"] });
    expect(fake.calls).toContain(`logs:cid-playon-${server.id}:25`);
  });

  it("local docker: start follows logs through the handle, stop aborts", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    fake.calls.length = 0;

    await servers.start(server.id);
    expect(fake.calls).toContain(`follow:cid-playon-${server.id}`);

    await servers.stop(server.id);
    expect(fake.calls).toContain(`follow-abort:cid-playon-${server.id}`);
  });

  it("remote docker: tails the node's container, never Home's docker", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    node.jobs.length = 0;
    fake.calls.length = 0;

    const tail = await servers.tailLogs(id, 25);

    expect(tail).toEqual({
      status: "running",
      runtime: "docker",
      lines: ["node-log-1", "node-log-2"],
    });
    expect(node.jobs.at(-1)).toEqual({
      kind: "container_logs",
      args: { id: `cid-${name}`, tail: 25 },
    });
    // The old Home-docker-only path would have tailed the wrong host entirely.
    expect(fake.calls).toEqual([]);
  });

  it("local native: tails the console file the process writes", async () => {
    const { servers, id, dataPath } = await nativeServer();
    writeLocalConsole(dataPath, "boot\nready\nplayer joined\n");

    const tail = await servers.tailLogs(id, 2);

    expect(tail).toEqual({
      status: "stopped",
      runtime: "native",
      lines: ["ready", "player joined"],
    });
  });

  it("remote native: tails the node's console file over the fs job contract", async () => {
    const { servers, id } = await remoteNativeServer();
    node.files.set(`servers/${id}/logs/console.log`, "boot\nready\nplayer joined\n");
    node.jobs.length = 0;

    const tail = await servers.tailLogs(id, 2);

    expect(tail).toEqual({
      status: "stopped",
      runtime: "native",
      lines: ["ready", "player joined"],
    });
    expect(node.kinds().filter((k) => k === "fs_read_text")).toHaveLength(2);
    // Home neither runs nor reads for a server it does not host.
    expect(host.calls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("a runtime that cannot answer tails nothing rather than failing the read", async () => {
    const { db, servers, id } = await remoteServer();
    await db
      .update(nodesTable)
      .set({ lastSeenAt: new Date(Date.now() - 3_600_000) })
      .where(eq(nodesTable.id, REMOTE_NODE_ID));
    node.containers.clear();

    const tail = await servers.tailLogs(id, 25);

    expect(tail).toMatchObject({ runtime: "docker", lines: [] });
  });

  it("detail carries the node's container status and logs, not Home's", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    fake.calls.length = 0;

    const detail = await servers.detail(id);

    expect(detail!.runtime).toMatchObject({
      kind: "docker",
      containerName: name,
      containerStatus: "running",
      logs: ["node-log-1", "node-log-2"],
    });
    expect(fake.calls).toEqual([]);
  });

  it("detail carries a native server's console tail", async () => {
    const { servers, id, dataPath } = await nativeServer();
    writeLocalConsole(dataPath, "boot\nready\n");

    const detail = await servers.detail(id);

    expect(detail!.runtime.kind).toBe("native");
    expect(detail!.runtime.logs).toEqual(["boot", "ready"]);
  });
});
