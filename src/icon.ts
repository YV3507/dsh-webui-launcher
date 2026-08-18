/**
 * Icon conversion for the desktop shortcut: decodes arbitrary image formats
 * (PNG/JPEG/BMP/GIF/TIFF) via jimp and produces what each platform's shortcut
 * needs — a multi-size Windows .ico (PNG-compressed entries, Vista+) and a
 * single PNG for Linux .desktop icons. jimp is loaded lazily so a missing
 * dependency degrades the icon feature only, never the plugin.
 */

/** Standard Windows shortcut icon sizes. */
const ICON_SIZES = [16, 32, 48, 64, 128, 256]

export interface IconSet {
  /** Multi-size Windows icon (PNG-compressed entries). */
  ico: Buffer
  /** A single 256px PNG for Linux .desktop icons. */
  png: Buffer
}

/** One PNG entry destined for the .ico container. */
export interface IcoPngEntry {
  size: number
  data: Buffer
}

/**
 * Pack PNG blobs into a Windows .ico container (PNG-compressed entries).
 * Header: reserved(2) type(2)=1 count(2); then 16-byte entries (width,
 * height with 0=256, palette, reserved, planes=1, bpp=32, byte length,
 * offset); then the PNG payloads.
 */
export function packIco(pngs: readonly IcoPngEntry[]): Buffer {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  const entries = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  for (let i = 0; i < count; i += 1) {
    const { size, data } = pngs[i]!
    const entry = entries.subarray(i * 16, (i + 1) * 16)
    entry[0] = size >= 256 ? 0 : size // width (0 = 256)
    entry[1] = size >= 256 ? 0 : size // height
    entry[2] = 0 // palette
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
  }
  return Buffer.concat([header, entries, ...pngs.map((png) => png.data)])
}

/**
 * Decode any supported image and produce the icon set. Uses jimp, loaded
 * lazily so conversion failures are isolated to this feature.
 */
export async function convertImageToIcon(input: Buffer): Promise<IconSet> {
  let Jimp: typeof import('jimp').Jimp
  try {
    ({ Jimp } = await import('jimp'))
  } catch {
    throw new Error('icon conversion requires the "jimp" package, which is missing — reinstall dsh-webui-launcher with its dependencies')
  }
  const image = await Jimp.read(input)
  const pngs: IcoPngEntry[] = []
  for (const size of ICON_SIZES) {
    const resized = image.clone().resize({ w: size, h: size })
    const data = await resized.getBuffer('image/png')
    pngs.push({ size, data })
  }
  return { ico: packIco(pngs), png: pngs[pngs.length - 1]!.data }
}
