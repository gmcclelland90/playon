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
  $archiveName = Split-Path $asset.downloadUrl -Leaf
  $archivePath = Join-Path $staging $archiveName
  Write-Host "==> Downloading $archiveName"
  Invoke-WebRequest -Uri $asset.downloadUrl -OutFile $archivePath -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
  if ($hash -ne $asset.sha256.ToLowerInvariant()) {
    throw "SHA256 mismatch for node package"
  }
  # Prefer tar (zip + tar.gz). Expand-Archive is the slow path that timed out on OTA (#868).
  $ProgressPreference = "SilentlyContinue"
  if ($archiveName -match '\.tar\.gz$') {
    & tar --force-local -xzf $archivePath -C $staging
    if ($LASTEXITCODE -ne 0) { throw "tar extract failed: $LASTEXITCODE" }
  } else {
    & tar --force-local -xf $archivePath -C $staging
    if ($LASTEXITCODE -ne 0) {
      Expand-Archive -LiteralPath $archivePath -DestinationPath $staging -Force
    }
  }
  $extracted = Join-Path $staging "playon-node"
  if (-not (Test-Path (Join-Path $extracted "apps\node-agent\dist\index.js"))) {
    $extracted = Get-ChildItem -Path $staging -Directory | Where-Object {
      Test-Path (Join-Path $_.FullName "apps\node-agent\dist\index.js")
    } | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $extracted) { throw "Extracted node package missing apps/node-agent/dist/index.js" }
  return $extracted
}

function Write-PlayOnCrlfText {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Text)
  $normalized = $Text -replace "`r`n", "`n" -replace "`n", "`r`n"
  if (-not $normalized.EndsWith("`r`n")) { $normalized += "`r`n" }
  [System.IO.File]::WriteAllText($Path, $normalized, [System.Text.ASCIIEncoding]::new())
}

function Write-PlayOnNodeEnv {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][hashtable]$Vars
  )
  $keys = @(
    "PLAYON_API_URL", "PLAYON_NODE_TOKEN", "PLAYON_NODE_ID", "PLAYON_NODE_NAME",
    "PLAYON_DATA_ROOT", "PLAYON_RUNTIME", "PLAYON_INSTALL_ROOT"
  )
  $obj = [ordered]@{}
  $cmdLines = New-Object System.Collections.Generic.List[string]
  foreach ($key in $keys) {
    if ($Vars.ContainsKey($key) -and $Vars[$key]) {
      $obj[$key] = [string]$Vars[$key]
      $cmdLines.Add("set $key=$($Vars[$key])")
    }
  }
  $jsonPath = Join-Path $InstallRoot "node.env.json"
  [System.IO.File]::WriteAllText(
    $jsonPath,
    (($obj | ConvertTo-Json -Compress) + "`r`n"),
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-PlayOnCrlfText -Path (Join-Path $InstallRoot "node.env.cmd") -Text ($cmdLines -join "`r`n")
}

