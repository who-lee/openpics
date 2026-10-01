import { allocateRaster, type Raster } from '../image/image'
import type { AdjustOptions } from '../../shared/edit'
import { EditError } from './errors'

// Declared in `shared` so the editor panel and the agent tools describe the same
// adjustments, and re-exported here so everything that already imported it from
// this module keeps working.
export type { AdjustOptions }

/**
 * Geometry and tone: crop, rotate, flip, resize, and the colour controls.
 *
 * These run on the finished composite rather than on the mask, because a crop is
 * a statement about the output and not about which pixels the subject occupies.
 * Keeping them separate means the mask stays in source coordinates and every
 * selection tool keeps working after a crop, instead of needing to be told about
 * the transform that was applied to the picture underneath it.
 *
 * Nothing here is destructive: each takes a raster and returns a new one.
 */

/** Bilinear sample of a raster at float coordinates, clamped at the edges. */
function sampleBilinear(raster: Raster, x: number, y: number): [number, number, number, number] {
  const { width, height, data } = raster
  const cx = Math.max(0, Math.min(width - 1, x))
  const cy = Math.max(0, Math.min(height - 1, y))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = cx - x0
  const ty = cy - y0

  const at = (px: number, py: number, c: number): number => data[(py * width + px) * 4 + c]!
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let c = 0; c < 4; c++) {
    const top = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx
    const bottom = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx
    out[c] = top * (1 - ty) + bottom * ty
  }
  return out
}

/**
 * Crops to a rectangle.
 *
 * The box is clipped rather than rejected, and the result is refused only if the
 * overlap is empty, because a caller working from a previous tool's reported
 * bounds is often a pixel out and failing that would be pedantry. `trim` takes
 * the tighter of the two: whatever the box asks for, or the non-transparent
 * content, which is what "remove the empty margin" actually means.
 */
export function cropRaster(
  raster: Raster,
  box: { x: number; y: number; width: number; height: number } | null,
  trim = false
): Raster {
  let x = 0
  let y = 0
  let w = raster.width
  let h = raster.height

  if (trim) {
    // The bounds of what is *kept*, not of what was removed. Trimming to the
    // extent of the empty pixels trims to the border of the picture and therefore
    // never crops anything at all, which is how this shipped as a no-op that still
    // reported a new size.
    let minX = raster.width
    let minY = raster.height
    let maxX = -1
    let maxY = -1
    for (let py = 0; py < raster.height; py++) {
      const row = py * raster.width
      for (let px = 0; px < raster.width; px++) {
        if (raster.data[(row + px) * 4 + 3]! === 0) continue
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
      }
    }
    if (maxX < 0) {
      throw new EditError('everything has been removed, so there is nothing left to crop to')
    }
    x = minX
    y = minY
    w = maxX - minX + 1
    h = maxY - minY + 1
  }

  if (box) {
    const bx = Math.max(0, Math.round(box.x))
    const by = Math.max(0, Math.round(box.y))
    const bx1 = Math.max(0, Math.min(raster.width, Math.round(box.x + box.width)))
    const by1 = Math.max(0, Math.min(raster.height, Math.round(box.y + box.height)))
    if (bx1 <= bx || by1 <= by) {
      throw new EditError(
        `the crop ${bx},${by} ${Math.round(box.width)}x${Math.round(box.height)} falls outside the ${raster.width}x${raster.height} image`
      )
    }
    x = bx
    y = by
    w = bx1 - bx
    h = by1 - by
  }

  if (x === 0 && y === 0 && w === raster.width && h === raster.height) {
    return { width: w, height: h, data: new Uint8ClampedArray(raster.data) }
  }

  const out = allocateRaster(w, h)
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const src = ((py + y) * raster.width + (px + x)) * 4
      const dst = (py * w + px) * 4
      out.data[dst] = raster.data[src]!
      out.data[dst + 1] = raster.data[src + 1]!
      out.data[dst + 2] = raster.data[src + 2]!
      out.data[dst + 3] = raster.data[src + 3]!
    }
  }
  return out
}

