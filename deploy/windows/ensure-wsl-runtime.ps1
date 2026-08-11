# PlayOn — Enable Linux runtime via WSL2 on a Windows host.
# Idempotent: run to install or repair the WSL sibling node (local-wsl or {nodeId}-wsl).
# Home may be local or remote — pass -ApiUrl / -NodeToken / -NodeId when not using a local Home env file.
#
# Phases:
#   1. Ensure WSL2 feature enabled (may require reboot)
#   2. Create/verify playon-linux distro
#   3. Install Docker Engine inside the distro
#   4. Install node-agent with PLAYON_NODE_ID=<NodeId>
#
# Exit codes / error tags:
#   0   = success or already present
#   10  = wsl_reboot_required (WSL feature just enabled, reboot needed)
#   11  = wsl_virt_disabled (virtualization not available in BIOS)
#   12  = wsl_user_cancelled_uac (user cancelled elevation prompt)
#   13  = wsl_distro_failed (distro setup failed)
#   14  = wsl_docker_failed (Docker install inside distro failed)
#   15  = wsl_agent_failed (node-agent install failed)
#   1   = generic error

param(
  [string]$ApiUrl = "",
  [string]$NodeToken = "",
  [string]$NodeId = "local-wsl",
  [string]$DistroName = "playon-linux",
  [string]$InstallRoot = "",
  [switch]$StatusOnly,
  [switch]$Repair
)

if (-not $NodeId) { $NodeId = "local-wsl" }

$ErrorActionPreference = "Stop"

# Detect Home install root from script location or env (optional when -ApiUrl/-NodeToken passed)
if (-not $InstallRoot) {
  $candidate = $null
  if ($PSScriptRoot) {
    $parent = Split-Path -Path $PSScriptRoot -Parent -ErrorAction SilentlyContinue
    if ($parent) {
      $candidate = Split-Path -Path $parent -Parent -ErrorAction SilentlyContinue
    }
  }
  if ($candidate -and (Test-Path (Join-Path $candidate "apps\api\dist\index.js"))) {
    $InstallRoot = $candidate
  } elseif ($env:PLAYON_INSTALL_ROOT) {
    $InstallRoot = $env:PLAYON_INSTALL_ROOT
  } else {
    $localApp = $env:LOCALAPPDATA
    if (-not $localApp) { $localApp = Join-Path $env:ProgramData "PlayOn" }
    $InstallRoot = Join-Path $localApp "PlayOn"
  }
}

# Load API URL and node token from env file if not passed
if (-not $ApiUrl -and (Test-Path (Join-Path $InstallRoot "env\playon.env.cmd"))) {
  $envContent = Get-Content (Join-Path $InstallRoot "env\playon.env.cmd") -Raw
  if ($envContent -match 'set PLAYON_ADVERTISE_HOST=(.+)') {
    $host_ip = $Matches[1].Trim()
  }
  if ($envContent -match 'set PLAYON_PORT=(\d+)') {
    $port = $Matches[1].Trim()
  } else {
    $port = "8787"
  }
  if ($host_ip) {
    $ApiUrl = "http://${host_ip}:${port}"
  }
}
if (-not $NodeToken -and (Test-Path (Join-Path $InstallRoot "env\playon.env.cmd"))) {
  $envContent = Get-Content (Join-Path $InstallRoot "env\playon.env.cmd") -Raw
  if ($envContent -match 'set PLAYON_NODE_TOKEN=(.+)') {
    $NodeToken = $Matches[1].Trim()
  }
}

function Write-Status {
  param([string]$Status, [string]$Message, [int]$Code = 0)
  $obj = @{
    status = $Status
    message = $Message
    code = $Code
    distro = $DistroName
    nodeId = $NodeId
  }
  ConvertTo-Json $obj -Compress
}

function Write-Phase {
  param([string]$Message)
  # Parsed by node-agent for live UI progress (ASCII marker; keep message plain).
  Write-Host ("PLAYON_WSL_PHASE:" + $Message)
}

function Normalize-WslText {
  param([string]$Text)
  if (-not $Text) { return "" }
  # wsl.exe often emits UTF-16LE; PowerShell may show it as C\0h\0a\0r\0...
  return (($Text -replace "`0", "") -replace "\uFFFD", "").Trim()
}

