import { describe, expect, it } from "vitest";
import { NodeJobService } from "./node-jobs.js";

describe("NodeJobService", () => {
  it("enqueues, claims, and completes jobs in order", async () => {
    const svc = new NodeJobService();
    const a = svc.enqueue("node-a", "ping");
    const b = svc.enqueue("node-a", "fs_list", { path: "." });
    expect(svc.claimNext("other")).toBeNull();
    const claimed = svc.claimNext("node-a");
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.status).toBe("running");
    svc.complete(a.id, { pong: true });
    const done = await svc.waitFor(a.id, { timeoutMs: 1000 });
    expect(done.status).toBe("done");
    expect(done.result).toEqual({ pong: true });
    const next = svc.claimNext("node-a");
    expect(next?.id).toBe(b.id);
    svc.fail(b.id, "boom");
    expect(svc.get(b.id)?.status).toBe("failed");
  });
});
