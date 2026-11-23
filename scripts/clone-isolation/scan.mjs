/**
 * Clone-isolation identity scan (#1016 / #1050).
 *
 * A game package must declare the identity Home rewrites per server: a server
 * name, every port, and a data directory. A launch literal is allowed when it
 * is this package's own fallback behind an env Home can set, or — for a
 * server's own start script — when the literal is that server's own name,
 * port, or jail. A literal that belongs to some other server is foreign and
 * cannot be waived.
 */
import fs from "node:fs";
import path from "node:path";

/** Live worlds a catalog package must never bake in. */
export const FOREIGN_SERVER_NAMES = ["NewZombieLand3", "NZLCloneFrontierRD"];

/** Ports that belong to the live NZL server, not to an unrelated package. */
export const FOREIGN_LIVE_PORTS = new Set([16261, 16262]);

export const WAIVABLE_KINDS = new Set(["inherited_port", "inherited_name", "inherited_path"]);

export const UNWAIVABLE_KINDS = new Set([
  "foreign_name",
  "foreign_port",
  "foreign_path",
  "identity_undeclared",
]);

const NAME_ENV_KEYS = new Set([
  "SERVER_NAME",
  "CS2_SERVERNAME",
  "NWN_SERVERNAME",
  "TM_SERVER_NAME",
  "VS_CFG_SERVER_NAME",
  "NAME",
  "TMOD_WORLDNAME",
  "SAVE_NAME",
]);

const PORT_ENV_KEYS =
  /(?:^|_)(?:PORT|GAMEPORT|QUERYPORT|LISTENPORT|CONNECT_PORT|SERVER_PORT)$/i;

const FOREIGN_NAME_SET = new Set(FOREIGN_SERVER_NAMES.map((name) => name.toLowerCase()));

