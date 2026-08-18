/**
 * End-to-end smoke test for the built dsh-webui-launcher plugin: the wiring
 * (4 tools, /webui command, 4 routes, exported runtime) and the runtime
 * against a real live HTTP server on an ephemeral port (adopt path, no
 * process spawning). The state-machine failure paths live in runtime.test.mjs.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { loadPlugin, makeContext } from './_helpers.mjs'

test('wiring: registers 4 tools, the /webui command, 4 routes and exports the runtime', async () => {
  const plugin = await loadPlugin()
  assert.equal(plugin.name, 'dsh-webui-launcher')
  assert.deepEqual(plugin.inject, ['tools', 'commands', 'webServer'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.WebUiRuntime, 'function')
  assert.equal(typeof plugin.defaultDeps, 'function')
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
