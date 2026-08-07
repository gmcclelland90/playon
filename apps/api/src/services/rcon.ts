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

/** Normalize agent/RCON input (strip leading /, collapse whitespace). */
export function normalizeRconCommand(command: string): string {
  return String(command ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, " ");
}

/**
 * Minecraft often returns HTTP-200-style RCON success with an error body.
 * Detect command failures so agents stop retrying obsolete syntax.
 */
export function rconBodyIndicatesFailure(body: string): boolean {
  const text = String(body ?? "");
  return (
    /incorrect argument for command/i.test(text) ||
    /unknown or incomplete command/i.test(text) ||
    /unknown command/i.test(text) ||
    /<--\[HERE\]/.test(text) ||
    /no permission/i.test(text) ||
    /you do not have permission/i.test(text)
  );
}

/**
 * Legacy camelCase gamerules → modern snake_case registry ids (Java 1.21.11+ / 26.x).
 * Keys are lowercased without the minecraft: namespace.
 */
export const LEGACY_MINECRAFT_GAMERULES: Record<string, string> = {
  announceadvancements: "show_advancement_messages",
  commandblocksenabled: "command_blocks_work",
  command_modification_block_limit: "max_block_modifications",
  disableelytramovementcheck: "elytra_movement_check",
  disableplayermovementcheck: "player_movement_check",
  disableraids: "raids",
  dodaylightcycle: "advance_time",
  doentitydrops: "entity_drops",
  doimmediaterespawn: "immediate_respawn",
  doinsomnia: "spawn_phantoms",
  dolimitedcrafting: "limited_crafting",
  domobloot: "mob_drops",
  domobspawning: "spawn_mobs",
  dopatrolspawning: "spawn_patrols",
  dotiledrops: "block_drops",
  dotraderspawning: "spawn_wandering_traders",
  dovinesspread: "spread_vines",
  dowardenspawning: "spawn_wardens",
  doweathercycle: "advance_weather",
  keepinventory: "keep_inventory",
  maxcommandchainlength: "max_command_sequence_length",
  maxcommandforkcount: "max_command_forks",
  mobgriefing: "mob_griefing",
  naturalregeneration: "natural_health_regeneration",
  snowaccumulationheight: "max_snow_accumulation_height",
  spawnradius: "respawn_radius",
  spawnerblocksenabled: "spawner_blocks_work",
  // common agent typos / old docs
  daylightcycle: "advance_time",
  weathercycle: "advance_weather",
};

/** Rewrite known obsolete `gamerule …` commands to modern names. */
export function rewriteLegacyGameruleCommand(command: string): {
  command: string;
  rewrittenFrom?: string;
} {
  const normalized = normalizeRconCommand(command);
  const match = normalized.match(/^gamerule\s+(\S+)(\s+.*)?$/i);
  if (!match) return { command: normalized };
  const ruleToken = match[1] ?? "";
  const rest = match[2] ?? "";
  const key = ruleToken.replace(/^minecraft:/i, "").toLowerCase();
  const modern = LEGACY_MINECRAFT_GAMERULES[key];
  if (!modern || modern.toLowerCase() === key) return { command: normalized };
  return {
    command: `gamerule ${modern}${rest}`,
    rewrittenFrom: normalized,
  };
}

export interface RconSelfHealResult {
  serverId?: string;
  command: string;
  body: string;
  /** Present when a legacy command was rewritten before/after failure. */
  healedFrom?: string;
  healed?: boolean;
  error?: string;
  hint?: string;
}

/**
 * Run an RCON command with automatic rewrite of known legacy gamerules.
 * Returns error + hint when the (possibly healed) command still fails.
 */
export async function rconExecWithSelfHeal(
  endpoint: RconEndpoint,
  rawCommand: string,
  opts: { timeoutMs?: number } = {},
): Promise<RconSelfHealResult> {
  const rewritten = rewriteLegacyGameruleCommand(rawCommand);
  const command = rewritten.command;
  const result = await rconExec(endpoint, command, opts);
  if (!rconBodyIndicatesFailure(result.body)) {
    return {
      command,
      body: result.body,
      ...(rewritten.rewrittenFrom
        ? { healed: true, healedFrom: rewritten.rewrittenFrom }
        : {}),
    };
  }

  return {
    error: "rcon_command_failed",
    command,
    body: result.body,
    ...(rewritten.rewrittenFrom
      ? { healed: true, healedFrom: rewritten.rewrittenFrom }
      : {}),
    hint: rewritten.rewrittenFrom
      ? "Legacy gamerule was rewritten but still failed. Read the body, try one different approach, then explain — do not spam the same command."
      : "Command syntax rejected. Prefer modern snake_case gamerules on Java 26.x (advance_time, keep_inventory). Diagnose once, try one alternate, then stop.",
  };
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
      // fall through to discovery
    }
  }

  return (
    discoverMcRconFromProperties(serverDataPath) ??
    discoverSourceRconFromTree(serverDataPath)
  );
}

