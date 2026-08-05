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

$start = Join-Path $InstallRoot "start-node.cmd"
if ($useBundled) {
  @"
@echo off
call `"$envFile`"
cd /d `"$InstallRoot`"
`"$nodeExe`" `"$agentJs`"
"@ | Set-Content -Path $start -Encoding ASCII
} else {
  @"
@echo off
call `"$envFile`"
cd /d `"$InstallRoot`"
pnpm --filter @playon/node-agent start
"@ | Set-Content -Path $start -Encoding ASCII
}

$action = New-ScheduledTaskAction -Execute $start
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "PlayOnNodeAgent" -Action $action -Trigger $trigger -Force | Out-Null
Start-ScheduledTask -TaskName "PlayOnNodeAgent"
Write-Host "Node $NodeId joining $ApiUrl"
