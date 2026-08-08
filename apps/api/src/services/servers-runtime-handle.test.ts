import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { ContainerSpec, DockerAdapter, ProcessSupervisor } from "@playon/runtime";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { LAB_DOCKER_SKILL, resolveFixturesRoot } from "../lab-games-root.js";
import { ServerService } from "./servers.js";

type FakeContainer = { id: string; name: string; status: "created" | "running" | "exited" };

const fake = vi.hoisted(() => {
  const calls: string[] = [];
  const containers = new Map<string, FakeContainer>();
  const specs: ContainerSpec[] = [];
  return {
    calls,
    containers,
    specs,
    reset() {
      calls.length = 0;
      containers.clear();
      specs.length = 0;
    },
    docker: {
      async create(spec: ContainerSpec) {
        calls.push(`create:${spec.name}`);
        specs.push(spec);
        const info: FakeContainer = { id: `cid-${spec.name}`, name: spec.name, status: "created" };
        containers.set(spec.name, info);
        return info;
      },
      async start(id: string) {
        calls.push(`start:${id}`);
        for (const c of containers.values()) if (c.id === id) c.status = "running";
      },
      async stop(id: string) {
        calls.push(`stop:${id}`);
        for (const c of containers.values()) if (c.id === id) c.status = "exited";
      },
      async remove(id: string) {
        calls.push(`remove:${id}`);
      },
      async inspect(id: string) {
        calls.push(`inspect:${id}`);
        const hit = containers.get(id) ?? [...containers.values()].find((c) => c.id === id);
        if (!hit) throw new Error("no such container");
        return hit;
      },
      async logs(id: string, tail?: number) {
        calls.push(`logs:${id}:${tail ?? "all"}`);
        return ["fake-log"];
      },
    },
  };
});

vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  const supervisor: ProcessSupervisor = {
    async start() {
      throw new Error("native_supervisor_should_not_run");
    },
    async stop() {},
    async status(id: string) {
      return { id, name: id, status: "unknown" as const };
    },
  };
  return {
    ...actual,
    createRuntime: async () => ({
      docker: fake.docker as unknown as DockerAdapter,
      process: supervisor,
      mode: "docker" as const,
    }),
  };
});

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function findRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function tempEnv(): { db: Db; config: AppConfig; servers: ServerService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-runtime-handle-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [resolveFixturesRoot(findRepoRoot()), path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  return { db, config, servers: new ServerService(db, config) };
}

beforeEach(() => {
  fake.reset();
});

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
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
