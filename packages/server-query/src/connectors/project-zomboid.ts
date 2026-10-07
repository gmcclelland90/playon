import dgram from "node:dgram";
import { LiveServerStateSchema, offlineState, type LiveServerState } from "@playon/shared";
import type { Connector, QueryTarget } from "../types.js";
import {
  a2sInfoExchange,
  isA2sHeader,
  liveStateFromA2s as liveStateFromA2sGeneric,
  parseA2sInfo,
  uniqueA2sPorts,
  type ParsedA2sInfo,
} from "./a2s-info.js";

export {
  A2S_INFO_QUERY,
  a2sInfoExchange,
  buildA2sInfoRequest,
  isA2sChallenge,
  isA2sHeader,
  parseA2sInfo,
  type ParsedA2sInfo,
} from "./a2s-info.js";

/** Official RakNet offline-message magic (16 bytes). */
export const RAKNET_MAGIC = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

export const RAKNET_UNCONNECTED_PING = 0x01;
export const RAKNET_UNCONNECTED_PONG = 0x1c;

export function liveStateFromA2s(info: ParsedA2sInfo, queryMs: number): LiveServerState {
  return liveStateFromA2sGeneric(info, queryMs, "Project Zomboid");
}

export function buildRakNetUnconnectedPing(timeMs = Date.now(), clientGuid = 0x0a110n): Buffer {
  const buf = Buffer.alloc(1 + 8 + 16 + 8);
  buf.writeUInt8(RAKNET_UNCONNECTED_PING, 0);
  buf.writeBigUInt64BE(BigInt(timeMs) & 0xffffffffffffffffn, 1);
  RAKNET_MAGIC.copy(buf, 9);
  buf.writeBigUInt64BE(clientGuid, 25);
  return buf;
}

/**
 * Encode an UNCONNECTED_PONG. A real PZ dedicated omits the identifier
 * entirely (33 bytes). Non-empty messages use the RakNet uint16be length prefix.
 */
export function encodeRakNetUnconnectedPong(opts: {
  pingTime: bigint;
  serverGuid: bigint;
  message: string;
}): Buffer {
  const payload = Buffer.from(opts.message, "utf8");
  const buf = Buffer.alloc(payload.length === 0 ? 33 : 1 + 8 + 8 + 16 + 2 + payload.length);
  buf.writeUInt8(RAKNET_UNCONNECTED_PONG, 0);
  buf.writeBigUInt64BE(opts.pingTime, 1);
  buf.writeBigUInt64BE(opts.serverGuid, 9);
  RAKNET_MAGIC.copy(buf, 17);
  if (payload.length === 0) return buf;
  buf.writeUInt16BE(payload.length, 33);
  payload.copy(buf, 35);
  return buf;
}

export function parseRakNetUnconnectedPong(buf: Buffer): {
  pingTime: bigint;
  serverGuid: bigint;
  message: string;
} {
  if (isA2sHeader(buf)) {
    throw new Error("pz_a2s_not_raknet");
  }
  if (buf.length < 1 + 8 + 8 + 16) {
    throw new Error("pz_pong_truncated");
  }
  if (buf[0] !== RAKNET_UNCONNECTED_PONG) {
    throw new Error("pz_not_raknet_pong");
  }
  const pingTime = buf.readBigUInt64BE(1);
  const serverGuid = buf.readBigUInt64BE(9);
  const magic = buf.subarray(17, 33);
  if (!magic.equals(RAKNET_MAGIC)) {
    throw new Error("pz_bad_raknet_magic");
  }
  let message = "";
  if (buf.length >= 35) {
    const declared = buf.readUInt16BE(33);
    if (declared > 0 && 35 + declared <= buf.length) {
      message = buf.subarray(35, 35 + declared).toString("utf8");
    } else if (declared === 0) {
      message = "";
    } else {
      message = buf.subarray(33).toString("utf8");
    }
  }
  return { pingTime, serverGuid, message };
}

/**
 * Real PZ dedicated UNCONNECTED_PONG has an empty identifier (33-byte frame).
 * Do not guess Bedrock / `PZ;name;players;max` fields from whatever string
 * a host happens to attach.
 */
export function liveStateFromPzPong(message: string, queryMs: number): LiveServerState {
  const text = message.replace(/\0+$/g, "").trim();
  return LiveServerStateSchema.parse({
    online: true,
    queryMs,
    game: "Project Zomboid",
    ...(text ? { extras: { raw: text } } : {}),
  });
}

export function udpExchange(
  host: string,
  port: number,
  payload: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const done = (err: Error | null, msg?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(msg ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => done(new Error("pz_query_timeout")), timeoutMs);
    socket.once("error", (err) => done(err));
    socket.once("message", (msg) => done(null, msg));
    socket.send(payload, port, host, (err) => {
      if (err) done(err);
    });
  });
}

export function pzQueryPorts(target: QueryTarget): number[] {
  return uniqueA2sPorts(target.gamePort ?? target.port, target.queryPort);
}

export const projectZomboidConnector: Connector = {
  id: "project_zomboid",
  async query(target: QueryTarget): Promise<LiveServerState> {
    const started = Date.now();
    const timeoutMs = target.timeoutMs ?? 2500;
    const ports = pzQueryPorts(target);
    if (!ports.length) {
      return offlineState("pz_no_port", Date.now() - started);
    }
    const perTry = Math.max(400, Math.floor(timeoutMs / ports.length));

    // Steam/A2S on the Steam-facing port (GameQ Source / GameDig protocol-valve).
    // Try gamePort first, then queryPort. This is where player counts live.
    for (const port of ports) {
      try {
        const reply = await a2sInfoExchange(target.host, port, perTry);
        const info = parseA2sInfo(reply);
        return liveStateFromA2s(info, Date.now() - started);
      } catch {
        // next port / fall through to RakNet
      }
    }

    // Direct RakNet UDPPort answers UNCONNECTED_PING with an empty identifier.
    // Liveness only — do not invent players/maxPlayers from the pong.
    for (const port of ports) {
      try {
        const reply = await udpExchange(target.host, port, buildRakNetUnconnectedPing(), perTry);
        const { message } = parseRakNetUnconnectedPong(reply);
        return liveStateFromPzPong(message, Date.now() - started);
      } catch {
        // next port
      }
    }

    return offlineState("pz_query_failed", Date.now() - started);
  },
};
