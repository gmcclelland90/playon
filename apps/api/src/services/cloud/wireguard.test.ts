import { describe, expect, it } from "vitest";
import {
  generateWgKeypair,
  MemoryWireGuardRunner,
  overlayIpForHost,
  renderWgQuickConfig,
  wgPublicFromPrivate,
} from "./wireguard.js";

describe("wireguard helpers", () => {
  it("generates matching keypairs", () => {
    const pair = generateWgKeypair();
    expect(pair.privateKey.length).toBeGreaterThan(20);
    expect(wgPublicFromPrivate(pair.privateKey)).toBe(pair.publicKey);
  });

  it("renders wg-quick config", () => {
    const conf = renderWgQuickConfig({
      privateKey: "AAA=",
      address: "10.77.0.1/24",
      peers: [
        {
          publicKey: "BBB=",
          allowedIps: "10.77.0.2/32",
          endpoint: "1.2.3.4:51820",
          persistentKeepalive: 25,
        },
      ],
    });
    expect(conf).toContain("PrivateKey = AAA=");
    expect(conf).toContain("Endpoint = 1.2.3.4:51820");
    expect(conf).toContain("AllowedIPs = 10.77.0.2/32");
  });

  it("allocates overlay hosts", () => {
    expect(overlayIpForHost(2)).toBe("10.77.0.2");
    expect(() => overlayIpForHost(1)).toThrow();
  });

  it("memory runner stores config", async () => {
    const runner = new MemoryWireGuardRunner();
    await runner.apply("playon0", {
      privateKey: "x",
      address: "10.77.0.1/24",
      peers: [],
    });
    expect(runner.configs.get("playon0")?.address).toBe("10.77.0.1/24");
    await runner.down("playon0");
    expect(runner.configs.has("playon0")).toBe(false);
  });
});
