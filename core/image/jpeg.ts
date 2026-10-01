import { allocateRaster, ImageError, MAX_EDGE, type Raster } from './raster'

/**
 * Baseline and progressive JPEG decoding, in plain TypeScript.
 *
 * Why hand-write this: every image library that does this well is a native
 * dependency, and this app is deliberately one. More importantly, the editing
 * tools have to run in the MCP process, which has no Electron and therefore no
 * Chromium to borrow a decoder from. One implementation in core/ serves both
 * the viewer and the agent, and it works with the app closed.
 *
 * Progressive support is not optional here. Cameras, phone galleries and every
 * image optimiser on the web write progressive JPEGs, so a baseline-only
 * decoder would fail on a large share of real photographs.
 *
 * Output is always PNG-written RGBA elsewhere in this folder, because a cutout
 * is an alpha channel and JPEG cannot hold one.
 */

/** Zig-zag order: where each of the 64 coefficients sits in the natural scan. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
]

/**
 * Separable 8x8 inverse DCT basis. Precomputed once; without it the transform
 * would cost a cosine per term per block.
 */
const IDCT_BASIS = (() => {
  const basis = new Float32Array(64)
  for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) {
      const cu = u === 0 ? Math.SQRT1_2 : 1
      basis[u * 8 + x] = (cu / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
    }
  }
  return basis
})()

interface HuffTable {
  /** Smallest code of each bit length, or -1 when no code has that length. */
  mincode: Int32Array
  /** Largest code of each bit length, or -1 when no code has that length. */
  maxcode: Int32Array
  /** Index into `values` of the first code of each bit length. */
  valptr: Int32Array
  values: Uint8Array
  /** Present so a malformed table is reported rather than read past its end. */
  length: number
}

interface Component {
  id: number
  /** Horizontal and vertical sampling factors, 1..4. */
  h: number
  v: number
  quantId: number
  /** Output plane at this component's own resolution. */
  planeWidth: number
  planeHeight: number
  plane: Uint8Array
  /**
   * Dequantised coefficients, one Int32Array per component, sized for the
   * component's block grid. Progressive scans write partial coefficients here
   * over several passes; the IDCT runs once at the very end. Baseline decodes
   * straight into the same buffer, so both paths share the transform.
   */
  coefficients: Int32Array
  /** Blocks across and down in this component's own grid. */
  blocksPerLine: number
  blocksPerColumn: number
  /**
   * Where the interleaved scans park the blocks that fall outside that grid.
   * An MCU always carries a full h*v blocks per component, so the ragged right
   * and bottom edges are covered by blocks that hold no image data. The
   * entropy stream still carries them, so they have to be consumed, but letting
   * them land on a real block would corrupt that block's coefficients. They get
   * one shared scratch block instead, which behaves like the zero-filled block
   * the encoder emitted.
   */
  dummyBase: number
  /** DC predictor, one per component, carried across blocks. */
  pred: number
  /** Progressive EOB run length, reset at the start of each AC scan. */
  eobrun: number
}

interface ScanComponent {
  component: Component
  dcTable: number
  acTable: number
}

export function decodeJpeg(buf: Buffer): Raster {
  const state = new JpegDecoder(buf)
  return state.decode()
}

/** SOF markers that carry the frame size: baseline, extended and progressive. */
const SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2])

/**
 * Reads the frame size out of a JPEG header without decoding the entropy data.
 *
 * Unlike PNG, a JPEG has no fixed offset to the size: it lives in an SOF segment
 * that can sit behind any number of APPn and COM segments, so this walks the
 * marker chain the same way the decoder does. That walk is still cheap, because
 * every segment is skipped by its own declared length rather than scanned.
 *
 * Stops at SOS. Everything past the first scan is image data, not metadata, and
 * a file truncated inside its first scan still has its size available in the
 * segments already passed.
 *
 * Returns null when no frame header is in the bytes given, which means either a
 * malformed file or a caller who read too few bytes to reach the SOF.
 */
export function probeJpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let pos = 2
  while (pos + 1 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos += 1
      continue
    }
    while (buf[pos] === 0xff) pos += 1
    const marker = buf[pos]!
    pos += 1
    if (marker === 0xd9) return null // EOI with no frame header
    // Standalone markers: no length field follows.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (pos + 2 > buf.length) return null
    const length = buf.readUInt16BE(pos)
    if (length < 2) return null
    const segment = buf.subarray(pos + 2, pos + length)
    pos += length
    if (SIZE_MARKERS.has(marker)) {
      // precision, then height, then width.
      if (segment.length < 5) return null
      const height = segment.readUInt16BE(1)
      const width = segment.readUInt16BE(3)
      if (!width || !height) return null
      return { width, height }
    }
    if (marker === 0xda) return null // SOS: metadata is over, size never arrived
  }
  return null
}

