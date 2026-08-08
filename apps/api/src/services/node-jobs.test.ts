import { describe, expect, it } from "vitest";
import { NodeJobError } from "@playon/shared";
import { NodeJobService } from "./node-jobs.js";

const SELF_UPDATE_ARGS = {
  downloadUrl: "https://example.com/playon-node-0.1.11-linux-x64.tar.gz",
  sha256: "b".repeat(64),
  version: "0.1.11",
};

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

  it("validates args of contracted kinds before queueing", () => {
    const svc = new NodeJobService();
    try {
      svc.enqueue("node-a", "node_self_update", { downloadUrl: "nope", sha256: "short" });
      expect.unreachable("expected enqueue to refuse invalid args");
    } catch (err) {
      expect(err).toBeInstanceOf(NodeJobError);
      expect((err as NodeJobError).code).toBe("validation_failed");
    }
    expect(svc.claimNext("node-a")).toBeNull();
  });

  it("normalizes fs args and refuses a jail escape before queueing", () => {
    const svc = new NodeJobService();
    const job = svc.enqueue("node-a", "fs_write_text", { path: "servers/a/x.ini" });
    expect(job.args).toEqual({ path: "servers/a/x.ini", content: "" });
    expect(() => svc.enqueue("node-a", "fs_remove", { path: "../../etc" })).toThrow(
      /validation_failed/,
    );
    expect(() =>
      svc.enqueue("node-a", "fs_list", { path: ".", tail: 10 }),
    ).toThrow(/validation_failed/);
  });

  it("normalizes process and steamcmd args before queueing", () => {
    const svc = new NodeJobService();
    const start = svc.enqueue("node-a", "process_start", {
      name: "server-a",
      command: "/bin/bash",
      args: ["start.sh"],
      cwd: "servers/a/game",
      serverId: "a",
      logRel: "servers/a/console.log",
    });
    expect(start.args).toEqual({
      name: "server-a",
      command: "/bin/bash",
      args: ["start.sh"],
      cwd: "servers/a/game",
      env: {},
      serverId: "a",
      logRel: "servers/a/console.log",
    });
    // A lost process id is normal after a restart; a missing one on status is not.
    expect(svc.enqueue("node-a", "process_stop", { cwd: "servers/a/game" }).args).toEqual({
      id: "",
      name: "",
      cwd: "servers/a/game",
    });
    expect(() => svc.enqueue("node-a", "process_status", {})).toThrow(/validation_failed/);

    expect(
      svc.enqueue("node-a", "steamcmd_app_update", { serverRel: "servers/a", appId: 258_550 }).args,
    ).toEqual({ serverRel: "servers/a", appId: 258_550, installDirRel: "game", validate: true });
    expect(() =>
      svc.enqueue("node-a", "steamcmd_app_update", { serverRel: "servers/a", appId: 0 }),
    ).toThrow(/validation_failed/);
  });

  it("normalizes manage args and refuses a destination outside the server", () => {
    const svc = new NodeJobService();
    expect(svc.enqueue("node-a", "manage_probe", { roots: ["/srv/games"] }).args).toEqual({
      roots: ["/srv/games"],
      hints: [],
      maxDepth: 2,
      maxCandidates: 40,
    });
    expect(() =>
      svc.enqueue("node-a", "manage_seed", {
        sourcePath: "/opt/pzserver",
        allowRoots: ["/opt"],
        destRel: "servers/abc/home",
      }),
    ).toThrow(/validation_failed/);
    expect(() => svc.enqueue("node-a", "manage_probe", { roots: ["/srv"], extra: 1 })).toThrow(
      /validation_failed/,
    );
  });

  it("refuses kinds a node does not advertise", () => {
    const svc = new NodeJobService();
    svc.advertiseJobKinds("node-a", ["ping"]);
    expect(svc.advertisedJobKinds("node-a")).toEqual(["ping"]);
    expect(svc.supportsKind("node-a", "ping")).toBe(true);
    expect(svc.supportsKind("node-a", "fs_list")).toBe(false);
    try {
      svc.enqueue("node-a", "fs_list", { path: "." });
      expect.unreachable("expected enqueue to refuse an unadvertised kind");
    } catch (err) {
      expect((err as NodeJobError).code).toBe("unsupported_job_kind");
    }
    expect(() => svc.enqueue("node-a", "ping")).not.toThrow();
  });

  it("stays optimistic for agents that advertise nothing", () => {
    const svc = new NodeJobService();
    svc.advertiseJobKinds("legacy-node", undefined);
    expect(svc.advertisedJobKinds("legacy-node")).toBeNull();
    expect(() => svc.enqueue("legacy-node", "fs_list", { path: "." })).not.toThrow();
  });

  it("forgets the advertisement when a self-update is queued", () => {
    const svc = new NodeJobService();
    svc.advertiseJobKinds("node-a", ["ping", "node_self_update"]);
    svc.enqueue("node-a", "node_self_update", SELF_UPDATE_ARGS);
    expect(svc.advertisedJobKinds("node-a")).toBeNull();
    // Post-update the kind set is unknown again, so dispatch goes back to optimistic.
    expect(() => svc.enqueue("node-a", "fs_list", { path: "." })).not.toThrow();
  });

  it("reports a typed timeout when a node never answers", async () => {
    const svc = new NodeJobService();
    const job = svc.enqueue("node-a", "ping");
    await expect(svc.waitFor(job.id, { timeoutMs: 20, intervalMs: 5 })).rejects.toMatchObject({
      code: "timeout",
      kind: "ping",
    });
  });

  it("releases in-flight waiters on abort instead of holding their full timeout", async () => {
    const svc = new NodeJobService();
    const job = svc.enqueue("node-a", "ping");
    const waiting = svc.waitFor(job.id, { timeoutMs: 60_000, intervalMs: 30_000 });
    const startedAt = Date.now();
    // Give the poll a tick to park on its interval before shutdown fires.
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.abortWaiters("control_plane_SIGTERM")).toBe(1);
    await expect(waiting).rejects.toMatchObject({ code: "timeout", kind: "ping" });
    await expect(waiting).rejects.toThrow(/control_plane_SIGTERM/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // Waiters deregister, so a second shutdown pass has nothing left to release.
    expect(svc.abortWaiters()).toBe(0);
  });

  it("leaves queued jobs alone when waiters are aborted", async () => {
    const svc = new NodeJobService();
    const job = svc.enqueue("node-a", "ping");
    expect(svc.abortWaiters()).toBe(0);
    expect(svc.get(job.id)?.status).toBe("queued");
    svc.complete(job.id, { pong: true });
    expect((await svc.waitFor(job.id, { timeoutMs: 1000 })).status).toBe("done");
  });
});
