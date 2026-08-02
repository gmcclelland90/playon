import { describe, expect, it } from "vitest";
import { createNativeRuntimeAdapters, createRuntimeAdapters, UnavailableDockerAdapter } from "./factory.js";

describe("createRuntimeAdapters", () => {
  it("returns docker adapters when Docker is available", async () => {
    const adapters = await createRuntimeAdapters("docker");
    expect(adapters.mode).toBe("docker");
  });

  it("native adapters refuse Docker ops", async () => {
    const adapters = createNativeRuntimeAdapters();
    expect(adapters.docker).toBeInstanceOf(UnavailableDockerAdapter);
    await expect(adapters.docker.create({ name: "x", image: "y" })).rejects.toThrow(
      /docker_not_configured/,
    );
  });
});
