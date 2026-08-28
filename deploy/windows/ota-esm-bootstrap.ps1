# PlayOn Windows OTA bootstrap (#885 / #917)
# Home writes this so 0.2.3–0.2.11 never claim node_self_update.
# Download + size/magic/sha256, then the packaged apply-self-update.ps1.
param(
  [Parameter(Mandatory = $true)][string]$DownloadUrl,
  [Parameter(Mandatory = $true)][string]$Sha256,
  [Parameter(Mandatory = $true)][string]$Version,
  [int]$ExpectedSize = 0
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$LogFile = Join-Path $env:TEMP "playon-ota-esm-bootstrap.log"
function Write-Log {
  param([string]$Message)
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [ota-esm-bootstrap] $Message"
  Write-Host $line
  try { Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue } catch {}
}
function Get-AgentPid {
  try {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    if ($parent.ParentProcessId) { return [int]$parent.ParentProcessId }
  } catch {}
  try {
    $parent = Get-WmiObject Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    if ($parent.ParentProcessId) { return [int]$parent.ParentProcessId }
  } catch {}
  throw "update_bootstrap_parent_pid_missing"
}
function Get-InstallRoot {
  if ($env:PLAYON_INSTALL_ROOT) { return $env:PLAYON_INSTALL_ROOT }
  if ($env:PLAYON_DATA_ROOT) { return Split-Path $env:PLAYON_DATA_ROOT -Parent }
  return (Get-Location).Path
}
function Find-ExtractedRoot {
  param([string]$DestDir)
  foreach ($name in @("playon-node", "playon")) {
    $candidate = Join-Path $DestDir $name
    if (Test-Path (Join-Path $candidate "package.json")) { return $candidate }
  }
  foreach ($ent in Get-ChildItem -Path $DestDir -Directory) {
    if (Test-Path (Join-Path $ent.FullName "package.json")) { return $ent.FullName }
  }
  throw "update_extract_root_missing"
}
function Get-ArchiveKind {
  param([string]$Path)
  $fs = [IO.File]::OpenRead($Path)
  try {
    $magic = New-Object byte[] 2
    [void]$fs.Read($magic, 0, 2)
  } finally { $fs.Close() }
  if ($magic[0] -eq 31 -and $magic[1] -eq 139) { return "gzip" }
  if ($magic[0] -eq 80 -and $magic[1] -eq 75) { return "zip" }
  return "unknown"
}
Write-Log "Starting Windows OTA bootstrap version=$Version expectedSize=$ExpectedSize"
$agentPid = Get-AgentPid
$installRoot = Get-InstallRoot
Write-Log "agentPid=$agentPid installRoot=$installRoot"
$staging = Join-Path $env:TEMP "playon-node-ota-esm-bootstrap"
if (Test-Path $staging) { Remove-Item -Path $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$leaf = [IO.Path]::GetFileName(([Uri]$DownloadUrl).AbsolutePath)
if (-not $leaf) { $leaf = "node-update.bin" }
$archivePath = Join-Path $staging $leaf
$headers = @{
  "User-Agent" = "PlayOn-Node"
  "Accept" = "application/octet-stream"
  "Cache-Control" = "no-cache"
  "Pragma" = "no-cache"
}
$lastErr = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    if (Test-Path $archivePath) { Remove-Item -Path $archivePath -Force }
    Write-Log "Downloading attempt=$attempt $DownloadUrl"
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $archivePath -UseBasicParsing -Headers $headers
    $len = (Get-Item -LiteralPath $archivePath).Length
    if ($ExpectedSize -gt 0 -and $len -ne $ExpectedSize) {
      throw "update_download_size_mismatch: expected $ExpectedSize got $len"
    }
    $kind = Get-ArchiveKind -Path $archivePath
    if ($kind -ne "gzip" -and $kind -ne "zip") {
      throw "update_download_not_archive: kind=$kind bytes=$len"
    }
    $got = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash
    if ($got.ToLower() -ne $Sha256.ToLower()) {
      throw "update_sha256_mismatch: expected $Sha256 got $got bytes=$len expectedBytes=$ExpectedSize kind=$kind"
    }
    $lastErr = $null
    break
  } catch {
    $lastErr = $_
    Write-Log "Download attempt $attempt failed: $($_.Exception.Message)"
    if ($attempt -eq 3) { throw }
    Start-Sleep -Seconds (2 * $attempt)
  }
}
if ($lastErr) { throw $lastErr }
Write-Log "Checksum ok"
$destDir = Join-Path $staging "extracted"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$isZip = $archivePath.ToLower().EndsWith(".zip")
if ($isZip) {
  & tar -xf $archivePath -C $destDir
  if ($LASTEXITCODE -ne 0) {
    Write-Log "tar zip extract failed; Expand-Archive fallback"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $destDir -Force
  }
} else {
  & tar -xzf $archivePath -C $destDir
  if ($LASTEXITCODE -ne 0) { throw "update_extract_failed: tar exit $LASTEXITCODE" }
}
$extracted = Find-ExtractedRoot -DestDir $destDir
$helper = Join-Path $extracted "deploy\windows\apply-self-update.ps1"
if (-not (Test-Path $helper)) { throw "update_helper_missing: $helper" }
Write-Log "Launching apply-self-update.ps1 (breakaway) source=$extracted"
$preserve = @("data", "env", "node.env", "node.env.cmd")
$helperArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $helper,
  "-SourceDir", $extracted, "-TargetDir", $installRoot, "-AgentPid", "$agentPid"
)
foreach ($name in $preserve) { $helperArgs += @("-Preserve", $name) }
Start-Process -FilePath "powershell.exe" -ArgumentList $helperArgs -WindowStyle Hidden | Out-Null
Write-Log "Helper started; apply-self-update.ps1 will wait for PID $agentPid then swap."
