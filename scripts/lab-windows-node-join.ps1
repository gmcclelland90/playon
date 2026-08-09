#Requires -RunAsAdministrator
<#
  Join this Windows host to the playon-dev Home as a lab Windows worker.

  Run ON the Windows machine (elevated PowerShell), after it can reach Home:

    Test-NetConnection 172.16.0.156 -Port 8787

  Then:

    $env:PLAYON_NODE_TOKEN = '<token from playon-dev /etc/playon/playon.env>'
    irm https://raw.githubusercontent.com/gmcclelland90/playon/main/deploy/windows/install-node.ps1 -OutFile $env:TEMP\install-node.ps1
    # or copy deploy/windows/install-node.ps1 from the repo

    powershell -File .\scripts\lab-windows-node-join.ps1

  Optional env:
    PLAYON_API_URL   default http://172.16.0.156:8787
    PLAYON_NODE_ID   default playon-win-1
#>
$ErrorActionPreference = "Stop"

$ApiUrl = if ($env:PLAYON_API_URL) { $env:PLAYON_API_URL } else { "http://172.16.0.156:8787" }
$Token = $env:PLAYON_NODE_TOKEN
$NodeId = if ($env:PLAYON_NODE_ID) { $env:PLAYON_NODE_ID } else { "playon-win-1" }

if (-not $Token) {
  throw "Set PLAYON_NODE_TOKEN to the same value as playon-dev /etc/playon/playon.env"
}

Write-Host "==> Probing Home $ApiUrl"
try {
  Invoke-WebRequest -Uri $ApiUrl -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
  throw "Cannot reach Home at $ApiUrl — put this PC on the 172.16.0.0/16 LAN (or route it) and allow TCP 8787. $_"
}

$script = Join-Path $PSScriptRoot "..\deploy\windows\install-node.ps1"
if (-not (Test-Path $script)) {
  $url = "https://raw.githubusercontent.com/gmcclelland90/playon/main/deploy/windows/install-node.ps1"
  $script = Join-Path $env:TEMP "playon-install-node.ps1"
  Write-Host "==> Downloading install-node.ps1"
  Invoke-WebRequest -Uri $url -OutFile $script -UseBasicParsing
}

Write-Host "==> Installing node $NodeId -> $ApiUrl"
& $script -ApiUrl $ApiUrl -Token $Token -NodeId $NodeId -Runtime native

Write-Host @"

Done. In Home UI → Settings → Nodes, expect $NodeId online with os=windows.
Scheduled task: PlayOnNodeAgent
Data: C:\playon-node\data
"@