class JpegDecoder {
  private readonly buf: Buffer
  private pos = 0

  private width = 0
  private height = 0
  private progressive = false
  private restartInterval = 0
  private maxH = 1
  private maxV = 1
  private mcusPerLine = 0
  private mcusPerColumn = 0

  private readonly quant: (Int32Array | null | undefined)[] = new Array(4).fill(undefined)
  private readonly dcTables: (HuffTable | null | undefined)[] = new Array(4).fill(undefined)
  private readonly acTables: (HuffTable | null | undefined)[] = new Array(4).fill(undefined)
  private components: Component[] = []
  /** Set once a frame is parsed; scans are decoded against it. */
  private sawFrame = false

  private bits = 0
  private bitCount = 0
  private markerHit = 0

  constructor(buf: Buffer) {
    this.buf = buf
  }

  decode(): Raster {
    if (this.buf.length < 4 || this.buf[0] !== 0xff || this.buf[1] !== 0xd8) {
      throw new ImageError('not a JPEG')
    }
    this.pos = 2

    while (this.pos < this.buf.length) {
      // Markers are 0xFF followed by a non-zero, non-FF code. Any run of 0xFF
      // before the code is legal padding.
      if (this.buf[this.pos] !== 0xff) {
        this.pos += 1
        continue
      }
      while (this.buf[this.pos] === 0xff) this.pos += 1
      const marker = this.buf[this.pos]!
      this.pos += 1

      if (marker === 0xd9) break // EOI
      if (marker >= 0xd0 && marker <= 0xd7) continue // stray restart
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue

      if (this.pos + 2 > this.buf.length) break
      const length = this.buf.readUInt16BE(this.pos)
      if (length < 2 || this.pos + length > this.buf.length) {
        throw new ImageError('truncated JPEG segment')
      }
      const segment = this.buf.subarray(this.pos + 2, this.pos + length)
      this.pos += length

      switch (marker) {
        case 0xc0: // SOF0 baseline
        case 0xc1: // SOF1 extended sequential, same entropy coding
          this.readFrame(segment, false)
          break
        case 0xc2: // SOF2 progressive
          this.readFrame(segment, true)
          break
        case 0xc3: // SOF3 lossless
        case 0xc5: case 0xc6: case 0xc7: // differential, not worth accepting
        case 0xc9: case 0xca: case 0xcb:
        case 0xcd: case 0xce: case 0xcf:
          throw new ImageError('this JPEG uses a coding mode OpenPics does not support')
        case 0xc4:
          this.readHuffmanTables(segment)
          break
        case 0xdb:
          this.readQuantTables(segment)
          break
        case 0xdd:
          this.restartInterval = segment.readUInt16BE(0)
          break
        case 0xda:
          this.readScan(segment)
          break
        default:
          // APPn, COM and anything else carries no pixel data.
          break
      }
    }

    if (!this.sawFrame) throw new ImageError('JPEG has no frame header')
    // Only now, with every scan read, are the coefficients complete. Progressive
    // JPEGs build them over a dozen passes, so the transform cannot run until
    // the last one.
    this.dequantise()
    this.runInverseDct()
    return this.toRaster()
  }

