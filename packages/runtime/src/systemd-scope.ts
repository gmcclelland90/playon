/**
 * Keep a native game out of the Home / node-agent cgroup (#1038 / #1045).
 *
 * Preferred launch: a transient user service (`systemd-run --user --unit=
 * playon-server-<id>.service`). The user manager forks the game, so it is
 * born under `user.slice` and survives `KillMode=mixed` on `playon.service`.
 * Moving an already-running PID (`--property=PIDs=`) often cannot leave
 * `system.slice/playon.service`, so that path is only the fallback.
 *
 * Windows / no user bus / `PLAYON_SYSTEMD_SCOPE=0` keep the detached spawn.
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
}) => { ok: boolean; stdout?: string; stderr?: string };

function defaultRunner(args: { argv: string[]; env?: NodeJS.ProcessEnv }): {
  ok: boolean;
  stdout?: string;
  stderr?: string;
} {
  try {
    const stdout = execFileSync(args.argv[0]!, args.argv.slice(1), {
      encoding: "utf8",
      timeout: 8_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: args.env ?? process.env,
    });
    return { ok: true, stdout };
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "")
        : err instanceof Error
          ? err.message
          : "";
    return { ok: false, stderr: stderr.slice(0, 400) };
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

/** Transient user service that owns one native game (#1045). */
export function playonServerServiceUnit(name: string): string {
  return playonServerScopeUnit(name).replace(/\.scope$/, ".service");
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

export function userSystemdAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isSystemdHost(env)) return false;
  const userEnv = userSystemdEnv(env);
  const xdg = userEnv?.XDG_RUNTIME_DIR;
  if (!xdg) return false;
  try {
    return fs.existsSync(`${xdg}/bus`);
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
  console.log(
    JSON.stringify({
      msg: "playon_native_scope",
      ok: false,
      method: "none",
      pid,
      unit,
      detail: "pid stayed in the control-plane cgroup; next start uses a user service when the user bus exists",
    }),
  );
  return { ok: false, method: "none", unit };
}

export type UserServiceLaunchRequest = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logFile?: string;
  stdinFifo?: string;
  pidFile: string;
};

export type UserServiceLaunch = {
  pid: number;
  unit: string;
};

export type UserServiceLauncher = (
  req: UserServiceLaunchRequest,
) => UserServiceLaunch | null | Promise<UserServiceLaunch | null>;

let launchOverride: UserServiceLauncher | null = null;

/** Test seam — production callers leave this unset. */
export function setUserServiceLauncherForTests(next: UserServiceLauncher | null): void {
  launchOverride = next;
}

/**
 * Shell the user service runs. The game is a child so this shell can record
 * its pid and log the exit status/signal after Home is gone (#1045).
 * Fd 3 holds the console FIFO open so keepStdin games do not see EOF.
 */
export function nativeUserServiceShell(): string {
  return [
    "set +e",
    'if [ -n "${PLAYON_FIFO:-}" ]; then',
    '  exec 3<>"$PLAYON_FIFO"',
    '  if [ -n "${PLAYON_CONSOLE_LOG:-}" ]; then',
    '    "$@" <"$PLAYON_FIFO" >>"$PLAYON_CONSOLE_LOG" 2>&1 &',
    "  else",
    '    "$@" <"$PLAYON_FIFO" >/dev/null 2>&1 &',
    "  fi",
    "else",
    '  if [ -n "${PLAYON_CONSOLE_LOG:-}" ]; then',
    '    "$@" >>"$PLAYON_CONSOLE_LOG" 2>&1 &',
    "  else",
    '    "$@" >/dev/null 2>&1 &',
    "  fi",
    "fi",
    "child=$!",
    'if [ -n "${PLAYON_PIDFILE:-}" ]; then printf "%s\\n" "$child" > "$PLAYON_PIDFILE"; fi',
    'wait "$child"',
    "status=$?",
    "sig=",
    'if [ "$status" -gt 128 ] && [ "$status" -lt 192 ]; then sig=$((status-128)); fi',
    "signame=none",
    'case "$sig" in',
    "  15) signame=SIGTERM ;;",
    "  9) signame=SIGKILL ;;",
    "  1) signame=SIGHUP ;;",
    "  2) signame=SIGINT ;;",
    '  *) signame="${sig:-none}" ;;',
    "esac",
    'msg="playon_native_child_exit pid=$child status=$status signal=$signame name=${PLAYON_PROCESS_NAME:-native}"',
    'if command -v logger >/dev/null 2>&1; then logger -t playon -- "$msg"; fi',
    'if [ -n "${PLAYON_CONSOLE_LOG:-}" ]; then printf "%s\\n" "$msg" >> "$PLAYON_CONSOLE_LOG"; fi',
    'if [ -n "${PLAYON_PIDFILE:-}" ]; then rm -f "$PLAYON_PIDFILE"; fi',
    'exit "$status"',
  ].join("\n");
}

