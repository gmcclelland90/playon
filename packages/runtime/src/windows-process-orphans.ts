import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type WindowsProcessRow = {
  pid: number;
  executablePath: string;
  commandLine: string;
};

function normalizeWinPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Last jail folder (e.g. `playon-proc-*` / nanoid). CIM often reports the 8.3
 * short path (`C:\Users\RUNNER~1\...`) while Node used the long form
 * (`C:\Users\runner\...`) — prefix match fails, but the leaf is unique.
 * Short leaves (`game`, `abc`) are skipped so we never match a sibling folder.
 */
function uniqueJailLeaf(root: string): string | undefined {
  const leaf = root.split(/[/\\]/).filter(Boolean).pop();
  if (leaf && leaf.length >= 8 && /^[a-z0-9._-]+$/i.test(leaf)) return leaf.toLowerCase();
  return undefined;
}

/**
 * WQL LIKE shape for tests/docs only. Live listing must not pass this to
 * `Get-CimInstance -Filter` — that hung for 8s and returned no rows on GHA.
 */
export function windowsCimFilterForRoots(roots: readonly string[]): string | undefined {
  const clauses: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const leaf = uniqueJailLeaf(root);
    if (!leaf || seen.has(leaf)) continue;
    seen.add(leaf);
    const esc = leaf.replace(/[%_]/g, "[$&]");
    clauses.push(`CommandLine LIKE '%${esc}%'`);
    clauses.push(`ExecutablePath LIKE '%${esc}%'`);
  }
  return clauses.length ? clauses.join(" OR ") : undefined;
}

function pathMentionsUniqueLeaf(normalizedPath: string, root: string): boolean {
  const leaf = uniqueJailLeaf(root);
  if (!leaf) return false;
  return normalizedPath.includes(`/${leaf}/`) || normalizedPath.endsWith(`/${leaf}`);
}

/** `RUNNER~1` ↔ `runneradmin` for intermediate dirs only (not the unique jail leaf). */
function dot83Prefix(seg: string): string | null {
  const m = /^(.{1,6})~\d+$/i.exec(seg);
  return m ? m[1]!.toLowerCase() : null;
}

function intermediateSegMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const sa = dot83Prefix(a);
  const sb = dot83Prefix(b);
  if (sa && b.startsWith(sa)) return true;
  if (sb && a.startsWith(sb)) return true;
  return false;
}

function windowsPathContainsRootAllowing83(candidate: string, root: string): boolean {
  const a = candidate.split("/").filter(Boolean);
  const b = root.split("/").filter(Boolean);
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) {
    const last = i === b.length - 1;
    if (a[i] === b[i]) continue;
    if (last) return false;
    if (!intermediateSegMatches(a[i]!, b[i]!)) return false;
  }
  return true;
}

/** Reject drive-only / tiny roots so a bad cwd cannot tree-kill the host. */
export function isUsableWindowsRoot(root: string): boolean {
  const n = normalizeWinPath(root);
  if (n.length < 8) return false;
  if (/^[a-z]:\/?$/.test(n)) return false;
  return true;
}

export function windowsPathContainsRoot(candidate: string, root: string): boolean {
  const a = normalizeWinPath(candidate);
  const b = normalizeWinPath(root);
  if (!a || !b || !isUsableWindowsRoot(root)) return false;
  if (a === b || a.startsWith(`${b}/`)) return true;
  if (pathMentionsUniqueLeaf(a, root)) return true;
  return windowsPathContainsRootAllowing83(a, b);
}

export function windowsCommandLineMentionsRoot(commandLine: string, root: string): boolean {
  if (!isUsableWindowsRoot(root)) return false;
  const cmd = normalizeWinPath(commandLine);
  const r = normalizeWinPath(root);
  let from = 0;
  while (from <= cmd.length) {
    const i = cmd.indexOf(r, from);
    if (i < 0) break;
    const after = cmd[i + r.length];
    if (after === undefined || after === "/" || after === " " || after === '"' || after === "'") {
      return true;
    }
    from = i + 1;
  }
  if (pathMentionsUniqueLeaf(cmd, root)) return true;
  for (const token of commandLine.split(/\s+/)) {
    const cleaned = token.replace(/^"+|"+$/g, "");
    if (cleaned !== commandLine && windowsPathContainsRoot(cleaned, root)) return true;
  }
  return false;
}

/**
 * Windows PowerShell 5.1 (`powershell.exe`) writes UTF-16LE when stdout is
 * redirected. Decoding that as UTF-8 yields NULs so every pid parse fails and
 * `find()` / reclaim see no orphans.
 */
export function decodeWindowsConsoleOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le");
  }
  if (looksLikeUtf16Le(buf)) return buf.toString("utf16le");
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

function looksLikeUtf16Le(buf: Buffer): boolean {
  if (buf.length < 6) return false;
  const n = Math.min(buf.length, 64);
  let nulOdds = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < n; i += 2) {
    pairs += 1;
    if (buf[i + 1] === 0 && buf[i] !== 0 && buf[i]! < 0x80) nulOdds += 1;
  }
  return pairs >= 3 && nulOdds / pairs >= 0.7;
}

export function windowsRowMatchesRoots(row: WindowsProcessRow, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (row.executablePath && windowsPathContainsRoot(row.executablePath, root)) return true;
    if (row.commandLine && windowsCommandLineMentionsRoot(row.commandLine, root)) return true;
  }
  return false;
}