  private readFrame(segment: Buffer, progressive: boolean): void {
    if (this.sawFrame) throw new ImageError('JPEG has more than one frame')
    const precision = segment[0]!
    this.height = segment.readUInt16BE(1)
    this.width = segment.readUInt16BE(3)
    const count = segment[5]!

    if (precision !== 8) throw new ImageError('16-bit JPEG is not supported')
    if (!this.width || !this.height) throw new ImageError('JPEG has a zero dimension')
    if (this.width > MAX_EDGE || this.height > MAX_EDGE) {
      throw new ImageError(`JPEG is ${this.width}x${this.height}, over the ${MAX_EDGE}px limit`)
    }
    if (count < 1 || count > 4) throw new ImageError(`JPEG has ${count} components`)

    this.progressive = progressive
    let offset = 6
    this.components = []
    for (let i = 0; i < count; i += 1) {
      // Sampling factors share one byte: high nibble horizontal, low vertical.
      const hv = segment[offset + 1]!
      const h = hv >> 4
      const v = hv & 0x0f
      if (h < 1 || h > 4 || v < 1 || v > 4) {
        throw new ImageError(`bad sampling factors ${h}x${v}`)
      }
      this.components.push({
        id: segment[offset]!,
        h,
        v,
        quantId: segment[offset + 2]!,
        planeWidth: 0,
        planeHeight: 0,
        plane: new Uint8Array(0),
        coefficients: new Int32Array(0),
        blocksPerLine: 0,
        blocksPerColumn: 0,
        dummyBase: 0,
        pred: 0,
        eobrun: 0
      })
      this.maxH = Math.max(this.maxH, h)
      this.maxV = Math.max(this.maxV, v)
      offset += 3
    }

    this.mcusPerLine = Math.ceil(this.width / (8 * this.maxH))
    this.mcusPerColumn = Math.ceil(this.height / (8 * this.maxV))
    for (const component of this.components) {
      component.blocksPerLine = Math.ceil((this.width * component.h) / (8 * this.maxH))
      component.blocksPerColumn = Math.ceil((this.height * component.v) / (8 * this.maxV))
      // Planes are padded out to whole blocks so the IDCT can write full 8x8
      // outputs without a special case for the ragged right and bottom edges.
      component.planeWidth = component.blocksPerLine * 8
      component.planeHeight = component.blocksPerColumn * 8
      component.plane = new Uint8Array(component.planeWidth * component.planeHeight)
      component.coefficients = new Int32Array((component.blocksPerLine * component.blocksPerColumn + 1) * 64)
      component.dummyBase = component.blocksPerLine * component.blocksPerColumn * 64
      component.pred = 0
      component.eobrun = 0
    }
    this.sawFrame = true
  }

  private readQuantTables(segment: Buffer): void {
    let offset = 0
    while (offset < segment.length) {
      const spec = segment[offset]!
      offset += 1
      const precision = spec >> 4
      const id = spec & 0x0f
      if (id > 3) throw new ImageError('bad quantisation table id')
      if (precision > 1) throw new ImageError('16-bit quantisation is not supported')
      const table = new Int32Array(64)
      for (let i = 0; i < 64; i += 1) {
        const value = precision ? segment.readUInt16BE(offset) : segment[offset]!
        // Stored in zig-zag order; reorder once here so the transform sees
        // natural order and does not have to know about scan order at all.
        table[ZIGZAG[i]!] = value
        offset += precision ? 2 : 1
      }
      this.quant[id] = table
    }
  }

  private readHuffmanTables(segment: Buffer): void {
    let offset = 0
    while (offset < segment.length) {
      const spec = segment[offset]!
      offset += 1
      const isDc = spec >> 4 === 0
      const id = spec & 0x0f
      if (id > 3) throw new ImageError('bad Huffman table id')

      const counts = new Int32Array(17)
      let total = 0
      for (let bits = 1; bits <= 16; bits += 1) {
        const count = segment[offset++]!
        counts[bits] = count
        total += count
      }
      if (total > 256 || offset + total > segment.length) {
        throw new ImageError('bad Huffman table')
      }
      const values = new Uint8Array(total)
      for (let i = 0; i < total; i += 1) values[i] = segment[offset + i]!
      // A DHT segment may hold several tables, so consume the value bytes too.
      // Without this the loop re-reads them as another table header.
      offset += total

      // Spec (ITU-T T.81 Annex C) table construction. `code` carries across
      // lengths, so the smallest code of length n is twice the previous
      // length's starting code; deriving it from maxcode[n-1] instead loses
      // that doubling and lands on the wrong symbol.
      const mincode = new Int32Array(17).fill(-1)
      const maxcode = new Int32Array(17).fill(-1)
      const valptr = new Int32Array(17)
      let code = 0
      let index = 0
      for (let bits = 1; bits <= 16; bits += 1) {
        const count = counts[bits]!
        if (count > 0) {
          valptr[bits] = index
          mincode[bits] = code
          code += count
          index += count
          maxcode[bits] = code - 1
        }
        code <<= 1
      }
      const table: HuffTable = { mincode, maxcode, valptr, values, length: total }
      if (isDc) this.dcTables[id] = table
      else this.acTables[id] = table
    }
  }

