import type { KeepSide, OutputSettings, Resize } from '../../shared/edit'
import { allocateRaster, type Raster } from '../image/image'
import { EditError } from './errors'
import { EditHistory } from './history'
import { createMask, featherMask, maskStats, type Mask, type MaskStats } from './mask'
import { selectRegion, type WandOptions, type WandResult } from './wand'
import {
  adjustRaster,
  colorHistogram,
  cropRaster,
  flipRaster,
  resizeRaster,
  rotateQuarterTurns,
  type AdjustOptions
} from './transform'

// These three describe the finished picture rather than any raster operation, and
// both the editor panel and the agent tools have to name them, so they are declared
// once in `shared` and re-exported here for the callers that already get them from
// this module.
export type { AdjustOptions, KeepSide, OutputSettings, Resize }


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
  /**
   * Steps taken, so a mistake can be walked back.
   *
   * Optional rather than required so that the object literal stays usable from
   * tests and from any future caller that wants to build a session by hand
   * without paying for history it will never read. Everything that reads it
   * treats absence as "no undo available".
   */
  history?: EditHistory
  /**
   * What to do to the finished picture on the way out.
   *
   * Held on the session rather than passed to `composite` because these are
   * decisions about the output that have to survive across calls: an agent that
   * crops, previews, then applies must get the crop in all three without
   * remembering to repeat the argument. They are applied after the mask, never to
   * it, so the selection tools keep working in source coordinates.
   */
  output?: OutputSettings
}

/**
 * `OutputSettings` and `Resize` are declared in `shared/edit` and re-exported above.
 *
 * Their order of application is fixed and is the order that makes each step mean
 * what it says: crop first so nothing else pays for pixels that are being thrown
 * away, then rotate and flip because those change what "width" and "height" mean,
 * then resize so it works on the smaller picture, then colour, and finally the
 * background flatten, which is only meaningful once everything else has settled.
 */

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

// Defined in `errors.ts` and re-exported here, so existing importers of
// `./session` keep working and nothing has to import the session module to throw.
export { EditError }

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
  return {
    width: source.width,
    height: source.height,
    source,
    mask: createMask(source.width, source.height),
    history: new EditHistory()
  }
}

/**
 * Starts the session over.
 *
 * Clears the history as well as the mask, because a fresh mask makes every earlier
 * step meaningless - keeping them would offer to undo into a state that no longer
 * corresponds to anything the caller has seen. Output settings survive, since a
 * crop asked for once is a statement about the picture rather than about the
 * selection that happens to be reset.
 */
export function resetSession(session: EditSession): void {
  session.mask = createMask(session.width, session.height)
  session.history?.clear()
}

/**
 * Records the current mask before a change, so it can be undone.
 *
 * A thin wrapper over the history object so callers have one place to go, and so
 * the optionality of `history` is resolved here instead of at every call site.
 * Returns whether a step was actually taken, which is false when history is
 * absent or the operation turned out to change nothing.
 */
export function checkpoint(session: EditSession, label: string): boolean {
  return session.history?.checkpoint(session, label) ?? false
}

/** Replaces the mask and records the previous one. The shape of nearly every edit. */
export function replaceMask(session: EditSession, mask: Mask, label: string): MaskStats {
  checkpoint(session, label)
  session.mask = mask
  return maskStats(mask)
}

/** Parses the 6-digit hex background colour, rejecting anything ambiguous. */
export function parseHexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) {
    throw new EditError(`background must be a 6-digit hex colour such as "#ffffff", got "${hex}"`)
  }
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/**
 * The finished picture: mask applied, then the output pipeline.
 *
 * This is the only place an edit becomes pixels, so preview and apply cannot
 * disagree - they both call it. The mask is composited in source coordinates
 * first and geometry is applied to the result, which is why a crop does not
 * invalidate a selection made before it.
 */
