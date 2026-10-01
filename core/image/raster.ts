/**
 * The shared vocabulary of an image, in a module that imports nothing.
 *
 * This exists to break an import cycle. `image.ts` dispatches to the PNG and JPEG
 * decoders, and both of those need the `Raster` shape, the size limit and an
 * allocation helper - so they reached back into `image.ts` for them, which made
 * the codec and its dispatcher mutually dependent. That resolves today only
 * because the decoders reach for these at call time rather than load time, so the
 * half-initialised module happens to be complete by then. It is a trap for
 * anyone who later adds an import that runs at module scope.
 *
 * Keeping the shared types and helpers here makes both directions point one way:
 * `image.ts` imports the codecs, the codecs import this, and nothing imports back.
 */

/**
 * A decoded image: straight 8-bit RGBA, row-major, no premultiplication.
 *
 * Every codec in this folder converts to exactly this, so the editing code never
 * needs to know which format a photo arrived in. The editing ops all want
 * per-pixel access, and a single representation is what makes that possible
 * without a conversion at every step.
 */
export interface Raster {
  width: number
  height: number
  /** `width * height * 4` bytes: red, green, blue, alpha. */
  data: Uint8ClampedArray
}

/** Longest edge we will decode. A cutout has to hold the mask and the pixels. */
export const MAX_EDGE = 20000

/** An image we cannot read, or that is not a supported format. */
export class ImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageError'
  }
}

/** Allocates a zeroed RGBA raster. Throws rather than overrunning the limit. */
export function allocateRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}
