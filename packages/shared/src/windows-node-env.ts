/**
 * Windows node Home wiring (`node.env.json` / leftover `node.env.cmd`).
 *
 * `start-node.cmd` used to `call node.env.cmd`. A LF-only `.cmd` hangs cmd.exe,
 * so the scheduled task never reaches node.exe and RestartCount never fires.
 * New installs exec node.exe directly; this module still writes leftover
 * `node.env.cmd` as CRLF and parses either line ending in JS.
 */

export const WINDOWS_NODE_ENV_JSON = "node.env.json";
export const WINDOWS_LOAD_ENV_CJS = "load-env.cjs";
export const WINDOWS_AGENT_STDOUT_LOG = "agent-stdout.log";
export const WINDOWS_AGENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export const WINDOWS_NODE_ENV_KEYS = [
  "PLAYON_API_URL",
  "PLAYON_NODE_TOKEN",
  "PLAYON_NODE_ID",
  "PLAYON_NODE_NAME",
  "PLAYON_DATA_ROOT",
  "PLAYON_RUNTIME",
  "PLAYON_INSTALL_ROOT",
] as const;

export type WindowsNodeEnvKey = (typeof WINDOWS_NODE_ENV_KEYS)[number];
export type WindowsNodeEnv = Partial<Record<WindowsNodeEnvKey, string>>;

/** True when every newline is CRLF (cmd.exe `call` requires this). */
export function windowsNodeEnvFileIsCrlf(contents: string): boolean {
  return !contents.replace(/\r\n/g, "").includes("\n");
}

export function parseWindowsNodeEnvCmd(contents: string): WindowsNodeEnv {
  const out: WindowsNodeEnv = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    const m = /^set\s+([A-Z0-9_]+)=(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if ((WINDOWS_NODE_ENV_KEYS as readonly string[]).includes(key)) {
      out[key as WindowsNodeEnvKey] = m[2];
    }
  }
  return out;
}

export function parseWindowsNodeEnvJson(contents: string): WindowsNodeEnv {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  const out: WindowsNodeEnv = {};
  for (const key of WINDOWS_NODE_ENV_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/** Always CRLF + trailing newline so leftover `call node.env.cmd` cannot hang. */
export function serializeWindowsNodeEnvCmd(vars: WindowsNodeEnv): string {
  const lines = WINDOWS_NODE_ENV_KEYS.filter((key) => vars[key] != null && vars[key] !== "").map(
    (key) => `set ${key}=${vars[key]}`,
  );
  return `${lines.join("\r\n")}\r\n`;
}

export function serializeWindowsNodeEnvJson(vars: WindowsNodeEnv): string {
  const body: Record<string, string> = {};
  for (const key of WINDOWS_NODE_ENV_KEYS) {
    const value = vars[key];
    if (value) body[key] = value;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Copy parsed PLAYON_* into `env` without clobbering values already set
 * (task / shell / tests win).
 */
export function applyWindowsNodeEnv(
  vars: WindowsNodeEnv,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];
  for (const key of WINDOWS_NODE_ENV_KEYS) {
    const value = vars[key];
    if (!value || env[key] != null) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Standalone CommonJS preload for `node --require load-env.cjs index.js`.
 * Must not import @playon/* — it runs against vintage agent trees too.
 */
export function windowsLoadEnvCjsSource(): string {
  return `"use strict";
/**
 * PlayOn Windows node preload (\`--require\`). Loads PLAYON_* from
 * node.env.json or node.env.cmd (LF or CRLF), then tees stdout/stderr
 * to a rotating agent-stdout.log. No cmd.exe, no shell redirect lock.
 */
var fs = require("fs");
var path = require("path");

var ENV_KEYS = [
  "PLAYON_API_URL",
  "PLAYON_NODE_TOKEN",
  "PLAYON_NODE_ID",
  "PLAYON_NODE_NAME",
  "PLAYON_DATA_ROOT",
  "PLAYON_RUNTIME",
  "PLAYON_INSTALL_ROOT",
];

function installRoot() {
  if (process.env.PLAYON_INSTALL_ROOT) return process.env.PLAYON_INSTALL_ROOT;
  return path.dirname(__filename);
}

function applyEnv(map) {
  for (var i = 0; i < ENV_KEYS.length; i++) {
    var key = ENV_KEYS[i];
    var value = map[key];
    if (typeof value === "string" && value && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function loadJson(root) {
  var p = path.join(root, "node.env.json");
  if (!fs.existsSync(p)) return;
  var parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  if (parsed && typeof parsed === "object") applyEnv(parsed);
}

function loadCmd(root) {
  var p = path.join(root, "node.env.cmd");
  if (!fs.existsSync(p)) return;
  var text = fs.readFileSync(p, "utf8");
  var map = {};
  var lines = text.split(/\\r?\\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = String(lines[i]).replace(/^\\uFEFF/, "").trim();
    var m = /^set\\s+([A-Z0-9_]+)=(.*)$/i.exec(line);
    if (m) map[m[1].toUpperCase()] = m[2];
  }
  applyEnv(map);
}

function attachLog(root) {
  var dataRoot = process.env.PLAYON_DATA_ROOT || path.join(root, "data");
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
  } catch (_e) {}
  var logPath = path.join(dataRoot, "agent-stdout.log");
  var maxBytes = 5 * 1024 * 1024;
  try {
    var st = fs.statSync(logPath);
    if (st.size >= maxBytes) {
      var bak = logPath + ".1";
      try {
        fs.unlinkSync(bak);
      } catch (_e2) {}
      try {
        fs.renameSync(logPath, bak);
      } catch (_e3) {}
    }
  } catch (_e4) {}
  var stream;
  try {
    stream = fs.createWriteStream(logPath, { flags: "a" });
  } catch (_e5) {
    return;
  }
  function tee(orig) {
    return function (chunk, enc, cb) {
      try {
        stream.write(chunk);
      } catch (_e6) {}
      return orig.call(this, chunk, enc, cb);
    };
  }
  process.stdout.write = tee(process.stdout.write);
  process.stderr.write = tee(process.stderr.write);
}

var root = installRoot();
try {
  loadJson(root);
} catch (_e7) {}
try {
  loadCmd(root);
} catch (_e8) {}
if (!process.env.PLAYON_INSTALL_ROOT) process.env.PLAYON_INSTALL_ROOT = root;
attachLog(root);
`;
}
