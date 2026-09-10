/**
 * Lab-matrix helpers for games.stormworks (#959).
 * Keep in sync with packages/shared/src/stormworks.ts — this file is plain JS
 * so unit tests do not require a prior `pnpm build`.
 */
export const STORMWORKS_SKILL = "games.stormworks";
export const STORMWORKS_CLIENT_APP_ID = 573090;
export const STORMWORKS_DEDICATED_STUB_APP_ID = 1247090;

export function stormworksSteamAppId(declaredAppId) {
  const id = Number(declaredAppId);
  if (id === STORMWORKS_DEDICATED_STUB_APP_ID) return STORMWORKS_CLIENT_APP_ID;
  return id;
}

/** Anonymous 573090 is expected; still try start (host client / managedFrom). */
export function stormworksContinueAfterSteamcmd(skillName, message) {
  if (String(skillName ?? "").trim() !== STORMWORKS_SKILL) return false;
  return /steamcmd_no_subscription|steamcmd_empty_depot|No subscription/i.test(
    String(message ?? ""),
  );
}

export function stormworksStartBat() {
  return [
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
    '    set "SERVERROOT=%%D"',
    '    set "EXE=%%D\\server64.exe"',
    "    exit /b 0",
    "  )",
    ")",
    "exit /b 1",
    "",
  ].join("\r\n");
}

export function stormworksServerConfigXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<server_data port="25564" name="PlayOn" seed="1" save_name="autosave_server" max_players="12" password="" day_length="30" night_length="30" infinite_resources="true" unlock_all_islands="false" settings_menu="true" settings_menu_lock="false" vehicle_spawn="true" respawning="true">
	<admins/>
	<authorized/>
	<blacklist/>
	<whitelist/>
	<playlists/>
	<mods/>
</server_data>
`;
}

export function stormworksOverlayWrites(existing = {}) {
  const bat = String(existing.startBat ?? "");
  const xml = String(existing.configXml ?? "");
  const hasServerDir = /\+server_dir/i.test(bat);
  const hasPe = /server64\.exe/i.test(bat);
  const hasPort = /\bport\s*=\s*["']?\d{1,5}/i.test(xml);
  const files = [];
  if (!bat.trim() || !hasServerDir || !hasPe) {
    files.push({ path: "game/start.bat", content: stormworksStartBat() });
  }
  if (!xml.trim() || !hasPort) {
    files.push({
      path: "game/server_data/server_config.xml",
      content: stormworksServerConfigXml(),
    });
  }
  return files;
}