/** TSV from `Get-CimInstance Win32_Process`: pid, executablePath, commandLine. */
export function parseWindowsProcessListing(text: string): WindowsProcessRow[] {
  const out: WindowsProcessRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, "").trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const pid = Number(line.slice(0, tab).trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const rest = line.slice(tab + 1);
    const tab2 = rest.indexOf("\t");
    const executablePath = (tab2 < 0 ? rest : rest.slice(0, tab2)).trim();
    const commandLine = (tab2 < 0 ? "" : rest.slice(tab2 + 1)).trim();
    out.push({ pid, executablePath, commandLine });
  }
  return out;
}

export function pidsMatchingWindowsRoots(
  rows: readonly WindowsProcessRow[],
  roots: readonly string[],
  opts?: { excludePids?: Iterable<number>; selfPid?: number },
): number[] {
  const exclude = new Set(opts?.excludePids ?? []);
  const selfPid = opts?.selfPid ?? 0;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const row of rows) {
    if (row.pid === selfPid || exclude.has(row.pid) || seen.has(row.pid)) continue;
    if (!windowsRowMatchesRoots(row, roots)) continue;
    seen.add(row.pid);
    out.push(row.pid);
  }
  return out;
}

/** `wmic process get … /FORMAT:LIST` (UTF-16). Faster than CIM on GHA. */
export function parseWmicProcessList(text: string): WindowsProcessRow[] {
  const normalized = text
    .replace(/\0/g, "")
    .replace(/\r\r\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const out: WindowsProcessRow[] = [];
  let pid = 0;
  let executablePath = "";
  let commandLine = "";
  const flush = (): void => {
    if (Number.isInteger(pid) && pid > 0) {
      out.push({ pid, executablePath, commandLine });
    }
    pid = 0;
    executablePath = "";
    commandLine = "";
  };
  for (const raw of normalized.split("\n")) {
    const line = raw.trim();
    if (!line) {
      // WMIC LIST puts a blank line after every property; flush only once
      // ProcessId has been seen for this block.
      if (pid > 0) flush();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const val = line.slice(eq + 1);
    if (key === "ProcessId") pid = Number(val.trim());
    else if (key === "ExecutablePath") executablePath = val.trim();
    else if (key === "CommandLine") commandLine = val.trim();
  }
  flush();
  return out;
}

const GENERIC_WIN_IMAGES = new Set([
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "conhost.exe",
  "ping.exe",
  "java.exe",
  "javaw.exe",
  "explorer.exe",
  "svchost.exe",
]);

/** `tasklist /FO CSV /NH`: `"image.exe","pid","session","#","mem"` */
export function parseTasklistCsv(text: string): { pid: number; image: string }[] {
  const out: { pid: number; image: string }[] = [];
  for (const raw of text.replace(/\0/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^"([^"]+)"\s*,\s*"(\d+)"/);
    if (!m) continue;
    const pid = Number(m[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({ image: m[1]!, pid });
  }
  return out;
}

export function collectExeBasenames(root: string, maxFiles = 80): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && /\.exe$/i.test(e.name)) out.push(e.name);
    }
  };
  walk(root, 0);
  return out;
}

function listViaTasklistImages(roots: readonly string[]): number[] {
  const wanted = new Set<string>();
  for (const root of roots) {
    for (const name of collectExeBasenames(root)) {
      if (!GENERIC_WIN_IMAGES.has(name.toLowerCase())) wanted.add(name.toLowerCase());
    }
  }
  if (wanted.size === 0) return [];
  try {
    const buf = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
      encoding: "buffer",
      timeout: 5_000,
      windowsHide: true,
    });
    return parseTasklistCsv(decodeWindowsConsoleOutput(buf))
      .filter((r) => wanted.has(r.image.toLowerCase()))
      .map((r) => r.pid);
  } catch {
    return [];
  }
}

export function listWindowsProcessDebug(roots: readonly string[]): {
  exeNames: string[];
  tasklistPids: number[];
  matchingPids: number[];
  rowCount: number;
} {
  return {
    exeNames: roots.flatMap((r) => collectExeBasenames(r)),
    tasklistPids: listViaTasklistImages(roots),
    matchingPids: listWindowsPidsMatchingRoots(roots),
    rowCount: listViaTasklistImages(roots).length,
  };
}

export function listWindowsPidsMatchingRoots(
  roots: readonly string[],
  excludePids?: Set<number>,
): number[] {
  const exclude = new Set(excludePids ?? []);
  const selfPid = process.pid;
  const seen = new Set<number>();
  const out: number[] = [];
  // tasklist only on the hot path. PowerShell/CIM/wmic stay empty or take
  // seconds on windows-latest and pushed API unit files into vitest's
  // onTaskUpdate timeout after every assertion already passed (#952).
  for (const pid of listViaTasklistImages(roots)) {
    if (pid === selfPid || exclude.has(pid) || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

export function killWindowsPidTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform !== "win32") return false;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function killWindowsOrphansByRoots(
  roots: readonly string[],
  excludePids?: Set<number>,
): Promise<void> {
  if (roots.length === 0) return;
  const first = listWindowsPidsMatchingRoots(roots, excludePids);
  for (const pid of first) killWindowsPidTree(pid);
  if (first.length === 0) return;
  await new Promise((r) => setTimeout(r, 200));
  for (const pid of listWindowsPidsMatchingRoots(roots, excludePids)) {
    killWindowsPidTree(pid);
  }
}
