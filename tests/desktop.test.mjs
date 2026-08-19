/**
 * Launcher-script tests for the built desktop module: the Windows .cmd
 * poll-until-ready loop must exit 1 while the surface is NOT ready (so
 * `if errorlevel 1` loops) and 0 once it answers 200 (so the browser opens).
 * The historical bug wrote `exit ($r -eq 200)`, which inverts the loop: ready
 * → exit 1 → infinite loop, never opening the browser.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadPlugin } from './_helpers.mjs'

function spec(root) {
  return {
    name: 'Test Launcher',
    command: 'C:\\node.exe',
    cliArgs: ['--profile', 'web', '--host', '127.0.0.1', '--port', '3080'],
    cwd: root,
    url: 'http://127.0.0.1:3080',
    description: 'Launch the DeepSeek Harness Web UI',
    iconPath: '',
  }
}

test('launcher script: Windows .cmd polls until ready with the correct polarity', async (t) => {
  const plugin = await loadPlugin()
  if (process.platform !== 'win32') {
    t.skip('Windows .cmd generation only applies on win32')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-launch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const path = plugin.writeLauncherScript(root, spec(root))
  const cmd = readFileSync(path, 'utf8')

  // Loop while NOT ready (exit 1), fall through to open the browser once ready.
  assert.match(cmd, /exit \(\$r -ne 200\)/)
  assert.doesNotMatch(cmd, /exit \(\$r -eq 200\)/)
  assert.match(cmd, /if errorlevel 1 \( timeout \/t 1 \/nobreak >nul & goto loop \)/)
  // The browser line follows the loop, not the other way around.
  const loopIndex = cmd.indexOf('goto loop')
  const openIndex = cmd.indexOf('start ""')
  assert.ok(loopIndex >= 0 && openIndex > loopIndex, 'browser must open only after the poll loop')
})

test('launcher script: POSIX .sh polls with curl before opening the browser', async (t) => {
  const plugin = await loadPlugin()
  if (process.platform === 'win32') {
    t.skip('POSIX launcher script only applies on non-Windows hosts')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-launch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const path = plugin.writeLauncherScript(root, spec(root))
  const script = readFileSync(path, 'utf8')

  assert.match(script, /while \[ \$i -lt 120 \]/)
  assert.match(script, /curl -sf/)
  const loopIndex = script.indexOf('done')
  const openIndex = script.indexOf('xdg-open') >= 0 ? script.indexOf('xdg-open') : script.indexOf('open "')
  assert.ok(loopIndex >= 0 && openIndex > loopIndex, 'browser must open only after the poll loop')
})
