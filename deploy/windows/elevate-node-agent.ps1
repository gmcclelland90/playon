# Re-register PlayOnNodeAgent as the current admin user with RunLevel Highest.
# WSL cannot run as SYSTEM (WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED). Use S4U so the
# agent stays up without an interactive desktop session, while still owning that
# user's WSL distros.
param(
  [string]$InstallRoot = "C:\playon-node",
  [string]$TaskName = "PlayOnNodeAgent"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Run elevate-node-agent.ps1 from an elevated PowerShell (Run as administrator)."
}

$nodeExe = Join-Path $InstallRoot "runtime\node\node.exe"
$agentJs = Join-Path $InstallRoot "apps\node-agent\dist\index.js"
$loadEnv = Join-Path $InstallRoot "load-env.cjs"
if (-not (Test-Path $agentJs)) {
  throw "Missing $agentJs - install the Windows node first (install-node.ps1)."
}
if (-not (Test-Path $nodeExe)) {
  throw "Missing $nodeExe - install the Windows node first (install-node.ps1)."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userId = $identity.Name
Write-Host "==> Stopping existing agent processes under $InstallRoot"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*apps\node-agent\dist\index.js*" } |
  ForEach-Object {
    Write-Host "Stopping PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

if (-not (Test-Path $loadEnv)) {
  $bundled = Join-Path $PSScriptRoot "load-env.cjs"
  if (Test-Path $bundled) {
    Copy-Item -Force $bundled $loadEnv
  } else {
    throw "Missing $loadEnv — copy deploy/windows/load-env.cjs next to the agent or re-run install-node.ps1."
  }
}

# Leftover node.env.cmd must be CRLF so a human `call` cannot hang cmd.exe.
$envCmd = Join-Path $InstallRoot "node.env.cmd"
if (Test-Path $envCmd) {
  $raw = [System.IO.File]::ReadAllText($envCmd)
  $crlf = ($raw -replace "`r`n", "`n" -replace "`n", "`r`n")
  if (-not $crlf.EndsWith("`r`n")) { $crlf += "`r`n" }
  [System.IO.File]::WriteAllText($envCmd, $crlf, [System.Text.ASCIIEncoding]::new())
}

Write-Host "==> Registering $TaskName as $userId (RunLevel Highest, S4U, node.exe)"
$arg = "--require `"$loadEnv`" `"$agentJs`""
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $arg -WorkingDirectory $InstallRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType S4U `
  -RunLevel Highest
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Principal: $($task.Principal.UserId) RunLevel=$($task.Principal.RunLevel) LogonType=$($task.Principal.LogonType)"
Write-Host "Action: $nodeExe $arg"
$alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$InstallRoot*" }
if ($alive) {
  Write-Host "AGENT_UP PID=$($alive.ProcessId)"
} else {
  Write-Host "WARN: agent process not seen yet - check $InstallRoot\data\agent-stdout.log"
}
Write-Host "Done. Agent runs as $userId (elevated, S4U). Enable Linux runtime can proceed without a desktop session."
