import type { Raster } from '../image/image'
import { EditError } from './errors'
import type { WandResult } from './wand'

/**
 * Geometric selections: rectangles, polygons and ellipses.
 *
 * The magic wand answers "everything this colour", which is the wrong question
 * for a picture whose background is not one colour - a sky gradient, a shadow
 * across a table, a subject that touches two different backdrops. Geometry is
 * blunt but unconditional, and blunt is the right tool when the alternative
 * silently eats part of the subject.
 *
 * Every function here returns the same `WandResult` shape the wand produces, so
 * the caller feeds all of them into `applySelection` without knowing which was
 * used. That is the point: a selection is a selection, and how it was drawn is
 * not something the rest of the editor should have to care about.
 */

/** A rectangle in image pixels. Half-open on `maxX`/`maxY`, like the mask bounds. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function blankSelection(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height)
}

/**
 * Clips a requested rectangle to the picture and rejects a degenerate one.
 *
 * Clipping rather than failing is deliberate: an agent working from a previous
 * tool's `bounds` will occasionally be one pixel out, and refusing to select
 * anything because of that is a worse answer than selecting the overlap.
 */
function clipRect(rect: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(width, Math.round(rect.x)))
  const y0 = Math.max(0, Math.min(height, Math.round(rect.y)))
  const x1 = Math.max(0, Math.min(width, Math.round(rect.x + rect.width)))
  const y1 = Math.max(0, Math.min(height, Math.round(rect.y + rect.height)))
  if (x1 <= x0 || y1 <= y0) {
    throw new EditError(
      `the rectangle ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)} does not overlap the picture, which is ${width}x${height}`
    )
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** A result shaped so callers cannot tell geometry from the wand. */
function asResult(
  width: number,
  height: number,
  selection: Uint8Array,
  pixels: number,
  from: WandResult['from']
): WandResult {
  return { width, height, selection, reference: [0, 0, 0], pixels, from }
}

/** Fills an inclusive rectangle, the ordinary case. */
export function selectRect(raster: Raster, rect: Rect): WandResult {
  const { width, height } = raster
  const box = clipRect(rect, width, height)
  const selection = blankSelection(width, height)
  for (let y = box.y; y < box.y + box.height; y++) {
    const row = y * width
    selection.fill(1, row + box.x, row + box.x + box.width)
  }
  return asResult(width, height, selection, box.width * box.height, 'border')
}

/**
 * Fills a polygon by the even-odd rule, one scanline at a time.
 *
 * Even-odd rather than a winding rule because it is the one the caller can reason
 * about: a shape with a hole in it works without the point order being meaningful,
 * and a self-intersecting shape is drawn the way it looks instead of cancelling
 * itself out.
 *
 * Vertices are in the same continuous coordinate space as `selectRect`, where an
 * integer `x` with width `w` covers pixels `x` to `x + w - 1`, and they are
 * half-open: the far corner is at `x + w`, not `x + w - 1`. So a rectangle is
 * written with the same two numbers either way -
 * `selectRect(20, 10, 20, 20)` and the polygon `20,10 40,10 40,30 20,30` select
 * exactly the same 400 pixels - and the exclusive `maxX`/`maxY` that `maskStats`
 * reports can be used as polygon corners without adjusting them.
 *
 * That consistency is the whole reason the scanline sits at each row's *centre*,
 * `y + 0.5`, and not at `y`. Testing the edges against the row index itself
 * includes one row too many at the bottom and one column too many at the right,
 * so a 10x10 polygon filled 110 pixels rather than 100, and a polygon built from
 * reported pixel indices quietly lost a column against the rectangle it came from.
 *
 * The last point connects back to the first, so callers pass an open list of
 * corners rather than repeating the first one at the end.
 */
export function selectPolygon(raster: Raster, points: Array<{ x: number; y: number }>): WandResult {
  const { width, height } = raster
  if (points.length < 3) {
    throw new EditError(`a polygon needs at least 3 points, got ${points.length}`)
  }

  const selection = blankSelection(width, height)
  const xs: number[] = []
  const ys: number[] = []
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new EditError('a polygon point is not a number')
    }
    xs.push(p.x)
    ys.push(p.y)
  }

  let pixels = 0
  // The scanline is walked one row at a time, so the loop bounds are the only
  // part that scales with the picture; the crossing test is per span, not per
  // pixel, which keeps a many-pointed polygon cheap.
  const minY = Math.max(0, Math.ceil(Math.min(...ys) - 0.5))
  const maxY = Math.min(height - 1, Math.floor(Math.max(...ys) - 0.5))

  for (let y = minY; y <= maxY; y++) {
    // The horizontal line through the centre of row y. Comparing the vertices
    // against this rather than against `y` is what makes the rule half-open in y:
    // a vertex exactly on a row's centre counts once, not twice (which would
    // cancel the span) and not zero times (which would punch a hole).
    const yc = y + 0.5
    const crossings: number[] = []
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      const yi = ys[i]!
      const yj = ys[j]!
      if (yi > yc !== yj > yc) {
        const t = (yc - yi) / (yj - yi)
        crossings.push(xs[i]! + t * (xs[j]! - xs[i]!))
      }
    }
    if (crossings.length < 2) continue
    crossings.sort((a, b) => a - b)

    const row = y * width
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      // Half-open in x for the same reason: a pixel belongs to the span when its
      // centre lies within it, so the span [left, right) covers columns
      // ceil(left - 0.5) through ceil(right - 0.5) - 1. No pixel can be counted
      // by two spans, and none is missed between them.
      const x0 = Math.max(0, Math.ceil(crossings[k]! - 0.5))
      const x1 = Math.min(width, Math.ceil(crossings[k + 1]! - 0.5))
      if (x1 <= x0) continue
      selection.fill(1, row + x0, row + x1)
      pixels += x1 - x0
    }
  }

  return asResult(width, height, selection, pixels, 'border')
}

/** Fills an axis-aligned ellipse inscribed in the given box. */
export function selectEllipse(raster: Raster, rect: Rect): WandResult {
  const { width, height } = raster
  const box = clipRect(rect, width, height)
  const selection = blankSelection(width, height)
  const rx = box.width / 2
  const ry = box.height / 2
  const cx = box.x + rx
  const cy = box.y + ry

  let pixels = 0
  for (let y = box.y; y < box.y + box.height; y++) {
    const dy = (y + 0.5 - cy) / ry
    const row = y * width
    for (let x = box.x; x < box.x + box.width; x++) {
      const dx = (x + 0.5 - cx) / rx
      if (dx * dx + dy * dy <= 1) {
        selection[row + x] = 1
        pixels++
      }
    }
  }
  return asResult(width, height, selection, pixels, 'border')
}

/**
 * The tight box around everything the mask currently keeps.
 *
 * Returns null when nothing survives, which is the case where a caller asking to
 * crop to the subject needs to be told so rather than handed a zero-sized crop.
 */
export function maskBoundsToRect(mask: { width: number; height: number; values: Uint8Array }): Rect | null {
  let minX = mask.width
  let minY = mask.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width
    for (let x = 0; x < mask.width; x++) {
      if (mask.values[row + x] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
