/**
 * Cross-platform server process management: spawns `dsh --profile web`
 * detached, captures a bounded output tail, and kills the process tree with a
 * PID-identity guard. The guard matters: once the child has exited its PID
 * may be recycled, and a recycled PID must never be killed.
 *
 * Windows: the tree is killed with `taskkill /T /F`, but only after
 * `tasklist` confirms the PID still names node.exe (fail-safe: refuse rather
 * than risk a recycled PID). POSIX: the detached process group is signalled
 * (SIGTERM, then SIGKILL after a grace period).
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

/** A spawned web server the runtime can query and kill. */
export interface SpawnedServer {
  readonly pid: number
  /** null while running; the exit code once the process has exited. */
  exitCode(): number | null
  /** Kill the process tree; resolves true when the process is gone. */
  kill(): Promise<boolean>
  /** Bounded tail of stdout+stderr. */
  logs(): string[]
}

export interface SpawnOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  maxLogLines?: number
}

/** Bounded in-memory line ring buffer capturing a spawned server's output. */
class LineLog {
  private readonly lines: string[] = []

  constructor(private readonly max: number) {}

  push(chunk: Buffer | string): void {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
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

/** Spawn a detached server process and wrap it in the {@link SpawnedServer} surface. */
export function spawnServer(options: SpawnOptions): SpawnedServer {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const log = new LineLog(options.maxLogLines ?? 25)
  // A failed spawn (missing CLI, unresolvable tsx import) never sets
  // child.exitCode. Capture it so the runtime fails fast with the real error
  // instead of waiting out the full startup timeout.
  let spawnError: Error | null = null
  child.once('error', (error: Error) => {
    spawnError = error
    log.push(Buffer.from(`spawn failed: ${error.message}`, 'utf8'))
  })
  child.stdout?.on('data', (chunk: Buffer) => log.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => log.push(chunk))
  // Pipe errors on a dead child must never surface as an unhandled 'error'
  // event on the host; the log tail already reflects the child's fate.
  child.stdout?.on('error', () => {})
  child.stderr?.on('error', () => {})
  return {
    get pid() {
      return child.pid ?? 0
    },
    exitCode: () => spawnError !== null ? -1 : child.exitCode,
    kill: () => killTree(child, log),
    logs: () => log.tail(),
  }
}

/** Kill the tree; only ever called while `child.exitCode === null`. */
async function killTree(child: ChildProcess, log: LineLog): Promise<boolean> {
  if (child.exitCode !== null) return true
  const pid = child.pid
  // A child that never spawned (spawn 'error') has nothing to kill.
  if (pid === undefined) return true

  if (process.platform === 'win32') {
    if (!(await looksLikeNode(pid))) {
      log.push(Buffer.from(`refusing to kill pid ${pid}: tasklist does not show node.exe (possible PID reuse)`, 'utf8'))
      return false
    }
    await runTaskkill(pid)
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
  }

  for (let i = 0; i < 15; i += 1) {
    if (child.exitCode !== null) return true
    await delay(200)
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await delay(300)
  }
  return child.exitCode !== null
}

/** tasklist confirmation that the PID currently names node.exe. */
function looksLikeNode(pid: number): Promise<boolean> {
  const tasklist = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe')
  return new Promise((resolve) => {
    execFile(tasklist, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(false)
        return
      }
      const match = /^"([^"]+)"/.exec(stdout.trim())
      resolve(match !== null && match[1]!.toLowerCase() === 'node.exe')
    })
  })
}

/** taskkill the whole tree; non-zero exit is tolerated (fallback below). */
function runTaskkill(pid: number): Promise<void> {
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  return new Promise((resolve) => {
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
