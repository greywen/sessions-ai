# sessions-ai Agent - Windows one-click installer
#
# Usage (PowerShell, will self-elevate to Administrator if needed):
#   iwr -useb https://raw.githubusercontent.com/greywen/sessions-ai/main/scripts/install-agent.ps1 -OutFile $env:TEMP\sa.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\sa.ps1 -ServerUrl http://your-host:23712
# Or local:
#   powershell -ExecutionPolicy Bypass -File scripts\install-agent.ps1 -ServerUrl http://your-host:23712
#
# What it does:
#   1. Self-elevates to Administrator
#   2. Installs Bun (https://bun.sh) if missing
#   3. Installs Node.js LTS via winget if `npm` is missing
#   4. npm i -g sessions-ai
#   5. (optional) sessions-ai config set serverUrl <ServerUrl>
#   6. sessions-ai service install   (registers a hidden Task Scheduler task)

[CmdletBinding()]
param(
  [string]$ServerUrl = '',
  [switch]$NoService
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host '[sessions-ai] Re-launching as Administrator...' -ForegroundColor Yellow
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($ServerUrl) { $argv += @('-ServerUrl', $ServerUrl) }
  if ($NoService) { $argv += '-NoService' }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argv
  exit
}

function Has-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function First-Line([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return '' }
  return ($text -split "\r?\n")[0].Trim()
}

function Get-SessionsCommand {
  $cmd = Get-Command 'sessions-ai' -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $cmd = Get-Command 'sessions-ai.cmd' -ErrorAction SilentlyContinue
  }
  return $cmd
}

Write-Host '== sessions-ai Agent installer (Windows) ==' -ForegroundColor Cyan

# 1. Bun
if (-not (Has-Cmd 'bun')) {
  Write-Host '[sessions-ai] Installing Bun...' -ForegroundColor Cyan
  powershell -NoProfile -Command "irm https://bun.sh/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
} else {
  Write-Host "[sessions-ai] Bun present: $(bun --version)" -ForegroundColor Green
}

# 2. Node + npm
if (-not (Has-Cmd 'npm')) {
  if (Has-Cmd 'winget') {
    Write-Host '[sessions-ai] Installing Node.js LTS via winget...' -ForegroundColor Cyan
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements

    # Refresh PATH for current process so newly installed node/npm can be found.
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
  } else {
    throw 'npm not found and winget unavailable. Please install Node.js LTS from https://nodejs.org'
  }
}

# 3. sessions-ai
Write-Host '[sessions-ai] Installing sessions-ai globally via npm...' -ForegroundColor Cyan
npm install -g sessions-ai

# Ensure global npm bin is in current process PATH.
if (-not (Get-SessionsCommand)) {
  try {
    $npmBin = First-Line (npm bin -g 2>$null)
    if ($npmBin) {
      $env:Path = "$npmBin;$env:Path"
    }
  } catch {
    # No-op: keep going and let subsequent commands surface actionable errors.
  }
}

# 4. Configure server URL
if ($ServerUrl) {
  Write-Host "[sessions-ai] Setting serverUrl = $ServerUrl" -ForegroundColor Cyan
  sessions-ai config set serverUrl $ServerUrl
}

# 5. Service
if (-not $NoService) {
  Write-Host '[sessions-ai] Installing autostart service (Task Scheduler, no console window)...' -ForegroundColor Cyan
  sessions-ai service install
} else {
  Write-Host '[sessions-ai] -NoService specified, skipping service install.' -ForegroundColor Yellow
}

Write-Host ''

$sessionsCmd = Get-SessionsCommand
$cliPath = if ($sessionsCmd) { $sessionsCmd.Source } else { '' }

$npmPrefix = ''
try {
  $npmPrefix = First-Line (npm prefix -g 2>$null)
} catch {
  $npmPrefix = ''
}

$configPath = ''
if ($sessionsCmd) {
  try {
    $configPath = First-Line (& sessions-ai config path 2>$null)
  } catch {
    $configPath = ''
  }
}

if (-not $configPath) {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
  $configPath = Join-Path $localAppData 'sessions-ai\config.json'
}

$dataDir = Split-Path -Parent $configPath
$logPath = Join-Path $dataDir 'service\supervisor.log'

Write-Host '[sessions-ai] Install completed successfully.' -ForegroundColor Green
Write-Host 'Summary:' -ForegroundColor Green
if ($cliPath) {
  Write-Host "  CLI path:    $cliPath"
}
if ($npmPrefix) {
  Write-Host "  npm prefix:  $npmPrefix"
}
Write-Host "  Config path: $configPath"
Write-Host "  Data dir:    $dataDir"
Write-Host "  Logs:        $logPath"
if ($ServerUrl) {
  Write-Host "  Server URL:  $ServerUrl"
}
if (-not $NoService) {
  Write-Host "  Service:     Task Scheduler task 'sessions-ai-agent' installed"
} else {
  Write-Host '  Service:     skipped (--NoService)'
}

Write-Host ''
Write-Host 'Useful commands:' -ForegroundColor Cyan
Write-Host '  sessions-ai config show'
Write-Host '  sessions-ai config path'
if (-not $NoService) {
  Write-Host '  sessions-ai service uninstall'
}
Write-Host "  Get-Content -Path `"$logPath`" -Tail 100 -Wait"
