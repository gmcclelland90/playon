param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$TargetDir,
  [Parameter(Mandatory = $true)][int]$AgentPid,
  [string[]]$Preserve = @("data", "env", "node.env", "node.env.cmd", "node.env.json"),
  [string]$ExpectedVersion = "",
  [string]$ApplyLog = "",
  [string]$StartedMarker = "",
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
  foreach ($path in @($LogFile, $ApplyLog)) {
    if (-not $path) { continue }
    try {
      Add-Content -Path $path -Value $line -ErrorAction SilentlyContinue
    } catch {
    }
  }
}

function ConvertTo-PsSingleQuoted {
  param([string]$Value)
  if ($null -eq $Value) { $Value = "" }
  return "'" + ($Value -replace "'", "''") + "'"
}

function Write-StartedMarker {
  if (-not $StartedMarker) { return }
  try {
    $markerDir = Split-Path -Parent $StartedMarker
    if ($markerDir -and -not (Test-Path -LiteralPath $markerDir)) {
      New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
    }
    [System.IO.File]::WriteAllText($StartedMarker, "pid=$PID`r`n", [System.Text.ASCIIEncoding]::new())
  } catch {
  }
}

# 0.2.19 spawns this script inside the PlayOnNodeAgent job and exits about
# 200ms later, which kills the process before later breakaway code can run.
# Schedule.Service does not import the ScheduledTasks module. The one-shot
# task copies the agent principal (S4U, Highest) and runs outside that job.
# If COM fails, Win32_Process.Create still escapes the job (#1060 / #1041).
function Start-ImmediateOneShotRelaunch {
  $captureLog = $ApplyLog
  if (-not $captureLog) { $captureLog = $LogFile }
  $launcher = Join-Path $env:TEMP "playon-ota-oneshot.ps1"
  $argParts = @(
    (ConvertTo-PsSingleQuoted "-SourceDir"), (ConvertTo-PsSingleQuoted $SourceDir),
    (ConvertTo-PsSingleQuoted "-TargetDir"), (ConvertTo-PsSingleQuoted $TargetDir),
    (ConvertTo-PsSingleQuoted "-AgentPid"), (ConvertTo-PsSingleQuoted "$AgentPid"),
    (ConvertTo-PsSingleQuoted "-Detached")
  )
  if ($ExpectedVersion) {
    $argParts += @((ConvertTo-PsSingleQuoted "-ExpectedVersion"), (ConvertTo-PsSingleQuoted $ExpectedVersion))
  }
  if ($ApplyLog) {
    $argParts += @((ConvertTo-PsSingleQuoted "-ApplyLog"), (ConvertTo-PsSingleQuoted $ApplyLog))
  }
  if ($StartedMarker) {
    $argParts += @((ConvertTo-PsSingleQuoted "-StartedMarker"), (ConvertTo-PsSingleQuoted $StartedMarker))
  }
  foreach ($name in $Preserve) {
    $argParts += @((ConvertTo-PsSingleQuoted "-Preserve"), (ConvertTo-PsSingleQuoted $name))
  }
  $joined = $argParts -join ",`r`n"
  $qLog = ConvertTo-PsSingleQuoted $captureLog
  $qHelper = ConvertTo-PsSingleQuoted $PSCommandPath
  $launcherText = @(
    '$ErrorActionPreference = ''Continue'''
    "`$log = $qLog"
    "`$helper = $qHelper"
    '$argList = @('
    "  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `$helper,"
    $joined
    ')'
    '$ps = Join-Path $env:SystemRoot ''System32\WindowsPowerShell\v1.0\powershell.exe'''
    '& $ps @argList 2>&1 | ForEach-Object {'
    '  try { Add-Content -LiteralPath $log -Value ([string]$_) -ErrorAction SilentlyContinue } catch {}'
    '}'
    'exit $LASTEXITCODE'
    ''
  ) -join "`r`n"
  $utf8Bom = New-Object System.Text.UTF8Encoding $true
  [System.IO.File]::WriteAllText($launcher, $launcherText, $utf8Bom)

  try {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $folder = $service.GetFolder("\")
    $task = $service.NewTask(0)
    $task.RegistrationInfo.Description = "PlayOn one-shot node self-update helper"
    $task.Settings.Enabled = $true
    $task.Settings.AllowDemandStart = $true
    $task.Settings.StartWhenAvailable = $true
    $task.Settings.DisallowStartIfOnBatteries = $false
    $task.Settings.StopIfGoingOnBatteries = $false
    $task.Settings.ExecutionTimeLimit = "PT1H"
    try {
      $existing = $folder.GetTask($TaskName)
      $p = $existing.Definition.Principal
      if ($p.UserId) { $task.Principal.UserId = [string]$p.UserId }
      if ($p.GroupId) { $task.Principal.GroupId = [string]$p.GroupId }
      $task.Principal.LogonType = $p.LogonType
      $task.Principal.RunLevel = $p.RunLevel
    } catch {
      $task.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      $task.Principal.LogonType = 2
      $task.Principal.RunLevel = 1
    }
    $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $action = $task.Actions.Create(0)
    $action.Path = $psExe
    $action.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
    $trigger = $task.Triggers.Create(1)
    $trigger.StartBoundary = (Get-Date).AddMinutes(2).ToString("yyyy-MM-ddTHH:mm:ss")
    $trigger.Enabled = $true
    $null = $folder.RegisterTaskDefinition($UpdateTaskName, $task, 6, $null, $null, 0)
    $null = $folder.GetTask($UpdateTaskName).Run($null)
    return $true
  } catch {
    Write-Log "WARNING: immediate one-shot $UpdateTaskName failed: $_"
    try { & schtasks.exe /Delete /TN $UpdateTaskName /F 2>$null | Out-Null } catch {}
  }

  try {
    $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $command = "`"$psExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
    $wmi = [wmiclass]"\\.\root\cimv2:Win32_Process"
    $created = $wmi.Create($command)
    if (-not $created -or $created.ReturnValue -ne 0) {
      $code = if ($created) { $created.ReturnValue } else { -1 }
      throw "Win32_Process.Create failed: $code"
    }
    Write-Log "immediate WMI helper pid=$($created.ProcessId)"
    return $true
  } catch {
    Write-Log "WARNING: immediate WMI launch failed: $_"
    return $false
  }
}

# Before any swap work. 0.2.19 is still inside the agent job here, so the
# one-shot relaunch above is the first side effect. -ApplyLog and the
# launcher's 2>&1 redirect both land in data/ota-apply-<jobId>.log (#1060).
if (-not $Detached) {
  $immediateOk = $false
  try {
    $immediateOk = Start-ImmediateOneShotRelaunch
  } catch {
    Write-Log "WARNING: immediate one-shot relaunch failed: $_"
  }
  if ($immediateOk) {
    try { & schtasks.exe /Change /TN $TaskName /DISABLE 2>$null | Out-Null } catch {}
    Write-Log "immediate one-shot $UpdateTaskName started; in-job helper exiting"
    exit 0
  }
}

Write-Log "start pid=$PID detached=$([bool]$Detached) agent=$AgentPid source=$SourceDir target=$TargetDir"

# Leftover double-click launcher. Task action is node.exe - never >> logfile.
function Write-PortableStartNodeCmd {
  param([string]$Dir)
  $portable = Join-Path $Dir "start-node.cmd"
  $text = @"
@echo off
cd /d "%~dp0"
if exist "%~dp0node.env.cmd" call "%~dp0node.env.cmd"
if defined PLAYON_DATA_ROOT if not exist "%PLAYON_DATA_ROOT%" mkdir "%PLAYON_DATA_ROOT%"
if exist "%~dp0load-env.cjs" (
  "%~dp0runtime\node\node.exe" --require "%~dp0load-env.cjs" "%~dp0apps\node-agent\dist\index.js"
) else (
  "%~dp0runtime\node\node.exe" "%~dp0apps\node-agent\dist\index.js"
)
"@
  $crlf = ($text -replace "`r`n", "`n" -replace "`n", "`r`n")
  if (-not $crlf.EndsWith("`r`n")) { $crlf += "`r`n" }
  [System.IO.File]::WriteAllText($portable, $crlf, [System.Text.ASCIIEncoding]::new())
  Write-Log "Wrote leftover start-node.cmd (no logfile redirect)"
}

function Restore-NodeAgentTask {
  param([string]$Reason)
  Write-Log $Reason
  try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Unregister-ApplyUpdateTask
}

function Register-PlayOnNodeAgentTaskFromTree {
  param([string]$TargetDir)
  $nodeExe = Join-Path $TargetDir "runtime\node\node.exe"
  $agentJs = Join-Path $TargetDir "apps\node-agent\dist\index.js"
  $loadEnv = Join-Path $TargetDir "load-env.cjs"
  if (-not (Test-Path $nodeExe) -or -not (Test-Path $agentJs)) {
    throw "Missing node.exe or agent entry after swap"
  }
  if (-not (Test-Path $loadEnv)) {
    $fromSource = Join-Path $SourceDir "load-env.cjs"
    $fromDeploy = Join-Path $SourceDir "deploy\windows\load-env.cjs"
    if (Test-Path $fromSource) { Copy-Item -Force $fromSource $loadEnv }
    elseif (Test-Path $fromDeploy) { Copy-Item -Force $fromDeploy $loadEnv }
  }
  $arg = "--require `"$loadEnv`" `"$agentJs`""
  $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $arg -WorkingDirectory $TargetDir
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $userId = if ($existing) { $existing.Principal.UserId } else { [Security.Principal.WindowsIdentity]::GetCurrent().Name }
  $logon = if ($existing) { $existing.Principal.LogonType } else { "S4U" }
  $runLevel = if ($existing) { $existing.Principal.RunLevel } else { "Highest" }
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $logon -RunLevel $runLevel
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Log "Registered $TaskName -> $nodeExe $arg"
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
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", $PSCommandPath,
    "-SourceDir", $SourceDir,
    "-TargetDir", $TargetDir,
    "-AgentPid", "$AgentPid",
    "-Detached"
  )
  if ($ExpectedVersion) {
    $relaunch += @("-ExpectedVersion", $ExpectedVersion)
  }
  if ($ApplyLog) {
    $relaunch += @("-ApplyLog", $ApplyLog)
  }
  if ($StartedMarker) {
    $relaunch += @("-StartedMarker", $StartedMarker)
  }
  foreach ($name in $Preserve) {
    $relaunch += @("-Preserve", $name)
  }
  return $relaunch
}