function Write-PlayOnLoadEnvCjs {
  param([Parameter(Mandatory = $true)][string]$InstallRoot)
  $dest = Join-Path $InstallRoot "load-env.cjs"
  foreach ($candidate in @(
    (Join-Path $InstallRoot "load-env.cjs"),
    (Join-Path $PSScriptRoot "load-env.cjs"),
    (Join-Path $InstallRoot "deploy\windows\load-env.cjs")
  )) {
    if ((Test-Path $candidate) -and $candidate -ne $dest) {
      Copy-Item -Force $candidate $dest
      return
    }
  }
  if (Test-Path $dest) { return }
  # Standalone irm of this script + an older tarball: embed the preload.
  $embedded = @'
"use strict";
var fs = require("fs");
var path = require("path");
var ENV_KEYS = ["PLAYON_API_URL","PLAYON_NODE_TOKEN","PLAYON_NODE_ID","PLAYON_NODE_NAME","PLAYON_DATA_ROOT","PLAYON_RUNTIME","PLAYON_INSTALL_ROOT"];
function installRoot() { return process.env.PLAYON_INSTALL_ROOT || path.dirname(__filename); }
function applyEnv(map) { ENV_KEYS.forEach(function (key) { if (typeof map[key] === "string" && map[key] && process.env[key] == null) process.env[key] = map[key]; }); }
function loadJson(root) { var p = path.join(root, "node.env.json"); if (!fs.existsSync(p)) return; applyEnv(JSON.parse(fs.readFileSync(p, "utf8"))); }
function loadCmd(root) {
  var p = path.join(root, "node.env.cmd"); if (!fs.existsSync(p)) return;
  var map = {}; String(fs.readFileSync(p, "utf8")).split(/\r?\n/).forEach(function (raw) {
    var m = /^set\s+([A-Z0-9_]+)=(.*)$/i.exec(String(raw).replace(/^\uFEFF/, "").trim());
    if (m) map[m[1].toUpperCase()] = m[2];
  }); applyEnv(map);
}
function attachLog(root) {
  var dataRoot = process.env.PLAYON_DATA_ROOT || path.join(root, "data");
  try { fs.mkdirSync(dataRoot, { recursive: true }); } catch (e) {}
  var logPath = path.join(dataRoot, "agent-stdout.log");
  try { var st = fs.statSync(logPath); if (st.size >= 5 * 1024 * 1024) { try { fs.unlinkSync(logPath + ".1"); } catch (e2) {} try { fs.renameSync(logPath, logPath + ".1"); } catch (e3) {} } } catch (e4) {}
  var stream; try { stream = fs.createWriteStream(logPath, { flags: "a" }); } catch (e5) { return; }
  function tee(orig) { return function (chunk, enc, cb) { try { stream.write(chunk); } catch (e6) {} return orig.call(this, chunk, enc, cb); }; }
  process.stdout.write = tee(process.stdout.write); process.stderr.write = tee(process.stderr.write);
}
var root = installRoot();
try { loadJson(root); } catch (e7) {}
try { loadCmd(root); } catch (e8) {}
if (!process.env.PLAYON_INSTALL_ROOT) process.env.PLAYON_INSTALL_ROOT = root;
attachLog(root);
'@
  [System.IO.File]::WriteAllText($dest, $embedded.Trim() + "`n", [System.Text.UTF8Encoding]::new($false))
}

function Register-PlayOnNodeAgentTask {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$TaskName = "PlayOnNodeAgent"
  )
  $nodeExe = Join-Path $InstallRoot "runtime\node\node.exe"
  $agentJs = Join-Path $InstallRoot "apps\node-agent\dist\index.js"
  $loadEnv = Join-Path $InstallRoot "load-env.cjs"
  if (-not (Test-Path $nodeExe)) { throw "Missing $nodeExe" }
  if (-not (Test-Path $agentJs)) { throw "Missing $agentJs" }
  Write-PlayOnLoadEnvCjs -InstallRoot $InstallRoot
  # Exec node.exe directly. start-node.cmd `call` of LF node.env.cmd hangs cmd.exe
  # and a locked >> agent-stdout.log wedges the wrapper; RestartCount never fires.
  $arg = "--require `"$loadEnv`" `"$agentJs`""
  $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $arg -WorkingDirectory $InstallRoot
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
    -TaskName $TaskName `
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
  if ($_.Name -in @("data", "env", "node.env", "node.env.cmd", "node.env.json") -and (Test-Path $dest)) { return }
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

Write-PlayOnNodeEnv -InstallRoot $InstallRoot -Vars @{
  PLAYON_API_URL      = $ApiUrl
  PLAYON_NODE_TOKEN   = $Token
  PLAYON_NODE_ID      = $NodeId
  PLAYON_NODE_NAME    = $NodeId
  PLAYON_DATA_ROOT    = $DataRoot
  PLAYON_RUNTIME      = $Runtime
  PLAYON_INSTALL_ROOT = $InstallRoot
}
Write-PlayOnLoadEnvCjs -InstallRoot $InstallRoot
$envFile = Join-Path $InstallRoot "node.env.cmd"

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
$loadEnv = Join-Path $InstallRoot "load-env.cjs"
# Leftover double-click launcher only. Task action is node.exe (no cmd, no >> log).
if ($useBundled) {
  Write-PlayOnCrlfText -Path $start -Text @"
@echo off
call `"$envFile`"
cd /d `"$InstallRoot`"
if not exist `"$DataRoot`" mkdir `"$DataRoot`"
`"$nodeExe`" --require `"$loadEnv`" `"$agentJs`"
"@
} else {
  Write-PlayOnCrlfText -Path $start -Text @"
@echo off
call `"$envFile`"
cd /d `"$InstallRoot`"
if not exist `"$DataRoot`" mkdir `"$DataRoot`"
pnpm --filter @playon/node-agent start
"@
}

Register-PlayOnNodeAgentTask -InstallRoot $InstallRoot
Start-ScheduledTask -TaskName "PlayOnNodeAgent"
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host "Node $NodeId joining $ApiUrl (agent runs as $userId, elevated - not SYSTEM; WSL requires a user session)"
