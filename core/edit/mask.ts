/**
 * The selection a cutout works on: how much of each pixel survives.
 *
 * Stored per pixel as 0-255 rather than as "selected" or not, because the edit
 * ops need a third state. A feathered edge and a soft brush both produce pixels
 * that are partly gone, and a boolean mask has nowhere to put that. It also
 * makes erase and restore symmetric: both are the same operation painting
 * towards a different end of the same scale.
 */
export interface Mask {
  width: number
  height: number
  /** `width * height` bytes: 0 removes the pixel entirely, 255 leaves it alone. */
  values: Uint8Array
}

export interface MaskStats {
  width: number
  height: number
  pixels: number
  /** Pixels the cutout would leave completely opaque. */
  kept: number
  /** Pixels it would partly fade. */
  softened: number
  /** Pixels it would remove completely. */
  removed: number
  /** Fraction removed, 0-1. */
  removedFraction: number
  /**
   * Tight bounds around the surviving pixels, or null when nothing survives.
   * Half-open, so `maxX`/`maxY` are exclusive.
   */
  bounds: { x: number; y: number; maxX: number; maxY: number } | null
}

export function createMask(width: number, height: number, value = 255): Mask {
  const values = new Uint8Array(width * height)
  if (value !== 0) values.fill(value)
  return { width, height, values }
}

export function cloneMask(mask: Mask): Mask {
  return { width: mask.width, height: mask.height, values: new Uint8Array(mask.values) }
}

/**
 * Tallies what a mask would do to the image.
 *
 * Cheap enough to run after every stroke, which is the point: the point of a
 * preview is that it tells you what is about to happen before it happens, and it
 * can only do that if measuring it is not the expensive part.
 */
export function maskStats(mask: Mask): MaskStats {
  const { width, height, values } = mask
  let kept = 0
  let softened = 0
  let removed = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const v = values[row + x]!
      if (v === 0) {
        removed++
        continue
      }
      if (v < 255) softened++
      else kept++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  const pixels = width * height
  return {
    width,
    height,
    pixels,
    kept,
    softened,
    removed,
    removedFraction: pixels === 0 ? 0 : removed / pixels,
    bounds: maxX < 0 ? null : { x: minX, y: minY, maxX: maxX + 1, maxY: maxY + 1 }
  }
}

/**
 * Softens every hard edge by a radius, as a separable box blur on the mask.
 *
 * A wand or an eraser leaves a staircase along the subject's outline, and a
 * staircase is the single most obvious sign that a cutout was made by a machine.
 * Blurring the mask before it multiplies the alpha turns that staircase into the
 * soft half-pixel edge a lens or a matte would have produced.
 *
 * Blurring the mask rather than the image is deliberate: it keeps the surviving
 * pixels at their original colour, so nothing blurs except the transparency.
 *
 * The pass is separable and uses a running sum, so cost is linear in the number
 * of pixels rather than quadratic in the radius. That matters because a large
 * radius on a 12MP photo is 12M reads per pass, not 12M times the radius.
 */
export function featherMask(mask: Mask, radius: number): Mask {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return cloneMask(mask)

  const { width, height, values } = mask
  const width2 = width * 2
  const tmp = new Float64Array(width * height)
  const out = new Uint8Array(width * height)
  const window = r * 2 + 1

  for (let y = 0; y < height; y++) {
    const row = y * width
    // Seed the running sum with the clamped start of the row, then step.
    let sum = 0
    for (let k = -r; k <= r; k++) sum += values[row + Math.min(width - 1, Math.max(0, k))]!
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / window
      const leaving = values[row + Math.min(width - 1, Math.max(0, x - r))]!
      const entering = values[row + Math.min(width - 1, Math.max(0, x + r + 1))]!
      sum += entering - leaving
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(height - 1, Math.max(0, k)) * width + x]!
    for (let y = 0; y < height; y++) {
      const v = sum / window
      out[y * width + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
      const leaving = tmp[Math.min(height - 1, Math.max(0, y - r)) * width + x]!
      const entering = tmp[Math.min(height - 1, Math.max(0, y + r + 1)) * width + x]!
      sum += entering - leaving
    }
  }

  return { width, height, values: out }
}