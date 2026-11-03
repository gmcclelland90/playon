/**
 * Game-generic start-config identity guard (#1050, keeps #1016).
 *
 * A start script, batch file, or server.properties may fall back to *this*
 * server's own name, ports, and `servers/<id>` jail. That is what a live
 * Project Zomboid host does (`servername=${PLAYON_SERVER_NAME:-NewZombieLand3}`)
 * and what Paper, the lab Docker fixture, and Windows launchers do with their
 * own level name, port, and data dir.
 *
 * The same literal is refused when it belongs to a different server, or when
 * it is still a Project Zomboid catalog default (`servertest`, 16261, 16262)
 * that is not this server's identity. Comments and plain mentions are ignored.
 * Variable references (`$PLAYON_SERVER_NAME`, `%PLAYON_GAME_PORT%`) are not
 * literals.
 */
export type StartConfigSelf = {
  id: string;
  names: readonly string[];
  ports: readonly number[];
};

export type StartConfigPeer = {
  id: string;
  names: readonly string[];
  ports: readonly number[];
};

export type StartConfigCheck = {
  text: string;
  self: StartConfigSelf;
  peers?: readonly StartConfigPeer[];
};

/** Launch scripts and the Minecraft properties file Home reads before exec. */
export const START_CONFIG_REL_PATHS = [
  "game/start.sh",
  "game/start.bat",
  "game/start.ps1",
  "game/run.bat",
  "game/run.sh",
  "game/run.ps1",
  "game/start-server.sh",
  "game/server.properties",
] as const;

const NAME_KEYS = new Set([
  "playon_server_name",
  "server_name",
  "servername",
  "name",
  "level",
  "level-name",
  "level_name",
  "server-name",
]);

const GAME_PORT_KEYS = new Set([
  "playon_game_port",
  "server_port",
  "server-port",
  "query.port",
]);

const DIRECT_PORT_KEYS = new Set(["playon_direct_port", "udpport", "udp-port"]);

type PortSlot = "game" | "direct" | "other";
type LiteralHow = "fallback" | "assign" | "flag";

type NameHit = { value: string; how: LiteralHow; at: number };
type PortHit = { value: number; how: LiteralHow; slot: PortSlot; at: number };

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function codeText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#") && !/^rem\b/i.test(trimmed) && !trimmed.startsWith("::");
    })
    .join("\n");
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** A concrete name, not a `$var`, `%VAR%`, flag, or path. */
function nameLiteral(raw: string): string | null {
  const value = unquote(raw);
  if (value.length < 2 || value.length > 80) return null;
  if (/[$%{}]/.test(value)) return null;
  if (/^\d+$/.test(value)) return null;
  if (/^(true|false|yes|no|null)$/i.test(value)) return null;
  if (value.startsWith("-") || value.startsWith("/") || value.startsWith("\\")) return null;
  if (/^[A-Za-z]:[\\/]/.test(value)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.+-]*$/u.test(value)) return null;
  return value;
}

