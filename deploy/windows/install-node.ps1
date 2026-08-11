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
$ManifestUrl = if ($env:PLAYON_UPDATE_MANIFEST_URL) { $env:PLAYON_UPDATE_MANIFEST_URL } else { "https://playon.games/home/latest.json" }

# Node agent must stay elevated so host work (WSL feature enable, etc.) needs no second UAC.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Run install-node.ps1 from an elevated PowerShell (Run as administrator). Privilege is captured once at install so Enable Linux runtime can run without a UAC prompt."
}

# deploy/windows → package root is two levels up when inside a tree
$Candidate = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$BundleRoot = $null
if (Test-Path (Join-Path $Candidate "apps\node-agent\dist\index.js")) {
  $BundleRoot = $Candidate
} elseif (Test-Path (Join-Path $PSScriptRoot "..\..\apps\node-agent\dist\index.js")) {
  $BundleRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Get-NodeBundleFromManifest {
  Write-Host "==> Fetching node package from $ManifestUrl"
  $headers = @{
    "Accept"     = "application/json"
    "User-Agent" = "PlayOn-Install-Node"
  }
  $manifest = Invoke-RestMethod -Uri $ManifestUrl -Headers $headers
  $asset = $manifest.node.'windows-x64'
  if (-not $asset -or -not $asset.downloadUrl -or -not $asset.sha256) {
    throw "No windows-x64 node asset in update manifest. Publish playon-node release + home/latest.json first."
  }
  $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("playon-node-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $zipName = Split-Path $asset.downloadUrl -Leaf
  $zipPath = Join-Path $staging $zipName
  Write-Host "==> Downloading $zipName"
  Invoke-WebRequest -Uri $asset.downloadUrl -OutFile $zipPath -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLowerInvariant()
  if ($hash -ne $asset.sha256.ToLowerInvariant()) {
    throw "SHA256 mismatch for node package"
  }
  Expand-Archive -Path $zipPath -DestinationPath $staging -Force
  $extracted = Join-Path $staging "playon-node"
  if (-not (Test-Path (Join-Path $extracted "apps\node-agent\dist\index.js"))) {
    $extracted = Get-ChildItem -Path $staging -Directory | Where-Object {
      Test-Path (Join-Path $_.FullName "apps\node-agent\dist\index.js")
    } | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $extracted) { throw "Extracted node package missing apps/node-agent/dist/index.js" }
  return $extracted
}

function Register-PlayOnNodeAgentTask {
  param(
    [Parameter(Mandatory = $true)][string]$StartCmd,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  $action = New-ScheduledTaskAction -Execute $StartCmd -WorkingDirectory $WorkingDirectory
  # WSL cannot run as LocalSystem (WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED). Use the installing
  # admin user with Highest + S4U so the agent stays up without a desktop session and
  # Enable Linux runtime needs no second UAC.
  $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
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
    -TaskName "PlayOnNodeAgent" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null
}

if (-not $BundleRoot) {
  $BundleRoot = Get-NodeBundleFromManifest
}

New-Item -ItemType Directory -Force -Path $InstallRoot, $DataRoot | Out-Null
Get-ChildItem -Force $BundleRoot | ForEach-Object {
  $dest = Join-Path $InstallRoot $_.Name
  if ($_.Name -in @("data", "env", "node.env", "node.env.cmd") -and (Test-Path $dest)) { return }
  Copy-Item -Recurse -Force $_.FullName $dest
}

$nodeExe = Join-Path $InstallRoot "runtime\node\node.exe"
$agentJs = Join-Path $InstallRoot "apps\node-agent\dist\index.js"
$useBundled = Test-Path $nodeExe

if (-not $useBundled) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  }
  corepack enable
  corepack prepare pnpm@9.15.4 --activate
  Push-Location $InstallRoot
  pnpm install --prod --frozen-lockfile=false
  Pop-Location
}

$envFile = Join-Path $InstallRoot "node.env.cmd"
@"
set PLAYON_API_URL=$ApiUrl
set PLAYON_NODE_TOKEN=$Token
set PLAYON_NODE_ID=$NodeId
set PLAYON_NODE_NAME=$NodeId
set PLAYON_DATA_ROOT=$DataRoot
set PLAYON_RUNTIME=$Runtime
set PLAYON_INSTALL_ROOT=$InstallRoot
"@ | Set-Content -Path $envFile -Encoding ASCII

# Ensure workspace deps are linked (release zip may ship without node_modules/@playon).
$env:Path = (Join-Path $InstallRoot "runtime\node") + ";" + $env:Path
$env:CI = "true"
Push-Location $InstallRoot
try {
  if ($useBundled) {
    & (Join-Path $InstallRoot "runtime\node\corepack.cmd") pnpm install --prod --force
  } else {
    pnpm install --prod --frozen-lockfile=$false
  }
} finally {
  Pop-Location
}

$start = Join-Path $InstallRoot "start-node.cmd"
$logFile = Join-Path $DataRoot "agent-stdout.log"
if ($useBundled) {
  @"
@echo off
call `"$envFile`"
cd /d `"$InstallRoot`"
if not exist `"$DataRoot`" mkdir `"$DataRoot`"
`"$nodeExe`" `"$agentJs`" >> `"$logFile`" 2>&1
"@ | Set-Content -Path $start -Encoding ASCII
} else {
  @"
@echo off
call `"$envFile`"
cd /d `"$InstallRoot`"
if not exist `"$DataRoot`" mkdir `"$DataRoot`"
pnpm --filter @playon/node-agent start >> `"$logFile`" 2>&1
"@ | Set-Content -Path $start -Encoding ASCII
}

Register-PlayOnNodeAgentTask -StartCmd $start -WorkingDirectory $InstallRoot
Start-ScheduledTask -TaskName "PlayOnNodeAgent"
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host "Node $NodeId joining $ApiUrl (agent runs as $userId, elevated - not SYSTEM; WSL requires a user session)"
