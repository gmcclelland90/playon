import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInJail } from "./path-jail.js";
import type { ProcessInfo, ProcessSpec, ProcessSupervisor } from "./types.js";

interface TrackedProcess {
  info: ProcessInfo;
  child: ChildProcess;
  cwdJail: string;
  logFd?: number;
  /** Extra write end so agent exit does not EOF a keepStdin console. */
  stdinWriteFd?: number;
  stdinHolder?: ChildProcess;
  stdinDir?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pathBasename(p: string): string {
  const normalized = p.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function pathDirname(p: string): string {
  const normalized = p.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (idx < 0) return ".";
  if (idx === 0) return normalized[0] ?? ".";
  return normalized.slice(0, idx);
}

/**
 * PlayOn game processes spawn with cwd `…/game`, but some runtimes (JVM
 * dedicated servers) chdir into sibling userdata (`…/home/…`). Orphan find
 * and reclaim must cover the whole server tree, not only the launch cwd.
 */
export function serverTreeRoot(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  if (pathBasename(normalized) === "game") {
    const parent = pathDirname(normalized);
    if (parent && parent !== "." && parent !== "/" && parent !== "\\") return parent;
  }
  return normalized;
}

/** Cmdline match roots — game + home only. Never the parent server id path. */
export function cmdlineOrphanRoots(cwd: string): string[] {
  const normalized = cwd.replace(/[\\/]+$/, "");
  if (pathBasename(normalized) !== "game") return [normalized];
  const parent = pathDirname(normalized);
  const sep = normalized.includes("\\") ? "\\" : "/";
  return [normalized, `${parent}${sep}home`];
}

/**
 * Tree-wide orphan reap is only for the control-plane server identity
 * (`server-<instanceId>`) launched from `…/game`. A diagnostic
 * `process_start` / `process_stop` whose cwd happens to sit under that
 * jail must not SIGTERM the dedicated server / JVM (#909).
 */
export function shouldReapServerTreeOrphans(name: string, cwd: string): boolean {
  if (!name || name === "server-unknown") return false;
  if (!name.startsWith("server-")) return false;
  const normalized = cwd.replace(/[\\/]+$/, "");
  return pathBasename(normalized) === "game";
}

/**
 * `/proc/<pid>/stat` pgrp (field 5). Used to prove a game is not in the
 * agent's process group — `kill(-agentPid)` / systemd session teardown
 * must not land on the dedicated server (#886).
 */
export function readProcessGroupId(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const rest = stat.slice(close + 2).split(" ");
    const pgrp = Number(rest[2]);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

/**
 * cgroup v2 path from `/proc/<pid>/cgroup` (`0::/system.slice/…`).
 * `detached` is a new session/pgrp — it is not a cgroup escape.
 */
export function readCgroupRelativePath(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const text = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(":");
      if (parts.length < 3) continue;
      const rel = parts.slice(2).join(":") || "/";
      return rel.startsWith("/") ? rel : `/${rel}`;
    }
    return null;
  } catch {
    return null;
  }
}

function cgroupProcsFile(relPath: string): string {
  const rel = relPath === "/" ? "" : relPath;
  return `/sys/fs/cgroup${rel}/cgroup.procs`;
}

/**
 * Best-effort move out of the agent unit cgroup so `KillMode=control-group`
 * (units OTA cannot rewrite) does not SIGTERM the game / FIFO holder.
 * Often EACCES without privileges — NZL-shaped `KillMode=process` is the
 * path that must still work when this returns false.
 */
export function moveProcessOutOfAgentCgroup(pid: number): boolean {
  if (process.platform === "win32" || !pid) return false;
  const self = readCgroupRelativePath(process.pid);
  const dests: string[] = [];
  if (process.ppid > 1) {
    const parentCg = readCgroupRelativePath(process.ppid);
    if (parentCg && parentCg !== self) dests.push(parentCg);
  }
  if (self && self !== "/") {
    dests.push(self.replace(/\/[^/]+$/, "") || "/");
  }
  dests.push("/");
  const seen = new Set<string>();
  for (const dest of dests) {
    if (!dest || seen.has(dest) || dest === self) continue;
    seen.add(dest);
    try {
      fs.writeFileSync(cgroupProcsFile(dest), `${pid}\n`);
      const now = readCgroupRelativePath(pid);
      if (now && now !== self) return true;
    } catch {
      /* EACCES / ENOENT / EBUSY */
    }
  }
  return false;
}

/**
 * Linux/mac: new session so `kill(-agentPid)` misses the game.
 * Windows: never detach — FIFO is Linux-only, and GoldSrc/HLDS segfaults
 * with detached + piped stdin. `keepStdin` on Windows stays a pipe.
 */
export function supervisedChildDetached(keepStdin = false): boolean {
  if (process.platform === "win32") return false;
  void keepStdin;
  return true;
}

/**
 * Hold a write end on a FIFO so `keepStdin` games do not see EOF when the
 * agent process exits (systemd restart / crash). The agent also writes here.
 */
function openHeldStdin(): { readFd: number; writeFd: number; holder: ChildProcess; dir: string } | null {
  if (process.platform === "win32") return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-stdin-"));
  const fifo = path.join(dir, "in");
  try {
    execFileSync("mkfifo", [fifo], { stdio: "ignore" });
    const writeFd = fs.openSync(fifo, "r+");
    const readFd = fs.openSync(fifo, "r");
    const holder = spawn("sleep", ["infinity"], {
      detached: true,
      stdio: [writeFd, "ignore", "ignore"],
    });
    holder.unref();
    if (holder.pid) moveProcessOutOfAgentCgroup(holder.pid);
    return { readFd, writeFd, holder, dir };
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
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
    // Linux: new session/pgrp. Windows keepStdin stays attached (FIFO is Linux-only).
    const detached = supervisedChildDetached(Boolean(spec.keepStdin));
    // GoldSrc/HLDS segfault with detached + piped stdin — use a FIFO holder instead of a pipe.
    const heldStdin = spec.keepStdin ? openHeldStdin() : null;
    const stdinMode: "pipe" | "ignore" | number = heldStdin
      ? heldStdin.readFd
      : spec.keepStdin
        ? "pipe"
        : "ignore";
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
      this.releaseHeldStdin(heldStdin);
      throw err;
    }

    if (process.platform !== "win32") {
      child.unref();
    }
    if (child.pid) moveProcessOutOfAgentCgroup(child.pid);
    if (heldStdin) {
      try {
        fs.closeSync(heldStdin.readFd);
      } catch {
        /* child holds the read end */
      }
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

    this.procs.set(id, {
      info,
      child,
      cwdJail: cwd,
      logFd,
      stdinWriteFd: heldStdin?.writeFd,
      stdinHolder: heldStdin?.holder,
      stdinDir: heldStdin?.dir,
    });
    return { ...info };
  }

  /** FIFO holder pid when this identity was started with Linux keepStdin. */
  stdinHolderPid(name: string, cwd: string): number | undefined {
    const resolved = this.jailRoot ? resolveInJail(this.jailRoot, cwd) : cwd;
    return this.findTracked(name, resolved)?.stdinHolder?.pid;
  }

  /**
   * True when a running child still has a Node pipe write-end (FIFO holder
   * failed or Windows). Agent MAINPID exit would EOF that console (#909).
   */
  hasPipeStdinChildren(): boolean {
    for (const tracked of this.procs.values()) {
      if (tracked.info.status !== "running") continue;
      if (tracked.stdinHolder) continue;
      const stdin = tracked.child.stdin;
      if (stdin && !stdin.destroyed) return true;
    }
    return false;
  }

  async stop(id: string): Promise<void> {
    const tracked = this.require(id);
    if (tracked.info.status !== "running") return;
    const cwd = tracked.cwdJail;
    const name = tracked.info.name;
    this.signalTracked(tracked);
    tracked.info.status = "stopped";
    tracked.info.pid = undefined;
    this.closeLogFd(tracked);
    // Children may re-parent outside the process group after detach.
    // Only the server identity may tree-reap — a diagnostic stop with
    // cwd under the game jail must not SIGTERM the JVM (#909).
    if (process.platform !== "win32" && shouldReapServerTreeOrphans(name, cwd)) {
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
    const excludePids = new Set<number>();
    for (const tracked of this.procs.values()) {
      if (tracked.info.status !== "running") continue;
      if (tracked.info.name !== name) {
        if (tracked.child.pid) excludePids.add(tracked.child.pid);
        if (tracked.stdinHolder?.pid) excludePids.add(tracked.stdinHolder.pid);
        continue;
      }
      this.signalTracked(tracked);
      tracked.info.status = "stopped";
      tracked.info.pid = undefined;
      this.closeLogFd(tracked);
    }
    if (process.platform !== "win32" && shouldReapServerTreeOrphans(name, cwd)) {
      await this.killOrphansByCwd(cwd, excludePids);
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
    const line = data.endsWith("\n") ? data : `${data}\n`;
    if (tracked.stdinWriteFd != null) {
      fs.writeSync(tracked.stdinWriteFd, line);
      return;
    }
    const stdin = tracked.child.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error("stdin_unavailable: process console is closed");
    }
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  list(): ProcessInfo[] {
    const out: ProcessInfo[] = [];
    for (const tracked of this.procs.values()) {
      if (tracked.info.status !== "running") continue;
      out.push({ ...tracked.info });
    }
    return out;
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
    if (tracked.logFd != null) {
      try {
        fs.closeSync(tracked.logFd);
      } catch {
        // already closed
      }
      tracked.logFd = undefined;
    }
    this.releaseHeldStdin({
      readFd: undefined,
      writeFd: tracked.stdinWriteFd,
      holder: tracked.stdinHolder,
      dir: tracked.stdinDir,
    });
    tracked.stdinWriteFd = undefined;
    tracked.stdinHolder = undefined;
    tracked.stdinDir = undefined;
  }

  private releaseHeldStdin(held?: {
    readFd?: number;
    writeFd?: number;
    holder?: ChildProcess;
    dir?: string;
  } | null): void {
    if (!held) return;
    if (held.holder) {
      try {
        held.holder.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const fd of [held.readFd, held.writeFd]) {
      if (fd == null) continue;
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    if (held.dir) {
      fs.rmSync(held.dir, { recursive: true, force: true });
    }
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
  private async killOrphansByCwd(cwd: string, excludePids?: Set<number>): Promise<void> {
    const target = serverTreeRoot(cwd.replace(/\/+$/, ""));
    if (!target || target === "/") return;
    const cmdlineRoots = cmdlineOrphanRoots(cwd);

    const pids = listPidsWithCwdUnder(target).filter((pid) => !excludePids?.has(pid));
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
    const surviving = listPidsWithCwdUnder(target).filter((pid) => !excludePids?.has(pid));
    const pkillStillMatches = pkillFoundAny && pgrepMatchingRoots(cmdlineRoots);

    if (surviving.length === 0 && !pkillStillMatches) {
      return;
    }

    // Stubborn survivors: wait longer then SIGKILL.
    await sleep(1400);
    for (const pid of listPidsWithCwdUnder(target).filter((pid) => !excludePids?.has(pid))) {
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
