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
    let stdio: "ignore" | Array<"ignore" | number> = "ignore";
    if (spec.logFile) {
      const logPath = path.isAbsolute(spec.logFile)
        ? spec.logFile
        : this.jailRoot
          ? resolveInJail(this.jailRoot, spec.logFile)
          : path.resolve(cwd, spec.logFile);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logFd = fs.openSync(logPath, "a");
      stdio = ["ignore", logFd, logFd];
    }

    const id = `native-${spec.name}-${++this.seq}`;
    const child = spawn(spec.command, spec.args ?? [], {
      cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio,
      // Detach long-running game servers so start() cannot stall on child I/O/session.
      detached: process.platform !== "win32",
    });
    if (process.platform !== "win32") {
      child.unref();
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

  async reclaim(name: string, cwd: string): Promise<void> {
    for (const tracked of this.procs.values()) {
      if (tracked.info.name !== name && tracked.cwdJail !== cwd) continue;
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

  /** SIGTERM then SIGKILL any process whose /proc cwd is under `cwd`. */
  private async killOrphansByCwd(cwd: string): Promise<void> {
    const target = cwd.replace(/\/+$/, "");
    if (!target || target === "/") return;

    const pids = listPidsWithCwdUnder(target);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    // Fallback: pkill -f for start scripts under this game dir (covers races
    // where /proc/cwd is unreadable to the agent user).
    try {
      execFileSync("pkill", ["-TERM", "-f", target], { stdio: "ignore" });
    } catch {
      // exit 1 = no match
    }
    await sleep(1500);
    for (const pid of listPidsWithCwdUnder(target)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    try {
      execFileSync("pkill", ["-KILL", "-f", target], { stdio: "ignore" });
    } catch {
      // no match
    }
  }

  private require(id: string): TrackedProcess {
    const p = this.procs.get(id);
    if (!p) throw new Error(`unknown process: ${id}`);
    return p;
  }
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
