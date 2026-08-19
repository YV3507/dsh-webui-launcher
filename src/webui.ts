/**
 * WebUiRuntime — the high-robustness core of the dsh-webui-launcher plugin.
 *
 * A small explicit state machine (`idle → starting → running → stopping`)
 * over one spawned server, with:
 *
 *  - **single-flight serialization** — every mutation runs under a promise
 *    mutex, so concurrent `start`/`stop` calls never interleave and a second
 *    `start` while one is in flight returns the same outcome;
 *  - **adopt-or-start** — a server already listening is adopted (never
 *    started, never stopped); our own instance dying before binding is
 *    re-checked for a sibling that won the port race;
 *  - **abort and timeout hygiene** — an aborted or timed-out start kills the
 *    child it spawned and returns to `idle`, surfacing the output tail;
 *  - **orphan cleanup** — `dispose()` (wired to the plugin's `ctx.effect`)
 *    stops the spawned server on plugin unload/hot-reload;
 *  - **injectable dependencies** — probes, spawn, browser open, sleep and
 *    clock come from {@link WebUiRuntimeDeps}, so tests can script every
 *    failure path without real processes.
 *
 * A server the plugin did not start is never killed: `stop()` only ever
 * targets the `SpawnedServer` this instance spawned.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { openBrowser as defaultOpenBrowser } from './browser.ts'
import { resolveCli as defaultResolveCli, type ResolvedCli } from './cli.ts'
import { killPidTree as defaultKillPidTree, pidForPort as defaultPidForPort, spawnServer as defaultSpawnServer, type SpawnedServer } from './process.ts'
import { probeApiReady as defaultProbeApiReady, probeHttpReady as defaultProbeHttpReady, probeListening as defaultProbeListening } from './probe.ts'

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
  /** PID-record file for launcher-started servers ("" = disabled). The
   * desktop launcher (and this runtime's own spawn) write the server PID
   * here; `stop()` only stops an adopted server when the recorded PID is the
   * one currently listening — so servers the launcher started are closable,
   * while genuinely foreign servers stay untouched. */
  adoptedPidFile: string
}

/** The runtime's lifecycle state, surfaced in status. */
export type RuntimeState = 'idle' | 'starting' | 'running' | 'stopping'

