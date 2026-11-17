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
 * that is not this server's identity. Comments, echo lines, and plain mentions
 * are ignored. Variable references (`$PLAYON_SERVER_NAME`, `%PLAYON_GAME_PORT%`)
 * are not literals.
 *
 * Flags are read from shell words, not a single regex. Quotes (single, double,
 * or none), `ARGS+=(-servername "World")`, `-flag=value`, `/port N`, `/port:N`,
 * and the same shapes in `start.bat` / `start.ps1` all count.
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

/** CLI forms of a launch name. Short and long dashes, plus Rust `+server.identity`. */
const NAME_FLAGS = new Set([
  "-servername",
  "--server-name",
  "--servername",
  "--level-name",
  "--world",
  "-world",
  "-name",
  "--name",
  "--start-server",
  "+server.identity",
]);

const GAME_PORT_KEYS = new Set([
  "playon_game_port",
  "server_port",
  "server-port",
  "query.port",
]);

const DIRECT_PORT_KEYS = new Set(["playon_direct_port", "udpport", "udp-port"]);

const GAME_PORT_FLAGS = new Set(["-port", "--port", "--server-port", "/port"]);

const DIRECT_PORT_FLAGS = new Set(["-udpport", "--udpport", "-udp-port", "--udp-port"]);

/** Docker publish. The host side is the port another server could already own. */
const PUBLISH_FLAGS = new Set(["-p", "--publish"]);

type PortSlot = "game" | "direct" | "other";
type LiteralHow = "fallback" | "assign" | "flag";

type NameHit = { value: string; how: LiteralHow; at: number };
type PortHit = { value: number; how: LiteralHow; slot: PortSlot; at: number };

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("#") || trimmed.startsWith("::")) return true;
  if (/^rem\b/i.test(trimmed)) return true;
  if (/^@?echo\b/i.test(trimmed) && !/^@?echo\s+off\b/i.test(trimmed)) return true;
  if (/^(write-host|write-output)\b/i.test(trimmed)) return true;
  return false;
}

function codeText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isIgnorableLine(line))
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

type FlagKind = "name" | "game" | "direct" | "publish";

function flagKind(name: string): FlagKind | null {
  const key = name.toLowerCase();
  if (NAME_FLAGS.has(key)) return "name";
  if (GAME_PORT_FLAGS.has(key)) return "game";
  if (DIRECT_PORT_FLAGS.has(key)) return "direct";
  if (PUBLISH_FLAGS.has(key)) return "publish";
  return null;
}

/** Known identity flag, optionally with `=` / `/port:` glued on. */
function splitFlag(word: string): { name: string; inline: string | null } | null {
  if (!word || !/^[-+/]/.test(word)) return null;
  // `docker run -p25565:25565` glues the mapping onto -p.
  if (/^-p\d/i.test(word)) return { name: "-p", inline: word.slice(2) };
  let cut = -1;
  const eq = word.indexOf("=");
  if (eq > 0) cut = eq;
  if (word.startsWith("/")) {
    const colon = word.indexOf(":");
    if (colon > 0 && (cut < 0 || colon < cut)) cut = colon;
  }
  const name = cut > 0 ? word.slice(0, cut) : word;
  if (!flagKind(name)) return null;
  return { name, inline: cut > 0 ? word.slice(cut + 1) : null };
}

type ShellWord = { text: string; at: number };

const WORD_BREAK = new Set([" ", "\t", "\n", "\r", "(", ")", "[", "]", ",", ";", "|", "&", '"', "'"]);

function isWordBreak(ch: string): boolean {
  return WORD_BREAK.has(ch);
}

/** A quoted blob that is itself an argument list (`ARGS=-servername "World"`). */
function containsIdentityFlag(text: string): boolean {
  if (text.startsWith("${") || text.startsWith("$(")) return false;
  const parts = text.split(/[\s,;|()[\]]+/);
  for (const part of parts) {
    const head = part.replace(/^['"]+|['"]+$/g, "");
    if (!head) continue;
    if (splitFlag(head)) return true;
    const eq = head.match(/^[A-Za-z_][\w.-]*=(.+)$/);
    if (eq?.[1] && splitFlag(eq[1])) return true;
  }
  return false;
}

function tokenize(code: string): ShellWord[] {
  const words: ShellWord[] = [];
  const push = (text: string, at: number) => {
    if (!text) return;
    if (containsIdentityFlag(text) && /\s/.test(text)) {
      for (const inner of tokenize(text)) words.push({ text: inner.text, at: at + inner.at });
      return;
    }
    words.push({ text, at });
  };

  let i = 0;
  while (i < code.length) {
    const ch = code[i] ?? "";
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "#" && (i === 0 || isWordBreak(code[i - 1] ?? ""))) {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === "," || ch === ";" || ch === "|" || ch === "&") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      let buf = "";
      while (i < code.length && code[i] !== quote && code[i] !== "\n") {
        if (quote === '"' && code[i] === "\\" && (code[i + 1] === '"' || code[i + 1] === "\\")) {
          buf += code[i + 1] === '"' ? '"' : "\\";
          i += 2;
          continue;
        }
        buf += code[i] ?? "";
        i++;
      }
      if (code[i] === quote) i++;
      push(buf, start);
      continue;
    }
    const start = i;
    let buf = "";
    while (i < code.length && !isWordBreak(code[i] ?? "")) buf += code[i++] ?? "";
    push(buf, start);
  }
  return words;
}

