/**
 * A decoded image: straight 8-bit RGBA, row-major, no premultiplication.
 *
 * Every codec in this folder converts to exactly this, so the editing code never
 * needs to know which format a photo arrived in. The editing ops all want
 * per-pixel access, and a single representation is what makes that possible
 * without a conversion at every step.
 */
export interface Raster {
  width: number
  height: number
  /** `width * height * 4` bytes: red, green, blue, alpha. */
  data: Uint8ClampedArray
}

/** What we can read and what we can write, stated up front rather than discovered. */
export const READABLE = ['png', 'jpeg'] as const
export const WRITABLE = ['png'] as const

export type ReadableFormat = (typeof READABLE)[number]
export type WritableFormat = (typeof WRITABLE)[number]

/** Longest edge we will decode. A cutout has to hold the mask and the pixels. */
export const MAX_EDGE = 20000

export class ImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageError'
  }
}

import { decodePng } from './png'
import { decodeJpeg } from './jpeg'

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

export function allocateRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}
