import { describe, expect, it } from "vitest";
import { LOCAL_NODE_ID, NodeJobError } from "@playon/shared";
import { dispatchNodeJob, nodeServerRelPath } from "./node-runtime.js";
import { nodeJobService } from "./node-jobs.js";

function pingResult(nodeId: string) {
  return {
    pong: true,
    nodeId,
    dataRoot: "/var/lib/playon-node",
    at: new Date().toISOString(),
  };
}

describe("dispatchNodeJob", () => {
  it("runs localHandler for local node", async () => {
    const result = await dispatchNodeJob({
      nodeId: LOCAL_NODE_ID,
      kind: "ping",
      localHandler: () => pingResult(LOCAL_NODE_ID),
    });
    expect(result.pong).toBe(true);
    expect(result.nodeId).toBe(LOCAL_NODE_ID);
  });

  it("validates args on the local path too", async () => {
    await expect(
      dispatchNodeJob({
        nodeId: LOCAL_NODE_ID,
        kind: "ping",
        args: { path: "/etc" } as never,
        localHandler: () => pingResult(LOCAL_NODE_ID),
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "ping" });
  });

  it("validates localHandler results for contracted kinds", async () => {
    await expect(
      dispatchNodeJob({
        nodeId: LOCAL_NODE_ID,
        kind: "ping",
        // Local and remote shores must agree on the contract.
        localHandler: () => ({ pong: true }) as never,
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "ping" });
  });

  it("enqueues remote jobs and parses the result", async () => {
    const pending = dispatchNodeJob({
      nodeId: "spare-1",
      kind: "ping",
      timeoutMs: 2_000,
      localHandler: () => pingResult("spare-1"),
    });
    // Simulate agent claim + complete
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("spare-1");
    expect(job?.kind).toBe("ping");
    nodeJobService.complete(job!.id, pingResult("spare-1"));
    await expect(pending).resolves.toMatchObject({ pong: true, nodeId: "spare-1" });
  });

  it("rejects a remote result that breaks the contract", async () => {
    const pending = dispatchNodeJob({
      nodeId: "spare-2",
      kind: "ping",
      timeoutMs: 2_000,
      localHandler: () => pingResult("spare-2"),
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("spare-2");
    nodeJobService.complete(job!.id, { pong: true });
    await expect(pending).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("maps a reported failure onto a typed error", async () => {
    const pending = dispatchNodeJob({
      nodeId: "spare-3",
      kind: "ping",
      timeoutMs: 2_000,
      localHandler: () => pingResult("spare-3"),
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("spare-3");
    nodeJobService.fail(job!.id, "unsupported_job_kind: ping");
    await expect(pending).rejects.toBeInstanceOf(NodeJobError);
    await pending.catch((err: NodeJobError) => {
      expect(err.code).toBe("unsupported_job_kind");
    });
  });

  it("keeps the untyped shim for unmigrated kinds", async () => {
    const pending = dispatchNodeJob<{ running: boolean }>({
      nodeId: "spare-4",
      kind: "process_status",
      args: { id: "abc" },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("spare-4");
    expect(job?.args).toEqual({ id: "abc" });
    nodeJobService.complete(job!.id, { running: true });
    await expect(pending).resolves.toEqual({ running: true });
  });

  it("refuses kinds the node does not advertise", async () => {
    nodeJobService.advertiseJobKinds("spare-5", ["ping"]);
    try {
      await expect(
        dispatchNodeJob({
          nodeId: "spare-5",
          kind: "fs_list",
          args: { path: "." },
          localHandler: () => ({ path: ".", entries: [] }),
        }),
      ).rejects.toMatchObject({ code: "unsupported_job_kind" });
    } finally {
      nodeJobService.forgetJobKinds("spare-5");
    }
  });
});

describe("dispatchNodeJob — fs family", () => {
  it("infers args and result from the fs kind", async () => {
    const pending = dispatchNodeJob({
      nodeId: "fs-1",
      kind: "fs_read_text",
      args: { path: "servers/a/logs/console.log", offset: 4 },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("fs-1");
    // Defaults are applied before the job is queued, so the agent sees full args.
    expect(job?.args).toEqual({ path: "servers/a/logs/console.log", offset: 4 });
    nodeJobService.complete(job!.id, {
      path: "servers/a/logs/console.log",
      content: "line",
      bytesRead: 4,
      truncated: false,
      size: 8,
    });
    const result = await pending;
    expect(result.content).toBe("line");
    expect(result.truncated).toBe(false);
  });

  it("rejects an fs result that breaks the contract", async () => {
    const pending = dispatchNodeJob({
      nodeId: "fs-2",
      kind: "fs_list",
      args: { path: "servers/a" },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("fs-2");
    nodeJobService.complete(job!.id, { entries: [{ name: "game", type: "folder" }] });
    await expect(pending).rejects.toMatchObject({ code: "validation_failed", kind: "fs_list" });
  });

  it("refuses a jail escape before enqueueing", async () => {
    await expect(
      dispatchNodeJob({
        nodeId: "fs-3",
        kind: "fs_remove",
        args: { path: "servers/../../etc" },
        localHandler: () => ({ path: "x", ok: true }),
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "fs_remove" });
    expect(nodeJobService.claimNext("fs-3")).toBeNull();
  });

  it("validates fs results produced locally too", async () => {
    await expect(
      dispatchNodeJob({
        nodeId: LOCAL_NODE_ID,
        kind: "fs_write_text",
        args: { path: "servers/a/x.ini", content: "k=v" },
        localHandler: () => ({ ok: true }) as never,
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "fs_write_text" });

    await expect(
      dispatchNodeJob({
        nodeId: LOCAL_NODE_ID,
        kind: "fs_write_text",
        args: { path: "servers/a/x.ini", content: "k=v" },
        localHandler: () => ({ path: "servers/a/x.ini", bytes: 3 }),
      }),
    ).resolves.toEqual({ path: "servers/a/x.ini", bytes: 3 });
  });
});

describe("dispatchNodeJob — container family", () => {
  it("fills create defaults before enqueue and infers the info result", async () => {
    const pending = dispatchNodeJob({
      nodeId: "ctr-1",
      kind: "container_create",
      args: {
        name: "playon-abc",
        image: "itzg/minecraft-server:latest",
        ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
        binds: [{ hostPath: "servers/abc/game", containerPath: "/data" }],
      },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("ctr-1");
    expect(job?.args).toEqual({
      name: "playon-abc",
      image: "itzg/minecraft-server:latest",
      env: {},
      ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
      binds: [{ hostPath: "servers/abc/game", containerPath: "/data" }],
    });
    nodeJobService.complete(job!.id, { id: "9f2c1b", name: "playon-abc", status: "created" });
    const result = await pending;
    expect(result.id).toBe("9f2c1b");
    expect(result.status).toBe("created");
  });

  it("rejects a container result that breaks the contract", async () => {
    const pending = dispatchNodeJob({
      nodeId: "ctr-2",
      kind: "container_inspect",
      args: { id: "playon-abc" },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("ctr-2");
    nodeJobService.complete(job!.id, { id: "9f2c1b", name: "playon-abc", status: "paused" });
    await expect(pending).rejects.toMatchObject({
      code: "validation_failed",
      kind: "container_inspect",
    });
  });

  it("refuses a bind escape before enqueueing", async () => {
    await expect(
      dispatchNodeJob({
        nodeId: "ctr-3",
        kind: "container_create",
        args: {
          name: "playon-abc",
          image: "busybox",
          binds: [{ hostPath: "servers/../../etc", containerPath: "/data" }],
        },
        localHandler: () => ({ id: "x", name: "playon-abc", status: "created" as const }),
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "container_create" });
    expect(nodeJobService.claimNext("ctr-3")).toBeNull();
  });

  it("validates container results produced locally too", async () => {
    await expect(
      dispatchNodeJob({
        nodeId: LOCAL_NODE_ID,
        kind: "container_stdin",
        args: { id: "playon-abc", line: "say hi" },
        localHandler: () => ({ ok: true }),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      dispatchNodeJob({
        nodeId: LOCAL_NODE_ID,
        kind: "container_stdin",
        args: { id: "playon-abc", line: "say hi" },
        localHandler: () => ({ wrote: true }) as never,
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "container_stdin" });
  });
});

describe("nodeServerRelPath", () => {
  it("builds jail-relative server paths", () => {
    expect(nodeServerRelPath("abc", "game")).toBe("servers/abc/game");
  });
});