function portLiteral(raw: string): number | null {
  const value = unquote(raw);
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function portSlotForKey(key: string): PortSlot | null {
  const normalized = key.trim().toLowerCase();
  if (GAME_PORT_KEYS.has(normalized)) return "game";
  if (DIRECT_PORT_KEYS.has(normalized)) return "direct";
  if (normalized === "rcon.port" || normalized === "rcon_port" || normalized === "playon_rcon_port") {
    return "other";
  }
  return null;
}

function collectHits(code: string): { names: NameHit[]; ports: PortHit[] } {
  const names: NameHit[] = [];
  const ports: PortHit[] = [];

  const pushName = (raw: string, how: LiteralHow, at: number) => {
    const value = nameLiteral(raw);
    if (value) names.push({ value, how, at });
  };
  const pushPort = (raw: string, how: LiteralHow, slot: PortSlot, at: number) => {
    const value = portLiteral(raw);
    if (value != null) ports.push({ value, how, slot, at });
  };

  for (const match of code.matchAll(/\$\{([A-Za-z_][\w.-]*):-([^}]+)\}/g)) {
    const key = match[1] ?? "";
    const raw = match[2] ?? "";
    const at = match.index ?? 0;
    if (NAME_KEYS.has(key.toLowerCase())) pushName(raw, "fallback", at);
    const slot = portSlotForKey(key);
    if (slot) pushPort(raw, "fallback", slot, at);
  }

  for (const match of code.matchAll(
    /(?:^|[\s;])(?:export\s+|set\s+)?["']?([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'#;]+))/g,
  )) {
    const key = match[1] ?? "";
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    const at = match.index ?? 0;
    if (NAME_KEYS.has(key.toLowerCase())) pushName(raw, "assign", at);
    const slot = portSlotForKey(key);
    if (slot) pushPort(raw, "assign", slot, at);
  }

  for (const match of code.matchAll(/\$env:([A-Za-z_][\w]*)\s*=\s*['"]([^'"]+)['"]/gi)) {
    const key = match[1] ?? "";
    const raw = match[2] ?? "";
    const at = match.index ?? 0;
    if (NAME_KEYS.has(key.toLowerCase())) pushName(raw, "assign", at);
    const slot = portSlotForKey(key);
    if (slot) pushPort(raw, "assign", slot, at);
  }

  for (const match of code.matchAll(
    /(?:^|[\s"'=])(-servername|--server-name|--servername|--level-name|--world|\+server\.identity)(?:=|\s+)([^\s"'\\]+)/gi,
  )) {
    pushName(match[2] ?? "", "flag", match.index ?? 0);
  }

  for (const match of code.matchAll(
    /(?:^|[\s"'=])(-udpport|--udpport)(?:=|\s+)(\d{1,5})\b/gi,
  )) {
    pushPort(match[2] ?? "", "flag", "direct", match.index ?? 0);
  }
  for (const match of code.matchAll(
    /(?:^|[\s"'=])(--server-port|--port|-port|\/port)(?:=|\s+)(\d{1,5})\b/gi,
  )) {
    pushPort(match[2] ?? "", "flag", "game", match.index ?? 0);
  }
  for (const match of code.matchAll(/(?:^|[\s])-p\s+(\d{1,5}):(\d{1,5})\b/g)) {
    pushPort(match[1] ?? "", "flag", "game", match.index ?? 0);
  }

  names.sort((a, b) => a.at - b.at);
  ports.sort((a, b) => a.at - b.at);
  return { names, ports };
}

function ownsName(self: StartConfigSelf, literal: string): boolean {
  if (self.id && self.id === literal) return true;
  return self.names.some((name) => same(name, literal));
}

function peerNamed(peers: readonly StartConfigPeer[], literal: string): StartConfigPeer | undefined {
  return peers.find(
    (peer) =>
      peer.id === literal ||
      peer.names.some((name) => same(name, literal)),
  );
}

function nameProblem(
  hit: NameHit,
  self: StartConfigSelf,
  peers: readonly StartConfigPeer[],
): string | null {
  if (ownsName(self, hit.value)) return null;
  if (hit.value.toLowerCase() === "servertest") {
    return "start_config_hardcoded: start script defaults the server name";
  }
  const peer = peerNamed(peers, hit.value);
  if (!peer) return null;
  return `start_config_hardcoded: start script names ${hit.value}`;
}

function portProblem(
  hit: PortHit,
  self: StartConfigSelf,
  peers: readonly StartConfigPeer[],
): string | null {
  if (self.ports.includes(hit.value)) return null;
  if (hit.value === 16261 && hit.slot === "game") {
    return hit.how === "flag"
      ? "start_config_hardcoded: start script hardcodes -port 16261"
      : "start_config_hardcoded: start script defaults the game port";
  }
  if (hit.value === 16262 && hit.slot === "direct") {
    return hit.how === "flag"
      ? "start_config_hardcoded: start script hardcodes -udpport 16262"
      : "start_config_hardcoded: start script defaults the direct port";
  }
  if (peers.some((peer) => peer.ports.includes(hit.value))) {
    return `start_config_hardcoded: start script hardcodes port ${hit.value}`;
  }
  return null;
}

/**
 * Jail path of some other server. Linux (`/var/lib/playon/servers/<id>/home`)
 * and Windows (`C:\PlayOn\servers\<id>\home`) both count. This server's own
 * id, and `$VAR` / `%VAR%` segments, do not.
 */
export function foreignServerPathId(text: string, selfId: string): string | null {
  const code = codeText(text);
  for (const match of code.matchAll(/(?:^|[^A-Za-z0-9_])servers[\\/]+([^\\/\s"'`;]+)/gi)) {
    const id = match[1] ?? "";
    if (!id || /[$%{}]/.test(id)) continue;
    if (selfId && id === selfId) continue;
    return id;
  }
  return null;
}

/**
 * Null when every hardcoded name, port, and data dir in `text` is this
 * server's own (or is not another server's). Otherwise `start_config_hardcoded`.
 */
export function startConfigHardcodedProblem(input: StartConfigCheck): string | null {
  const code = codeText(input.text);
  const peers = input.peers ?? [];
  const { names, ports } = collectHits(code);
  for (const hit of names) {
    const problem = nameProblem(hit, input.self, peers);
    if (problem) return problem;
  }
  for (const hit of ports) {
    const problem = portProblem(hit, input.self, peers);
    if (problem) return problem;
  }
  const foreignId = foreignServerPathId(input.text, input.self.id);
  if (foreignId) {
    return `start_config_hardcoded: start script uses another server's data dir (${foreignId})`;
  }
  return null;
}