function Invoke-Wsl {
  # Pass args as an explicit array. Do NOT use ValueFromRemainingArguments:
  # PowerShell steals switches like --version / -d from the callee.
  param([Parameter(Mandatory = $true)][string[]]$WslArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & wsl.exe @WslArgs 2>&1
    $code = $LASTEXITCODE
    $text = Normalize-WslText (($out | ForEach-Object { "$_" }) -join "`n")
    return @{ Code = $code; Out = $text }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Install-WslPlatformMsi {
  # Inbox wsl.exe is a stub that only prints "run wsl --install" until the real package is present.
  # Download the official x64 MSI from GitHub releases (works headless / as SYSTEM).
  Write-Host "==> Installing WSL platform from GitHub releases MSI..."
  $msiUrl = $null
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/microsoft/WSL/releases/latest" -Headers @{
      "User-Agent" = "PlayOn-WSL"
      "Accept"     = "application/vnd.github+json"
    }
    $asset = $rel.assets | Where-Object { $_.name -match '^wsl\..*\.x64\.msi$' } | Select-Object -First 1
    if ($asset) { $msiUrl = $asset.browser_download_url }
  } catch {
    Write-Host "GitHub latest lookup failed: $_"
  }
  if (-not $msiUrl) {
    $msiUrl = "https://github.com/microsoft/WSL/releases/download/2.7.11/wsl.2.7.11.0.x64.msi"
  }

  $msiPath = Join-Path $env:TEMP ("playon-wsl-" + [guid]::NewGuid().ToString("n") + ".msi")
  Write-Host "==> Downloading $msiUrl"
  try {
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
  } catch {
    return @{ Ok = $false; Message = "Failed to download WSL MSI: $_" }
  }

  Write-Host "==> msiexec /i (quiet)..."
  $p = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", "`"$msiPath`"", "/qn", "/norestart") -Wait -PassThru
  Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
    return @{ Ok = $false; Message = "WSL MSI install failed with exit $($p.ExitCode)" }
  }
  return @{ Ok = $true; Message = "WSL MSI installed (exit $($p.ExitCode))" }
}

function Test-WslFeature {
  $wsl = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -ErrorAction SilentlyContinue
  $vmp = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction SilentlyContinue
  return @{
    WslEnabled = ($wsl -and $wsl.State -eq "Enabled")
    VmpEnabled = ($vmp -and $vmp.State -eq "Enabled")
    WslPending = ($wsl -and $wsl.RestartNeeded)
    VmpPending = ($vmp -and $vmp.RestartNeeded)
  }
}

function Test-WslPlatform {
  # Optional features can be Enabled while the WSL app/kernel is still missing (needs wsl --install).
  $r = Invoke-Wsl -WslArgs @("--status")
  if ($r.Code -eq 0) { return $true }
  $r2 = Invoke-Wsl -WslArgs @("-l", "-v")
  if ($r2.Code -eq 0) { return $true }
  if ($r.Out -match "not installed" -or $r2.Out -match "not installed") { return $false }
  # --version works on modern WSL packages even with zero distros
  $r3 = Invoke-Wsl -WslArgs @("--version")
  return ($r3.Code -eq 0)
}

function Test-VirtEnabled {
  # When a hypervisor is already running, Win32_Processor.VirtualizationFirmwareEnabled
  # often reads False even though VT-x/AMD-V is on — trust HyperVisorPresent first.
  try {
    $ci = Get-ComputerInfo -Property HyperVisorPresent -ErrorAction SilentlyContinue
    if ($ci -and $ci.HyperVisorPresent) { return $true }
  } catch { }

  $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cpu -and $cpu.VirtualizationFirmwareEnabled -eq $false) {
    return $false
  }
  return $true
}

function Test-DistroExists {
  $r = Invoke-Wsl -WslArgs @("--list", "--quiet")
  if ($r.Code -ne 0) { return $false }
  $names = @($r.Out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  # wsl --list may emit UTF-16; strip NULs if present
  $names = $names | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ }
  return ($names -contains $DistroName)
}

function Test-DockerInDistro {
  $r = Invoke-Wsl -WslArgs @("-d", $DistroName, "--", "docker", "version", "--format", "{{.Server.Version}}")
  return ($r.Code -eq 0 -and $r.Out.Trim().Length -gt 0)
}

function Test-AgentInDistro {
  $r = Invoke-Wsl -WslArgs @("-d", $DistroName, "--", "systemctl", "is-active", "playon-node-agent.service")
  return ($r.Out.Trim() -eq "active")
}

