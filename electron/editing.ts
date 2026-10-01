import type {
  ApplyOptions,
  BrushOptions,
  BrushReply,
  CutoutOptions,
  CutoutReply,
  EditApplied,
  EditInfo,
  EditPreview,
  PreviewOptions
} from '../shared/edit'
import { encodePng } from '../core/image/png'
import { EditError } from '../core/edit/session'
import {
  composite,
  cutoutFromBorder,
  inspectSession,
  resetSession
} from '../core/edit/session'
import { paintBrush } from '../core/edit/brush'
import { defaultOutputPath, resolveOutputPath, savePng } from '../core/edit/io'
import { previewRaster } from '../core/edit/preview'
import { EditStore, type EditHandle } from '../core/edit/store'

/**
 * The editor, as the main process sees it.
 *
 * A separate module from `main.ts` so the session lifetime has one owner and the
 * IPC handlers stay thin. Everything here runs in Node, which is the point: the
 * renderer is sandboxed with no filesystem access, so main is the only place an
 * edit can actually happen.
 */

/**
 * Edits cost roughly five bytes a pixel - four for the original, one for the mask -
 * so the budget is expressed in pixels and covers every session at once. Four 12
 * megapixel pictures fit; a browser tab of the same size would not.
 */
const PIXEL_BUDGET = 48_000_000

/**
 * Longest edge of a preview handed to the renderer.
 *
 * A little over a typical stage, so zooming in still has detail, but small enough
 * that a stroke's preview stays cheap to encode and to push across the bridge.
 */
const PREVIEW_EDGE = 1600

const edits = new EditStore({ pixelBudget: PIXEL_BUDGET, maxSessions: 8 })

/** Why a cutout finished without removing anything, in words the user can act on. */
function cutoutHint(removed: number, pixels: number, reference: [number, number, number]): string | undefined {
  if (removed === 0) {
    return `Nothing was removed. The border colour rgb(${reference.join(', ')}) was not found away from the edges, so raise the tolerance or erase the background with the brush.`
  }
  // Removing everything leaves no picture to look at, which is worth saying plainly:
  // it means the subject was judged to be background, not that the tool worked well.
  if (removed === pixels) {
    return 'Everything was removed. Every pixel looked like the border, so lower the tolerance.'
  }
  if (removed > pixels * 0.98) {
    return 'Almost nothing is left. That usually means the tolerance is too high for this picture.'
  }
  return undefined
}

function describe(handle: EditHandle): EditInfo {
  const stats = inspectSession(handle.session)
  return {
    id: handle.id,
    path: handle.path,
    format: handle.format,
    width: handle.session.width,
    height: handle.session.height,
    stats,
    hasEdits: stats.hasEdits
  }
}

/**
 * Encodes a picture as a PNG data URL.
 *
 * A data URL rather than a file path because a preview exists only in memory. The
 * renderer's CSP already allows `data:` in img-src, so this needs no new scheme,
 * no allowlist entry, and no temporary file to clean up when the edit is closed.
 */
function toPreview(raster: Parameters<typeof encodePng>[0], maxEdge: number): EditPreview {
  const scaled = previewRaster(raster, maxEdge)
  const base64 = Buffer.from(encodePng(scaled)).toString('base64')
  return {
    dataUrl: `data:image/png;base64,${base64}`,
    width: scaled.width,
    height: scaled.height
  }
}

function clampFeather(feather: number | undefined): number {
  if (feather === undefined) return 0
  if (!Number.isFinite(feather) || feather < 0) {
    throw new EditError(`feather must be a number of pixels, got ${feather}`)
  }
  return Math.round(feather)
}

function clampEdge(maxEdge: number | undefined): number {
  if (maxEdge === undefined) return PREVIEW_EDGE
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) {
    throw new EditError(`maxEdge must be a positive number, got ${maxEdge}`)
  }
  // Bounded so a caller cannot ask for a full-size encode of a 40 megapixel session
  // and stall the main process, which is the one thread the whole app shares.
  return Math.min(Math.round(maxEdge), 4096)
}

