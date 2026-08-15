<#
.SYNOPSIS
  Watchdog quick-launch for the DeepSeek Harness Web UI on Windows.

.DESCRIPTION
  Starts `dsh --profile web` hidden in the background, waits until it serves,
  opens the system default browser on the Web UI, and keeps the harness alive
  only while a browser holds a TCP connection to it. When every browser that
  opened the Web UI is closed (no established connection for the grace period),
  the watchdog stops the harness it started and exits.

  The normal entry point is dsh-webui.vbs (double-click it, or the desktop
  shortcut installed by install-shortcut.ps1), which runs this script hidden.
  Run this script directly for diagnostics and tests.

  A server already listening on the port is adopted, not started and never
  stopped: the watchdog only owns the process tree it launched. Exit code 0
  means a normal lifecycle (browser closed and a self-started harness stopped,
  or an adopted server left running); exit code 1 means startup failed or the
  self-started server crashed.

.PARAMETER Port
  The Web UI port. Defaults to 3080 (the dsh web default).

.PARAMETER HostAddress
  The loopback address dsh web binds. Defaults to 127.0.0.1; `localhost` is
  normalized to it. dsh web rejects 0.0.0.0, so do not pass it here.

.PARAMETER Launch
  Which CLI artifact to boot: `built` uses apps/cli/lib/bin.js, `source` uses
  apps/cli/src/bin.ts through the tsx loader, `auto` prefers the built bin and
  falls back to source. Defaults to `auto`.

.PARAMETER DshHome
  Override $env:DSH_HOME for the harness process only. Empty (default) inherits
  the ambient DSH_HOME. Mostly useful to isolate a test server from the live
  harness home.

.PARAMETER NoBrowser
  Do not open the default browser; still watch for browser connections and stop
  the harness when they all vanish. Useful for scripts and CI.

.PARAMETER AdoptOnly
  Never start and never stop a server; only watch an already-listening one.
  With AdoptOnly and no listener on the port, the script fails with exit 1.

.PARAMETER StartupTimeoutSeconds
  How long to wait for the server to listen and answer HTTP before failing.
  Defaults to 120.

.PARAMETER BrowserObservationSeconds
  How long after opening the browser the watchdog keeps the harness alive no
  matter what, giving the page time to load and connect. Defaults to 30.

.PARAMETER ShutdownGraceSeconds
  How long with no browser connection before the harness is stopped. Defaults
  to 6 (polled every 2 seconds).

.PARAMETER SiblingStartupGraceSeconds
  When a just-started harness exits before binding (a sibling launcher usually
  won the port), how long to keep polling for the sibling's server before
  reporting startup failure. Defaults to 15.

.PARAMETER LogDir
  Where watchdog and server logs go. Defaults to scripts/windows/logs.

.PARAMETER SelfTest
  Print environment diagnostics (node, CLI artifacts, frontend dist, port and
  browser state) and exit without starting anything.

.PARAMETER Quiet
  Write to the watchdog log only, not the console.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\dsh-webui.ps1
  Launch the Web UI on the default port and watch the browser.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\dsh-webui.ps1 -Port 8080 -Launch source
  Launch from source on another port.
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$HostAddress = '127.0.0.1',
  [ValidateSet('auto', 'source', 'built')]
  [string]$Launch = 'auto',
  [string]$DshHome = '',
  [string]$ShRoot = '',
  [switch]$NoBrowser,
  [switch]$AdoptOnly,
  [int]$StartupTimeoutSeconds = 120,
  [int]$BrowserObservationSeconds = 30,
  [int]$ShutdownGraceSeconds = 6,
  [int]$SiblingStartupGraceSeconds = 15,
  [string]$LogDir = '',
  [switch]$SelfTest,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.3+ turns native stderr into terminating errors under EAP=Stop;
# taskkill reports refused kills on stderr and we decide how to handle them.
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSNativeCommandUseErrorActionPreference = $false }

# PowerShell 5.1 runs everywhere; keep to core cmdlets and operators so this
# also works under constrained execution. netstat is the connection source:
# Get-NetTCPConnection needs CIM/WMI rights this script should not require.
# The System32 helpers are resolved absolutely so a hostile PATH entry can
# never substitute netstat or taskkill.
$browserNames = @('msedge', 'chrome', 'firefox', 'opera', 'brave', 'vivaldi', 'iexplore', 'msedgewebview2', 'browser')
$pollIntervalSeconds = 2
$netstatExe = Join-Path $env:SystemRoot 'System32\netstat.exe'
if (-not (Test-Path $netstatExe)) { $netstatExe = 'netstat.exe' }
$taskkillExe = Join-Path $env:SystemRoot 'System32\taskkill.exe'
if (-not (Test-Path $taskkillExe)) { $taskkillExe = 'taskkill.exe' }

