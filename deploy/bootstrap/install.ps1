# PlayOn Home — one-line installer (Windows x64)
#   irm https://playon.games/install.ps1 | iex
#
# Env (optional):
#   PLAYON_HOME     Install directory (default: %LOCALAPPDATA%\PlayOn)
#   PLAYON_REPO     GitHub owner/repo (default: gmcclelland90/playon)
#   PLAYON_VERSION  Release tag, e.g. v0.1.0 (default: latest)
#   PLAYON_START    0 to skip launching after install (default: 1)
#   PLAYON_SERVICE  1 to register scheduled tasks via deploy\windows\install.ps1 (default: 0)

$ErrorActionPreference = "Stop"

$Repo = if ($env:PLAYON_REPO) { $env:PLAYON_REPO } else { "gmcclelland90/playon" }
$HomeDir = if ($env:PLAYON_HOME) { $env:PLAYON_HOME } else { Join-Path $env:LOCALAPPDATA "PlayOn" }
$DoStart = if ($null -ne $env:PLAYON_START -and $env:PLAYON_START -eq "0") { $false } else { $true }
$AsService = $env:PLAYON_SERVICE -eq "1"
$AssetPattern = "playon-home-*-windows-x64.zip"

function Get-Release {
  $headers = @{
    "Accept"               = "application/vnd.github+json"
    "User-Agent"           = "PlayOn-Install"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  if ($env:PLAYON_VERSION) {
    $tag = $env:PLAYON_VERSION.Trim()
    if (-not $tag.StartsWith("v")) { $tag = "v$tag" }
    $url = "https://api.github.com/repos/$Repo/releases/tags/$tag"
  } else {
    $url = "https://api.github.com/repos/$Repo/releases/latest"
  }
  return Invoke-RestMethod -Uri $url -Headers $headers
}

Write-Host "==> PlayOn Home install"
Write-Host "    Repo: $Repo"
Write-Host "    Dir:  $HomeDir"

$release = Get-Release
$asset = $release.assets | Where-Object { $_.name -like $AssetPattern } | Select-Object -First 1
if (-not $asset) {
  throw "No asset matching '$AssetPattern' on release $($release.tag_name). Publish a Home package first."
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("playon-home-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$zipPath = Join-Path $staging $asset.name

Write-Host "==> Downloading $($asset.name) ($($release.tag_name))"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing

Write-Host "==> Extracting"
Expand-Archive -Path $zipPath -DestinationPath $staging -Force
$extracted = Get-ChildItem -Path $staging -Directory | Where-Object { $_.Name -ne "__MACOSX" } | Select-Object -First 1
if (-not $extracted -or -not (Test-Path (Join-Path $extracted.FullName "Start-PlayOn.ps1"))) {
  $candidate = Join-Path $staging "playon"
  if (Test-Path (Join-Path $candidate "Start-PlayOn.ps1")) {
    $extracted = Get-Item $candidate
  } else {
    throw "Extracted archive missing Start-PlayOn.ps1"
  }
}

if (Test-Path $HomeDir) {
  Write-Host "==> Updating $HomeDir (keeping data\ and env\)"
  Get-ChildItem -Force $extracted.FullName | ForEach-Object {
    $dest = Join-Path $HomeDir $_.Name
    if ($_.Name -in @("data", "env") -and (Test-Path $dest)) { return }
    Copy-Item -Recurse -Force $_.FullName $dest
  }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $HomeDir -Parent) | Out-Null
  Copy-Item -Recurse -Force $extracted.FullName $HomeDir
}

Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue

Write-Host "==> Installed $($release.tag_name) → $HomeDir"

if ($AsService) {
  Write-Host "==> Registering Windows scheduled tasks (elevated)"
  $installPs1 = Join-Path $HomeDir "deploy\windows\install.ps1"
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installPs1, "-InstallRoot", $HomeDir
  ) -Wait
  Write-Host "Done. Open the admin URL printed by the installer."
  return
}

if ($DoStart) {
  Write-Host "==> Starting PlayOn"
  Set-Location $HomeDir
  & (Join-Path $HomeDir "Start-PlayOn.ps1")
} else {
  Write-Host "Start later with:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$HomeDir\Start-PlayOn.ps1`""
}
