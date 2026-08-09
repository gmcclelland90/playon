import { describe, expect, it } from "vitest";
import net from "node:net";
import { factorioConnector, probeFactorioRcon } from "./factorio.js";

describe("factorio connector", () => {
  it("reports online when RCON TCP accepts", async () => {
    const server = net.createServer((sock) => sock.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const state = await factorioConnector.query({
        host: "127.0.0.1",
        port,
        queryPort: port,
        timeoutMs: 1000,
      });
      expect(state.online).toBe(true);
      expect(state.game).toBe("Factorio");
    } finally {
      server.close();
    }
  });

  it("reports offline when nothing listens", async () => {
    const state = await factorioConnector.query({
      host: "127.0.0.1",
      port: 1,
      queryPort: 1,
      timeoutMs: 200,
    });
    expect(state.online).toBe(false);
    expect(state.error).toMatch(/factorio_rcon_unreachable|connect/i);
  });

  it("probeFactorioRcon returns false on refused port", async () => {
    await expect(probeFactorioRcon("127.0.0.1", 1, 200)).resolves.toBe(false);
  });
});
