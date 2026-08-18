/**
 * Icon conversion tests: the pure .ico packer (header/entry/payload layout)
 * and the jimp-based converter (negative when jimp is missing; positive run
 * skipped when jimp is not installed, e.g. in sandboxes without network).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPlugin } from './_helpers.mjs'

/** Tiny valid PNG (1x1 red pixel) as a Buffer. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('icon: packIco lays out header, entries and payloads correctly', async () => {
  const plugin = await loadPlugin()
  const pngs = [
    { size: 16, data: Buffer.from([1, 2, 3]) },
    { size: 256, data: Buffer.from([4, 5, 6, 7]) },
  ]
  const ico = plugin.packIco(pngs)

  // ICONDIR: reserved 0, type 1, count 2
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 2)
  // Entry 1: 16x16 at offset 6+32=38
  assert.equal(ico[6], 16)
  assert.equal(ico[7], 16)
  assert.equal(ico.readUInt16LE(10), 1) // planes
  assert.equal(ico.readUInt16LE(12), 32) // bpp
  assert.equal(ico.readUInt32LE(14), 3) // byte length
  assert.equal(ico.readUInt32LE(18), 38) // offset
  // Entry 2: 256x256 (width byte 0), offset 41
  assert.equal(ico[22], 0)
  assert.equal(ico[23], 0)
  assert.equal(ico.readUInt32LE(30), 4)
  assert.equal(ico.readUInt32LE(34), 41)
  // Payloads at the recorded offsets
  assert.deepEqual([...ico.subarray(38, 41)], [1, 2, 3])
  assert.deepEqual([...ico.subarray(41, 45)], [4, 5, 6, 7])
  assert.equal(ico.length, 45)
})

test('icon: convertImageToIcon reports a helpful error when jimp is missing', async () => {
  const plugin = await loadPlugin()
  let jimpAvailable = false
  try {
    await import('jimp')
    jimpAvailable = true
  } catch {
    /* not installed — the negative path applies */
  }
  if (jimpAvailable) return // positive path covered by the next test

  await assert.rejects(() => plugin.convertImageToIcon(TINY_PNG), /requires the "jimp" package/)
})

test('icon: convertImageToIcon produces an ICO set from a PNG', { skip: false }, async (t) => {
  const plugin = await loadPlugin()
  let jimpAvailable = false
  try {
    await import('jimp')
    jimpAvailable = true
  } catch {
    /* not installed — skip the positive path */
  }
  if (!jimpAvailable) {
    t.skip('jimp not installed; positive conversion path not exercised')
    return
  }
  const set = await plugin.convertImageToIcon(TINY_PNG)
  assert.ok(Buffer.isBuffer(set.ico))
  assert.ok(Buffer.isBuffer(set.png))
  assert.equal(set.ico.readUInt16LE(2), 1) // type icon
  assert.ok(set.ico.readUInt16LE(4) >= 1) // at least one size entry
  assert.ok(set.png.length > 0)
})
