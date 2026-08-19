param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$TargetDir,
  [Parameter(Mandatory = $true)][int]$AgentPid,
  [string[]]$Preserve = @("data", "env", "node.env", "node.env.cmd"),
  [switch]$Detached
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$TaskName = "PlayOnNodeAgent"
$UpdateTaskName = "PlayOnNodeAgentApplyUpdate"
$LogFile = Join-Path $env:TEMP "playon-apply-self-update.log"

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$timestamp] [apply-self-update] $Message"
  Write-Host $line
  try {
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
  } catch {
  }
}

# Tarball start-node.cmd (0.2.3–0.2.9) omitted `call node.env.cmd`. Write this
# immediately after swap so a later failure cannot leave localhost wiring.
function Write-PortableStartNodeCmd {
  param([string]$Dir)
  $portable = Join-Path $Dir "start-node.cmd"
  @"
@echo off
cd /d "%~dp0"
if exist "%~dp0node.env.cmd" call "%~dp0node.env.cmd"
if defined PLAYON_DATA_ROOT if not exist "%PLAYON_DATA_ROOT%" mkdir "%PLAYON_DATA_ROOT%"
if defined PLAYON_DATA_ROOT (
  "%~dp0runtime\node\node.exe" "%~dp0apps\node-agent\dist\index.js" >> "%PLAYON_DATA_ROOT%\agent-stdout.log" 2>&1
) else (
  "%~dp0runtime\node\node.exe" "%~dp0apps\node-agent\dist\index.js"
)
"@ | Set-Content -Path $portable -Encoding ASCII
  Write-Log "Wrote start-node.cmd with node.env.cmd wiring"
}

function Format-ProcessArgs {
  param([string[]]$Parts)
  return ($Parts | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '""') + '"' } else { $_ }
  }) -join " "
}

function Disable-NodeAgentTask {
  try {
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
    Write-Log "Disabled scheduled task $TaskName (blocks RestartCount while swapping)."
  } catch {
    Write-Log "WARNING: could not disable $TaskName : $_"
  }
}

function Unregister-ApplyUpdateTask {
  try { Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
}

function Get-RelaunchArgList {
  $relaunch = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $PSCommandPath,
    "-SourceDir", $SourceDir,
    "-TargetDir", $TargetDir,
    "-AgentPid", "$AgentPid",
    "-Detached"
  )
  foreach ($name in $Preserve) {
    $relaunch += @("-Preserve", $name)
  }
  return $relaunch
}

# Start-Process stays in the PlayOnNodeAgent Job; Task Scheduler then kills
# the helper when the agent PID exits (zip never lands). Break away with a
# one-shot task, or CREATE_BREAKAWAY_FROM_JOB if that register fails.
function Start-BreakawayHelper {
  $argList = Get-RelaunchArgList
  $argString = Format-ProcessArgs $argList
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    try {
      $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argString
      $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1)
      $p = $existing.Principal
      $principal = New-ScheduledTaskPrincipal `
        -UserId $p.UserId `
        -LogonType $p.LogonType `
        -RunLevel $p.RunLevel
      Register-ScheduledTask `
        -TaskName $UpdateTaskName `
        -Action $action `
        -Principal $principal `
        -Settings $settings `
        -Force | Out-Null
      Start-ScheduledTask -TaskName $UpdateTaskName -ErrorAction Stop
      Write-Log "Started one-shot $UpdateTaskName (pid=$AgentPid source=$SourceDir)."
      return
    } catch {
      Write-Log "WARNING: one-shot $UpdateTaskName failed: $_. Falling back to CREATE_BREAKAWAY_FROM_JOB."
    }
  } else {
    Write-Log "WARNING: $TaskName missing; CREATE_BREAKAWAY_FROM_JOB fallback."
  }
  Start-BreakawayProcess -ArgString $argString
}

