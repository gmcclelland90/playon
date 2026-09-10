/**
 * Stormworks dedicated-server contract.
 *
 * Geometa discontinued Steam tool 1247090 (2024-02-24). Anonymous SteamCMD
 * still "installs" that app — a ~26KB stub that prints "moved to the game
 * folder" and never binds UDP. The real PE is `server64.exe` in client app
 * 573090. Without `+server_dir`, the process reads `%APPDATA%\Stormworks`
 * and ignores the jail overlay `server_config.xml` (port 25564).
 */

export const STORMWORKS_SKILL_NAME = "games.stormworks";
export const STORMWORKS_CLIENT_APP_ID = 573090;
export const STORMWORKS_DEDICATED_STUB_APP_ID = 1247090;
export const STORMWORKS_GAME_PORT = 25564;

/** Discontinued dedicated-server tools whose files now ship in the client app. */
export const STEAM_DEDICATED_STUB_REMAP: Readonly<Record<number, number>> = {
  [STORMWORKS_DEDICATED_STUB_APP_ID]: STORMWORKS_CLIENT_APP_ID,
};

export function isStormworksSkill(skillName: string | null | undefined): boolean {
  return (skillName ?? "").trim() === STORMWORKS_SKILL_NAME;
}

export function isSteamDedicatedStubAppId(appId: number): boolean {
  return Object.prototype.hasOwnProperty.call(STEAM_DEDICATED_STUB_REMAP, appId);
}

/** Map a discontinued dedicated tool id to the client app that actually ships files. */
export function resolveSteamInstallAppId(appId: number): number {
  return STEAM_DEDICATED_STUB_REMAP[appId] ?? appId;
}

/** Jail-relative config the dedicated PE reads when launched with +server_dir. */
export const STORMWORKS_CONFIG_REL_PATHS = [
  "game/server_data/server_config.xml",
  "server_data/server_config.xml",
  "game/server_config.xml",
] as const;

export function parseStormworksServerConfigPort(text: string): number | null {
  const match = /\bport\s*=\s*["']?(\d{1,5})["']?/i.exec(text);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

export function stormworksServerConfigXml(port = STORMWORKS_GAME_PORT): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<server_data port="${port}" name="PlayOn" seed="1" save_name="autosave_server" max_players="12" password="" day_length="30" night_length="30" infinite_resources="true" unlock_all_islands="false" settings_menu="true" settings_menu_lock="false" vehicle_spawn="true" respawning="true">
	<admins/>
	<authorized/>
	<blacklist/>
	<whitelist/>
	<playlists/>
	<mods/>
</server_data>
`;
}

/**
 * Windows overlay. Locates server64.exe in the jail, PLAYON_MANAGED_FROM, or a
 * host Steam library, then launches with +server_dir so port 25564 is the jail
 * XML — not %APPDATA%\\Stormworks. Do not use `start` (supervised cmd would
 * exit before UDP binds).
 */
export function stormworksStartBat(): string {
  const lines = [
    "@echo off",
    "REM PlayOn: Stormworks dedicated. Tool 1247090 is a discontinued stub.",
    "REM server64.exe ships in client 573090. +server_dir keeps config in the jail.",
    "setlocal EnableExtensions",
    'cd /d "%~dp0"',
    'set "ROOT=%CD%"',
    'if not defined SteamAppId set "SteamAppId=573090"',
    'if not defined SteamGameId set "SteamGameId=573090"',
    'set "EXE="',
    'set "SERVERROOT="',
    'call :try "%ROOT%\\server64.exe" "%ROOT%"',
    'if not defined EXE call :try "%ROOT%\\Stormworks\\server64.exe" "%ROOT%\\Stormworks"',
    'if not defined EXE call :try "%ROOT%\\573090\\server64.exe" "%ROOT%\\573090"',
    "if not defined EXE if defined PLAYON_MANAGED_FROM call :try \"%PLAYON_MANAGED_FROM%\\server64.exe\" \"%PLAYON_MANAGED_FROM%\"",
    'if not defined EXE call :try "%ProgramFiles(x86)%\\Steam\\steamapps\\common\\Stormworks\\server64.exe" "%ProgramFiles(x86)%\\Steam\\steamapps\\common\\Stormworks"',
    'if not defined EXE call :try "%ProgramFiles%\\Steam\\steamapps\\common\\Stormworks\\server64.exe" "%ProgramFiles%\\Steam\\steamapps\\common\\Stormworks"',
    'if not defined EXE call :try "C:\\Steam\\steamapps\\common\\Stormworks\\server64.exe" "C:\\Steam\\steamapps\\common\\Stormworks"',
    "if not defined EXE call :find_nested",
    "if not defined EXE (",
    "  echo stormworks: server64.exe missing - steamcmd_app_update 573090 needs an owned account or a local Stormworks client",
    "  exit /b 1",
    ")",
    'if not exist "%ROOT%\\server_data" mkdir "%ROOT%\\server_data"',
    'cd /d "%SERVERROOT%"',
    ">steam_appid.txt echo %SteamAppId%",
    '"%EXE%" +server_dir "%ROOT%\\server_data" %*',
    "exit /b %ERRORLEVEL%",
    ":try",
    'if exist "%~1" (',
    '  set "EXE=%~1"',
    '  set "SERVERROOT=%~2"',
    ")",
    "exit /b 0",
    ":find_nested",
    'for /d %%D in ("%ROOT%\\steamapps\\common\\*") do (',
    '  if exist "%%D\\server64.exe" (',
    "    set \"SERVERROOT=%%D\"",
    "    set \"EXE=%%D\\server64.exe\"",
    "    exit /b 0",
    "  )",
    ")",
    "exit /b 1",
    "",
  ];
  return lines.join("\r\n");
}

export type StormworksJailOverlayPlan = {
  writeStartBat: boolean;
  writeConfig: boolean;
};

/** Rewrite start.bat when it cannot pin the jail config; write XML when port is missing. */
export function stormworksJailOverlayPlan(existing: {
  startBat?: string | null;
  configXml?: string | null;
}): StormworksJailOverlayPlan {
  const bat = existing.startBat ?? "";
  const xml = existing.configXml ?? "";
  const hasServerDir = /\+server_dir/i.test(bat);
  const hasPe = /server64\.exe/i.test(bat);
  const port = xml.trim() ? parseStormworksServerConfigPort(xml) : null;
  return {
    writeStartBat: !bat.trim() || !hasServerDir || !hasPe,
    writeConfig: !xml.trim() || port == null,
  };
}
