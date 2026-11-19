# Parse shipped PowerShell with Windows PowerShell 5.1 (#1060).
# Invoke with powershell.exe, not pwsh. PowerShell 7 decodes UTF-8 and hides
# the cp1252 smart-quote failure this guard exists to catch.
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 6) {
  Write-Host "Refusing PowerShell $($PSVersionTable.PSVersion). Use powershell.exe (Windows PowerShell 5.1)."
  exit 2
}

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$skip = @(
  "node_modules",
  "dist",
  "dist-home",
  "dist-node",
  "dist-package",
  ".git",
  "tmp",
  "coverage",
  ".turbo",
  "out"
)

function Get-ShippedScripts([string]$Dir) {
  foreach ($item in Get-ChildItem -LiteralPath $Dir -Force) {
    if ($item.PSIsContainer) {
      if ($skip -contains $item.Name) { continue }
      Get-ShippedScripts $item.FullName
    } elseif ($item.Extension -eq ".ps1" -or $item.Extension -eq ".psm1") {
      $item.FullName
    }
  }
}

$files = @(Get-ShippedScripts $root)
if ($files.Count -lt 1) {
  Write-Host "No .ps1/.psm1 files found under $root"
  exit 1
}

$failed = $false
foreach ($file in $files) {
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) {
    $failed = $true
    Write-Host "PARSE FAIL $file"
    foreach ($err in $errors) {
      Write-Host $err.ToString()
    }
  }
}

Write-Host "PowerShell $($PSVersionTable.PSVersion) parsed $($files.Count) script(s)"
if ($failed) { exit 1 }
exit 0
