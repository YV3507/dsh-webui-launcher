/**
 * Spawn-process tests for the built process module: a failed spawn (missing
 * executable) must be surfaced as an exited server with the error in the log
 * tail, so WebUiRuntime fails fast instead of waiting out the startup timeout.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadPlugin } from './_helpers.mjs'

test('process: a failed spawn is surfaced as an exited server with the error logged', async (t) => {
  const plugin = await loadPlugin()
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-spawn-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const server = plugin.spawnServer({
    command: 'definitely-not-a-real-executable-xyz',
    args: [],
    cwd: root,
    maxLogLines: 5,
  })

  // The spawn 'error' event fires on the next tick; give it a generous bound.
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(server.exitCode(), -1, 'a failed spawn must read as exited')
  assert.match(server.logs().join('\n'), /spawn failed:/)
  // Nothing was spawned, so a kill attempt is trivially "stopped".
  assert.equal(await server.kill(), true)
})

test('process: parseNetstatPid extracts the LISTENING pid for a port', async () => {
  const plugin = await loadPlugin()
  const out = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       30936',
    '  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:55555        0.0.0.0:0              LISTENING       7777',
  ].join('\r\n')

  assert.equal(plugin.parseNetstatPid(out, 3080), 30936)
  assert.equal(plugin.parseNetstatPid(out, 4000), 9999)
  // A port that is a numeric prefix of another must not match (5555 vs 55555).
  assert.equal(plugin.parseNetstatPid(out, 5555), null)
  assert.equal(plugin.parseNetstatPid(out, 1), null)
})