# Default WSL2 vmIdleTimeout is 60s — systemd services alone do not keep the VM up.
# Disable idle shutdown so the sibling agent keeps heartbeating.
function Ensure-WslVmIdleDisabled {
  $cfgPath = Join-Path $env:USERPROFILE ".wslconfig"
  $content = ""
  if (Test-Path -LiteralPath $cfgPath) {
    $content = [System.IO.File]::ReadAllText($cfgPath)
  }
  if ($content -match '(?im)^\s*vmIdleTimeout\s*=\s*-1\s*$') {
    return $false
  }

  if ($content -match '(?im)^\s*vmIdleTimeout\s*=') {
    $content = [regex]::Replace($content, '(?im)^\s*vmIdleTimeout\s*=.*$', "vmIdleTimeout=-1")
  } elseif ($content -match '(?im)^\s*\[wsl2\]\s*$') {
    $content = [regex]::Replace($content, '(?im)^(\s*\[wsl2\]\s*)$', "`$1`r`nvmIdleTimeout=-1")
  } else {
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
      $content += "`r`n"
    }
    $content += "[wsl2]`r`nvmIdleTimeout=-1`r`n"
  }

  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($cfgPath, $content.TrimEnd() + "`r`n", $utf8)
  return $true
}

function Restart-WslDistroForConfig {
  Write-Phase "Applying WSL config (disable idle shutdown)..."
  Write-Host "==> Restarting WSL so .wslconfig takes effect..."
  Invoke-Wsl -WslArgs @("--shutdown") | Out-Null
  Start-Sleep -Seconds 2
  # Wake distro + agent (best-effort)
  Invoke-Wsl -WslArgs @("-d", $DistroName, "-u", "root", "--", "systemctl", "start", "playon-node-agent.service") | Out-Null
}

function Get-WslStatus {
  $features = Test-WslFeature
  $virtOk = Test-VirtEnabled
  $platformOk = $false
  $distroExists = $false
  $dockerReady = $false
  $agentReady = $false

  if ($features.WslEnabled -and $features.VmpEnabled -and -not $features.WslPending -and -not $features.VmpPending) {
    $platformOk = Test-WslPlatform
    if ($platformOk) {
      $distroExists = Test-DistroExists
      if ($distroExists) {
        $dockerReady = Test-DockerInDistro
        $agentReady = Test-AgentInDistro
      }
    }
  }

  return @{
    WslEnabled = $features.WslEnabled
    VmpEnabled = $features.VmpEnabled
    PlatformReady = $platformOk
    RebootRequired = ($features.WslPending -or $features.VmpPending)
    VirtAvailable = $virtOk
    DistroExists = $distroExists
    DockerReady = $dockerReady
    AgentReady = $agentReady
  }
}

# Status-only mode
if ($StatusOnly) {
  $s = Get-WslStatus
  if (-not $s.VirtAvailable) {
    Write-Status "error" "Virtualization is not enabled in BIOS/UEFI" 11
    exit 11
  }
  if (-not $s.WslEnabled -or -not $s.VmpEnabled) {
    Write-Status "not_installed" "WSL2 features not enabled" 0
    exit 0
  }
  if ($s.RebootRequired) {
    Write-Status "reboot_required" "WSL2 features enabled but reboot required" 10
    exit 10
  }
  if (-not $s.PlatformReady) {
    Write-Status "not_installed" "WSL optional features on but platform package missing (needs wsl --install)" 0
    exit 0
  }
  if (-not $s.DistroExists) {
    Write-Status "distro_missing" "WSL2 ready but playon-linux distro not installed" 0
    exit 0
  }
  if (-not $s.DockerReady) {
    Write-Status "docker_missing" "playon-linux distro exists but Docker not ready" 0
    exit 0
  }
  if (-not $s.AgentReady) {
    Write-Status "agent_missing" "Docker ready but node-agent not running" 0
    exit 0
  }
  Write-Status "ready" "$NodeId node is healthy" 0
  exit 0
}

# Ensure running elevated
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Status "error" "Administrator privileges required" 12
  exit 12
}

# WSL refuses LocalSystem entirely.
$who = whoami
if ($who -match '^nt authority\\system$' ) {
  Write-Status "error" "WSL cannot run as SYSTEM. Re-register the node agent as an admin user (deploy/windows/elevate-node-agent.ps1)." 1
  exit 1
}

