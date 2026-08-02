import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";

const TYPE_RESPONSE = 0;
const TYPE_COMMAND = 2;
const TYPE_AUTH = 3;

export interface RconEndpoint {
  host: string;
  port: number;
  /** Never include in panel / player payloads. */
  password: string;
}

export interface RconCommandResult {
  ok: true;
  body: string;
  requestId: number;
}

function readInt32LE(buf: Buffer, offset: number): number {
  return buf.readInt32LE(offset);
}

function packPacket(requestId: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const size = 4 + 4 + payload.length + 2; // id + type + body + 2 nulls
  const packet = Buffer.alloc(4 + size);
  packet.writeInt32LE(size, 0);
  packet.writeInt32LE(requestId, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  packet.writeUInt8(0, 12 + payload.length);
  packet.writeUInt8(0, 12 + payload.length + 1);
  return packet;
}

async function readPacket(socket: net.Socket, timeoutMs: number): Promise<{
  requestId: number;
  type: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("rcon_timeout"));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const size = readInt32LE(buf, 0);
      if (size < 10 || size > 4096) {
        cleanup();
        reject(new Error(`rcon_bad_packet_size: ${size}`));
        return;
      }
      if (buf.length < 4 + size) return;
      const requestId = readInt32LE(buf, 4);
      const type = readInt32LE(buf, 8);
      const body = buf.subarray(12, 4 + size - 2).toString("utf8");
      cleanup();
      resolve({ requestId, type, body });
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/** Low-level Minecraft RCON command against a live endpoint. */
export async function rconExec(
  endpoint: RconEndpoint,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<RconCommandResult> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
  socket.setTimeout(timeoutMs);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("rcon_connect_timeout")));
    });

    const authId = 1;
    socket.write(packPacket(authId, TYPE_AUTH, endpoint.password));
    const auth = await readPacket(socket, timeoutMs);
    if (auth.requestId === -1) {
      throw new Error("rcon_auth_failed");
    }

    const cmdId = 2;
    socket.write(packPacket(cmdId, TYPE_COMMAND, command));
    const response = await readPacket(socket, timeoutMs);
    // Some servers send an empty TYPE_RESPONSE ack; read again if needed.
    if (response.type === TYPE_RESPONSE && response.body === "" && response.requestId === cmdId) {
      const next = await readPacket(socket, timeoutMs).catch(() => null);
      if (next) {
        return { ok: true, body: next.body, requestId: next.requestId };
      }
    }
    return { ok: true, body: response.body, requestId: response.requestId };
  } finally {
    socket.destroy();
  }
}

export function generateRconPassword(): string {
  return randomBytes(12).toString("base64url");
}

export function rconConfigPath(serverDataPath: string): string {
  return path.join(serverDataPath, "rcon.json");
}

export function writeRconConfig(serverDataPath: string, endpoint: RconEndpoint): void {
  fs.mkdirSync(serverDataPath, { recursive: true });
  fs.writeFileSync(
    rconConfigPath(serverDataPath),
    JSON.stringify(
      {
        host: endpoint.host,
        port: endpoint.port,
        password: endpoint.password,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function readRconConfig(serverDataPath: string): RconEndpoint | null {
  const file = rconConfigPath(serverDataPath);
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RconEndpoint>;
      if (
        typeof parsed.host === "string" &&
        typeof parsed.port === "number" &&
        typeof parsed.password === "string" &&
        parsed.password
      ) {
        return { host: parsed.host, port: parsed.port, password: parsed.password };
      }
    } catch {
      // fall through to server.properties
    }
  }

  const propsPath = path.join(serverDataPath, "game", "server.properties");
  if (!fs.existsSync(propsPath)) return null;
  const text = fs.readFileSync(propsPath, "utf8");
  const password = text.match(/^rcon\.password=(.*)$/m)?.[1]?.trim();
  const portRaw = text.match(/^rcon\.port=(.*)$/m)?.[1]?.trim();
  const enabled = text.match(/^enable-rcon=(.*)$/m)?.[1]?.trim();
  if (!password || enabled === "false") return null;
  const port = portRaw ? Number(portRaw) : 25575;
  if (!Number.isFinite(port)) return null;
  return { host: "127.0.0.1", port, password };
}

/** Poll until RCON accepts auth+command or timeout. */
export async function waitForRcon(
  endpoint: RconEndpoint,
  opts: { timeoutMs?: number; intervalMs?: number; command?: string } = {},
): Promise<RconCommandResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const command = opts.command ?? "list";
  const deadline = Date.now() + timeoutMs;
  let lastError = "rcon_not_ready";
  while (Date.now() < deadline) {
    try {
      return await rconExec(endpoint, command, { timeoutMs: 5_000 });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`rcon_not_ready: ${lastError}`);
}
