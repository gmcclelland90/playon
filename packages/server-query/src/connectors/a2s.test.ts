import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import { offlineState } from "@playon/shared";
import { defaultRegistry } from "../registry.js";
import type { Connector } from "../types.js";
import { a2sQueryPorts, createA2sConnector } from "./a2s.js";

/**
 * Captured A2S_INFO (`I`) from a public Project Zomboid dedicated
 * (Steam-facing game port, 2026-08-15). Same fixture as PZ tests — Valve layout.
 */
const CAPTURED_A2S_HEX =
  "ffffffff49115468697320697320686f7720796f752064696564004d756c6472617567682c204b59007a6f6d626f69640050726f6a656374205a6f6d626f6964000000405000646c0001312e302e302e3000b1853f1438207224c740013b6d6f646465643b7076703b56455253494f4e3a34322e32300038a8010000000000";

function listenUdp(
  onMessage: (msg: Buffer, rinfo: dgram.RemoteInfo, socket: dgram.Socket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const socket = dgram.createSocket("udp4");
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.on("message", (msg, rinfo) => onMessage(msg, rinfo, socket));
    socket.bind(0, "127.0.0.1", () => {
      const addr = socket.address();
      resolve({
        port: addr.port,
        close: () =>
          new Promise((done) => {
            socket.close(() => done());
          }),
      });
    });
  });
}

const failingGamedig: Connector = {
  id: "a2s",
  query: async () => offlineState("Failed all 3 attempts", 12),
};

describe("a2s connector", () => {
  it("dedupes query/game/primary ports", () => {
    expect(a2sQueryPorts({ host: "127.0.0.1", port: 27015, queryPort: 27015, gamePort: 27015 })).toEqual([
      27015,
    ]);
    expect(a2sQueryPorts({ host: "127.0.0.1", port: 27016, queryPort: 27016, gamePort: 27015 })).toEqual([
      27016, 27015,
    ]);
  });

  it("keeps a GameDig hit without opening a native socket", async () => {
    const connector = createA2sConnector({
      gamedig: {
        id: "a2s",
        query: async () => ({ online: true, name: "gamedig-hit", queryMs: 4, game: "Source" }),
      },
    });
    const state = await connector.query({ host: "127.0.0.1", port: 1, timeoutMs: 50 });
    expect(state.online).toBe(true);
    expect(state.name).toBe("gamedig-hit");
  });

  it("falls back to native A2S after GameDig Failed all 3 attempts", async () => {
    const a2s = Buffer.from(CAPTURED_A2S_HEX, "hex");
    const { port, close } = await listenUdp((msg, rinfo, socket) => {
      if (msg[0] === 0xff && msg[4] === 0x54) {
        socket.send(a2s, rinfo.port, rinfo.address);
      }
    });
    try {
      const connector = createA2sConnector({ gamedig: failingGamedig });
      const state = await connector.query({
        host: "127.0.0.1",
        port,
        queryPort: port,
        timeoutMs: 1000,
      });
      expect(state.online).toBe(true);
      expect(state.players).toBe(64);
      expect(state.maxPlayers).toBe(80);
      expect(state.name).toBe("This is how you died");
    } finally {
      await close();
    }
  });

  it("answers an A2S challenge on the same UDP 5-tuple after GameDig miss", async () => {
    const a2s = Buffer.from(CAPTURED_A2S_HEX, "hex");
    const challenge = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x11, 0x22, 0x33, 0x44]);
    const { port, close } = await listenUdp((msg, rinfo, socket) => {
      if (msg.length === 25) {
        socket.send(challenge, rinfo.port, rinfo.address);
        return;
      }
      if (msg.length === 29 && msg.subarray(25).equals(Buffer.from([0x11, 0x22, 0x33, 0x44]))) {
        socket.send(a2s, rinfo.port, rinfo.address);
      }
    });
    try {
      const connector = createA2sConnector({ gamedig: failingGamedig });
      const state = await connector.query({
        host: "127.0.0.1",
        port,
        queryPort: port,
        timeoutMs: 1000,
      });
      expect(state.online).toBe(true);
      expect(state.players).toBe(64);
    } finally {
      await close();
    }
  });

  it("keeps the GameDig error when native A2S also misses", async () => {
    const connector = createA2sConnector({ gamedig: failingGamedig });
    const state = await connector.query({
      host: "127.0.0.1",
      port: 1,
      timeoutMs: 150,
    });
    expect(state.online).toBe(false);
    expect(state.error).toBe("Failed all 3 attempts");
  });

  it("is the registry a2s dialect", () => {
    expect(defaultRegistry.resolve({ queryDialect: "a2s" })?.id).toBe("a2s");
  });
});