# ------------------------------------------------------------------ paths
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# The dsh checkout root is derived from the launcher's own location (the
# in-repo layout scripts/windows/...), overridable with -ShRoot or the
# dsh-webui.json sidecar written by the standalone installer.
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
if ($ShRoot -eq '') {
  $configPath = Join-Path $scriptDir 'dsh-webui.json'
  if (Test-Path $configPath) {
    try {
      $config = Get-Content -Path $configPath -Raw | ConvertFrom-Json
      if ($null -ne $config.shRoot -and $config.shRoot -ne '') { $repoRoot = $config.shRoot }
    } catch {
      # an unreadable sidecar must not break the launch; keep the derived root
    }
  }
}
if ($LogDir -eq '') { $LogDir = Join-Path $scriptDir 'logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$watchLog = Join-Path $LogDir "dsh-webui-$stamp-$PID.watch.log"
$serverOutLog = Join-Path $LogDir "dsh-webui-$stamp-$PID.server.out.log"
$serverErrLog = Join-Path $LogDir "dsh-webui-$stamp-$PID.server.err.log"

function Write-Log {
  param([string]$Message, [string]$Level = 'info')
  $line = '[{0}] {1} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level.ToUpper(), $Message
  Add-Content -Path $watchLog -Value $line -Encoding UTF8
  if (-not $Quiet) { Write-Host $line }
}

# ------------------------------------------------------------ diagnostics
function Test-IsBrowserName {
  param([string]$Name)
  if ($null -eq $Name) { return $false }
  return ($browserNames -contains $Name.ToLowerInvariant())
}

function Get-TcpRows {
  # netstat -ano -p tcp rows as objects; -o puts the PID last and the state
  # second-to-last for TCP, which also keeps IPv6 literals in one token.
  $rows = @()
  $lines = & $netstatExe -ano -p tcp 2>$null
  foreach ($line in $lines) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -lt 5) { continue }
    if ($parts[0] -ne 'TCP') { continue }
    $portText = ''
    if ($parts[1] -match '^.*:(\d+)$') { $portText = $Matches[1] } else { continue }
    $foreignPortText = ''
    if ($parts[2] -match '^.*:(\d+)$') { $foreignPortText = $Matches[1] } else { continue }
    if ($parts[4] -notmatch '^\d+$') { continue }
    $rows += [pscustomobject]@{
      LocalAddress   = $parts[1].Substring(0, $parts[1].Length - $portText.Length - 1)
      LocalPort      = [int]$portText
      ForeignAddress = $parts[2].Substring(0, $parts[2].Length - $foreignPortText.Length - 1)
      ForeignPort    = [int]$foreignPortText
      State          = $parts[3]
      Pid            = [int]$parts[4]
    }
  }
  return $rows
}

function Test-PortListening {
  param([string]$Addr, [int]$Port)
  foreach ($row in Get-TcpRows) {
    if ($row.State -eq 'LISTENING' -and $row.LocalPort -eq $Port -and $row.LocalAddress -eq $Addr) { return $true }
  }
  return $false
}

function Get-ListenerPid {
  param([string]$Addr, [int]$Port)
  foreach ($row in Get-TcpRows) {
    if ($row.State -eq 'LISTENING' -and $row.LocalPort -eq $Port -and $row.LocalAddress -eq $Addr) { return $row.Pid }
  }
  return $null
}

function Test-BrowserConnected {
  # True when any established connection to Addr:Port belongs to a
  # currently running browser process. A connection appears twice in netstat:
  # once with the server's port as the local port (owned by the server) and
  # once with the browser's ephemeral local port and the server's port as the
  # foreign port (owned by the browser); the browser-owned half is the one
  # that matches a browser PID.
  param([string]$Addr, [int]$Port)
  $browserIds = @{}
  foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
    if (Test-IsBrowserName $process.ProcessName) { $browserIds[$process.Id] = $true }
  }
  if ($browserIds.Count -eq 0) { return $false }
  foreach ($row in Get-TcpRows) {
    if ($row.State -ne 'ESTABLISHED') { continue }
    $serverSide = ($row.LocalPort -eq $Port -and ($row.LocalAddress -eq $Addr -or $row.LocalAddress -eq 'localhost'))
    $clientSide = ($row.ForeignPort -eq $Port -and ($row.ForeignAddress -eq $Addr -or $row.ForeignAddress -eq 'localhost'))
    if (-not $serverSide -and -not $clientSide) { continue }
    if ($browserIds.ContainsKey($row.Pid)) { return $true }
  }
  return $false
}

