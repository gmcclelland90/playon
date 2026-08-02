import net from "node:net";
import { offlineState, type LivePlayer, type LiveServerState } from "@playon/shared";
import { LiveServerStateSchema } from "@playon/shared";
import type { Connector, QueryTarget } from "../types.js";

/** Encode a Minecraft VarInt. */
export function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function writeString(value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  return Buffer.concat([writeVarInt(data.length), data]);
}

function writeUnsignedShort(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

function framePacket(packetId: number, payload: Buffer): Buffer {
  const id = writeVarInt(packetId);
  const body = Buffer.concat([id, payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } {
  let numRead = 0;
  let result = 0;
  let read: number;
  do {
    if (offset + numRead >= buf.length) throw new Error("varint_truncated");
    read = buf[offset + numRead]!;
    const value = read & 0x7f;
    result |= value << (7 * numRead);
    numRead++;
    if (numRead > 5) throw new Error("varint_too_big");
  } while ((read & 0x80) !== 0);
  return { value: result, size: numRead };
}

function motdToString(description: unknown): string | undefined {
  if (typeof description === "string") return description;
  if (!description || typeof description !== "object") return undefined;
  const obj = description as { text?: string; extra?: unknown[] };
  const parts: string[] = [];
  if (typeof obj.text === "string") parts.push(obj.text);
  if (Array.isArray(obj.extra)) {
    for (const part of obj.extra) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object" && typeof (part as { text?: string }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
  }
  const joined = parts.join("").trim();
  return joined || undefined;
}

type McStatusJson = {
  description?: unknown;
  version?: { name?: string; protocol?: number };
  players?: {
    online?: number;
    max?: number;
    sample?: Array<{ name?: string; id?: string }>;
  };
};

/** Parse Minecraft status JSON into LiveServerState (exported for tests). */
export function parseMinecraftStatusJson(json: unknown, queryMs: number): LiveServerState {
  const data = json as McStatusJson;
  const playerList: LivePlayer[] | undefined = data.players?.sample
    ?.map((p) => (p.name?.trim() ? { name: p.name.trim() } : null))
    .filter((p): p is LivePlayer => Boolean(p));

  return LiveServerStateSchema.parse({
    online: true,
    queryMs,
    game: "Minecraft",
    ...(motdToString(data.description) ? { name: motdToString(data.description) } : {}),
    ...(typeof data.players?.online === "number" ? { players: data.players.online } : {}),
    ...(typeof data.players?.max === "number" ? { maxPlayers: data.players.max } : {}),
    ...(playerList?.length ? { playerList } : {}),
    ...(data.version?.name ? { version: data.version.name } : {}),
  });
}

/** Byte reader that retains leftover TCP data across exact/VarInt reads. */
class SocketReader {
  private buffer: Buffer = Buffer.alloc(0);
  private waiters: Array<{
    needed: number;
    resolve: (buf: Buffer) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
      this.flush();
    });
    socket.on("error", (err) => {
      for (const w of this.waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      this.waiters = [];
    });
  }

  readExact(length: number, timeoutMs: number): Promise<Buffer> {
    if (length <= 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.waiters.push({ needed: length, resolve, reject, timer });
      this.flush();
    });
  }

  async readVarInt(timeoutMs: number): Promise<number> {
    let numRead = 0;
    let result = 0;
    for (;;) {
      const byteBuf = await this.readExact(1, timeoutMs);
      const read = byteBuf[0]!;
      result |= (read & 0x7f) << (7 * numRead);
      numRead++;
      if (numRead > 5) throw new Error("varint_too_big");
      if ((read & 0x80) === 0) return result;
    }
  }

  private flush(): void {
    while (this.waiters.length && this.buffer.length >= this.waiters[0]!.needed) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      const out = this.buffer.subarray(0, w.needed);
      this.buffer = Buffer.from(this.buffer.subarray(w.needed));
      w.resolve(Buffer.from(out));
    }
  }
}

export const minecraftStatusConnector: Connector = {
  id: "minecraft_status",
  async query(target: QueryTarget) {
    const started = Date.now();
    const timeoutMs = target.timeoutMs ?? 2500;
    const host = target.host;
    const port = target.gamePort ?? target.port;

    return new Promise<LiveServerState>((resolve) => {
      const socket = net.connect({ host, port });
      const reader = new SocketReader(socket);
      let settled = false;
      const finish = (state: LiveServerState) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(state);
      };

      const timer = setTimeout(() => finish(offlineState("timeout", Date.now() - started)), timeoutMs);

      socket.once("error", (err) => {
        clearTimeout(timer);
        finish(offlineState(err.message || "connect_failed", Date.now() - started));
      });

      socket.once("connect", () => {
        void (async () => {
          try {
            const handshake = framePacket(
              0x00,
              Buffer.concat([writeVarInt(760), writeString(host), writeUnsignedShort(port), writeVarInt(1)]),
            );
            const statusReq = framePacket(0x00, Buffer.alloc(0));
            socket.write(Buffer.concat([handshake, statusReq]));

            const packetLen = await reader.readVarInt(timeoutMs);
            const packet = await reader.readExact(packetLen, timeoutMs);
            let offset = 0;
            const packetId = readVarInt(packet, offset);
            offset += packetId.size;
            if (packetId.value !== 0x00) throw new Error("unexpected_packet");
            const strLen = readVarInt(packet, offset);
            offset += strLen.size;
            const jsonStr = packet.subarray(offset, offset + strLen.value).toString("utf8");
            const json = JSON.parse(jsonStr) as unknown;
            clearTimeout(timer);
            finish(parseMinecraftStatusJson(json, Date.now() - started));
          } catch (err) {
            clearTimeout(timer);
            finish(
              offlineState(err instanceof Error ? err.message : "status_failed", Date.now() - started),
            );
          }
        })();
      });
    });
  },
};