function parseFallback(raw: string): { key: string; value: string } | null {
  const match = raw.trim().match(/^\$\{([A-Za-z_][\w.-]*):-([^}]*)\}$/);
  if (!match?.[1]) return null;
  return { key: match[1], value: match[2] ?? "" };
}

function publishHostPort(raw: string): string | null {
  const value = unquote(raw.trim());
  const match = value.match(/^(\d{1,5}):(\d{1,5})(?:\/(?:tcp|udp))?$/i);
  return match?.[1] ?? null;
}

function collectHits(code: string): { names: NameHit[]; ports: PortHit[] } {
  const names: NameHit[] = [];
  const ports: PortHit[] = [];
  const words = tokenize(code);

  const pushName = (raw: string, how: LiteralHow, at: number) => {
    const value = nameLiteral(raw);
    if (value) names.push({ value, how, at });
  };
  const pushPort = (raw: string, how: LiteralHow, slot: PortSlot, at: number) => {
    const value = portLiteral(raw);
    if (value != null) ports.push({ value, how, slot, at });
  };
  const applyKey = (key: string, raw: string, how: LiteralHow, at: number) => {
    const normalized = key.trim().toLowerCase();
    if (NAME_KEYS.has(normalized)) {
      pushName(raw, how, at);
      return;
    }
    const slot = portSlotForKey(normalized);
    if (slot) pushPort(raw, how, slot, at);
  };
  const recordKeyValue = (key: string, raw: string, how: LiteralHow, at: number) => {
    const fallback = parseFallback(raw);
    if (fallback) {
      applyKey(fallback.key, fallback.value, "fallback", at);
      return;
    }
    applyKey(key, raw, how, at);
  };

  /**
   * PowerShell `$args += '-servername'` / `$args += 'World'` stores the flag
   * and its value on two statements. A `$var` immediately after the flag is
   * the argument (and not a literal) unless it is that array append.
   */
  const arrayAppendLiteral = (index: number): { value: string; last: number } | null => {
    const name = words[index + 1];
    const op = words[index + 2];
    const value = words[index + 3];
    if (!name || !op || !value) return null;
    if (!/^\$[A-Za-z_][\w]*$/.test(name.text)) return null;
    if (op.text !== "+=" && op.text !== "=") return null;
    if (splitFlag(value.text)) return null;
    return { value: value.text, last: index + 3 };
  };

  const takeFlag = (word: string, index: number): number => {
    const parsed = splitFlag(word);
    if (!parsed) return -1;
    const kind = flagKind(parsed.name);
    if (!kind) return -1;
    let value = parsed.inline ?? "";
    let last = index;
    if (!value) {
      const appended = arrayAppendLiteral(index);
      const next = words[index + 1];
      if (appended && next && /^\$/.test(next.text)) {
        value = appended.value;
        last = appended.last;
      } else if (next && !splitFlag(next.text)) {
        value = next.text;
        last = index + 1;
      } else {
        return index;
      }
    }
    const at = words[index]?.at ?? 0;
    if (kind === "name") pushName(value, "flag", at);
    else if (kind === "publish") {
      const host = publishHostPort(value);
      if (host) pushPort(host, "flag", "game", at);
    } else {
      pushPort(value, "flag", kind, at);
    }
    return last;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i]?.text ?? "";
    const at = words[i]?.at ?? 0;

    const envInline = word.match(/^\$env:([A-Za-z_][\w]*)=(.*)$/i);
    if (envInline?.[1]) {
      let value = envInline[2] ?? "";
      let last = i;
      const next = words[i + 1];
      if (!value && next && !splitFlag(next.text)) {
        value = next.text;
        last = i + 1;
      }
      recordKeyValue(envInline[1], value, "assign", at);
      i = last;
      continue;
    }
    const envName = word.match(/^\$env:([A-Za-z_][\w]*)$/i);
    const envNext = words[i + 1];
    const envValue = words[i + 2];
    if (envName?.[1] && envNext?.text === "=" && envValue && !splitFlag(envValue.text)) {
      recordKeyValue(envName[1], envValue.text, "assign", at);
      i += 2;
      continue;
    }

    const assigned = word.match(/^([A-Za-z_][\w.-]*)=(.*)$/);
    if (assigned?.[1]) {
      const key = assigned[1];
      const inline = assigned[2] ?? "";
      if (!inline) {
        const next = words[i + 1];
        if (next && !splitFlag(next.text) && next.text !== "=") {
          recordKeyValue(key, next.text, "assign", at);
          i += 1;
          continue;
        }
      } else if (splitFlag(inline)) {
        const last = takeFlag(inline, i);
        i = last < 0 ? i : last;
        continue;
      } else {
        recordKeyValue(key, inline, "assign", at);
        continue;
      }
    }

    const bare = parseFallback(word);
    if (bare) {
      applyKey(bare.key, bare.value, "fallback", at);
      continue;
    }

    const last = takeFlag(word, i);
    if (last >= 0) i = last;
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