function Get-NodeExe {
  $candidate = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($candidate -eq '') {
    # Fall back to the standard install location when node is not on PATH.
    $defaultPath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $defaultPath) { return $defaultPath }
    throw 'node.exe not found; install Node.js 22 or newer and put it on PATH'
  }
  return $candidate
}

function Resolve-CliScript {
  # Locate the dsh CLI bin. Two layouts: the in-repo checkout (apps/cli/...) or
  # an npm-style install where Root is the @deepseek-ai/dsh package directory
  # itself (lib/bin.js). auto prefers a built bin and falls back to the tsx
  # source launcher in a checkout.
  param([string]$Mode, [string]$Root)
  $srcBin = Join-Path $Root 'apps\cli\src\bin.ts'
  $builtBin = Join-Path $Root 'apps\cli\lib\bin.js'
  $npmBin = Join-Path $Root 'lib\bin.js'
  if (-not (Test-Path $builtBin) -and (Test-Path $npmBin)) { $builtBin = $npmBin }
  $useBuilt = ($Mode -eq 'built') -or ($Mode -eq 'auto' -and (Test-Path $builtBin))
  if ($useBuilt) {
    if (-not (Test-Path $builtBin)) { throw "built CLI bin not found: $builtBin (run pnpm run build, or install @deepseek-ai/dsh)" }
    return @{ Script = $builtBin; Import = $false }
  }
  if (-not (Test-Path $srcBin)) { throw "source CLI bin not found: $srcBin" }
  return @{ Script = $srcBin; Import = $true }
}

function Test-FrontendDist {
  # The browser surface dist ships in the frontend package. Probe the checkout
  # layout (apps/web/dist) and the npm layout (the dsh package's sibling
  # @deepseek-ai/dsh-web-frontend/dist), so SelfTest reports accurately for
  # both an in-repo and an npm-installed dsh.
  param([string]$Root)
  $checkoutDist = Join-Path $Root 'apps\web\dist\index.html'
  if (Test-Path $checkoutDist) { return $true }
  $npmDist = Join-Path (Split-Path -Parent $Root) '@deepseek-ai\dsh-web-frontend\dist\index.html'
  return (Test-Path $npmDist)
}

function Invoke-SelfTest {
  Write-Log "self-test on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  $node = Get-NodeExe
  Write-Log "node: $node"
  Write-Log "dsh root: $repoRoot"
  $resolved = Resolve-CliScript -Mode $Launch -Root $repoRoot
  Write-Log "CLI script: $($resolved.Script) (tsx import: $($resolved.Import))"
  Write-Log "frontend dist exists: $(Test-FrontendDist -Root $repoRoot)"
  $listening = Test-PortListening -Addr $HostAddress -Port $Port
  $listener = Get-ListenerPid -Addr $HostAddress -Port $Port
  Write-Log "port $($HostAddress):$Port listening: $listening (pid: $listener)"
  $connected = Test-BrowserConnected -Addr $HostAddress -Port $Port
  Write-Log "browser connected to $($HostAddress):${Port}: $connected"
  $browsers = @()
  foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
    if (Test-IsBrowserName $process.ProcessName) { $browsers += $process.ProcessName }
  }
  Write-Log "running browsers: $(($browsers | Sort-Object -Unique) -join ', ')"
}

