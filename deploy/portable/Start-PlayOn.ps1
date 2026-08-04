# Copy to PlayOn Home bundle root as Start-PlayOn.ps1 (package-home does this).
# Run: right-click → Run with PowerShell
#   or: powershell -ExecutionPolicy Bypass -File .\Start-PlayOn.ps1
$ErrorActionPreference = "Stop"
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $Root

$Node = Join-Path $Root "runtime\node\node.exe"
$Launcher = Join-Path $Root "deploy\portable\start-home.mjs"

if (-not (Test-Path $Node)) {
  Write-Host "Bundled Node not found at runtime\node\node.exe"
  Write-Host "Re-download the Windows PlayOn Home package, or run:"
  Write-Host "  node deploy\portable\start-home.mjs"
  exit 1
}

if (-not (Test-Path $Launcher)) {
  Write-Host "Missing $Launcher"
  exit 1
}

& $Node $Launcher
exit $LASTEXITCODE
