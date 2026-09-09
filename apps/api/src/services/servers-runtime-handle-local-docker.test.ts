import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAB_DOCKER_SKILL } from "../lab-games-root.js";
import {
  cleanupRuntimeHandleTemps,
  fake,
  host,
  node,
  resetRuntimeHandleFakes,
  tempEnv,
  writeFactorioShapedSkill,
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

describe("local docker lifecycle through ServerRuntimeHandle", () => {
  it("exposes a docker/local handle from the runtime choke point", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });

    const handle = await servers.runtime(server.id);

    expect(handle.mode).toBe("docker");
    expect(handle.locality).toBe("local");
  });

  it("start creates the container under the handle-owned name and starts it", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });

    const started = await servers.start(server.id);

    expect(started.status).toBe("running");
    expect(fake.calls).toContain(`create:playon-${server.id}`);
    expect(fake.calls).toContain(`start:cid-playon-${server.id}`);

    const spec = fake.specs[0]!;
    expect(spec.image).toBe("itzg/minecraft-server:latest");
    expect(spec.env?.RCON_PORT).toBe("25575");
    expect(spec.ports?.map((p) => p.host)).toEqual([25565, 25575]);
    expect(spec.binds?.[0]).toEqual({
      hostPath: path.join(server.dataPath, "game"),
      containerPath: "/data",
    });
  });

  it("publishes Factorio game 34197/udp and rcon 27015/tcp — not a Source game remap (#942)", async () => {
    const { servers, config } = tempEnv();
    writeFactorioShapedSkill(path.join(config.dataRoot!, "skills"));
    const server = await servers.createFromSkill({ skillName: "fixtures.lab-factorio-ports" });

    await servers.start(server.id);

    expect(fake.specs[0]?.ports).toEqual([
      { host: 34197, container: 34197, protocol: "udp" },
      { host: 27015, container: 27015, protocol: "tcp" },
    ]);
  });

  it("rewrites Docker bind-address-in-use as host_port_in_use with the holder (#941)", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    const origStart = fake.docker.start;
    fake.docker.start = async () => {
      throw new Error(
        "(HTTP code 500) server error - failed to bind host port 0.0.0.0:27015/tcp: address already in use",
      );
    };
    servers.hostPortHoldersOverride = async () => [
      {
        name: "playon-leftover",
        image: "cm2network/cs2",
        status: "running",
        ports: [{ host: 27015, container: 27015, protocol: "tcp" }],
      },
    ];
    try {
      await expect(servers.start(server.id)).rejects.toThrow(
        /host_port_in_use: 27015\/tcp held by container playon-leftover/,
      );
    } finally {
      fake.docker.start = origStart;
    }
  });

  it("start reuses an existing container instead of creating a second one", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    await servers.stop(server.id);
    fake.calls.length = 0;

    await servers.start(server.id);

    expect(fake.calls.filter((c) => c.startsWith("create:"))).toEqual([]);
    expect(fake.calls).toContain(`start:cid-playon-${server.id}`);
  });

  it("start does not start a second container when a healthy instance already exists", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    fake.calls.length = 0;
    servers.portsBoundOverride = async () => true;

    const again = await servers.start(server.id);

    expect(again.status).toBe("running");
    expect(fake.calls.filter((c) => c.startsWith("create:"))).toEqual([]);
    expect(fake.calls.filter((c) => c.startsWith("start:"))).toEqual([]);
  });

  it("start reaps a leftover host process before starting the named container", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    host.plantLeftover({
      id: "native-orphan-99",
      name: `server-${server.id}`,
      pid: 99,
      status: "running",
    });
    servers.portsBoundOverride = async () => false;

    const started = await servers.start(server.id);

    expect(started.status).toBe("running");
    expect(host.calls.some((c) => c.startsWith("reclaim:"))).toBe(true);
    expect(host.running).toBeNull();
    expect(fake.calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
    expect(fake.calls.filter((c) => c.startsWith("start:"))).toHaveLength(1);
  });

  it("docker reap_then_start also reaps a native leftover beside the container", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    host.plantLeftover({
      id: "native-orphan-77",
      name: `server-${server.id}`,
      pid: 77,
      status: "running",
    });
    servers.portsBoundOverride = async () => false;
    host.calls.length = 0;
    fake.calls.length = 0;

    const started = await servers.start(server.id);

    expect(started.status).toBe("running");
    expect(host.calls.some((c) => c.startsWith("reclaim:"))).toBe(true);
    expect(host.running).toBeNull();
    expect(fake.calls.filter((c) => c.startsWith("start:"))).toHaveLength(1);
  });

  it("stop resolves the container id before stopping it", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    fake.calls.length = 0;

    const stopped = await servers.stop(server.id);

    expect(stopped.status).toBe("stopped");
    expect(fake.calls).toContain(`stop:cid-playon-${server.id}`);
    expect(fake.calls).not.toContain(`stop:playon-${server.id}`);
  });

  it("restart cycles the same container through the handle", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    fake.calls.length = 0;

    const restarted = await servers.restart(server.id);

    expect(restarted.status).toBe("running");
    expect(fake.calls).toEqual(
      expect.arrayContaining([`stop:cid-playon-${server.id}`, `start:cid-playon-${server.id}`]),
    );
    expect(fake.calls.filter((c) => c.startsWith("create:"))).toEqual([]);
  });

  it("alive container with advertised ports unbound is reaped and not reported running", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);
    servers.portsBoundOverride = async () => false;
    servers.portDeadGraceMs = 0;
    servers.autoRestartOnDeadInstance = false;

    const row = await servers.get(server.id);

    expect(row!.status).toBe("error");
    expect(fake.containers.get(`playon-${server.id}`)?.status).toBe("exited");
  });

  it("status reconciliation follows the container state", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);

    fake.containers.get(`playon-${server.id}`)!.status = "exited";
    expect((await servers.get(server.id))!.status).toBe("stopped");

    fake.containers.get(`playon-${server.id}`)!.status = "running";
    expect((await servers.get(server.id))!.status).toBe("running");
  });

  it("status reconciliation reports stopped when the container is gone", async () => {
    const { servers } = tempEnv();
    const server = await servers.createFromSkill({ skillName: LAB_DOCKER_SKILL });
    await servers.start(server.id);

    fake.containers.clear();

    expect((await servers.get(server.id))!.status).toBe("stopped");
  });
});
