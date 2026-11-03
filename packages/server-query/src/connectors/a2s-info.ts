import dgram from "node:dgram";
import { LiveServerStateSchema, type LiveServerState } from "@playon/shared";

/** Valve A2S_INFO request (`FF FF FF FF` + `TSource Engine Query\0`). */
export const A2S_INFO_QUERY = Buffer.from("\xff\xff\xff\xffTSource Engine Query\x00", "latin1");

export type ParsedA2sInfo = {
  name?: string;
  map?: string;
  folder?: string;
  game?: string;
  players: number;
  maxPlayers: number;
  bots?: number;
  version?: string;
  passwordProtected?: boolean;
  extras?: Record<string, unknown>;
};

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isA2sHeader(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xff && buf[2] === 0xff && buf[3] === 0xff;
}

export function isA2sChallenge(buf: Buffer): boolean {
  return isA2sHeader(buf) && buf.length >= 9 && buf[4] === 0x41;
}

export function buildA2sInfoRequest(challenge?: Buffer): Buffer {
  if (!challenge || challenge.length !== 4) return Buffer.from(A2S_INFO_QUERY);
  return Buffer.concat([A2S_INFO_QUERY, challenge]);
}

function readCString(buf: Buffer, offset: number): { value: string; next: number } {
  if (offset >= buf.length) throw new Error("a2s_truncated");
  const end = buf.indexOf(0, offset);
  if (end < 0) throw new Error("a2s_truncated");
  return { value: buf.subarray(offset, end).toString("utf8"), next: end + 1 };
}

/**
 * Parse a Source A2S_INFO (`I`) reply. Challenge (`A`) and non-info types throw.
 * Player counts are the Valve uint8 fields — not guessed from RakNet identifiers.
 */
export function parseA2sInfo(buf: Buffer): ParsedA2sInfo {
  if (!isA2sHeader(buf) || buf.length < 6) throw new Error("a2s_truncated");
  if (buf[4] === 0x41) throw new Error("a2s_challenge");
  if (buf[4] !== 0x49) throw new Error("a2s_not_info");
  let i = 5;
  const protocol = buf[i++]!;
  const name = readCString(buf, i);
  i = name.next;
  const map = readCString(buf, i);
  i = map.next;
  const folder = readCString(buf, i);
  i = folder.next;
  const game = readCString(buf, i);
  i = game.next;
  if (i + 8 > buf.length) throw new Error("a2s_truncated");
  const appId = buf.readUInt16LE(i);
  i += 2;
  const players = buf[i++]!;
  const maxPlayers = buf[i++]!;
  const bots = buf[i++]!;
  const serverType = String.fromCharCode(buf[i++]!);
  const environment = String.fromCharCode(buf[i++]!);
  const visibility = buf[i++]!;
  const vac = buf[i++]!;
  let version = "";
  if (i < buf.length) {
    const ver = readCString(buf, i);
    version = ver.value;
    i = ver.next;
  }
  return {
    ...(name.value ? { name: name.value } : {}),
    ...(map.value ? { map: map.value } : {}),
    ...(folder.value ? { folder: folder.value } : {}),
    ...(game.value ? { game: game.value } : {}),
    players,
    maxPlayers,
    bots,
    ...(version ? { version } : {}),
    passwordProtected: visibility === 1,
    extras: { protocol, folder: folder.value, appId, bots, serverType, environment, vac: vac === 1 },
  };
}

export function liveStateFromA2s(
  info: ParsedA2sInfo,
  queryMs: number,
  defaultGame = "Source",
): LiveServerState {
  return LiveServerStateSchema.parse({
    online: true,
    queryMs,
    game: info.game || defaultGame,
    ...(info.name ? { name: info.name } : {}),
    ...(isNonNegInt(info.players) ? { players: info.players } : {}),
    ...(isNonNegInt(info.maxPlayers) ? { maxPlayers: info.maxPlayers } : {}),
    ...(info.version ? { version: info.version } : {}),
    ...(info.map ? { map: info.map } : {}),
    ...(info.passwordProtected !== undefined ? { passwordProtected: info.passwordProtected } : {}),
    ...(info.extras ? { extras: info.extras } : {}),
  });
}

/** Keep the socket open so an A2S challenge can be answered on the same 5-tuple. */
export function a2sInfoExchange(host: string, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    let challenged = false;
    const done = (err: Error | null, msg?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(msg ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => done(new Error("a2s_query_timeout")), timeoutMs);
    socket.once("error", (err) => done(err));
    socket.on("message", (msg) => {
      if (isA2sChallenge(msg) && !challenged) {
        challenged = true;
        socket.send(buildA2sInfoRequest(msg.subarray(5, 9)), port, host, (err) => {
          if (err) done(err);
        });
        return;
      }
      done(null, msg);
    });
    socket.send(buildA2sInfoRequest(), port, host, (err) => {
      if (err) done(err);
    });
  });
}

export function uniqueA2sPorts(...ports: Array<number | undefined>): number[] {
  const out: number[] = [];
  for (const p of ports) {
    if (typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535 && !out.includes(p)) {
      out.push(p);
    }
  }
  return out;
}
