import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Windows self-update launch (#1060 / #1041).
 *
 * PlayOnNodeAgent is an S4U scheduled task. Its job object kills every process
 * still in the job when the agent exits, including a detached powershell.exe.
 * Node detached spawn does not pass CREATE_BREAKAWAY_FROM_JOB, and Task
 * Scheduler jobs usually deny breakaway (ERROR_ACCESS_DENIED), so the helper
 * never reaches the breakaway logic inside apply-self-update.ps1.
 *
 * The reliable launch is a one-shot scheduled task created with the Task
 * Scheduler COM API (Schedule.Service). That copies the PlayOnNodeAgent
 * principal (same user, S4U, Highest) and Task Scheduler starts the helper in
 * a new job. schtasks.exe is only a fallback: /TR is capped at 261 characters
 * and schtasks cannot create an S4U principal ("run whether the user is logged
 * on" with no stored password). WMI Win32_Process.Create is the last resort;
 * the WMI service creates that process outside the caller job.
 *
 * The agent waits until the helper disables PlayOnNodeAgent and writes an
 * armed marker. If that does not happen, the update job fails and the agent
 * stays on the old version.
 */
export const WINDOWS_AGENT_TASK_NAME = "PlayOnNodeAgent";
export const WINDOWS_APPLY_UPDATE_TASK_NAME = "PlayOnNodeAgentApplyUpdate";
export const WINDOWS_HELPER_ARMED_MARK = "[apply-self-update] helper armed";
export const WINDOWS_HELPER_START_TIMEOUT_MS = 10_000;
/** Let the helper finish disabling the agent task before this process exits. */
export const WINDOWS_HELPER_SETTLE_MS = 1_000;
/** schtasks.exe /TR documented limit, including quotes. */
export const SCHTASKS_TR_MAX = 261;

export type WindowsLaunchMethod = "scheduled-task" | "schtasks" | "wmi";

export function windowsUpdateLaunchOrder(): WindowsLaunchMethod[] {
  return ["scheduled-task", "schtasks", "wmi"];
}

export function powershellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function windowsHelperMarkerPath(logPath: string): string {
  if (/\.log$/i.test(logPath)) return logPath.replace(/\.log$/i, ".started");
  return `${logPath}.started`;
}

export function formatSchtasksTr(launcherPs1: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${launcherPs1}"`;
}

/** Prefer a launcher beside the apply log. Fall back to %TEMP% when /TR would overflow. */
export function windowsHelperLauncherPath(logPath: string): string {
  const dir = path.dirname(logPath);
  const stem = path.basename(logPath).replace(/\.log$/i, "");
  const preferred = path.join(dir, `${stem}-launch.ps1`);
  if (formatSchtasksTr(preferred).length <= SCHTASKS_TR_MAX) return preferred;
  const shortStem = stem.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24) || "ota";
  return path.join(os.tmpdir(), `${shortStem}-launch.ps1`);
}

export function schtasksOnceLocalTime(now: Date = new Date()): string {
  const when = new Date(now.getTime() + 2 * 60 * 1000);
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function buildSchtasksCreateArgs(opts: {
  taskName: string;
  launcherPs1: string;
  startTime: string;
  highest?: boolean;
}): string[] {
  const tr = formatSchtasksTr(opts.launcherPs1);
  if (tr.length > SCHTASKS_TR_MAX) {
    throw new Error(`schtasks_tr_too_long: ${tr.length} > ${SCHTASKS_TR_MAX}`);
  }
  const args = ["/Create", "/TN", opts.taskName, "/SC", "ONCE", "/ST", opts.startTime];
  if (opts.highest !== false) args.push("/RL", "HIGHEST");
  args.push("/F", "/TR", tr);
  return args;
}

export function buildWindowsHelperArguments(opts: {
  sourceDir: string;
  targetDir: string;
  agentPid: number;
  version: string;
  applyLog: string;
  startedMarker: string;
  preserve: readonly string[];
}): string[] {
  const args = [
    "-SourceDir",
    opts.sourceDir,
    "-TargetDir",
    opts.targetDir,
    "-AgentPid",
    String(opts.agentPid),
    "-ExpectedVersion",
    opts.version,
    "-ApplyLog",
    opts.applyLog,
    "-StartedMarker",
    opts.startedMarker,
    "-Detached",
  ];
  for (const name of opts.preserve) args.push("-Preserve", name);
  return args;
}

/**
 * Outer PowerShell captures the helper's stdout and stderr into the apply log.
 * A Windows PowerShell 5.1 parse error never reaches the helper's own logger,
 * so it has to be merged here with 2>&1 (5.1 does not treat native stderr as
 * a PowerShell error stream).
 */
export function buildWindowsHelperLauncherPs1(opts: {
  helperScript: string;
  helperArgs: readonly string[];
  logPath: string;
}): string {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    opts.helperScript,
    ...opts.helperArgs,
  ];
  const argList = args.map((arg) => powershellSingleQuote(arg)).join(", ");
  return [
    "$ErrorActionPreference = 'Continue'",
    `$log = ${powershellSingleQuote(opts.logPath)}`,
    "$logDir = Split-Path -Parent $log",
    "if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {",
    "  New-Item -ItemType Directory -Force -Path $logDir | Out-Null",
    "}",
    "try { Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format o) + '] [node-agent] helper launcher start') -ErrorAction SilentlyContinue } catch {}",
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `$argList = @(${argList})`,
    "& $ps @argList 2>&1 | ForEach-Object {",
    "  try { Add-Content -LiteralPath $log -Value ([string]$_) -ErrorAction SilentlyContinue } catch {}",
    "}",
    "exit $LASTEXITCODE",
    "",
  ].join("\n");
}

export function buildScheduledTaskLaunchScript(opts: {
  launcherPs1: string;
  taskName?: string;
  agentTaskName?: string;
}): string {
  const taskName = opts.taskName ?? WINDOWS_APPLY_UPDATE_TASK_NAME;
  const agentTaskName = opts.agentTaskName ?? WINDOWS_AGENT_TASK_NAME;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$UpdateTaskName = ${powershellSingleQuote(taskName)}`,
    `$AgentTaskName = ${powershellSingleQuote(agentTaskName)}`,
    `$launcher = ${powershellSingleQuote(opts.launcherPs1)}`,
    "$service = New-Object -ComObject Schedule.Service",
    "$service.Connect()",
    "$folder = $service.GetFolder('\\')",
    "$task = $service.NewTask(0)",
    "$task.RegistrationInfo.Description = 'PlayOn one-shot node self-update helper'",
    "$task.Settings.Enabled = $true",
    "$task.Settings.AllowDemandStart = $true",
    "$task.Settings.StartWhenAvailable = $true",
    "$task.Settings.DisallowStartIfOnBatteries = $false",
    "$task.Settings.StopIfGoingOnBatteries = $false",
    "$task.Settings.ExecutionTimeLimit = 'PT1H'",
    "try {",
    "  $existing = $folder.GetTask($AgentTaskName)",
    "  $principal = $existing.Definition.Principal",
    "  if ($principal.UserId) { $task.Principal.UserId = [string]$principal.UserId }",
    "  if ($principal.GroupId) { $task.Principal.GroupId = [string]$principal.GroupId }",
    "  $task.Principal.LogonType = $principal.LogonType",
    "  $task.Principal.RunLevel = $principal.RunLevel",
    "} catch {",
    "  $task.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "  $task.Principal.LogonType = 2",
    "  $task.Principal.RunLevel = 1",
    "}",
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$action = $task.Actions.Create(0)",
    "$action.Path = $ps",
    "$action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $launcher + '\"'",
    "$trigger = $task.Triggers.Create(1)",
    "$trigger.StartBoundary = (Get-Date).AddMinutes(2).ToString('yyyy-MM-ddTHH:mm:ss')",
    "$trigger.Enabled = $true",
    "$null = $folder.RegisterTaskDefinition($UpdateTaskName, $task, 6, $null, $null, 0)",
    "$null = $folder.GetTask($UpdateTaskName).Run($null)",
    "Write-Output 'PLAYON_UPDATE_TASK_STARTED'",
    "",
  ].join("\n");
}

export function buildWmiLaunchScript(opts: { launcherPs1: string }): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$launcher = ${powershellSingleQuote(opts.launcherPs1)}`,
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$command = '\"' + $ps + '\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $launcher + '\"'",
    String.raw`$wmi = [wmiclass]"\\.\root\cimv2:Win32_Process"`,
    "$result = $wmi.Create($command)",
    "if (-not $result -or $result.ReturnValue -ne 0) {",
    "  $code = if ($result) { $result.ReturnValue } else { -1 }",
    '  throw "Win32_Process.Create failed: $code"',
    "}",
    'Write-Output ("PLAYON_WMI_PID=" + $result.ProcessId)',
    "",
  ].join("\n");
}

