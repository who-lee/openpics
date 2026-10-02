import { allocateRaster, type Raster } from '../image/image'
import { adjustRaster } from './transform'
import {
  MAX_FADE_LIFT,
  MAX_TEMPERATURE_GAIN,
  MAX_TEMPERATURE_GREEN_GAIN,
  VIGNETTE_END,
  VIGNETTE_START,
  isEmptyAdjustments,
  resolveFilter,
  sepiaMatrix,
  type FilterAdjustments,
  type FilterSettings
} from '../../shared/filters'

/**
 * Filters for pictures, on the CPU.
 *
 * This is the picture half of `shared/filters.ts`. The recipes are read from
 * there, not written here, so a preset added to the catalogue shows up in the
 * editor panel, in the agent's tools and in a video filter without anyone
 * remembering to come back to this file.
 *
 * What is deliberately *not* shared with the video half is the arithmetic.
 * ffmpeg's `eq` and this loop both claim to be "contrast about mid grey" and
 * neither is wrong, but ffmpeg computes it in YUV against a slightly different
 * pivot and rounds differently at 8 bits. Chasing bit-identical output between
 * them would mean reimplementing ffmpeg's colour pipeline in JavaScript. So the
 * guarantee made to a user is the weaker and honest one: the same recipe, in the
 * same order, aimed at the same look.
 *
 * Order follows `FILTER_ORDER` and the reasoning for it lives there. Nothing in
 * this file reorders anything, and nothing mutates the raster it is given - a
 * caller applying a filter keeps the ability to render the unfiltered picture
 * from the same session, which is what makes the filter undoable.
 */

/** Rec. 601 luma, matching `adjustRaster`, so desaturating lands on the same grey. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** `v' = 255 * (v/255) ^ gamma`. Below 1 lifts midtones, above 1 pushes them down. */
function gammaCurve(raster: Raster, gamma: number): Raster {
  const out = allocateRaster(raster.width, raster.height)
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v++) lut[v] = Math.pow(v / 255, gamma) * 255

  for (let i = 0; i < raster.width * raster.height; i++) {
    const o = i * 4
    out.data[o] = lut[raster.data[o]!]!
    out.data[o + 1] = lut[raster.data[o + 1]!]!
    out.data[o + 2] = lut[raster.data[o + 2]!]!
    out.data[o + 3] = raster.data[o + 3]!
  }
  return out
}

/**
 * Warms or cools by scaling the red and blue planes apart and green slightly with
 * them.
 *
 * Green moves at a fifth of the rate, because pushing it with the others is what
 * turns a warm cast into a yellow cast - and yellow reads as a fault rather than
 * as evening. 30% of the gap at full strength: enough to notice on skin, not
 * enough to make a blue sky look like a mistake.
 */
function shiftTemperature(raster: Raster, amount: number): Raster {
  const t = amount / 100
  const rGain = 1 + t * MAX_TEMPERATURE_GAIN
  const bGain = 1 - t * MAX_TEMPERATURE_GAIN
  const gGain = 1 + t * MAX_TEMPERATURE_GREEN_GAIN
  const out = allocateRaster(raster.width, raster.height)

  for (let i = 0; i < raster.width * raster.height; i++) {
    const o = i * 4
    out.data[o] = raster.data[o]! * rGain
    out.data[o + 1] = raster.data[o + 1]! * gGain
    out.data[o + 2] = raster.data[o + 2]! * bGain
    out.data[o + 3] = raster.data[o + 3]!
  }
  return out
}

function applySepia(raster: Raster, amount: number): Raster {
  const c = sepiaMatrix(amount)
  const out = allocateRaster(raster.width, raster.height)

  for (let i = 0; i < raster.width * raster.height; i++) {
    const o = i * 4
    const r = raster.data[o]!
    const g = raster.data[o + 1]!
    const b = raster.data[o + 2]!
    out.data[o] = r * c[0]! + g * c[1]! + b * c[2]!
    out.data[o + 1] = r * c[3]! + g * c[4]! + b * c[5]!
    out.data[o + 2] = r * c[6]! + g * c[7]! + b * c[8]!
    out.data[o + 3] = raster.data[o + 3]!
  }
  return out
}

/**
 * Lifts blacks towards flat grey without touching white.
 *
 * The `(1 - v/255)` term is what makes this a *lift* rather than a wash: white
 * stays white, so the picture loses contrast in the shadows only. Adding a flat
 * amount to every channel instead would push white off the end of the range and
 * clip it, which is a different filter and a much uglier one.
 */