function Stop-ServerTree {
  # Kill the harness process tree; taskkill needs no elevation for a tree the
  # caller spawned. Falls back to Stop-Process on the root when taskkill is
  # refused, and reports success only when the root process is actually gone.
  # taskkill runs via Start-Process so its stderr and non-zero exit never
  # become terminating errors under $ErrorActionPreference = 'Stop'.
  # Before killing, the process at the PID must still look like the one the
  # watchdog spawned (expected name and start time); anything else means the
  # PID was reused and must not be touched (fail safe: leave it running).
  param([int]$ProcessId, [object]$ExpectedStartTime = $null, [string]$ExpectedName = 'node')
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    $refuse = $false
    if ($ExpectedName -ne '' -and $process.ProcessName -ne $ExpectedName) {
      Write-Log "refusing to kill pid ${ProcessId}: process is $($process.ProcessName), expected $ExpectedName" 'error'
      $refuse = $true
    }
    if ($null -ne $ExpectedStartTime) {
      $currentStart = $null
      try { $currentStart = $process.StartTime } catch { $currentStart = $null }
      if ($null -eq $currentStart) {
        Write-Log "refusing to kill pid ${ProcessId}: start time unreadable" 'error'
        $refuse = $true
      } else {
        $drift = ($currentStart - $ExpectedStartTime).TotalSeconds
        if ($drift -lt -2 -or $drift -gt 2) {
          Write-Log "refusing to kill pid ${ProcessId}: start time drifted $($drift.ToString('F1'))s, PID likely reused" 'error'
          $refuse = $true
        }
      }
    }
    if ($refuse) { return $false }
  }
  $kill = $null
  try {
    $kill = Start-Process -FilePath $taskkillExe -ArgumentList '/PID', "$ProcessId", '/T', '/F' -WindowStyle Hidden -Wait -PassThru -ErrorAction SilentlyContinue
  } catch {
    # taskkill could not start at all; the Stop-Process fallback below owns it.
  }
  if ($null -eq $kill -or $kill.ExitCode -ne 0) {
    $refused = if ($null -eq $kill) { 'n/a' } else { [string]$kill.ExitCode }
    Write-Log "taskkill refused (exit $refused); falling back to Stop-Process" 'warn'
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $process) { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Milliseconds 500
  return ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

# ---------------------------------------------------------- input guards
# Fail fast on anything that could corrupt the node command line or probe a
# nonsense address; the product additionally rejects 0.0.0.0 at boot.
if ($HostAddress -eq 'localhost') { $HostAddress = '127.0.0.1' }
if ($HostAddress -notmatch '^[0-9A-Za-z.\-:\[\]]+$' -or $HostAddress -eq '0.0.0.0') {
  Write-Log "invalid -HostAddress '$HostAddress' (must be a hostname or IP literal, and not 0.0.0.0)" 'error'
  exit 1
}
if ($Port -lt 1 -or $Port -gt 65535) {
  Write-Log "invalid -Port $Port (must be 1..65535)" 'error'
  exit 1
}
$webUrl = "http://$($HostAddress):$Port"
if ($SelfTest) {
  Invoke-SelfTest
  exit 0
}

Write-Log "watchdog start (port $Port, launch $Launch, browser: $(if ($NoBrowser) {'off'} else {'default'}))"

# ---- adopt or start the server
$serverPid = $null
$started = $false
if (Test-PortListening -Addr $HostAddress -Port $Port) {
  $adoptedPid = Get-ListenerPid -Addr $HostAddress -Port $Port
  Write-Log "server already listening on $webUrl (pid $adoptedPid); adopting without start/stop"
} else {
  if ($AdoptOnly) {
    Write-Log "no server on $webUrl but -AdoptOnly given; nothing to watch" 'error'
    exit 1
  }
  $nodeExe = Get-NodeExe
  $resolved = Resolve-CliScript -Mode $Launch -Root $repoRoot
  $arguments = @()
  if ($resolved.Import) { $arguments += '--import', 'tsx/esm' }
  $arguments += $resolved.Script, '--profile', 'web', '--host', $HostAddress, '--port', "$Port"
  $argumentLine = ($arguments | ForEach-Object {
    if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
  }) -join ' '
  Write-Log "starting: $nodeExe $argumentLine"
  if ($DshHome -ne '') {
    $previousDshHome = $env:DSH_HOME
    $env:DSH_HOME = $DshHome
  }
  try {
    $server = Start-Process -FilePath $nodeExe -ArgumentList $argumentLine -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $serverOutLog -RedirectStandardError $serverErrLog -PassThru
  } finally {
    if ($DshHome -ne '') { $env:DSH_HOME = $previousDshHome }
  }
  $serverPid = $server.Id
  $started = $true
  # Record the spawned process's identity so a kill can verify it still owns
  # this PID; a reused PID after an early exit must never be terminated.
  $serverStartTime = $null
  try {
    $serverStartTime = (Get-Process -Id $serverPid -ErrorAction Stop).StartTime
  } catch {
    Write-Log "could not read start time of pid $serverPid; kill will verify by name only" 'warn'
  }
  Write-Log "harness started (pid $serverPid)"
}

# ---- wait for readiness
$ready = $false
$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$serverDeadAt = $null
while ((Get-Date) -lt $deadline) {
  if ($started) {
    if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) {
      $serverDeadAt = $null
    } else {
      # Our instance died before binding. A sibling launcher may be winning
      # the port race (EADDRINUSE, or a concurrent profile-heal in a fresh
      # home): keep polling for its server and adopt it instead of failing.
      if ($null -eq $serverDeadAt) {
        $serverDeadAt = Get-Date
        Write-Log "harness process $serverPid exited before binding; waiting up to ${SiblingStartupGraceSeconds}s for a sibling to serve the port" 'warn'
      }
      if (Test-PortListening -Addr $HostAddress -Port $Port) {
        Write-Log "port is now served; adopting the sibling's server" 'warn'
        $started = $false
        $serverPid = $null
      } elseif ((Get-Date) -gt $serverDeadAt.AddSeconds($SiblingStartupGraceSeconds)) {
        break
      }
    }
  }
  if (Test-PortListening -Addr $HostAddress -Port $Port) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$webUrl/" -TimeoutSec 3 -ErrorAction Stop
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      # not ready yet; keep polling
    }
  }
  Start-Sleep -Milliseconds 500
}
if (-not $ready) {
  $tail = ''
  if (Test-Path $serverErrLog) {
    $tail = (Get-Content -Path $serverErrLog -Tail 10 -ErrorAction SilentlyContinue) -join ' | '
  }
  Write-Log "server did not become ready within ${StartupTimeoutSeconds}s; stderr tail: $tail" 'error'
  if ($started -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
    $null = Stop-ServerTree -ProcessId $serverPid -ExpectedStartTime $serverStartTime
  }
  exit 1
}
Write-Log "Web UI ready at $webUrl"

