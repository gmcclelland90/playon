# PlayOn Home — Windows install (no Docker required).
# Run elevated PowerShell from an extracted Home bundle.
param(
  [string]$InstallRoot = "C:\playon",
  [string]$DataRoot = "C:\playon\data",
  [string]$AdvertiseHost = "",
  [ValidateSet("native", "docker")]
  [string]$Runtime = "native"
)

$ErrorActionPreference = "Stop"
$BundleRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path (Join-Path $BundleRoot "apps\api\dist\index.js"))) {
  $BundleRoot = Split-Path $PSScriptRoot -Parent
  $BundleRoot = Split-Path $BundleRoot -Parent
}

Write-Host "==> PlayOn Home → $InstallRoot"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Node.js 22 via winget..."
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
}

corepack enable
corepack prepare pnpm@9.15.4 --activate

New-Item -ItemType Directory -Force -Path $InstallRoot, $DataRoot | Out-Null
Copy-Item -Recurse -Force (Join-Path $BundleRoot "*") $InstallRoot

Push-Location $InstallRoot
pnpm install --prod --frozen-lockfile=false
Pop-Location

if (-not $AdvertiseHost) {
  $AdvertiseHost = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
    Select-Object -First 1 -ExpandProperty IPAddress)
  if (-not $AdvertiseHost) { $AdvertiseHost = "127.0.0.1" }
}

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$sessionSecret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
$tokenBytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes)
$nodeToken = ($tokenBytes | ForEach-Object { $_.ToString("x2") }) -join ""

$envDir = Join-Path $InstallRoot "env"
New-Item -ItemType Directory -Force -Path $envDir | Out-Null
$envFile = Join-Path $envDir "playon.env.cmd"
@"
set PLAYON_ENV=production
set PLAYON_HOST=0.0.0.0
set PLAYON_PORT=8787
set PLAYON_ADVERTISE_HOST=$AdvertiseHost
set PLAYON_SESSION_SECRET=$sessionSecret
set PLAYON_DATA_ROOT=$DataRoot
set PLAYON_RUNTIME=$Runtime
set PLAYON_LLM_MODE=openai_compatible
set PLAYON_NODE_TOKEN=$nodeToken
set PLAYON_SKILLS_ROOT=$InstallRoot\skills
set PLAYON_SKILLS_PROFILE=minimal
set PLAYON_WEB_DIST=$InstallRoot\apps\web\dist
"@ | Set-Content -Path $envFile -Encoding ASCII

$apiCmd = Join-Path $InstallRoot "start-api.cmd"
@"
@echo off
call `"$envFile`"
cd /d `"$InstallRoot`"
pnpm --filter @playon/api start
"@ | Set-Content -Path $apiCmd -Encoding ASCII

$nodeCmd = Join-Path $InstallRoot "start-node.cmd"
@"
@echo off
call `"$envFile`"
set PLAYON_API_URL=http://127.0.0.1:8787
set PLAYON_NODE_ID=local
set PLAYON_NODE_NAME=%COMPUTERNAME%
cd /d `"$InstallRoot`"
pnpm --filter @playon/node-agent start
"@ | Set-Content -Path $nodeCmd -Encoding ASCII

$actionApi = New-ScheduledTaskAction -Execute $apiCmd
$actionNode = New-ScheduledTaskAction -Execute $nodeCmd
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "PlayOnControlPlane" -Action $actionApi -Trigger $trigger -Force | Out-Null
Register-ScheduledTask -TaskName "PlayOnLocalNode" -Action $actionNode -Trigger $trigger -Force | Out-Null
Start-ScheduledTask -TaskName "PlayOnControlPlane"
Start-ScheduledTask -TaskName "PlayOnLocalNode"

Write-Host ""
Write-Host "PlayOn Home is starting."
Write-Host "  Admin: http://${AdvertiseHost}:8787"
Write-Host "  Env:   $envFile"
Write-Host "  Node token stored in env file for LAN join."