  private readScan(segment: Buffer): void {
    if (!this.sawFrame) throw new ImageError('JPEG scan before frame')
    const count = segment[0]!
    const scan: ScanComponent[] = []
    let offset = 1
    for (let i = 0; i < count; i += 1) {
      const id = segment[offset]!
      const tables = segment[offset + 1]!
      const component = this.components.find((c) => c.id === id)
      if (!component) throw new ImageError('scan names an unknown component')
      scan.push({ component, dcTable: tables >> 4, acTable: tables & 0x0f })
      offset += 2
    }

    const spectralStart = segment[offset]!
    const spectralEnd = segment[offset + 1]!
    const approx = segment[offset + 2]!
    const ah = approx >> 4
    const al = approx & 0x0f

    this.resetBits()
    const dataStart = this.pos
    try {
      this.decodeScan(scan, spectralStart, spectralEnd, ah, al)
    } catch (error) {
      // A scan that runs off the end of the data is a truncated file. Say so,
      // rather than surfacing whatever half-decoded image happened to result.
      if (error instanceof ImageError && error.message === 'scan ran out of data') {
        throw new ImageError('truncated JPEG scan')
      }
      throw error
    }
    this.pos = this.findNextMarker(dataStart)
  }

  /** Steps past entropy-coded data to the next marker that is not stuffing. */
  private findNextMarker(from: number): number {
    let i = Math.max(from, this.pos)
    while (i + 1 < this.buf.length) {
      if (this.buf[i] === 0xff) {
        const next = this.buf[i + 1]!
        // 0x00 is a stuffed zero byte inside entropy data; 0xFF is padding.
        if (next !== 0x00 && next !== 0xff) return i
      }
      i += 1
    }
    return this.buf.length
  }

  private resetBits(): void {
    this.bits = 0
    this.bitCount = 0
    this.markerHit = 0
  }

  /** Fills the bit buffer, stopping at a marker instead of running past it. */
  private fillBits(): void {
    // `bits` holds at most 24 real bits, so the count must never claim more.
    // Refilling only while <= 16 means each +8 lands at or below 24.
    while (this.bitCount <= 16) {
      if (this.markerHit) {
        // Past a restart marker every bit reads as zero, which is what the spec
        // requires, and the marker is consumed at the restart boundary.
        this.bits = (this.bits << 8) & 0xffffff
        this.bitCount += 8
        continue
      }
      if (this.pos >= this.buf.length) {
        this.markerHit = 1
        this.bits = (this.bits << 8) & 0xffffff
        this.bitCount += 8
        continue
      }
      let byte = this.buf[this.pos++]!
      if (byte === 0xff) {
        const next = this.buf[this.pos]
        if (next === 0x00) {
          this.pos += 1
        } else if (next === undefined) {
          this.markerHit = 1
        } else {
          // A real marker: rewind so the caller's restart handling can see it.
          this.pos -= 1
          this.markerHit = 1
        }
      }
      this.bits = ((this.bits << 8) | byte) & 0xffffff
      this.bitCount += 8
    }
  }

  private getBits(count: number): number {
    if (count === 0) return 0
    if (this.bitCount < count) this.fillBits()
    this.bitCount -= count
    const value = (this.bits >>> this.bitCount) & ((1 << count) - 1)
    this.bits &= (1 << this.bitCount) - 1
    return value
  }

  private getBit(): number {
    return this.getBits(1)
  }

  /** Drops the partial byte, which the spec requires at each restart marker. */
  private alignToByte(): void {
    this.bits = 0
    this.bitCount = 0
  }

  private decodeHuffman(table: HuffTable | null | undefined): number {
    if (!table) throw new ImageError('JPEG names a Huffman table it never defined')
    // Grow the code one bit at a time until it fits a length the table defines.
    // Empty lengths keep maxcode -1, so they are skipped by the same test.
    let code = this.getBit()
    let length = 1
    while (length <= 16 && code > table.maxcode[length]!) {
      code = (code << 1) | this.getBit()
      length += 1
    }
    if (length > 16) throw new ImageError('bad Huffman code')
    const index = table.valptr[length]! + code - table.mincode[length]!
    if (index < 0 || index >= table.length) throw new ImageError('Huffman index out of range')
    return table.values[index]!
  }

  /**
   * Reads a value of `size` bits and extends it to a signed number, which is
   * how JPEG stores a negative: as its complement, in one fewer bit.
   */
  private receiveExtend(size: number): number {
    if (size === 0) return 0
    const value = this.getBits(size)
    return value < 1 << (size - 1) ? value - (1 << size) + 1 : value
  }

