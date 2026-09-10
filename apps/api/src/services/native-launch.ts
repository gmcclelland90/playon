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

/** Catalog id for Mount & Blade II: Bannerlord dedicated (Steam 1863440). */
export const BANNERLORD_SKILL = "games.bannerlord";

/** Starter PE relative to the SteamCMD jail root (and the usual nested depot). */
export const BANNERLORD_STARTER_REL =
  "bin/Win64_Shipping_Server/DedicatedCustomServer.Starter.exe";

/**
 * TaleWorlds Starter must run with CWD=this directory. PlayOn identity cwd is
 * always game/; launching the PE from game/ Access-Violates before UDP 7210
 * binds (lab: udp_process_not_running).
 */
export const BANNERLORD_WORKING_DIR_REL = "bin/Win64_Shipping_Server";

/** Overlay config name; must live under Modules/Native (TaleWorlds loader). */
export const BANNERLORD_CONFIG_NAME = "playon_tdm.txt";

/**
 * Disposable TDM rotation so the listen socket stays up after start.
 * `start_game_and_mission` (not start_game alone) is what binds UDP 7210.
 */
export const BANNERLORD_PLAYON_TDM = [
  "ServerName PlayOn-Bannerlord",
  "GameType TeamDeathmatch",
  "Map mp_tdm_map_001",
  "MaxNumberOfPlayers 16",
  "MinNumberOfPlayersForMatchStart 1",
  "NumberOfBotsTeam1 0",
  "NumberOfBotsTeam2 0",
  "CultureTeam1 vlandia",
  "CultureTeam2 battania",
  "add_map_to_automated_battle_pool mp_tdm_map_001",
  "set_automated_battle_count -1",
  "enable_automated_battle_switching",
  "start_game_and_mission",
  "",
].join("\n");

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

  const env: Record<string, string> = isFoundrySkill(skillName)
    ? foundryLaunchEnv({ PLAYON_GAME: "native", ...native.env })
    : { PLAYON_GAME: "native", ...native.env };
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
export const FOUNDRY_SKILL_NAME = "games.foundry";
/** Client Steam app id — steamclient / steam_appid.txt (Survival Servers + official launcher). */
export const FOUNDRY_STEAM_CLIENT_APP_ID = "983870";
export const FOUNDRY_GAME_PORT = 3724;
/**
 * Unity headless flags. FoundryDedicatedServer.exe is a Windows-subsystem PE.
 * Catalog start.bat uses `start /wait` (new window). playon-win-1's node-agent
 * is a Scheduled Task with LogonType S4U — no interactive desktop — so that
 * wrapper exits immediately (lab: udp_process_not_running) before UDP 3724 binds.
 */
export const FOUNDRY_HEADLESS_ARGS = ["-batchmode", "-nographics", "-log"] as const;

export function isFoundrySkill(skillName?: string | null): boolean {
  return skillName === FOUNDRY_SKILL_NAME;
}

/** Direct PE launch — never cmd `start /wait` / start.bat on an S4U Windows node. */
export function foundryPreferStartScript(): boolean {
  return false;
}

function hasArgFlag(args: string[], flag: string): boolean {
  const want = flag.toLowerCase();
  return args.some((a) => a.toLowerCase() === want);
}

export function ensureFoundryHeadlessArgs(args: string[]): string[] {
  const out = [...args];
  for (const flag of FOUNDRY_HEADLESS_ARGS) {
    if (!hasArgFlag(out, flag)) out.push(flag);
  }
  return out;
}

export function foundryLaunchEnv(existing?: Record<string, string>): Record<string, string> {
  const next = { ...(existing ?? {}) };
  if (!next.SteamAppId?.trim()) next.SteamAppId = FOUNDRY_STEAM_CLIENT_APP_ID;
  if (!next.SteamGameId?.trim()) next.SteamGameId = FOUNDRY_STEAM_CLIENT_APP_ID;
  return next;
}

