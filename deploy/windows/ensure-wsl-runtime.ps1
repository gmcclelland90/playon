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

# Detect Home install root from script location or env
if (-not $InstallRoot) {
  $candidate = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  if (Test-Path (Join-Path $candidate "apps\api\dist\index.js")) {
    $InstallRoot = $candidate
  } elseif ($env:PLAYON_INSTALL_ROOT) {
    $InstallRoot = $env:PLAYON_INSTALL_ROOT
  } else {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "PlayOn"
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

function Test-VirtEnabled {
  $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cpu -and $cpu.VirtualizationFirmwareEnabled -eq $false) {
    return $false
  }
  return $true
}

function Test-DistroExists {
  $distros = wsl.exe --list --quiet 2>$null | Where-Object { $_ -and $_.Trim() -ne "" }
  return ($distros -contains $DistroName)
}

function Test-DockerInDistro {
  try {
    $result = wsl.exe -d $DistroName -- docker version --format '{{.Server.Version}}' 2>$null
    return ($LASTEXITCODE -eq 0 -and $result -and $result.Trim().Length -gt 0)
  } catch {
    return $false
  }
}

function Test-AgentInDistro {
  try {
    $result = wsl.exe -d $DistroName -- systemctl is-active playon-node-agent.service 2>$null
    return ($result -and $result.Trim() -eq "active")
  } catch {
    return $false
  }
}

function Get-WslStatus {
  $features = Test-WslFeature
  $virtOk = Test-VirtEnabled
  $distroExists = $false
  $dockerReady = $false
  $agentReady = $false

  if ($features.WslEnabled -and $features.VmpEnabled -and -not $features.WslPending -and -not $features.VmpPending) {
    $distroExists = Test-DistroExists
    if ($distroExists) {
      $dockerReady = Test-DockerInDistro
      $agentReady = Test-AgentInDistro
    }
  }

  return @{
    WslEnabled = $features.WslEnabled
    VmpEnabled = $features.VmpEnabled
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
  Write-Status "ready" "local-wsl node is healthy" 0
  exit 0
}

# Ensure running elevated
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Status "error" "Administrator privileges required" 12
  exit 12
}

# Check virtualization
if (-not (Test-VirtEnabled)) {
  Write-Status "error" "Virtualization is not enabled in BIOS/UEFI. Enable Intel VT-x or AMD-V, then retry." 11
  exit 11
}

# Enable WSL2 features
$features = Test-WslFeature
$needReboot = $false
if (-not $features.WslEnabled) {
  Write-Host "==> Enabling WSL feature..."
  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart -ErrorAction Stop | Out-Null
  $needReboot = $true
}
if (-not $features.VmpEnabled) {
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

# Ensure WSL is set to version 2
wsl.exe --set-default-version 2 2>$null | Out-Null

# Create or verify distro
if (-not (Test-DistroExists) -or $Repair) {
  Write-Host "==> Installing $DistroName distro..."
  
  # Use --install with Ubuntu, then rename/re-register as playon-linux
  # Or import a minimal rootfs. For reliability, use wsl --install -d Ubuntu then convert.
  # Actually, let's use a simpler approach: wsl --install then import.
  
  # Check if we can use wsl --install
  $wslVer = wsl.exe --version 2>$null
  $canInstall = $LASTEXITCODE -eq 0
  
  if ($canInstall) {
    # Modern WSL2 - use online install
    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "playon-wsl-setup"
    New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
    
    # Import Ubuntu rootfs if distro doesn't exist
    if (-not (Test-DistroExists)) {
      # Use wsl --install to get Ubuntu, then import for our named distro
      # Or download minimal Ubuntu rootfs
      $rootfsUrl = "https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz"
      $rootfsPath = Join-Path $tmpRoot "ubuntu-rootfs.tar.gz"
      $distroPath = Join-Path $env:LOCALAPPDATA "PlayOn\wsl\$DistroName"
      
      Write-Host "==> Downloading Ubuntu rootfs..."
      try {
        Invoke-WebRequest -Uri $rootfsUrl -OutFile $rootfsPath -UseBasicParsing
      } catch {
        Write-Status "error" "Failed to download Ubuntu rootfs: $_" 13
        exit 13
      }
      
      New-Item -ItemType Directory -Force -Path $distroPath | Out-Null
      Write-Host "==> Importing as $DistroName..."
      wsl.exe --import $DistroName $distroPath $rootfsPath --version 2
      if ($LASTEXITCODE -ne 0) {
        Write-Status "error" "Failed to import WSL distro" 13
        exit 13
      }
      Remove-Item $rootfsPath -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Status "error" "WSL command not available after feature enable. Reboot and retry." 10
    exit 10
  }
}

# Verify distro exists now
if (-not (Test-DistroExists)) {
  Write-Status "error" "Distro creation failed" 13
  exit 13
}

# Prepare the inner setup script
$setupScript = @'
#!/bin/bash
set -euo pipefail

API_URL="$1"
NODE_TOKEN="$2"
NODE_ID="${3:-local-wsl}"
NODE_NAME="${4:-Linux (WSL)}"

# Update and install prerequisites
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release systemd

# Install Docker Engine
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine..."
  curl -fsSL https://get.docker.com | sh
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

# Install Node.js 22 if not present
if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]")" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
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

cp -a "$extracted/." "$PLAYON_ROOT/"
chown -R playon:playon "$PLAYON_ROOT" "$PLAYON_DATA"

# Install dependencies
cd "$PLAYON_ROOT"
sudo -u playon pnpm install --prod --frozen-lockfile=false || pnpm install --prod

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
Write-Host "==> Configuring Docker and node-agent inside $DistroName (nodeId=$NodeId)..."
$scriptPath = Join-Path ([System.IO.Path]::GetTempPath()) "playon-wsl-setup.sh"
$setupScript | Set-Content -Path $scriptPath -Encoding UTF8 -NoNewline

# Convert Windows path to WSL path
$wslScriptPath = wsl.exe -d $DistroName -- wslpath -u ($scriptPath -replace '\\', '/')

$nodeName = if ($NodeId -eq "local-wsl") { "Linux (WSL)" } else { "Linux (WSL) · $NodeId" }

# Run the setup script
$result = wsl.exe -d $DistroName -u root -- bash $wslScriptPath "$ApiUrl" "$NodeToken" "$NodeId" "$nodeName" 2>&1
$exitCode = $LASTEXITCODE

Remove-Item $scriptPath -Force -ErrorAction SilentlyContinue

if ($exitCode -ne 0) {
  Write-Host $result
  if ($result -match "Docker") {
    Write-Status "error" "Docker installation failed inside WSL" 14
    exit 14
  }
  Write-Status "error" "Node-agent setup failed inside WSL" 15
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
