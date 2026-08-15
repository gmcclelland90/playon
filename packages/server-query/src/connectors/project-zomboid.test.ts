import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import { liveStateToPanelBody } from "@playon/shared";
import {
  RAKNET_MAGIC,
  RAKNET_UNCONNECTED_PING,
  RAKNET_UNCONNECTED_PONG,
  buildA2sInfoRequest,
  buildRakNetUnconnectedPing,
  encodeRakNetUnconnectedPong,
  liveStateFromA2s,
  liveStateFromPzPong,
  parseA2sInfo,
  parseRakNetUnconnectedPong,
  projectZomboidConnector,
  pzQueryPorts,
} from "./project-zomboid.js";

/**
 * Captured UNCONNECTED_PONG from a public Project Zomboid dedicated
 * (direct RakNet UDPPort, 2026-08-15). 33 bytes: id + pingTime + guid + magic.
 * Identifier is empty — no player counts. Not an encoder round-trip.
 */
const CAPTURED_PZ_PONG_HEX =
  "1c000001a00327d6da000659067e3e154e00ffff00fefefefefdfdfdfd12345678";

/**
 * Captured A2S_INFO (`I`) from a public Project Zomboid dedicated
 * (Steam-facing game port, 2026-08-15). Valve layout; players/maxPlayers
 * are the uint8 fields after appId. Not NZL. Host is not stored here.
 */
const CAPTURED_PZ_A2S_HEX =
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

describe("captured RakNet UNCONNECTED_PONG", () => {
  it("is a 33-byte empty-identifier pong with official magic", () => {
    const buf = Buffer.from(CAPTURED_PZ_PONG_HEX, "hex");
    expect(buf.length).toBe(33);
    expect(buf[0]).toBe(RAKNET_UNCONNECTED_PONG);
    expect(buf.subarray(17, 33).equals(RAKNET_MAGIC)).toBe(true);
    const { message, pingTime, serverGuid } = parseRakNetUnconnectedPong(buf);
    expect(message).toBe("");
    expect(pingTime).toBe(0x000001a00327d6dan);
    expect(serverGuid).toBe(0x000659067e3e154en);
  });

  it("does not invent players/maxPlayers from the empty identifier", () => {
    const { message } = parseRakNetUnconnectedPong(Buffer.from(CAPTURED_PZ_PONG_HEX, "hex"));
    const state = liveStateFromPzPong(message, 8);
    expect(state.online).toBe(true);
    expect(state.game).toBe("Project Zomboid");
    expect(state.players).toBeUndefined();
    expect(state.maxPlayers).toBeUndefined();
    expect(state.name).toBeUndefined();
    expect(liveStateToPanelBody(state)).toEqual({ online: true });
  });

  it("does not guess Bedrock PZ;name;players;max fields", () => {
    const state = liveStateFromPzPong("PZ;Lab Fixture;2;16;41.78.16;Muldraugh, KY", 1);
    expect(state.online).toBe(true);
    expect(state.players).toBeUndefined();
    expect(state.maxPlayers).toBeUndefined();
    expect(state.name).toBeUndefined();
    expect(state.extras?.raw).toBe("PZ;Lab Fixture;2;16;41.78.16;Muldraugh, KY");
  });

  it("rejects captured A2S bytes on the RakNet parser", () => {
    const a2s = Buffer.from(CAPTURED_PZ_A2S_HEX, "hex");
    expect(() => parseRakNetUnconnectedPong(a2s)).toThrow(/pz_a2s_not_raknet/);
  });

  it("rejects a short A2S header as not a pong", () => {
    const a2s = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.alloc(32, 0)]);
    expect(() => parseRakNetUnconnectedPong(a2s)).toThrow(/pz_a2s_not_raknet/);
  });

  it("encodes an empty identifier as the captured 33-byte layout", () => {
    const encoded = encodeRakNetUnconnectedPong({
      pingTime: 0x000001a00327d6dan,
      serverGuid: 0x000659067e3e154en,
      message: "",
    });
    expect(encoded.toString("hex")).toBe(CAPTURED_PZ_PONG_HEX);
  });

  it("builds a ping with magic and client GUID", () => {
    const ping = buildRakNetUnconnectedPing(1000, 7n);
    expect(ping[0]).toBe(RAKNET_UNCONNECTED_PING);
    expect(ping.subarray(9, 25).equals(RAKNET_MAGIC)).toBe(true);
    expect(ping.readBigUInt64BE(25)).toBe(7n);
  });
});

