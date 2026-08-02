import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { minecraftStatusConnector, parseMinecraftStatusJson, writeVarInt } from "./minecraft-status.js";

function framePacket(packetId: number, payload: Buffer): Buffer {
  const id = writeVarInt(packetId);
  const body = Buffer.concat([id, payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function writeString(value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  return Buffer.concat([writeVarInt(data.length), data]);
}

describe("minecraft status helpers", () => {
  it("encodes VarInts", () => {
    expect(writeVarInt(0).equals(Buffer.from([0]))).toBe(true);
    expect(writeVarInt(127).equals(Buffer.from([127]))).toBe(true);
    expect(writeVarInt(128).equals(Buffer.from([0x80, 0x01]))).toBe(true);
  });

  it("parses status JSON into LiveServerState", () => {
    const state = parseMinecraftStatusJson(
      {
        description: { text: "LAN Party" },
        version: { name: "1.21.1" },
        players: {
          online: 2,
          max: 20,
          sample: [{ name: "alice" }, { name: "bob" }],
        },
      },
      15,
    );
    expect(state.online).toBe(true);
    expect(state.name).toBe("LAN Party");
    expect(state.players).toBe(2);
    expect(state.maxPlayers).toBe(20);
    expect(state.playerList?.map((p) => p.name)).toEqual(["alice", "bob"]);
    expect(state.version).toBe("1.21.1");
    expect(state.queryMs).toBe(15);
  });
});

describe("minecraftStatusConnector", () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("parses a single-chunk status response without dropping bytes", async () => {
    const json = JSON.stringify({
      description: "Fixture",
      players: { online: 3, max: 20 },
      version: { name: "1.21.1", protocol: 760 },
    });
    const response = framePacket(0x00, writeString(json));

    server = net.createServer((socket) => {
      socket.once("data", () => {
        // One TCP write — regresses the old per-byte reader that discarded leftovers.
        socket.write(response);
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (!addr || typeof addr === "string") reject(new Error("no port"));
        else resolve(addr.port);
      });
    });

    const state = await minecraftStatusConnector.query({
      host: "127.0.0.1",
      port,
      gamePort: port,
      timeoutMs: 2000,
    });
    expect(state.online).toBe(true);
    expect(state.players).toBe(3);
    expect(state.maxPlayers).toBe(20);
    expect(state.name).toBe("Fixture");
  });
});
