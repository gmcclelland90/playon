import { execFileSync } from "node:child_process";

export type WindowsProcessRow = {
  pid: number;
  executablePath: string;
  commandLine: string;
};

function normalizeWinPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
  return a === b || a.startsWith(`${b}/`);
}

export function windowsCommandLineMentionsRoot(commandLine: string, root: string): boolean {
  if (!isUsableWindowsRoot(root)) return false;
  const cmd = normalizeWinPath(commandLine);
  const r = normalizeWinPath(root);
  let from = 0;
  while (from <= cmd.length) {
    const i = cmd.indexOf(r, from);
    if (i < 0) return false;
    const after = cmd[i + r.length];
    if (after === undefined || after === "/" || after === " " || after === '"' || after === "'") {
      return true;
    }
    from = i + 1;
  }
  return false;
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
    const line = rawLine.trim();
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

function listWindowsProcessRows(): WindowsProcessRow[] {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0}`t{1}`t{2}' -f $_.ProcessId, $_.ExecutablePath, $_.CommandLine }",
      ],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
    return parseWindowsProcessListing(out);
  } catch {
    return [];
  }
}

export function listWindowsPidsMatchingRoots(
  roots: readonly string[],
  excludePids?: Set<number>,
): number[] {
  return pidsMatchingWindowsRoots(listWindowsProcessRows(), roots, {
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
