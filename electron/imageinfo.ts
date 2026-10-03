import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Bytes read from the front of a file when sniffing dimensions. */
const HEAD_BYTES = 262144

export interface Dimensions {
  width: number
  height: number
}

function readHead(path: string): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(HEAD_BYTES)
    const read = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return read === HEAD_BYTES ? buf : buf.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* the descriptor is already gone, nothing to recover */
      }
    }
  }
}

function png(buf: Buffer): Dimensions | null {
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function gif(buf: Buffer): Dimensions | null {
  if (buf.length < 10) return null
  const sig = buf.toString('ascii', 0, 6)
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

function jpeg(buf: Buffer): Dimensions | null {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null
  let off = 2
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off += 1
      continue
    }
    const marker = buf[off + 1]!
    // Standalone markers carry no payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2
      continue
    }
    const len = buf.readUInt16BE(off + 2)
    // SOF0..SOF15, excluding the DHT/JPG/DAC slots that share the numeric range.
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
    }
    if (marker === 0xda) break
    off += 2 + len
  }
  return null
}

function bmp(buf: Buffer): Dimensions | null {
  if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null
  return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
}

function webp(buf: Buffer): Dimensions | null {
  if (buf.length < 30) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return {
      width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buf.readUIntLE(27, 3) & 0xffffff) + 1
    }
  }
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    }
  }
  return null
}

/**
 * AVIF, HEIC and friends are ISO base media files. The pixel size lives in an
 * "ispe" box, so scan the buffered head for it rather than walking the box tree.
 */
function isobmff(buf: Buffer): Dimensions | null {
  if (buf.length < 12) return null
  const brand = buf.toString('ascii', 4, 12)
  if (!/^(ftyp|heic|heix|hevc|hevx|mif1|msf1|avif|avis)/.test(brand)) return null
  const idx = buf.indexOf('ispe', 0, 'ascii')
  if (idx < 0 || idx + 16 > buf.length) return null
  return { width: buf.readUInt32BE(idx + 8), height: buf.readUInt32BE(idx + 12) }
}

function tiff(buf: Buffer): Dimensions | null {
  if (buf.length < 8) return null
  const le = buf.toString('ascii', 0, 2) === 'II'
  const magic = le ? buf.readUInt16LE(2) : buf.readUInt16BE(2)
  if (magic !== 42) return null
  const ifd = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4)
  if (ifd + 2 > buf.length) return null
  const count = le ? buf.readUInt16LE(ifd) : buf.readUInt16BE(ifd)
  let width = 0
  let height = 0
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > buf.length) break
    const tag = le ? buf.readUInt16LE(entry) : buf.readUInt16BE(entry)
    if (tag !== 256 && tag !== 257) continue
    const type = le ? buf.readUInt16LE(entry + 2) : buf.readUInt16BE(entry + 2)
    // SHORT type packs the value into the first two bytes of the value field.
    const value =
      type === 3
        ? le
          ? buf.readUInt16LE(entry + 8)
          : buf.readUInt16BE(entry + 8)
        : le
          ? buf.readUInt32LE(entry + 8)
          : buf.readUInt32BE(entry + 8)
    if (tag === 256) width = value
    else height = value
    if (width > 0 && height > 0) return { width, height }
  }
  return { width, height }
}

function svg(buf: Buffer): Dimensions | null {
  // SVG is text. Only the first few kilobytes matter for a root <svg> tag.
  const head = buf.subarray(0, 8192).toString('utf8')
  const tag = head.match(/<svg\b[^>]*>/i)
  if (!tag) return null
  const attr = (name: string): number | null => {
    const m = tag[0]!.match(new RegExp(`\\b${name}\\s*=\\s*["']?\\s*([\\d.]+)`, 'i'))
    if (!m?.[1]) return null
    const n = Number.parseFloat(m[1])
    return Number.isFinite(n) && n > 0 ? n : null
  }
  let width = attr('width')
  let height = attr('height')
  if (width === null || height === null) {
    const vb = tag[0]!.match(/\bviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)/i)
    if (vb) {
      width ??= Number.parseFloat(vb[3]!)
      height ??= Number.parseFloat(vb[4]!)
    }
  }
  if (width === null || height === null) return { width: 0, height: 0 }
  return { width: Math.round(width), height: Math.round(height) }
}

const PARSERS: Record<string, (buf: Buffer) => Dimensions | null> = {
  png,
  jpg: jpeg,
  jpeg: jpeg,
  jpe: jpeg,
  jfif: jpeg,
  gif,
  bmp,
  webp,
  avif: isobmff,
  heic: isobmff,
  heif: isobmff,
  tif: tiff,
  tiff: tiff,
  svg
}

/**
 * Reads only the file header, never the pixel data. Returns zeroes when the
 * format is unrecognised, which the grid treats as "unknown ratio".
 */
export function probeDimensions(path: string, ext: string): Dimensions {
  const parser = PARSERS[ext.toLowerCase()]
  if (!parser) return { width: 0, height: 0 }
  const buf = readHead(path)
  if (!buf || buf.length === 0) return { width: 0, height: 0 }
  try {
    return parser(buf) ?? { width: 0, height: 0 }
  } catch {
    return { width: 0, height: 0 }
  }
}

export function safeStat(path: string): { bytes: number; mtime: number } | null {
  try {
    const s = statSync(path)
    return { bytes: s.size, mtime: Math.round(s.mtimeMs) }
  } catch {
    return null
  }
}