  /** Consumes an RSTn marker, or skips it if the scan ran to its end cleanly. */
  private handleRestart(): void {
    this.alignToByte()
    this.markerHit = 0
    // Step over any run of 0xFF padding to the restart code itself.
    while (this.pos + 1 < this.buf.length) {
      if (this.buf[this.pos] === 0xff) {
        const next = this.buf[this.pos + 1]!
        if (next >= 0xd0 && next <= 0xd7) {
          this.pos += 2
          break
        }
        if (next !== 0xff) break
      }
      this.pos += 1
    }
    // A restart interval resets the run-length and predictor state. Without
    // this, an EOBRUN left over from the previous interval swallows the first
    // blocks of the next one as if they were silent, and the DC predictor
    // carries a difference across the boundary that the encoder never coded.
    for (const component of this.components) {
      component.eobrun = 0
      component.pred = 0
    }
  }

  private checkData(): void {
    if (this.markerHit && this.pos >= this.buf.length) {
      throw new ImageError('scan ran out of data')
    }
  }

  private decodeScan(
    scan: ScanComponent[],
    spectralStart: number,
    spectralEnd: number,
    ah: number,
    al: number
  ): void {
    for (const entry of scan) {
      // eobrun is per-scan state: a scan that does not use it must not inherit
      // a stale run from the previous one. DC first and DC refinement passes
      // never touch it, and decodeDcFirst resets the DC predictor itself.
      if (!this.progressive || spectralStart !== 0) entry.component.eobrun = 0
    }

    // Baseline and extended-sequential write the DC value and the whole AC band
    // of a block back to back, so both must be read in one pass over each block.
    // Only progressive splits them into separate scans. Decoding them as two
    // full passes here makes the second pass read the first pass's AC bits as if
    // they were DC symbols, which desyncs everything that follows.
    if (!this.progressive) {
      this.decodeSequential(scan)
      return
    }

    if (spectralStart === 0) {
      if (ah === 0) this.decodeDcFirst(scan, al)
      else this.decodeDcRefine(scan, al)
    } else {
      if (ah === 0) this.decodeAcFirst(scan, spectralStart, spectralEnd, al)
      else this.decodeAcRefine(scan, spectralStart, spectralEnd, al)
    }
  }

  /** One block's DC difference followed by its run-length-coded AC band. */
  private decodeSequential(scan: ScanComponent[]): void {
    this.eachBlock(scan, (entry, row, col) => {
      const component = entry.component
      const coeffs = component.coefficients
      const base = this.coeffIndex(entry, row, col)

      this.checkData()
      const dcSize = this.decodeHuffman(this.dcTables[entry.dcTable])
      component.pred += dcSize === 0 ? 0 : this.receiveExtend(dcSize)
      coeffs[base] = component.pred

      const acTable = this.acTables[entry.acTable]
      let k = 1
      while (k <= 63) {
        this.checkData()
        const rs = this.decodeHuffman(acTable)
        const run = rs >> 4
        const size = rs & 0x0f
        if (size === 0) {
          if (run < 15) break // end of band for this block
          k += 16 // a run of sixteen zeroes
          continue
        }
        k += run
        if (k > 63) break
        coeffs[base + ZIGZAG[k]!] = this.receiveExtend(size)
        k += 1
      }
    })
  }
  /**
   * Walks every block in the scan, in the order the entropy coder wrote them.
   *
   * An interleaved scan visits MCUs; inside each MCU it visits h*v blocks per
   * component. A non-interleaved scan (a single component) walks just that
   * component's own block grid. Getting this order wrong is the classic way a
   * decoder looks almost right and then falls apart partway across the image.
   */
  private eachBlock(scan: ScanComponent[], visit: (entry: ScanComponent, blockRow: number, blockCol: number) => void): void {
    const interleaved = scan.length > 1
    if (interleaved) {
      let mcu = 0
      for (let my = 0; my < this.mcusPerColumn; my += 1) {
        for (let mx = 0; mx < this.mcusPerLine; mx += 1) {
          if (this.restartInterval && mcu > 0 && mcu % this.restartInterval === 0) this.handleRestart()
          mcu += 1
          for (const entry of scan) {
            const c = entry.component
            for (let v = 0; v < c.v; v += 1) {
              for (let h = 0; h < c.h; h += 1) {
                visit(entry, my * c.v + v, mx * c.h + h)
              }
            }
          }
        }
      }
    } else {
      const entry = scan[0]!
      const c = entry.component
      const total = c.blocksPerLine * c.blocksPerColumn
      let n = 0
      for (let by = 0; by < c.blocksPerColumn; by += 1) {
        for (let bx = 0; bx < c.blocksPerLine; bx += 1) {
          if (this.restartInterval && n > 0 && n % this.restartInterval === 0) this.handleRestart()
          n += 1
          visit(entry, by, bx)
        }
      }
      void total
    }
  }

