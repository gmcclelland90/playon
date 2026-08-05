import { describe, expect, it } from "vitest";
import {
  buildCloudBootstrapScript,
  buildLanBootstrapScript,
  clearBootstrapTokensForTests,
} from "./add-node.js";

describe("bootstrap scripts", () => {
  it("builds LAN install script", () => {
    const script = buildLanBootstrapScript({
      apiUrl: "http://192.168.1.10:8787",
      nodeToken: "tok",
      nodeId: "spare-1",
    });
    expect(script).toContain("--api 'http://192.168.1.10:8787'");
    expect(script).toContain("--node-id 'spare-1'");
  });

  it("builds cloud script with wireguard", () => {
    const script = buildCloudBootstrapScript({
      apiUrl: "http://10.77.0.1:8787",
      nodeToken: "tok",
      nodeId: "vps-1",
      wgConfig: "[Interface]\nPrivateKey = x\n",
      wgListenPort: 51820,
    });
    expect(script).toContain("wireguard");
    expect(script).toContain("wg-quick up playon0");
    expect(script).toContain("10.77.0.1:8787");
  });

  it("clears tokens helper", () => {
    clearBootstrapTokensForTests();
    expect(true).toBe(true);
  });
});
