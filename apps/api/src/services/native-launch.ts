import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillMetadata, SkillNative } from "@playon/shared";

export interface NativeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  kind: "native" | "script";
}

/**
 * Resolve cmd.exe on Windows using ComSpec or fallback to absolute path.
 * Prevents spawn ENOENT on hosts where cmd.exe is not in PATH.
 */
function resolveWindowsCmd(): string {
  if (process.env.ComSpec) return process.env.ComSpec;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "cmd.exe");
}

/**
 * Resolve PowerShell executable on Windows.
 * Tries pwsh (cross-platform PowerShell 7+) first, then powershell.exe (Windows PowerShell 5.1).
 * Falls back to "powershell.exe" in PATH if absolute paths don't exist.
 */
function resolveWindowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    path.join(systemRoot, "System32", "pwsh.exe"),
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "System32", "powershell.exe"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore stat failures */
    }
  }
  return "powershell.exe";
}

/**
 * GoldSrc HLDS and Source SRCDS load `~/.steam/sdk32/steamclient.so` for
 * SteamAPI/breakpad. When missing or pointing at a cleaned-up tmp install,
 * the process may bind UDP then hang/segfault during Steam GameServer init
 * and never answer A2S — lab-matrix sees query_offline / udp_process_not_running.
 */
export function ensureLinuxSteamSdk32(gameDir: string): void {
  if (process.platform !== "linux") return;
  const steamcmdLinux32 = [
    process.env.PLAYON_STEAMCMD
      ? path.join(path.dirname(process.env.PLAYON_STEAMCMD), "linux32", "steamclient.so")
      : "",
    path.join(os.homedir(), "steamcmd", "linux32", "steamclient.so"),
    "/home/playon/steamcmd/linux32/steamclient.so",
  ].filter(Boolean);
  const isSrcds =
    fs.existsSync(path.join(gameDir, "srcds_run")) ||
    fs.existsSync(path.join(gameDir, "srcds_linux")) ||
    fs.existsSync(path.join(gameDir, "bin", "steamclient.so"));
  // Source SRCDS: prefer SteamCMD's steamclient (lab-proven for BMS). GoldSrc
  // HLDS: prefer the app-dir copy first (older ABI).
  const candidates = isSrcds
    ? [
        ...steamcmdLinux32,
        path.join(gameDir, "bin", "steamclient.so"),
        path.join(gameDir, "steamclient.so"),
      ]
    : [
        path.join(gameDir, "steamclient.so"),
        path.join(gameDir, "bin", "steamclient.so"),
        ...steamcmdLinux32,
      ];
  const target = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!target) return;
  const steamRoot = path.join(os.homedir(), ".steam");
  const dir = path.join(steamRoot, "sdk32");
  const link = path.join(dir, "steamclient.so");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const steamcmdDir = steamcmdLinux32
      .map((p) => path.dirname(path.dirname(p)))
      .find((d) => d && fs.existsSync(d));
    if (steamcmdDir) {
      for (const name of ["steam", "root"] as const) {
        const l = path.join(steamRoot, name);
        try {
          fs.lstatSync(l);
          fs.unlinkSync(l);
        } catch {
          /* missing */
        }
        try {
          fs.symlinkSync(steamcmdDir, l);
        } catch {
          /* best-effort */
        }
      }
    }
    // Copy into sdk32 so tmp matrix game dirs can be deleted without dangling links.
    const targetReal = fs.realpathSync(target);
    const curReal = (() => {
      try {
        return fs.existsSync(link) ? fs.realpathSync(link) : null;
      } catch {
        return null;
      }
    })();
    if (curReal === targetReal) return;
    try {
      fs.unlinkSync(link);
    } catch {
      /* missing */
    }
    fs.copyFileSync(targetReal, link);
    const crashSrc = path.join(path.dirname(targetReal), "crashhandler.so");
    const crashDst = path.join(dir, "crashhandler.so");
    if (fs.existsSync(crashSrc)) {
      try {
        fs.copyFileSync(crashSrc, crashDst);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort — never block launch */
  }
}

/**
 * SteamCMD depots sometimes ship `srcds_run` / `hlds_run` with CRLF. Linux then
 * execs interpreter `/bin/sh\r` → spawn ENOENT ("required file not found").
 * Rewrite in place when CR is present; leave LF scripts alone.
 */
export function ensureUnixShellScript(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0 || st.size > 2_000_000) return;
    const buf = fs.readFileSync(filePath);
    if (!buf.includes(0x0d)) return;
    // Only touch text-ish shell wrappers (shebang or known Valve names).
    const base = path.basename(filePath);
    const head = buf.subarray(0, Math.min(buf.length, 64)).toString("utf8");
    const looksShell =
      head.startsWith("#!") ||
      /^(srcds_run|hlds_run|svends_run)$/i.test(base) ||
      base.endsWith(".sh");
    if (!looksShell) return;
    const mode = st.mode;
    fs.writeFileSync(filePath, buf.filter((b) => b !== 0x0d));
    fs.chmodSync(filePath, mode);
  } catch {
    /* best-effort — never block launch */
  }
}