function sameName(a, b) {
  return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function unquoteYaml(raw) {
  const value = String(raw ?? "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function topBlock(text, key) {
  const match = text.match(new RegExp(`^${key}:\\n((?:[ \\t].*\\n|\\n)*)`, "m"));
  return match?.[1] ?? "";
}

/** Subset of catalog metadata.yaml this check needs. Not a general YAML parser. */
export function parsePackageMetadata(text) {
  const name = text.match(/^name:\s*(\S+)\s*$/m)?.[1] ?? "";
  const gameLine = text.match(/^game:\s*(.+)\s*$/m)?.[1] ?? "";
  const game = unquoteYaml(gameLine);
  const containerSupport = text.match(/^containerSupport:\s*(\S+)\s*$/m)?.[1] ?? "none";
  const dockerDataMount = text.match(/^dockerDataMount:\s*(\S+)\s*$/m)?.[1] ?? "";
  const steamAppId = text.match(/^steamAppId:\s*(\d+)\s*$/m)?.[1] ?? "";
  const osBlock = topBlock(text, "os");
  const os = [...osBlock.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]);
  const portsBlock = topBlock(text, "ports");
  const ports = [];
  const portRe =
    /- name:\s*(\S+)\s*\n(?:[ \t]+#[^\n]*\n)*[ \t]+protocol:\s*(\S+)\s*\n(?:[ \t]+#[^\n]*\n)*[ \t]+default:\s*(\d+)/g;
  for (const match of portsBlock.matchAll(portRe)) {
    ports.push({
      name: match[1],
      protocol: match[2],
      port: Number(match[3]),
    });
  }
  const prefer = text.match(/preferStartScript:\s*(true|false)/)?.[1];
  const preferStartScript = prefer !== "false";
  const nativeBlock = topBlock(text, "native");
  const argsBlock = nativeBlock.match(/^ {2}args:\n((?: {4}- .*\n)*)/m)?.[1] ?? "";
  const nativeArgs = [...argsBlock.matchAll(/^ {4}- ["']?(.+?)["']?\s*$/gm)].map((m) => m[1]);
  const envBlock = topBlock(text, "dockerEnv");
  const dockerEnv = [];
  for (const line of envBlock.split("\n")) {
    const match = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (!match) continue;
    dockerEnv.push({ key: match[1], value: unquoteYaml(match[2]) });
  }
  const argsList = topBlock(text, "dockerArgs");
  const dockerArgs = [...argsList.matchAll(/^\s+-\s+["']?(.+?)["']?\s*$/gm)].map((m) => m[1]);
  return {
    name,
    game,
    os: os.length ? os : ["linux", "windows"],
    containerSupport,
    dockerDataMount: dockerDataMount || (containerSupport === "none" ? "" : "/data"),
    steamAppId,
    preferStartScript,
    nativeArgs,
    dockerEnv,
    dockerArgs,
    ports,
  };
}

const SCRIPT_NAMES = new Set(["start.sh", "start.bat", "start.ps1", "start.cmd"]);

function isCommentLine(line, fileName) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".bat") || lower.endsWith(".cmd")) {
    return /^(?:@?rem\b|::)/i.test(trimmed);
  }
  if (lower.endsWith(".xml")) return trimmed.startsWith("<!--");
  if (
    lower.endsWith(".sh") ||
    lower.endsWith(".ps1") ||
    lower.endsWith(".cfg") ||
    lower.endsWith(".ini") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".txt")
  ) {
    return trimmed.startsWith("#");
  }
  return false;
}

function isEchoLine(line) {
  return /^\s*(?:echo|Write-Error|Write-Host|Write-Output|Write-Warning)\b/i.test(line);
}

/** Own-identity fallback: the literal is used only when Home did not set the env. */
function isEnvDefaultLine(line) {
  if (/\b(?:exec|Start-Process)\b/i.test(line) || /\bstart\s+\/wait\b/i.test(line)) return false;
  return (
    /\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=][^}]+\}/.test(line) ||
    /^\s*if not defined\s+[A-Za-z0-9_]+\s+set\s+/i.test(line) ||
    /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\$\{/.test(line) ||
    /^\s*if\s*\(\s*-not\s+\$env:/i.test(line)
  );
}

function envHooksFromLine(line) {
  const hooks = [];
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*):[-=]([^}]+)\}/g;
  for (const match of line.matchAll(pattern)) {
    hooks.push({ env: match[1], literal: match[2].trim().replace(/^["']|["']$/g, "") });
  }
  const bat = line.match(/if not defined\s+([A-Za-z0-9_]+)\s+set\s+"?[A-Za-z0-9_]+=([^"\r\n]+)"?/i);
  if (bat) hooks.push({ env: bat[1], literal: bat[2].trim() });
  return hooks;
}

function isToolPath(value) {
  return /steamcmd|steamclient|steamapps|linux32|linux64|sdk32|sdk64/i.test(value);
}

function serverIdInPath(value) {
  const match = String(value).match(/servers[\\/]([^\\/"'\s]+)/i);
  return match?.[1] ?? null;
}

function finding(kind, file, line, message) {
  return { kind, file, line, message: `${file}:${line}: ${message}` };
}

function isPortFlag(flag) {
  const bare = String(flag).replace(/^[-+/]+/, "");
  if (/^(?:support|report)$/i.test(bare)) return false;
  return /port$/i.test(bare);
}

function considerPort(ctx, file, lineNo, port, where) {
  if (!isPortFlag(where)) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  if (ctx.steamIds.has(String(port))) return;
  const declared = ctx.declaredPorts.has(port);
  const owned = ctx.owner?.ports?.includes(port);
  if (ctx.role === "server") {
    if (owned) return;
    ctx.findings.push(
      finding(
        "foreign_port",
        file,
        lineNo,
        `port ${port} (${where}) is not this server's own port`,
      ),
    );
    return;
  }
  if (!declared && FOREIGN_LIVE_PORTS.has(port)) {
    ctx.findings.push(
      finding(
        "foreign_port",
        file,
        lineNo,
        `port ${port} (${where}) is the live NZL port and this package does not declare it`,
      ),
    );
    return;
  }
  ctx.findings.push(
    finding(
      "inherited_port",
      file,
      lineNo,
      `hardcodes port ${port} (${where}) with no per-server env; a clone that copies this file binds it`,
    ),
  );
}

function considerName(ctx, file, lineNo, raw, where) {
  const name = String(raw ?? "").trim().replace(/^["']|["']$/g, "").trim();
  if (!name || name.startsWith("$") || name.startsWith("%") || name.includes("${")) return;
  if (name.startsWith("-") || name.startsWith("/")) return;
  if (/[*?]/.test(name) || /\.(?:so|exe|dll|sh|bat|cfg|xml|json|txt)$/i.test(name)) return;
  if (ctx.role === "server") {
    if (sameName(name, ctx.owner?.serverName)) return;
    ctx.findings.push(
      finding(
        "foreign_name",
        file,
        lineNo,
        `launch name "${name}" (${where}) is not this server's own name "${ctx.owner?.serverName ?? ""}"`,
      ),
    );
    return;
  }
  if (FOREIGN_NAME_SET.has(name.toLowerCase())) {
    ctx.findings.push(
      finding(
        "foreign_name",
        file,
        lineNo,
        `hardcodes foreign server name "${name}" (${where}); a clone would launch as that live world`,
      ),
    );
    return;
  }
  ctx.findings.push(
    finding(
      "inherited_name",
      file,
      lineNo,
      `hardcodes server name "${name}" (${where}) with no per-server env; a clone inherits it`,
    ),
  );
}

function considerPath(ctx, file, lineNo, raw, where) {
  const value = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!value || value.startsWith("$") || value.startsWith("%") || value.includes("${")) return;
  if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return;
  if (isToolPath(value)) return;
  const serverId = serverIdInPath(value);
  if (serverId && !serverId.startsWith("$") && !serverId.startsWith("%")) {
    if (ctx.role === "server" && serverId === ctx.owner?.id) return;
    ctx.findings.push(
      finding(
        "foreign_path",
        file,
        lineNo,
        `data path ${value} (${where}) points at servers/${serverId}, not this server`,
      ),
    );
    return;
  }
  if (ctx.role === "server") {
    if (ctx.owner?.dataDir && value.replace(/[\\/]+$/, "") === ctx.owner.dataDir.replace(/[\\/]+$/, "")) {
      return;
    }
    ctx.findings.push(
      finding(
        "foreign_path",
        file,
        lineNo,
        `data path ${value} (${where}) is outside this server's own data dir`,
      ),
    );
    return;
  }
  ctx.findings.push(
    finding(
      "inherited_path",
      file,
      lineNo,
      `hardcodes data path ${value} (${where}); a clone inherits it instead of its own jail`,
    ),
  );
}

const PORT_FLAG =
  /(?:^|[\s"'=(])((?:[-+/]{1,2})?[A-Za-z0-9_.-]*port)\b["']?\s*(?:,|=|\s)\s*["']?(\d{2,5})\b/gi;
const JSON_PORT = /"([A-Za-z0-9_.-]*[Pp]ort)"\s*:\s*"?(\d{2,5})"?/g;
const NAME_FLAG =
  /(?:^|[\s])((?:--|\/|\+)?(?:server-?name|hostname|sv_name|server_name))\s+["']([^"']+)["']/gi;
const NAME_FLAG_BARE =
  /(?:^|[\s])(-name|-servername|--name|--server-name)\s+["']?([A-Za-z0-9][^"'\s]*)/gi;
const SERVER_NAME_WORD =
  /(?:^|[\s])(ServerName|server_name|hostname|sv_name)\s*[:=]?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][^\s"']*))/gi;
const JSON_NAME = /"(ServerName|server_name|hostname|sv_name)"\s*:\s*"([^"]+)"/gi;
const LAN_SERVER = /--lan-server=([^\s"']+)/gi;
const PATH_FLAG =
  /(?:^|[\s])(-cachedir|-world|--world|-saveName|--save-name|server_persistent_data_override_folder)\s*[:=]?\s*["']?([A-Za-z]:\\[^"'\s]+|\/[^"'\s]+)["']?/gi;

function inspectFallback(ctx, file, lineNo, hook) {
  const literal = hook.literal?.trim() ?? "";
  if (!literal) return;
  if (FOREIGN_NAME_SET.has(literal.toLowerCase())) {
    if (ctx.role === "server" && sameName(literal, ctx.owner?.serverName)) return;
    considerName(ctx, file, lineNo, literal, hook.env);
    return;
  }
  if (/^\d{2,5}$/.test(literal) && /port/i.test(hook.env)) {
    const port = Number(literal);
    if (ctx.role === "server") {
      if (ctx.owner?.ports?.includes(port)) return;
      considerPort(ctx, file, lineNo, port, hook.env);
      return;
    }
    if (ctx.declaredPorts.has(port)) return;
    if (FOREIGN_LIVE_PORTS.has(port)) considerPort(ctx, file, lineNo, port, hook.env);
  }
}

function scanLine(ctx, file, lineNo, line, opts = {}) {
  if (isCommentLine(line, file)) return;
  if (/\bfind\b/.test(line) && /-name\b/.test(line)) return;
  if (isEchoLine(line) && !/port|servername|hostname|sv_name/i.test(line)) return;
  if (isEnvDefaultLine(line)) {
    for (const hook of envHooksFromLine(line)) {
      ctx.hooks.push({ ...hook, file, line: lineNo });
      inspectFallback(ctx, file, lineNo, hook);
    }
    return;
  }
  for (const match of line.matchAll(PORT_FLAG)) considerPort(ctx, file, lineNo, Number(match[2]), match[1]);
  for (const match of line.matchAll(JSON_PORT)) considerPort(ctx, file, lineNo, Number(match[2]), match[1]);
  for (const match of line.matchAll(NAME_FLAG)) considerName(ctx, file, lineNo, match[2], match[1]);
  if (!opts.skipBareName) {
    for (const match of line.matchAll(NAME_FLAG_BARE)) considerName(ctx, file, lineNo, match[2], match[1]);
  }
  for (const match of line.matchAll(SERVER_NAME_WORD)) {
    considerName(ctx, file, lineNo, match[2] || match[3] || match[4], match[1]);
  }
  for (const match of line.matchAll(JSON_NAME)) considerName(ctx, file, lineNo, match[2], match[1]);
  for (const match of line.matchAll(LAN_SERVER)) considerName(ctx, file, lineNo, match[1], "--lan-server");
  if (/\bport\s*=\s*"\d/.test(line) && /\bname\s*=\s*"/.test(line)) {
    const port = line.match(/\bport\s*=\s*"(\d{2,5})"/i);
    const name = line.match(/\bname\s*=\s*"([^"]+)"/i);
    if (port) considerPort(ctx, file, lineNo, Number(port[1]), "port");
    if (name) considerName(ctx, file, lineNo, name[1], "name");
  }
  for (const match of line.matchAll(PATH_FLAG)) considerPath(ctx, file, lineNo, match[2], match[1]);
  const home = line.match(/\bPLAYON_HOME\s*=\s*["']?([^"'\s]+)/);
  if (home && !home[1].includes("$") && !home[1].includes("%")) {
    considerPath(ctx, file, lineNo, home[1], "PLAYON_HOME");
  }
}

function scanTokens(ctx, file, tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    const eq = token.match(/^(-?[A-Za-z][A-Za-z0-9_.]*[Pp]ort)=(\d{2,5})$/);
    if (eq) {
      considerPort(ctx, file, 1, Number(eq[2]), eq[1]);
      continue;
    }
    if (/(?:^|[+-])port$/i.test(token) || /port$/i.test(token.replace(/^[-+/]/, ""))) {
      const next = tokens[i + 1];
      if (next && /^\d{2,5}$/.test(next)) considerPort(ctx, file, 1, Number(next), token);
    }
    if (/^(?:[+-]hostname|[+-]sv_name|--server-name|-servername|-name)$/i.test(token)) {
      const next = tokens[i + 1];
      if (next) considerName(ctx, file, 1, next, token);
    }
    const lan = token.match(/^--lan-server=(.+)$/);
    if (lan) considerName(ctx, file, 1, lan[1], "--lan-server");
    if (/^(?:-world|--world)$/i.test(token)) {
      const next = tokens[i + 1];
      if (next) considerPath(ctx, file, 1, next, token);
    }
  }
}

function scanDockerEnv(ctx, entries) {
  for (const entry of entries) {
    const key = entry.key;
    if (PORT_ENV_KEYS.test(key) && /^\d{2,5}$/.test(entry.value)) {
      considerPort(ctx, "metadata.yaml", 1, Number(entry.value), `dockerEnv ${key}`);
    }
    if (NAME_ENV_KEYS.has(key) && entry.value && !/^(true|false|\d+)$/i.test(entry.value)) {
      considerName(ctx, "metadata.yaml", 1, entry.value, `dockerEnv ${key}`);
    }
  }
}

const SKIP_FILE = /(?:^|\/)(?:steam_appid\.txt|.*\.md)$/i;

function shouldScanFile(rel) {
  if (SKIP_FILE.test(rel)) return false;
  if (rel === "metadata.yaml") return false;
  return /\.(sh|bat|cmd|ps1|cfg|ini|xml|json|yml|yaml|txt)$/i.test(rel);
}

function collectHooks(text) {
  const hooks = [];
  for (const line of text.split(/\r?\n/)) {
    if (!isEnvDefaultLine(line) && !line.includes("PLAYON_") && !line.includes("${")) continue;
    hooks.push(...envHooksFromLine(line));
    for (const match of line.matchAll(/\b(PLAYON_[A-Z0-9_]+|VALHEIM_[A-Z0-9_]+)\b/g)) {
      hooks.push({ env: match[1], literal: "" });
    }
  }
  return hooks;
}

/**
 * @param {object} pkg package from loadPackageDir or an in-memory fixture
 * @param {{ role?: "package"|"server", owner?: { id?: string, serverName?: string, ports?: number[], dataDir?: string } }} [opts]
 */
export function scanPackage(pkg, opts = {}) {
  const meta = pkg.metadata;
  const role = opts.role ?? "package";
  const ctx = {
    role,
    owner: opts.owner ?? null,
    declaredPorts: new Set((meta?.ports ?? []).map((port) => port.port)),
    steamIds: new Set([meta?.steamAppId].filter(Boolean)),
    findings: [],
    hooks: [],
  };
  const scriptLaunch = ["start.sh", "start.bat", "start.ps1", "start.cmd"].some((name) =>
    Object.keys(pkg.files ?? {}).some((rel) => rel === name || rel.endsWith(`/${name}`) || rel.endsWith(`\\${name}`)),
  );
  if (meta && (!meta.preferStartScript || !scriptLaunch) && meta.nativeArgs?.length) {
    scanTokens(ctx, "metadata.yaml native.args", meta.nativeArgs);
  }
  if (meta?.dockerArgs?.length) scanTokens(ctx, "metadata.yaml dockerArgs", meta.dockerArgs);
  if (meta?.dockerEnv?.length) scanDockerEnv(ctx, meta.dockerEnv);

  for (const [rel, text] of Object.entries(pkg.files ?? {})) {
    const norm = rel.replace(/\\/g, "/");
    if (!shouldScanFile(norm)) continue;
    const lines = String(text).split(/\r?\n/);
    let findCont = false;
    lines.forEach((line, index) => {
      const inFind = findCont || /\bfind\b/.test(line);
      scanLine(ctx, norm, index + 1, line, { skipBareName: inFind });
      const cont = /\\\s*$/.test(line);
      findCont = inFind && cont;
    });
    if (SCRIPT_NAMES.has(path.posix.basename(norm))) ctx.hooks.push(...collectHooks(text));
  }

  const identity = describeIdentity(meta, ctx);
  if (role === "package" && (!meta?.ports || meta.ports.length === 0)) {
    ctx.findings.unshift(
      finding(
        "identity_undeclared",
        "metadata.yaml",
        1,
        "package declares no ports; Home cannot rewrite a game port per server",
      ),
    );
  }
  return { identity, findings: dedupeFindings(ctx.findings), hooks: ctx.hooks };
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const item of findings) {
    const key = `${item.kind}|${item.file}|${item.line}|${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function describeIdentity(meta, ctx) {
  const hookEnv = (pattern) => ctx.hooks.find((hook) => pattern.test(hook.env))?.env ?? null;
  const nameEnv = hookEnv(/NAME|HOSTNAME/i);
  const nameHook = ctx.hooks.find((hook) => /NAME|HOSTNAME/i.test(hook.env) && hook.literal);
  const portEnv = hookEnv(/PORT/i);
  return {
    serverName: {
      env: nameEnv,
      own: nameHook?.literal || null,
      rewritable: Boolean(nameEnv) || !ctx.findings.some((f) => f.kind === "inherited_name" || f.kind === "foreign_name"),
    },
    ports: (meta?.ports ?? []).map((port) => ({
      name: port.name,
      protocol: port.protocol,
      port: port.port,
      env: portEnv,
      rewritable: !ctx.findings.some(
        (f) =>
          (f.kind === "inherited_port" || f.kind === "foreign_port") &&
          f.message.includes(`port ${port.port}`),
      ),
    })),
    dataDir: {
      relative: meta?.dockerDataMount || "servers/<id>",
      env: hookEnv(/HOME|DIR|PATH/i) || (ctx.hooks.some((h) => h.env === "PLAYON_HOME") ? "PLAYON_HOME" : null),
      scope: meta?.dockerDataMount ? "docker-mount" : "per-server-jail",
      rewritable: !ctx.findings.some((f) => f.kind === "foreign_path" || f.kind === "inherited_path"),
    },
  };
}

/**
 * A server's own start script may name itself (#1050). The same literal on a
 * different server is foreign.
 */
export function scanServerScript({ serverId, serverName, ports, dataDir, filename, text }) {
  const pkg = {
    metadata: {
      name: serverId,
      ports: (ports ?? []).map((port, index) => ({
        name: index === 0 ? "game" : `port${index}`,
        protocol: "udp",
        port,
      })),
      preferStartScript: true,
      nativeArgs: [],
      dockerArgs: [],
      dockerEnv: [],
      os: ["linux", "windows"],
      containerSupport: "none",
    },
    files: { [filename || "start.sh"]: text },
  };
  return scanPackage(pkg, {
    role: "server",
    owner: { id: serverId, serverName, ports: ports ?? [], dataDir },
  });
}

export function loadAllowlist(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("allowlist must be a JSON object keyed by package name");
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry.justification !== "string" || !Array.isArray(entry.findings)) {
      throw new Error(`allowlist ${name} needs justification and findings`);
    }
    const justification = entry.justification.trim();
    if (justification.length < 40) {
      throw new Error(`allowlist ${name} justification is too short to explain the exception`);
    }
    for (const kind of entry.findings) {
      if (UNWAIVABLE_KINDS.has(kind)) {
        throw new Error(`allowlist ${name} cannot waive ${kind}; foreign identity is never allowed`);
      }
      if (!WAIVABLE_KINDS.has(kind)) {
        throw new Error(`allowlist ${name} has unknown finding kind ${kind}`);
      }
    }
  }
  return raw;
}

export function evaluatePackage(pkg, allowlist) {
  const scanned = scanPackage(pkg);
  const entry = allowlist?.[pkg.metadata?.name];
  const kept = [];
  const waived = [];
  for (const item of scanned.findings) {
    if (UNWAIVABLE_KINDS.has(item.kind) || !entry?.findings?.includes(item.kind)) {
      kept.push(item);
      continue;
    }
    waived.push(item);
  }
  const stale = [];
  if (entry) {
    const present = new Set(scanned.findings.map((item) => item.kind));
    for (const kind of entry.findings) {
      if (!present.has(kind)) stale.push(kind);
    }
  }
  return { ...scanned, findings: kept, waived, stale, allowlisted: Boolean(entry) };
}

export function loadPackageDir(dir) {
  const metaPath = path.join(dir, "metadata.yaml");
  if (!fs.existsSync(metaPath)) return null;
  const metadata = parsePackageMetadata(fs.readFileSync(metaPath, "utf8"));
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      if (rel === "metadata.yaml") continue;
      if (!shouldScanFile(rel) && !SKIP_FILE.test(rel)) continue;
      files[rel] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  if (!metadata.name) metadata.name = path.basename(dir);
  return { dir, metadata, files };
}

export function listPackages(root) {
  if (!root || !fs.existsSync(root)) return [];
  const packages = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const pkg = loadPackageDir(dir);
    if (pkg?.metadata?.name) packages.push(pkg);
  }
  packages.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return packages;
}

export function packageRunsOn(metadata, host) {
  const os = metadata.os?.length ? metadata.os : ["linux", "windows"];
  if (host === "linux") return os.includes("linux") || metadata.containerSupport === "full" || metadata.containerSupport === "partial";
  if (host === "windows") {
    return os.includes("windows") || metadata.containerSupport === "full" || metadata.containerSupport === "partial";
  }
  return true;
}

function refusalFor(item) {
  if (item.kind === "foreign_path" || item.kind === "inherited_path") {
    return `start_identity_foreign_home: ${item.message}`;
  }
  if (item.kind === "foreign_name" || item.kind === "inherited_name") {
    return `start_identity_collision: ${item.message}`;
  }
  if (item.kind === "foreign_port" || item.kind === "inherited_port") {
    return `start_port_collision: ${item.message}`;
  }
  return `start_config_missing: ${item.message}`;
}

function slug(name) {
  return String(name).replace(/^games\./, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

/** Shift declared ports so a clone cannot reuse the stand-in bind. */
export function clonePorts(ports, delta = 1000) {
  return ports.map((port) => {
    const next = port.port + delta;
    const shifted = next <= 65535 ? next : port.port - delta;
    return { ...port, port: shifted };
  });
}

/**
 * What a clone would do if it was created with the live server's start
 * settings copied in. Home's rewrite is modeled as "the script must actually
 * read a per-server env". A hardcoded literal still collides, so the clone is
 * refused instead of started. Allowlist entries do not make a collision safe.
 */
export function planClone(pkg) {
  const scanned = scanPackage(pkg);
  const id = slug(pkg.metadata.name || "package");
  const live = {
    id: `lab-live-${id}`,
    name: `lab-live-${id}`,
    ports: pkg.metadata.ports.map((port) => ({ ...port })),
    dataDir: `servers/lab-live-${id}/home`,
  };
  const clone = {
    id: `lab-clone-${id}`,
    name: `lab-clone-${id}`,
    ports: clonePorts(pkg.metadata.ports),
    dataDir: `servers/lab-clone-${id}/home`,
  };
  const hard = scanned.findings.find((item) =>
    ["inherited_port", "inherited_name", "inherited_path", "foreign_name", "foreign_port", "foreign_path", "identity_undeclared"].includes(
      item.kind,
    ),
  );
  if (hard) {
    return {
      action: "refuse",
      error: refusalFor(hard),
      live,
      clone,
      identity: scanned.identity,
      findings: scanned.findings,
    };
  }
  return {
    action: "isolate",
    error: null,
    live,
    clone,
    identity: scanned.identity,
    findings: [],
  };
}

export function formatStaticReport(results) {
  const lines = [];
  const failed = results.filter((result) => result.findings.length || result.stale.length);
  for (const result of failed) {
    lines.push(result.name);
    for (const item of result.findings) lines.push(`  ${item.kind}: ${item.message}`);
    for (const kind of result.stale) {
      lines.push(
        `  stale_allowlist: ${result.name} is waived for ${kind}, but that finding is gone; delete it from the allowlist`,
      );
    }
  }
  return lines.join("\n");
}