/** Rotates by a multiple of 90 degrees, which is lossless and exact. */
export function rotateQuarterTurns(raster: Raster, turns: number): Raster {
  const t = ((Math.round(turns) % 4) + 4) % 4
  if (t === 0) return { width: raster.width, height: raster.height, data: new Uint8ClampedArray(raster.data) }

  const swap = t === 1 || t === 3
  const out = allocateRaster(swap ? raster.height : raster.width, swap ? raster.width : raster.height)
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const src = (y * raster.width + x) * 4
      let dx: number
      let dy: number
      if (t === 1) { dx = raster.height - 1 - y; dy = x }
      else if (t === 2) { dx = raster.width - 1 - x; dy = raster.height - 1 - y }
      else { dx = y; dy = raster.width - 1 - x }
      const dst = (dy * out.width + dx) * 4
      out.data[dst] = raster.data[src]!
      out.data[dst + 1] = raster.data[src + 1]!
      out.data[dst + 2] = raster.data[src + 2]!
      out.data[dst + 3] = raster.data[src + 3]!
    }
  }
  return out
}

/** Mirrors left to right, or top to bottom. */
export function flipRaster(raster: Raster, axis: 'horizontal' | 'vertical'): Raster {
  const out = allocateRaster(raster.width, raster.height)
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const sx = axis === 'horizontal' ? raster.width - 1 - x : x
      const sy = axis === 'horizontal' ? y : raster.height - 1 - y
      const src = (sy * raster.width + sx) * 4
      const dst = (y * out.width + x) * 4
      out.data[dst] = raster.data[src]!
      out.data[dst + 1] = raster.data[src + 1]!
      out.data[dst + 2] = raster.data[src + 2]!
      out.data[dst + 3] = raster.data[src + 3]!
    }
  }
  return out
}

/**
 * Scales to exact dimensions, or by a percentage, or to a longest edge.
 *
 * Bilinear rather than nearest-neighbour because nearest is what makes a resized
 * cutout look chewed. Bilinear on straight alpha is technically wrong at soft
 * edges - it averages colour and coverage separately, so a red pixel fading out
 * picks up the colour of whatever was next to it - which is why this is offered
 * as a deliberate choice and not as the only option. Correct premultiplied
 * resampling is `downscale` in the preview module, which is not usable here
 * because it is a reduction-only path.
 */
export function resizeRaster(
  raster: Raster,
  options: { width?: number; height?: number; percent?: number; longestEdge?: number }
): Raster {
  const { width: w0, height: h0 } = raster
  let w = w0
  let h = h0

  if (options.percent !== undefined) {
    const p = options.percent / 100
    if (!(p > 0)) throw new EditError(`a scale of ${options.percent}% is not a size`)
    w = Math.max(1, Math.round(w0 * p))
    h = Math.max(1, Math.round(h0 * p))
  } else if (options.longestEdge !== undefined) {
    const longest = Math.max(w0, h0)
    if (!(options.longestEdge > 0)) throw new EditError(`a longest edge of ${options.longestEdge} is not a size`)
    const p = options.longestEdge / longest
    w = Math.max(1, Math.round(w0 * p))
    h = Math.max(1, Math.round(h0 * p))
  } else if (options.width !== undefined || options.height !== undefined) {
    // Give the other dimension a sane value rather than refusing: a caller who
    // asks for a width usually wants the aspect kept.
    if (options.width !== undefined && options.height !== undefined) {
      w = Math.max(1, Math.round(options.width))
      h = Math.max(1, Math.round(options.height))
    } else if (options.width !== undefined) {
      w = Math.max(1, Math.round(options.width))
      h = Math.max(1, Math.round((options.width / w0) * h0))
    } else {
      h = Math.max(1, Math.round(options.height!))
      w = Math.max(1, Math.round((options.height! / h0) * w0))
    }
  }

  if (w === w0 && h === h0) {
    return { width: w, height: h, data: new Uint8ClampedArray(raster.data) }
  }

  const out = allocateRaster(w, h)
  const sx = w0 / w
  const sy = h0 / h
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = sampleBilinear(raster, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5)
      const dst = (y * w + x) * 4
      out.data[dst] = r
      out.data[dst + 1] = g
      out.data[dst + 2] = b
      out.data[dst + 3] = a
    }
  }
  return out
}

