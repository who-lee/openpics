/**
 * Geometry for painting on a picture, kept apart from React and from the bridge
 * so the arithmetic can be reasoned about — and tested — on its own.
 */

export interface StrokePoint {
  x: number
  y: number
}

/**
 * Where a pointer sits on the picture, in the picture's own pixels.
 *
 * `rect` is the rendered box of the picture element. Working from that box rather
 * than from the fit-and-zoom arithmetic keeps this correct through every way the
 * picture can be shown: panned, zoomed, or swapped for a downscaled preview.
 * A preview keeps the original's proportions, so the fraction across the box is
 * the fraction across the picture either way.
 *
 * `null` means off the picture. That is deliberate: the area around a letterboxed
 * picture is part of the stage and is clickable, and painting there would put a
 * stroke somewhere the user did not ask for.
 */
export function picturePointAt(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  width: number,
  height: number
): StrokePoint | null {
  if (rect.width === 0 || rect.height === 0) return null
  const x = ((clientX - rect.left) / rect.width) * width
  const y = ((clientY - rect.top) / rect.height) * height
  if (x < 0 || y < 0 || x > width || y > height) return null
  return { x, y }
}