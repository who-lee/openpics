// The image shape, its size limit and the allocation helper live in `raster.ts`,
// which is where the codecs get them from. Re-exported here so the rest of the app
// keeps importing the one module it already knows.
export { allocateRaster, ImageError, MAX_EDGE, type Raster } from './raster'

import { ImageError, type Raster } from './raster'

/** What we can read and what we can write, stated up front rather than discovered. */
export const READABLE = ['png', 'jpeg'] as const
export const WRITABLE = ['png'] as const

export type ReadableFormat = (typeof READABLE)[number]
export type WritableFormat = (typeof WRITABLE)[number]

import { closeSync, openSync, readSync } from 'node:fs'
import { decodePng, probePngSize } from './png'
import { decodeJpeg, probeJpegSize } from './jpeg'

/**
 * Identifies a format from its leading bytes rather than its extension.
 *
 * A file's name is the least reliable thing about it - photos get renamed to
 * .jpg while still being PNG, which is exactly what happens after a download or
 * an export from another tool. The magic bytes are what the file actually is.
 */
export function sniffFormat(buf: Buffer): ReadableFormat | null {
  if (buf.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (png.every((b, i) => buf[i] === b)) return 'png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  return null
}

/** True for the formats we can decode. Callers use this to skip before reading. */
export function isReadable(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return (READABLE as readonly string[]).includes(ext)
}

/** Enough bytes for a PNG header; generous enough to reach most JPEG SOF segments. */
const PROBE_BYTES = 64 * 1024

/**
 * The size of an encoded image, read from its header alone.
 *
 * This is the cheap half of decoding: it opens the file, reads at most one
 * 64kb buffer, and returns. Nothing is decompressed and no raster is allocated,
 * so a caller can size up a whole folder for the cost of the directory walk
 * itself. `decodeImage` remains the answer when the pixels are actually wanted.
 *
 * Uses the file's magic bytes rather than its extension, matching `sniffFormat`,
 * so a photograph renamed to the wrong suffix still reports its true size.
 *
 * Returns null for an unreadable file or an unrecognised one, never throws.
 */
export function probeImageSize(path: string): { width: number; height: number } | null {
  let handle: number
  try {
    handle = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    // One buffer per call rather than a shared one: this is called from a
    // directory walk that may run on several threads, and a module-level
    // scratch buffer would be a data race waiting to happen.
    const buf = Buffer.allocUnsafe(PROBE_BYTES)
    const read = readSync(handle, buf, 0, PROBE_BYTES, 0)
    const head = buf.subarray(0, read)
    const format = sniffFormat(head)
    if (!format) return null
    return format === 'png' ? probePngSize(head) : probeJpegSize(head)
  } catch {
    return null
  } finally {
    closeSync(handle)
  }
}

/**
 * Decodes a supported image to RGBA.
 *
 * Rejects anything it cannot handle rather than returning a partial image, so a
 * caller never has to guess whether a result is trustworthy.
 */
export function decodeImage(buf: Buffer): Raster {
  const format = sniffFormat(buf)
  if (!format) throw new ImageError('not a PNG or JPEG')
  // Imported statically rather than with a lazy require: the bundler inlines both
  // decoders but leaves a bare `require('./png')` string in the output, which then
  // fails at runtime in the packaged app because no such file sits next to the
  // bundle. Both decoders are small enough that loading them eagerly costs nothing.
  return format === 'png' ? decodePng(buf) : decodeJpeg(buf)
}


