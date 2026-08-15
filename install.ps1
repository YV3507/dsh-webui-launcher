<#
.SYNOPSIS
  One-command installer for the DeepSeek Harness Web UI quick-launch.

.DESCRIPTION
  Provisions the dsh CLI (locating an existing deepseek-harness checkout or an
  npm install of @deepseek-ai/dsh, or the runtime\ folder of a release zip),
  deploys the launcher to a stable per-user folder, writes the dsh-webui.json
  sidecar that tells the watchdog where dsh lives, creates the desktop shortcut
  (and optionally a Start Menu one), and runs the watchdog self-test.

.PARAMETER ShRoot
  Path to an existing dsh installation: the deepseek-harness checkout root, or
  the @deepseek-ai/dsh package directory of an npm install. Auto-detected from
  $env:DSH_ROOT, then from the release-zip runtime folder, then from the `dsh`
  command on PATH; otherwise the installer prints what to install first.

.PARAMETER Destination
  Where the launcher files are deployed. Defaults to %LOCALAPPDATA%\dsh-webui-launcher.

.PARAMETER StartMenu
  Also create the shortcut in the Start Menu (the desktop shortcut is always created).

.PARAMETER SkipBuild
  Do not build a source checkout (assumes it is already built).

.PARAMETER ShortcutDestination
  Test hook: where install-shortcut.ps1 puts the shortcut. Defaults to the real desktop.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
  Auto-detect dsh and install.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -ShRoot D:\deepseek-harness
  Install against an existing checkout.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -ShRoot "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
  Install against an npm-global @deepseek-ai/dsh package.
#>
[CmdletBinding()]
param(
  [string]$ShRoot = '',
  [string]$Destination = '',
  [switch]$StartMenu,
  [switch]$SkipBuild,
  [string]$ShortcutDestination = ''
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcherSource = Join-Path $scriptDir 'launcher'
if (-not (Test-Path (Join-Path $launcherSource 'dsh-webui.ps1'))) {
  throw "launcher files not found beside this script: $launcherSource"
}

function Test-DshRoot {
  param([string]$Root)
  if ($Root -eq '') { return $false }
  return (Test-Path (Join-Path $Root 'apps\cli\lib\bin.js'))
    -or (Test-Path (Join-Path $Root 'lib\bin.js'))
    -or (Test-Path (Join-Path $Root 'apps\cli\src\bin.ts'))
}

# ---- 1. resolve the dsh installation
if ($ShRoot -eq '' -and $env:DSH_ROOT -ne '') { $ShRoot = $env:DSH_ROOT }
if ($ShRoot -eq '') {
  $zipRuntime = Join-Path $scriptDir 'runtime\node_modules\@deepseek-ai\dsh'
  if (Test-Path $zipRuntime) { $ShRoot = $zipRuntime }
}
if ($ShRoot -eq '') {
  try {
    $npmRoot = & npm root -g 2>$null | Select-Object -First 1
    if ($npmRoot -and (Test-Path $npmRoot)) {
      $candidate = Join-Path $npmRoot '@deepseek-ai\dsh'
      if (Test-DshRoot $candidate) { $ShRoot = $candidate }
    }
  } catch {
    # npm not on PATH; the guidance below applies
  }
}
if (-not (Test-DshRoot $ShRoot)) {
  Write-Host 'dsh CLI not found. Obtain it first, then rerun with -ShRoot:'
  Write-Host '  1) source checkout: git clone https://github.com/deepseek-ai/deepseek-harness'
  Write-Host '     then in the checkout: pnpm install && pnpm run build'
  Write-Host '  2) npm (once @deepseek-ai/dsh is published): npm install -g @deepseek-ai/dsh'
  Write-Host '  3) rerun: powershell -ExecutionPolicy Bypass -File install.ps1 -ShRoot <path>'
  Write-Host "     (or set the DSH_ROOT environment variable to that path)"
  exit 1
}
$ShRoot = (Resolve-Path $ShRoot).Path
Write-Host "dsh found at: $ShRoot"

# ---- 2. build a source checkout when its CLI is not built yet
$builtBin = Join-Path $ShRoot 'apps\cli\lib\bin.js'
$sourceBin = Join-Path $ShRoot 'apps\cli\src\bin.ts'
if ((Test-Path $sourceBin) -and -not (Test-Path $builtBin) -and -not $SkipBuild) {
  Write-Host 'checkout detected without a built CLI; building (pnpm install + pnpm run build)...'
  Push-Location $ShRoot
  try {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
    & pnpm run build
    if ($LASTEXITCODE -ne 0) { throw 'pnpm run build failed' }
  } finally {
    Pop-Location
  }
}

# ---- 3. deploy the launcher and write the sidecar config
if ($Destination -eq '') { $Destination = Join-Path $env:LOCALAPPDATA 'dsh-webui-launcher' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Copy-Item (Join-Path $launcherSource '*') -Destination $Destination -Recurse -Force
Set-Content -Path (Join-Path $Destination 'dsh-webui.json') -Value ('{ "shRoot": "' + $ShRoot.Replace('\', '\\') + '" }') -Encoding utf8
Write-Host "launcher deployed to: $Destination"

# ---- 4. shortcut and validation
$shortcutScript = Join-Path $Destination 'install-shortcut.ps1'
$shortcutArgs = @{}
if ($StartMenu) { $shortcutArgs.StartMenu = $true }
if ($ShortcutDestination -ne '') { $shortcutArgs.Destination = $ShortcutDestination }
try {
  & $shortcutScript @shortcutArgs
} catch {
  throw "shortcut installation failed: $($_.Exception.Message)"
}

& (Join-Path $Destination 'dsh-webui.ps1') -SelfTest -Quiet
if ($LASTEXITCODE -ne 0) { throw 'watchdog self-test failed; see the logs folder' }

Write-Host ''
Write-Host 'Install complete.'
Write-Host "Double-click the desktop shortcut ""DeepSeek Harness Web UI"" to start."
Write-Host "Uninstall: delete $Destination and the desktop shortcut."