function Get-WslDistroName {
  if ($env:PLAYON_WSL_DISTRO) { return $env:PLAYON_WSL_DISTRO.Trim() }
  return "playon-linux"
}

function Get-TreeVersion {
  param([string]$Dir)
  foreach ($rel in @("apps\node-agent\package.json", "package.json")) {
    $pkg = Join-Path $Dir $rel
    if (-not (Test-Path $pkg)) { continue }
    try {
      $json = Get-Content -LiteralPath $pkg -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($json.version) { return (([string]$json.version).Trim() -replace '^[vV]', '') }
    } catch {
    }
  }
  return ""
}

function Test-CommandLineIsTargetAgent {
  param([string]$CommandLine, [string]$InstallRoot)
  if (-not $CommandLine) { return $false }
  $root = $InstallRoot.TrimEnd("\")
  $inRoot = $CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
  if (-not $inRoot) { return $false }
  return $CommandLine -match 'apps[\\/]node-agent[\\/]dist[\\/]index\.js'
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
  Start-BreakawayProcess -CommandLine "powershell.exe $argString" -LogLabel "apply-helper"
}

function Start-BreakawayProcess {
  param(
    [string]$CommandLine,
    [string]$LogLabel = "helper"
  )
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
  $flags = [PlayOnBreakaway]::CREATE_BREAKAWAY_FROM_JOB -bor [PlayOnBreakaway]::CREATE_NEW_PROCESS_GROUP -bor [PlayOnBreakaway]::CREATE_NO_WINDOW
  $ok = [PlayOnBreakaway]::CreateProcess(
    $null, $CommandLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags,
    [IntPtr]::Zero, $null, [ref]$si, [ref]$pi
  )
  if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "CreateProcess breakaway failed (Win32 $err)"
  }
  Write-Log "Started breakaway $LogLabel pid=$($pi.dwProcessId)."
}