# Check virtualization
if (-not (Test-VirtEnabled)) {
  Write-Status "error" "Virtualization is not enabled in BIOS/UEFI. Enable Intel VT-x or AMD-V, then retry." 11
  exit 11
}

# Enable WSL2 features
Write-Phase "Checking Windows optional features..."
$features = Test-WslFeature
$needReboot = $false
if (-not $features.WslEnabled) {
  Write-Phase "Enabling Windows Subsystem for Linux feature..."
  Write-Host "==> Enabling WSL feature..."
  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart -ErrorAction Stop | Out-Null
  $needReboot = $true
}
if (-not $features.VmpEnabled) {
  Write-Phase "Enabling Virtual Machine Platform..."
  Write-Host "==> Enabling Virtual Machine Platform..."
  Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart -ErrorAction Stop | Out-Null
  $needReboot = $true
}
if ($features.WslPending -or $features.VmpPending) {
  $needReboot = $true
}

if ($needReboot) {
  Write-Status "reboot_required" "WSL2 features enabled. Reboot Windows, then run this again." 10
  exit 10
}

# Optional features can be Enabled while inbox wsl.exe is still a stub (needs MSI / reboot).
if (-not (Test-WslPlatform)) {
  Write-Phase "Installing WSL platform package..."
  # Try modern CLI first (works on some builds); ignore stub "not installed" noise.
  Write-Host "==> Trying wsl --install --no-distribution..."
  $install = Invoke-Wsl -WslArgs @("--install", "--no-distribution")
  if ($install.Out) { Write-Host $install.Out }
  if (-not (Test-WslPlatform)) {
    Write-Phase "Downloading WSL MSI from GitHub (large download)..."
    $msi = Install-WslPlatformMsi
    Write-Host $msi.Message
    if (-not $msi.Ok -and -not (Test-WslPlatform)) {
      $msg = Normalize-WslText $msi.Message
      Write-Status "error" "WSL platform install failed: $msg" 1
      exit 1
    }
  }
  # MSI / feature registration usually needs a reboot before import works.
  Write-Status "reboot_required" "WSL platform installed. Reboot Windows, then run Enable again." 10
  exit 10
}

# Ensure WSL is set to version 2 (ignore failures if already set / no distros yet)
Invoke-Wsl -WslArgs @("--set-default-version", "2") | Out-Null

