import { createMask, featherMask, type Mask } from './mask'
import { EditError } from './errors'

/**
 * Mask arithmetic: the operations that turn "mostly right" into "right".
 *
 * A cutout is nearly never right on the first try. The wand leaves a halo, the
 * brush leaves a scallop, and the picture has holes in the subject that nothing
 * that selects by colour can know about. Rather than make the caller express
 * those fixes as thousands of brush strokes, each is one operation here.
 *
 * Every function takes and returns a new `Mask` rather than mutating. The editor
 * keeps the original pixels forever precisely so that any of these can be undone
 * by discarding its result, and in-place editing would make that impossible.
 */

/**
 * A separable min or max filter over a radius.
 *
 * Separable because a square structuring element can be applied as a horizontal
 * pass then a vertical pass, which turns the cost per pixel from the square of the
 * radius into twice the radius. On a 12MP picture with a radius of 20 that is the
 * difference between four hundred million operations and twenty-four million.
 *
 * `mode: 'grow'` takes the maximum, which pushes the kept area outward;
 * `'shrink'` takes the minimum, which eats into it. Both clamp at the image edge,
 * so a subject touching the border does not develop a transparent fringe there.
 */
function minMaxFilter(mask: Mask, radius: number, mode: 'grow' | 'shrink'): Mask {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return { width: mask.width, height: mask.height, values: new Uint8Array(mask.values) }

  const { width, height, values } = mask
  const tmp = new Uint8Array(width * height)
  const out = new Uint8Array(width * height)
  const pick = mode === 'grow' ? Math.max : Math.min

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let best = values[row + x]!
      const lo = Math.max(0, x - r)
      const hi = Math.min(width - 1, x + r)
      for (let k = lo; k <= hi; k++) {
        const v = values[row + k]!
        if (mode === 'grow' ? v > best : v < best) best = v
      }
      tmp[row + x] = best
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let best = tmp[y * width + x]!
      const lo = Math.max(0, y - r)
      const hi = Math.min(height - 1, y + r)
      for (let k = lo; k <= hi; k++) {
        const v = tmp[k * width + x]!
        if (mode === 'grow' ? v > best : v < best) best = v
      }
      out[y * width + x] = best
    }
  }

  return { width, height, values: out }
}

/**
 * Pushes the kept area outward, eating the halo left by the wand.
 *
 * The amount is in pixels and follows the existing soft edge: a mask value of 128
 * moves to 255 if any pixel within the radius was 255, which is what closes a
 * one-pixel fringe without closing a genuine gap in the subject.
 */
export function growMask(mask: Mask, radius: number): Mask {
  return minMaxFilter(mask, radius, 'grow')
}

/** Pulls the kept area inward, taking back background the wand wrongly kept. */
export function shrinkMask(mask: Mask, radius: number): Mask {
  return minMaxFilter(mask, radius, 'shrink')
}

/** Flips every pixel, so what was kept is removed and the reverse. */
export function invertMask(mask: Mask): Mask {
  const values = new Uint8Array(mask.values.length)
  for (let i = 0; i < values.length; i++) values[i] = 255 - mask.values[i]!
  return { width: mask.width, height: mask.height, values }
}

/** Sets every pixel to fully kept or fully removed. */
export function fillMask(mask: Mask, value: 255 | 0): Mask {
  return createMask(mask.width, mask.height, value)
}

/**
 * Keeps only the part of the selection connected to the largest component.
 *
 * The wand grows from every border pixel at once, so any speck of background that
 * happens to match the reference and touches an edge is kept along with the
 * subject. Isolated pieces are far more likely to be noise than intent, so this
 * drops them. Flood-filling from the edge inwards rather than labelling every
 * component means the cost is proportional to what survives the test, not to the
 * whole picture.
 */
export function keepLargestRegion(mask: Mask): { mask: Mask; dropped: number } {
  const { width, height, values } = mask
  const total = width * height
  const seen = new Uint8Array(total)
  const sizes: number[] = []
  const labels: Int32Array = new Int32Array(total)
  const stack = new Int32Array(total)
  let next = 0

  for (let start = 0; start < total; start++) {
    if (values[start]! === 0 || seen[start] === 1) continue
    const label = next++
    let size = 0
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    while (sp > 0) {
      const index = stack[--sp]!
      labels[index] = label
      size++
      const x = index % width
      if (x > 0 && seen[index - 1] === 0 && values[index - 1]! > 0) { seen[index - 1] = 1; stack[sp++] = index - 1 }
      if (x < width - 1 && seen[index + 1] === 0 && values[index + 1]! > 0) { seen[index + 1] = 1; stack[sp++] = index + 1 }
      if (index >= width && seen[index - width] === 0 && values[index - width]! > 0) { seen[index - width] = 1; stack[sp++] = index - width }
      if (index < total - width && seen[index + width] === 0 && values[index + width]! > 0) { seen[index + width] = 1; stack[sp++] = index + width }
    }
    sizes.push(size)
  }

  if (sizes.length <= 1) return { mask: { width, height, values: new Uint8Array(values) }, dropped: 0 }

  let biggest = 0
  for (let i = 1; i < sizes.length; i++) if (sizes[i]! > sizes[biggest]!) biggest = i

  const out = new Uint8Array(total)
  let dropped = 0
  for (let i = 0; i < total; i++) {
    const v = values[i]!
    if (v > 0 && labels[i] === biggest) out[i] = v
    // Only pixels that were kept and are now not. Counting the already-removed
    // background too would report the whole picture minus the subject - 2300
    // pixels "dropped" when the actual second island was 13 - which reads as
    // though the operation destroyed the cutout rather than tidied it.
    else if (v > 0) dropped++
  }
  return { mask: { width, height, values: out }, dropped }
}