# Keep playon-linux awake while PlayOnNodeAgent's Job object tears down.
# Killing wsl.exe (or the hold child) idles the distro and takes the WSL sibling
# offline - do not Stop-Process wsl.exe (#1040 / #837).
function Start-WslSiblingHold {
  $distro = Get-WslDistroName
  $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
  if (-not $wsl) {
    Write-Log "WSL not present; skip sibling hold"
    return
  }
  try {
    $cmd = "wsl.exe -d $distro -u root -- bash -lc `"exec sleep infinity`""
    Start-BreakawayProcess -CommandLine $cmd -LogLabel "wsl-hold"
  } catch {
    Write-Log "WARNING: WSL sibling hold failed: $_"
  }
}

function Start-WslSiblingAgent {
  $distro = Get-WslDistroName
  $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
  if (-not $wsl) { return }
  try {
    & wsl.exe -d $distro -u root -- systemctl start playon-node-agent.service | Out-Null
    Write-Log "Poked WSL sibling agent distro=$distro"
  } catch {
    Write-Log "WARNING: WSL sibling poke failed: $_"
  }
}

function Stop-TargetAgentPid {
  param([int]$PidToStop)
  if ($PidToStop -le 0) { return }
  Write-Log "Force stopping target node-agent PID=$PidToStop only (no wsl.exe, no sibling agents)"
  Stop-Process -Id $PidToStop -Force -ErrorAction SilentlyContinue
}

# 0.2.3+ agents spawn this script as a child of PlayOnNodeAgent. Task Scheduler
# RestartCount would start the *old* binary before the swap, and a Job object
# would kill this helper (and the WSL hold) when the agent PID exits. Relaunch
# the apply helper and a WSL hold outside that Job *before* disabling the task
# (#1040).
if (-not $Detached) {
  Start-WslSiblingHold
  Start-BreakawayHelper
  Disable-NodeAgentTask
  exit 0
}

Disable-NodeAgentTask
Start-WslSiblingHold
# Marker is written only after the agent task is disabled and the WSL hold
# has been started, so the agent can exit without RestartCount racing the swap.
Write-StartedMarker
Write-Log "helper armed pid=$PID"

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
  Write-Log "Process still running after ${maxWaitSec}s, force stopping target PID only..."
  Stop-TargetAgentPid -PidToStop $AgentPid
  Start-Sleep -Seconds 2
} catch {
}

if (-not (Test-Path $SourceDir)) {
  Restore-NodeAgentTask -Reason "ERROR: Source directory not found: $SourceDir - leaving previous agent"
  exit 1
}

if ($ExpectedVersion) {
  $want = $ExpectedVersion.Trim() -replace '^[vV]', ''
  $srcVer = Get-TreeVersion -Dir $SourceDir
  if ($srcVer -and $srcVer -ne $want) {
    Restore-NodeAgentTask -Reason "ERROR: package version $srcVer != expected $want - not swapping"
    exit 1
  }
}

Write-Log "Swapping install tree: $SourceDir -> $TargetDir"
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
  try {
    Remove-Item -Path $dest -Recurse -Force -ErrorAction Stop
  } catch {
    if ($_.Exception.Message -match "being used by another process|EBUSY|cannot access|locked") {
      Restore-NodeAgentTask -Reason "ERROR: swap locked removing $($item.Name): $_ - aborting, previous tree kept where possible"
      exit 1
    }
  }
  try {
    Copy-Item -Path $item.FullName -Destination $dest -Recurse -Force -ErrorAction Stop
  } catch {
    if ($_.Exception.Message -match "being used by another process|EBUSY|cannot access|locked") {
      Restore-NodeAgentTask -Reason "ERROR: swap locked copying $($item.Name): $_ - aborting, restarting previous agent"
      exit 1
    }
    throw
  }
}

if ($ExpectedVersion) {
  $want = $ExpectedVersion.Trim() -replace '^[vV]', ''
  $got = Get-TreeVersion -Dir $TargetDir
  if (-not $got) {
    Restore-NodeAgentTask -Reason "ERROR: swapped tree has no package version (expected $want)"
    exit 1
  }
  if ($got -ne $want) {
    Restore-NodeAgentTask -Reason "ERROR: swapped version $got != expected $want - leaving previous agent"
    exit 1
  }
  Write-Log "Swapped tree version $got matches expected"
}

Write-PortableStartNodeCmd -Dir $TargetDir

$nodeExe = Join-Path $TargetDir "runtime\node\node.exe"
$agentJs = Join-Path $TargetDir "apps\node-agent\dist\index.js"
$useBundled = Test-Path $nodeExe

if (-not (Test-Path $agentJs)) {
  Restore-NodeAgentTask -Reason "ERROR: Agent missing after swap: $agentJs"
  exit 1
}

$envFile = Join-Path $TargetDir "node.env.cmd"
if (Test-Path $envFile) {
  $rawEnv = [System.IO.File]::ReadAllText($envFile)
  $crlfEnv = ($rawEnv -replace "`r`n", "`n" -replace "`n", "`r`n")
  if (-not $crlfEnv.EndsWith("`r`n")) { $crlfEnv += "`r`n" }
  [System.IO.File]::WriteAllText($envFile, $crlfEnv, [System.Text.ASCIIEncoding]::new())
  Write-Log "Rewrote node.env.cmd as CRLF"
} else {
  Write-Log "WARNING: node.env.cmd missing - load-env.cjs will use node.env.json if present"
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

$loadEnvFile = Join-Path $TargetDir "load-env.cjs"
if ($useBundled) {
  $startText = @"
@echo off
call `"$envFile`"
cd /d `"$TargetDir`"
if not exist `"$dataRoot`" mkdir `"$dataRoot`"
`"$nodeExe`" --require `"$loadEnvFile`" `"$agentJs`"
"@
} else {
  $startText = @"
@echo off
call `"$envFile`"
cd /d `"$TargetDir`"
if not exist `"$dataRoot`" mkdir `"$dataRoot`"
pnpm --filter @playon/node-agent start
"@
}
$crlfStart = ($startText -replace "`r`n", "`n" -replace "`n", "`r`n")
if (-not $crlfStart.EndsWith("`r`n")) { $crlfStart += "`r`n" }
[System.IO.File]::WriteAllText($startCmd, $crlfStart, [System.Text.ASCIIEncoding]::new())
Write-Log "Regenerated leftover start-node.cmd (no logfile redirect)"

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

Write-Log "Re-registering $TaskName as node.exe (not start-node.cmd)..."
try {
  Register-PlayOnNodeAgentTaskFromTree -TargetDir $TargetDir
} catch {
  Write-Log "WARNING: could not rewrite task action: $_"
  try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
}

Write-Log "Starting $TaskName..."
try {
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Write-Log "Update complete and agent restarted."
} catch {
  Write-Log "ERROR: Failed to start ${TaskName}: $_"
  Unregister-ApplyUpdateTask
  exit 1
}

$seen = $false
for ($i = 0; $i -lt 20 -and -not $seen; $i++) {
  Start-Sleep -Milliseconds 500
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if (Test-CommandLineIsTargetAgent -CommandLine $p.CommandLine -InstallRoot $TargetDir) {
      Write-Log "New node-agent PID=$($p.ProcessId) under $TargetDir"
      $seen = $true
      break
    }
  }
}
if (-not $seen) {
  Write-Log "WARNING: new node-agent process not seen yet under $TargetDir"
}

Start-WslSiblingAgent

Unregister-ApplyUpdateTask
Write-Log "Self-update completed successfully."
