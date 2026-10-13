/**
 * Move a native game PID into a transient systemd scope so a Home / node-agent
 * unit restart (KillMode=mixed|control-group) cannot SIGKILL it (#1038).
 *
 * Preferred path: user systemd (`systemd-run --user --scope`) after linger, so
 * the scope lives under `user.slice`, not `playon.service`. Falls back to the
 * system bus, then to a best-effort cgroup.procs move. Windows / WSL-without-
 * systemd / `pnpm dev` keep the existing detached spawn.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { moveProcessOutOfAgentCgroup, readCgroupRelativePath } from "./cgroup.js";

export type SystemdScopeMethod = "user-scope" | "system-scope" | "cgroup-move" | "none";

export type SystemdScopeAdoptResult = {
  ok: boolean;
  method: SystemdScopeMethod;
  unit?: string;
};

export type SystemdScopeRunner = (args: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
}) => { ok: boolean; stdout?: string };

function defaultRunner(args: { argv: string[]; env?: NodeJS.ProcessEnv }): {
  ok: boolean;
  stdout?: string;
} {
  try {
    const stdout = execFileSync(args.argv[0]!, args.argv.slice(1), {
      encoding: "utf8",
      timeout: 8_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: args.env ?? process.env,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}

let runner: SystemdScopeRunner = defaultRunner;

/** Test seam — do not use from production callers. */
export function setSystemdScopeRunnerForTests(next: SystemdScopeRunner | null): void {
  runner = next ?? defaultRunner;
}

/** systemd unit names: `[A-Za-z0-9:_.\\-]+` plus a `.scope` suffix. */
export function playonServerScopeUnit(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return `playon-server-${sanitized || "unknown"}.scope`;
}

export function isSystemdHost(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === "win32") return false;
  if (env.PLAYON_SYSTEMD_SCOPE === "0") return false;
  if (env.PLAYON_SYSTEMD_SCOPE === "1") return true;
  try {
    return fs.existsSync("/run/systemd/system");
  } catch {
    return false;
  }
}

export function userSystemdEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const xdg = env.XDG_RUNTIME_DIR?.trim() || (uid != null ? `/run/user/${uid}` : "");
  if (!xdg) return undefined;
  const bus = env.DBUS_SESSION_BUS_ADDRESS?.trim() || `unix:path=${xdg}/bus`;
  return {
    ...env,
    XDG_RUNTIME_DIR: xdg,
    DBUS_SESSION_BUS_ADDRESS: bus,
  };
}

function pidLeftParentCgroup(pid: number): boolean {
  const self = readCgroupRelativePath(process.pid);
  const child = readCgroupRelativePath(pid);
  if (!self || !child) return false;
  return child !== self;
}

function runSystemdScope(opts: {
  unit: string;
  pid: number;
  user: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const argv = [
    "systemd-run",
    ...(opts.user ? ["--user"] : []),
    "--quiet",
    "--collect",
    "--scope",
    `--unit=${opts.unit}`,
    `--property=PIDs=${opts.pid}`,
    "/bin/true",
  ];
  return runner({ argv, env: opts.env }).ok;
}

/**
 * Best-effort: put `pid` in `playon-server-<name>.scope` outside the control
 * plane / agent cgroup. Returns whether the PID left this process's cgroup.
 */
export function adoptPidIntoPlayonScope(pid: number, name: string): SystemdScopeAdoptResult {
  if (process.platform === "win32" || !pid) {
    return { ok: false, method: "none" };
  }
  const unit = playonServerScopeUnit(name);
  if (isSystemdHost()) {
    const userEnv = userSystemdEnv();
    if (userEnv && runSystemdScope({ unit, pid, user: true, env: userEnv })) {
      if (pidLeftParentCgroup(pid)) {
        return { ok: true, method: "user-scope", unit };
      }
    }
    if (runSystemdScope({ unit, pid, user: false })) {
      if (pidLeftParentCgroup(pid)) {
        return { ok: true, method: "system-scope", unit };
      }
    }
  }
  if (moveProcessOutOfAgentCgroup(pid) && pidLeftParentCgroup(pid)) {
    return { ok: true, method: "cgroup-move", unit };
  }
  return { ok: false, method: "none", unit };
}