  private coeffIndex(entry: ScanComponent, blockRow: number, blockCol: number): number {
    const c = entry.component
    if (blockRow >= c.blocksPerColumn || blockCol >= c.blocksPerLine) return c.dummyBase
    return (blockRow * c.blocksPerLine + blockCol) * 64
  }

  private decodeDcFirst(scan: ScanComponent[], al: number): void {
    for (const entry of scan) {
      entry.component.pred = 0
    }
    this.eachBlock(scan, (entry, row, col) => {
      const table = this.dcTables[entry.dcTable]
      this.checkData()
      const t = this.decodeHuffman(table)
      const diff = t === 0 ? 0 : this.receiveExtend(t) * (1 << al)
      entry.component.pred += diff
      const coeffs = entry.component.coefficients
      const at = this.coeffIndex(entry, row, col)
      coeffs[at] = entry.component.pred
    })
  }

  private decodeDcRefine(scan: ScanComponent[], al: number): void {
    this.eachBlock(scan, (entry, row, col) => {
      // A DC refinement pass is not Huffman coded. It contributes exactly one
      // raw bit per block: the next bit plane of the DC coefficient, at the
      // precision this pass is refining to. The DC first pass left the
      // coefficient shifted down by al, so OR-ing the bit back in at position
      // al reconstructs the true value. OR rather than + is what makes this
      // correct for negative coefficients too, whose high bit planes are
      // two's complement, and it is why the bit budget for these scans is
      // one bit per block plus restart-interval alignment padding.
      if (this.getBit()) {
        const coeffs = entry.component.coefficients
        const at = this.coeffIndex(entry, row, col)
        coeffs[at] = coeffs[at]! | (1 << al)
      }
    })
  }

  private decodeAcFirst(scan: ScanComponent[], spectralStart: number, spectralEnd: number, al: number): void {
    for (const entry of scan) entry.component.eobrun = 0
    this.eachBlock(scan, (entry, row, col) => {
      const acTable = this.acTables[entry.acTable]
      const component = entry.component
      if (component.eobrun > 0) {
        component.eobrun -= 1
        return
      }
      const coeffs = component.coefficients
      const base = this.coeffIndex(entry, row, col)
      let k = spectralStart
      while (k <= spectralEnd) {
        this.checkData()
        const rs = this.decodeHuffman(acTable)
        const run = rs >> 4
        const size = rs & 0x0f
        if (size !== 0) {
          k += run
          if (k > spectralEnd) {
            break
          }
          coeffs[base + ZIGZAG[k]!] = this.receiveExtend(size) * (1 << al)
          k += 1
        } else if (run !== 15) {
          // End of band. The run is (1 << run) plus `run` extra bits read
          // straight from the stream, which stay pending for the blocks that
          // follow; skipping those bits is what desynchronised every
          // progressive decode.
          //
          // The count includes the block that just signalled the run, because
          // that block's band also ended here. Failing to discount it made
          // every later coefficient land one block too far across, which
          // showed up as a clean one-block shift rather than a bit-level
          // desync -- and so survived every drift check.
          component.eobrun = this.readEobRun(run) - 1
          break
        } else {
          k += 16
        }
      }
    })
  }

  /**
   * Reads the tail of an end-of-band run. The Huffman symbol carries only the
   * high bits of the count: it gives the most significant bit as 1 << `run`,
   * and the low `run` bits follow as raw, non-Huffman-coded data.
   */
  private readEobRun(run: number): number {
    let length = 1 << run
    if (run !== 0) {
      this.checkData()
      length += this.getBits(run)
    }
    return length
  }