/** Serializable status snapshot returned by tools, commands and endpoints. */
export interface WebUiStatus {
  port: number
  host: string
  url: string
  /** Lifecycle state of this runtime instance. */
  state: RuntimeState
  /** Something listens on host:port. */
  listening: boolean
  /** The surface answered HTTP 200. */
  ready: boolean
  /** This runtime spawned the running server. */
  spawned: boolean
  /** A server was already listening, so this instance owns nothing. */
  adopted: boolean
  /** stop() can close the current server (spawned, or launcher-recorded). */
  stoppable: boolean
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

/** Injectable dependencies; the real wiring comes from {@link defaultDeps}. */
export interface WebUiRuntimeDeps {
  probeListening(host: string, port: number): Promise<boolean>
  probeHttpReady(url: string): Promise<boolean>
  /** The web client's API transport prefix answers 426 (all plugins loaded). */
  probeApiReady(url: string): Promise<boolean>
  resolveCli(): ResolvedCli
  spawnServer(cli: ResolvedCli, host: string, port: number): SpawnedServer
  /** The PID currently listening on host:port, or null. */
  pidForPort(host: string, port: number): Promise<number | null>
  /** Identity-guarded tree-kill of an arbitrary PID (node.exe only on win32). */
  killPidTree(pid: number): Promise<boolean>
  /** Record a spawned server's PID for a later instance's adopted-stop. */
  recordSpawnedPid(pid: number): void
  openBrowser(url: string): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
}

/** The production wiring for one runtime instance. */
export function defaultDeps(options: WebUiOptions): WebUiRuntimeDeps {
  return {
    probeListening: (host, port) => defaultProbeListening(host, port),
    probeHttpReady: (url) => defaultProbeHttpReady(url),
    probeApiReady: (url) => defaultProbeApiReady(url),
    resolveCli: () => defaultResolveCli(options.cliBin),
    spawnServer: (cli, host, port) => defaultSpawnServer({
      command: cli.command,
      args: [...cli.prefixArgs, cli.entry, '--profile', 'web', '--host', host, '--port', String(port)],
      cwd: cli.cwd,
      maxLogLines: options.maxLogLines,
    }),
    pidForPort: (host, port) => defaultPidForPort(host, port),
    killPidTree: (pid) => defaultKillPidTree(pid),
    recordSpawnedPid: (pid) => {
      if (options.adoptedPidFile === '') return
      try {
        writeFileSync(options.adoptedPidFile, String(pid), 'utf8')
      } catch {
        /* best-effort: the adopted-stop just degrades to a refuse */
      }
    },
    openBrowser: (url) => defaultOpenBrowser(url),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}

/** Readiness probe backoff, capped; replayed for longer waits. */
const PROBE_BACKOFF_MS = [250, 500, 750, 1000]

/**
 * The web UI controller. One instance per plugin load.
 */
export class WebUiRuntime {
  private state: RuntimeState = 'idle'
  private server: SpawnedServer | null = null
  private lock: Promise<void> = Promise.resolve()
  private readonly url: string

  constructor(
    private readonly options: WebUiOptions,
    private readonly deps: WebUiRuntimeDeps,
  ) {
    this.url = `http://${options.host}:${options.port}`
  }

  /** Run one mutation exclusively; concurrent calls queue behind it. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** A status snapshot without side effects (port probes are the only I/O). */
  async status(): Promise<WebUiStatus> {
    const listening = await this.deps.probeListening(this.options.host, this.options.port)
    // "Ready" means the shell answers 200 AND the client API transport is up
    // (426 on /api/events.mux) — otherwise the browser would boot to
    // "Failed to load plugins" (all entries pending on `connection`).
    const ready = listening
      ? (await this.deps.probeHttpReady(this.url)) && (await this.deps.probeApiReady(this.url))
      : false
    const spawned = this.server !== null && this.server.exitCode() === null
    const adopted = listening && this.server === null
    // Whether stop() can actually close the current server: our own spawned
    // child, or an adopted launcher-recorded server (PID match). The settings
    // card enables Stop only on this.
    const stoppable = spawned || (adopted && (await this.adoptedPidMatch()) !== null)
    return {
      port: this.options.port,
      host: this.options.host,
      url: this.url,
      state: this.state,
      listening,
      ready,
      spawned,
      adopted,
      stoppable,
      pid: spawned ? this.server!.pid : null,
      exitCode: this.server?.exitCode() ?? null,
      logs: this.server?.logs() ?? [],
    }
  }

  /**
   * Start the Web UI: adopt an already-listening server, otherwise spawn
   * `dsh --profile web` and wait for HTTP 200. Serialized: a second `start`
   * while one is in flight queues behind it and reports the same outcome.
   */
  async start(signal: AbortSignal): Promise<WebUiResult> {
    return this.serialized(async () => {
      if (this.state === 'starting') {
        throw new Error('webui_start: another start is already in progress')
      }
      if (this.state === 'running' && this.server !== null) {
        const status = await this.status()
        // The spawned server may have died since it became ready; never claim
        // "ready" without the probes agreeing.
        let message: string
        if (status.listening && status.ready) {
          message = `Web UI ready at ${this.url}${status.spawned && status.pid ? ` (pid ${status.pid})` : ''}`
        } else if (status.listening) {
          message = `Web UI listening at ${this.url} but not answering HTTP 200 yet`
        } else if (status.exitCode !== null) {
          message = `the Web UI server exited (code ${status.exitCode}); nothing serving ${this.url}`
        } else {
          message = `nothing serving ${this.url}`
        }
        return { status, message }
      }
      if (await this.deps.probeListening(this.options.host, this.options.port)) {
        this.state = 'running'
        const status = await this.status()
        return { status, message: `adopted the Web UI already serving ${this.url}` }
      }

      const cli = this.deps.resolveCli()
      const server = this.deps.spawnServer(cli, this.options.host, this.options.port)
      this.server = server
      this.deps.recordSpawnedPid(server.pid)
      this.state = 'starting'
      const startedAt = this.deps.now()
      let attempt = 0

      try {
        for (;;) {
          if (signal.aborted) {
            await this.stopSpawned()
            throw new Error('webui_start aborted')
          }
          const exited = server.exitCode()
          if (exited !== null) {
            // Our instance died before binding. A sibling launcher may be
            // winning the port race: adopt its server instead of failing.
            if (await this.deps.probeListening(this.options.host, this.options.port)) {
              this.server = null
              this.state = 'running'
              const status = await this.status()
              return {
                status,
                message: `our dsh exited (code ${exited}); adopted the server now on ${this.url}`,
              }
            }
            this.server = null
            this.state = 'idle'
            throw new Error(
              `dsh exited before serving ${this.url} (code ${exited}). Log tail:\n${server.logs().join('\n') || '(no output)'}`,
            )
          }
          if (await this.deps.probeListening(this.options.host, this.options.port)) {
            if (await this.deps.probeHttpReady(this.url)
              && await this.deps.probeApiReady(this.url)) break
          }
          if (this.deps.now() - startedAt > this.options.startupTimeoutMs) {
            await this.stopSpawned()
            throw new Error(
              `Web UI did not become ready within ${Math.round(this.options.startupTimeoutMs / 1000)}s. Log tail:\n${server.logs().join('\n') || '(no output)'}`,
            )
          }
          await this.deps.sleep(PROBE_BACKOFF_MS[attempt] ?? 1000)
          attempt += 1
        }
      } catch (error) {
        this.state = 'idle'
        throw error
      }

      this.state = 'running'
      const status = await this.status()
      const message = `Web UI ready at ${this.url} (pid ${status.pid})`
      if (this.options.openBrowserOnStart) {
        await this.deps.openBrowser(this.url)
      }
      return { status, message }
    })
  }

  /**
   * Stop the web server. A server this runtime spawned is always stopped; an
   * adopted server is stopped only when the desktop launcher (or an earlier
   * plugin instance) recorded its PID and that PID is the one currently
   * listening — a genuinely foreign server is never touched.
   */
  async stop(): Promise<WebUiResult> {
    return this.serialized(async () => {
      if (this.server === null) {
        const adopted = await this.stopAdoptedIfOurs()
        this.state = 'idle'
        const status = await this.status()
        if (adopted.stopped) {
          return { status, message: `stopped the Web UI server started by the launcher (pid ${adopted.pid})` }
        }
        if (adopted.pid !== null) {
          return { status, message: `launcher server pid ${adopted.pid} still running after kill attempts` }
        }
        return { status, message: 'nothing to stop: this plugin spawned no server' }
      }
      if (this.server.exitCode() !== null) {
        const pid = this.server.pid
        const code = this.server.exitCode()
        this.server = null
        this.state = 'idle'
        const status = await this.status()
        return { status, message: `server pid ${pid} already exited (code ${code})` }
      }
      const pid = this.server.pid
      this.state = 'stopping'
      const stopped = await this.stopSpawned()
      // A failed kill leaves the server alive: keep it manageable so a later
      // stop/dispose can retry, and surface the truth in status.
      if (!stopped && this.server !== null && this.server.exitCode() === null) {
        this.state = 'running'
      }
      const status = await this.status()
      return stopped
        ? { status, message: `stopped the Web UI server (pid ${pid})` }
        : { status, message: `server pid ${pid} still running after kill attempts` }
    })
  }

  /** Open the default browser on the Web UI URL (no start/stop side effects). */
  async open(): Promise<WebUiResult> {
    const status = await this.status()
    if (!status.listening) {
      return { status, message: `nothing serving ${this.url} \u2014 run webui_start first` }
    }
    const opened = await this.deps.openBrowser(this.url)
    return opened
      ? { status, message: `opened the default browser on ${this.url}` }
      : { status, message: `failed to open the default browser on ${this.url}` }
  }

  /** Plugin-unload cleanup: stop the spawned server, if any (orphan guard). */
  async dispose(): Promise<void> {
    await this.serialized(async () => {
      if (this.server !== null && this.server.exitCode() === null) {
        await this.stopSpawned()
      } else {
        this.server = null
        this.state = 'idle'
        // The desktop launcher's server is also ours in spirit — clean it up
        // too (PID-recorded, identity-guarded).
        await this.stopAdoptedIfOurs()
      }
    })
  }

  /**
   * The launcher-recorded server PID when it matches the process currently
   * listening on the port — the provenance proof that the adopted server is
   * ours to stop — or null when there is no record / no match.
   */
  private async adoptedPidMatch(): Promise<number | null> {
    const file = this.options.adoptedPidFile
    if (file === '' || !existsSync(file)) return null
    let recorded = NaN
    try {
      recorded = Number(readFileSync(file, 'utf8').trim())
    } catch {
      return null
    }
    if (!Number.isInteger(recorded) || recorded <= 0) return null
    const current = await this.deps.pidForPort(this.options.host, this.options.port)
    return current === recorded ? recorded : null
  }

  /**
   * Stop an adopted server that this plugin's launcher (or an earlier plugin
   * instance) spawned. Returns whether a server was stopped and the PID it
   * targeted (null = nothing matched, so nothing was attempted).
   */
  private async stopAdoptedIfOurs(): Promise<{ stopped: boolean; pid: number | null }> {
    const recorded = await this.adoptedPidMatch()
    if (recorded === null) return { stopped: false, pid: null }
    let stopped = await this.deps.killPidTree(recorded)
    if (!stopped) {
      // taskkill /F can lag a moment before the OS reaps the process; the
      // port is the real signal — if it no longer answers on the recorded
      // PID, the server is gone regardless of what the pid-watcher reported.
      const still = await this.deps.pidForPort(this.options.host, this.options.port)
      if (still === null || still !== recorded) stopped = true
    }
    return { stopped, pid: recorded }
  }

  /** Clear the server reference and stop it; resolves whether it is gone. */
  private async stopSpawned(): Promise<boolean> {
    const server = this.server
    if (server === null) {
      this.state = 'idle'
      return true
    }
    const stopped = await server.kill()
    if (stopped) {
      this.server = null
      this.state = 'idle'
    }
    // On a failed kill the reference is deliberately kept: dropping it would
    // orphan a possibly-still-running server that a later stop/dispose could
    // have retried. State transitions on failure are left to the caller.
    return stopped
  }
}