/** LAN-safe App.cfg. Public Steam listing exits this dedi after boot under PlayOn. */
export function foundryLanAppCfg(opts?: { saveDir?: string }): string {
  const lines = [
    "server_name=PlayOn-Foundry-Lab",
    "server_world_name=PlayOnLab",
    "server_password=",
    "pause_server_when_empty=false",
    "autosave_interval=300",
    "server_is_public=false",
    `server_port=${FOUNDRY_GAME_PORT}`,
    // Official default is 27015; unused while server_is_public=false.
    "server_query_port=3725",
    "server_max_players=8",
  ];
  if (opts?.saveDir?.trim()) {
    lines.push(`server_persistent_data_override_folder=${opts.saveDir.trim()}`);
  }
  return `${lines.join("\n")}\n`;
}

function upsertCfgKey(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "im");
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  const body = text.replace(/\s*$/, "");
  return `${body}${body ? "\n" : ""}${key}=${value}\n`;
}

/**
 * Keep Foundry listening on the jail: force LAN public=false, game port, and
 * an absolute save folder when we can see the disk (local native).
 */
export function ensureFoundryAppCfg(gameDir: string): void {
  const cfgPath = path.join(gameDir, "app.cfg");
  const saveDir = path.join(gameDir, "save");
  try {
    fs.mkdirSync(saveDir, { recursive: true });
  } catch {
    /* best-effort */
  }
  let text = "";
  try {
    text = fs.readFileSync(cfgPath, "utf8");
  } catch {
    text = "";
  }
  let next = text.trim() ? text : foundryLanAppCfg({ saveDir });
  next = upsertCfgKey(next, "server_is_public", "false");
  next = upsertCfgKey(next, "server_port", String(FOUNDRY_GAME_PORT));
  next = upsertCfgKey(next, "server_persistent_data_override_folder", saveDir);
  if (!next.endsWith("\n")) next += "\n";
  try {
    fs.writeFileSync(cfgPath, next);
  } catch {
    /* best-effort — never block launch */
  }
  try {
    fs.writeFileSync(path.join(gameDir, "steam_appid.txt"), `${FOUNDRY_STEAM_CLIENT_APP_ID}\n`);
  } catch {
    /* best-effort */
  }
}

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
  if (opts.skillName === "games.stormworks") {
    const hasServerDir = args.some(
      (a) => a === "+server_dir" || a.startsWith("+server_dir="),
    );
    if (!hasServerDir) {
      args = [...args, "+server_dir", "server_data"];
    }
  }
  if (opts.skillName === BANNERLORD_SKILL) {
    const token = bannerlordAuthToken(env);
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
  if (isFoundrySkill(opts.skillName)) {
    args = ensureFoundryHeadlessArgs(args);
  }
  return args;
}

/** Host/node secret for Bannerlord custom-server registration. */
export function bannerlordAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PLAYON_BANNERLORD_AUTH_TOKEN ?? "").trim();
}

/**
 * Copy the Home/node token into the supervised process env so overlay
 * `start.bat` can see it. native.args injection is skipped when Home launches
 * `cmd /c start.bat` with no extra args (Windows remote) — env is the path
 * that actually reaches playon-win-1.
 */
export function bannerlordProcessEnv(
  base: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const token = bannerlordAuthToken(env);
  if (!token) return { ...base };
  return { ...base, PLAYON_BANNERLORD_AUTH_TOKEN: token };
}

/**
 * Session-0-safe Bannerlord start.bat.
 *
 * Catalog 0.1.4 uses `start /wait` (new console). On playon-win-1 the node-agent
 * spawns with `windowsHide` under Session 0 — that new window dies immediately,
 * cmd.exe exits, and lab-matrix records `udp_process_not_running` after start
 * reported ok. `start /b /wait` keeps the Windows-subsystem Starter attached
 * in the same hidden console, after cd into bin\\Win64_Shipping_Server.
 */