# Create or verify distro
if (-not (Test-DistroExists) -or $Repair) {
  Write-Phase "Preparing playon-linux distro..."
  Write-Host "==> Installing $DistroName distro..."

  # Prefer ProgramData (SYSTEM agent + interactive share one tree; avoids tiny %TEMP%).
  $tmpRoot = Join-Path $env:ProgramData "PlayOn\wsl-setup"
  New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

  if (-not (Test-DistroExists)) {
    # Filename changed on cloud-images; try current then legacy names.
    $rootfsCandidates = @(
      "https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz",
      "https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz",
      "https://cloud-images.ubuntu.com/wsl/noble/current/ubuntu-noble-wsl-amd64-ubuntu24.04lts.rootfs.tar.gz"
    )
    $rootfsPath = Join-Path $tmpRoot "ubuntu-rootfs.tar.gz"
    $distroPath = Join-Path $env:ProgramData "PlayOn\wsl\$DistroName"

    Write-Phase "Downloading Ubuntu rootfs (~325 MB)..."
    Write-Host "==> Downloading Ubuntu rootfs..."
    $downloaded = $false
    $lastErr = $null
    foreach ($rootfsUrl in $rootfsCandidates) {
      try {
        Write-Host "    $rootfsUrl"
        Invoke-WebRequest -Uri $rootfsUrl -OutFile $rootfsPath -UseBasicParsing
        if ((Get-Item $rootfsPath).Length -gt 1MB) {
          $downloaded = $true
          break
        }
      } catch {
        $lastErr = $_
        Write-Host "    failed: $_"
      }
    }
    if (-not $downloaded) {
      Write-Status "error" "Failed to download Ubuntu rootfs: $lastErr" 13
      exit 13
    }

    if (Test-Path $distroPath) {
      Remove-Item -Recurse -Force $distroPath -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $distroPath | Out-Null
    Write-Phase "Importing Ubuntu into WSL as playon-linux..."
    Write-Host "==> Importing as $DistroName..."
    $imp = Invoke-Wsl -WslArgs @("--import", $DistroName, $distroPath, $rootfsPath, "--version", "2")
    if ($imp.Code -ne 0) {
      Write-Host $imp.Out
      $detail = if ($imp.Out) { Normalize-WslText $imp.Out } else { "exit $($imp.Code)" }
      Write-Status "error" "Failed to import WSL distro: $detail" 13
      exit 13
    }
    Remove-Item $rootfsPath -Force -ErrorAction SilentlyContinue
  }
}

# Verify distro exists now
if (-not (Test-DistroExists)) {
  Write-Status "error" "Distro creation failed" 13
  exit 13
}

$idleCfgChanged = Ensure-WslVmIdleDisabled
if ($idleCfgChanged) {
  Restart-WslDistroForConfig
}

# Already healthy — skip reinstall (re-Enable / refresh must not fight a running agent binary).
if (-not $Repair -and (Test-DockerInDistro) -and (Test-AgentInDistro)) {
  Write-Phase "WSL Linux runtime already healthy"
  Write-Status "ready" "$NodeId node is ready" 0
  exit 0
}

# Prepare the inner setup script
$setupScript = @'
#!/bin/bash
set -euo pipefail

API_URL="$1"
NODE_TOKEN="$2"
NODE_ID="${3:-local-wsl}"
NODE_NAME="${4:-Linux (WSL)}"

echo "PLAYON_WSL_PHASE:Updating apt packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release systemd

# Ensure systemd is the init for future boots
if [ ! -f /etc/wsl.conf ] || ! grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null; then
  printf '[boot]\nsystemd=true\n' >/etc/wsl.conf
fi

# Install Docker Engine (avoid curl|sh under pipefail — SIGPIPE aborts the whole script)
if ! command -v docker >/dev/null 2>&1; then
  echo "PLAYON_WSL_PHASE:Installing Docker Engine..."
  echo "==> Installing Docker Engine..."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi

# Start Docker
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable docker 2>/dev/null || true
  systemctl start docker 2>/dev/null || true
fi

# Wait for Docker socket
for i in {1..30}; do
  if [ -S /var/run/docker.sock ]; then
    break
  fi
  sleep 1
done

if [ ! -S /var/run/docker.sock ]; then
  echo "Docker socket not available after install"
  exit 1
fi

# Create playon user
if ! id -u playon >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/playon --shell /usr/sbin/nologin playon || true
fi
usermod -aG docker playon || true

echo "PLAYON_WSL_PHASE:Installing Node.js..."
# Install Node.js 22 if not present
if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]")" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh
  bash /tmp/nodesource-setup.sh
  apt-get install -y nodejs
fi

# Install pnpm
corepack enable >/dev/null 2>&1 || npm install -g pnpm@9

# Create install directories
PLAYON_ROOT=/opt/playon-node
PLAYON_DATA=/var/lib/playon-node
mkdir -p "$PLAYON_ROOT" "$PLAYON_DATA" /etc/playon

# Download node package from manifest
MANIFEST_URL="https://playon.games/home/latest.json"
echo "PLAYON_WSL_PHASE:Downloading PlayOn node package..."
echo "==> Fetching node package from $MANIFEST_URL"
json="$(curl -fsSL -H "Accept: application/json" -H "User-Agent: PlayOn-WSL" "$MANIFEST_URL")"

if command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$json" | python3 -c '
import json,sys
m=json.load(sys.stdin)
a=(m.get("node") or {}).get("linux-x64") or {}
print("url="+repr(a.get("downloadUrl") or ""))
print("sha="+repr(a.get("sha256") or ""))
')"
else
  echo "Need python3 to parse manifest"
  exit 1
fi

if [ -z "${url:-}" ] || [ -z "${sha:-}" ]; then
  echo "No linux-x64 node asset in manifest"
  exit 1
fi

staging="$(mktemp -d)"
archive="${staging}/$(basename "$url")"
echo "==> Downloading node package..."
curl -fsSL -o "$archive" "$url"
echo "${sha}  ${archive}" | sha256sum -c -

echo "==> Extracting..."
tar -xzf "$archive" -C "$staging"
extracted="$staging/playon-node"
if [ ! -f "$extracted/package.json" ]; then
  extracted="$(find "$staging" -maxdepth 2 -type f -name package.json -printf '%h\n' | head -n1)"
fi

