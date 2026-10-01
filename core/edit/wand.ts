import type { Raster } from '../image/image'

/**
 * Magic wand region growing.
 *
 * The selection is grown from a set of seed pixels over the whole raster, and
 * every candidate is compared against one reference colour rather than against
 * the pixel it was reached from. Comparing each step against its own neighbour
 * instead - which is what a plain region-grow does - lets the fill creep across
 * any gradient one step at a time, so a soft-edged subject slowly disappears
 * into the background. A single global reference makes the tolerance mean one
 * thing: how far a colour may be from the reference and still count as part of
 * the same region. That predictability is the whole point for a tool an agent
 * drives.
 *
 * The result is deliberately a separate selection rather than a finished mask.
 * Which side of the selection is the subject is a question about the picture,
 * not about the wand, so the caller answers it.
 */

export interface WandOptions {
  /** Seed point in image pixels, for `from: 'point'`. Defaults to the centre. */
  x?: number
  y?: number
  /**
   * Sum of absolute per-channel differences a pixel may differ by and still be
   * part of the region. 0 is an exact match, 765 is anything. Default 48,
   * which is about 16 per channel: measured against ordinary photographs, 12 and
   * 24 remove nothing at all, because JPEG noise alone moves a background further
   * than that. Raising it to 64 or 90 keeps eating into the subject.
   */
  tolerance?: number
  /**
   * Where the region starts. `point` grows from one pixel; `border` grows from
   * every border pixel at once, which finds the background around a subject
   * without the user having to guess a corner. Default is `point` when a
   * coordinate is given and `border` otherwise.
   */
  from?: 'point' | 'border'
}

export interface WandResult {
  width: number
  height: number
  /** `width * height` bytes: 1 where the region was grown, 0 elsewhere. */
  selection: Uint8Array
  /** The colour everything was compared against. */
  reference: [number, number, number]
  pixels: number
  from: 'point' | 'border'
}

const DEFAULT_TOLERANCE = 48
/** Alpha at or below this counts as already-empty background to grow into. */
const TRANSPARENT_ALPHA = 4

/**
 * A LIFO of pixel indices that grows as it fills.
 *
 * Region growing is written most naturally as a stack, and the stack's high-water
 * mark on a real photo is far below the pixel count - it holds the frontier, not
 * the region. Starting at a fraction of the image and doubling from there keeps
 * a 12MP photo from allocating a 48MB index buffer it will never touch.
 */
class IndexStack {
  private buf: Int32Array
  private len = 0

  constructor(hint: number) {
    this.buf = new Int32Array(Math.max(1024, Math.min(1 << 20, hint)))
  }

  get size(): number {
    return this.len
  }

  push(v: number): void {
    if (this.len === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.len++] = v
  }

  pop(): number {
    return this.buf[--this.len]!
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Mean colour of the outermost ring, ignoring pixels that are already empty.
 *
 * Only the opaque ones count. A transparent pixel's RGB is whatever the last
 * encoder left there - typically zero - and averaging those in drags the
 * reference towards black by however much of the border is already cut out. On a
 * picture that has been through this tool once that is most of the border, and
 * the reference ends up so far from the real background that nothing matches the
 * tolerance and the cutout silently removes nothing at all.
 */
function borderReference(raster: Raster): [number, number, number] {
  const { width, height, data } = raster
  let r = 0
  let g = 0
  let b = 0
  let n = 0

  const add = (index: number): void => {
    const o = index * 4
    if (data[o + 3]! <= TRANSPARENT_ALPHA) return
    r += data[o]!
    g += data[o + 1]!
    b += data[o + 2]!
    n++
  }

  for (let x = 0; x < width; x++) {
    add(x)
    add((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    add(y * width)
    add(y * width + width - 1)
  }
  if (n === 0) return [0, 0, 0]
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

export function selectRegion(raster: Raster, options: WandOptions = {}): WandResult {
  const { width, height, data } = raster
  if (width === 0 || height === 0) {
    return {
      width,
      height,
      selection: new Uint8Array(0),
      reference: [0, 0, 0],
      pixels: 0,
      from: 'point'
    }
  }

  const from: 'point' | 'border' =
    options.from ?? (options.x !== undefined && options.y !== undefined ? 'point' : 'border')
  const tolerance = clampInt(options.tolerance ?? DEFAULT_TOLERANCE, 0, 765)

  let reference: [number, number, number]
  let seed: (index: number) => void

  if (from === 'border') {
    reference = borderReference(raster)
    // Every border pixel is a seed, plus any already-empty pixel anywhere, so a
    // PNG that has been cut out once can be re-cut without the fill having to
    // find its way back in through a fully transparent band.
    seed = (index: number): void => {
      const o = index * 4
      if (data[o + 3]! <= TRANSPARENT_ALPHA) mark(index)
      else if (index < width || index >= (height - 1) * width || index % width === 0 || index % width === width - 1) {
        mark(index)
      }
    }
  } else {
    const x = clampInt(Math.round(options.x ?? Math.floor(width / 2)), 0, width - 1)
    const y = clampInt(Math.round(options.y ?? Math.floor(height / 2)), 0, height - 1)
    const o = (y * width + x) * 4
    reference = [data[o]!, data[o + 1]!, data[o + 2]!]
    seed = (index: number): void => mark(index)
  }

  const selection = new Uint8Array(width * height)
  const stack = new IndexStack(Math.floor((width * height) / 64))
  const [refR, refG, refB] = reference
  let pixels = 0

  function mark(index: number): void {
    if (selection[index] === 1) return
    const o = index * 4
    // A pixel with nothing in it has no colour to disagree about, so it always
    // passes. Without this, a PNG that was already cut out once presents a hole
    // full of undefined RGB that a light-background reference rejects, and the
    // fill cannot travel through its own transparent region to reach the rest.
    if (data[o + 3]! > TRANSPARENT_ALPHA) {
      const dr = Math.abs(data[o]! - refR)
      const dg = Math.abs(data[o + 1]! - refG)
      const db = Math.abs(data[o + 2]! - refB)
      if (dr + dg + db > tolerance) return
    }
    selection[index] = 1
    pixels++
    stack.push(index)
  }

  if (from === 'border') {
    for (let x = 0; x < width; x++) {
      seed(x)
      seed((height - 1) * width + x)
    }
    for (let y = 1; y < height - 1; y++) {
      seed(y * width)
      seed(y * width + width - 1)
    }
    // A hole in the middle of an already-transparent PNG is not reachable from
    // the border ring, so sweep the interior for transparent pixels too. Doing
    // this in one pass keeps the cost at one read per pixel.
    for (let index = 0; index < selection.length; index++) {
      if (selection[index] === 0 && data[index * 4 + 3]! <= TRANSPARENT_ALPHA) mark(index)
    }
  } else {
    const x = clampInt(Math.round(options.x ?? Math.floor(width / 2)), 0, width - 1)
    const y = clampInt(Math.round(options.y ?? Math.floor(height / 2)), 0, height - 1)
    seed(y * width + x)
  }

  while (stack.size > 0) {
    const index = stack.pop()
    const x = index % width
    // Four-connected. Diagonal growth would join regions that only touch at a
    // corner, which is exactly the leak that eats a strand of hair.
    if (x > 0) mark(index - 1)
    if (x < width - 1) mark(index + 1)
    if (index >= width) mark(index - width)
    if (index < width * (height - 1)) mark(index + width)
  }

  return { width, height, selection, reference, pixels, from }
}