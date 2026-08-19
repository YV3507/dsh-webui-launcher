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

  // The spawned CLI must run from spec.cwd (tsx resolvable in checkout
  // layouts), not from wherever the .lnk happened to point.
  assert.match(cmd, /cd \/d "/)
  // Ready = shell 200 AND the client API transport up (426 on the mux path);
  // the generated file keeps cmd's literal-percent escape (%% -> %).
  assert.match(cmd, /curl\.exe/)
  assert.match(cmd, /api\/events\.mux/)
  assert.match(cmd, /%%\{http_code\}/)
  assert.doesNotMatch(cmd, /\$r -eq 200/)
  // Already serving? Skip the spawn and open the browser directly.
  assert.match(cmd, /if not errorlevel 1 goto open/)
  assert.match(cmd, /if errorlevel 1 \( timeout \/t 1 \/nobreak >nul & goto loop \)/)
  // The server is launched through a VBScript with a hidden console, so no
  // Node.js terminal stays on the desktop/taskbar while the server runs.
  assert.match(cmd, /wscript\.exe "/)
  const vbs = readFileSync(join(root, 'launch-server.vbs'), 'utf8')
  assert.match(vbs, /sh\.CurrentDirectory = "/)
  assert.match(vbs, /sh\.Run ".*", 0, False/)
  // The SPAWN path records the server PID (netstat) so the plugin can stop it
  // later; the record line must sit between the poll loop and the browser.
  assert.match(cmd, /netstat -ano/)
  assert.match(cmd, /server\.pid/)
  const recordIndex = cmd.indexOf('netstat -ano')
  const loopIndex = cmd.indexOf('goto loop')
  const openIndex = cmd.indexOf('start ""')
  assert.ok(loopIndex >= 0 && recordIndex > loopIndex && openIndex > recordIndex,
    'PID recording must run after the poll loop (spawn path) and before the browser')
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

  assert.match(script, /cd "/)
  assert.match(script, /is_ready\(\) \{/)
  assert.match(script, /api\/events\.mux/)
  assert.match(script, /while \[ \$i -lt 120 \]/)
  assert.match(script, /curl -sf/)
  // The spawn path records the server PID (lsof) for a later adopted-stop.
  assert.match(script, /lsof -nP -tiTCP:3080 -sTCP:LISTEN/)
  assert.match(script, /server\.pid/)
})
