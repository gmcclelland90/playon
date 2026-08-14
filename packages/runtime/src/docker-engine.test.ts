import { describe, expect, it } from "vitest";
import {
  parseDockerEngineInfo,
  refineDockerCapability,
  inspectDockerEngine,
} from "./docker-engine.js";

describe("parseDockerEngineInfo", () => {
  it("reads Windows Server / Desktop Windows-container engines", () => {
    expect(parseDockerEngineInfo({ OSType: "windows", Isolation: "process" })).toEqual({
      osType: "windows",
      isolation: "process",
    });
    expect(parseDockerEngineInfo({ osType: "windows", isolation: "hyperv" })).toEqual({
      osType: "windows",
      isolation: "hyperv",
    });
  });

  it("reads Linux engines and ignores unknown isolation", () => {
    expect(parseDockerEngineInfo({ OSType: "linux" })).toEqual({ osType: "linux" });
    expect(parseDockerEngineInfo({ OSType: "linux", Isolation: "default" })).toEqual({
      osType: "linux",
    });
  });

  it("rejects missing or unknown OSType", () => {
    expect(parseDockerEngineInfo({})).toBeNull();
    expect(parseDockerEngineInfo({ OSType: "darwin" })).toBeNull();
    expect(parseDockerEngineInfo(null)).toBeNull();
  });
});

describe("refineDockerCapability", () => {
  const windowsCaps = {
    os: "windows" as const,
    docker: true,
    native: true,
    steamcmd: true,
  };

  it("keeps Linux socket-probe results unchanged", async () => {
    const linux = { os: "linux" as const, docker: true, native: true, steamcmd: false };
    await expect(refineDockerCapability(linux, async () => null)).resolves.toEqual(linux);
  });

  it("reports docker only when the Windows engine OSType is windows", async () => {
    await expect(
      refineDockerCapability(windowsCaps, async () => ({
        osType: "windows",
        isolation: "process",
      })),
    ).resolves.toMatchObject({ docker: true });
    await expect(
      refineDockerCapability(windowsCaps, async () => ({ osType: "linux" })),
    ).resolves.toMatchObject({ docker: false });
    await expect(refineDockerCapability(windowsCaps, async () => null)).resolves.toMatchObject({
      docker: false,
    });
  });
});

describe("inspectDockerEngine", () => {
  it("returns parsed info from an injected probe", async () => {
    await expect(
      inspectDockerEngine({
        info: async () => ({ OSType: "windows", Isolation: "hyperv" }),
      }),
    ).resolves.toEqual({ osType: "windows", isolation: "hyperv" });
  });

  it("returns null when the engine is unreachable", async () => {
    await expect(
      inspectDockerEngine({
        info: async () => {
          throw new Error("connect ENOENT");
        },
      }),
    ).resolves.toBeNull();
  });

  it("returns null when info hangs past the timeout", async () => {
    await expect(
      inspectDockerEngine({
        timeoutMs: 20,
        info: () => new Promise(() => undefined),
      }),
    ).resolves.toBeNull();
  });
});
