import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeJobKindSchema, type NodeJobKind } from "@playon/shared";
import { executeJob, shouldTryDockerAdapter, SUPPORTED_JOB_KINDS } from "./jobs.js";
import { portPublishRegistry } from "./port-publish.js";

describe("shouldTryDockerAdapter", () => {
  it("tries Docker on Windows even when PLAYON_RUNTIME=native", () => {
    expect(shouldTryDockerAdapter({ PLAYON_RUNTIME: "native" }, "win32")).toBe(true);
    expect(shouldTryDockerAdapter({ PLAYON_RUNTIME: "docker" }, "win32")).toBe(true);
  });

  it("respects PLAYON_RUNTIME=native on Linux SteamCMD-only hosts", () => {
    expect(shouldTryDockerAdapter({ PLAYON_RUNTIME: "native" }, "linux")).toBe(false);
    expect(shouldTryDockerAdapter({ PLAYON_RUNTIME: "docker" }, "linux")).toBe(true);
    expect(shouldTryDockerAdapter({}, "linux")).toBe(true);
  });
});

describe("SUPPORTED_JOB_KINDS", () => {
  it("advertises every protocol kind exactly once", () => {
    expect([...SUPPORTED_JOB_KINDS].sort()).toEqual([...NodeJobKindSchema.options].sort());
    expect(new Set(SUPPORTED_JOB_KINDS).size).toBe(SUPPORTED_JOB_KINDS.length);
  });
});

afterEach(() => {
  portPublishRegistry.releaseAll();
});

