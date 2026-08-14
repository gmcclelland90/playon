import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveInJail } from "./path-jail.js";
import type { ProcessInfo, ProcessSpec, ProcessSupervisor } from "./types.js";

interface TrackedProcess {
  info: ProcessInfo;
  child: ChildProcess;
  cwdJail: string;
  logFd?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * PlayOn game processes spawn with cwd `…/game`, but some runtimes (JVM
 * dedicated servers) chdir into sibling userdata (`…/home/…`). Orphan find
 * and reclaim must cover the whole server tree, not only the launch cwd.
 */
export function serverTreeRoot(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  if (path.basename(normalized) === "game") {
    const parent = path.dirname(normalized);
    if (parent && parent !== "." && parent !== path.parse(normalized).root) return parent;
  }
  return normalized;
}

/** Cmdline match roots — game + home only. Never the parent server id path. */
export function cmdlineOrphanRoots(cwd: string): string[] {
  const normalized = cwd.replace(/[\\/]+$/, "");
  if (path.basename(normalized) !== "game") return [normalized];
  return [normalized, path.join(path.dirname(normalized), "home")];
}

/**
 * Spawns OS processes with cwd constrained to an optional jail root.
 * When `jailRoot` is set on the supervisor, `spec.cwd` must resolve inside it.
 */
export class NativeProcessSupervisor implements ProcessSupervisor {
  private procs = new Map<string, TrackedProcess>();
  private seq = 0;

  constructor(private readonly jailRoot?: string) {}

