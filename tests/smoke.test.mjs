/**
 * Self-contained smoke test for the built dsh-webui-launcher plugin.
 *
 * Runs against lib/index.js with the two external runtime packages
 * (@deepseek-ai/dsh-tools, @deepseek-ai/schemastery) mocked in a temporary
 * node_modules — so `npm test` works right after `npm run build` with no
 * dependency install. It verifies:
 *   1. the plugin wiring: 4 tools, 1 slash command, 4 JSON routes registered;
 *   2. the runtime: status probes a live HTTP server, start adopts it,
 *      stop refuses to touch it, and the /webui command answers correctly.
 */

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/** Chainable schemastery mock sufficient for the plugin's Config schema. */
const SCHEMA_MOCK = `
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
async function loadPlugin() {
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
function makeContext() {
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

test('wiring: registers 4 tools, the /webui command and 4 routes', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.name, 'dsh-webui-launcher')
  assert.deepEqual(plugin.inject, ['tools', 'commands', 'webServer'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.Config._kind, 'object')
  assert.deepEqual(Object.keys(plugin.Config.fields), ['port', 'host', 'cliBin', 'startupTimeoutMs', 'openBrowserOnStart'])

  const ctx = makeContext()
  plugin.apply(ctx, {})
  assert.deepEqual(ctx.state.tools.map((t) => t.name).sort(), ['webui.open', 'webui.start', 'webui.status', 'webui.stop'])
  assert.deepEqual(ctx.state.commands.map((c) => c.name), ['webui'])
  assert.deepEqual(ctx.state.routes.map((r) => r.path).sort(), ['/webui/open', '/webui/start', '/webui/status', '/webui/stop'])
})

test('runtime: status/start/stop against a live HTTP server on an ephemeral port', async (t) => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const plugin = await loadPlugin()
  const ctx = makeContext()
  plugin.apply(ctx, { port })

  const call = async (path) => {
    const body = await new Promise((resolve) => {
      const res = {
        statusCode: 0,
        setHeader() {},
        end(payload) { resolve(payload) },
      }
      const req = {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}` },
        on() {},
        once() {},
      }
      void ctx.state.routes.find((r) => r.path === path).handler(req, res)
    })
    return JSON.parse(body)
  }

  const status = await call('/webui/status')
  assert.equal(status.ok, true)
  assert.equal(status.status.listening, true)
  assert.equal(status.status.ready, true)
  assert.equal(status.status.adopted, true)

  const start = await call('/webui/start')
  assert.equal(start.ok, true)
  assert.equal(start.status.adopted, true)

  const stop = await call('/webui/stop')
  assert.equal(stop.ok, true)
  assert.match(stop.message, /nothing to stop/)

  const command = ctx.state.commands[0]
  const result = await command.handler({
    rawInput: ' status ',
    signal: new AbortController().signal,
    agent: {},
    commandId: 'test',
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Web UI/)
})