# Stop agent before replacing binaries (otherwise: Text file busy on runtime/node/bin/node)
systemctl stop playon-node-agent.service 2>/dev/null || true
pkill -u playon -f 'node-agent|playon-node' 2>/dev/null || true
sleep 1

mkdir -p "$PLAYON_ROOT"
cp -a "$extracted/." "$PLAYON_ROOT/"
chown -R playon:playon "$PLAYON_ROOT" "$PLAYON_DATA"

echo "PLAYON_WSL_PHASE:Installing node-agent dependencies..."
# Install dependencies
cd "$PLAYON_ROOT"
# Bundled node packages ship with runtime/node; prefer that over host pnpm when present.
if [ -x "${PLAYON_ROOT}/runtime/node/bin/node" ]; then
  echo "Using bundled Node runtime"
else
  sudo -u playon pnpm install --prod --frozen-lockfile=false || pnpm install --prod
fi

# Create env file
cat >/etc/playon/node.env <<EOF
PLAYON_API_URL=${API_URL}
PLAYON_NODE_TOKEN=${NODE_TOKEN}
PLAYON_NODE_ID=${NODE_ID}
PLAYON_NODE_NAME=${NODE_NAME}
PLAYON_DATA_ROOT=${PLAYON_DATA}
PLAYON_RUNTIME=docker
PLAYON_INSTALL_ROOT=${PLAYON_ROOT}
EOF
chmod 600 /etc/playon/node.env

# Determine exec start
NODE_BIN="${PLAYON_ROOT}/runtime/node/bin/node"
if [ -x "$NODE_BIN" ]; then
  EXEC_START="$NODE_BIN ${PLAYON_ROOT}/apps/node-agent/dist/index.js"
else
  EXEC_START="/usr/bin/pnpm --filter @playon/node-agent start"
fi

echo "PLAYON_WSL_PHASE:Starting playon-node-agent service..."
# Create systemd service
cat >/etc/systemd/system/playon-node-agent.service <<EOF
[Unit]
Description=PlayOn node-agent (WSL)
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=playon
Group=playon
EnvironmentFile=/etc/playon/node.env
WorkingDirectory=${PLAYON_ROOT}
ExecStart=${EXEC_START}
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable playon-node-agent.service
systemctl start playon-node-agent.service

echo "==> ${NODE_ID} node ready"
'@

# Run setup inside WSL
Write-Phase "Installing Docker and node-agent inside WSL (several minutes)..."
Write-Host "==> Configuring Docker and node-agent inside $DistroName (nodeId=$NodeId)..."
# Embed script via base64 so we never depend on wslpath / Windows path escaping.
$unixScript = ($setupScript -replace "`r`n", "`n" -replace "`r", "`n")
$scriptB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($unixScript))
$nodeName = if ($NodeId -eq "local-wsl") { "Linux (WSL)" } else { "Linux (WSL) $NodeId" }

# Quote args safely for bash -lc
function Escape-BashSingle([string]$s) { return ($s -replace "'", "'\''") }
$qApi = Escape-BashSingle $ApiUrl
$qTok = Escape-BashSingle $NodeToken
$qId = Escape-BashSingle $NodeId
$qName = Escape-BashSingle $nodeName
$bashLc = "echo '$scriptB64' | base64 -d > /tmp/playon-wsl-setup.sh && chmod +x /tmp/playon-wsl-setup.sh && bash /tmp/playon-wsl-setup.sh '$qApi' '$qTok' '$qId' '$qName'"

$setup = Invoke-Wsl -WslArgs @(
  "-d", $DistroName, "-u", "root", "--",
  "bash", "-lc", $bashLc
)

if ($setup.Code -ne 0) {
  Write-Host $setup.Out
  $detail = Normalize-WslText $setup.Out
  if ($detail.Length -gt 400) { $detail = $detail.Substring($detail.Length - 400) }
  # Match real Docker failures only — do not treat unrelated log lines that mention "docker".
  if ($detail -match "Docker socket not available|get-docker\.sh|docker\.service") {
    Write-Status "error" "Docker installation failed inside WSL: $detail" 14
    exit 14
  }
  Write-Status "error" "Node-agent setup failed inside WSL: $detail" 15
  exit 15
}

# Final verification
Start-Sleep -Seconds 3
if (-not (Test-AgentInDistro)) {
  Write-Status "error" "Node-agent not running after setup" 15
  exit 15
}

Write-Status "ready" "$NodeId node is ready" 0
exit 0