/** Minecraft Java `server.properties` RCON keys. */
export function discoverMcRconFromProperties(serverDataPath: string): RconEndpoint | null {
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

/** Parse Source-style RCON keys from ini/cfg text (PZ, TF2, etc.). */
export function parseSourceRconText(
  text: string,
  defaults: { port: number } = { port: 27015 },
): { port: number; password: string } | null {
  const iniPass = text.match(/^\s*RCONPassword\s*=\s*(.*)$/im)?.[1]?.trim();
  const iniPort = text.match(/^\s*RCONPort\s*=\s*(\d+)\s*$/im)?.[1]?.trim();
  const cfgPass = text.match(/^\s*rcon_password\s+"?([^"\r\n]+)"?\s*$/im)?.[1]?.trim();
  const cfgPort = text.match(/^\s*rcon_port\s+(\d+)\s*$/im)?.[1]?.trim();
  const password = (iniPass || cfgPass || "").trim();
  if (!password) return null;
  const portRaw = iniPort || cfgPort;
  const port = portRaw ? Number(portRaw) : defaults.port;
  if (!Number.isFinite(port)) return null;
  return { port, password };
}

/**
 * Best-effort scan under server data for Source RCON credentials.
 * Caps walk depth/file count so detail() stays cheap.
 */
export function discoverSourceRconFromTree(serverDataPath: string): RconEndpoint | null {
  const roots = [serverDataPath, path.join(serverDataPath, "game")].filter((p) =>
    fs.existsSync(p),
  );
  const files: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (files.length >= 40 || depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (files.length >= 40) return;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "steamapps") {
          continue;
        }
        visit(abs, depth + 1);
      } else if (ent.isFile() && /\.(ini|cfg)$/i.test(ent.name)) {
        files.push(abs);
      }
    }
  };
  for (const root of roots) visit(root, 0);

  for (const file of files) {
    try {
      const parsed = parseSourceRconText(fs.readFileSync(file, "utf8"));
      if (parsed) return { host: "127.0.0.1", ...parsed };
    } catch {
      // skip unreadable
    }
  }
  return null;
}

/** Patch ini text that already mentions RCON keys; returns null when unchanged/unrelated. */
export function patchSourceRconIniText(
  text: string,
  endpoint: RconEndpoint,
): string | null {
  if (!/RCONPassword\s*=/i.test(text) && !/RCONPort\s*=/i.test(text)) return null;
  let next = text;
  if (/^\s*RCONPassword\s*=/im.test(next)) {
    next = next.replace(/^\s*RCONPassword\s*=.*$/im, `RCONPassword=${endpoint.password}`);
  } else {
    next += `\nRCONPassword=${endpoint.password}\n`;
  }
  if (/^\s*RCONPort\s*=/im.test(next)) {
    next = next.replace(/^\s*RCONPort\s*=.*$/im, `RCONPort=${endpoint.port}`);
  } else {
    next += `RCONPort=${endpoint.port}\n`;
  }
  return next === text ? null : next;
}

/** Patch Source server.cfg-style text; returns null when unchanged. */
export function patchSourceRconCfgText(
  text: string,
  endpoint: RconEndpoint,
): string | null {
  let next = text;
  if (/^\s*rcon_password\s+/im.test(next)) {
    next = next.replace(/^\s*rcon_password\s+.+$/im, `rcon_password "${endpoint.password}"`);
  } else if (/rcon_password/i.test(next) || /rcon_port/i.test(next)) {
    next += `\nrcon_password "${endpoint.password}"\n`;
  } else {
    return null;
  }
  return next === text ? null : next;
}

/** Best-effort write-back of RCON password/port into a discovered ini/cfg. */
export function patchSourceRconConfigFiles(
  serverDataPath: string,
  endpoint: RconEndpoint,
): boolean {
  const roots = [serverDataPath, path.join(serverDataPath, "game")].filter((p) =>
    fs.existsSync(p),
  );
  let patched = false;
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "steamapps") {
          continue;
        }
        visit(abs, depth + 1);
      } else if (ent.isFile() && /\.ini$/i.test(ent.name)) {
        try {
          const text = fs.readFileSync(abs, "utf8");
          const next = patchSourceRconIniText(text, endpoint);
          if (next == null) continue;
          fs.writeFileSync(abs, next, "utf8");
          patched = true;
        } catch {
          // skip
        }
      } else if (ent.isFile() && /(^|\/)server\.cfg$/i.test(ent.name.replace(/\\/g, "/"))) {
        try {
          const text = fs.readFileSync(abs, "utf8");
          const next = patchSourceRconCfgText(text, endpoint);
          if (next == null) continue;
          fs.writeFileSync(abs, next, "utf8");
          patched = true;
        } catch {
          // skip
        }
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return patched;
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
