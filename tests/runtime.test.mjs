/**
 * State-machine failure-path tests for the built WebUiRuntime, driven with
 * scriptable fake dependencies: no real processes, ports or timers. Covers
 * adopt, ready, child-death, sibling adoption, timeout, abort, stop, dispose,
 * single-flight concurrency and browser-open config.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { baseOptions, fakeDeps, loadPlugin } from './_helpers.mjs'

/** A probe sequence with a clamp: `[false, true]` = false once, then true. */
function sequencedProbe(sequence) {
  let i = 0
  return async () => sequence[Math.min(i++, sequence.length - 1)] ?? false
}

test('runtime: start adopts an already-listening server without spawning', async () => {
  const plugin = await loadPlugin()
  const { deps, calls } = fakeDeps({ probeListening: sequencedProbe([true]) })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)

  const result = await rt.start(new AbortController().signal)

  assert.equal(calls.spawns, 0)
  assert.equal(result.status.adopted, true)
  assert.equal(result.status.spawned, false)
  assert.equal(result.status.state, 'running')
  assert.match(result.message, /adopted the Web UI already serving/)
})

test('runtime: start spawns and reports ready once HTTP 200', async () => {
  const plugin = await loadPlugin()
  const { deps, calls } = fakeDeps({ probeListening: sequencedProbe([false, false, true]) })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)

  const result = await rt.start(new AbortController().signal)

  assert.equal(calls.spawns, 1)
  assert.ok(calls.httpReady >= 1) // once in the readiness loop, once in the final status()
  assert.equal(result.status.spawned, true)
  assert.equal(result.status.ready, true)
  assert.equal(result.status.state, 'running')
  assert.match(result.message, /Web UI ready at http:\/\/127\.0\.0\.1:3080 \(pid 4242\)/)
})

test('runtime: start waits until the API transport is ready (426 on /api/events.mux)', async () => {
  const plugin = await loadPlugin()
  let apiCalls = 0
  const { deps } = fakeDeps({
    probeListening: sequencedProbe([false, false, true, true, true]),
    // The API transport comes up on the second probe.
    probeApiReady: async () => {
      apiCalls += 1
      return apiCalls > 1
    },
  })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)

  const result = await rt.start(new AbortController().signal)

  // The shell answered 200 before the API transport was up; start must keep
  // polling instead of declaring ready (the browser would boot to "Failed to
  // load plugins").
  assert.ok(apiCalls >= 2)
  assert.equal(result.status.ready, true)
  assert.equal(result.status.spawned, true)
  assert.match(result.message, /Web UI ready/)
})

test('runtime: start fails loudly with the log tail when the child exits before serving', async () => {
  const plugin = await loadPlugin()
  const { deps, calls, server } = fakeDeps()
  server.die(1)
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)

  await assert.rejects(() => rt.start(new AbortController().signal), (error) => {
    assert.match(error.message, /exited before serving http:\/\/127\.0\.0\.1:3080 \(code 1\)/)
    assert.match(error.message, /server log line/)
    return true
  })
  assert.equal(calls.spawns, 1)
  assert.equal((await rt.status()).state, 'idle')
})

test('runtime: adopts a sibling that wins the port after our child dies', async () => {
  const plugin = await loadPlugin()
  const { deps, calls, server } = fakeDeps({ probeListening: sequencedProbe([false, true]) })
  server.die(1)
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)

  const result = await rt.start(new AbortController().signal)

  assert.equal(calls.spawns, 1)
  assert.equal(result.status.adopted, true)
  assert.match(result.message, /our dsh exited \(code 1\); adopted the server now on/)
})

test('runtime: start times out and kills the spawned child', async () => {
  const plugin = await loadPlugin()
  const { deps, calls } = fakeDeps() // probeListening always false
  const rt = new plugin.WebUiRuntime(baseOptions(), deps) // startupTimeoutMs 1000

  await assert.rejects(() => rt.start(new AbortController().signal), /did not become ready within 1s/)
  assert.equal(calls.kills, 1)
  assert.equal((await rt.status()).state, 'idle')
})

test('runtime: start aborts and kills the spawned child', async () => {
  const plugin = await loadPlugin()
  const { deps, calls } = fakeDeps()
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(() => rt.start(controller.signal), /webui_start aborted/)
  assert.equal(calls.spawns, 1)
  assert.equal(calls.kills, 1)
})

