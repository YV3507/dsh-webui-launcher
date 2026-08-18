/**
 * Web UI runtime for the dsh-webui-launcher plugin: a cross-platform Node port
 * of the Windows watchdog (`launcher/dsh-webui.ps1`). It adopts a server that
 * already listens, spawns `dsh --profile web` when none does, waits for HTTP
 * readiness, stops only the process tree it spawned (never an adopted
 * server), and opens the default browser.
 *
 * The module keeps no module-level state: a fresh {@link WebUiRuntime} is
 * created per plugin load, so a config edit or plugin reload cannot act on a
 * stale process handle.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, join, basename } from 'node:path'
import process from 'node:process'

/** Runtime configuration. Values come from plugin config with safe defaults. */
export interface WebUiOptions {
  /** Web UI port (1..65535). Default 3080 (the dsh web default). */
  port: number
  /** Loopback host dsh web binds. dsh web rejects 0.0.0.0. */
  host: string
  /** Explicit CLI script override ("" = auto). */
  cliBin: string
  /** How long `start()` waits for HTTP 200 before failing. */
  startupTimeoutMs: number
  /** Whether `start()` opens the default browser once ready. */
  openBrowserOnStart: boolean
  /** Bound on the retained tail of the spawned server's output. */
  maxLogLines: number
}

/** Serializable status snapshot returned by tools, commands and endpoints. */
export interface WebUiStatus {
  port: number
  host: string
  url: string
  /** Something listens on host:port. */
  listening: boolean
  /** The surface answered HTTP 200. */
  ready: boolean
  /** This plugin instance spawned the running server. */
  spawned: boolean
  /** A server was already listening, so this instance owns nothing. */
  adopted: boolean
  /** PID of the spawned server, when spawned and alive. */
  pid: number | null
  /** Exit code of the spawned server, once it exited. */
  exitCode: number | null
  /** Tail of the spawned server's stdout+stderr (bounded). */
  logs: string[]
}

/** A short human message paired with every operation result. */
export interface WebUiResult {
  status: WebUiStatus
  message: string
}

const DEFAULT_MAX_LOG_LINES = 25

/** True when the process at `host:port` accepts TCP connections. */
export function probeListening(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** True when GET / on the surface answers 200 within the bound. */
export async function probeHttpReady(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.status === 200
  } catch {
    return false
  }
}

/** Bounded in-memory line ring buffer capturing a spawned server's output. */
class LineLog {
  private readonly lines: string[] = []

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const text = chunk.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd()
      if (trimmed === '') continue
      this.lines.push(trimmed)
      if (this.lines.length > this.max) this.lines.shift()
    }
  }

  tail(): string[] {
    return [...this.lines]
  }
}

/**
 * Resolve the dsh CLI entry script. Preferred: the script the current process
 * was launched with (`process.argv[1]`), which reproduces the installation
 * exactly (built npm CLI, source checkout, or tsx launcher). Fallback: the
 * `@deepseek-ai/dsh` package's `lib/bin.js` resolved through the plugin's own
 * module graph. An explicit `cliBin` config wins over both.
 */
export function resolveCliScript(cliBin: string): string {
  if (cliBin !== '') return cliBin
  const argvScript = process.argv[1]
  if (typeof argvScript === 'string' && argvScript !== '') {
    const name = basename(argvScript)
    if (name === 'bin.js' || name === 'bin.ts' || /(^|[\\/])apps[\\/]cli[\\/]/.test(argvScript)) {
      return argvScript
    }
  }
  try {
    const require = createRequire(import.meta.url)
    const pkgJson = require.resolve('@deepseek-ai/dsh/package.json')
    const script = join(dirname(pkgJson), 'lib', 'bin.js')
    if (existsSync(script)) return script
  } catch {
    /* package not resolvable from this module graph — report below */
  }
  throw new Error(
    'could not locate the dsh CLI: pass cliBin in the plugin config, or install dsh-webui-launcher inside a dsh profile',
  )
}

/**
 * Working directory for the spawned CLI: the package directory that owns the
 * script (npm layout: the @deepseek-ai/dsh package dir; checkout layout: the
 * apps/cli package dir), walked up from the script location.
 */