export function helperArmConfirmed(opts: { logSlice: string; markerText?: string | null }): boolean {
  if (opts.markerText && opts.markerText.trim().length > 0) return true;
  return opts.logSlice.includes(WINDOWS_HELPER_ARMED_MARK);
}

export type WindowsLaunchAttemptResult = { launched: boolean; detail?: string };

export async function runWindowsHelperLaunchAttempts(opts: {
  order?: readonly WindowsLaunchMethod[];
  timeoutMs?: number;
  settleMs?: number;
  attempt: (method: WindowsLaunchMethod) => Promise<WindowsLaunchAttemptResult>;
  confirm: () => Promise<boolean>;
  cleanup: (method: WindowsLaunchMethod) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<WindowsLaunchMethod> {
  const order = opts.order ?? windowsUpdateLaunchOrder();
  const timeoutMs = opts.timeoutMs ?? WINDOWS_HELPER_START_TIMEOUT_MS;
  const sleep = opts.sleep ?? delay;
  const log = opts.log ?? ((line: string) => console.error(line));
  const errors: string[] = [];
  for (const method of order) {
    let launched = false;
    try {
      const result = await opts.attempt(method);
      launched = result.launched;
      if (!launched) {
        errors.push(`${method}: ${result.detail || "did not launch"}`);
        await safeCleanup(opts.cleanup, method, errors);
        continue;
      }
    } catch (err) {
      errors.push(`${method}: ${errorText(err)}`);
      await safeCleanup(opts.cleanup, method, errors);
      continue;
    }
    const confirmed = await opts.confirm();
    if (confirmed) {
      if (opts.settleMs && opts.settleMs > 0) await sleep(opts.settleMs);
      return method;
    }
    errors.push(`${method}: no start marker within ${timeoutMs}ms`);
    log(`[node-agent] SELF-UPDATE helper not confirmed after ${method}`);
    await safeCleanup(opts.cleanup, method, errors);
  }
  const message =
    `update_helper_not_started: helper did not write a start marker (${errors.join("; ")}). ` +
    "Staying on the current version.";
  log(`[node-agent] SELF-UPDATE HELPER DID NOT START: ${message}`);
  log("[node-agent] staying on the current version; not exiting");
  throw new Error(message);
}

export type CapturedProcess = { code: number; stdout: string; stderr: string };

export async function waitForHelperStart(opts: {
  logPath: string;
  markerPath: string;
  logOffset: number;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const sleep = opts.sleep ?? delay;
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    if (
      helperArmConfirmed({
        markerText: readMarker(opts.markerPath),
        logSlice: readLogSlice(opts.logPath, opts.logOffset),
      })
    ) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

export async function launchWindowsUpdateHelper(opts: {
  helperScript: string;
  sourceDir: string;
  targetDir: string;
  agentPid: number;
  version: string;
  preserve: readonly string[];
  logPath: string;
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  registerTimeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  runFile?: (scriptPath: string) => Promise<CapturedProcess>;
  runSchtasks?: (args: string[]) => Promise<CapturedProcess>;
  stopProcess?: (pid: number) => Promise<void>;
}): Promise<{ method: WindowsLaunchMethod; logPath: string; markerPath: string; launcherPath: string }> {
  const logPath = opts.logPath;
  const markerPath = windowsHelperMarkerPath(logPath);
  const launcherPath = windowsHelperLauncherPath(logPath);
  const timeoutMs = opts.timeoutMs ?? WINDOWS_HELPER_START_TIMEOUT_MS;
  const registerTimeoutMs = opts.registerTimeoutMs ?? 25_000;
  const runFile = opts.runFile ?? ((scriptPath: string) => defaultRunFile(scriptPath, registerTimeoutMs));
  const runSchtasks =
    opts.runSchtasks ?? ((args: string[]) => runCaptured("schtasks.exe", args, registerTimeoutMs));
  const stopProcess = opts.stopProcess ?? defaultStopProcess;
  const helperArgs = buildWindowsHelperArguments({
    sourceDir: opts.sourceDir,
    targetDir: opts.targetDir,
    agentPid: opts.agentPid,
    version: opts.version,
    applyLog: logPath,
    startedMarker: markerPath,
    preserve: opts.preserve,
  });
  writePowerShellUtf8Bom(
    launcherPath,
    buildWindowsHelperLauncherPs1({
      helperScript: opts.helperScript,
      helperArgs,
      logPath,
    }),
  );
  const stem = path.basename(logPath).replace(/\.log$/i, "");
  const registerPath = path.join(path.dirname(launcherPath), `${stem}-register.ps1`);
  const wmiPath = path.join(path.dirname(launcherPath), `${stem}-wmi.ps1`);
  writePowerShellUtf8Bom(
    registerPath,
    buildScheduledTaskLaunchScript({ launcherPs1: launcherPath }),
  );
  writePowerShellUtf8Bom(wmiPath, buildWmiLaunchScript({ launcherPs1: launcherPath }));

  appendLog(
    logPath,
    `launching apply helper outside the agent job via ${WINDOWS_APPLY_UPDATE_TASK_NAME}`,
  );
  removeFile(markerPath);

  let logOffset = 0;
  let wmiPid: number | null = null;
  const logFailure = (line: string) => {
    console.error(line);
    appendLog(logPath, line.replace(/^\[node-agent\]\s*/, ""));
  };

  const method = await runWindowsHelperLaunchAttempts({
    timeoutMs,
    settleMs: opts.settleMs ?? WINDOWS_HELPER_SETTLE_MS,
    sleep: opts.sleep,
    log: logFailure,
    attempt: async (name) => {
      removeFile(markerPath);
      logOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      wmiPid = null;
      if (name === "scheduled-task") {
        const result = await runFile(registerPath);
        if (result.code !== 0 || !result.stdout.includes("PLAYON_UPDATE_TASK_STARTED")) {
          return { launched: false, detail: clip(result.stderr || result.stdout || `exit ${result.code}`) };
        }
        return { launched: true };
      }
      if (name === "schtasks") {
        const startTime = schtasksOnceLocalTime(opts.now?.() ?? new Date());
        let create = await runSchtasks(
          buildSchtasksCreateArgs({
            taskName: WINDOWS_APPLY_UPDATE_TASK_NAME,
            launcherPs1: launcherPath,
            startTime,
            highest: true,
          }),
        );
        if (create.code !== 0) {
          create = await runSchtasks(
            buildSchtasksCreateArgs({
              taskName: WINDOWS_APPLY_UPDATE_TASK_NAME,
              launcherPs1: launcherPath,
              startTime,
              highest: false,
            }),
          );
        }
        if (create.code !== 0) {
          return { launched: false, detail: clip(create.stderr || create.stdout || `create exit ${create.code}`) };
        }
        const run = await runSchtasks(["/Run", "/TN", WINDOWS_APPLY_UPDATE_TASK_NAME]);
        if (run.code !== 0) {
          return { launched: false, detail: clip(run.stderr || run.stdout || `run exit ${run.code}`) };
        }
        return { launched: true };
      }
      const result = await runFile(wmiPath);
      const match = result.stdout.match(/PLAYON_WMI_PID=(\d+)/);
      if (result.code !== 0 || !match) {
        return { launched: false, detail: clip(result.stderr || result.stdout || `exit ${result.code}`) };
      }
      wmiPid = Number(match[1]);
      return { launched: true };
    },
    confirm: () =>
      waitForHelperStart({
        logPath,
        markerPath,
        logOffset,
        timeoutMs,
        pollMs: opts.pollMs,
        sleep: opts.sleep,
      }),
    cleanup: async () => {
      await cleanupLaunch({ runSchtasks, stopProcess, wmiPid });
    },
  });

  appendLog(logPath, `helper armed via ${method}; agent will exit so the swap can finish`);
  console.log(`[node-agent] self-update helper armed via ${method}`);
  return { method, logPath, markerPath, launcherPath };
}

function writePowerShellUtf8Bom(filePath: string, text: string): void {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const body = Buffer.from(normalized, "utf8");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
}

function appendLog(logPath: string, message: string): void {
  const line = `[${new Date().toISOString()}] [node-agent] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // The apply log is best-effort once launch has been requested.
  }
}

function removeFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Missing marker is the not-started state.
  }
}

function readMarker(markerPath: string): string | null {
  try {
    return fs.readFileSync(markerPath, "utf8");
  } catch {
    return null;
  }
}

function readLogSlice(logPath: string, offset: number): string {
  try {
    const buf = fs.readFileSync(logPath);
    if (buf.length <= offset) return "";
    return buf.subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}

async function cleanupLaunch(opts: {
  runSchtasks: (args: string[]) => Promise<CapturedProcess>;
  stopProcess: (pid: number) => Promise<void>;
  wmiPid: number | null;
}): Promise<void> {
  await opts.runSchtasks(["/End", "/TN", WINDOWS_APPLY_UPDATE_TASK_NAME]).catch(() => undefined);
  await opts.runSchtasks(["/Delete", "/TN", WINDOWS_APPLY_UPDATE_TASK_NAME, "/F"]).catch(() => undefined);
  if (opts.wmiPid && opts.wmiPid > 0) {
    await opts.stopProcess(opts.wmiPid).catch(() => undefined);
  }
}

async function safeCleanup(
  cleanup: (method: WindowsLaunchMethod) => Promise<void>,
  method: WindowsLaunchMethod,
  errors: string[],
): Promise<void> {
  try {
    await cleanup(method);
  } catch (err) {
    errors.push(`${method} cleanup: ${errorText(err)}`);
  }
}

function defaultRunFile(scriptPath: string, timeoutMs: number): Promise<CapturedProcess> {
  return runCaptured(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    timeoutMs,
  );
}

function defaultStopProcess(pid: number): Promise<void> {
  return runCaptured("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 10_000).then(() => undefined);
}

function runCaptured(command: string, args: string[], timeoutMs: number): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-8000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.once("error", (err) => finish(() => reject(err)));
    child.once("close", (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(err: unknown): string {
  return clip(err instanceof Error ? err.message : String(err));
}

function clip(text: string, max = 400): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "failed";
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}