  async start(spec: ProcessSpec): Promise<ProcessInfo> {
    const cwd = this.jailRoot ? resolveInJail(this.jailRoot, spec.cwd) : spec.cwd;
    // Never stack duplicates: stop prior tracked + OS orphans for this server cwd.
    await this.reclaim(spec.name, cwd);

    let logFd: number | undefined;
    // Detach long-running game servers so start() cannot stall on child I/O/session.
    const detached = process.platform !== "win32";
    // GoldSrc/HLDS (and some other native dedi) segfault with detached + piped stdin.
    // Only keep a stdin pipe when the skill explicitly needs console admin.
    const stdinMode: "pipe" | "ignore" = spec.keepStdin ? "pipe" : "ignore";
    let stdio: Array<"pipe" | "ignore" | number> = [stdinMode, "ignore", "ignore"];
    if (spec.logFile) {
      const logPath = path.isAbsolute(spec.logFile)
        ? spec.logFile
        : this.jailRoot
          ? resolveInJail(this.jailRoot, spec.logFile)
          : path.resolve(cwd, spec.logFile);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logFd = fs.openSync(logPath, "a");
      stdio = [stdinMode, logFd, logFd];
    }

    const id = `native-${spec.name}-${++this.seq}`;
    const child = spawn(spec.command, spec.args ?? [], {
      cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio,
      detached,
    });

    // Wait for spawn success so missing binaries (ENOENT) reject instead of
    // crashing the host via an unhandled 'error' event after start() returns.
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          child.off("spawn", onSpawn);
          reject(err);
        };
        const onSpawn = () => {
          child.off("error", onError);
          resolve();
        };
        child.once("error", onError);
        child.once("spawn", onSpawn);
      });
    } catch (err) {
      if (logFd !== undefined) {
        try {
          fs.closeSync(logFd);
        } catch {
          /* ignore */
        }
      }
      throw err;
    }

    if (process.platform !== "win32") {
      child.unref();
    }
    if (child.stdin) {
      // A game that exits first must turn a late console write into a rejected
      // promise, never an unhandled error event on the host.
      child.stdin.on("error", () => undefined);
      // The write end must not keep the host alive for a detached game.
      (child.stdin as unknown as { unref?: () => void }).unref?.();
    }

    const info: ProcessInfo = {
      id,
      name: spec.name,
      pid: child.pid,
      status: "running",
    };

    child.on("exit", () => {
      const tracked = this.procs.get(id);
      if (tracked) {
        tracked.info.status = "stopped";
        tracked.info.pid = undefined;
        this.closeLogFd(tracked);
      }
    });
    // Keep a listener so late spawn failures never become unhandled.
    child.on("error", () => undefined);

    this.procs.set(id, { info, child, cwdJail: cwd, logFd });
    return { ...info };
  }

  async stop(id: string): Promise<void> {
    const tracked = this.require(id);
    if (tracked.info.status !== "running") return;
    const cwd = tracked.cwdJail;
    this.signalTracked(tracked);
    tracked.info.status = "stopped";
    tracked.info.pid = undefined;
    this.closeLogFd(tracked);
    // Children may re-parent outside the process group after detach.
    if (process.platform !== "win32") {
      await this.killOrphansByCwd(cwd);
    }
  }

  async status(id: string): Promise<ProcessInfo> {
    return { ...this.require(id).info };
  }

  /**
   * Answer "is a process running for this server" from identity alone: tracked
   * entries first, then OS processes living in `cwd` (survives a supervisor restart).
   */
  async find(name: string, cwd: string): Promise<ProcessInfo | null> {
    const resolved = this.jailRoot ? resolveInJail(this.jailRoot, cwd) : cwd;
    const tracked = this.findTracked(name, resolved);
    if (tracked) return { ...tracked.info };
    if (process.platform === "win32") return null;
    const pid =
      listPidsWithCwdUnder(serverTreeRoot(resolved))[0] ?? firstPidWithCmdlineUnderRoots(resolved);
    if (pid == null) return null;
    // Untracked survivor: the pid is the only identity we can offer.
    return { id: `native-orphan-${pid}`, name, pid, status: "running" };
  }

  async reclaim(name: string, cwd: string): Promise<void> {
    const tree = serverTreeRoot(cwd);
    for (const tracked of this.procs.values()) {
      const sameTree =
        tracked.cwdJail === cwd ||
        tracked.cwdJail === tree ||
        tracked.cwdJail.startsWith(`${tree}${path.sep}`);
      if (tracked.info.name !== name && !sameTree) continue;
      if (tracked.info.status !== "running") continue;
      this.signalTracked(tracked);
      tracked.info.status = "stopped";
      tracked.info.pid = undefined;
      this.closeLogFd(tracked);
    }
    if (process.platform !== "win32") {
      await this.killOrphansByCwd(cwd);
    }
  }

  /**
   * Write a console line to the process behind an identity. Only a spawn this
   * supervisor still holds the stdin pipe for can be addressed — an OS orphan
   * `find` re-resolved after a restart has no console left to write to.
   */
  async writeStdin(name: string, cwd: string, data: string): Promise<void> {
    const resolved = this.jailRoot ? resolveInJail(this.jailRoot, cwd) : cwd;
    const tracked = this.findTracked(name, resolved);
    if (!tracked) {
      throw new Error("stdin_unavailable: no supervised process for this identity");
    }
    const stdin = tracked.child.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error("stdin_unavailable: process console is closed");
    }
    const line = data.endsWith("\n") ? data : `${data}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Tracked process for an identity: supervisor name first, then jailed cwd. */
  private findTracked(name: string, resolvedCwd: string): TrackedProcess | null {
    for (const tracked of this.procs.values()) {
      if (tracked.info.status !== "running") continue;
      if (tracked.info.name === name || tracked.cwdJail === resolvedCwd) return tracked;
    }
    return null;
  }

  private closeLogFd(tracked: TrackedProcess): void {
    if (tracked.logFd == null) return;
    try {
      fs.closeSync(tracked.logFd);
    } catch {
      // already closed
    }
    tracked.logFd = undefined;
  }

  private signalTracked(tracked: TrackedProcess): void {
    const pid = tracked.child.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          tracked.child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    } else {
      try {
        tracked.child.kill();
      } catch {
        // already gone
      }
    }
  }

  /** SIGTERM then SIGKILL any process whose /proc cwd is under this server tree. */
  private async killOrphansByCwd(cwd: string): Promise<void> {
    const target = serverTreeRoot(cwd.replace(/\/+$/, ""));
    if (!target || target === "/") return;
    const cmdlineRoots = cmdlineOrphanRoots(cwd);

    const pids = listPidsWithCwdUnder(target);
    // Fallback: pkill -f for start scripts under game/ or home/ (covers races
    // where /proc/cwd is unreadable to the agent user). Never pkill the parent
    // server-id path — that can match unrelated node-agent job cmdlines.
    let pkillFoundAny = false;
    if (pids.length === 0) {
      pkillFoundAny = pkillMatchingRoots(cmdlineRoots, "TERM");
      if (!pkillFoundAny) return;
    } else {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      pkillMatchingRoots(cmdlineRoots, "TERM");
    }

    // Brief poll: if nothing survived SIGTERM, skip the long sleep.
    await sleep(100);
    const surviving = listPidsWithCwdUnder(target);
    const pkillStillMatches = pkillFoundAny && pgrepMatchingRoots(cmdlineRoots);

    if (surviving.length === 0 && !pkillStillMatches) {
      return;
    }

    // Stubborn survivors: wait longer then SIGKILL.
    await sleep(1400);
    for (const pid of listPidsWithCwdUnder(target)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    pkillMatchingRoots(cmdlineRoots, "KILL");
  }

  private require(id: string): TrackedProcess {
    const p = this.procs.get(id);
    if (!p) throw new Error(`unknown process: ${id}`);
    return p;
  }
}

/** Fallback for hosts where /proc/<pid>/cwd is unreadable: match the command line. */
function firstPidWithCmdlineUnder(target: string): number | null {
  try {
    const out = execFileSync("pgrep", ["-f", target], { encoding: "utf8" });
    for (const line of out.trim().split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) return pid;
    }
    return null;
  } catch {
    // exit 1 = no match
    return null;
  }
}

function firstPidWithCmdlineUnderRoots(cwd: string): number | null {
  for (const root of cmdlineOrphanRoots(cwd)) {
    const pid = firstPidWithCmdlineUnder(root);
    if (pid != null) return pid;
  }
  return null;
}

function pkillMatchingRoots(roots: string[], signal: "TERM" | "KILL"): boolean {
  let found = false;
  for (const root of roots) {
    if (!root || root === "/") continue;
    try {
      execFileSync("pkill", [`-${signal}`, "-f", root], { stdio: "ignore" });
      found = true;
    } catch {
      // exit 1 = no match
    }
  }
  return found;
}

function pgrepMatchingRoots(roots: string[]): boolean {
  for (const root of roots) {
    if (!root || root === "/") continue;
    try {
      execFileSync("pgrep", ["-f", root], { stdio: "ignore" });
      return true;
    } catch {
      // exit 1 = no match
    }
  }
  return false;
}

function listPidsWithCwdUnder(target: string): number[] {
  const out: number[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    if (pid === process.pid) continue;
    let cwd: string;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (cwd === target || cwd.startsWith(`${target}/`)) {
      out.push(pid);
    }
  }
  return out;
}
