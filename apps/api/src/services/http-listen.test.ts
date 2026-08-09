import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { listenPlayOnHttp, type MultiListenResult } from "./http-listen.js";

const openResults: MultiListenResult[] = [];

afterEach(async () => {
  while (openResults.length) {
    const multi = openResults.pop()!;
    await new Promise<void>((resolve) => multi.composite.close(() => resolve()));
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

describe("listenPlayOnHttp", () => {
  it("binds preferred + fallback on 0.0.0.0 when privileged LAN succeeds (legacy node-agents)", async () => {
    const preferred = await freePort();
    const fallback = await freePort();
    expect(preferred).not.toBe(fallback);

    const multi = await listenPlayOnHttp({
      app: { fetch: async () => new Response("ok") },
      lanHost: "0.0.0.0",
      preferredLanPort: preferred,
      fallbackPort: fallback,
      loopbackPort: fallback,
    });
    openResults.push(multi);

    expect(multi.privilegedLan).toBe(true);
    expect(multi.lanPort).toBe(preferred);
    expect(multi.endpoints.some((e) => e.host === "0.0.0.0" && e.port === preferred)).toBe(true);
    expect(multi.endpoints.some((e) => e.host === "0.0.0.0" && e.port === fallback)).toBe(true);
    // Wildcard :fallback covers loopback — no duplicate 127.0.0.1 listener
    expect(multi.endpoints.some((e) => e.host === "127.0.0.1")).toBe(false);
  });

  it("falls back to a single LAN port when preferred bind fails", async () => {
    const blockerPort = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(blockerPort, "0.0.0.0", () => resolve());
    });
    try {
      const fallback = await freePort();
      const multi = await listenPlayOnHttp({
        app: { fetch: async () => new Response("ok") },
        lanHost: "0.0.0.0",
        preferredLanPort: blockerPort,
        fallbackPort: fallback,
        loopbackPort: fallback,
      });
      openResults.push(multi);
      expect(multi.privilegedLan).toBe(false);
      expect(multi.lanPort).toBe(fallback);
      expect(multi.endpoints.some((e) => e.port === fallback)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
