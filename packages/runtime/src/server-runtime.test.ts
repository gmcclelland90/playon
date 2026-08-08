import { describe, expect, it } from "vitest";
import {
  localDockerTransport,
  openServerRuntime,
  RuntimeUnsupportedError,
  type DockerRuntimeTransport,
  type ServerContainerSpec,
} from "./server-runtime.js";
import type { ContainerInfo, ContainerSpec, DockerAdapter } from "./types.js";

const SPEC: ServerContainerSpec = {
  image: "playon/fixture:latest",
  env: { A: "1" },
  ports: [{ host: 25565, container: 25565, protocol: "tcp" }],
};

interface FakeDocker extends DockerRuntimeTransport {
  calls: string[];
  containers: Map<string, ContainerInfo>;
}

function fakeDockerTransport(opts?: {
  existing?: ContainerInfo;
  locality?: "local" | "remote";
  stdin?: boolean;
}): FakeDocker {
  const containers = new Map<string, ContainerInfo>();
  if (opts?.existing) containers.set(opts.existing.name, opts.existing);
  const calls: string[] = [];
  const transport: FakeDocker = {
    locality: opts?.locality ?? "local",
    calls,
    containers,
    async inspect(id) {
      calls.push(`inspect:${id}`);
      const hit = containers.get(id) ?? [...containers.values()].find((c) => c.id === id);
      if (!hit) throw new Error("no such container");
      return hit;
    },
    async create(spec: ContainerSpec) {
      calls.push(`create:${spec.name}:${spec.image}`);
      const info: ContainerInfo = { id: `id-${spec.name}`, name: spec.name, status: "created" };
      containers.set(spec.name, info);
      return info;
    },
    async start(id) {
      calls.push(`start:${id}`);
    },
    async stop(id) {
      calls.push(`stop:${id}`);
    },
    async logs(id, tail) {
      calls.push(`logs:${id}:${tail ?? "all"}`);
      return ["line-1"];
    },
    writeStdin: opts?.stdin === false
      ? undefined
      : async (id, line) => {
          calls.push(`stdin:${id}:${line}`);
        },
  };
  return transport;
}

function openDocker(transport: DockerRuntimeTransport) {
  return openServerRuntime(
    { serverId: "srv1", mode: "docker", locality: transport.locality },
    {
      containerName: "playon-srv1",
      docker: transport,
      resolveContainerSpec: async () => SPEC,
    },
  );
}

describe("docker ServerRuntimeHandle", () => {
  it("creates the container under the handle-owned name, then starts it", async () => {
    const transport = fakeDockerTransport();
    const handle = openDocker(transport);

    const started = await handle.start();

    expect(started.id).toBe("id-playon-srv1");
    expect(transport.calls).toEqual([
      "inspect:playon-srv1",
      "create:playon-srv1:playon/fixture:latest",
      "start:id-playon-srv1",
    ]);
  });

  it("re-resolves an existing container instead of creating a second one", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "exited" },
    });
    const handle = openDocker(transport);

    const started = await handle.start();

    expect(started.id).toBe("abc123");
    expect(transport.calls).toEqual(["inspect:playon-srv1", "start:abc123"]);
  });

  it("stops the resolved container id", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
    });
    const handle = openDocker(transport);

    await handle.stop();

    expect(transport.calls).toEqual(["inspect:playon-srv1", "stop:abc123"]);
  });

  it("stop is a no-op when the container is gone", async () => {
    const transport = fakeDockerTransport();
    const handle = openDocker(transport);

    await expect(handle.stop()).resolves.toBeUndefined();
    expect(transport.calls).toEqual(["inspect:playon-srv1"]);
  });

  it("restart stops before starting", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
    });
    const handle = openDocker(transport);

    await handle.restart();

    expect(transport.calls).toEqual([
      "inspect:playon-srv1",
      "stop:abc123",
      "inspect:playon-srv1",
      "start:abc123",
    ]);
  });

  it("maps container status onto runtime state", async () => {
    const running = openDocker(
      fakeDockerTransport({ existing: { id: "a", name: "playon-srv1", status: "running" } }),
    );
    const exited = openDocker(
      fakeDockerTransport({ existing: { id: "b", name: "playon-srv1", status: "exited" } }),
    );
    const missing = openDocker(fakeDockerTransport());

    await expect(running.status()).resolves.toEqual({ state: "running", id: "a", detail: "running" });
    await expect(exited.status()).resolves.toEqual({ state: "stopped", id: "b", detail: "exited" });
    await expect(missing.status()).resolves.toEqual({ state: "missing" });
  });

  it("tails logs for the resolved id and returns nothing when missing", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
    });
    await expect(openDocker(transport).logs(20)).resolves.toEqual(["line-1"]);
    expect(transport.calls).toContain("logs:abc123:20");

    await expect(openDocker(fakeDockerTransport()).logs(20)).resolves.toEqual([]);
  });

  it("writes stdin to the resolved id, and reports unsupported transports", async () => {
    const transport = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
    });
    await openDocker(transport).writeStdin("say hi");
    expect(transport.calls).toContain("stdin:abc123:say hi");

    const noStdin = fakeDockerTransport({
      existing: { id: "abc123", name: "playon-srv1", status: "running" },
      stdin: false,
    });
    await expect(openDocker(noStdin).writeStdin("say hi")).rejects.toThrow(
      /runtime_unsupported: docker stdin/,
    );
  });
});

describe("localDockerTransport", () => {
  it("adapts a DockerAdapter and reports local locality", async () => {
    const seen: string[] = [];
    const adapter: DockerAdapter = {
      async create(spec) {
        seen.push(`create:${spec.name}`);
        return { id: "x", name: spec.name, status: "created" };
      },
      async start(id) {
        seen.push(`start:${id}`);
      },
      async stop(id) {
        seen.push(`stop:${id}`);
      },
      async remove(id) {
        seen.push(`remove:${id}`);
      },
      async inspect(id) {
        seen.push(`inspect:${id}`);
        return { id: "x", name: id, status: "running" };
      },
      async logs(id, tail) {
        seen.push(`logs:${id}:${tail ?? "all"}`);
        return [];
      },
    };

    const transport = localDockerTransport(adapter);
    expect(transport.locality).toBe("local");
    // Adapters without stdin support surface as an unsupported capability, not a silent no-op.
    expect(transport.writeStdin).toBeUndefined();

    await openDocker(transport).start();
    expect(seen).toEqual(["inspect:playon-srv1", "start:x"]);
  });
});

describe("openServerRuntime", () => {
  it("refuses native quadrants until they are wired", () => {
    expect(() =>
      openServerRuntime(
        { serverId: "srv1", mode: "native", locality: "local" },
        { containerName: "playon-srv1" },
      ),
    ).toThrow(RuntimeUnsupportedError);
  });

  it("refuses docker quadrants with no transport", () => {
    expect(() =>
      openServerRuntime(
        { serverId: "srv1", mode: "docker", locality: "remote" },
        { containerName: "playon-srv1" },
      ),
    ).toThrow(/runtime_unsupported: docker remote/);
  });

  it("refuses a transport whose locality contradicts the target", () => {
    expect(() =>
      openServerRuntime(
        { serverId: "srv1", mode: "docker", locality: "remote" },
        {
          containerName: "playon-srv1",
          docker: fakeDockerTransport({ locality: "local" }),
          resolveContainerSpec: async () => SPEC,
        },
      ),
    ).toThrow(/runtime_locality_mismatch/);
  });
});
