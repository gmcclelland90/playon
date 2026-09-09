import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { nodes as nodesTable } from "../db/schema.js";
import {
  REMOTE_NODE_ID,
  cleanupRuntimeHandleTemps,
  fake,
  host,
  node,
  remoteServer,
  resetRuntimeHandleFakes,
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

describe("remote docker lifecycle through ServerRuntimeHandle", () => {
  it("exposes a docker/remote handle from the runtime choke point", async () => {
    const { servers, id } = await remoteServer();

    const handle = await servers.runtime(id);

    expect(handle.mode).toBe("docker");
    expect(handle.locality).toBe("remote");
  });

  it("start creates and starts the container on the node, never on the Home docker", async () => {
    const { servers, id, name } = await remoteServer();

    const started = await servers.start(id);

    expect(started.status).toBe("running");
    expect(node.kinds()).toContain("container_create");
    expect(node.kinds()).toContain("container_start");
    // Home's docker adapter must stay out of a remote server's lifecycle.
    expect(fake.calls).toEqual([]);

    const create = node.jobs.find((j) => j.kind === "container_create")!;
    expect(create.args.name).toBe(name);
    expect(create.args.image).toBe("itzg/minecraft-server:latest");
    // Host paths are jail-relative so the node resolves them under its own data root.
    expect(create.args.binds).toEqual([
      { hostPath: `servers/${id}/game`, containerPath: "/data" },
    ]);
    expect((create.args.env as Record<string, string>).RCON_PORT).toBe("25575");

    expect(node.jobs.find((j) => j.kind === "container_start")!.args).toEqual({
      id: `cid-${name}`,
      serverId: id,
    });
  });

  it("start re-resolves an existing container by name instead of creating another", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    await servers.stop(id);
    node.jobs.length = 0;

    await servers.start(id);

    expect(node.kinds()).not.toContain("container_create");
    expect(node.jobs.find((j) => j.kind === "container_start")!.args.id).toBe(`cid-${name}`);
  });

  it("stop is mode-correct: the resolved container only, no process_stop", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    node.jobs.length = 0;

    const stopped = await servers.stop(id);

    expect(stopped.status).toBe("stopped");
    expect(node.kinds()).toEqual(["container_inspect", "container_stop"]);
    expect(node.jobs.at(-1)!.args).toEqual({ id: `cid-${name}`, serverId: id });
  });

  it("restart cycles the same container on the node", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);
    node.jobs.length = 0;

    const restarted = await servers.restart(id);

    expect(restarted.status).toBe("running");
    expect(node.kinds()).not.toContain("container_create");
    expect(node.kinds()).toContain("container_stop");
    expect(node.jobs.at(-1)).toMatchObject({
      kind: "container_start",
      args: { id: `cid-${name}` },
    });
  });

  it("status reconciliation follows the node's container, not Home's", async () => {
    const { servers, id, name } = await remoteServer();
    await servers.start(id);

    node.containers.get(name)!.status = "exited";
    expect((await servers.get(id))!.status).toBe("stopped");

    node.containers.get(name)!.status = "running";
    expect((await servers.get(id))!.status).toBe("running");

    node.containers.clear();
    expect((await servers.get(id))!.status).toBe("stopped");
    expect(fake.calls).toEqual([]);
  });

  it("does not question an offline node, and does not read its silence as stopped", async () => {
    const { db, servers, id } = await remoteServer();
    await servers.start(id);
    node.jobs.length = 0;
    await db
      .update(nodesTable)
      .set({ lastSeenAt: new Date(Date.now() - 3_600_000) })
      .where(eq(nodesTable.id, REMOTE_NODE_ID));

    expect((await servers.get(id))!.status).toBe("running");
    expect(node.jobs).toEqual([]);
  });
});
