import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLancacheHeartbeatConfig,
  getLancacheAdvertisement,
  resetLancacheClientForTests,
} from "./lancache-client.js";

describe("lancache-client", () => {
  afterEach(() => {
    resetLancacheClientForTests();
  });

  it("applies and removes hosts pin via temp hosts file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-lc-client-"));
    const hostsPath = path.join(dir, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n", "utf8");

    await applyLancacheHeartbeatConfig(
      { enabled: true, cacheIp: "10.0.0.8", pinSteamcmd: true },
      { hostsPath },
    );
    const mid = fs.readFileSync(hostsPath, "utf8");
    expect(mid).toContain("10.0.0.8");
    expect(getLancacheAdvertisement().lancachePin).toBe("applied");

    await applyLancacheHeartbeatConfig(
      { enabled: false, pinSteamcmd: false },
      { hostsPath },
    );
    expect(fs.readFileSync(hostsPath, "utf8")).not.toContain("playon-lancache-begin");
    expect(getLancacheAdvertisement().lancachePin).toBe("removed");
  });

  it("skips pin when enabled but pinSteamcmd false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-lc-client-"));
    const hostsPath = path.join(dir, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n", "utf8");

    await applyLancacheHeartbeatConfig(
      { enabled: true, cacheIp: "10.0.0.8", pinSteamcmd: false },
      { hostsPath },
    );
    expect(fs.readFileSync(hostsPath, "utf8")).not.toContain("10.0.0.8");
    expect(getLancacheAdvertisement().lancachePin).toBe("skipped");
  });
});
