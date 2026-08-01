import { describe, expect, it } from "vitest";
import { createMockRuntimeAdapters, createRuntimeAdapters } from "./factory.js";
import { MockDockerAdapter } from "./mock-docker.js";

describe("createMockRuntimeAdapters", () => {
  it("returns mock docker that supports name-based inspect after create", async () => {
    const { docker, mode } = createMockRuntimeAdapters();
    expect(mode).toBe("mock");
    expect(docker).toBeInstanceOf(MockDockerAdapter);

    const created = await docker.create({
      name: "playon-test",
      image: "itzg/minecraft-server:latest",
      ports: [{ host: 25565, container: 25565 }],
    });
    const info = await docker.inspect("playon-test");
    expect(info.id).toBe(created.id);
    await docker.start("playon-test");
    expect((await docker.inspect(created.id)).status).toBe("running");
  });
});

describe("createRuntimeAdapters", () => {
  it("honours mock mode without probing Docker", async () => {
    const adapters = await createRuntimeAdapters("mock");
    expect(adapters.mode).toBe("mock");
    expect(adapters.docker).toBeInstanceOf(MockDockerAdapter);
  });

  it("uses docker when available, otherwise falls back to mock", async () => {
    const adapters = await createRuntimeAdapters("docker");
    expect(["mock", "docker"]).toContain(adapters.mode);
    if (adapters.mode === "mock") {
      expect(adapters.docker).toBeInstanceOf(MockDockerAdapter);
    }
  });
});