function applyFade(raster: Raster, amount: number): Raster {
  const lift = (Math.max(0, Math.min(100, amount)) / 100) * MAX_FADE_LIFT
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v++) lut[v] = v + (1 - v / 255) * lift
  const out = allocateRaster(raster.width, raster.height)

  for (let i = 0; i < raster.width * raster.height; i++) {
    const o = i * 4
    out.data[o] = lut[raster.data[o]!]!
    out.data[o + 1] = lut[raster.data[o + 1]!]!
    out.data[o + 2] = lut[raster.data[o + 2]!]!
    out.data[o + 3] = raster.data[o + 3]!
  }
  return out
}

/**
 * Darkens towards the corners.
 *
 * The falloff is squared rather than linear so the corners fall away sharply
 * while the middle stays clean - a linear ramp reads as a grey haze over the
 * whole frame, which is not what anyone means by a vignette. Fully transparent
 * pixels are skipped: darkening the colour of a pixel nobody can see only wastes
 * time, and a vignette must never put colour back into a cutout's corners.
 */
function applyVignette(raster: Raster, amount: number): Raster {
  const v = Math.max(0, Math.min(100, amount)) / 100
  const out = allocateRaster(raster.width, raster.height)
  const span = VIGNETTE_END - VIGNETTE_START

  for (let y = 0; y < raster.height; y++) {
    const ny = ((y + 0.5) / raster.height) * 2 - 1
    for (let x = 0; x < raster.width; x++) {
      const i = y * raster.width + x
      const o = i * 4
      const a = raster.data[o + 3]!
      out.data[o + 3] = a
      if (v === 0 || a === 0) {
        out.data[o] = raster.data[o]!
        out.data[o + 1] = raster.data[o + 1]!
        out.data[o + 2] = raster.data[o + 2]!
        continue
      }
      const nx = ((x + 0.5) / raster.width) * 2 - 1
      const t = clamp01((Math.sqrt(nx * nx + ny * ny) - VIGNETTE_START) / span)
      const f = 1 - v * t * t
      out.data[o] = raster.data[o]! * f
      out.data[o + 1] = raster.data[o + 1]! * f
      out.data[o + 2] = raster.data[o + 2]! * f
    }
  }
  return out
}

/**
 * Applies concrete adjustments, in the catalogue's order.
 *
 * Exported for the tests and for any caller that has already resolved a recipe.
 * The tone pass is delegated to `adjustRaster` rather than reimplemented: it is
 * the same maths the brightness and contrast sliders already use, and a filter
 * that looked slightly different from the slider doing the same thing would be
 * inexplicable to anyone comparing them.
 */
export function applyAdjustments(raster: Raster, adjustments: FilterAdjustments): Raster {
  let out = raster

  if (adjustments.gamma !== undefined && adjustments.gamma !== 1) {
    out = gammaCurve(out, Math.max(0.2, Math.min(3, adjustments.gamma)))
  }

  const brightness = adjustments.brightness ?? 0
  const contrast = adjustments.contrast ?? 0
  const saturation = adjustments.saturation ?? 0
  if (brightness !== 0 || contrast !== 0 || saturation !== 0) {
    out = adjustRaster(out, { brightness, contrast, saturation })
  }

  if (adjustments.temperature) out = shiftTemperature(out, adjustments.temperature)
  if (adjustments.sepia) out = applySepia(out, adjustments.sepia)
  if (adjustments.fade) out = applyFade(out, adjustments.fade)
  if (adjustments.vignette) out = applyVignette(out, adjustments.vignette)

  return out
}

/**
 * Applies a named filter to a picture, returning a new raster.
 *
 * An empty adjustment set copies rather than returns the same raster. The session
 * holds the composite it would otherwise be aliased to, and a caller applying
 * filters to several renders in sequence would find all of them changing at once
 * - a bug that only shows up when two operations are combined, and then as an
 * inexplicable picture.
 */
export function filterRaster(raster: Raster, settings: FilterSettings | null | undefined): Raster {
  const adjustments = resolveFilter(settings)
  if (isEmptyAdjustments(adjustments)) {
    return { width: raster.width, height: raster.height, data: new Uint8ClampedArray(raster.data) }
  }
  return applyAdjustments(raster, adjustments)
}