import { describe, expect, it } from "vitest";
import {
  createNativeRuntimeAdapters,
  createRuntime,
  createRuntimeAdapters,
  UnavailableDockerAdapter,
} from "./factory.js";

describe("createRuntime", () => {
  it("returns docker adapters when Docker is available", async ({ skip }) => {
    let adapters;
    try {
      adapters = await createRuntime("docker");
    } catch (err) {
      if (String(err).includes("docker_unavailable")) {
        skip();
        return;
      }
      throw err;
    }
    expect(adapters.mode).toBe("docker");
  });

  it("native mode labels adapters as native", async () => {
    const adapters = await createRuntime("native");
    expect(adapters.mode).toBe("native");
    expect(adapters.docker).toBeInstanceOf(UnavailableDockerAdapter);
  });
});

describe("createRuntimeAdapters", () => {
  it("returns docker adapters when Docker is available", async ({ skip }) => {
    let adapters;
    try {
      adapters = await createRuntimeAdapters("docker");
    } catch (err) {
      if (String(err).includes("docker_unavailable")) {
        skip();
        return;
      }
      throw err;
    }
    expect(adapters.mode).toBe("docker");
  });

  it("native adapters refuse Docker ops and label mode native", async () => {
    const adapters = createNativeRuntimeAdapters();
    expect(adapters.mode).toBe("native");
    expect(adapters.docker).toBeInstanceOf(UnavailableDockerAdapter);
    await expect(adapters.docker.create({ name: "x", image: "y" })).rejects.toThrow(
      /docker_not_configured/,
    );
  });

  it("createRuntimeAdapters('native') matches createNativeRuntimeAdapters", async () => {
    const adapters = await createRuntimeAdapters("native");
    expect(adapters.mode).toBe("native");
    expect(adapters.docker).toBeInstanceOf(UnavailableDockerAdapter);
  });
});
