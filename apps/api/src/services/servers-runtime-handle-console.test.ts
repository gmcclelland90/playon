import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { servers as serversTable } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { ServerService } from "./servers.js";
import {
  cleanupRuntimeHandleTemps,
  fake,
  host,
  node,
  placeOnRemoteNode,
  resetRuntimeHandleFakes,
  tempEnv,
} from "./servers-runtime-handle-fakes.js";

vi.mock("./node-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-runtime.js")>();
  return {
    ...actual,
    dispatchNodeJob: (opts: { kind: string; args?: Record<string, unknown> }) =>
      node.dispatch(opts),
  };
});

vi.mock("./node-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-sync.js")>();
  return { ...actual, pushServerDirToNode: async () => undefined };
});

vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  const { unitRuntimeDockerStubs } = await import("../test/unit-runtime-mocks.js");
  return {
    ...actual,
    ...unitRuntimeDockerStubs(actual),
    createRuntime: async () => ({
      docker: fake.docker as never,
      process: host.supervisor,
      mode: "docker" as const,
    }),
  };
});

/**
 * Split from servers-runtime-handle.test.ts so Windows CI does not pack ~177s
 * of SQLite/fs work into one vitest file near the birpc onTaskUpdate cliff
 * (#912 / vitest#6511).
 */

beforeEach(() => {
  resetRuntimeHandleFakes();
});

afterEach(() => {
  cleanupRuntimeHandleTemps();
});

describe("console stdin through ServerRuntimeHandle", () => {
  const STDIN_SKILL = "fixtures.stdin-console-server";

  /** A skill whose admin console is the game's own stdin, in the per-test skills root. */
  function writeStdinSkill(config: AppConfig): void {
    const dir = path.join(config.dataRoot, "skills", "stdin-console-server");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "metadata.yaml"),
      [
        `name: ${STDIN_SKILL}`,
        "version: 0.1.0",
        "game: Stdin Console Server",
        "containerSupport: full",
        "dockerImage: playon/fixture-stdin:latest",
        "dockerDataMount: /data",
        "adminDialect: stdin",
        "ports:",
        "  - name: game",
        "    protocol: tcp",
        "    default: 27015",
        "",
      ].join("\n"),
    );
  }

  /** A stdin-dialect server in one of the four quadrants. */
  async function stdinServer(opts?: { remote?: boolean; native?: boolean }): Promise<{
    servers: ServerService;
    id: string;
    name: string;
    gameDir: string;
  }> {
    const { db, config, servers } = tempEnv();
    writeStdinSkill(config);
    const server = await servers.createFromSkill({ skillName: STDIN_SKILL });
    const gameDir = path.join(server.dataPath, "game");
    if (opts?.native) {
      await db
        .update(serversTable)
        .set({ runtimeMode: "native" })
        .where(eq(serversTable.id, server.id));
      fs.mkdirSync(gameDir, { recursive: true });
      fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\nsleep 30\n");
      fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\n");
    }
    if (opts?.remote) await placeOnRemoteNode(db, server.id);
    fake.reset();
    host.reset();
    node.jobs.length = 0;
    return { servers, id: server.id, name: `playon-${server.id}`, gameDir };
  }

  it("local docker: writes to the container Home runs, by resolved id", async () => {
    const { servers, id } = await stdinServer();
    await servers.start(id);
    fake.calls.length = 0;

    await expect(servers.consoleCapability(id)).resolves.toEqual({
      input: "ready",
      dialect: "stdin",
    });
    await servers.writeStdin(id, "say hi");

    expect(fake.calls).toContain(`stdin:cid-playon-${id}:say hi`);
  });

  it("reports the console unavailable while the server is down", async () => {
    const { servers, id } = await stdinServer();

    await expect(servers.consoleCapability(id)).resolves.toEqual({
      input: "unavailable",
      dialect: "stdin",
    });
  });

  it("remote docker: writes through the node's container job, never Home's docker", async () => {
    const { servers, id, name } = await stdinServer({ remote: true });
    await servers.start(id);
    node.jobs.length = 0;
    fake.calls.length = 0;

    await servers.writeStdin(id, "say hi");

    expect(node.jobs.at(-1)).toEqual({
      kind: "container_stdin",
      args: { id: `cid-${name}`, line: "say hi" },
    });
    expect(fake.calls).toEqual([]);
  });

  it("local native: writes to the supervised process, by identity", async () => {
    const { servers, id, gameDir } = await stdinServer({ native: true });
    await servers.start(id);
    host.calls.length = 0;
    fake.calls.length = 0;

    await expect(servers.consoleCapability(id)).resolves.toEqual({
      input: "ready",
      dialect: "stdin",
    });
    await servers.writeStdin(id, "say hi");

    expect(host.calls).toContain(`stdin:server-${id}:${gameDir}:say hi`);
    // A native console never goes near the container path.
    expect(fake.calls).toEqual([]);
  });

  it("remote native: reports no console instead of pretending to write", async () => {
    const { servers, id } = await stdinServer({ remote: true, native: true });
    await servers.start(id);
    node.jobs.length = 0;

    await expect(servers.consoleCapability(id)).resolves.toEqual({
      input: "unsupported",
      dialect: "stdin",
    });
    await expect(servers.writeStdin(id, "say hi")).rejects.toThrow(
      /runtime_unsupported: native stdin over remote transport/,
    );
    expect(node.kinds()).not.toContain("container_stdin");
    expect(host.calls).toEqual([]);
  });
});