/**
 * Brightness, contrast, saturation and opacity.
 *
 * Applied per pixel in that order, because the order changes the result and there
 * is only one defensible choice: contrast about mid grey after a brightness lift
 * keeps a lifted image from washing out, whereas doing it first would blow the
 * highlights and the brightness lift would then have nothing left to work with.
 *
 * Contrast is pivoted on 127.5 rather than 128 so that a no-op is exactly a no-op:
 * 255 maps to 255 and 0 maps to 0, which is what makes this safe to apply twice.
 */
export function adjustRaster(raster: Raster, options: AdjustOptions): Raster {
  const brightness = Math.max(-100, Math.min(100, options.brightness ?? 0)) * 2.55
  const contrast = Math.max(-100, Math.min(100, options.contrast ?? 0)) / 100
  const saturation = Math.max(-100, Math.min(100, options.saturation ?? 0)) / 100
  const opacity = Math.max(0, Math.min(1, options.opacity ?? 1))

  if (brightness === 0 && contrast === 0 && saturation === 0 && opacity === 1) {
    return { width: raster.width, height: raster.height, data: new Uint8ClampedArray(raster.data) }
  }

  // Contrast becomes a multiplier and offset: (v - 127.5) * k + 127.5.
  const k = contrast >= 0 ? 1 / Math.max(1e-6, 1 - contrast) : 1 + contrast
  const out = allocateRaster(raster.width, raster.height)

  for (let i = 0; i < raster.width * raster.height; i++) {
    const o = i * 4
    let r = raster.data[o]!
    let g = raster.data[o + 1]!
    let b = raster.data[o + 2]!
    let a = raster.data[o + 3]!

    if (brightness !== 0) { r += brightness; g += brightness; b += brightness }
    if (contrast !== 0) {
      r = (r - 127.5) * k + 127.5
      g = (g - 127.5) * k + 127.5
      b = (b - 127.5) * k + 127.5
    }
    if (saturation !== 0) {
      // Rec. 601 luma, which is what the eye weights and therefore what
      // "desaturate" should pull towards. A flat mean would shift hues towards
      // cyan and look wrong on skin.
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      r = luma + (r - luma) * (1 + saturation)
      g = luma + (g - luma) * (1 + saturation)
      b = luma + (b - luma) * (1 + saturation)
    }

    out.data[o] = r
    out.data[o + 1] = g
    out.data[o + 2] = b
    out.data[o + 3] = opacity === 1 ? a : a * opacity
  }
  return out
}

/** A coarse colour histogram, for telling a caller what a picture is made of. */
export function colorHistogram(raster: Raster, bins = 8): { bins: number; counts: number[] } {
  const n = Math.max(2, Math.min(64, Math.round(bins)))
  const counts = new Array(n * n * n).fill(0)
  for (let i = 0; i < raster.width * raster.height; i++) {
    const o = i * 4
    if (raster.data[o + 3]! < 8) continue
    const r = Math.min(n - 1, Math.floor((raster.data[o]! / 256) * n))
    const g = Math.min(n - 1, Math.floor((raster.data[o + 1]! / 256) * n))
    const b = Math.min(n - 1, Math.floor((raster.data[o + 2]! / 256) * n))
    counts[(r * n + g) * n + b]!++
  }
  return { bins: n, counts }
}
