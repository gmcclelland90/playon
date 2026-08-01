#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Bootstrap a Windows host as a PlayOn blank node (node-agent heartbeat).

.EXAMPLE
  $env:PLAYON_API_URL = "http://192.168.1.10:8787"
  $env:PLAYON_NODE_TOKEN = "change-me"
  $env:PLAYON_NODE_ID = "lab-win"
  .\bootstrap.ps1
#>
$ErrorActionPreference = "Stop"

function Require-Env([string]$Name) {
  $val = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($val)) {
    throw "Set environment variable $Name before running."
  }
  return $val
}

$apiUrl = Require-Env "PLAYON_API_URL"
$token = Require-Env "PLAYON_NODE_TOKEN"
$nodeId = if ($env:PLAYON_NODE_ID) { $env:PLAYON_NODE_ID } else { $env:COMPUTERNAME }
$nodeName = if ($env:PLAYON_NODE_NAME) { $env:PLAYON_NODE_NAME } else { $env:COMPUTERNAME }
$dataRoot = if ($env:PLAYON_DATA_ROOT) { $env:PLAYON_DATA_ROOT } else { "C:\playon\data" }
$repo = if ($env:PLAYON_REPO) { $env:PLAYON_REPO } else { "C:\playon\src\playon" }
$heartbeatMs = if ($env:PLAYON_HEARTBEAT_MS) { $env:PLAYON_HEARTBEAT_MS } else { "5000" }

Write-Host "PlayOn blank-node bootstrap → $apiUrl as $nodeId"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Node.js 22 via winget..."
  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [System.Environment]::GetEnvironmentVariable("Path", "User")
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  npm install -g pnpm@9
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Warning @"
Docker was not found on PATH.
For containerised game skills, install Docker Desktop and enable the engine,
then re-open this shell. The node-agent will still heartbeat without Docker.
"@
}

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $repo -Parent) | Out-Null

if (-not (Test-Path (Join-Path $repo "package.json"))) {
  Write-Error @"
PlayOn repo not found at $repo.
Copy or clone the monorepo there, set PLAYON_REPO if needed, then re-run.
"@
}

Push-Location $repo
try {
  pnpm install --filter "@playon/node-agent..."
  pnpm --filter "@playon/node-agent" build
} finally {
  Pop-Location
}

$envFile = "C:\playon\node.env.cmd"
@"
@echo off
set PLAYON_API_URL=$apiUrl
set PLAYON_NODE_TOKEN=$token
set PLAYON_NODE_ID=$nodeId
set PLAYON_NODE_NAME=$nodeName
set PLAYON_DATA_ROOT=$dataRoot
set PLAYON_HEARTBEAT_MS=$heartbeatMs
"@ | Set-Content -Path $envFile -Encoding ASCII

$taskName = "PlayOnNodeAgent"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$envFile && cd /d $repo && pnpm --filter @playon/node-agent start`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Scheduled task '$taskName' started. Check control-plane Dashboard → Nodes for status: online."