function Start-BreakawayProcess {
  param([string]$ArgString)
  if (-not ("PlayOnBreakaway" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PlayOnBreakaway {
  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFO {
    public int cb;
    public IntPtr lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(
    string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
    IntPtr lpEnvironment, string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
  public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
  public const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
  public const uint CREATE_NO_WINDOW = 0x08000000;
}
"@
  }
  $si = New-Object PlayOnBreakaway+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf([type][PlayOnBreakaway+STARTUPINFO])
  $pi = New-Object PlayOnBreakaway+PROCESS_INFORMATION
  $cmd = "powershell.exe $ArgString"
  $flags = [PlayOnBreakaway]::CREATE_BREAKAWAY_FROM_JOB -bor [PlayOnBreakaway]::CREATE_NEW_PROCESS_GROUP -bor [PlayOnBreakaway]::CREATE_NO_WINDOW
  $ok = [PlayOnBreakaway]::CreateProcess(
    $null, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags,
    [IntPtr]::Zero, $null, [ref]$si, [ref]$pi
  )
  if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "CreateProcess breakaway failed (Win32 $err)"
  }
  Write-Log "Started breakaway helper pid=$($pi.dwProcessId)."
}

# 0.2.3+ agents spawn this script as a child of PlayOnNodeAgent. Task Scheduler
# RestartCount would start the *old* binary before the swap, and a Job object
# would kill this helper when the agent PID exits. Relaunch outside that Job.
if (-not $Detached) {
  Disable-NodeAgentTask
  Start-BreakawayHelper
  exit 0
}

Disable-NodeAgentTask

Write-Log "Waiting for node-agent process PID=$AgentPid to exit..."
$maxWaitSec = 60
$waited = 0
while ($waited -lt $maxWaitSec) {
  try {
    $null = Get-Process -Id $AgentPid -ErrorAction Stop
    Start-Sleep -Milliseconds 500
    $waited += 0.5
  } catch {
    Write-Log "Process exited."
    break
  }
}

try {
  $null = Get-Process -Id $AgentPid -ErrorAction Stop
  Write-Log "Process still running after ${maxWaitSec}s, force stopping..."
  Stop-Process -Id $AgentPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
} catch {
}

if (-not (Test-Path $SourceDir)) {
  Write-Log "ERROR: Source directory not found: $SourceDir"
  try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
  Unregister-ApplyUpdateTask
  exit 1
}

Write-Log "Swapping install tree: $SourceDir → $TargetDir"
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

$sourceNames = @((Get-ChildItem -Path $SourceDir).Name)
foreach ($item in Get-ChildItem -Path $TargetDir) {
  if ($Preserve -contains $item.Name) {
    Write-Log "Preserving: $($item.Name)"
    continue
  }
  if ($sourceNames -notcontains $item.Name) {
    Write-Log "Removing stale: $($item.Name)"
    Remove-Item -Path $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}

foreach ($item in Get-ChildItem -Path $SourceDir) {
  $dest = Join-Path $TargetDir $item.Name
  if ($Preserve -contains $item.Name -and (Test-Path $dest)) {
    Write-Log "Skipping preserved: $($item.Name)"
    continue
  }
  Write-Log "Copying: $($item.Name)"
  Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -Path $item.FullName -Destination $dest -Recurse -Force
}

Write-PortableStartNodeCmd -Dir $TargetDir

$nodeExe = Join-Path $TargetDir "runtime\node\node.exe"
$agentJs = Join-Path $TargetDir "apps\node-agent\dist\index.js"
$useBundled = Test-Path $nodeExe

if (-not (Test-Path $agentJs)) {
  Write-Log "ERROR: Agent missing after swap: $agentJs"
  try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
  Unregister-ApplyUpdateTask
  exit 1
}

$envFile = Join-Path $TargetDir "node.env.cmd"
if (-not (Test-Path $envFile)) {
  Write-Log "ERROR: node.env.cmd missing — cannot regenerate installer start-node.cmd; portable launcher already written"
  try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
  Unregister-ApplyUpdateTask
  exit 1
}

$startCmd = Join-Path $TargetDir "start-node.cmd"
$dataRoot = $env:PLAYON_DATA_ROOT
if (-not $dataRoot) {
  if (Test-Path $envFile) {
    $envContent = Get-Content $envFile -Raw
    if ($envContent -match 'set PLAYON_DATA_ROOT=(.+)') {
      $dataRoot = $matches[1].Trim()
    }
  }
}
if (-not $dataRoot) {
  $dataRoot = Join-Path $TargetDir "data"
}

$agentStdout = Join-Path $dataRoot "agent-stdout.log"

if ($useBundled) {
  @"
@echo off
call `"$envFile`"
cd /d `"$TargetDir`"
if not exist `"$dataRoot`" mkdir `"$dataRoot`"
`"$nodeExe`" `"$agentJs`" >> `"$agentStdout`" 2>&1
"@ | Set-Content -Path $startCmd -Encoding ASCII
  Write-Log "Regenerated start-node.cmd (bundled Node)"
} else {
  @"
@echo off
call `"$envFile`"
cd /d `"$TargetDir`"
if not exist `"$dataRoot`" mkdir `"$dataRoot`"
pnpm --filter @playon/node-agent start >> `"$agentStdout`" 2>&1
"@ | Set-Content -Path $startCmd -Encoding ASCII
  Write-Log "Regenerated start-node.cmd (system Node)"
}

Write-Log "Linking workspace dependencies..."
$env:Path = (Join-Path $TargetDir "runtime\node") + ";" + $env:Path
$env:CI = "true"
Push-Location $TargetDir
try {
  if ($useBundled) {
    & (Join-Path $TargetDir "runtime\node\corepack.cmd") pnpm install --prod --force 2>&1 | Out-String | ForEach-Object { Write-Log $_ }
  } else {
    pnpm install --prod --frozen-lockfile=$false 2>&1 | Out-String | ForEach-Object { Write-Log $_ }
  }
} catch {
  Write-Log "WARNING: pnpm install failed: $_"
} finally {
  Pop-Location
}

Write-Log "Re-enabling and starting $TaskName..."
try {
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Write-Log "Update complete and agent restarted."
} catch {
  Write-Log "ERROR: Failed to start ${TaskName}: $_"
  Unregister-ApplyUpdateTask
  exit 1
}

Unregister-ApplyUpdateTask
Write-Log "Self-update completed successfully."
