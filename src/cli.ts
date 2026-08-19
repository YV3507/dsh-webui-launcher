/**
 * dsh CLI location across install layouts. The plugin runs inside a dsh
 * process, so the preferred source is the script the current process was
 * launched with (`process.argv[1]`) — it reproduces the installation exactly
 * (built npm CLI, source checkout, or tsx launcher). Fallbacks: the
 * `@deepseek-ai/dsh` package resolved through the plugin's own module graph,
 * then an explicit `cliBin` config override. Resolution failure throws an
 * actionable error instead of silently spawning nothing.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

/** Everything needed to spawn one web-server process. */
export interface ResolvedCli {
  /** Executable to spawn (node for JS/TS scripts, the binary otherwise). */
  command: string
  /** Args placed before the entry (e.g. --import tsx/esm for TS sources). */
  prefixArgs: string[]
  /** The CLI entry script or binary path. */
  entry: string
  /** Working directory for the spawn. */
  cwd: string
}

/** Whether a path looks like the dsh CLI entry (bin.js/bin.ts layouts). */
export function looksLikeCliScript(p: string): boolean {
  const name = basename(p)
  return name === 'bin.js' || name === 'bin.ts'
    || /(^|[\\/])apps[\\/]cli[\\/]/.test(p)
    || /(^|[\\/])lib[\\/]bin\.(js|ts)$/.test(p)
}

/** Resolve the dsh CLI entry script; throws with guidance when not found. */
export function resolveCliScript(cliBin: string, argvScript?: string): string {
  if (cliBin !== '') return cliBin
  const argv = argvScript ?? process.argv[1]
  if (typeof argv === 'string' && argv !== '' && looksLikeCliScript(argv)) return argv
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
export function resolveWorkingDir(cliScript: string): string {
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

/** A working directory from which `--import tsx/esm` can resolve tsx: the
 * @deepseek-ai/dsh package dir first, then the host's own cwd (the host was
 * itself launched with tsx, so its cwd resolves it), else the package dir. */
function chooseTsxCwd(script: string): string {
  const pkgDir = resolveWorkingDir(script)
  if (tsxResolvable(pkgDir)) return pkgDir
  if (tsxResolvable(process.cwd())) return process.cwd()
  return pkgDir
}

/** Whether `require('tsx')` resolves from `dir` (walking up its parents). */
function tsxResolvable(dir: string): boolean {
  try {
    createRequire(join(dir, '__dsh_tsx_probe__.cjs')).resolve('tsx')
    return true
  } catch {
    return false
  }
}

/** Full spawn spec for the web server process. */
export function resolveCli(cliBin: string, argvScript?: string): ResolvedCli {
  const script = resolveCliScript(cliBin, argvScript)
  if (script.endsWith('.ts')) {
    return { command: process.execPath, prefixArgs: ['--import', 'tsx/esm'], entry: script, cwd: chooseTsxCwd(script) }
  }
  if (/\.(js|cjs|mjs)$/.test(script)) {
    return { command: process.execPath, prefixArgs: [], entry: script, cwd: resolveWorkingDir(script) }
  }
  // An explicit binary (cliBin pointing at an executable).
  return { command: script, prefixArgs: [], entry: script, cwd: dirname(script) }
}