describe("captured Steam A2S_INFO", () => {
  it("parses the captured Valve I reply into live player counts", () => {
    const buf = Buffer.from(CAPTURED_PZ_A2S_HEX, "hex");
    expect(buf.subarray(0, 5).equals(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]))).toBe(true);
    const info = parseA2sInfo(buf);
    expect(info.name).toBe("This is how you died");
    expect(info.map).toBe("Muldraugh, KY");
    expect(info.folder).toBe("zomboid");
    expect(info.game).toBe("Project Zomboid");
    expect(info.players).toBe(64);
    expect(info.maxPlayers).toBe(80);
    expect(info.version).toBe("1.0.0.0");
    expect(info.passwordProtected).toBe(false);
    const state = liveStateFromA2s(info, 15);
    expect(state.online).toBe(true);
    expect(state.players).toBe(64);
    expect(state.maxPlayers).toBe(80);
    expect(liveStateToPanelBody(state)).toMatchObject({
      online: true,
      players: 64,
      maxPlayers: 80,
      serverName: "This is how you died",
      map: "Muldraugh, KY",
    });
  });

  it("rejects a RakNet pong as A2S_INFO", () => {
    expect(() => parseA2sInfo(Buffer.from(CAPTURED_PZ_PONG_HEX, "hex"))).toThrow(/a2s_/);
  });

  it("builds the documented A2S_INFO request", () => {
    const req = buildA2sInfoRequest();
    expect(req.toString("latin1")).toBe("\xff\xff\xff\xffTSource Engine Query\x00");
    const withChallenge = buildA2sInfoRequest(Buffer.from([1, 2, 3, 4]));
    expect(withChallenge.subarray(0, req.length).equals(req)).toBe(true);
    expect(withChallenge.subarray(req.length)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});

describe("projectZomboidConnector", () => {
  it("prefers gamePort then queryPort", () => {
    expect(pzQueryPorts({ host: "127.0.0.1", port: 9, gamePort: 16261, queryPort: 16262 })).toEqual([
      16261, 16262,
    ]);
    expect(pzQueryPorts({ host: "127.0.0.1", port: 16261 })).toEqual([16261]);
  });

  it("reports players from a fake Steam A2S responder on gamePort", async () => {
    const a2s = Buffer.from(CAPTURED_PZ_A2S_HEX, "hex");
    const { port, close } = await listenUdp((msg, rinfo, socket) => {
      if (msg[0] === 0xff && msg[4] === 0x54) {
        socket.send(a2s, rinfo.port, rinfo.address);
      }
    });
    try {
      const state = await projectZomboidConnector.query({
        host: "127.0.0.1",
        port,
        gamePort: port,
        timeoutMs: 1000,
      });
      expect(state.online).toBe(true);
      expect(state.players).toBe(64);
      expect(state.maxPlayers).toBe(80);
      expect(state.name).toBe("This is how you died");
      expect(state.map).toBe("Muldraugh, KY");
    } finally {
      await close();
    }
  });

  it("answers an A2S challenge then returns the captured INFO", async () => {
    const a2s = Buffer.from(CAPTURED_PZ_A2S_HEX, "hex");
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
      const state = await projectZomboidConnector.query({
        host: "127.0.0.1",
        port,
        gamePort: port,
        timeoutMs: 1000,
      });
      expect(state.online).toBe(true);
      expect(state.players).toBe(64);
      expect(state.maxPlayers).toBe(80);
    } finally {
      await close();
    }
  });

  it("falls back to captured RakNet pong (online, no invented counts)", async () => {
    const pong = Buffer.from(CAPTURED_PZ_PONG_HEX, "hex");
    const { port, close } = await listenUdp((msg, rinfo, socket) => {
      if (msg[0] === RAKNET_UNCONNECTED_PING) {
        socket.send(pong, rinfo.port, rinfo.address);
      }
    });
    try {
      const state = await projectZomboidConnector.query({
        host: "127.0.0.1",
        port,
        gamePort: port,
        timeoutMs: 800,
      });
      expect(state.online).toBe(true);
      expect(state.players).toBeUndefined();
      expect(state.maxPlayers).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("uses A2S on gamePort when queryPort only speaks RakNet", async () => {
    const a2s = Buffer.from(CAPTURED_PZ_A2S_HEX, "hex");
    const pong = Buffer.from(CAPTURED_PZ_PONG_HEX, "hex");
    const steam = await listenUdp((msg, rinfo, socket) => {
      if (msg[0] === 0xff && msg[4] === 0x54) {
        socket.send(a2s, rinfo.port, rinfo.address);
      }
    });
    const raknet = await listenUdp((msg, rinfo, socket) => {
      if (msg[0] === RAKNET_UNCONNECTED_PING) {
        socket.send(pong, rinfo.port, rinfo.address);
      }
    });
    try {
      const state = await projectZomboidConnector.query({
        host: "127.0.0.1",
        port: steam.port,
        gamePort: steam.port,
        queryPort: raknet.port,
        timeoutMs: 1500,
      });
      expect(state.online).toBe(true);
      expect(state.players).toBe(64);
      expect(state.maxPlayers).toBe(80);
    } finally {
      await steam.close();
      await raknet.close();
    }
  });

  it("reports offline when nothing answers", async () => {
    const state = await projectZomboidConnector.query({
      host: "127.0.0.1",
      port: 1,
      gamePort: 1,
      timeoutMs: 150,
    });
    expect(state.online).toBe(false);
    expect(state.error).toMatch(/pz_query_failed|pz_query_timeout|a2s_query_timeout|ECONNREFUSED|EPERM|EACCES/i);
  });
});
