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

describe("dispatchNodeJob — process family", () => {
  it("fills start defaults before enqueue and infers the process info result", async () => {
    const pending = dispatchNodeJob({
      nodeId: "proc-1",
      kind: "process_start",
      args: {
        name: "server-abc",
        command: "/bin/bash",
        args: ["start.sh"],
        cwd: "servers/abc/game",
        serverId: "abc",
        logRel: "servers/abc/logs/console.log",
      },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("proc-1");
    expect(job?.args).toEqual({
      name: "server-abc",
      command: "/bin/bash",
      args: ["start.sh"],
      cwd: "servers/abc/game",
      env: {},
      serverId: "abc",
      logRel: "servers/abc/logs/console.log",
    });
    nodeJobService.complete(job!.id, {
      id: "native-server-abc-1",
      name: "server-abc",
      pid: 4242,
      status: "running",
    });
    const result = await pending;
    expect(result.id).toBe("native-server-abc-1");
    expect(result.status).toBe("running");
  });

  it("accepts a status result whose process has already exited", async () => {
    const pending = dispatchNodeJob({
      nodeId: "proc-2",
      kind: "process_status",
      args: { id: "native-server-abc-1" },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("proc-2");
    // No pid once the child is gone; the control plane reads this as "stopped".
    nodeJobService.complete(job!.id, {
      id: "native-server-abc-1",
      name: "server-abc",
      status: "stopped",
    });
    expect((await pending).status).toBe("stopped");
  });

  it("rejects a process result that breaks the contract", async () => {
    const pending = dispatchNodeJob({
      nodeId: "proc-3",
      kind: "process_status",
      args: { id: "native-server-abc-1" },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("proc-3");
    nodeJobService.complete(job!.id, { id: "native-server-abc-1", name: "server-abc" });
    await expect(pending).rejects.toMatchObject({
      code: "validation_failed",
      kind: "process_status",
    });
  });

  it("queues a stop whose tracked id was lost, but refuses a cwd escape", async () => {
    const pending = dispatchNodeJob({
      nodeId: "proc-4",
      kind: "process_stop",
      args: { id: "", name: "server-abc", cwd: "servers/abc/game", serverId: "abc" },
      timeoutMs: 2_000,
      localHandler: async () => ({ ok: true }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("proc-4");
    expect(job?.args).toEqual({
      id: "",
      name: "server-abc",
      cwd: "servers/abc/game",
      serverId: "abc",
    });
    nodeJobService.complete(job!.id, { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });

    await expect(
      dispatchNodeJob({
        nodeId: "proc-5",
        kind: "process_stop",
        args: { name: "server-abc", cwd: "servers/../../etc" },
        localHandler: async () => ({ ok: true }),
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "process_stop" });
    expect(nodeJobService.claimNext("proc-5")).toBeNull();
  });
});

describe("dispatchNodeJob — steamcmd family", () => {
  it("defaults the install dir and validate flag before enqueue", async () => {
    const pending = dispatchNodeJob({
      nodeId: "steam-1",
      kind: "steamcmd_app_update",
      args: { serverRel: "servers/abc", appId: 258_550 },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("steam-1");
    expect(job?.args).toEqual({
      serverRel: "servers/abc",
      appId: 258_550,
      installDirRel: "game",
      validate: true,
    });
    nodeJobService.complete(job!.id, {
      ok: true,
      binary: "/root/steamcmd/steamcmd.sh",
      exitCode: 0,
      stdout: "Success! App '258550' fully installed.",
      stderr: "",
      installDir: "/var/lib/playon-node/servers/abc/game",
      appId: 258_550,
      provisioned: false,
    });
    const result = await pending;
    expect(result.appId).toBe(258_550);
    expect(result.installDir).toBe("/var/lib/playon-node/servers/abc/game");
  });

  it("refuses an appId or install dir the node could not act on", async () => {
    await expect(
      dispatchNodeJob({
        nodeId: "steam-2",
        kind: "steamcmd_app_update",
        args: { serverRel: "servers/abc", appId: 1.5 },
        localHandler: () => {
          throw new Error("remote_only");
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "steamcmd_app_update" });
    await expect(
      dispatchNodeJob({
        nodeId: "steam-2",
        kind: "steamcmd_app_update",
        args: { serverRel: "servers/abc", appId: 258_550, installDirRel: "../../opt" },
        localHandler: () => {
          throw new Error("remote_only");
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "steamcmd_app_update" });
    expect(nodeJobService.claimNext("steam-2")).toBeNull();
  });
});

describe("dispatchNodeJob — manage family", () => {
  it("infers the probe result and fills the scan defaults before enqueue", async () => {
    const pending = dispatchNodeJob({
      nodeId: "manage-1",
      kind: "manage_probe",
      args: { roots: ["/srv/games"], hints: [{ id: "pz", anyFiles: ["StartServer64.sh"] }] },
      timeoutMs: 2_000,
      localHandler: () => {
        throw new Error("remote_only");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const job = nodeJobService.claimNext("manage-1");
    expect(job?.args).toEqual({
      roots: ["/srv/games"],
      hints: [{ id: "pz", anyFiles: ["StartServer64.sh"] }],
      maxDepth: 2,
      maxCandidates: 40,
    });
    nodeJobService.complete(job!.id, {
      candidates: [{ path: "/srv/games/pz", hintIds: ["pz"], suggestedGame: "Project Zomboid" }],
      scannedRoots: ["/srv/games"],
    });
    const probe = await pending;
    expect(probe.candidates[0]?.path).toBe("/srv/games/pz");
    expect(probe.scannedRoots).toEqual(["/srv/games"]);
  });

  it("carries seed and cutover through the queue with their contracts", async () => {
    const seeding = dispatchNodeJob({
      nodeId: "manage-2",
      kind: "manage_seed",
      args: { sourcePath: "/opt/pzserver", allowRoots: ["/opt"], destRel: "servers/abc/game" },
      timeoutMs: 2_000,
      localHandler: async () => {
        throw new Error("manage_seed_local_unreachable");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const seedJob = nodeJobService.claimNext("manage-2");
    nodeJobService.complete(seedJob!.id, {
      destRel: "servers/abc/game",
      sourcePath: "/opt/pzserver",
      bytesCopied: 4096,
    });
    expect((await seeding).bytesCopied).toBe(4096);

    const cutting = dispatchNodeJob({
      nodeId: "manage-2",
      kind: "manage_cutover",
      args: {
        sourcePath: "/opt/pzserver",
        allowRoots: ["/opt"],
        homeRel: "servers/abc/home",
        manage: { userdataHomeDirs: ["Zomboid"], serverNameArg: "servername" },
      },
      timeoutMs: 2_000,
      localHandler: async () => {
        throw new Error("manage_cutover_local_unreachable");
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const cutJob = nodeJobService.claimNext("manage-2");
    // Hint defaults are applied on this shore, so the node never has to guess.
    expect(cutJob?.args.manage).toEqual({
      userdataHomeDirs: ["Zomboid"],
      serverNameArg: "servername",
      adminPasswordArg: false,
      worldSubdirs: ["Server", "db", "Saves/Multiplayer"],
    });
    nodeJobService.complete(cutJob!.id, {
      serverName: "WorldA",
      unitName: "zomboid.service",
      playonHome: "/var/lib/playon-node/servers/abc/home",
      playonHomeRel: "servers/abc/home",
      userdataBytes: 512,
    });
    const cutover = await cutting;
    expect(cutover.serverName).toBe("WorldA");
    expect(cutover.warnings).toEqual([]);
  });

  it("refuses a manage job that would write outside the adopted server", async () => {
    await expect(
      dispatchNodeJob({
        nodeId: "manage-3",
        kind: "manage_seed",
        args: { sourcePath: "/opt/pzserver", allowRoots: ["/opt"], destRel: "../../opt/pzserver" },
        localHandler: async () => {
          throw new Error("manage_seed_local_unreachable");
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "manage_seed" });
    await expect(
      dispatchNodeJob({
        nodeId: "manage-3",
        kind: "manage_pack_read",
        args: { packRel: "servers/abc/game/secrets.tar", offset: 0 },
        localHandler: async () => {
          throw new Error("manage_pack_read_local_unreachable");
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "manage_pack_read" });
    expect(nodeJobService.claimNext("manage-3")).toBeNull();
  });
});

describe("nodeServerRelPath", () => {
  it("builds jail-relative server paths", () => {
    expect(nodeServerRelPath("abc", "game")).toBe("servers/abc/game");
  });
});
