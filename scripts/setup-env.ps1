[CmdletBinding()]
param(
  [switch]$InstallMissing,
  [switch]$SkipInstall,
  [switch]$SkipNpm,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$LocalEnvPath = Join-Path $Root '.gemsync.local.ps1'
$Missing = New-Object System.Collections.Generic.List[string]
$Results = [ordered]@{}

if ($CheckOnly) {
  $SkipInstall = $true
  $SkipNpm = $true
}

function Write-Info {
  param([string]$Message)
  Write-Host "[GemSync] $Message" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-WarnLine {
  param([string]$Message)
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Get-EnvValue {
  param([string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not $value) { $value = [Environment]::GetEnvironmentVariable($Name, 'User') }
  if (-not $value) { $value = [Environment]::GetEnvironmentVariable($Name, 'Machine') }
  if ($value) { return $value.Trim().Trim('"') }
  return $null
}

function Resolve-CommandPath {
  param([string[]]$Names)
  foreach ($name in $Names) {
    if (-not $name) { continue }
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { continue }
    $path = $command.Source
    if (-not $path) { $path = $command.Path }
    if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $path).Path
    }
  }
  return $null
}

function Resolve-CommonPath {
  param([string[]]$Candidates)
  foreach ($candidate in $Candidates) {
    if (-not $candidate) { continue }
    if ($candidate.Contains('*') -or $candidate.Contains('?')) {
      $match = Get-ChildItem -Path $candidate -File -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
      if ($match) { return $match.FullName }
    } elseif (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Resolve-Tool {
  param(
    [string]$EnvName,
    [string[]]$Commands,
    [string[]]$CommonPaths
  )

  $envValue = Get-EnvValue $EnvName
  if ($envValue) {
    if (Test-Path -LiteralPath $envValue -PathType Leaf) {
      return (Resolve-Path -LiteralPath $envValue).Path
    }
    $fromEnvCommand = Resolve-CommandPath @($envValue)
    if ($fromEnvCommand) { return $fromEnvCommand }
  }

  $fromCommand = Resolve-CommandPath $Commands
  if ($fromCommand) { return $fromCommand }

  return Resolve-CommonPath $CommonPaths
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($machinePath) { $parts += $machinePath }
  if ($userPath) { $parts += $userPath }
  $env:Path = ($parts -join ';')
}

function Install-WingetPackage {
  param(
    [string]$Name,
    [string]$PackageId
  )

  if ($SkipInstall) {
    Write-WarnLine "$Name is missing. Install skipped."
    return
  }

  if (-not $InstallMissing) {
    $answer = Read-Host "$Name is missing. Install with winget now? [Y/n]"
    if ($answer -and $answer -notmatch '^(y|yes)$') {
      Write-WarnLine "$Name install skipped."
      return
    }
  }

  $winget = Resolve-CommandPath @('winget.exe', 'winget')
  if (-not $winget) {
    Write-WarnLine "winget was not found. Please install $Name manually."
    return
  }

  Write-Info "Installing $Name with winget package $PackageId ..."
  & $winget install --id $PackageId --exact --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-WarnLine "winget install failed for $Name. Exit code: $LASTEXITCODE"
    return
  }
  Refresh-Path
}

function Get-MajorVersion {
  param([string]$VersionText)
  if ($VersionText -match 'v?(\d+)') { return [int]$Matches[1] }
  return 0
}

function Invoke-Version {
  param(
    [string]$Path,
    [string[]]$Args
  )
  try {
    $output = & $Path @Args 2>$null | Select-Object -First 1
    if ($output) { return [string]$output }
  } catch {
    return ''
  }
  return ''
}

function Invoke-PythonProbe {
  param(
    [string]$Command,
    [string[]]$PrefixArgs = @()
  )
  try {
    $probe = "import sys; print(sys.executable); print('%d.%d.%d' % sys.version_info[:3])"
    $lines = & $Command @PrefixArgs -c $probe 2>$null
    if ($LASTEXITCODE -eq 0 -and $lines.Count -ge 2) {
      $pythonPath = [string]$lines[0]
      $version = [string]$lines[1]
      if ($pythonPath -and (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
        return [pscustomobject]@{
          Path = (Resolve-Path -LiteralPath $pythonPath).Path
          Version = $version
        }
      }
    }
  } catch {
    return $null
  }
  return $null
}

function Resolve-Python {
  $envPython = Resolve-Tool -EnvName 'GEMSYNC_PYTHON' -Commands @() -CommonPaths @()
  if ($envPython) {
    $probe = Invoke-PythonProbe -Command $envPython
    if ($probe) { return $probe }
  }

  foreach ($name in @('python.exe', 'python', 'python3.exe', 'python3')) {
    $commandPath = Resolve-CommandPath @($name)
    if (-not $commandPath) { continue }
    $probe = Invoke-PythonProbe -Command $commandPath
    if ($probe) { return $probe }
  }

  $pyLauncher = Resolve-CommandPath @('py.exe', 'py')
  if ($pyLauncher) {
    $probe = Invoke-PythonProbe -Command $pyLauncher -PrefixArgs @('-3')
    if ($probe) { return $probe }
  }

  $common = @()
  if ($env:LOCALAPPDATA) {
    $common += Join-Path $env:LOCALAPPDATA 'Programs\Python\Python*\python.exe'
  }
  if ($env:ProgramFiles) {
    $common += Join-Path $env:ProgramFiles 'Python*\python.exe'
  }
  $commonPython = Resolve-CommonPath $common
  if ($commonPython) {
    $probe = Invoke-PythonProbe -Command $commonPython
    if ($probe) { return $probe }
  }
  return $null
}

function Resolve-Node {
  param([string[]]$CommonPaths)

  $candidates = @()
  $envNode = Get-EnvValue 'GEMSYNC_NODE'
  if ($envNode) {
    if (Test-Path -LiteralPath $envNode -PathType Leaf) {
      $candidates += (Resolve-Path -LiteralPath $envNode).Path
    } else {
      $fromEnvCommand = Resolve-CommandPath @($envNode)
      if ($fromEnvCommand) { $candidates += $fromEnvCommand }
    }
  }

  $fromCommand = Resolve-CommandPath @('node.exe', 'node')
  if ($fromCommand) { $candidates += $fromCommand }

  $fromCommon = Resolve-CommonPath $CommonPaths
  if ($fromCommon) { $candidates += $fromCommon }

  $seen = @{}
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $key = $candidate.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true

    $version = Invoke-Version -Path $candidate -Args @('--version')
    if ((Get-MajorVersion $version) -gt 0) {
      return [pscustomobject]@{
        Path = $candidate
        Version = $version
      }
    }
  }

  return $null
}

function Set-GemSyncEnv {
  param(
    [string]$Name,
    [string]$Value
  )
  if (-not $Value -or $CheckOnly) { return }
  [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
  Set-Item -Path "Env:$Name" -Value $Value
}

function Quote-PowerShellString {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Add-CommonPath {
  param(
    [string[]]$List,
    [string]$Base,
    [string]$Child
  )
  if ($Base) { return $List + (Join-Path $Base $Child) }
  return $List
}

Write-Info "Checking GemSync Manager environment..."
Refresh-Path

$nodeCommon = @()
$nodeCommon = Add-CommonPath $nodeCommon $env:ProgramFiles 'nodejs\node.exe'
$nodeCommon = Add-CommonPath $nodeCommon ${env:ProgramFiles(x86)} 'nodejs\node.exe'
$nodeCommon = Add-CommonPath $nodeCommon $env:LOCALAPPDATA 'Programs\nodejs\node.exe'

$node = Resolve-Node -CommonPaths $nodeCommon
if (-not $node) {
  Install-WingetPackage -Name 'Node.js LTS' -PackageId 'OpenJS.NodeJS.LTS'
  $node = Resolve-Node -CommonPaths $nodeCommon
}
if ($node) {
  if ((Get-MajorVersion $node.Version) -lt 20) {
    Write-WarnLine "Node.js $($node.Version) found, but GemSync needs Node.js 20 or newer."
    Install-WingetPackage -Name 'Node.js LTS' -PackageId 'OpenJS.NodeJS.LTS'
    $node = Resolve-Node -CommonPaths $nodeCommon
  }
  if ($node -and (Get-MajorVersion $node.Version) -ge 20) {
    $Results['Node'] = [pscustomobject]@{ Path = $node.Path; Version = $node.Version }
    Write-Ok "Node.js $($node.Version) -> $($node.Path)"
  } else {
    $Missing.Add('Node.js 20+')
  }
} else {
  $Missing.Add('Node.js 20+')
}

$python = Resolve-Python
if (-not $python) {
  Install-WingetPackage -Name 'Python 3' -PackageId 'Python.Python.3.12'
  $python = Resolve-Python
}
if ($python -and (Get-MajorVersion $python.Version) -ge 3) {
  $Results['Python'] = $python
  Write-Ok "Python $($python.Version) -> $($python.Path)"
} else {
  $Missing.Add('Python 3')
}

$popplerPackage = 'oschwartz10612.Poppler'
$pdfinfoCommon = @()
$pdftoppmCommon = @()
$pdfinfoCommon = Add-CommonPath $pdfinfoCommon $env:ProgramFiles 'poppler\Library\bin\pdfinfo.exe'
$pdfinfoCommon += 'C:\poppler\Library\bin\pdfinfo.exe'
$pdftoppmCommon = Add-CommonPath $pdftoppmCommon $env:ProgramFiles 'poppler\Library\bin\pdftoppm.exe'
$pdftoppmCommon += 'C:\poppler\Library\bin\pdftoppm.exe'
if ($env:LOCALAPPDATA) {
  $wingetBase = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  $pdfinfoCommon += Join-Path $wingetBase 'oschwartz10612.Poppler_*\poppler-*\Library\bin\pdfinfo.exe'
  $pdfinfoCommon += Join-Path $wingetBase 'oschwartz10612.Poppler_*\Library\bin\pdfinfo.exe'
  $pdftoppmCommon += Join-Path $wingetBase 'oschwartz10612.Poppler_*\poppler-*\Library\bin\pdftoppm.exe'
  $pdftoppmCommon += Join-Path $wingetBase 'oschwartz10612.Poppler_*\Library\bin\pdftoppm.exe'
}

$pdfinfoPath = Resolve-Tool -EnvName 'GEMSYNC_PDFINFO' -Commands @('pdfinfo.exe', 'pdfinfo') -CommonPaths $pdfinfoCommon
$pdftoppmPath = Resolve-Tool -EnvName 'GEMSYNC_PDFTOPPM' -Commands @('pdftoppm.exe', 'pdftoppm') -CommonPaths $pdftoppmCommon
if (-not $pdfinfoPath -or -not $pdftoppmPath) {
  Install-WingetPackage -Name 'Poppler' -PackageId $popplerPackage
  $pdfinfoPath = Resolve-Tool -EnvName 'GEMSYNC_PDFINFO' -Commands @('pdfinfo.exe', 'pdfinfo') -CommonPaths $pdfinfoCommon
  $pdftoppmPath = Resolve-Tool -EnvName 'GEMSYNC_PDFTOPPM' -Commands @('pdftoppm.exe', 'pdftoppm') -CommonPaths $pdftoppmCommon
}
if ($pdfinfoPath -and $pdftoppmPath) {
  $Results['PdfInfo'] = [pscustomobject]@{ Path = $pdfinfoPath }
  $Results['PdfToPpm'] = [pscustomobject]@{ Path = $pdftoppmPath }
  Write-Ok "pdfinfo -> $pdfinfoPath"
  Write-Ok "pdftoppm -> $pdftoppmPath"
} else {
  $Missing.Add('Poppler: pdfinfo + pdftoppm')
}

$officeCommon = @()
$officeCommon = Add-CommonPath $officeCommon $env:ProgramFiles 'LibreOffice\program\soffice.exe'
$officeCommon = Add-CommonPath $officeCommon ${env:ProgramFiles(x86)} 'LibreOffice\program\soffice.exe'
$officePath = Resolve-Tool -EnvName 'GEMSYNC_SOFFICE' -Commands @('soffice.exe', 'soffice', 'libreoffice') -CommonPaths $officeCommon
if (-not $officePath) {
  Install-WingetPackage -Name 'LibreOffice' -PackageId 'TheDocumentFoundation.LibreOffice'
  $officePath = Resolve-Tool -EnvName 'GEMSYNC_SOFFICE' -Commands @('soffice.exe', 'soffice', 'libreoffice') -CommonPaths $officeCommon
}
if ($officePath) {
  $Results['LibreOffice'] = [pscustomobject]@{ Path = $officePath }
  Write-Ok "LibreOffice -> $officePath"
} else {
  Write-WarnLine "LibreOffice was not found. PPT/PPTX conversion will not work until it is installed."
}

$chromeCommon = @()
$chromeCommon = Add-CommonPath $chromeCommon $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
$chromeCommon = Add-CommonPath $chromeCommon ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
$chromeCommon = Add-CommonPath $chromeCommon $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
$chromePath = Resolve-Tool -EnvName 'GEMSYNC_CHROME' -Commands @('chrome.exe', 'chrome') -CommonPaths $chromeCommon
if (-not $chromePath) {
  Install-WingetPackage -Name 'Google Chrome' -PackageId 'Google.Chrome'
  $chromePath = Resolve-Tool -EnvName 'GEMSYNC_CHROME' -Commands @('chrome.exe', 'chrome') -CommonPaths $chromeCommon
}
if ($chromePath) {
  $Results['Chrome'] = [pscustomobject]@{ Path = $chromePath }
  Write-Ok "Chrome -> $chromePath"
} else {
  $Missing.Add('Google Chrome')
}

$automationScripts = Join-Path $Root 'scripts'

if (-not $CheckOnly) {
  if ($Results.Contains('Node')) { Set-GemSyncEnv 'GEMSYNC_NODE' $Results['Node'].Path }
  if ($Results.Contains('Python')) { Set-GemSyncEnv 'GEMSYNC_PYTHON' $Results['Python'].Path }
  if ($Results.Contains('PdfInfo')) { Set-GemSyncEnv 'GEMSYNC_PDFINFO' $Results['PdfInfo'].Path }
  if ($Results.Contains('PdfToPpm')) { Set-GemSyncEnv 'GEMSYNC_PDFTOPPM' $Results['PdfToPpm'].Path }
  if ($Results.Contains('Chrome')) { Set-GemSyncEnv 'GEMSYNC_CHROME' $Results['Chrome'].Path }
  Set-GemSyncEnv 'GEMSYNC_AUTOMATION_SCRIPTS' $automationScripts

  $lines = @(
    '# Generated by scripts/setup-env.ps1. This file contains local machine paths.',
    '# It is ignored by git and can be regenerated at any time.'
  )
  if ($Results.Contains('Node')) { $lines += '$env:GEMSYNC_NODE = ' + (Quote-PowerShellString $Results['Node'].Path) }
  if ($Results.Contains('Python')) { $lines += '$env:GEMSYNC_PYTHON = ' + (Quote-PowerShellString $Results['Python'].Path) }
  if ($Results.Contains('PdfInfo')) { $lines += '$env:GEMSYNC_PDFINFO = ' + (Quote-PowerShellString $Results['PdfInfo'].Path) }
  if ($Results.Contains('PdfToPpm')) { $lines += '$env:GEMSYNC_PDFTOPPM = ' + (Quote-PowerShellString $Results['PdfToPpm'].Path) }
  if ($Results.Contains('Chrome')) { $lines += '$env:GEMSYNC_CHROME = ' + (Quote-PowerShellString $Results['Chrome'].Path) }
  $lines += '$env:GEMSYNC_AUTOMATION_SCRIPTS = ' + (Quote-PowerShellString $automationScripts)
  Set-Content -LiteralPath $LocalEnvPath -Value $lines -Encoding UTF8
  Write-Ok "Local config written: $LocalEnvPath"
  Write-Ok "User environment variables updated."
}

if (-not $SkipNpm -and $Results.Contains('Node')) {
  $npm = Resolve-CommandPath @('npm.cmd', 'npm')
  if (-not $npm) {
    $npmCandidate = Join-Path (Split-Path -Parent $Results['Node'].Path) 'npm.cmd'
    if (Test-Path -LiteralPath $npmCandidate -PathType Leaf) { $npm = $npmCandidate }
  }
  if ($npm) {
    Write-Info "Installing Node dependencies with npm install..."
    Push-Location $Root
    try {
      & $npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
    Write-Ok "Node dependencies are ready."
  } else {
    Write-WarnLine "npm was not found. Run npm install manually after Node.js is available."
  }
}

Write-Host ''
Write-Info "Summary"
foreach ($key in $Results.Keys) {
  $item = $Results[$key]
  if ($item.Version) {
    Write-Host ("- {0}: {1} ({2})" -f $key, $item.Path, $item.Version)
  } else {
    Write-Host ("- {0}: {1}" -f $key, $item.Path)
  }
}

if ($Missing.Count -gt 0) {
  Write-Host ''
  Write-WarnLine "Still missing: $($Missing -join ', ')"
  if ($CheckOnly) { exit 0 }
  exit 1
}

Write-Host ''
Write-Ok "GemSync environment is ready. Start with: .\start.ps1"