test('runtime: stop without a spawned server says nothing to stop', async () => {
  const plugin = await loadPlugin()
  const { deps, calls } = fakeDeps()
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)

  const result = await rt.stop()

  assert.equal(calls.kills, 0)
  assert.match(result.message, /nothing to stop/)
})

test('runtime: stop kills an adopted launcher server when the recorded PID matches', async (t) => {
  const plugin = await loadPlugin()
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-pidfile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pidFile = join(root, 'server.pid')
  writeFileSync(pidFile, '4242\n')
  const { deps, calls } = fakeDeps({
    pidForPort: async () => 4242,
    killPidTree: async () => {
      calls.pidKills += 1
      return true
    },
  })
  const rt = new plugin.WebUiRuntime({ ...baseOptions(), adoptedPidFile: pidFile }, deps)

  const result = await rt.stop()

  assert.equal(calls.pidKills, 1)
  assert.match(result.message, /stopped the Web UI server started by the launcher \(pid 4242\)/)
  assert.equal((await rt.status()).state, 'idle')
})

test('runtime: refuses to stop an adopted server when the recorded PID does not match the listener', async (t) => {
  const plugin = await loadPlugin()
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-pidfile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pidFile = join(root, 'server.pid')
  writeFileSync(pidFile, '100\n')
  const { deps, calls } = fakeDeps({
    pidForPort: async () => 4242, // a different process is listening now
  })
  const rt = new plugin.WebUiRuntime({ ...baseOptions(), adoptedPidFile: pidFile }, deps)

  const result = await rt.stop()

  assert.equal(calls.pidKills, 0)
  assert.match(result.message, /nothing to stop/)
})

test('runtime: refuses to stop an adopted server without a PID record', async (t) => {
  const plugin = await loadPlugin()
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-pidfile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { deps, calls } = fakeDeps({
    pidForPort: async () => 4242,
  })
  const rt = new plugin.WebUiRuntime({ ...baseOptions(), adoptedPidFile: join(root, 'server.pid') }, deps)

  const result = await rt.stop()

  assert.equal(calls.pidKills, 0)
  assert.match(result.message, /nothing to stop/)
})

test('runtime: an adopted stop is confirmed via the port when the pid-watcher lags', async (t) => {
  const plugin = await loadPlugin()
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-pidfile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pidFile = join(root, 'server.pid')
  writeFileSync(pidFile, '4242\n')
  let pidForPortCalls = 0
  const { deps } = fakeDeps({
    // First probe matches the recorded PID; after the (lagging) kill, the
    // port no longer answers on it — that is the real "stopped" signal.
    pidForPort: async () => {
      pidForPortCalls += 1
      return pidForPortCalls === 1 ? 4242 : null
    },
    killPidTree: async () => false, // the pid-watcher lags, but the kill worked
  })
  const rt = new plugin.WebUiRuntime({ ...baseOptions(), adoptedPidFile: pidFile }, deps)

  const result = await rt.stop()
  // killPidTree reported false, but the port no longer answers on the
  // recorded PID — the port is the real signal, so the stop is a success.
  assert.match(result.message, /stopped the Web UI server started by the launcher/)
})

test('runtime: an adopted stop stays "still running" when the port still has the recorded PID', async (t) => {
  const plugin = await loadPlugin()
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-pidfile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pidFile = join(root, 'server.pid')
  writeFileSync(pidFile, '4242\n')
  const { deps } = fakeDeps({
    pidForPort: async () => 4242, // the process is still listening
    killPidTree: async () => false,
  })
  const rt = new plugin.WebUiRuntime({ ...baseOptions(), adoptedPidFile: pidFile }, deps)

  const result = await rt.stop()
  assert.match(result.message, /still running after kill attempts/)
})

test('runtime: start records the spawned server PID for a later adopted-stop', async () => {
  const plugin = await loadPlugin()
  let recorded = null
  const { deps } = fakeDeps({
    probeListening: sequencedProbe([false, false, true]),
    recordSpawnedPid: (pid) => {
      recorded = pid
    },
  })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)

  await rt.start(new AbortController().signal)

  assert.equal(recorded, 4242)
})

