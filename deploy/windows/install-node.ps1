param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$NodeId = $env:COMPUTERNAME,
  [string]$InstallRoot = "C:\playon-node",
  [string]$DataRoot = "C:\playon-node\data",
  [ValidateSet("native", "docker")]
  [string]$Runtime = "native"
)

$ErrorActionPreference = "Stop"
$BundleRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
}
corepack enable
corepack prepare pnpm@9.15.4 --activate

New-Item -ItemType Directory -Force -Path $InstallRoot, $DataRoot | Out-Null
Copy-Item -Recurse -Force (Join-Path $BundleRoot "*") $InstallRoot
Push-Location $InstallRoot
pnpm install --prod --frozen-lockfile=false
Pop-Location

$envFile = Join-Path $InstallRoot "node.env.cmd"
@"
set PLAYON_API_URL=$ApiUrl
set PLAYON_NODE_TOKEN=$Token
set PLAYON_NODE_ID=$NodeId
set PLAYON_NODE_NAME=$NodeId
set PLAYON_DATA_ROOT=$DataRoot
set PLAYON_RUNTIME=$Runtime
"@ | Set-Content -Path $envFile -Encoding ASCII

$start = Join-Path $InstallRoot "start-node.cmd"
@"
@echo off
call `"$envFile`"
cd /d `"$InstallRoot`"
pnpm --filter @playon/node-agent start
"@ | Set-Content -Path $start -Encoding ASCII

$action = New-ScheduledTaskAction -Execute $start
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "PlayOnNodeAgent" -Action $action -Trigger $trigger -Force | Out-Null
Start-ScheduledTask -TaskName "PlayOnNodeAgent"
Write-Host "Node $NodeId joining $ApiUrl"
