import type { Mask } from './mask'

/**
 * Erase and restore brushes.
 *
 * Both are the same operation painting towards a different end of the mask's
 * 0-255 scale, which is why there is one function rather than two. Erase paints
 * towards 0, restore towards 255, and everything in between - the falloff, the
 * blend with what is already there - is identical.
 */

export type BrushMode = 'erase' | 'restore'

export interface BrushOptions {
  /** Centre in image pixels. */
  x: number
  y: number
  /** Radius in image pixels. */
  radius: number
  /**
   * Fraction of the radius painted at full strength, 0-1. The rest fades out.
   * Default 0.7, which leaves a soft rim rather than a hard disc.
   */
  hardness?: number
  mode: BrushMode
}

/**
 * Smoothstep between the two edges.
 *
 * Linear falloff puts a visible crease where a hard edge meets a soft one, which
 * is what makes a painted mask look like a gradient ramp rather than a brush.
 * Smoothstep is zero-derivative at both ends, so the two meet without a step.
 */
function falloff(t: number, hardness: number): number {
  if (t >= 1) return 0
  // Answered before the ramp rather than by clamping the caller's value down to
  // 0.999: clamping makes a requested hard edge leave a fractional sliver at the
  // rim, which is exactly the kind of near-invisible softness that later shows up
  // as a dark halo. The ramp below divides by 1 - hardness, so this case has to be
  // taken out of its hands.
  if (t <= hardness || hardness >= 1) return 1
  const u = (1 - t) / (1 - hardness)
  return u * u * (3 - 2 * u)
}

/**
 * Paints one dab and reports how many pixels it changed.
 *
 * A dab, not a stroke: the caller paints along the pointer's path, because a
 * stroke would have to guess how far the mouse moved between two events and
 * would either leave gaps on a fast drag or over-paint on a slow one.
 */
export function paintBrush(mask: Mask, options: BrushOptions): number {
  const radius = options.radius
  if (!(radius > 0)) return 0

  // falloff handles hardness of 1 and of 0 on its own; this only rejects values
  // outside the range the description promises, so a caller cannot pass NaN and
  // get a brush that quietly paints nothing.
  const hardness = options.hardness === undefined ? 0.7 : options.hardness
  if (!(hardness >= 0) || hardness > 1) {
    throw new RangeError(`hardness must be between 0 and 1, got ${options.hardness}`)
  }
  const target = options.mode === 'erase' ? 0 : 255

  const { width, height, values } = mask
  const cx = options.x
  const cy = options.y
  const minX = Math.max(0, Math.floor(cx - radius))
  const maxX = Math.min(width - 1, Math.ceil(cx + radius))
  const minY = Math.max(0, Math.floor(cy - radius))
  const maxY = Math.min(height - 1, Math.ceil(cy + radius))
  const radiusSq = radius * radius
  let changed = 0

  for (let y = minY; y <= maxY; y++) {
    const dy = y - cy
    const row = y * width
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx
      const distSq = dx * dx + dy * dy
      if (distSq > radiusSq) continue
      const strength = falloff(Math.sqrt(distSq) / radius, hardness)
      if (strength <= 0) continue
      const index = row + x
      const before = values[index]!
      // Blend rather than assign, so two half-strength dabs over the same pixel
      // land between the endpoints instead of snapping to whichever was last.
      const after = Math.round(before + (target - before) * strength)
      if (after !== before) {
        values[index] = after
        changed++
      }
    }
  }
  return changed
}