describe("executeJob", () => {
  it("pings with node metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    const result = (await executeJob(
      { id: "j1", nodeId: "n1", kind: "ping", args: {} },
      root,
    )) as { pong: boolean; nodeId: string; dataRoot: string; at: string };
    expect(result.pong).toBe(true);
    expect(result.nodeId).toBe("n1");
    expect(result.dataRoot).toBe(root);
    expect(Number.isNaN(Date.parse(result.at))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects malformed meta args with a typed validation error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    try {
      await expect(
        executeJob({ id: "j1a", nodeId: "n1", kind: "ping", args: { path: "/etc" } }, root),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "ping" });
      await expect(
        executeJob(
          {
            id: "j1b",
            nodeId: "n1",
            kind: "node_self_update",
            args: { downloadUrl: "not-a-url", sha256: "short", version: "" },
          },
          root,
        ),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "node_self_update" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a typed unsupported error for kinds it cannot run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    try {
      await expect(
        executeJob(
          { id: "j1c", nodeId: "n1", kind: "future_kind" as NodeJobKind, args: {} },
          root,
        ),
      ).rejects.toMatchObject({ code: "unsupported_job_kind", kind: "future_kind" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists jailed directories and rejects escape", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    fs.mkdirSync(path.join(root, "servers"), { recursive: true });
    fs.writeFileSync(path.join(root, "servers", "a.txt"), "x");
    const listed = (await executeJob(
      { id: "j2", nodeId: "n1", kind: "fs_list", args: { path: "servers" } },
      root,
    )) as { entries: Array<{ name: string }> };
    expect(listed.entries.some((e) => e.name === "a.txt")).toBe(true);
    await expect(
      executeJob(
        { id: "j3", nodeId: "n1", kind: "fs_list", args: { path: "../.." } },
        root,
      ),
    ).rejects.toMatchObject({ code: "validation_failed", kind: "fs_list" });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips the fs family against the contract", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-fs-"));
    const run = (kind: NodeJobKind, args: Record<string, unknown>) =>
      executeJob({ id: `fs-${kind}`, nodeId: "n1", kind, args }, root);
    try {
      expect(await run("fs_ensure_dir", { path: "servers/s1/game" })).toEqual({
        path: "servers/s1/game",
        ok: true,
      });

      expect(await run("fs_write_text", { path: "servers/s1/game/a.ini", content: "k=v" })).toEqual(
        { path: "servers/s1/game/a.ini", bytes: 3 },
      );
      // Absent content defaults to an empty file rather than failing on a missing arg.
      expect(await run("fs_write_text", { path: "servers/s1/game/empty.ini" })).toEqual({
        path: "servers/s1/game/empty.ini",
        bytes: 0,
      });

      expect(await run("fs_read_text", { path: "servers/s1/game/a.ini" })).toEqual({
        path: "servers/s1/game/a.ini",
        content: "k=v",
        bytesRead: 3,
        truncated: false,
        size: 3,
      });
      expect(
        await run("fs_read_text", { path: "servers/s1/game/a.ini", offset: 1, maxBytes: 1 }),
      ).toMatchObject({ content: "=", bytesRead: 1, truncated: true, size: 3 });
      // An oversized ask is clamped by the agent, not refused.
      expect(
        await run("fs_read_text", { path: "servers/s1/game/a.ini", maxBytes: 10_000_000 }),
      ).toMatchObject({ content: "k=v", truncated: false });

      expect(
        await run("fs_copy", { from: "servers/s1/game/a.ini", to: "servers/s1/game/b.ini" }),
      ).toEqual({ from: "servers/s1/game/a.ini", to: "servers/s1/game/b.ini" });
      await expect(
        run("fs_copy", { from: "servers/s1/game/a.ini", to: "servers/s1/game/b.ini" }),
      ).rejects.toThrow(/already_exists/);

      expect(
        await run("fs_rename", { from: "servers/s1/game/b.ini", to: "servers/s1/game/c.ini" }),
      ).toEqual({ from: "servers/s1/game/b.ini", to: "servers/s1/game/c.ini" });

      const archived = (await run("fs_get_archive", { path: "servers/s1/game" })) as {
        archiveBase64: string;
      };
      expect(archived.archiveBase64.length).toBeGreaterThan(0);

      expect(await run("fs_remove", { path: "servers/s1/game/c.ini" })).toEqual({
        path: "servers/s1/game/c.ini",
        ok: true,
      });
      expect(fs.existsSync(path.join(root, "servers", "s1", "game", "c.ini"))).toBe(false);

      expect(
        await run("fs_put_archive", {
          path: "servers/s2",
          archiveBase64: archived.archiveBase64,
          format: "tar",
        }),
      ).toEqual({ path: "servers/s2", ok: true });
      expect(fs.readFileSync(path.join(root, "servers", "s2", "a.ini"), "utf8")).toBe("k=v");

      expect(await run("fs_get_archive", { path: "servers/missing" })).toEqual({
        archiveBase64: "",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed fs args with a typed validation error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-fs-bad-"));
    try {
      await expect(
        executeJob({ id: "b1", nodeId: "n1", kind: "fs_read_text", args: {} }, root),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "fs_read_text" });
      await expect(
        executeJob(
          { id: "b2", nodeId: "n1", kind: "fs_rename", args: { from: "a", to: "/etc/passwd" } },
          root,
        ),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "fs_rename" });
      await expect(
        executeJob(
          { id: "b3", nodeId: "n1", kind: "fs_list", args: { path: ".", depth: 2 } },
          root,
        ),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "fs_list" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Docker may or may not exist on the machine running this suite, so assert the
   * shape of the contract rather than the outcome: args are validated before the
   * runtime is consulted, and well-formed args always get past that gate.
   */
  it("validates container args before touching the runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-ctr-"));
    const run = (kind: NodeJobKind, args: Record<string, unknown>) =>
      executeJob({ id: `ctr-${kind}`, nodeId: "n1", kind, args }, root);
    try {
      await expect(run("container_inspect", {})).rejects.toMatchObject({
        code: "validation_failed",
        kind: "container_inspect",
      });
      await expect(run("container_stdin", { id: "playon-a" })).rejects.toMatchObject({
        code: "validation_failed",
        kind: "container_stdin",
      });
      await expect(run("container_logs", { id: "playon-a", follow: true })).rejects.toMatchObject({
        code: "validation_failed",
        kind: "container_logs",
      });
      await expect(
        run("container_create", {
          name: "playon-a",
          image: "busybox",
          binds: [{ hostPath: "../../etc", containerPath: "/data" }],
        }),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "container_create" });

      // Whether this then fails on `docker_unavailable` or "no such container" is
      // a host concern; what matters is that it is no longer a contract failure.
      await expect(
        run("container_inspect", { id: "playon-no-such-container-ctr-test" }),
      ).rejects.not.toMatchObject({ code: "validation_failed" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A real spawn needs a game tree, so assert the contract gate rather than the
   * outcome: bad args fail before the supervisor is consulted, and a well-formed
   * stop of an already-gone process is still an `ok` acknowledgement.
   */
  it("validates process args before touching the supervisor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-proc-"));
    const run = (kind: NodeJobKind, args: Record<string, unknown>) =>
      executeJob({ id: `proc-${kind}`, nodeId: "n1", kind, args }, root);
    try {
      await expect(run("process_start", { name: "server-a" })).rejects.toMatchObject({
        code: "validation_failed",
        kind: "process_start",
      });
      await expect(
        run("process_start", { name: "server-a", command: "/bin/true", cwd: "../../etc" }),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "process_start" });
      await expect(run("process_status", {})).rejects.toMatchObject({
        code: "validation_failed",
        kind: "process_status",
      });
      await expect(run("process_stop", { id: "x", signal: "SIGKILL" })).rejects.toMatchObject({
        code: "validation_failed",
        kind: "process_stop",
      });

      // Nothing is tracked, so this only exercises reclaim — it must still ack.
      fs.mkdirSync(path.join(root, "servers", "s1", "game"), { recursive: true });
      expect(await run("process_stop", { name: "server-s1", cwd: "servers/s1/game" })).toEqual({
        ok: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    // Orphan reclaim deliberately waits between SIGTERM and SIGKILL.
  }, 30_000);

  it("starts a native process and reports it back through the contract", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-proc-run-"));
    const gameRel = "servers/s1/game";
    fs.mkdirSync(path.join(root, "servers", "s1", "game"), { recursive: true });
    try {
      const started = (await executeJob(
        {
          id: "proc-start",
          nodeId: "n1",
          kind: "process_start",
          args: {
            name: "server-s1",
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 60_000)"],
            cwd: gameRel,
            logRel: "servers/s1/logs/console.log",
          },
        },
        root,
      )) as { id: string; name: string; pid?: number; status: string };
      expect(started.name).toBe("server-s1");
      expect(started.status).toBe("running");
      expect(started.pid).toBeGreaterThan(0);

      expect(
        await executeJob(
          { id: "proc-status", nodeId: "n1", kind: "process_status", args: { id: started.id } },
          root,
        ),
      ).toMatchObject({ id: started.id, status: "running" });

      // A caller that kept no id gets the same answer from name + cwd alone.
      expect(
        await executeJob(
          {
            id: "proc-status-by-identity",
            nodeId: "n1",
            kind: "process_status",
            args: { name: "server-s1", cwd: gameRel },
          },
          root,
        ),
      ).toMatchObject({ name: "server-s1", status: "running" });

      expect(
        await executeJob(
          {
            id: "proc-stop",
            nodeId: "n1",
            kind: "process_stop",
            args: { id: started.id, name: "server-s1", cwd: gameRel },
          },
          root,
        ),
      ).toEqual({ ok: true });

      expect(
        await executeJob(
          { id: "proc-status-2", nodeId: "n1", kind: "process_status", args: { id: started.id } },
          root,
        ),
      ).toMatchObject({ id: started.id, status: "stopped" });

      // An identity with nothing behind it is answered, not refused.
      expect(
        await executeJob(
          {
            id: "proc-status-gone",
            nodeId: "n1",
            kind: "process_status",
            args: { name: "server-s1", cwd: gameRel },
          },
          root,
        ),
      ).toMatchObject({ name: "server-s1", status: "stopped" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  /** SteamCMD may be absent here, so only the contract gate is asserted. */
  it("validates steamcmd args before shelling out", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-steam-"));
    const run = (args: Record<string, unknown>) =>
      executeJob({ id: "steam-1", nodeId: "n1", kind: "steamcmd_app_update", args }, root);
    try {
      await expect(run({ serverRel: "servers/s1" })).rejects.toMatchObject({
        code: "validation_failed",
        kind: "steamcmd_app_update",
      });
      await expect(run({ serverRel: "servers/s1", appId: "258550" })).rejects.toMatchObject({
        code: "validation_failed",
        kind: "steamcmd_app_update",
      });
      await expect(
        run({ serverRel: "servers/s1", appId: 258_550, installDirRel: "../../opt" }),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "steamcmd_app_update" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports runtime caps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    const caps = (await executeJob(
      { id: "j4", nodeId: "n1", kind: "runtime_caps", args: {} },
      root,
    )) as { native: boolean; docker: boolean; steamcmd: boolean; jobKinds: NodeJobKind[] };
    expect(caps.native).toBe(true);
    expect(typeof caps.docker).toBe("boolean");
    expect(typeof caps.steamcmd).toBe("boolean");
    expect(caps.jobKinds).toEqual([...SUPPORTED_JOB_KINDS]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports a bound UDP port via net_udp_listen", async () => {
    const dgram = await import("node:dgram");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-udp-"));
    const socket = dgram.createSocket("udp4");
    try {
      const port = await new Promise<number>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, "127.0.0.1", () => {
          const addr = socket.address();
          resolve(typeof addr === "string" ? 0 : addr.port);
        });
      });
      const bound = (await executeJob(
        { id: "udp-1", nodeId: "n1", kind: "net_udp_listen", args: { port } },
        root,
      )) as { port: number; listening: boolean; probe: string };
      expect(bound.port).toBe(port);
      expect(bound.listening).toBe(true);
      expect(bound.probe).toMatch(/^(ss|netstat)$/);

      await expect(
        executeJob(
          { id: "udp-bad", nodeId: "n1", kind: "net_udp_listen", args: { port: 0 } },
          root,
        ),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "net_udp_listen" });
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a bound TCP port via net_tcp_connect and rejects non-loopback hosts", async () => {
    const net = await import("node:net");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-tcp-"));
    const server = net.createServer();
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          resolve(!addr || typeof addr === "string" ? 0 : addr.port);
        });
      });
      const bound = (await executeJob(
        { id: "tcp-1", nodeId: "n1", kind: "net_tcp_connect", args: { port } },
        root,
      )) as { host: string; port: number; state: string };
      expect(bound.host).toBe("127.0.0.1");
      expect(bound.port).toBe(port);
      expect(bound.state).toBe("open");

      const closed = (await executeJob(
        { id: "tcp-2", nodeId: "n1", kind: "net_tcp_connect", args: { host: "127.0.0.1", port: 1 } },
        root,
      )) as { state: string };
      expect(closed.state).toBe("closed");

      await expect(
        executeJob(
          {
            id: "tcp-lan",
            nodeId: "n1",
            kind: "net_tcp_connect",
            args: { host: "172.16.0.94", port },
          },
          root,
        ),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "net_tcp_connect" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes a TCP port onto a listen host and releases it", async () => {
    const net = await import("node:net");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-pub-"));
    const backend = net.createServer((socket) => {
      socket.on("data", (buf) => socket.write(buf));
    });
    try {
      const backendPort = await new Promise<number>((resolve, reject) => {
        backend.once("error", reject);
        backend.listen(0, "127.0.0.1", () => {
          const addr = backend.address();
          resolve(!addr || typeof addr === "string" ? 0 : addr.port);
        });
      });
      const ensured = (await executeJob(
        {
          id: "pub-1",
          nodeId: "n1",
          kind: "net_port_publish",
          args: {
            action: "ensure",
            serverId: "srv-wsl",
            listenHost: "127.0.0.1",
            listenPort: 39231,
            protocol: "tcp",
            targetHost: "127.0.0.1",
            targetPort: backendPort,
          },
        },
        root,
      )) as { ok: boolean; listening: boolean; listenPort: number };
      expect(ensured.ok).toBe(true);
      expect(ensured.listening).toBe(true);

      const echoed = await new Promise<string>((resolve, reject) => {
        const client = net.connect({ host: "127.0.0.1", port: 39231 });
        client.once("error", reject);
        client.write("lan");
        client.once("data", (buf) => {
          client.end();
          resolve(buf.toString());
        });
      });
      expect(echoed).toBe("lan");

      const released = (await executeJob(
        {
          id: "pub-2",
          nodeId: "n1",
          kind: "net_port_publish",
          args: { action: "release_server", serverId: "srv-wsl" },
        },
        root,
      )) as { ok: boolean; listening: boolean };
      expect(released.ok).toBe(true);
      expect(released.listening).toBe(false);
    } finally {
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("manage_probe finds allowlisted trees and manage_pack rejects escapes", async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    const scan = fs.mkdtempSync(path.join(os.tmpdir(), "playon-scan-"));
    const server = path.join(scan, "game");
    fs.mkdirSync(server);
    fs.writeFileSync(path.join(server, "StartServer64.sh"), "#!/bin/sh\n");
    try {
      const probe = (await executeJob(
        {
          id: "j5",
          nodeId: "n1",
          kind: "manage_probe",
          args: {
            roots: [scan],
            hints: [
              {
                id: "project_zomboid_layout",
                anyFiles: ["StartServer64.sh"],
                suggestedGame: "Project Zomboid",
              },
            ],
            maxDepth: 2,
            maxCandidates: 10,
          },
        },
        dataRoot,
      )) as { candidates: Array<{ path: string }> };
      expect(probe.candidates.some((c) => c.path === path.resolve(server))).toBe(true);

      await expect(
        executeJob(
          {
            id: "j6",
            nodeId: "n1",
            kind: "manage_pack",
            args: { path: dataRoot, allowRoots: [scan], maxBytes: 1024 * 1024 },
          },
          dataRoot,
        ),
      ).rejects.toThrow(/path_not_allowlisted/);

      const packed = (await executeJob(
        {
          id: "j7",
          nodeId: "n1",
          kind: "manage_pack",
          args: { path: server, allowRoots: [scan], maxBytes: 1024 * 1024 },
        },
        dataRoot,
      )) as { packRel: string; bytes: number };
      expect(packed.bytes).toBeGreaterThan(0);
      expect(packed.packRel.startsWith("tmp/manage-packs/")).toBe(true);
      const absPack = path.join(dataRoot, ...packed.packRel.split("/"));
      expect(fs.existsSync(absPack)).toBe(true);

      const chunk = (await executeJob(
        {
          id: "j8",
          nodeId: "n1",
          kind: "manage_pack_read",
          args: { packRel: packed.packRel, offset: 0, length: 1024 },
        },
        dataRoot,
      )) as { bytes: number; done: boolean; dataBase64: string };
      expect(chunk.bytes).toBeGreaterThan(0);
      expect(chunk.dataBase64.length).toBeGreaterThan(0);

      const seeded = (await executeJob(
        {
          id: "j9",
          nodeId: "n1",
          kind: "manage_seed",
          args: {
            sourcePath: server,
            allowRoots: [scan],
            destRel: "servers/abc/game",
          },
        },
        dataRoot,
      )) as { bytesCopied: number; destRel: string };
      expect(seeded.destRel).toBe("servers/abc/game");
      expect(seeded.bytesCopied).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(dataRoot, "servers", "abc", "game", "StartServer64.sh"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(scan, { recursive: true, force: true });
    }
  });

  it("rejects malformed manage args before touching the host filesystem", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-manage-bad-"));
    const run = (kind: NodeJobKind, args: Record<string, unknown>) =>
      executeJob({ id: `manage-${kind}`, nodeId: "n1", kind, args }, root);
    try {
      await expect(run("manage_probe", { roots: [] })).rejects.toMatchObject({
        code: "validation_failed",
        kind: "manage_probe",
      });
      await expect(run("manage_pack", { path: "/srv/games/pz" })).rejects.toMatchObject({
        code: "validation_failed",
        kind: "manage_pack",
      });
      // The seed destination is pinned to the adopted server's own game dir.
      await expect(
        run("manage_seed", {
          sourcePath: "/opt/pzserver",
          allowRoots: ["/opt"],
          destRel: "servers/abc/home",
        }),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "manage_seed" });
      await expect(
        run("manage_pack_read", { packRel: "servers/abc/game/secrets.tar", offset: 0 }),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "manage_pack_read" });
      await expect(
        run("manage_cutover", {
          sourcePath: "/opt/pzserver",
          allowRoots: ["/opt"],
          homeRel: "/etc",
          manage: {},
        }),
      ).rejects.toMatchObject({ code: "validation_failed", kind: "manage_cutover" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