function resolveScriptLaunch(gameDir: string): NativeLaunch | null {
  if (process.platform === "win32") {
    for (const name of ["start.bat", "run.bat"]) {
      const full = path.join(gameDir, name);
      if (fs.existsSync(full)) {
        return {
          kind: "script",
          command: resolveWindowsCmd(),
          args: ["/c", full],
          env: { PLAYON_GAME: "native" },
        };
      }
    }
    for (const name of ["start.ps1", "run.ps1"]) {
      const full = path.join(gameDir, name);
      if (fs.existsSync(full)) {
        const pwsh = resolveWindowsPowerShell();
        return {
          kind: "script",
          command: pwsh,
          args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", full],
          env: { PLAYON_GAME: "native" },
        };
      }
    }
    return null;
  }

  for (const name of [
    "start.sh",
    "start-server.sh",
    "StartServer64.sh",
    "LaunchServer.sh",
    "runds.sh",
    "run.sh",
  ]) {
    const full = path.join(gameDir, name);
    if (fs.existsSync(full)) {
      ensureUnixShellScript(full);
      return {
        kind: "script",
        command: "/bin/bash",
        args: [full],
        env: { PLAYON_GAME: "native" },
      };
    }
  }
  return null;
}

function resolveBinaryLaunch(
  gameDir: string,
  native: SkillNative,
  skillName?: string | null,
): NativeLaunch | null {
  const isWin = process.platform === "win32";
  const rel = (isWin && native.binaryWindows ? native.binaryWindows : native.binary)?.replace(
    /\\/g,
    "/",
  );
  if (!rel) return null;
  const binary = path.join(gameDir, ...rel.split("/"));
  if (!fs.existsSync(binary)) return null;

  const env: Record<string, string> = { PLAYON_GAME: "native", ...native.env };
  if (!isWin && native.libraryPathRelative.length > 0) {
    const parts = [
      ...native.libraryPathRelative.map((p) => path.join(gameDir, ...p.split("/"))),
      process.env.LD_LIBRARY_PATH,
    ].filter(Boolean) as string[];
    env.LD_LIBRARY_PATH = parts.join(":");
  }

  const args = resolveNativeArgs({
    args: native.args,
    gameDir,
    skillName,
  });

  const base = path.basename(rel);
  const isShellWrapper =
    !isWin &&
    (rel.endsWith(".sh") || /^(srcds_run|hlds_run|svends_run)$/i.test(base));
  if (isShellWrapper) {
    ensureUnixShellScript(binary);
    // Shell wrappers (PalServer.sh, srcds_run, …): run via bash so +x/shebang
    // are not required and native.args reach the script as $1… (e.g. -configfile=).
    return {
      kind: "script",
      command: "/bin/bash",
      args: [binary, ...args],
      env,
    };
  }

  return {
    kind: "native",
    command: binary,
    args,
    env,
  };
}

/**
 * Expand skill native.args placeholders and inject optional host secrets.
 * Bannerlord: PLAYON_BANNERLORD_AUTH_TOKEN → /dedicatedcustomserverauthtoken
 * (TaleWorlds rejects anonymous hosting; token from client customserver.gettoken).
 */
export function resolveNativeArgs(opts: {
  args: string[];
  gameDir?: string;
  skillName?: string | null;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = opts.env ?? process.env;
  let args = opts.args.map((a) =>
    opts.gameDir ? a.replaceAll("{{gameDir}}", opts.gameDir) : a,
  );
  if (opts.skillName === "games.bannerlord") {
    const token = (env.PLAYON_BANNERLORD_AUTH_TOKEN ?? "").trim();
    const hasTokenArg = args.some(
      (a, i) =>
        a === "/dedicatedcustomserverauthtoken" ||
        a.startsWith("/dedicatedcustomserverauthtoken=") ||
        (i > 0 && args[i - 1] === "/dedicatedcustomserverauthtoken"),
    );
    if (token && !hasTokenArg) {
      args = [...args, "/dedicatedcustomserverauthtoken", token];
    }
  }
  return args;
}

/** Pick a host process launch for a native skill's game/ directory. */
export function resolveNativeLaunch(opts: {
  skillName: string;
  game?: string | null;
  gameDir: string;
  /** Skill metadata when available — preferred over name heuristics. */
  metadata?: SkillMetadata | null;
}): NativeLaunch | null {
  const { gameDir, metadata, skillName } = opts;
  if (!fs.existsSync(gameDir)) return null;

  const native = metadata?.native;
  const binaryName = (native?.binary ?? "").replace(/\\/g, "/");
  const needsSteamSdk32 =
    /(^|\/)(hlds|srcds)(_run|_linux)?$/i.test(binaryName) ||
    fs.existsSync(path.join(gameDir, "hlds_run")) ||
    fs.existsSync(path.join(gameDir, "srcds_run")) ||
    fs.existsSync(path.join(gameDir, "srcds_linux"));
  if (needsSteamSdk32) {
    ensureLinuxSteamSdk32(gameDir);
  }

  const preferScript = native?.preferStartScript !== false;
  if (preferScript) {
    const script = resolveScriptLaunch(gameDir);
    if (script) return script;
  }
  if (native) {
    const bin = resolveBinaryLaunch(gameDir, native, skillName ?? metadata?.name);
    if (bin) return bin;
  }
  if (!preferScript) {
    const script = resolveScriptLaunch(gameDir);
    if (script) return script;
  }
  return null;
}

export function nativeGamePort(metadata?: SkillMetadata | null): number | null {
  const game = metadata?.ports.find((p) => p.name === "game" && p.default);
  return game?.default ?? null;
}

export function nativeRconPort(metadata?: SkillMetadata | null): number | null {
  const rcon = metadata?.ports.find((p) => p.name === "rcon" && p.default);
  return rcon?.default ?? null;
}
