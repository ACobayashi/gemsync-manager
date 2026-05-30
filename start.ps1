$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LocalEnv = Join-Path $Root '.gemsync.local.ps1'
if (Test-Path -LiteralPath $LocalEnv) {
  . $LocalEnv
}

$Node = if ($env:GEMSYNC_NODE) { $env:GEMSYNC_NODE } else { 'node' }
$Port = if ($env:GEMSYNC_MANAGER_PORT) { [int]$env:GEMSYNC_MANAGER_PORT } else { 5188 }
$Url = "http://127.0.0.1:$Port"
$LogDir = Join-Path $Root 'logs'
$OutLog = Join-Path $LogDir 'manager.out.log'
$ErrLog = Join-Path $LogDir 'manager.err.log'

if (!(Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

$Running = $false
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/state" -TimeoutSec 2
  $Running = $response.StatusCode -eq 200
} catch {
  $Running = $false
}

if (-not $Running) {
  Start-Process -FilePath $Node `
    -ArgumentList 'server.mjs' `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -WindowStyle Hidden | Out-Null
  Start-Sleep -Milliseconds 900
}

Start-Process $Url
Write-Host "GemSync Manager: $Url"
