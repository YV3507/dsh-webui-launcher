/**
 * Shared test helpers: load the built plugin bundle with the two external
 * runtime packages (@deepseek-ai/dsh-tools, @deepseek-ai/schemastery) mocked
 * in a temporary node_modules, so tests run right after `npm run build` with
 * no dependency install. Also the fake client Context and the scriptable
 * fake runtime dependencies for the state-machine failure-path tests.
 */

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Chainable schemastery mock sufficient for the plugin's Config schema. */
export const SCHEMA_MOCK = `
function chain(init) {
  const o = { ...init }
  const self = {
    default: (v) => { o.default = v; return self },
    min: (v) => { o.min = v; return self },
    max: (v) => { o.max = v; return self },
    step: (v) => { o.step = v; return self },
  }
  return self
}
export default {
  object: (fields) => ({ _kind: 'object', fields }),
  string: () => chain({ _kind: 'string' }),
  number: () => chain({ _kind: 'number' }),
  boolean: () => chain({ _kind: 'boolean' }),
}
`

/** Load the built plugin from a tmpdir whose node_modules mocks the externals. */
export async function loadPlugin() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webui-launcher-test-'))
  const scope = join(dir, 'node_modules', '@deepseek-ai')
  for (const name of ['dsh-tools', 'schemastery']) {
    mkdirSync(join(scope, name), { recursive: true })
    writeFileSync(join(scope, name, 'package.json'), JSON.stringify({
      name: `@deepseek-ai/${name}`,
      type: 'module',
      exports: { '.': './index.js' },
    }))
  }
  writeFileSync(join(scope, 'dsh-tools', 'index.js'), 'export function defineTool(def) { return def }')
  writeFileSync(join(scope, 'schemastery', 'index.js'), SCHEMA_MOCK)
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  copyFileSync(new URL('../lib/index.js', import.meta.url), join(dir, 'index.js'))
  return import(pathToFileURL(join(dir, 'index.js')).href)
}

/** A fake client Context capturing registrations. */
export function makeContext() {
  const state = { tools: [], commands: [], routes: [] }
  const ctx = {
    state,
    tools: { register: (t) => state.tools.push(t) },
    commands: { register: (c) => state.commands.push(c) },
    webServer: {
      register: (route) => {
        state.routes.push(route)
        return () => {}
      },
    },
    effect: (fn) => fn(),
  }
  return ctx
}

/** Plugin options with fast, deterministic defaults for tests. */
export function baseOptions() {
  return {
    port: 3080,
    host: '127.0.0.1',
    cliBin: '',
    startupTimeoutMs: 1000,
    openBrowserOnStart: false,
    maxLogLines: 25,
  }
}

/**
 * Scriptable fake runtime dependencies. The returned `server` object is
 * mutable: tests flip `exitCode` to script death; `kill()` records the call
 * and marks the server gone. `sleep` advances the fake clock, so timeout
 * scenarios run without real waiting.
 */
export function fakeDeps(overrides = {}) {
  const calls = { spawns: 0, kills: 0, probes: 0, httpReady: 0, apiReady: 0 }
  const clock = { t: 0 }
  let code = null
  const server = {
    pid: 4242,
    killed: false,
    exitCode: () => code,
    /** Script a child death at the given exit code. */
    die: (exit = 1) => {
      code = exit
    },
    kill: async () => {
      calls.kills += 1
      server.killed = true
      code = 143
      return true
    },
    logs: () => ['server log line'],
  }
  const deps = {
    probeListening: async () => {
      calls.probes += 1
      return false
    },
    probeHttpReady: async () => {
      calls.httpReady += 1
      return true
    },
    probeApiReady: async () => {
      calls.apiReady += 1
      return true
    },
    resolveCli: () => ({ command: process.execPath, prefixArgs: [], entry: '/x/lib/bin.js', cwd: '/x' }),
    spawnServer: () => {
      calls.spawns += 1
      return server
    },
    openBrowser: async () => true,
    sleep: async (ms) => {
      clock.t += ms
    },
    now: () => clock.t,
    ...overrides,
  }
  return { deps, calls, clock, server }
}