/** The user-facing slice of EXIF this app reads. Absent tags stay absent. */
export interface RawExif {
  Make?: string
  Model?: string
  camera?: string
  Software?: string
  DateTime?: string
  DateTimeOriginal?: string
  Orientation?: number
  FNumber?: number
  ExposureTime?: number
  ISO?: number
  FocalLength?: number
  LensModel?: string
}

const EXIF_TAGS: Record<number, keyof RawExif> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x9003: 'DateTimeOriginal',
  0x0112: 'Orientation',
  0x829d: 'FNumber',
  0x829a: 'ExposureTime',
  0x8827: 'ISO',
  0x920a: 'FocalLength',
  0xa434: 'LensModel'
}

const EXIF_IFD_POINTER = 0x8769

/**
 * Locates the TIFF block that carries EXIF: the payload of a JPEG APP1 "Exif"
 * segment, or the file itself when it is already a TIFF. Returns null when the
 * header carries none, so a PNG or a bare BMP is an honest "no metadata".
 */
function findExifTiff(buf: Buffer): Buffer | null {
  if (buf.length >= 4 && buf.readUInt16BE(0) === 0xffd8) {
    let off = 2
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) {
        off += 1
        continue
      }
      const marker = buf[off + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2
        continue
      }
      if (marker === 0xda) break
      const len = buf.readUInt16BE(off + 2)
      if (marker === 0xe1 && off + 10 <= buf.length && buf.toString('ascii', off + 4, off + 10) === 'Exif\0\0') {
        return buf.subarray(off + 10, off + 2 + len)
      }
      off += 2 + len
    }
    return null
  }
  if (buf.length < 8) return null
  const magic = buf.toString('ascii', 0, 2) === 'II' ? buf.readUInt16LE(2) : buf.readUInt16BE(2)
  return magic === 42 ? buf : null
}

function readAscii(tiff: Buffer, valueOffset: number, count: number): string {
  const end = Math.min(valueOffset + count, tiff.length)
  const raw = tiff.subarray(valueOffset, end).toString('utf8')
  return raw.replace(/\0+$/, '').trim()
}

/** Reads one IFD's entries into `out`, recursing into the Exif sub-IFD once. */
function readIfd(tiff: Buffer, ifdOffset: number, le: boolean, out: RawExif, depth: number): void {
  if (depth > 2 || ifdOffset + 2 > tiff.length) return
  const count = le ? tiff.readUInt16LE(ifdOffset) : tiff.readUInt16BE(ifdOffset)
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12
    if (entry + 12 > tiff.length) return
    const tag = le ? tiff.readUInt16LE(entry) : tiff.readUInt16BE(entry)
    const type = le ? tiff.readUInt16LE(entry + 2) : tiff.readUInt16BE(entry + 2)
    const valueCount = le ? tiff.readUInt32LE(entry + 4) : tiff.readUInt32BE(entry + 4)
    // A value of four bytes or fewer sits inline; anything larger is an offset.
    const inline = type === 3 || type === 8 ? 2 : 4
    const valueOffset =
      valueCount * inline <= 4
        ? entry + 8
        : le
          ? tiff.readUInt32LE(entry + 8)
          : tiff.readUInt32BE(entry + 8)

    if (tag === EXIF_IFD_POINTER && type === 4) {
      const sub = le ? tiff.readUInt32LE(entry + 8) : tiff.readUInt32BE(entry + 8)
      readIfd(tiff, sub, le, out, depth + 1)
      continue
    }

    const name = EXIF_TAGS[tag]
    if (!name) continue
    const read = (): string | number | undefined => {
      if (type === 2) return readAscii(tiff, valueOffset, valueCount)
      if (type === 3) return le ? tiff.readUInt16LE(valueOffset) : tiff.readUInt16BE(valueOffset)
      if (type === 4) return le ? tiff.readUInt32LE(valueOffset) : tiff.readUInt32BE(valueOffset)
      if ((type === 5 || type === 10) && valueOffset + 8 <= tiff.length) {
        const num = type === 5
          ? le ? tiff.readUInt32LE(valueOffset) : tiff.readUInt32BE(valueOffset)
          : le ? tiff.readInt32LE(valueOffset) : tiff.readInt32BE(valueOffset)
        const den = type === 5
          ? le ? tiff.readUInt32LE(valueOffset + 4) : tiff.readUInt32BE(valueOffset + 4)
          : le ? tiff.readInt32LE(valueOffset + 4) : tiff.readInt32BE(valueOffset + 4)
        return den === 0 ? undefined : num / den
      }
      return undefined
    }
    const value = read()
    if (value === undefined || value === '') continue
    out[name] = value as never
  }
}

/**
 * Reads the small, human-interest slice of EXIF from a picture header. It never
 * touches pixel data and never throws; an unreadable file simply has none.
 */
export function probeExif(path: string, ext: string): RawExif | null {
  const buf = readHead(path)
  if (!buf || buf.length < 8) return null
  try {
    const tiff = findExifTiff(buf)
    if (!tiff || tiff.length < 8) return null
    const le = tiff.toString('ascii', 0, 2) === 'II'
    const firstIfd = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4)
    const out: RawExif = {}
    readIfd(tiff, firstIfd, le, out, 0)
    if (out.Model || out.Make) out.camera = out.Model ?? out.Make
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}