export function render(session: EditSession, featherRadius = 0): Raster {
  let raster = composite(session, featherRadius)
  const settings = session.output
  if (!settings) return raster

  if (settings.crop || settings.trim) raster = cropRaster(raster, settings.crop ?? null, settings.trim === true)
  if (settings.rotate) raster = rotateQuarterTurns(raster, settings.rotate)
  if (settings.flip) raster = flipRaster(raster, settings.flip)
  if (settings.resize) raster = resizeRaster(raster, settings.resize)
  if (settings.adjust) raster = adjustRaster(raster, settings.adjust)

  if (settings.background) {
    const [r, g, b] = parseHexColor(settings.background)
    // Straight alpha, so the background is mixed per channel by coverage rather
    // than written under the pixel. Writing under it would leave a dark fringe
    // wherever the mask is soft, which is the exact artefact flatten is meant to
    // remove.
    for (let i = 0; i < raster.width * raster.height; i++) {
      const o = i * 4
      const a = raster.data[o + 3]! / 255
      if (a >= 1) continue
      const inv = 1 - a
      raster.data[o] = raster.data[o]! * a + r * inv
      raster.data[o + 1] = raster.data[o + 1]! * a + g * inv
      raster.data[o + 2] = raster.data[o + 2]! * a + b * inv
      raster.data[o + 3] = 255
    }
  }
  return raster
}

/** Reads the colour of specific pixels, for picking a wand reference by hand. */
export function samplePixels(raster: Raster, points: Array<{ x: number; y: number }>) {
  return points.map((p) => {
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) {
      return { x, y, outside: true as const }
    }
    const o = (y * raster.width + x) * 4
    return {
      x,
      y,
      outside: false as const,
      r: raster.data[o]!,
      g: raster.data[o + 1]!,
      b: raster.data[o + 2]!,
      a: raster.data[o + 3]!,
      hex: `#${[raster.data[o]!, raster.data[o + 1]!, raster.data[o + 2]!]
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('')}`
    }
  })
}

/** What the picture is made of, so a caller can pick a tolerance from evidence. */
export function analyseRaster(raster: Raster, bins = 8) {
  const hist = colorHistogram(raster, bins)
  let opaque = 0
  let transparent = 0
  let partial = 0
  for (let i = 0; i < raster.width * raster.height; i++) {
    const a = raster.data[i * 4 + 3]!
    if (a === 255) opaque++
    else if (a === 0) transparent++
    else partial++
  }
  const total = raster.width * raster.height
  const populated = hist.counts.filter((c) => c > 0).length
  return {
    width: raster.width,
    height: raster.height,
    pixels: total,
    opaque,
    transparent,
    partial,
    /** Distinct occupied histogram cells over the maximum possible. */
    colourSpread: populated / hist.counts.length,
    histogram: hist
  }
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
  session.mask = maskFromSelection(session.width, session.height, selection, keep)
  return maskStats(session.mask)
}

/**
 * Turns a raw 0/1 selection into a keep-strength mask, without touching a session.
 *
 * Split out from `applySelection` because the selection tools want the mask as a
 * value they can check and pass on, so it can be recorded and undone like any other
 * change. Going through a session here would mutate it before the undo step was
 * taken, which would make the first selection after opening a picture impossible
 * to undo.
 */
export function maskFromSelection(
  width: number,
  height: number,
  selection: WandResult['selection'],
  keep: KeepSide
): Mask {
  if (selection.length !== width * height) {
    throw new EditError(`selection is ${selection.length} pixels, expected ${width * height}`)
  }
  // Start fully removed and write back what survives. Starting opaque and
  // subtracting would leave every pixel the loop skipped at full strength, and
  // the pixels the loop does not touch are exactly the ones the wand rejected.
  const mask = createMask(width, height, 0)
  const keepRegion = keep === 'region'
  for (let i = 0; i < selection.length; i++) {
    if ((selection[i] === 1) === keepRegion) mask.values[i] = 255
  }
  return mask
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

/** Whether a session carries at least one output setting. */
export function hasOutputSettings(session: EditSession): boolean {
  return session.output !== undefined && Object.keys(session.output).length > 0
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
    // Output settings count. A session that has only had its picture rotated or
    // cropped has been edited, and saying otherwise is not a rounding detail: the
    // renderer uses this to decide whether there are unsaved changes, so a mask-only
    // test would let a rotated-but-not-cut-out picture be handed to the desktop as
    // the untouched original.
    hasEdits: stats.removed > 0 || stats.softened > 0 || hasOutputSettings(session)
  }
}