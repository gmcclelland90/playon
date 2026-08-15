import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP,
  NodeJobError,
  WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME,
  WINDOWS_OTA_ESM_BOOTSTRAP_REL,
} from "@playon/shared";
import { isDurableOtaBootstrapJob, NodeJobService, shouldAbandonRunningJobOnReclaim } from "./node-jobs.js";

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

  it("validates net_udp_listen before queueing", () => {
    const svc = new NodeJobService();
    expect(svc.enqueue("node-a", "net_udp_listen", { port: 27015 }).args).toEqual({ port: 27015 });
    expect(() => svc.enqueue("node-a", "net_udp_listen", { port: 0 })).toThrow(/validation_failed/);
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

  it("lets the vintage Windows agent claim bootstrap jobs while a tracked ESM self-update is running (#885)", () => {
    const svc = new NodeJobService();
    const tracked = svc.enqueue(
      "win-1",
      "node_self_update",
      { ...SELF_UPDATE_ARGS, via: NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP },
      { status: "running" },
    );
    const write = svc.enqueue("win-1", "fs_write_text", {
      path: WINDOWS_OTA_ESM_BOOTSTRAP_REL,
      content: "Write-Host bootstrap",
    });
    const start = svc.enqueue("win-1", "process_start", {
      name: WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME,
      command: "powershell.exe",
      args: ["-File", WINDOWS_OTA_ESM_BOOTSTRAP_REL],
      cwd: ".",
    });
    expect(isDurableOtaBootstrapJob(write)).toBe(true);
    expect(isDurableOtaBootstrapJob(start)).toBe(true);
    expect(svc.claimNext("win-1")?.id).toBe(write.id);
    expect(svc.get(tracked.id)?.status).toBe("running");
    svc.complete(write.id, { path: WINDOWS_OTA_ESM_BOOTSTRAP_REL, bytes: 8 });
    expect(svc.claimNext("win-1")?.id).toBe(start.id);
    expect(svc.claimNext("win-1")).toBeNull();
    const done = svc.reconcileSelfUpdateOnHeartbeat("win-1", "0.1.11");
    expect(done?.status).toBe("done");
    expect(svc.get(tracked.id)?.status).toBe("done");
  });

  it("never hands an esm-bootstrap node_self_update to the agent", () => {
    const svc = new NodeJobService();
    svc.enqueue(
      "win-1",
      "node_self_update",
      { ...SELF_UPDATE_ARGS, via: NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP },
    );
    expect(svc.claimNext("win-1")).toBeNull();
    expect(svc.findActive("win-1", "node_self_update")?.args.via).toBe("esm-bootstrap");
  });

  it("does not abandon a running node_self_update when the agent reconnects", () => {
    expect(shouldAbandonRunningJobOnReclaim("ping")).toBe(true);
    expect(shouldAbandonRunningJobOnReclaim("node_self_update")).toBe(false);
    const svc = new NodeJobService();
    const job = svc.enqueue("win-1", "node_self_update", SELF_UPDATE_ARGS);
    expect(svc.claimNext("win-1")?.id).toBe(job.id);
    expect(svc.claimNext("win-1")).toBeNull();
    expect(svc.get(job.id)?.status).toBe("running");
    expect(svc.get(job.id)?.error).toBeUndefined();
  });

  it("still abandons a running ping when the agent reclaims", () => {
    const svc = new NodeJobService();
    const ping = svc.enqueue("win-1", "ping");
    const next = svc.enqueue("win-1", "fs_list", { path: "." });
    expect(svc.claimNext("win-1")?.id).toBe(ping.id);
    const claimed = svc.claimNext("win-1");
    expect(claimed?.id).toBe(next.id);
    expect(svc.get(ping.id)?.status).toBe("failed");
    expect(svc.get(ping.id)?.error).toMatch(/abandoned: agent reclaimed without completing/);
  });

  it("completes an in-flight self-update when heartbeat shows the target version", () => {
    const svc = new NodeJobService();
    const job = svc.enqueue("win-1", "node_self_update", SELF_UPDATE_ARGS);
    svc.claimNext("win-1");
    const done = svc.reconcileSelfUpdateOnHeartbeat("win-1", "0.1.11");
    expect(done?.status).toBe("done");
    expect(svc.get(job.id)?.status).toBe("done");
    expect(svc.claimNext("win-1")).toBeNull();
  });

  it("does not complete a self-update heartbeat that is still on the old stamp", () => {
    const svc = new NodeJobService();
    const job = svc.enqueue("win-1", "node_self_update", { ...SELF_UPDATE_ARGS, version: "0.2.4" });
    svc.claimNext("win-1");
    expect(svc.reconcileSelfUpdateOnHeartbeat("win-1", "0.2.3")).toBeNull();
    expect(svc.get(job.id)?.status).toBe("running");
  });

  it("fails a stale self-update if the old stamp is still heartbeating", () => {
    const svc = new NodeJobService();
    const job = svc.enqueue("win-1", "node_self_update", { ...SELF_UPDATE_ARGS, version: "0.2.4" });
    svc.claimNext("win-1");
    const later = Date.parse(job.createdAt) + 16 * 60 * 1000;
    const failed = svc.reconcileSelfUpdateOnHeartbeat("win-1", "0.2.3", later, 15 * 60 * 1000);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/did not land after restart/);
  });

  it("findLatest returns failed jobs so the UI can surface them", () => {
    const svc = new NodeJobService();
    const job = svc.enqueue("node-a", "node_self_update", SELF_UPDATE_ARGS);
    svc.fail(job.id, "update_sha256_mismatch");
    expect(svc.findActive("node-a", "node_self_update")).toBeNull();
    expect(svc.findLatest("node-a", "node_self_update")).toMatchObject({
      id: job.id,
      status: "failed",
      error: "update_sha256_mismatch",
    });
  });

  it("persists vintage Windows OTA bootstrap helpers with the tracked self-update (#885)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-jobs-esm-"));
    const file = path.join(dir, "node-self-update-jobs.json");
    try {
      const a = new NodeJobService();
      a.attachPersistFile(file);
      a.enqueue(
        "win-1",
        "node_self_update",
        { ...SELF_UPDATE_ARGS, via: NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP },
        { status: "running" },
      );
      a.enqueue("win-1", "fs_write_text", {
        path: WINDOWS_OTA_ESM_BOOTSTRAP_REL,
        content: "Write-Host bootstrap",
      });
      a.enqueue("win-1", "ping");
      const dumped = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ kind: string }>;
      expect(dumped.map((row) => row.kind).sort()).toEqual(["fs_write_text", "node_self_update"]);
      const b = new NodeJobService();
      b.attachPersistFile(file);
      expect(b.findActive("win-1", "node_self_update")?.args.via).toBe("esm-bootstrap");
      expect(b.claimNext("win-1")?.kind).toBe("fs_write_text");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists node_self_update jobs across a new service instance", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-jobs-"));
    const file = path.join(dir, "node-self-update-jobs.json");
    try {
      const a = new NodeJobService();
      a.attachPersistFile(file);
      const job = a.enqueue("win-1", "node_self_update", SELF_UPDATE_ARGS);
      a.enqueue("win-1", "ping");
      const dumped = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ kind: string }>;
      expect(dumped.every((row) => row.kind === "node_self_update")).toBe(true);
      const b = new NodeJobService();
      b.attachPersistFile(file);
      expect(b.get(job.id)?.status).toBe("queued");
      expect(b.get(job.id)?.nodeId).toBe("win-1");
      expect(b.claimNext("win-1")?.kind).toBe("node_self_update");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a running node_self_update across reload so reconnect is not abandoned", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-jobs-"));
    const file = path.join(dir, "node-self-update-jobs.json");
    try {
      const a = new NodeJobService();
      a.attachPersistFile(file);
      const job = a.enqueue("zomboid", "node_self_update", SELF_UPDATE_ARGS);
      expect(a.claimNext("zomboid")?.id).toBe(job.id);
      const b = new NodeJobService();
      b.attachPersistFile(file);
      expect(b.get(job.id)?.status).toBe("running");
      expect(b.claimNext("zomboid")).toBeNull();
      expect(b.get(job.id)?.status).toBe("running");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
