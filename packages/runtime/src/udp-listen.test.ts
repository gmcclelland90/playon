import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import { probeUdpListen } from "./udp-listen.js";

describe("probeUdpListen", () => {
  it("reports a bound UDP port as listening and an unused port as not", async () => {
    if (process.platform === "win32") return;

    const socket = dgram.createSocket("udp4");
    const port = await new Promise<number>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => {
        const addr = socket.address();
        resolve(typeof addr === "string" ? 0 : addr.port);
      });
    });
    expect(port).toBeGreaterThan(0);
    try {
      const bound = probeUdpListen(port);
      expect(bound.port).toBe(port);
      expect(bound.probe).toMatch(/^(ss|netstat)$/);
      expect(bound.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }

    const after = probeUdpListen(port);
    expect(after.listening).toBe(false);
  });
});
