/**
 * Shortcut orchestration tests: first-start marker semantics, headless and
 * disabled skips, failure tolerance, and icon application — all with scripted
 * fake shortcut dependencies (no real desktop, COM or files beyond the managed
 * dir). Plus the headless desktop detection guard via environment control.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadPlugin } from './_helpers.mjs'

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-shortcut-'))
  const managedDir = join(root, 'state')
  const options = {
    desktopShortcut: true,
    shortcutName: 'Test Launcher',
    shortcutIconPath: '',
    managedDir,
    spec: { command: 'node', cliArgs: ['x', '--profile', 'web'], cwd: '/x', url: 'http://127.0.0.1:3080', description: 'd' },
  }
  return { root, managedDir, options, marker: join(managedDir, 'shortcut.json') }
}

test('shortcut: disabled by config creates nothing', async () => {
  const plugin = await loadPlugin()
  const { options, marker } = fresh()
  const created = []
  const manager = new plugin.ShortcutManager({ ...options, desktopShortcut: false }, {
    detectDesktopDir: () => '/desktop',
    createShortcut: async (...args) => { created.push(args); return { path: '/desktop/Test Launcher.lnk' } },
    updateShortcutIcon: async () => true,
  })

  await manager.ensure()

  assert.equal(created.length, 0)
  assert.equal(existsSync(marker), false)
})

test('shortcut: headless host (no desktop) skips silently without a marker', async () => {
  const plugin = await loadPlugin()
  const { options, marker } = fresh()
  const created = []
  const manager = new plugin.ShortcutManager(options, {
    detectDesktopDir: () => null,
    createShortcut: async (...args) => { created.push(args); return { path: '/nope' } },
    updateShortcutIcon: async () => true,
  })

  await manager.ensure()

  assert.equal(created.length, 0)
  assert.equal(existsSync(marker), false)
})

test('shortcut: created once on first start (marker prevents re-creation)', async () => {
  const plugin = await loadPlugin()
  const { options, marker, managedDir } = fresh()
  const created = []
  const manager = new plugin.ShortcutManager(options, {
    detectDesktopDir: () => '/desktop',
    createShortcut: async (_desktop, dir, spec) => {
      created.push({ dir, spec })
      return { path: '/desktop/Test Launcher.lnk' }
    },
    updateShortcutIcon: async () => true,
  })

  await manager.ensure()
  await manager.ensure()

  assert.equal(created.length, 1)
  assert.equal(existsSync(marker), true)
  const markerJson = JSON.parse(readFileSync(marker, 'utf8'))
  assert.equal(markerJson.path, '/desktop/Test Launcher.lnk')
  // The managed dir was passed through to the creator.
  assert.equal(created[0].dir, managedDir)
  assert.equal(created[0].spec.name, 'Test Launcher')
  assert.equal(manager.hasShortcut(), true)
})

test('shortcut: creator throwing never propagates and leaves no marker', async () => {
  const plugin = await loadPlugin()
  const { options, marker } = fresh()
  const manager = new plugin.ShortcutManager(options, {
    detectDesktopDir: () => '/desktop',
    createShortcut: async () => { throw new Error('COM failed') },
    updateShortcutIcon: async () => true,
  })

  await manager.ensure() // must not throw

  assert.equal(existsSync(marker), false)
})

test('shortcut: creator returning null leaves no marker', async () => {
  const plugin = await loadPlugin()
  const { options, marker } = fresh()
  const manager = new plugin.ShortcutManager(options, {
    detectDesktopDir: () => '/desktop',
    createShortcut: async () => null,
    updateShortcutIcon: async () => true,
  })

  await manager.ensure()

  assert.equal(existsSync(marker), false)
})

test('shortcut: applyIcon without a shortcut reports it', async () => {
  const plugin = await loadPlugin()
  const { options } = fresh()
  const manager = new plugin.ShortcutManager(options, {
    detectDesktopDir: () => null,
    createShortcut: async () => null,
    updateShortcutIcon: async () => true,
  })

  const result = await manager.applyIcon('/icons/icon.ico')

  assert.equal(result.ok, false)
  assert.match(result.message, /no desktop shortcut/)
})

test('shortcut: applyIcon updates the stored shortcut icon', async () => {
  const plugin = await loadPlugin()
  const { options, marker, managedDir } = fresh()
  const updated = []
  const manager = new plugin.ShortcutManager(options, {
    detectDesktopDir: () => '/desktop',
    createShortcut: async () => {
      mkdirSync(managedDir, { recursive: true })
      return { path: '/desktop/Test Launcher.lnk' }
    },
    updateShortcutIcon: async (handle, iconFile) => {
      updated.push({ handle, iconFile })
      return true
    },
  })
  await manager.ensure()

  const result = await manager.applyIcon('/icons/icon.ico')

  assert.equal(result.ok, true)
  assert.deepEqual(updated, [{ handle: { path: '/desktop/Test Launcher.lnk' }, iconFile: '/icons/icon.ico' }])
  assert.ok(existsSync(marker))
})

test('shortcut: applyIcon reports an unsupported platform update', async () => {
  const plugin = await loadPlugin()
  const { options, managedDir } = fresh()
  const manager = new plugin.ShortcutManager(options, {
    detectDesktopDir: () => '/desktop',
    createShortcut: async () => {
      mkdirSync(managedDir, { recursive: true })
      return { path: '/desktop/Test Launcher.lnk' }
    },
    updateShortcutIcon: async () => false,
  })
  await manager.ensure()

  const result = await manager.applyIcon('/icons/icon.ico')

  assert.equal(result.ok, false)
  assert.match(result.message, /not supported on this platform or failed/)
})

test('desktop detection: headless guard returns null without a Desktop dir', async (t) => {
  const plugin = await loadPlugin()
  const root = mkdtempSync(join(tmpdir(), 'dsh-webui-desktop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const previous = process.env.USERPROFILE
  process.env.USERPROFILE = root
  t.after(() => {
    if (previous === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous
  })

  assert.equal(plugin.detectDesktopDir(), null)

  // With a Desktop dir present, detection finds it (this host is win32).
  mkdirSync(join(root, 'Desktop'))
  const found = plugin.detectDesktopDir()
  assert.ok(found !== null && found.endsWith('Desktop'))
})
