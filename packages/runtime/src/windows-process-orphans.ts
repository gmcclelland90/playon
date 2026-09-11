import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function expandWindowsPath(p: string): string {
  if (process.platform !== "win32" || !p) return p;
  try {
    return fs.realpathSync.native(p);
  } catch {
    const cut = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    if (cut <= 2) return p;
    try {
      return `${fs.realpathSync.native(p.slice(0, cut))}${p.slice(cut)}`;
    } catch {
      return p;
    }
  }
}

function expandWindowsCommandLine(cmd: string): string {
  if (process.platform !== "win32" || !cmd) return cmd;
  return cmd.replace(/[A-Za-z]:\\[^"'|\r\n]+/g, (m) => {
    const trimmed = m.replace(/[.,;]+$/, "");
    return expandWindowsPath(trimmed) + m.slice(trimmed.length);
  });
}

function expandWindowsProcessRow(row: WindowsProcessRow): WindowsProcessRow {
  return {
    pid: row.pid,
    executablePath: expandWindowsPath(row.executablePath),
    commandLine: expandWindowsCommandLine(row.commandLine),
  };
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

function listViaWmic(): WindowsProcessRow[] {
  try {
    const buf = execFileSync(
      "wmic.exe",
      ["process", "get", "ProcessId,ExecutablePath,CommandLine", "/FORMAT:LIST"],
      { encoding: "buffer", timeout: 2_000, windowsHide: true },
    );
    return parseWmicProcessList(decodeWindowsConsoleOutput(buf)).map(expandWindowsProcessRow);
  } catch {
    return [];
  }
}

/**
 * Get-Process paths first (works when CIM is unavailable). Then cmd.exe
 * command lines via CIM/WMI, each in try/catch so a CIM failure cannot
 * wipe the path list. GHA windows-latest has returned empty CIM/wmic.
 */
const LIST_CMD_AND_PATHS_PS1 = [
  "$ErrorActionPreference = 'Continue'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "Get-Process -ErrorAction SilentlyContinue | ForEach-Object {",
  "  $path = $null",
  "  try { $path = $_.Path } catch {}",
  "  if ($path) { Write-Output ('{0}{1}{2}{1}' -f $_.Id, [char]9, $path) }",
  "}",
  "try {",
  "  Get-CimInstance -ClassName Win32_Process -Filter \"Name='cmd.exe'\" -ErrorAction SilentlyContinue | ForEach-Object {",
  "    $cmd = ([string]$_.CommandLine) -replace '[\\t\\r\\n]',' '",
  "    Write-Output ('{0}{1}{2}{1}{3}' -f $_.ProcessId, [char]9, ([string]$_.ExecutablePath), $cmd)",
  "  }",
  "} catch {}",
].join("\n");

function runPowerShellScript(script: string, timeoutMs: number): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-wps-"));
  const file = path.join(dir, "list.ps1");
  try {
    fs.writeFileSync(file, `\uFEFF${script}`, "utf8");
    try {
      return execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { encoding: "buffer", timeout: timeoutMs, windowsHide: true },
      );
    } catch (err) {
      const stdout = (err as { stdout?: Buffer }).stdout;
      return stdout && stdout.length > 0 ? stdout : Buffer.alloc(0);
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function listViaCmdAndPaths(): WindowsProcessRow[] {
  const buf = runPowerShellScript(LIST_CMD_AND_PATHS_PS1, 5_000);
  if (buf.length === 0) return [];
  return parseWindowsProcessListing(decodeWindowsConsoleOutput(buf)).map(expandWindowsProcessRow);
}

function mergeProcessRows(chunks: WindowsProcessRow[][]): WindowsProcessRow[] {
  const byPid = new Map<number, WindowsProcessRow>();
  for (const rows of chunks) {
    for (const row of rows) {
      const prev = byPid.get(row.pid);
      if (!prev) {
        byPid.set(row.pid, row);
        continue;
      }
      if (!prev.commandLine && row.commandLine) byPid.set(row.pid, row);
    }
  }
  return [...byPid.values()];
}

function listWindowsProcessRows(_roots: readonly string[] = []): WindowsProcessRow[] {
  if (process.platform !== "win32") return [];
  return mergeProcessRows([listViaWmic(), listViaCmdAndPaths()]);
}

export function listWindowsProcessDebug(roots: readonly string[]): {
  rowCount: number;
  matchingPids: number[];
  cmdHints: string[];
} {
  const rows = listWindowsProcessRows(roots);
  return {
    rowCount: rows.length,
    matchingPids: pidsMatchingWindowsRoots(rows, roots, { selfPid: process.pid }),
    cmdHints: rows
      .filter((r) => /playon-proc|hold\.(cmd|exe)|cmd\.exe/i.test(`${r.executablePath} ${r.commandLine}`))
      .slice(0, 8)
      .map((r) => `${r.pid}:${r.commandLine.slice(0, 180)}`),
  };
}

export function listWindowsPidsMatchingRoots(
  roots: readonly string[],
  excludePids?: Set<number>,
): number[] {
  return pidsMatchingWindowsRoots(listWindowsProcessRows(roots), roots, {
    excludePids,
    selfPid: process.pid,
  });
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
