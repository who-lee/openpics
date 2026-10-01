import { deflateSync, inflateSync } from 'node:zlib'
import { allocateRaster, ImageError, MAX_EDGE, type Raster } from './raster'

/**
 * PNG reading and writing, in RGBA.
 *
 * PNG is the format this app writes, for one reason: it is the only widely
 * supported format that keeps an alpha channel, and a cutout is nothing but an
 * alpha channel. Writing JPEG after a cutout would flatten the very thing the
 * edit exists to produce.
 *
 * zlib ships with Node, so this costs no dependency at all.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Colour types, as stored in the IHDR chunk. */
const COLOR_GRAY = 0
const COLOR_RGB = 2
const COLOR_PALETTE = 3
const COLOR_GRAY_ALPHA = 4
const COLOR_RGBA = 6

/** Channels each colour type puts in one pixel, before any bit-depth expansion. */
const CHANNELS: Record<number, number> = {
  [COLOR_GRAY]: 1,
  [COLOR_RGB]: 3,
  [COLOR_PALETTE]: 1,
  [COLOR_GRAY_ALPHA]: 2,
  [COLOR_RGBA]: 4
}

/** A four-byte repeating pattern, the usual way to spell "transparent colour". */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(body.length + 12)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'ascii')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

interface Header {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
}

/**
 * Reads just the dimensions out of a PNG header, without decompressing anything.
 *
 * Only the first 24 bytes matter: the signature, then the length and type of the
 * first chunk, which is always IHDR by the spec. That makes listing a folder of
 * photographs cost a few bytes per file instead of a full decode, which is the
 * difference between answering in milliseconds and answering in minutes.
 *
 * Returns null rather than throwing: a header probe is a best-effort lookup, and
 * a caller asking "how big is this picture" is better served by "unknown" than by
 * an exception. A real decode still rejects anything malformed.
 */
export function probePngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !SIGNATURE.equals(buf.subarray(0, 8))) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  // A zero here means the file is not a usable PNG even though the header parsed.
  if (!width || !height) return null
  return { width, height }
}

