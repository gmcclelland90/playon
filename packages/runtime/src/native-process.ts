import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moveProcessOutOfAgentCgroup } from "./cgroup.js";
import { resolveInJail } from "./path-jail.js";
import {
  adoptPidIntoPlayonScope,
  launchNativeViaUserService,
  stopUserService,
} from "./systemd-scope.js";
import type { ProcessInfo, ProcessSpec, ProcessSupervisor } from "./types.js";
import {
  killWindowsOrphansByRoots,
  killWindowsPidTree,
  listWindowsPidsMatchingRoots,
} from "./windows-process-orphans.js";

export { moveProcessOutOfAgentCgroup, readCgroupRelativePath } from "./cgroup.js";

interface TrackedProcess {
  info: ProcessInfo;
  /** Absent when a user systemd service owns the game (#1045). */
  child?: ChildProcess;
  /** Transient `playon-server-*.service` unit, when launched that way. */
  unit?: string;
  cwdJail: string;
  logFd?: number;
  /** Extra write end so agent exit does not EOF a keepStdin console. */
  stdinWriteFd?: number;
  stdinHolder?: ChildProcess;
  stdinDir?: string;
  stdinFifo?: string;
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
function windowsMatchRoots(cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of [serverTreeRoot(cwd), ...cmdlineOrphanRoots(cwd)]) {
    const key = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

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

/** Stable FIFO so a new Home/agent process can reopen console after restart. */
export function defaultStdinFifoPath(cwd: string): string {
  return path.join(serverTreeRoot(cwd), ".playon", "console.in");
}

function stdinHolderPidPath(cwd: string): string {
  return path.join(serverTreeRoot(cwd), ".playon", "stdin-holder.pid");
}

export function nativePidPath(cwd: string): string {
  return path.join(serverTreeRoot(cwd), ".playon", "native.pid");
}

export function nativePortPath(cwd: string): string {
  return path.join(serverTreeRoot(cwd), ".playon", "native.port");
}

export function nativeUnitPath(cwd: string): string {
  return path.join(serverTreeRoot(cwd), ".playon", "native.unit");
}

/** `/proc/<pid>/stat` starttime (field 22), so a recycled pid is not re-adopted. */
export function readProcStartTicks(pid: number): string | null {
  if (process.platform === "win32" || !pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const ticks = stat.slice(close + 2).split(" ")[19];
    return ticks && /^\d+$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

export type NativePidRecord = { pid: number; startTicks?: string };

export function readNativePidRecord(cwd: string): NativePidRecord | null {
  try {
    const text = fs.readFileSync(nativePidPath(cwd), "utf8").trim();
    if (!text) return null;
    const [pidRaw, ticks] = text.split(/\s+/);
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, ...(ticks && /^\d+$/.test(ticks) ? { startTicks: ticks } : {}) };
  } catch {
    return null;
  }
}

export function writeNativePidRecord(cwd: string, pid: number): void {
  const file = nativePidPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ticks = readProcStartTicks(pid);
  fs.writeFileSync(file, ticks ? `${pid} ${ticks}\n` : `${pid}\n`);
}

function clearNativePid(cwd: string): void {
  try {
    fs.rmSync(nativePidPath(cwd), { force: true });
  } catch {
    /* best-effort */
  }
}

function rememberNativeUnit(cwd: string, unit: string | undefined): void {
  const file = nativeUnitPath(cwd);
  try {
    if (!unit) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${unit}\n`);
  } catch {
    /* best-effort */
  }
}

function readNativeUnit(cwd: string): string | undefined {
  try {
    const unit = fs.readFileSync(nativeUnitPath(cwd), "utf8").trim();
    return unit || undefined;
  } catch {
    return undefined;
  }
}

function writeNativePort(cwd: string, env?: Record<string, string>): void {
  const raw = env?.PLAYON_GAME_PORT?.trim();
  const port = raw ? Number(raw) : NaN;
  const file = nativePortPath(cwd);
  try {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${port}\n`);
  } catch {
    /* best-effort */
  }
}

function readNativePort(cwd: string): number | null {
  try {
    const port = Number(fs.readFileSync(nativePortPath(cwd), "utf8").trim());
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function pidRecordIsAlive(record: NativePidRecord): boolean {
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }
  if (!record.startTicks) return true;
  const now = readProcStartTicks(record.pid);
  return now == null || now === record.startTicks;
}

/** True when this pid's cwd or command line is inside the server tree. */
export function processBelongsToServerTree(pid: number, tree: string): boolean {
  if (process.platform === "win32" || !pid || !tree || tree === "/" || tree === "\\") return false;
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (cwd === tree || cwd.startsWith(`${tree}/`)) return true;
  } catch {
    /* unreadable */
  }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    if (cmd.includes(tree)) return true;
  } catch {
    /* unreadable */
  }
  return false;
}

/** `ss -p` lines: `users:(("java",pid=123,fd=10))`. */
export function pidsFromSsOutput(text: string): number[] {
  const pids = new Set<number>();
  for (const match of text.matchAll(/pid=(\d+)/g)) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function pickListeningPid(
  pids: readonly number[],
  tree: string,
  belongs: (pid: number, tree: string) => boolean = processBelongsToServerTree,
): number | null {
  for (const pid of pids) {
    if (belongs(pid, tree)) return pid;
  }
  return null;
}

function pidsListeningOnPort(port: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const out = execFileSync("ss", ["-H", "-l", "-p", "-t", "-u", "-n", `sport = :${port}`], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return pidsFromSsOutput(out);
  } catch {
    return [];
  }
}

function logNativeChildExit(args: {
  name?: string;
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
}): void {
  console.log(
    JSON.stringify({
      msg: "playon_native_child_exit",
      name: args.name ?? null,
      pid: args.pid ?? null,
      exitCode: args.exitCode,
      signal: args.signal,
    }),
  );
}

function detachFromControlPlaneCgroup(pid: number | undefined, name: string): void {
  if (!pid) return;
  const scoped = adoptPidIntoPlayonScope(pid, name);
  if (!scoped.ok) moveProcessOutOfAgentCgroup(pid);
}

function persistHolderPid(cwd: string, pid: number | undefined): void {
  const file = stdinHolderPidPath(cwd);
  try {
    if (!pid) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${pid}\n`);
  } catch {
    /* best-effort */
  }
}

function killPersistedHolder(cwd: string): void {
  const file = stdinHolderPidPath(cwd);
  try {
    if (!fs.existsSync(file)) return;
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
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
 * A stable path (under the server tree) lets a new Home process reopen console.
 */
function openHeldStdin(
  fifoPath?: string,
  holderName = "stdin",
): { readFd: number; writeFd: number; holder: ChildProcess; dir?: string; fifo: string } | null {
  if (process.platform === "win32") return null;
  const stable = Boolean(fifoPath);
  const fifo = fifoPath ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "playon-stdin-")), "in");
  const dir = path.dirname(fifo);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(fifo)) {
      execFileSync("mkfifo", [fifo], { stdio: "ignore" });
    }
    const writeFd = fs.openSync(fifo, "r+");
    const readFd = fs.openSync(fifo, "r");
    const holder = spawn("sleep", ["infinity"], {
      detached: true,
      stdio: [writeFd, "ignore", "ignore"],
    });
    holder.unref();
    if (holder.pid) detachFromControlPlaneCgroup(holder.pid, `${holderName}-stdin`);
    return { readFd, writeFd, holder, dir: stable ? undefined : dir, fifo };
  } catch {
    if (!stable) fs.rmSync(dir, { recursive: true, force: true });
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

    const userLaunched = await this.startInUserService(spec, cwd);
    if (userLaunched) return userLaunched;

    let logFd: number | undefined;
    // Linux: new session/pgrp. Windows keepStdin stays attached (FIFO is Linux-only).
    const detached = supervisedChildDetached(Boolean(spec.keepStdin));
    // GoldSrc/HLDS segfault with detached + piped stdin — use a FIFO holder instead of a pipe.
    const stdinFifo = spec.keepStdin ? defaultStdinFifoPath(cwd) : undefined;
    const heldStdin = spec.keepStdin ? openHeldStdin(stdinFifo, spec.name) : null;
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
    if (child.pid) {
      detachFromControlPlaneCgroup(child.pid, spec.name);
      writeNativePidRecord(cwd, child.pid);
    }
    writeNativePort(cwd, spec.env);
    if (heldStdin?.holder?.pid) persistHolderPid(cwd, heldStdin.holder.pid);
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

    child.on("exit", (code, signal) => {
      const tracked = this.procs.get(id);
      logNativeChildExit({
        name: tracked?.info.name ?? spec.name,
        pid: tracked?.info.pid ?? child.pid,
        exitCode: code,
        signal,
      });
      if (tracked) {
        tracked.info.status = "stopped";
        tracked.info.pid = undefined;
        this.closeLogFd(tracked);
        clearNativePid(tracked.cwdJail);
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
      stdinFifo: heldStdin?.fifo,
    });
    return { ...info };
  }

  /**
   * Born in a user systemd service so `playon.service` KillMode=mixed cannot
   * SIGKILL it. Null falls through to the detached spawn (#1045).
   */
  private async startInUserService(
    spec: ProcessSpec,
    cwd: string,
  ): Promise<ProcessInfo | null> {
    const logFile = spec.logFile
      ? path.isAbsolute(spec.logFile)
        ? spec.logFile
        : this.jailRoot
          ? resolveInJail(this.jailRoot, spec.logFile)
          : path.resolve(cwd, spec.logFile)
      : undefined;
    if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const stdinFifo = spec.keepStdin ? defaultStdinFifoPath(cwd) : undefined;
    if (stdinFifo) {
      fs.mkdirSync(path.dirname(stdinFifo), { recursive: true });
      if (!fs.existsSync(stdinFifo)) {
        try {
          execFileSync("mkfifo", [stdinFifo], { stdio: "ignore" });
        } catch {
          return null;
        }
      }
    }
    const launched = await launchNativeViaUserService({
      name: spec.name,
      command: spec.command,
      args: spec.args ?? [],
      cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      logFile,
      stdinFifo,
      pidFile: nativePidPath(cwd),
    });
    if (!launched) return null;

    writeNativePidRecord(cwd, launched.pid);
    writeNativePort(cwd, spec.env);
    rememberNativeUnit(cwd, launched.unit);
    let stdinWriteFd: number | undefined;
    if (stdinFifo) {
      try {
        stdinWriteFd = fs.openSync(stdinFifo, "r+");
      } catch {
        stdinWriteFd = undefined;
      }
    }
    const id = `native-${spec.name}-${++this.seq}`;
    const info: ProcessInfo = {
      id,
      name: spec.name,
      pid: launched.pid,
      status: "running",
    };
    this.procs.set(id, {
      info,
      unit: launched.unit,
      cwdJail: cwd,
      stdinWriteFd,
      stdinFifo,
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
      if (tracked.stdinHolder || !tracked.child) continue;
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
    clearNativePid(cwd);
    rememberNativeUnit(cwd, undefined);
    // Children may re-parent outside the process group after detach.
    // Only the server identity may tree-reap — a diagnostic stop with
    // cwd under the game jail must not SIGTERM the JVM (#909).
    if (shouldReapServerTreeOrphans(name, cwd)) {
      await this.killOrphansByCwd(cwd);
    }
    killPersistedHolder(cwd);
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
    const recorded = readNativePidRecord(resolved);
    if (recorded && pidRecordIsAlive(recorded)) {
      return { id: `native-orphan-${recorded.pid}`, name, pid: recorded.pid, status: "running" };
    }
    const port = readNativePort(resolved);
    if (port) {
      const owner = pickListeningPid(pidsListeningOnPort(port), serverTreeRoot(resolved));
      if (owner && owner !== process.pid) {
        return { id: `native-orphan-${owner}`, name, pid: owner, status: "running" };
      }
    }
    if (process.platform === "win32") {
      const roots = windowsMatchRoots(resolved);
      const pid = listWindowsPidsMatchingRoots(roots)[0];
      if (pid == null) return null;
      return { id: `native-orphan-${pid}`, name, pid, status: "running" };
    }
    const pid =
      listPidsWithCwdUnder(serverTreeRoot(resolved))[0] ?? firstPidWithCmdlineUnderRoots(resolved);
    if (pid == null) return null;
    // Untracked survivor: the pid is the only identity we can offer.
    return { id: `native-orphan-${pid}`, name, pid, status: "running" };
  }

  async reclaim(name: string, cwd: string): Promise<void> {
    const resolved = this.jailRoot ? resolveInJail(this.jailRoot, cwd) : cwd;
    const excludePids = new Set<number>();
    for (const tracked of this.procs.values()) {
      if (tracked.info.status !== "running") continue;
      if (tracked.info.name !== name) {
        if (tracked.child?.pid) excludePids.add(tracked.child.pid);
        if (tracked.info.pid) excludePids.add(tracked.info.pid);
        if (tracked.stdinHolder?.pid) excludePids.add(tracked.stdinHolder.pid);
        continue;
      }
      this.signalTracked(tracked);
      tracked.info.status = "stopped";
      tracked.info.pid = undefined;
      this.closeLogFd(tracked);
    }
    if (shouldReapServerTreeOrphans(name, resolved)) {
      await this.killOrphansByCwd(resolved, excludePids);
    }
    this.killRecordedNative(resolved);
    killPersistedHolder(resolved);
  }

  /**
   * Write a console line to the process behind an identity. A supervisor this
   * process still holds can use the pipe/FIFO fd. After a control-plane
   * restart the stable FIFO under the server tree is reopened (#1038).
   */
  async writeStdin(name: string, cwd: string, data: string): Promise<void> {
    const resolved = this.jailRoot ? resolveInJail(this.jailRoot, cwd) : cwd;
    const line = data.endsWith("\n") ? data : `${data}\n`;
    const tracked = this.findTracked(name, resolved);
    if (!tracked) {
      // Surviving FIFO after a control-plane restart — reopen the write end.
      if (process.platform !== "win32") {
        const fifo = defaultStdinFifoPath(resolved);
        if (fs.existsSync(fifo)) {
          const fd = fs.openSync(fifo, "r+");
          try {
            fs.writeSync(fd, line);
            return;
          } finally {
            fs.closeSync(fd);
          }
        }
      }
      throw new Error("stdin_unavailable: no supervised process for this identity");
    }
    if (tracked.stdinWriteFd != null) {
      fs.writeSync(tracked.stdinWriteFd, line);
      return;
    }
    const stdin = tracked.child?.stdin;
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

  private killRecordedNative(cwd: string): void {
    const unit = readNativeUnit(cwd);
    if (unit) stopUserService(unit);
    rememberNativeUnit(cwd, undefined);
    const recorded = readNativePidRecord(cwd);
    clearNativePid(cwd);
    if (!recorded) return;
    try {
      process.kill(recorded.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  private signalTracked(tracked: TrackedProcess): void {
    if (tracked.unit) stopUserService(tracked.unit);
    const pid = tracked.child?.pid ?? tracked.info.pid;
    if (pid && process.platform === "win32") {
      killWindowsPidTree(pid);
      try {
        tracked.child?.kill();
      } catch {
        // already gone
      }
      return;
    }
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          tracked.child?.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    } else {
      try {
        tracked.child?.kill();
      } catch {
        // already gone
      }
    }
  }

  /** SIGTERM then SIGKILL any process whose /proc cwd is under this server tree. */
  private async killOrphansByCwd(cwd: string, excludePids?: Set<number>): Promise<void> {
    if (process.platform === "win32") {
      await killWindowsOrphansByRoots(windowsMatchRoots(cwd), excludePids);
      return;
    }
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