# ---- open the default browser
$browserOpenTime = Get-Date
if (-not $NoBrowser) {
  try {
    Start-Process $webUrl | Out-Null
    Write-Log "opened default browser on $webUrl"
  } catch {
    Write-Log "failed to open the default browser: $($_.Exception.Message)" 'warn'
  }
}

# ---- watch: keep the harness alive while a browser holds the Web UI open
$observationEnd = $browserOpenTime.AddSeconds($BrowserObservationSeconds)
$graceChecks = [int]($ShutdownGraceSeconds / $pollIntervalSeconds)
if ($graceChecks -lt 1) { $graceChecks = 1 }
$misses = 0
$adoptedMisses = 0
$shutdownReason = ''
while ($true) {
  Start-Sleep -Seconds $pollIntervalSeconds
  if ($started) {
    # The managed server exiting on its own is a crash, not a lifecycle end —
    # unless a sibling instance still serves the port, in which case adopt it.
    if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
      if (Test-PortListening -Addr $HostAddress -Port $Port) {
        Write-Log "harness process $serverPid exited but the port is served; adopting it" 'warn'
        $started = $false
        $serverPid = $null
        $adoptedMisses = 0
        continue
      }
      $shutdownReason = "harness process $serverPid exited on its own"
      $failed = $true
      break
    }
  } else {
    # The adopted server going away is a normal end of watching, not an error:
    # require consecutive misses so a single transient netstat hiccup cannot
    # trigger a failure popup.
    if (Test-PortListening -Addr $HostAddress -Port $Port) {
      $adoptedMisses = 0
    } else {
      $adoptedMisses++
      if ($adoptedMisses -ge $graceChecks) {
        $shutdownReason = "adopted server on $webUrl stopped listening"
        $failed = $false
        break
      }
    }
  }
  if ((Get-Date) -lt $observationEnd) { continue }
  if (Test-BrowserConnected -Addr $HostAddress -Port $Port) {
    $misses = 0
    continue
  }
  $misses++
  if ($misses -ge $graceChecks) {
    $shutdownReason = "no browser connected to $webUrl for ${ShutdownGraceSeconds}s"
    $failed = $false
    break
  }
}

# ---------------------------------------------------------------- stop
if ($failed) {
  Write-Log "stopping: $shutdownReason" 'error'
  if ($started -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
    $stopped = Stop-ServerTree -ProcessId $serverPid -ExpectedStartTime $serverStartTime
    if ($stopped) { Write-Log "stopped harness (pid $serverPid)" }
    else { Write-Log "harness (pid $serverPid) still running after kill attempts" 'error' }
  }
  Write-Log 'watchdog exit (code 1)'
  exit 1
}
if ($started) {
  Write-Log "stopping: $shutdownReason"
  $stopped = Stop-ServerTree -ProcessId $serverPid -ExpectedStartTime $serverStartTime
  if ($stopped) { Write-Log "stopped harness (pid $serverPid)" }
  else {
    Write-Log "harness (pid $serverPid) still running after kill attempts" 'error'
    Write-Log 'watchdog exit (code 1)'
    exit 1
  }
} else {
  Write-Log "exiting: $shutdownReason; adopted server left running"
}
Write-Log 'watchdog exit (code 0)'
exit 0
