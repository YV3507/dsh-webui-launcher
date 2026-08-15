<#
.SYNOPSIS
  Render the dsh SVG mark into the Windows .ico used by the Web UI quick-launch
  shortcut.

.DESCRIPTION
  Renders apps/web/public/favicon.svg (or -SvgPath) at every requested size
  with the local Microsoft Edge in headless mode, then packs the PNGs into one
  .ico. The SVG's own prefers-color-scheme rule turns the mark white under a
  dark color scheme, so -ColorScheme dark produces a light-on-transparent icon
  for dark desktops; the light scheme (default) is the black mark.

.PARAMETER SvgPath
  The SVG to render. Defaults to apps/web/public/favicon.svg in the checkout.

.PARAMETER OutIco
  Where to write the .ico. Defaults to scripts/windows/dsh-webui.ico.

.PARAMETER ColorScheme
  light (black mark, default) or dark (white mark via the SVG media query).

.PARAMETER Sizes
  Icon sizes in pixels. Defaults to 16, 24, 32, 48, 64, 128, 256.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\build-icon.ps1
  Regenerate scripts\windows\dsh-webui.ico from the favicon.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\build-icon.ps1 -ColorScheme dark -OutIco "$env:USERPROFILE\Desktop\dsh-dark.ico"
#>
[CmdletBinding()]
param(
  [string]$SvgPath = '',
  [string]$OutIco = '',
  [ValidateSet('light', 'dark')]
  [string]$ColorScheme = 'light',
  [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
if ($SvgPath -eq '') { $SvgPath = Join-Path $repoRoot 'apps\web\public\favicon.svg' }
if ($OutIco -eq '') { $OutIco = Join-Path $scriptDir 'dsh-webui.ico' }
if (-not (Test-Path $SvgPath)) { throw "SVG not found: $SvgPath" }

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) {
  $candidate = (Get-Command msedge -ErrorAction SilentlyContinue).Source
  if ($candidate -eq '') { throw 'Microsoft Edge not found; it renders the SVG' }
  $edge = $candidate
}

$svgContent = Get-Content -Path $SvgPath -Raw
# Chromium renders an SVG document at its intrinsic size; rewrite the width and
# height attributes so the rendered bitmap is exactly the requested size.
$scaledSvg = { param([int]$Size)
  return ($svgContent -replace 'width="[^"]*"', "width=`"$Size`"" -replace 'height="[^"]*"', "height=`"$Size`"")
}

$work = Join-Path $env:TEMP ("dsh-icon-" + $PID)
New-Item -ItemType Directory -Force -Path $work | Out-Null
$pngs = @()
try {
  foreach ($size in $Sizes) {
    $svgFile = Join-Path $work "mark-$size.svg"
    Set-Content -Path $svgFile -Value (& $scaledSvg $size) -Encoding utf8
    $pngFile = Join-Path $work "mark-$size.png"
    $arguments = @(
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--default-background-color=00000000',
      "--user-data-dir=$(Join-Path $work "profile-$size")",
      "--screenshot=$pngFile",
      "--window-size=$size,$size",
      ('file:///' + ($svgFile -replace '\\', '/'))
    )
    if ($ColorScheme -eq 'dark') { $arguments += '--force-dark-mode' }
    $null = Start-Process -FilePath $edge -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden -ErrorAction SilentlyContinue
    if (-not (Test-Path $pngFile)) { throw "Edge produced no screenshot for size $size" }
    $pngs += [pscustomobject]@{ Size = $size; Path = $pngFile }
  }

  # Pack the PNGs into an ICO container (PNG-compressed entries; supported by
  # Windows Vista and later, including every entry size on Windows 11).
  $pngs = $pngs | Sort-Object Size
  $count = $pngs.Count
  $offset = 6 + 16 * $count
  $writer = New-Object System.IO.BinaryWriter([System.IO.File]::Create($OutIco))
  try {
    $writer.Write([uint16]0)   # reserved
    $writer.Write([uint16]1)   # type: icon
    $writer.Write([uint16]$count)
    foreach ($png in $pngs) {
      $bytes = [System.IO.File]::ReadAllBytes($png.Path)
      $dimension = if ($png.Size -ge 256) { 0 } else { $png.Size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)   # palette
      $writer.Write([byte]0)   # reserved
      $writer.Write([uint16]1) # color planes
      $writer.Write([uint16]32) # bits per pixel
      $writer.Write([uint32]$bytes.Length)
      $writer.Write([uint32]$offset)
      $offset += $bytes.Length
    }
    foreach ($png in $pngs) {
      $writer.Write([System.IO.File]::ReadAllBytes($png.Path))
    }
    $writer.Flush()
  } finally {
    $writer.Close()
  }
} finally {
  Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "created $OutIco ($($pngs.Count) sizes, $ColorScheme mark)"