/**
 * Fills holes fully enclosed by the kept area.
 *
 * A ring the wand grew around a highlight leaves the highlight as a hole, and no
 * amount of growing closes it because growing needs kept pixels to grow from.
 * Flood-filling the *removed* area inward from the border and then inverting
 * finds every removed pixel the kept area encloses, which is the definition of a
 * hole - and does it in one pass regardless of how many holes there are.
 */
export function fillMaskHoles(mask: Mask): { mask: Mask; filled: number } {
  const { width, height, values } = mask
  const total = width * height
  // reached marks removed pixels connected to the outside world.
  const reached = new Uint8Array(total)
  const stack = new Int32Array(total)
  let sp = 0

  const push = (index: number): void => {
    if (reached[index] === 1 || values[index]! > 0) return
    reached[index] = 1
    stack[sp++] = index
  }

  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }

  while (sp > 0) {
    const index = stack[--sp]!
    const x = index % width
    if (x > 0) push(index - 1)
    if (x < width - 1) push(index + 1)
    if (index >= width) push(index - width)
    if (index < total - width) push(index + width)
  }

  const out = new Uint8Array(values)
  let filled = 0
  for (let i = 0; i < total; i++) {
    if (values[i] === 0 && reached[i] === 0) {
      out[i] = 255
      filled++
    }
  }
  return { mask: { width, height, values: out }, filled }
}

/**
 * Removes leftovers smaller than a fraction of the picture.
 *
 * Speckle is what a JPEG's compression noise does to an otherwise clean cutout:
 * a few dozen stray pixels around the edge. The operation that erases it is a
 * morphological opening - shrink by r, then grow by r - because a speck that
 * cannot survive being required to keep all of its neighbours is one narrower
 * than the structuring element, and the subject's real outline, being thicker than
 * that everywhere it matters, comes back the same size it went in.
 *
 * The order is the whole point, and it was previously the other way round. Growing
 * and then shrinking is a closing, which does the opposite job: it fills gaps and
 * bridges, and no amount of it will ever delete an isolated pixel. That version
 * ran to completion, reported a plausible pixel count, and left every speck in
 * the picture.
 */
export function despeckleMask(mask: Mask, radius = 1): Mask {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return { width: mask.width, height: mask.height, values: new Uint8Array(mask.values) }
  // Shrink then grow, and the grow is what restores the subject to its original
  // size. Only the shrink removes anything; a grow on its own would only add.
  return minMaxFilter(minMaxFilter(mask, r, 'shrink'), r, 'grow')
}

/**
 * Cuts on the source's own alpha, for a picture that is already transparent.
 *
 * A PNG saved by another tool often has a halo of partly-transparent pixels
 * around the subject - the remains of whatever matte it was made from. The
 * tolerance of a colour wand has nothing to say about that, because the pixels
 * are the right colour; it is their alpha that is wrong. This discards everything
 * fainter than the threshold, which is the one judgement that picture actually
 * supports.
 */
export function thresholdAlpha(mask: Mask, alpha: Uint8Array, level: number): { mask: Mask; removed: number } {
  const t = Math.max(0, Math.min(255, Math.round(level)))
  const values = new Uint8Array(mask.values.length)
  let removed = 0
  for (let i = 0; i < values.length; i++) {
    if (alpha[i]! < t) {
      values[i] = 0
      removed++
    } else {
      values[i] = 255
    }
  }
  return { mask: { width: mask.width, height: mask.height, values }, removed }
}

/** Applies the existing edge softening to the stored mask, making it permanent. */
export function featherMaskInPlace(mask: Mask, radius: number): Mask {
  return featherMask(mask, radius)
}

/**
 * Bakes a soft edge into a hard one at a given cut point.
 *
 * Everything above `level` becomes fully kept and everything below becomes fully
 * removed. Useful after a feathery operation when a caller wants a crisp
 * silhouette rather than a gradient, and the complement of feather for the cases
 * where a gradient was not wanted at all.
 */
export function thresholdMask(mask: Mask, level: number): { mask: Mask; kept: number } {
  const t = Math.max(0, Math.min(255, Math.round(level)))
  const values = new Uint8Array(mask.values.length)
  let kept = 0
  for (let i = 0; i < values.length; i++) {
    if (mask.values[i]! >= t) {
      values[i] = 255
      kept++
    } else {
      values[i] = 0
    }
  }
  return { mask: { width: mask.width, height: mask.height, values }, kept }
}

/** Guards the pixel budget for operations that allocate a second raster. */
export function assertWithinLimit(pixels: number, limit: number): void {
  if (pixels > limit) {
    throw new EditError(
      `this operation needs ${pixels.toLocaleString('en-US')} pixels, above the ${limit.toLocaleString('en-US')} supported`
    )
  }
}