test('runtime: stop kills the spawned server and returns to idle', async () => {
  const plugin = await loadPlugin()
  const { deps, calls } = fakeDeps({ probeListening: sequencedProbe([false, false, true]) })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)
  await rt.start(new AbortController().signal)

  const result = await rt.stop()

  assert.equal(calls.kills, 1)
  assert.match(result.message, /stopped the Web UI server \(pid 4242\)/)
  assert.equal((await rt.status()).state, 'idle')
})

test('runtime: a failed kill keeps the server reference so a later stop can retry', async () => {
  const plugin = await loadPlugin()
  const { deps, calls, server } = fakeDeps({ probeListening: sequencedProbe([false, false, true]) })
  server.kill = async () => {
    calls.kills += 1
    return false // the child survives the kill attempt
  }
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)
  await rt.start(new AbortController().signal)

  const first = await rt.stop()
  assert.equal(calls.kills, 1)
  assert.match(first.message, /still running after kill attempts/)
  // The reference must not be dropped: status still shows the live server.
  const afterFirst = await rt.status()
  assert.equal(afterFirst.spawned, true)
  assert.equal(afterFirst.state, 'running')
  assert.equal(afterFirst.pid, 4242)

  // A second stop retries the kill instead of reporting "nothing to stop".
  const second = await rt.stop()
  assert.equal(calls.kills, 2)
  assert.match(second.message, /still running after kill attempts/)
})

test('runtime: start while running but the server died reports the truth, not "ready"', async () => {
  const plugin = await loadPlugin()
  const { deps, server } = fakeDeps({ probeListening: sequencedProbe([false, false, true, true, false]) })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)
  await rt.start(new AbortController().signal)
  server.die(0) // the child exits after becoming ready; nothing listens anymore

  const result = await rt.start(new AbortController().signal)

  assert.equal(result.status.ready, false)
  assert.match(result.message, /exited \(code 0\); nothing serving/)
})

test('runtime: stop on an already-exited server reports it without killing', async () => {
  const plugin = await loadPlugin()
  const { deps, calls, server } = fakeDeps({ probeListening: sequencedProbe([false, false, true]) })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)
  await rt.start(new AbortController().signal)
  server.die(0) // the child dies after serving

  const result = await rt.stop()

  assert.equal(calls.kills, 0)
  assert.match(result.message, /already exited \(code 0\)/)
})

test('runtime: concurrent starts spawn once (single-flight)', async () => {
  const plugin = await loadPlugin()
  const { deps, calls } = fakeDeps({ probeListening: sequencedProbe([false, false, true, true]) })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)
  const signal = new AbortController().signal

  const [first, second] = await Promise.all([rt.start(signal), rt.start(signal)])

  assert.equal(calls.spawns, 1)
  assert.equal(first.status.ready, true)
  assert.equal(second.status.ready, true)
})

test('runtime: dispose stops the spawned server (orphan guard)', async () => {
  const plugin = await loadPlugin()
  const { deps, calls } = fakeDeps({ probeListening: sequencedProbe([false, false, true]) })
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)
  await rt.start(new AbortController().signal)

  await rt.dispose()

  assert.equal(calls.kills, 1)
  assert.equal((await rt.status()).state, 'idle')
})

test('runtime: start opens the browser only when configured', async () => {
  const plugin = await loadPlugin()
  let opened = 0
  const { deps } = fakeDeps({
    probeListening: sequencedProbe([false, false, true]),
    openBrowser: async () => {
      opened += 1
      return true
    },
  })
  const rt = new plugin.WebUiRuntime({ ...baseOptions(), openBrowserOnStart: true }, deps)

  await rt.start(new AbortController().signal)

  assert.equal(opened, 1)
})

test('runtime: status is idle/adopted-clean before anything runs', async () => {
  const plugin = await loadPlugin()
  const { deps } = fakeDeps()
  const rt = new plugin.WebUiRuntime(baseOptions(), deps)

  const status = await rt.status()

  assert.equal(status.state, 'idle')
  assert.equal(status.listening, false)
  assert.equal(status.spawned, false)
  assert.equal(status.adopted, false)
  assert.equal(status.pid, null)
})