  /**
   * One AC successive-approximation refinement scan.
   *
   * A refinement scan does not send coefficients; it sends the *next bit* of
   * coefficients an earlier scan already established. That shapes the whole
   * loop around two rules:
   *
   *  - A run length counts only positions that are still empty. Walking to the
   *    target therefore passes over positions that do hold a value, and each of
   *    those consumes exactly one correction bit. Empty positions cost nothing:
   *    counting them is all a run does. Charging a bit to every skipped
   *    position, empty or not, desynchronises everything after the first run.
   *
   *  - A run of r is followed by the (r+1)'th empty position, which is where the
   *    new coefficient lands. That is why the walk below decrements first and
   *    only breaks once it has gone negative: it consumes r empties and stops on
   *    the one just past them. Treating the target as the r'th empty position
   *    shifts every later coefficient by one and costs 27 bytes on a subsampled
   *    900x585 progressive scan.
   *
   * The correction bits are read as the walk passes them rather than being
   * buffered, so their order matches the encoder's buffered flush without this
   * decoder having to model that buffer.
   *
   * Blocks covered by an end-of-band run emit no symbols, but every outstanding
   * coefficient is still owed a correction bit, which is all they do.
   */
  private decodeAcRefine(scan: ScanComponent[], spectralStart: number, spectralEnd: number, al: number): void {
    for (const entry of scan) entry.component.eobrun = 0
    const p1 = 1 << al
    const m1 = -1 << al

    this.eachBlock(scan, (scanned, row, col) => {
      const acTable = this.acTables[scanned.acTable]
      const component = scanned.component
      const coeffs = component.coefficients
      const base = this.coeffIndex(scanned, row, col)
      let k = spectralStart

      // Correction bits owed for the still-empty rest of the band. A block inside
      // an end-of-band run does nothing but this.
      const refineTail = (): void => {
        for (; k <= spectralEnd; k += 1) {
          const at = base + ZIGZAG[k]!
          if (coeffs[at] !== 0) this.refineExisting(coeffs, at, p1, m1)
        }
      }

      if (component.eobrun > 0) {
        component.eobrun -= 1
        refineTail()
        return
      }

      while (k <= spectralEnd) {
        this.checkData()
        const rs = this.decodeHuffman(acTable)
        let run = rs >> 4
        const size = rs & 0x0f
        let value = 0

        if (size === 0) {
          if (run === 15) {
            // Zero run length: the walk below consumes fifteen empties and
            // stops on the sixteenth, so `run` is left at the coded 15.
          } else {
            // The count covers the block that signalled it, whose band ended
            // here too and so still owes its correction bits.
            component.eobrun = this.readEobRun(run) - 1
            refineTail()
            return
          }
        } else {
          // Successive approximation always codes a new coefficient with a
          // single sign bit, whatever the symbol's size field claims.
          this.checkData()
          value = this.getBit() !== 0 ? p1 : m1
        }

        // Walk on to the target, spending one correction bit on every position
        // that already holds a value and only counting the empty ones. `run`
        // empties are consumed first; the break lands on the one after them, so
        // a run of r targets the (r+1)'th empty position.
        while (k <= spectralEnd) {
          const at = base + ZIGZAG[k]!
          if (coeffs[at] !== 0) {
            this.refineExisting(coeffs, at, p1, m1)
            k += 1
          } else {
            if (--run < 0) break
            k += 1
          }
        }
        if (value !== 0 && k <= spectralEnd) coeffs[base + ZIGZAG[k]!] = value
        k += 1
      }
    })
  }

  private refineBit(): boolean {
    this.checkData()
    return this.getBit() !== 0
  }

  /**
   * Grows a coefficient that already holds a value by one refinement step, when
   * the bit it lands on was still unset. The step follows the existing sign, so
   * refining never flips a coefficient's sign.
   */
  private refineExisting(coeffs: Int32Array, at: number, p1: number, m1: number): void {
    if (this.refineBit()) this.stepRefine(coeffs, at, p1, m1)
  }

  private stepRefine(coeffs: Int32Array, at: number, p1: number, m1: number): void {
    const existing = coeffs[at]!
    if ((existing & p1) === 0) coeffs[at] = existing >= 0 ? existing + p1 : existing + m1
  }

