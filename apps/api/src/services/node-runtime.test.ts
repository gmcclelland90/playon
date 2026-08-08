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
    const pending = dispatchNodeJob<{ entries: Array<{ name: string }> }>({
      nodeId: "spare-4",
      kind: "fs_list",
      args: { path: "servers" },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("spare-4");
    expect(job?.args).toEqual({ path: "servers" });
    nodeJobService.complete(job!.id, { entries: [{ name: "a.txt" }] });
    await expect(pending).resolves.toEqual({ entries: [{ name: "a.txt" }] });
  });

  it("refuses kinds the node does not advertise", async () => {
    nodeJobService.advertiseJobKinds("spare-5", ["ping"]);
    try {
      await expect(
        dispatchNodeJob({
          nodeId: "spare-5",
          kind: "fs_list",
          args: { path: "." },
          localHandler: () => ({}),
        }),
      ).rejects.toMatchObject({ code: "unsupported_job_kind" });
    } finally {
      nodeJobService.forgetJobKinds("spare-5");
    }
  });
});

describe("nodeServerRelPath", () => {
  it("builds jail-relative server paths", () => {
    expect(nodeServerRelPath("abc", "game")).toBe("servers/abc/game");
  });
});
