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

function Disable-NodeAgentTask {
  try {
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
    Write-Log "Disabled scheduled task $TaskName (blocks RestartCount while swapping)."
  } catch {
    Write-Log "WARNING: could not disable $TaskName : $_"
  }
}

# 0.2.3+ agents spawn this script as a child of PlayOnNodeAgent. Task Scheduler
# RestartCount would start the *old* binary before the swap, and a Job object
# would kill this helper when the agent PID exits. Relaunch detached first.
if (-not $Detached) {
  Disable-NodeAgentTask
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
  Write-Log "Relaunching detached helper (pid=$AgentPid source=$SourceDir)."
  Start-Process -FilePath "powershell.exe" -ArgumentList $relaunch -WindowStyle Hidden | Out-Null
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

$nodeExe = Join-Path $TargetDir "runtime\node\node.exe"
$agentJs = Join-Path $TargetDir "apps\node-agent\dist\index.js"
$useBundled = Test-Path $nodeExe

if (-not (Test-Path $agentJs)) {
  Write-Log "ERROR: Agent missing after swap: $agentJs"
  try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
  exit 1
}

$envFile = Join-Path $TargetDir "node.env.cmd"
if (-not (Test-Path $envFile)) {
  Write-Log "ERROR: node.env.cmd missing — cannot regenerate start-node.cmd without environment"
  try { Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
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
  exit 1
}

Write-Log "Self-update completed successfully."