export function decodePng(buf: Buffer): Raster {
  if (buf.length < 8 || !SIGNATURE.equals(buf.subarray(0, 8))) {
    throw new ImageError('not a PNG')
  }

  let header: Header | null = null
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const data: Buffer[] = []

  let offset = 8
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buf.length) throw new ImageError(`truncated ${type} chunk`)

    if (type === 'IHDR') {
      header = {
        width: buf.readUInt32BE(start),
        height: buf.readUInt32BE(start + 4),
        bitDepth: buf[start + 8]!,
        colorType: buf[start + 9]!,
        interlace: buf[start + 12]!
      }
    } else if (type === 'PLTE') {
      palette = buf.subarray(start, end)
    } else if (type === 'tRNS') {
      transparency = buf.subarray(start, end)
    } else if (type === 'IDAT') {
      data.push(buf.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }

  if (!header) throw new ImageError('PNG has no IHDR')
  const { width, height, bitDepth, colorType, interlace } = header
  if (!width || !height) throw new ImageError('PNG has a zero dimension')
  if (width > MAX_EDGE || height > MAX_EDGE) {
    throw new ImageError(`PNG is ${width}x${height}, over the ${MAX_EDGE}px limit`)
  }
  // Adam7 splits the image into seven passes, each its own miniature file. It is
  // legal but vanishingly rare in photographs, and supporting it would double
  // the decoder for a case that does not come up. Saying so beats returning
  // scrambled pixels.
  if (interlace !== 0) throw new ImageError('interlaced PNG is not supported')
  if (data.length === 0) throw new ImageError('PNG has no image data')

  const channels = CHANNELS[colorType]
  if (!channels) throw new ImageError(`unsupported PNG colour type ${colorType}`)
  if (![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw new ImageError(`unsupported PNG bit depth ${bitDepth}`)
  }
  if (colorType === COLOR_PALETTE && !palette) throw new ImageError('palette PNG has no PLTE')

  const raw = inflateSync(Buffer.concat(data))
  const bitsPerPixel = channels * bitDepth
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8)
  const filterStride = Math.ceil(bitsPerPixel / 8)
  if (raw.length < (bytesPerLine + 1) * height) throw new ImageError('PNG data is short')

  // Undo the per-scanline filters in place, one row at a time. The previous row
  // is needed because three of the five filters are defined against it.
  const lines = Buffer.allocUnsafe(bytesPerLine * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (bytesPerLine + 1)]!
    const src = raw.subarray(y * (bytesPerLine + 1) + 1, y * (bytesPerLine + 1) + 1 + bytesPerLine)
    const row = y * bytesPerLine
    const prior = row - bytesPerLine
    for (let x = 0; x < bytesPerLine; x += 1) {
      const value = src[x]!
      const left = x >= filterStride ? lines[row + x - filterStride]! : 0
      const up = y > 0 ? lines[prior + x]! : 0
      const upLeft = y > 0 && x >= filterStride ? lines[prior + x - filterStride]! : 0
      let out: number
      switch (filter) {
        case 0: out = value; break
        case 1: out = value + left; break
        case 2: out = value + up; break
        case 3: out = value + ((left + up) >> 1); break
        case 4: out = value + paeth(left, up, upLeft); break
        default: throw new ImageError(`unknown PNG filter ${filter} on row ${y}`)
      }
      lines[row + x] = out & 0xff
    }
  }

  const out = allocateRaster(width, height)
  const max = (1 << bitDepth) - 1
  // Held in a local so the per-pixel loop does not re-narrow a nullable on every
  // iteration, and so the compiler sees a definitely-present Buffer.
  const pal = palette
  for (let y = 0; y < height; y += 1) {
    const row = y * bytesPerLine
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4
      if (colorType === COLOR_PALETTE) {
        const index = readSample(lines, row, x, 0, bitDepth, channels)
        if (!pal || index * 3 + 2 >= pal.length) throw new ImageError('palette index out of range')
        out.data[target] = pal[index * 3]!
        out.data[target + 1] = pal[index * 3 + 1]!
        out.data[target + 2] = pal[index * 3 + 2]!
        out.data[target + 3] = transparency && index < transparency.length ? transparency[index]! : 255
        continue
      }

      const r = readSample(lines, row, x, 0, bitDepth, channels)
      const g = colorType === COLOR_GRAY || colorType === COLOR_GRAY_ALPHA
        ? r
        : readSample(lines, row, x, 1, bitDepth, channels)
      const b = colorType === COLOR_RGB || colorType === COLOR_RGBA
        ? readSample(lines, row, x, 2, bitDepth, channels)
        : r

      // Sub-byte depths are stored packed, so scale them up to fill 0-255.
      // A 1-bit image is not "half grey", it is black or white.
      const scale = bitDepth === 16 ? 1 : max
      out.data[target] = bitDepth === 16 ? r >> 8 : scale8(r, scale)
      out.data[target + 1] = bitDepth === 16 ? g >> 8 : scale8(g, scale)
      out.data[target + 2] = bitDepth === 16 ? b >> 8 : scale8(b, scale)

      if (colorType === COLOR_GRAY_ALPHA) {
        const a = readSample(lines, row, x, 1, bitDepth, channels)
        out.data[target + 3] = bitDepth === 16 ? a >> 8 : scale8(a, scale)
      } else if (colorType === COLOR_RGBA) {
        const a = readSample(lines, row, x, 3, bitDepth, channels)
        out.data[target + 3] = bitDepth === 16 ? a >> 8 : scale8(a, scale)
      } else if (transparency) {
        // Truecolour tRNS names one exact colour to treat as clear.
        const key = colorType === COLOR_RGB ? 3 : 1
        if (key === 3) {
          if (r === transparency.readUInt16BE(0) && g === transparency.readUInt16BE(2) &&
              b === transparency.readUInt16BE(4)) {
            out.data[target + 3] = 0
          }
        } else if (r === transparency.readUInt16BE(0)) {
          out.data[target + 3] = 0
        }
      } else {
        out.data[target + 3] = 255
      }
    }
  }
  return out
}