export function buildBannerlordWindowsStartBat(): string {
  const lines = [
    "@echo off",
    "REM PlayOn: Bannerlord dedicated (SteamCMD 1863440).",
    "REM CWD must be bin\\Win64_Shipping_Server. start /b /wait: Session 0 / windowsHide.",
    "setlocal EnableExtensions",
    'cd /d "%~dp0"',
    'set "ROOT=%CD%"',
    'set "EXE="',
    `if exist "%ROOT%\\bin\\Win64_Shipping_Server\\DedicatedCustomServer.Starter.exe" (`,
    `  set "EXE=%ROOT%\\bin\\Win64_Shipping_Server\\DedicatedCustomServer.Starter.exe"`,
    ")",
    `if not defined EXE if exist "%ROOT%\\steamapps\\common\\Mount & Blade II Dedicated Server\\bin\\Win64_Shipping_Server\\DedicatedCustomServer.Starter.exe" (`,
    `  set "EXE=%ROOT%\\steamapps\\common\\Mount & Blade II Dedicated Server\\bin\\Win64_Shipping_Server\\DedicatedCustomServer.Starter.exe"`,
    ")",
    "if not defined EXE (",
    "  echo bannerlord: DedicatedCustomServer.Starter.exe missing - run steamcmd_app_update 1863440",
    "  exit /b 1",
    ")",
    'for %%I in ("%EXE%") do set "BIN_DIR=%%~dpI"',
    'for %%I in ("%BIN_DIR%\\..\\..") do set "GAME_ROOT=%%~fI"',
    'set "NATIVE=%GAME_ROOT%\\Modules\\Native"',
    `set "CFG=${BANNERLORD_CONFIG_NAME}"`,
    'if not exist "%NATIVE%" (',
    "  echo bannerlord: Modules\\Native missing - incomplete Steam depot 1863440",
    "  exit /b 1",
    ")",
    'if not exist "%NATIVE%\\%CFG%" (',
    `  if exist "%ROOT%\\Modules\\Native\\%CFG%" (`,
    `    copy /Y "%ROOT%\\Modules\\Native\\%CFG%" "%NATIVE%\\%CFG%" >nul`,
    "  ) else (",
    "    echo bannerlord: %CFG% missing under Modules\\Native - skill overlay failed",
    "    exit /b 1",
    "  )",
    ")",
    'if not exist "%NATIVE%\\MultiplayerForcedAvatars" mkdir "%NATIVE%\\MultiplayerForcedAvatars"',
    'if not exist "%GAME_ROOT%\\logs" mkdir "%GAME_ROOT%\\logs"',
    'set "TOKEN_ARGS="',
    "if defined PLAYON_BANNERLORD_AUTH_TOKEN set \"TOKEN_ARGS=/dedicatedcustomserverauthtoken %PLAYON_BANNERLORD_AUTH_TOKEN%\"",
    'cd /d "%BIN_DIR%"',
    "REM Quote _MODULES_ so cmd.exe does not glob '*'. /b = same hidden console.",
    `start /b /wait "" "%EXE%" "_MODULES_*Native*Multiplayer*_MODULES_" /port 7210 /DisableErrorReporting /dedicatedcustomserverconfigfile %CFG% /LogOutputPath "%GAME_ROOT%\\logs" %TOKEN_ARGS% %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ];
  return lines.join("\r\n");
}

/** Write the Session-0 start.bat + TDM config into a local game/ jail. */
export function writeBannerlordWindowsOverlayFiles(gameDir: string): void {
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "start.bat"), buildBannerlordWindowsStartBat());
  const nativeDir = path.join(gameDir, "Modules", "Native");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, BANNERLORD_CONFIG_NAME), BANNERLORD_PLAYON_TDM);
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
  if (isFoundrySkill(skillName)) {
    ensureFoundryAppCfg(gameDir);
  }

  const preferScript = isFoundrySkill(skillName)
    ? foundryPreferStartScript()
    : native?.preferStartScript !== false;
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