export function resolveCliWorkingDir(cliScript: string): string {
  let dir = dirname(cliScript)
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
        if (pkg.name === '@deepseek-ai/dsh') return dir
      } catch {
        /* unreadable package.json — keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(cliScript)
}

/** Open the system default browser on `url` without waiting for it to exit. */
export async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform
  let command: string
  let args: string[]
  if (platform === 'win32') {
    command = 'cmd.exe'
    args = ['/c', 'start', '', url]
  } else if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else {
    command = 'xdg-open'
    args = [url]
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

/**
 * The web UI controller. One instance per plugin load.
 */
export class WebUiRuntime {
  private child: ChildProcess | null = null
  private readonly nodeExe = process.execPath
  private readonly options: WebUiOptions
  private readonly log: LineLog

  constructor(options: WebUiOptions) {
    // Assigned before any field initializer reads them (class fields run
    // before the constructor body, so options must live in the body).
    this.options = options
    this.log = new LineLog(options.maxLogLines)
  }

  /** A status snapshot without side effects (a port probe is the only I/O). */
  async status(): Promise<WebUiStatus> {
    const url = `http://${this.options.host}:${this.options.port}`
    const listening = await probeListening(this.options.host, this.options.port)
    return {
      port: this.options.port,
      host: this.options.host,
      url,
      listening,
      ready: listening ? await probeHttpReady(url) : false,
      spawned: this.child !== null && this.child.exitCode === null,
      adopted: listening && (this.child === null || this.child.exitCode !== null),
      pid: this.child !== null && this.child.exitCode === null ? this.child.pid ?? null : null,
      exitCode: this.child?.exitCode ?? null,
      logs: this.log.tail(),
    }
  }

  /**
   * Start the Web UI: adopt an already-listening server, otherwise spawn
   * `dsh --profile web` and wait for HTTP 200. Aborts (rejects) on
   * `signal.abort` and on startup timeout or server exit.
   */
  async start(signal: AbortSignal): Promise<WebUiResult> {
    if (await probeListening(this.options.host, this.options.port)) {
      const status = await this.status()
      return { status, message: `adopted the Web UI already serving ${status.url}` }
    }
    if (this.child !== null && this.child.exitCode === null) {
      throw new Error(`a server spawned by this plugin (pid ${this.child.pid}) is still starting`)
    }

    const cliScript = resolveCliScript(this.options.cliBin)
    const cwd = resolveCliWorkingDir(cliScript)
    const args: string[] = []
    if (cliScript.endsWith('.ts')) args.push('--import', 'tsx/esm')
    args.push(cliScript, '--profile', 'web', '--host', this.options.host, '--port', String(this.options.port))

    const child = spawn(this.nodeExe, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.log.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.log.push(chunk))

    const url = `http://${this.options.host}:${this.options.port}`
    const startedAt = Date.now()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal.aborted) {
        this.stopQuietly(child)
        throw new Error('webui.start aborted')
      }
      if (child.exitCode !== null) {
        // Our instance died before binding. A sibling launcher may be winning
        // the port race: adopt its server instead of failing.
        if (await probeListening(this.options.host, this.options.port)) {
          const status = await this.status()
          return { status, message: `our dsh exited (code ${child.exitCode}); adopted the server now on ${url}` }
        }
        throw new Error(
          `dsh exited before serving ${url} (code ${child.exitCode}). Log tail:\n${this.log.tail().join('\n') || '(no output)'}`,
        )
      }
      if (await probeListening(this.options.host, this.options.port)) {
        if (await probeHttpReady(url)) break
      }
      if (Date.now() - startedAt > this.options.startupTimeoutMs) {
        this.stopQuietly(child)
        throw new Error(
          `Web UI did not become ready within ${Math.round(this.options.startupTimeoutMs / 1000)}s. Log tail:\n${this.log.tail().join('\n') || '(no output)'}`,
        )
      }
      await delay(500)
    }

    const status = await this.status()
    const message = `Web UI ready at ${url} (pid ${status.pid})`
    if (this.options.openBrowserOnStart) {
      await openBrowser(url)
    }
    return { status, message }
  }

  /**
   * Stop the server this plugin spawned. An adopted server is never stopped.
   * The PID guard is the live ChildProcess handle: once `exitCode` is set the
   * PID may have been recycled, and a recycled PID is never killed.
   */
  async stop(): Promise<WebUiResult> {
    const child = this.child
    if (child === null) {
      const status = await this.status()
      return { status, message: 'nothing to stop: this plugin spawned no server' }
    }
    if (child.exitCode !== null) {
      const status = await this.status()
      return { status, message: `server pid ${child.pid} already exited (code ${child.exitCode})` }
    }
    const pid = child.pid
    if (pid === undefined) {
      const status = await this.status()
      return { status, message: 'server process has no pid; nothing killed' }
    }
    const stopped = await this.killTree(child, pid)
    const status = await this.status()
    return stopped
      ? { status, message: `stopped the Web UI server (pid ${pid})` }
      : { status, message: `server pid ${pid} still running after kill attempts` }
  }

  /** Open the default browser on the Web UI URL (no start/stop side effects). */
  async open(): Promise<WebUiResult> {
    const status = await this.status()
    if (!status.listening) {
      return { status, message: `nothing serving ${status.url} — run webui.start first` }
    }
    const opened = await openBrowser(status.url)
    return opened
      ? { status, message: `opened the default browser on ${status.url}` }
      : { status, message: `failed to open the default browser on ${status.url}` }
  }

  /** Kill the spawned process tree; Windows uses taskkill /T, POSIX the group. */
  private killTree(child: ChildProcess, pid: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile(
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true },
          () => this.waitGone(child, resolve),
        )
      } else {
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            /* already gone */
          }
        }
        this.waitGone(child, resolve)
      }
    })
  }

  private waitGone(child: ChildProcess, resolve: (value: boolean) => void, attempts = 0): void {
    if (child.exitCode !== null) {
      resolve(true)
      return
    }
    if (attempts >= 10) {
      if (process.platform !== 'win32') {
        try {
          process.kill(child.pid!, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      resolve(false)
      return
    }
    setTimeout(() => this.waitGone(child, resolve, attempts + 1), 200)
  }

  /** Fire-and-forget stop used on the abort/timeout paths. */
  private stopQuietly(child: ChildProcess): void {
    if (child.exitCode === null && child.pid !== undefined) {
      void this.killTree(child, child.pid)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
