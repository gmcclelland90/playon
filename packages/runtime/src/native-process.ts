import { spawn, type ChildProcess } from "node:child_process";
import { resolveInJail } from "./path-jail.js";
import type { ProcessInfo, ProcessSpec, ProcessSupervisor } from "./types.js";

interface TrackedProcess {
  info: ProcessInfo;
  child: ChildProcess;
  cwdJail: string;
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
    const id = `native-${spec.name}-${++this.seq}`;
    const child = spawn(spec.command, spec.args ?? [], {
      cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: "ignore",
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
      }
    });

    this.procs.set(id, { info, child, cwdJail: cwd });
    return { ...info };
  }

  async stop(id: string): Promise<void> {
    const tracked = this.require(id);
    if (tracked.info.status !== "running") return;
    const pid = tracked.child.pid;
    if (pid && process.platform !== "win32") {
      try {
        // Detached spawns get their own process group — kill the group, not only the shell.
        process.kill(-pid, "SIGTERM");
      } catch {
        tracked.child.kill("SIGTERM");
      }
    } else {
      tracked.child.kill();
    }
    tracked.info.status = "stopped";
    tracked.info.pid = undefined;
  }

  async status(id: string): Promise<ProcessInfo> {
    return { ...this.require(id).info };
  }

  private require(id: string): TrackedProcess {
    const p = this.procs.get(id);
    if (!p) throw new Error(`unknown process: ${id}`);
    return p;
  }
}
