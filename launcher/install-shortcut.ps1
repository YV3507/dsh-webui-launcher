<#
.SYNOPSIS
  Install the DeepSeek Harness Web UI quick-launch shortcut.

.DESCRIPTION
  Creates a shortcut on the current user's desktop (and, with -StartMenu, in
  the Start Menu) that launches dsh-webui.vbs through wscript.exe, exactly as
  double-clicking the .vbs would, but with an application-style icon and name.
  The shortcut is named after the -ShortcutName parameter.

.PARAMETER ShortcutName
  Display name of the shortcut. Defaults to "DeepSeek Harness Web UI".

.PARAMETER StartMenu
  Also create the shortcut under the current user's Start Menu Programs.

.PARAMETER IconPath
  The .ico to use for the shortcut. Defaults to dsh-webui.ico beside this
  script (falling back to a generic shell icon when it is absent); pass
  dsh-webui-dark.ico for the white mark on dark desktops.

.PARAMETER Destination
  Override the destination folder (mainly for testing); the real desktop is the
  default when omitted.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-shortcut.ps1 -StartMenu
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-shortcut.ps1 -IconPath scripts\windows\dsh-webui-dark.ico
#>
[CmdletBinding()]
param(
  [string]$ShortcutName = 'DeepSeek Harness Web UI',
  [switch]$StartMenu,
  [string]$IconPath = '',
  [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $scriptDir 'dsh-webui.vbs'
if (-not (Test-Path $vbs)) { throw "dsh-webui.vbs not found: $vbs" }
if ($IconPath -eq '') { $IconPath = Join-Path $scriptDir 'dsh-webui.ico' }
if (-not (Test-Path $IconPath)) {
  Write-Warning "icon not found, using the generic shell icon: $IconPath"
  $IconPath = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',220'
}

$destinations = @()
if ($Destination -ne '') {
  $destinations += $Destination
} else {
  $destinations += Join-Path $env:USERPROFILE 'Desktop'
  if ($StartMenu) {
    $destinations += Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  }
}

$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $destinations) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $linkPath = Join-Path $dir "$ShortcutName.lnk"
  $link = $shell.CreateShortcut($linkPath)
  $link.TargetPath = $wscript
  $link.Arguments = '"' + $vbs + '"'
  $link.WorkingDirectory = $scriptDir
  $link.Description = 'Start DeepSeek Harness in the background and open its Web UI in the default browser; the harness stops when its browser closes.'
  $link.IconLocation = $IconPath
  $link.Save()
  Write-Host "created shortcut: $linkPath"
}
