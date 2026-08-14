import { describe, expect, it } from "vitest";
import { NodeJobKindSchema } from "../api.js";
import { NodeJobError } from "./errors.js";
import {
  ALL_NODE_JOB_KINDS,
  NODE_JOB_CONTRACTS,
  isNodeJobKind,
  nodeJobContract,
  parseNodeJobArgs,
  parseNodeJobResult,
} from "./registry.js";

/** A kind only a future build knows — what protocol skew looks like on the wire. */
const UNKNOWN_KIND = "future_kind" as never;

describe("node job registry", () => {
  it("contracts every kind in the protocol, and nothing else", () => {
    expect(Object.keys(NODE_JOB_CONTRACTS).sort()).toEqual([...ALL_NODE_JOB_KINDS].sort());
  });

  it("covers every kind the node agent can run", () => {
    for (const kind of ALL_NODE_JOB_KINDS) {
      expect(nodeJobContract(kind)?.kind).toBe(kind);
    }
  });

  it("gives every registered kind a keyed, complete contract", () => {
    for (const [key, contract] of Object.entries(NODE_JOB_CONTRACTS)) {
      expect(contract.kind).toBe(key);
      expect(typeof contract.argsSchema.safeParse).toBe("function");
      expect(typeof contract.resultSchema.safeParse).toBe("function");
    }
  });

  it("only registers kinds the protocol enum knows", () => {
    for (const kind of Object.keys(NODE_JOB_CONTRACTS)) {
      expect(NodeJobKindSchema.options).toContain(kind);
    }
    expect(ALL_NODE_JOB_KINDS).toEqual(NodeJobKindSchema.options);
  });

  it("treats a kind from another build as unsupported, not as free passage", () => {
    expect(isNodeJobKind("ping")).toBe(true);
    expect(isNodeJobKind(UNKNOWN_KIND)).toBe(false);
    expect(nodeJobContract(UNKNOWN_KIND)).toBeUndefined();
    for (const parse of [parseNodeJobArgs, parseNodeJobResult]) {
      try {
        parse(UNKNOWN_KIND, { anything: true });
        expect.unreachable("expected an unknown kind to be refused");
      } catch (err) {
        expect((err as NodeJobError).code).toBe("unsupported_job_kind");
      }
    }
  });
});

