import { describe, expect, it } from "vitest";
import { NodeJobKindSchema } from "../api.js";
import { NodeJobError } from "./errors.js";
import {
  ALL_NODE_JOB_KINDS,
  NODE_JOB_CONTRACTS,
  REGISTERED_NODE_JOB_KINDS,
  isRegisteredNodeJobKind,
  nodeJobContract,
  parseNodeJobArgs,
  parseNodeJobResult,
} from "./registry.js";

/** Kinds still waiting for their slice; used as the shim's stand-in. */
const SHIMMED_KIND = "process_status";

describe("node job registry", () => {
  it("registers exactly the meta, fs, and container families in this slice", () => {
    expect([...REGISTERED_NODE_JOB_KINDS].sort()).toEqual(
      [
        "node_self_update",
        "ping",
        "runtime_caps",
        "fs_list",
        "fs_read_text",
        "fs_write_text",
        "fs_ensure_dir",
        "fs_remove",
        "fs_rename",
        "fs_copy",
        "fs_put_archive",
        "fs_get_archive",
        "container_create",
        "container_start",
        "container_stop",
        "container_remove",
        "container_inspect",
        "container_logs",
        "container_stdin",
      ].sort(),
    );
  });

  it("covers every fs and container kind the node agent can run", () => {
    const migrated = ALL_NODE_JOB_KINDS.filter(
      (k) => k.startsWith("fs_") || k.startsWith("container_"),
    );
    for (const kind of migrated) {
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
    for (const kind of REGISTERED_NODE_JOB_KINDS) {
      expect(NodeJobKindSchema.options).toContain(kind);
    }
    expect(ALL_NODE_JOB_KINDS).toEqual(NodeJobKindSchema.options);
  });

  it("classifies registered vs shimmed kinds", () => {
    expect(isRegisteredNodeJobKind("ping")).toBe(true);
    expect(isRegisteredNodeJobKind(SHIMMED_KIND)).toBe(false);
    expect(nodeJobContract("ping")?.kind).toBe("ping");
    expect(nodeJobContract(SHIMMED_KIND)).toBeUndefined();
  });
});

describe("parseNodeJobArgs", () => {
  it("round-trips meta args", () => {
    expect(parseNodeJobArgs("ping", {})).toEqual({});
    expect(parseNodeJobArgs("runtime_caps")).toEqual({});
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
      ports: [],
      binds: [],
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
        ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
        binds: [{ hostPath: "servers/a/game", containerPath: "/data" }],
      }),
    ).toEqual({
      name: "playon-a",
      image: "itzg/minecraft-server:latest",
      env: { ENABLE_RCON: "true", RCON_PORT: "25575" },
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

  it("passes unmigrated kinds through untouched (W1 shim)", () => {
    const args = { id: "abc", weird: 1 };
    expect(parseNodeJobArgs(SHIMMED_KIND, args)).toEqual(args);
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

  it("passes unmigrated kinds through untouched (W1 shim)", () => {
    const result = { id: "abc", running: true };
    expect(parseNodeJobResult(SHIMMED_KIND, result)).toEqual(result);
  });
});
