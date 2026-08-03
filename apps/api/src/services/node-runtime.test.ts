import { describe, expect, it } from "vitest";
import { LOCAL_NODE_ID } from "@playon/shared";
import { dispatchNodeJob, nodeServerRelPath } from "./node-runtime.js";
import { nodeJobService } from "./node-jobs.js";

describe("dispatchNodeJob", () => {
  it("runs localHandler for local node", async () => {
    const result = await dispatchNodeJob({
      nodeId: LOCAL_NODE_ID,
      kind: "ping",
      localHandler: () => ({ ok: true, local: true }),
    });
    expect(result).toEqual({ ok: true, local: true });
  });

  it("enqueues remote jobs", async () => {
    const pending = dispatchNodeJob({
      nodeId: "spare-1",
      kind: "ping",
      timeoutMs: 2_000,
      localHandler: () => ({ ok: false }),
    });
    // Simulate agent claim + complete
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("spare-1");
    expect(job?.kind).toBe("ping");
    nodeJobService.complete(job!.id, { pong: true });
    await expect(pending).resolves.toEqual({ pong: true });
  });
});

describe("nodeServerRelPath", () => {
  it("joins under servers/", () => {
    expect(nodeServerRelPath("abc", "game")).toBe("servers/abc/game");
  });
});