  /**
   * Turns every component's finished coefficients into samples, and returns
   * those as planes. Called once, after the last scan.
   */
  private runInverseDct(): void {
    // One reusable row of intermediate output; the transform is separable, so a
    // horizontal pass followed by a vertical pass needs only 64 scratch values
    // rather than a full 8x8 temporary per block.
    const tmp = new Float32Array(64)
    for (const component of this.components) {
      const quant = this.quant[component.quantId]
      if (!quant) throw new ImageError('component has no quantisation table')
      const { plane, planeWidth, blocksPerLine, blocksPerColumn, coefficients } = component
      for (let by = 0; by < blocksPerColumn; by += 1) {
        for (let bx = 0; bx < blocksPerLine; bx += 1) {
          const base = (by * blocksPerLine + bx) * 64
          // Coefficients are laid out row-major as [vertical][horizontal].
          // Horizontal pass: every coefficient row becomes eight sample columns.
          for (let v = 0; v < 8; v += 1) {
            for (let x = 0; x < 8; x += 1) {
              let s = 0
              for (let u = 0; u < 8; u += 1) {
                s += IDCT_BASIS[u * 8 + x]! * coefficients[base + v * 8 + u]!
              }
              tmp[v * 8 + x] = s
            }
          }
          // Vertical pass: combine the rows into the finished 8x8 block.
          for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 8; x += 1) {
              let s = 0
              for (let v = 0; v < 8; v += 1) {
                s += IDCT_BASIS[v * 8 + y]! * tmp[v * 8 + x]!
              }
              plane[(by * 8 + y) * planeWidth + bx * 8 + x] = clamp(Math.round(s) + 128)
            }
          }
        }
      }
    }
  }

  /**
   * Multiplies every coefficient by its quantisation table entry, turning the
   * decoder's integers back into the magnitudes the transform expects.
   */
  private dequantise(): void {
    for (const component of this.components) {
      const quant = this.quant[component.quantId]
      if (!quant) throw new ImageError('component has no quantisation table')
      const coeffs = component.coefficients
      for (let i = 0; i < coeffs.length; i += 1) {
        coeffs[i] = coeffs[i]! * quant[i & 63]!
      }
    }
  }
  private toRaster(): Raster {
    const raster = allocateRaster(this.width, this.height)
    const [first, second, third] = this.components

    if (this.components.length === 1) {
      // Greyscale: replicate the single plane across RGB.
      const plane = first!.plane
      for (let y = 0; y < this.height; y += 1) {
        for (let x = 0; x < this.width; x += 1) {
          const t = (y * this.width + x) * 4
          const v = plane[y * first!.planeWidth + x]!
          raster.data[t] = v
          raster.data[t + 1] = v
          raster.data[t + 2] = v
          raster.data[t + 3] = 255
        }
      }
      return raster
    }

    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const t = (y * this.width + x) * 4
        const yy = sample(first!, x, y, this.maxH, this.maxV)
        if (!second || !third) {
          raster.data[t] = yy
          raster.data[t + 1] = yy
          raster.data[t + 2] = yy
          raster.data[t + 3] = 255
          continue
        }
        const cb = sample(second!, x, y, this.maxH, this.maxV) - 128
        const cr = sample(third!, x, y, this.maxH, this.maxV) - 128
        // YCbCr to RGB, the inverse of what the encoder did.
        raster.data[t] = clamp(yy + 1.402 * cr)
        raster.data[t + 1] = clamp(yy - 0.344136 * cb - 0.714136 * cr)
        raster.data[t + 2] = clamp(yy + 1.772 * cb)
        raster.data[t + 3] = 255
      }
    }
    return raster
  }
}

/** Reads one sample, upsampling chroma with a bilinear filter. */
function sample(component: Component, x: number, y: number, maxH: number, maxV: number): number {
  const { plane, planeWidth, planeHeight, h, v } = component
  // A component's plane spans the whole image at `h/maxH` scale. Dividing by
  // `h` alone would halve the luma of a 4:2:0 image and would leave subsampled
  // chroma at full width, so the sample position must use the ratio to the
  // largest component, not the component's own factors.
  const sx = (x * h) / maxH
  const sy = (y * v) / maxV

  if (h === maxH && v === maxV) {
    const px = Math.min(planeWidth - 1, Math.max(0, Math.round(sx)))
    const py = Math.min(planeHeight - 1, Math.max(0, Math.round(sy)))
    return plane[py * planeWidth + px]!
  }

  // Bilinear costs nothing here and removes the most obvious chroma blockiness.
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  const fx = sx - x0
  const fy = sy - y0
  const cx0 = Math.min(Math.max(x0, 0), planeWidth - 1)
  const cy0 = Math.min(Math.max(y0, 0), planeHeight - 1)
  const cx1 = Math.min(cx0 + 1, planeWidth - 1)
  const cy1 = Math.min(cy0 + 1, planeHeight - 1)
  const c00 = plane[cy0 * planeWidth + cx0]!
  const c10 = plane[cy0 * planeWidth + cx1]!
  const c01 = plane[cy1 * planeWidth + cx0]!
  const c11 = plane[cy1 * planeWidth + cx1]!
  const i0 = c00 * (1 - fx) + c10 * fx
  const i1 = c01 * (1 - fx) + c11 * fx
  return Math.round(i0 * (1 - fy) + i1 * fy)
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}
