import { allocateRaster, type Raster } from '../image/image'

/**
 * Making a finished edit small enough to look at.
 *
 * The reason this exists rather than reusing the Electron thumbnail path is that
 * the MCP server has no browser to hand the pixels to. It also cannot use the
 * shortcut the browser gets: `drawImage` already does the right thing, and here
 * the arithmetic has to be done by hand.
 */

/** Longest edge of a preview, chosen to stay legible when scaled up to a screen. */
export const DEFAULT_PREVIEW_EDGE = 1600

/**
 * Area-weighted box downscale that survives an alpha channel.
 *
 * Naive averaging of straight RGBA is wrong at every transparent edge, and wrong
 * in the one way that is immediately visible: a fully transparent pixel still
 * carries RGB bytes, `composite` leaves those bytes at the original colour, and
 * averaging them against opaque neighbours drags the edge towards black. The
 * result is a dark fringe that appears in the preview and not in the exported
 * file, which would make the preview worse than useless.
 *
 * So this averages premultiplied values, where a transparent pixel contributes
 * nothing to colour but still contributes to coverage, and divides the colour back
 * out afterwards. Coverage is what the eye reads as an edge, and coverage is
 * preserved exactly.
 *
 * The weights are exact overlaps between the output pixel's footprint and each
 * source pixel, not nearest-neighbour, because a box that snaps to a single
 * source pixel turns a hard alpha edge into a ragged one at preview scale.
 */
export function downscale(raster: Raster, maxEdge: number): Raster {
  const { width, height } = raster
  const longest = Math.max(width, height)
  if (!(maxEdge > 0)) throw new RangeError(`maxEdge must be positive, got ${maxEdge}`)
  if (longest <= maxEdge) return raster

  const scale = maxEdge / longest
  const outWidth = Math.max(1, Math.round(width * scale))
  const outHeight = Math.max(1, Math.round(height * scale))
  const sx = width / outWidth
  const sy = height / outHeight
  const out = allocateRaster(outWidth, outHeight)
  const src = raster.data

  // Row spans are the same for every pixel in a row, so the y weights are worked
  // out once per output row rather than once per output pixel.
  const spans: Array<Array<{ index: number; weight: number }>> = []

  for (let oy = 0; oy < outHeight; oy++) {
    const y0 = oy * sy
    const y1 = y0 + sy
    const row: Array<{ index: number; weight: number }> = []
    const firstY = Math.floor(y0)
    const lastY = Math.min(height, Math.ceil(y1))
    for (let sy2 = firstY; sy2 < lastY; sy2++) {
      const weight = Math.min(y1, sy2 + 1) - Math.max(y0, sy2)
      if (weight > 0) row.push({ index: sy2, weight })
    }
    spans.push(row)
  }

  for (let oy = 0; oy < outHeight; oy++) {
    const rowSpans = spans[oy]!
    for (let ox = 0; ox < outWidth; ox++) {
      const x0 = ox * sx
      const x1 = x0 + sx
      const firstX = Math.floor(x0)
      const lastX = Math.min(width, Math.ceil(x1))

      let weightSum = 0
      let alphaSum = 0
      let red = 0
      let green = 0
      let blue = 0

      for (const ySpan of rowSpans) {
        const rowStart = ySpan.index * width
        const wy = ySpan.weight
        for (let sxIndex = firstX; sxIndex < lastX; sxIndex++) {
          const weight = wy * (Math.min(x1, sxIndex + 1) - Math.max(x0, sxIndex))
          if (!(weight > 0)) continue
          const o = (rowStart + sxIndex) * 4
          const a = src[o + 3]! / 255
          weightSum += weight
          alphaSum += a * weight
          red += src[o]! * a * weight
          green += src[o + 1]! * a * weight
          blue += src[o + 2]! * a * weight
        }
      }

      const o = (oy * outWidth + ox) * 4
      if (alphaSum > 0) {
        // Dividing the weighted colour by the weighted alpha undoes the
        // premultiply; where coverage was partial this recovers the original
        // colour rather than a darkened one.
        out.data[o] = Math.round(red / alphaSum)
        out.data[o + 1] = Math.round(green / alphaSum)
        out.data[o + 2] = Math.round(blue / alphaSum)
        out.data[o + 3] = Math.round((alphaSum / weightSum) * 255)
      }
      // Fully transparent stays zeroed, which is the one case where un-premultiplying
      // would divide by nothing.
    }
  }

  return out
}

/** Scales an edit down to something safe to hand to a model or a window. */
export function previewRaster(raster: Raster, maxEdge = DEFAULT_PREVIEW_EDGE): Raster {
  return downscale(raster, maxEdge)
}