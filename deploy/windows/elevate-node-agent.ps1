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

$start = Join-Path $InstallRoot "start-node.cmd"
if (-not (Test-Path $start)) {
  throw "Missing $start - install the Windows node first (install-node.ps1)."
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

Write-Host "==> Registering $TaskName as $userId (RunLevel Highest, S4U)"
$action = New-ScheduledTaskAction -Execute $start -WorkingDirectory $InstallRoot
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
$alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$InstallRoot*" }
if ($alive) {
  Write-Host "AGENT_UP PID=$($alive.ProcessId)"
} else {
  Write-Host "WARN: agent process not seen yet - check $InstallRoot\data\agent-stdout.log"
}
Write-Host "Done. Agent runs as $userId (elevated, S4U). Enable Linux runtime can proceed without a desktop session."