function scale8(value: number, max: number): number {
  return max === 255 ? value : Math.round((value * 255) / max)
}

/**
 * Reads sample `channel` of pixel `x` from a packed scanline.
 *
 * `channels` is passed in rather than looked up because at 16 bits a sample is
 * two bytes, so the stride depends on the real channel count: an RGB pixel is
 * 6 bytes from its first sample to the next, not 2.
 */
function readSample(
  lines: Buffer,
  row: number,
  x: number,
  channel: number,
  bitDepth: number,
  channels: number
): number {
  if (bitDepth === 8) return lines[row + (x * channels + channel)]!
  if (bitDepth === 16) return lines.readUInt16BE(row + (x * channels + channel) * 2)
  // 1, 2 and 4 bits pack several pixels into one byte. These depths only occur
  // on greyscale and palette images, which have exactly one channel, so the
  // bit offset is the whole story.
  const bitIndex = x * bitDepth
  const byte = lines[row + Math.floor(bitIndex / 8)]!
  const shift = 8 - bitDepth - (bitIndex % 8)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}

/** The PNG Paeth predictor: whichever of left/up/up-left is closest to their average. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Picks a filter per scanline the way the PNG specification suggests: try all
 * five and keep whichever produces the smallest sum of absolute differences.
 * On a photograph that is typically worth 20-30% over storing rows unfiltered,
 * for a few milliseconds of work.
 */
function filterRow(raw: Buffer, prior: Buffer | null, bytesPerLine: number, filterStride: number): { filter: number; out: Buffer } {
  const candidates: { filter: number; out: Buffer; score: number }[] = []
  for (let filter = 0; filter <= 4; filter += 1) {
    const out = Buffer.allocUnsafe(bytesPerLine)
    let score = 0
    for (let x = 0; x < bytesPerLine; x += 1) {
      const rawByte = raw[x]!
      const left = x >= filterStride ? raw[x - filterStride]! : 0
      const up = prior ? prior[x]! : 0
      const upLeft = prior && x >= filterStride ? prior[x - filterStride]! : 0
      let value: number
      switch (filter) {
        case 0: value = rawByte; break
        case 1: value = rawByte - left; break
        case 2: value = rawByte - up; break
        case 3: value = rawByte - ((left + up) >> 1); break
        default: value = rawByte - paeth(left, up, upLeft); break
      }
      value &= 0xff
      out[x] = value
      // Treating the byte as signed is what the heuristic in the spec does; it
      // treats a near-zero difference as cheap either way.
      score += value < 128 ? value : 256 - value
    }
    candidates.push({ filter, out, score })
  }
  let best = candidates[0]!
  for (const candidate of candidates) if (candidate.score < best.score) best = candidate
  return { filter: best.filter, out: best.out }
}

/** Encodes straight RGBA as an 8-bit RGBA PNG. */
export function encodePng(raster: Raster): Buffer {
  const { width, height, data } = raster
  const bytesPerLine = width * 4
  const raw = Buffer.allocUnsafe((bytesPerLine + 1) * height)
  let prior: Buffer | null = null
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.from(data.buffer, data.byteOffset + y * bytesPerLine, bytesPerLine)
    const { filter, out } = filterRow(row, prior, bytesPerLine, 4)
    raw[y * (bytesPerLine + 1)] = filter
    out.copy(raw, y * (bytesPerLine + 1) + 1)
    prior = row
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = COLOR_RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    // Level 9 because these files are written once and then read by a person
    // looking at a cutout, not fetched in a loop.
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
