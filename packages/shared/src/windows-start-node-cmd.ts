/**
 * Windows node launcher (`start-node.cmd`).
 *
 * PlayOnNodeAgent runs this file with no extra environment. Home URL / token
 * live in `node.env.cmd` next to it. A packaged launcher that only execs
 * node.exe falls through to the agent default `http://127.0.0.1:8787`, so OTA
 * overwrite of the installer script makes Home show the node offline.
 */

export const WINDOWS_START_NODE_CMD = "start-node.cmd";
export const WINDOWS_NODE_ENV_CMD = "node.env.cmd";

/**
 * 0.2.3–0.2.9 `scripts/package-node.mjs` shipped this. Extract/apply copied it
 * over the installer script and dropped `call node.env.cmd`.
 */
export const VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD = [
  "@echo off",
  'cd /d "%~dp0"',
  '"%~dp0runtime\\node\\node.exe" "%~dp0apps\\node-agent\\dist\\index.js"',
  "",
].join("\n");

/** True when the launcher will load Home wiring instead of localhost defaults. */
export function startNodeCmdLoadsNodeEnv(contents: string): boolean {
  const normalized = contents.replace(/\r\n/g, "\n").toLowerCase();
  return /\bcall\b/.test(normalized) && /node\.env\.cmd/.test(normalized);
}

/**
 * Leftover portable start-node.cmd for the tarball / a human double-click.
 * The scheduled task must exec node.exe directly — this file is not the task
 * action. No `>> logfile` (a locked redirect wedges cmd). `call node.env.cmd`
 * is still here for vintage hosts; installers rewrite that file as CRLF.
 */
export function bundledWindowsStartNodeCmd(): string {
  return [
    "@echo off",
    'cd /d "%~dp0"',
    'if exist "%~dp0node.env.cmd" call "%~dp0node.env.cmd"',
    'if defined PLAYON_DATA_ROOT if not exist "%PLAYON_DATA_ROOT%" mkdir "%PLAYON_DATA_ROOT%"',
    'if exist "%~dp0load-env.cjs" (',
    '  "%~dp0runtime\\node\\node.exe" --require "%~dp0load-env.cjs" "%~dp0apps\\node-agent\\dist\\index.js"',
    ") else (",
    '  "%~dp0runtime\\node\\node.exe" "%~dp0apps\\node-agent\\dist\\index.js"',
    ")",
    "",
  ].join("\r\n");
}