describe("parseNodeJobArgs", () => {
  it("round-trips meta args", () => {
    expect(parseNodeJobArgs("ping", {})).toEqual({});
    expect(parseNodeJobArgs("runtime_caps")).toEqual({});
    expect(
      parseNodeJobArgs("wsl_ensure", {
        action: "enable",
        wslNodeId: "win-1-wsl",
        apiUrl: "http://172.16.0.156:8787",
        nodeToken: "tok",
        scriptBase64: "YWJj",
      }),
    ).toEqual({
      action: "enable",
      wslNodeId: "win-1-wsl",
      apiUrl: "http://172.16.0.156:8787",
      nodeToken: "tok",
      scriptBase64: "YWJj",
    });
    expect(
      parseNodeJobArgs("node_self_update", {
        downloadUrl: "https://example.com/playon-node-0.1.11-linux-x64.tar.gz",
        sha256: "a".repeat(64),
        version: "0.1.11",
        preserve: ["data", "node.env"],
      }),
    ).toEqual({
      downloadUrl: "https://example.com/playon-node-0.1.11-linux-x64.tar.gz",
      sha256: "a".repeat(64),
      version: "0.1.11",
      preserve: ["data", "node.env"],
    });
  });

  it("fails with a typed validation error", () => {
    try {
      parseNodeJobArgs("node_self_update", { downloadUrl: "not-a-url", sha256: "short" });
      expect.unreachable("expected validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(NodeJobError);
      const typed = err as NodeJobError;
      expect(typed.code).toBe("validation_failed");
      expect(typed.kind).toBe("node_self_update");
      expect(typed.message).toContain("validation_failed");
    }
  });

  it("rejects unknown args on contracted kinds", () => {
    expect(() => parseNodeJobArgs("ping", { path: "/etc" })).toThrow(/validation_failed/);
  });

  it("validates net_udp_listen args", () => {
    expect(parseNodeJobArgs("net_udp_listen", { port: 27015 })).toEqual({ port: 27015 });
    expect(() => parseNodeJobArgs("net_udp_listen", { port: 0 })).toThrow(/validation_failed/);
    expect(() => parseNodeJobArgs("net_udp_listen", { port: 27015, extra: true })).toThrow(
      /validation_failed/,
    );
  });

  it("validates net_tcp_connect args (loopback only)", () => {
    expect(parseNodeJobArgs("net_tcp_connect", { port: 25565 })).toEqual({
      host: "127.0.0.1",
      port: 25565,
    });
    expect(parseNodeJobArgs("net_tcp_connect", { host: "localhost", port: 25565 })).toEqual({
      host: "localhost",
      port: 25565,
    });
    expect(() =>
      parseNodeJobArgs("net_tcp_connect", { host: "172.16.0.94", port: 25565 }),
    ).toThrow(/validation_failed/);
    expect(() => parseNodeJobArgs("net_tcp_connect", { port: 0 })).toThrow(/validation_failed/);
  });

  it("applies fs defaults so both shores see the same args", () => {
    expect(parseNodeJobArgs("fs_list", {})).toEqual({ path: "." });
    expect(parseNodeJobArgs("fs_read_text", { path: "servers/a/log.txt" })).toEqual({
      path: "servers/a/log.txt",
      offset: 0,
    });
    expect(parseNodeJobArgs("fs_write_text", { path: "servers/a/x.ini" })).toEqual({
      path: "servers/a/x.ini",
      content: "",
    });
    expect(parseNodeJobArgs("fs_copy", { from: "servers/a", to: "servers/b" })).toEqual({
      from: "servers/a",
      to: "servers/b",
      overwrite: false,
    });
    expect(parseNodeJobArgs("fs_get_archive", { path: "servers/a" })).toEqual({
      path: "servers/a",
      format: "tar",
    });
  });

  it("refuses paths that could only be a jail escape", () => {
    for (const bad of ["../etc", "servers/../../etc", "/etc/passwd", "C:\\Windows", ""]) {
      expect(() => parseNodeJobArgs("fs_read_text", { path: bad })).toThrow(/validation_failed/);
    }
    expect(() => parseNodeJobArgs("fs_rename", { from: "servers/a", to: "../b" })).toThrow(
      /validation_failed/,
    );
  });

  it("applies container defaults so both shores see the same args", () => {
    expect(parseNodeJobArgs("container_create", { name: "playon-a", image: "itzg/mc" })).toEqual({
      name: "playon-a",
      image: "itzg/mc",
      env: {},
      cmd: [],
      ports: [],
      binds: [],
    });
    expect(
      parseNodeJobArgs("container_create", {
        name: "playon-sbox",
        image: "har0x/sbox-server:latest",
        tty: true,
        isolation: "process",
      }),
    ).toMatchObject({
      name: "playon-sbox",
      image: "har0x/sbox-server:latest",
      tty: true,
      isolation: "process",
    });
    expect(parseNodeJobArgs("container_logs", { id: "playon-a" })).toEqual({
      id: "playon-a",
      tail: 100,
    });
  });

  it("accepts the container args the control plane already sends", () => {
    expect(
      parseNodeJobArgs("container_create", {
        name: "playon-a",
        image: "itzg/minecraft-server:latest",
        env: { ENABLE_RCON: "true", RCON_PORT: "25575" },
        cmd: ["host"],
        ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
        binds: [{ hostPath: "servers/a/game", containerPath: "/data" }],
      }),
    ).toEqual({
      name: "playon-a",
      image: "itzg/minecraft-server:latest",
      env: { ENABLE_RCON: "true", RCON_PORT: "25575" },
      cmd: ["host"],
      ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
      binds: [{ hostPath: "servers/a/game", containerPath: "/data" }],
    });
    expect(parseNodeJobArgs("container_start", { id: "playon-a", serverId: "a" })).toEqual({
      id: "playon-a",
      serverId: "a",
    });
    expect(parseNodeJobArgs("container_stop", { id: "playon-a", serverId: "a" })).toEqual({
      id: "playon-a",
      serverId: "a",
    });
    expect(parseNodeJobArgs("container_stdin", { id: "playon-a", line: "say hi" })).toEqual({
      id: "playon-a",
      line: "say hi",
    });
  });

  it("keeps an absolute bind host path but refuses a relative escape", () => {
    expect(
      parseNodeJobArgs("container_create", {
        name: "playon-a",
        image: "itzg/mc",
        binds: [{ hostPath: "/srv/playon/a", containerPath: "/data" }],
      }).binds,
    ).toEqual([{ hostPath: "/srv/playon/a", containerPath: "/data" }]);

    expect(() =>
      parseNodeJobArgs("container_create", {
        name: "playon-a",
        image: "itzg/mc",
        binds: [{ hostPath: "servers/../../etc", containerPath: "/data" }],
      }),
    ).toThrow(/validation_failed/);
  });

  it("rejects container args that could only be a mistake", () => {
    expect(() => parseNodeJobArgs("container_inspect", {})).toThrow(/validation_failed/);
    expect(() => parseNodeJobArgs("container_stdin", { id: "a", line: "" })).toThrow(
      /validation_failed/,
    );
    expect(() => parseNodeJobArgs("container_start", { id: "a", tail: 5 })).toThrow(
      /validation_failed/,
    );
    expect(() =>
      parseNodeJobArgs("container_create", {
        name: "a",
        image: "b",
        ports: [{ host: 0, container: 25565 }],
      }),
    ).toThrow(/validation_failed/);
  });

  it("applies process defaults so both shores see the same args", () => {
    expect(parseNodeJobArgs("process_start", { name: "server-a", command: "/bin/bash" })).toEqual({
      name: "server-a",
      command: "/bin/bash",
      args: [],
      cwd: ".",
      env: {},
    });
    // A lost id is the normal post-restart case, so stop tolerates it.
    expect(parseNodeJobArgs("process_stop", { cwd: "servers/a/game" })).toEqual({
      id: "",
      name: "",
      cwd: "servers/a/game",
    });
  });

  it("accepts the process args the control plane already sends", () => {
    expect(
      parseNodeJobArgs("process_start", {
        name: "server-a",
        command: "/bin/bash",
        args: ["start.sh"],
        cwd: "servers/a/game",
        env: { PLAYON_SERVER_ID: "a" },
        serverId: "a",
        logRel: "servers/a/logs/console.log",
      }),
    ).toEqual({
      name: "server-a",
      command: "/bin/bash",
      args: ["start.sh"],
      cwd: "servers/a/game",
      env: { PLAYON_SERVER_ID: "a" },
      serverId: "a",
      logRel: "servers/a/logs/console.log",
    });
    expect(
      parseNodeJobArgs("process_stop", {
        id: "native-server-a-1",
        name: "server-a",
        cwd: "servers/a/game",
        serverId: "a",
      }).id,
    ).toBe("native-server-a-1");
    expect(parseNodeJobArgs("process_status", { id: "native-server-a-1" })).toEqual({
      id: "native-server-a-1",
    });
    // No id survives a restart on either shore, so identity is a first-class ask.
    expect(parseNodeJobArgs("process_status", { name: "server-a", cwd: "servers/a/game" })).toEqual({
      name: "server-a",
      cwd: "servers/a/game",
    });
  });

  it("rejects process args that could only be a mistake", () => {
    expect(() => parseNodeJobArgs("process_start", { name: "server-a" })).toThrow(
      /validation_failed/,
    );
    expect(() => parseNodeJobArgs("process_status", { id: "" })).toThrow(/validation_failed/);
    // An ask with neither an id nor a full identity has nothing to resolve.
    expect(() => parseNodeJobArgs("process_status", {})).toThrow(/validation_failed/);
    expect(() => parseNodeJobArgs("process_status", { name: "server-a" })).toThrow(
      /validation_failed/,
    );
    expect(() => parseNodeJobArgs("process_status", { cwd: "servers/a/game" })).toThrow(
      /validation_failed/,
    );
    expect(() =>
      parseNodeJobArgs("process_start", {
        name: "server-a",
        command: "/bin/bash",
        cwd: "../../etc",
      }),
    ).toThrow(/validation_failed/);
    expect(() =>
      parseNodeJobArgs("process_start", {
        name: "server-a",
        command: "/bin/bash",
        logRel: "/var/log/syslog",
      }),
    ).toThrow(/validation_failed/);
    expect(() => parseNodeJobArgs("process_stop", { cwd: "servers/a/game", force: true })).toThrow(
      /validation_failed/,
    );
  });

  it("applies steamcmd defaults and refuses an install dir outside the server", () => {
    expect(
      parseNodeJobArgs("steamcmd_app_update", { serverRel: "servers/a", appId: 258_550 }),
    ).toEqual({ serverRel: "servers/a", appId: 258_550, installDirRel: "game", validate: true });
    expect(
      parseNodeJobArgs("steamcmd_app_update", {
        serverRel: "servers/a",
        appId: 258_550,
        installDirRel: "game/serverfiles",
        validate: false,
      }).validate,
    ).toBe(false);
    for (const bad of [{ appId: 0 }, { appId: 1.5 }, { installDirRel: "../../opt" }]) {
      expect(() =>
        parseNodeJobArgs("steamcmd_app_update", {
          serverRel: "servers/a",
          appId: 258_550,
          ...bad,
        }),
      ).toThrow(/validation_failed/);
    }
  });

  it("applies manage defaults so both shores see the same args", () => {
    expect(parseNodeJobArgs("manage_probe", { roots: ["/srv/games"] })).toEqual({
      roots: ["/srv/games"],
      hints: [],
      maxDepth: 2,
      maxCandidates: 40,
    });
    expect(
      parseNodeJobArgs("manage_pack", { path: "/srv/games/pz", allowRoots: ["/srv/games"] })
        .maxBytes,
    ).toBe(32 * 1024 * 1024 * 1024);
    expect(
      parseNodeJobArgs("manage_pack_read", {
        packRel: "tmp/manage-packs/pack-j7.tar",
        offset: 0,
      }).length,
    ).toBe(4 * 1024 * 1024);
  });

  it("accepts the manage args the control plane already sends", () => {
    expect(
      parseNodeJobArgs("manage_probe", {
        // Roots stay patterns here; only the node that owns the disk can expand them.
        roots: ["~/games", "/srv/*/servers"],
        hints: [{ id: "project_zomboid_layout", anyFiles: ["StartServer64.sh"] }],
        maxDepth: 2,
        maxCandidates: 40,
      }).hints,
    ).toEqual([
      {
        id: "project_zomboid_layout",
        anyFiles: ["StartServer64.sh"],
      },
    ]);
    expect(
      parseNodeJobArgs("manage_seed", {
        sourcePath: "/opt/pzserver",
        allowRoots: ["/opt"],
        destRel: "servers/abc/game",
      }).destRel,
    ).toBe("servers/abc/game");
    expect(
      parseNodeJobArgs("manage_cutover", {
        sourcePath: "/opt/pzserver",
        allowRoots: ["/opt"],
        homeRel: "servers/abc/home",
        manage: { userdataHomeDirs: ["Zomboid"], serverNameArg: "servername" },
      }).manage,
    ).toEqual({
      userdataHomeDirs: ["Zomboid"],
      serverNameArg: "servername",
      adminPasswordArg: false,
      worldSubdirs: ["Server", "db", "Saves/Multiplayer"],
    });
  });

  it("refuses manage destinations outside the adopted server's own dirs", () => {
    for (const destRel of ["servers/abc", "servers/abc/home", "game", "../etc", "/srv/abc/game"]) {
      expect(() =>
        parseNodeJobArgs("manage_seed", {
          sourcePath: "/opt/pzserver",
          allowRoots: ["/opt"],
          destRel,
        }),
      ).toThrow(/validation_failed/);
    }
    expect(() =>
      parseNodeJobArgs("manage_cutover", {
        sourcePath: "/opt/pzserver",
        allowRoots: ["/opt"],
        homeRel: "servers/abc/game",
        manage: {},
      }),
    ).toThrow(/validation_failed/);
    // A pack chunk may only be read back out of the staging dir.
    for (const packRel of ["servers/abc/game/secrets.tar", "../tmp/manage-packs/p.tar"]) {
      expect(() => parseNodeJobArgs("manage_pack_read", { packRel, offset: 0 })).toThrow(
        /validation_failed/,
      );
    }
  });

  it("rejects manage args that could only be a mistake", () => {
    expect(() => parseNodeJobArgs("manage_probe", { roots: [] })).toThrow(/validation_failed/);
    expect(() => parseNodeJobArgs("manage_probe", { roots: ["/srv"], maxDepth: 9 })).toThrow(
      /validation_failed/,
    );
    expect(() => parseNodeJobArgs("manage_pack", { path: "/srv/games/pz" })).toThrow(
      /validation_failed/,
    );
    expect(() =>
      parseNodeJobArgs("manage_pack_read", {
        packRel: "tmp/manage-packs/p.tar",
        offset: 0,
        length: 64 * 1024 * 1024,
      }),
    ).toThrow(/validation_failed/);
    expect(() =>
      parseNodeJobArgs("manage_seed", {
        sourcePath: "/opt/pzserver",
        allowRoots: ["/opt"],
        destRel: "servers/abc/game",
        overwrite: true,
      }),
    ).toThrow(/validation_failed/);
  });
});

describe("parseNodeJobResult", () => {
  it("accepts real agent payloads", () => {
    expect(
      parseNodeJobResult("ping", {
        pong: true,
        nodeId: "node-z",
        dataRoot: "/var/lib/playon-node",
        at: new Date().toISOString(),
      }).pong,
    ).toBe(true);

    const caps = parseNodeJobResult("runtime_caps", {
      os: "linux",
      docker: true,
      native: true,
      steamcmd: false,
      jobKinds: ["ping"],
    });
    expect(caps.jobKinds).toEqual(["ping"]);

    expect(
      parseNodeJobResult("node_self_update", {
        version: "0.1.11",
        installRoot: "/opt/playon-node",
        preserved: ["data"],
        restartRequired: true,
      }).restartRequired,
    ).toBe(true);
  });

  it("accepts the fs payloads shipped agents already send", () => {
    expect(
      parseNodeJobResult("fs_list", {
        path: "servers/a",
        entries: [{ name: "game", type: "dir" }],
      }).entries,
    ).toEqual([{ name: "game", type: "dir" }]);
    expect(
      parseNodeJobResult("fs_read_text", {
        path: "servers/a/x.ini",
        content: "k=v",
        bytesRead: 3,
        truncated: false,
        size: 3,
      }).content,
    ).toBe("k=v");
    expect(parseNodeJobResult("fs_write_text", { path: "servers/a/x.ini", bytes: 3 }).bytes).toBe(3);
    expect(parseNodeJobResult("fs_ensure_dir", { path: "servers/a", ok: true }).ok).toBe(true);
    expect(parseNodeJobResult("fs_remove", { path: "servers/a", ok: true }).ok).toBe(true);
    expect(parseNodeJobResult("fs_rename", { from: "a", to: "b" }).to).toBe("b");
    expect(parseNodeJobResult("fs_copy", { from: "a", to: "b" }).to).toBe("b");
    expect(parseNodeJobResult("fs_put_archive", { path: "servers/a", ok: true }).ok).toBe(true);
    expect(parseNodeJobResult("fs_get_archive", { archiveBase64: "" }).archiveBase64).toBe("");
  });

  it("accepts a net_tcp_connect payload", () => {
    expect(
      parseNodeJobResult("net_tcp_connect", {
        host: "127.0.0.1",
        port: 25565,
        state: "open",
      }),
    ).toEqual({ host: "127.0.0.1", port: 25565, state: "open" });
    expect(() =>
      parseNodeJobResult("net_tcp_connect", {
        host: "127.0.0.1",
        port: 25565,
        state: "listening",
      }),
    ).toThrow(NodeJobError);
  });

  it("accepts a net_udp_listen payload", () => {
    expect(
      parseNodeJobResult("net_udp_listen", {
        port: 27015,
        listening: true,
        probe: "netstat",
      }),
    ).toEqual({ port: 27015, listening: true, probe: "netstat" });
    expect(() =>
      parseNodeJobResult("net_udp_listen", { port: 27015, listening: true, probe: "lsof" }),
    ).toThrow(NodeJobError);
  });

  it("accepts the container payloads shipped agents already send", () => {
    const created = parseNodeJobResult("container_create", {
      id: "9f2c1b",
      name: "playon-a",
      status: "created",
    });
    expect(created.id).toBe("9f2c1b");
    expect(
      parseNodeJobResult("container_inspect", { id: "9f2c1b", name: "playon-a", status: "running" })
        .status,
    ).toBe("running");
    expect(parseNodeJobResult("container_start", { ok: true }).ok).toBe(true);
    expect(parseNodeJobResult("container_stop", { ok: true }).ok).toBe(true);
    expect(parseNodeJobResult("container_remove", { ok: true }).ok).toBe(true);
    expect(parseNodeJobResult("container_stdin", { ok: true }).ok).toBe(true);
    expect(parseNodeJobResult("container_logs", { lines: ["[INFO] Done"] }).lines).toEqual([
      "[INFO] Done",
    ]);
  });

  it("rejects a container result the control plane could not act on", () => {
    expect(() => parseNodeJobResult("container_inspect", { id: "9f2c1b", name: "a" })).toThrow(
      NodeJobError,
    );
    expect(() =>
      parseNodeJobResult("container_inspect", { id: "9f2c1b", name: "a", status: "paused" }),
    ).toThrow(NodeJobError);
    expect(() => parseNodeJobResult("container_logs", { lines: "one line" })).toThrow(NodeJobError);
  });

  it("rejects an fs result missing contract fields", () => {
    expect(() => parseNodeJobResult("fs_read_text", { path: "a", content: "x" })).toThrow(
      NodeJobError,
    );
    expect(() => parseNodeJobResult("fs_list", { path: "a", entries: [{ name: "x" }] })).toThrow(
      NodeJobError,
    );
  });

  it("rejects a malformed result with a typed error", () => {
    expect(() => parseNodeJobResult("ping", { pong: "yes" })).toThrow(NodeJobError);
    try {
      parseNodeJobResult("ping", {});
    } catch (err) {
      expect((err as NodeJobError).code).toBe("validation_failed");
      expect((err as NodeJobError).detail).toContain("result");
    }
  });

  it("accepts the process payloads shipped agents already send", () => {
    const started = parseNodeJobResult("process_start", {
      id: "native-server-a-1",
      name: "server-a",
      pid: 4242,
      status: "running",
    });
    expect(started.pid).toBe(4242);
    // The supervisor drops the pid once the child exits.
    expect(
      parseNodeJobResult("process_status", {
        id: "native-server-a-1",
        name: "server-a",
        status: "stopped",
      }).pid,
    ).toBeUndefined();
    expect(parseNodeJobResult("process_stop", { ok: true }).ok).toBe(true);
  });

  it("rejects a process result the control plane could not act on", () => {
    expect(() => parseNodeJobResult("process_status", { id: "a", name: "server-a" })).toThrow(
      NodeJobError,
    );
    expect(() =>
      parseNodeJobResult("process_status", { id: "a", name: "server-a", status: "zombie" }),
    ).toThrow(NodeJobError);
  });

  it("accepts the steamcmd payload a shipped agent sends", () => {
    const run = parseNodeJobResult("steamcmd_app_update", {
      ok: true,
      binary: "/root/steamcmd/steamcmd.sh",
      exitCode: 0,
      stdout: "Success! App '258550' fully installed.",
      stderr: "",
      installDir: "/var/lib/playon-node/servers/a/game",
      appId: 258_550,
      provisioned: true,
    });
    expect(run.appId).toBe(258_550);
    expect(run.provisioned).toBe(true);
    expect(() =>
      parseNodeJobResult("steamcmd_app_update", { ok: true, appId: 258_550, exitCode: 0 }),
    ).toThrow(NodeJobError);
  });

  it("accepts the manage payloads shipped agents already send", () => {
    expect(
      parseNodeJobResult("manage_probe", {
        candidates: [
          {
            path: "/srv/games/pz",
            hintIds: ["project_zomboid_layout"],
            suggestedGame: "Project Zomboid",
          },
        ],
        scannedRoots: ["/srv/games"],
      }).candidates[0]?.suggestedGame,
    ).toBe("Project Zomboid");
    expect(
      parseNodeJobResult("manage_pack", {
        packRel: "tmp/manage-packs/pack-j7.tar",
        bytes: 2048,
        path: "/srv/games/pz",
      }).bytes,
    ).toBe(2048);
    expect(
      parseNodeJobResult("manage_pack_read", {
        dataBase64: "AAAA",
        bytes: 3,
        offset: 0,
        done: true,
      }).done,
    ).toBe(true);
    expect(
      parseNodeJobResult("manage_seed", {
        destRel: "servers/abc/game",
        sourcePath: "/opt/pzserver",
        bytesCopied: 10,
      }).bytesCopied,
    ).toBe(10);
    // A cutover with nothing to warn about still reports an (empty) warning list.
    expect(
      parseNodeJobResult("manage_cutover", {
        playonHome: "/var/lib/playon-node/servers/abc/home",
        playonHomeRel: "servers/abc/home",
        userdataBytes: 0,
      }).warnings,
    ).toEqual([]);
  });

  it("rejects a manage result the control plane could not act on", () => {
    expect(() =>
      parseNodeJobResult("manage_probe", { candidates: [{ path: "/srv/games/pz" }] }),
    ).toThrow(NodeJobError);
    expect(() =>
      parseNodeJobResult("manage_cutover", {
        playonHomeRel: "servers/abc/home",
        userdataBytes: 0,
      }),
    ).toThrow(NodeJobError);
    expect(() =>
      parseNodeJobResult("manage_seed", {
        destRel: "servers/abc/game",
        sourcePath: "/opt/pzserver",
        bytesCopied: -1,
      }),
    ).toThrow(NodeJobError);
  });
});