export function handleCutoutAuto(path: string, options: CutoutOptions = {}): CutoutReply {
  const handle = edits.open(path, options.edit)
  const tolerance = options.tolerance ?? 48
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 765) {
    throw new EditError(`tolerance must be between 0 and 765, got ${tolerance}`)
  }
  const { wand, stats } = cutoutFromBorder(handle.session, tolerance)
  const info = describe(handle)
  const pixels = stats.pixels
  const reply: CutoutReply = {
    info,
    reference: wand.reference,
    ...(stats.removed > 0
      ? { preview: toPreview(composite(handle.session), PREVIEW_EDGE) }
      : {}),
    ...(cutoutHint(stats.removed, pixels, wand.reference)
      ? { note: cutoutHint(stats.removed, pixels, wand.reference)! }
      : {})
  }
  return reply
}

export function handleOpen(path: string, reuseId?: string): EditInfo {
  return describe(edits.open(path, reuseId))
}

export function handleBrush(edit: string, options: BrushOptions): BrushReply {
  const handle = edits.require(edit)
  if (!Array.isArray(options?.points) || options.points.length === 0) {
    throw new EditError('a stroke needs at least one point')
  }
  if (!Number.isFinite(options.radius) || options.radius <= 0) {
    throw new EditError(`radius must be greater than zero, got ${options.radius}`)
  }
  if (options.mode !== 'erase' && options.mode !== 'restore') {
    throw new EditError(`mode must be 'erase' or 'restore', got ${String(options.mode)}`)
  }
  // A stroke is accumulated across its dabs, not replaced, so a drag that pauses
  // does not leave a dotted line. Counted as a whole so the note can say whether
  // anything moved at all.
  let painted = 0
  for (const point of options.points) {
    painted += paintBrush(handle.session.mask, {
      x: point.x,
      y: point.y,
      radius: options.radius,
      mode: options.mode,
      hardness: options.hardness
    })
  }
  const info = describe(handle)
  const reply: BrushReply = {
    ...info,
    ...(painted > 0 ? { preview: toPreview(composite(handle.session), PREVIEW_EDGE) } : {}),
    ...(painted === 0
      ? { note: 'Nothing changed. The brush only moves pixels that are not already at the end you asked for.' }
      : {})
  }
  return reply
}

export function handlePreview(edit: string, options: PreviewOptions = {}): EditPreview {
  const handle = edits.require(edit)
  return toPreview(composite(handle.session, clampFeather(options.feather)), clampEdge(options.maxEdge))
}

export function handleApply(edit: string, options: ApplyOptions = {}): EditApplied {
  const handle = edits.require(edit)
  const info = describe(handle)
  if (!info.hasEdits) {
    throw new EditError('nothing has been edited yet, so there is nothing to save')
  }
  const target = options.path ? resolveOutputPath(handle.path, options.path) : defaultOutputPath(handle.path)
  const saved = savePng(composite(handle.session, clampFeather(options.feather)), target, handle.path, {
    overwrite: options.overwrite === true
  })
  // Saved, but the session stays open. Applying is not a decision to stop editing,
  // and leaving the door open means the user can carry on from what they just saw.
  return { info, path: saved.path, bytes: saved.bytes }
}

export function handleInspect(edit?: string): { info: EditInfo | null; open: EditInfo[] } {
  if (edit) return { info: describe(edits.require(edit)), open: [] }
  // The summary list exists to report *which* ids are open; the detail behind each
  // one has to come from the handle, since the summary deliberately carries no mask.
  return { info: null, open: edits.list().map((summary) => describe(edits.require(summary.id))) }
}

export function handleReset(edit: string): EditInfo {
  const handle = edits.require(edit)
  resetSession(handle.session)
  return describe(handle)
}

export function handleClose(edit: string): boolean {
  return edits.close(edit)
}

/** Called on quit so no raster outlives the process that owns it. */
export function disposeEdits(): void {
  for (const summary of edits.list()) edits.close(summary.id)
}