import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANCACHE_SETTINGS,
  lancacheSettingsFromPut,
  toLancacheAgentConfig,
  toPublicLancacheSettings,
} from "./settings.js";

describe("lancache settings", () => {
  it("defaults and public DTO include tip sheet", () => {
    const pub = toPublicLancacheSettings(null);
    expect(pub.enabled).toBe(false);
    expect(pub.pinSteamcmd).toBe(false);
    expect(pub.tipSheet.length).toBeGreaterThan(0);
    expect(pub.diskWarn).toBe(false);
  });

  it("diskWarn when free disk below threshold and enabled", () => {
    const pub = toPublicLancacheSettings(
      { ...DEFAULT_LANCACHE_SETTINGS, enabled: true, warnFreeDiskBytes: 1000 },
      { minFreeDiskBytes: 500 },
    );
    expect(pub.diskWarn).toBe(true);
  });

  it("fromPut validates cache IP and merges", () => {
    const next = lancacheSettingsFromPut(
      { enabled: true, cacheIp: "10.0.0.5", pinSteamcmd: true },
      DEFAULT_LANCACHE_SETTINGS,
    );
    expect(next.enabled).toBe(true);
    expect(next.cacheIp).toBe("10.0.0.5");
    expect(next.pinSteamcmd).toBe(true);
    expect(() =>
      lancacheSettingsFromPut({ cacheIp: "999.1.1.1" }, DEFAULT_LANCACHE_SETTINGS),
    ).toThrow(/lancache_cache_ip_invalid/);
  });

  it("agent config omits empty cacheIp", () => {
    const cfg = toLancacheAgentConfig({ ...DEFAULT_LANCACHE_SETTINGS, enabled: true });
    expect(cfg).toEqual({ enabled: true, pinSteamcmd: false });
    const withIp = toLancacheAgentConfig({
      ...DEFAULT_LANCACHE_SETTINGS,
      enabled: true,
      cacheIp: "192.168.1.10",
      pinSteamcmd: true,
    });
    expect(withIp.cacheIp).toBe("192.168.1.10");
  });
});
