import { allocateRaster, type Raster } from '../image/image'
import { createMask, featherMask, maskStats, type Mask, type MaskStats } from './mask'
import { selectRegion, type WandOptions, type WandResult } from './wand'

/**
 * An edit in progress: the original pixels plus how much of each one survives.
 *
 * Nothing here mutates the original. Every operation writes to the mask and the
 * pixels are only combined at the end, which is what makes undo a matter of
 * forgetting the last mask rather than of reconstructing pixels that were
 * already destroyed. It is also why restore can be exact: restoring asks the
 * original what a pixel looked like instead of asking memory.
 */
export interface EditSession {
  width: number
  height: number
  /** The decoded original. Read-only for the lifetime of the session. */
  source: Raster
  mask: Mask
}

/** Which side of a wand selection is the thing worth keeping. */
export type KeepSide = 'region' | 'rest'

/**
 * Ceiling on how large an image we will hold a session for.
 *
 * The raster is four bytes per pixel and the mask is another one, so a session
 * costs about five. That is 240MB at 12 megapixels, which is already at the edge
 * of what a photo viewer should be asking for; past 40 megapixels the allocation
 * is more likely to fail than to succeed, and a failed allocation takes the whole
 * window with it. Refusing with a specific number is more useful than dying.
 */
export const MAX_PIXELS = 40_000_000

export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

export function createSession(source: Raster): EditSession {
  if (source.width <= 0 || source.height <= 0) {
    throw new EditError('the image is empty')
  }
  const pixels = source.width * source.height
  if (pixels > MAX_PIXELS) {
    throw new EditError(
      `the image is ${pixels.toLocaleString('en-US')} pixels, above the ${MAX_PIXELS.toLocaleString('en-US')} this editor holds at once`
    )
  }
  return { width: source.width, height: source.height, source, mask: createMask(source.width, source.height) }
}

export function resetSession(session: EditSession): void {
  session.mask = createMask(session.width, session.height)
}

/**
 * Turns a wand selection into a keep-strength mask.
 *
 * The mask always ends up meaning the same thing - 255 keeps the original pixel,
 * 0 discards it - whichever side the caller asked to keep, so a later brush
 * stroke does not need to know how the selection was made.
 */
export function applySelection(
  session: EditSession,
  selection: WandResult['selection'],
  keep: KeepSide
): MaskStats {
  const { width, height } = session
  if (selection.length !== width * height) {
    throw new EditError(`selection is ${selection.length} pixels, expected ${width * height}`)
  }
  // Start fully removed and write back what survives. Starting opaque and
  // subtracting would leave every pixel the loop skipped at full strength, and
  // the pixels the loop does not touch are exactly the ones the wand rejected.
  const mask = createMask(width, height, 0)
  const keepRegion = keep === 'region'
  for (let i = 0; i < selection.length; i++) {
    const inside = selection[i] === 1
    if (inside === keepRegion) mask.values[i] = 255
  }
  session.mask = mask
  return maskStats(mask)
}

export function cutoutWithWand(session: EditSession, options: WandOptions): { wand: WandResult; stats: MaskStats } {
  const wand = selectRegion(session.source, options)
  const stats = applySelection(session, wand.selection, 'rest')
  return { wand, stats }
}

/** Erases everything the wand did not select - the auto cutout, in one call. */
export function cutoutFromBorder(session: EditSession, tolerance?: number): { wand: WandResult; stats: MaskStats } {
  return cutoutWithWand(session, { from: 'border', tolerance })
}

/**
 * Combines the original and the mask into a finished image.
 *
 * Only alpha moves. The surviving pixels keep their exact colour, which is the
 * right call for straight RGBA: darkening RGB to match a shrinking alpha is
 * only correct if every consumer treats the data as premultiplied, and plenty
 * do not. Getting that wrong shows up as a dark halo around every soft edge.
 */
export function composite(session: EditSession, featherRadius = 0): Raster {
  const mask = featherRadius > 0 ? featherMask(session.mask, featherRadius) : session.mask
  const { width, height, source } = session
  const out = allocateRaster(width, height)
  const count = width * height

  for (let i = 0; i < count; i++) {
    const o = i * 4
    const m = mask.values[i]!
    out.data[o] = source.data[o]!
    out.data[o + 1] = source.data[o + 1]!
    out.data[o + 2] = source.data[o + 2]!
    out.data[o + 3] = m === 255 ? source.data[o + 3]! : Math.round((source.data[o + 3]! * m) / 255)
  }
  return out
}

export interface SessionInfo extends MaskStats {
  /** Alpha is 255 everywhere, so the cutout is a change in coverage alone. */
  opaqueSource: boolean
  hasEdits: boolean
}

export function inspectSession(session: EditSession): SessionInfo {
  const stats = maskStats(session.mask)
  let transparent = 0
  for (let i = 0; i < stats.pixels; i++) {
    if (session.source.data[i * 4 + 3]! < 255) transparent++
  }
  return {
    ...stats,
    opaqueSource: transparent === 0,
    hasEdits: stats.removed > 0 || stats.softened > 0
  }
}