function systemdEnvLine(key: string, value: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  if (value.includes("\0") || value.includes("\n")) return null;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

export function writeSystemdEnvironmentFile(
  file: string,
  env: Record<string, string | undefined>,
): void {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    const line = systemdEnvLine(key, value);
    if (line) lines.push(line);
  }
  fs.mkdirSync(pathDir(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function pathDir(file: string): string {
  const idx = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return idx > 0 ? file.slice(0, idx) : ".";
}

function userSliceArgs(): string[] {
  const candidates = ["/etc/systemd/user/playon.slice"];
  const home = process.env.HOME?.trim();
  if (home) candidates.push(`${home}/.config/systemd/user/playon.slice`);
  if (candidates.some((file) => fs.existsSync(file))) return ["--slice=playon.slice"];
  return [];
}

/** argv for `systemd-run --user` that forks the game outside playon.service. */
export function buildUserServiceLaunchArgv(req: UserServiceLaunchRequest, envFile: string): string[] {
  const unit = playonServerServiceUnit(req.name);
  const argv = [
    "systemd-run",
    "--user",
    "--quiet",
    "--collect",
    "--no-block",
    `--unit=${unit}`,
    `--working-directory=${req.cwd}`,
    ...userSliceArgs(),
    `--property=EnvironmentFile=${envFile}`,
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=90",
    "--property=SuccessExitStatus=0 143",
    "--property=ExecStopPost=/usr/bin/logger -t playon -- playon_native_unit_stop %n",
    `--setenv=PLAYON_PIDFILE=${req.pidFile}`,
    `--setenv=PLAYON_PROCESS_NAME=${req.name}`,
  ];
  if (req.stdinFifo) argv.push(`--setenv=PLAYON_FIFO=${req.stdinFifo}`);
  if (req.logFile) argv.push(`--setenv=PLAYON_CONSOLE_LOG=${req.logFile}`);
  argv.push("/bin/sh", "-c", nativeUserServiceShell(), "playon-native", req.command, ...req.args);
  return argv;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Fork the game in a transient user service. Null means the caller should
 * use the in-process spawn (no user bus, Windows, or systemd-run failed).
 * Vitest stays on the spawn path unless a test launcher is installed.
 */
export async function launchNativeViaUserService(
  req: UserServiceLaunchRequest,
): Promise<UserServiceLaunch | null> {
  if (process.platform === "win32" || process.env.PLAYON_SYSTEMD_SCOPE === "0") return null;
  if (launchOverride) return launchOverride(req);
  if (process.env.VITEST === "true" && process.env.PLAYON_SYSTEMD_SCOPE !== "1") return null;
  if (!userSystemdAvailable()) return null;
  if (!req.command || !req.cwd || !req.pidFile) return null;

  const unit = playonServerServiceUnit(req.name);
  const env = userSystemdEnv();
  const envFile = `${pathDir(req.pidFile)}/native.env`;
  try {
    writeSystemdEnvironmentFile(envFile, req.env);
  } catch {
    return null;
  }

  runner({ argv: ["systemctl", "--user", "stop", unit], env });
  runner({ argv: ["systemctl", "--user", "reset-failed", unit], env });
  const started = runner({ argv: buildUserServiceLaunchArgv(req, envFile), env });
  if (!started.ok) {
    console.log(
      JSON.stringify({
        msg: "playon_native_user_service",
        ok: false,
        unit,
        detail: started.stderr ?? started.stdout ?? "systemd-run failed",
      }),
    );
    return null;
  }

  for (let i = 0; i < 40; i++) {
    const pid = readPidFile(req.pidFile);
    if (pid && pidAlive(pid)) {
      console.log(JSON.stringify({ msg: "playon_native_user_service", ok: true, unit, pid }));
      return { pid, unit };
    }
    await sleepMs(50);
  }
  console.log(
    JSON.stringify({
      msg: "playon_native_user_service",
      ok: false,
      unit,
      detail: "pidfile did not appear",
    }),
  );
  runner({ argv: ["systemctl", "--user", "stop", unit], env });
  return null;
}

export function stopUserService(unit: string | undefined): void {
  if (process.platform === "win32" || !unit) return;
  if (process.env.VITEST === "true" && !launchOverride && process.env.PLAYON_SYSTEMD_SCOPE !== "1") {
    return;
  }
  runner({ argv: ["systemctl", "--user", "stop", unit], env: userSystemdEnv() });
}
