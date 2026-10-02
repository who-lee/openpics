import type {
  ApplyOptions,
  BrushOptions,
  BrushReply,
  CutoutOptions,
  CutoutReply,
  EditApplied,
  EditInfo,
  EditPreview,
  HistoryReply,
  HistoryState,
  OutputSettings,
  PreviewOptions,
  RefineOperation,
  SelectionCommand
} from '../shared/edit'
import { NO_FILTER, findFilter } from '../shared/filters'
import { encodePng } from '../core/image/png'
import { EditError } from '../core/edit/session'
import {
  checkpoint,
  cutoutFromBorder,
  hasOutputSettings,
  inspectSession,
  maskFromSelection,
  render,
  replaceMask,
  resetSession,
  type EditSession
} from '../core/edit/session'
import {
  despeckleMask,
  fillMaskHoles,
  growMask,
  invertMask,
  keepLargestRegion,
  shrinkMask,
  thresholdAlpha
} from '../core/edit/maskops'
import { selectEllipse, selectPolygon, selectRect } from '../core/edit/select'
import { selectRegion } from '../core/edit/wand'
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

/** True when the session carries output geometry or colour that a save would apply. */
function hasOutput(session: EditSession): boolean {
  return hasOutputSettings(session)
}

function pointIn(session: EditSession, x: unknown, y: unknown, what: string): { x: number; y: number } {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new EditError(`${what} must be a finite point, got x=${String(x)} y=${String(y)}`)
  }
  return { x, y }
}

/**
 * A box the caller can rely on being inside the picture.
 *
 * Checked here rather than left to the selection code because a rectangle from a
 * drag can easily start outside the picture - that is how a drag past the edge of
 * the canvas behaves - and clipping is the correct answer to that, while a
 * negative or non-finite size is a mistake worth refusing.
 */
function boxIn(session: EditSession, raw: Record<string, unknown>): { x: number; y: number; width: number; height: number } {
  const { x, y } = pointIn(session, raw.x, raw.y, 'a selection box')
  const width = raw.width
  const height = raw.height
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new EditError(`a selection box needs a finite width and height, got ${String(width)}x${String(height)}`)
  }
  if (width <= 0 || height <= 0) {
    throw new EditError(`a selection box must have a positive size, got ${width}x${height}`)
  }
  const left = Math.max(0, Math.min(session.width, x))
  const top = Math.max(0, Math.min(session.height, y))
  const right = Math.max(0, Math.min(session.width, x + width))
  const bottom = Math.max(0, Math.min(session.height, y + height))
  if (right - left < 1 || bottom - top < 1) {
    throw new EditError('a selection box that falls entirely outside the picture keeps nothing')
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Radii arrive from sliders and from typed numbers, so both are checked. */
function radiusIn(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new EditError(`radius must be a number of pixels of zero or more, got ${String(raw)}`)
  }
  return Math.min(Math.round(raw), 4096)
}

function levelIn(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new EditError(`level must be a finite number, got ${String(raw)}`)
  }
  return Math.max(0, Math.min(255, Math.round(raw)))
}

function keepIn(raw: unknown): 'region' | 'rest' {
  if (raw === 'region' || raw === 'rest') return raw
  throw new EditError(`keep must be 'region' or 'rest', got ${String(raw)}`)
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
      ? { preview: toPreview(render(handle.session), PREVIEW_EDGE) }
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
  const session = handle.session
  // Checkpointed before painting, not after: the whole stroke is one undo step,
  // which is what "undo the stroke" means. Checkpointing per dab would make a drag
  // of thirty points take thirty undos to reverse.
  //
  // This was missing here while the agent-facing brush had it, so a stroke made in
  // the panel could not be undone at all - undo reported the wrong picture rather
  // than failing, which is the version of this bug that survives being used.
  const recorded = checkpoint(session, options.mode === 'erase' ? 'erase brush' : 'restore brush')
  let painted = 0
  for (const point of options.points) {
    painted += paintBrush(session.mask, {
      x: point.x,
      y: point.y,
      radius: options.radius,
      mode: options.mode,
      hardness: options.hardness
    })
  }
  if (recorded && painted === 0) {
    // A stroke that moved nothing pushed a step onto an unchanged mask. Taking it
    // back keeps the history an account of real changes, so the next undo reaches
    // the step the user actually wants to reverse.
    session.history?.undo(session)
  }
  const info = describe(handle)
  const reply: BrushReply = {
    ...info,
    ...(painted > 0 ? { preview: toPreview(render(handle.session), PREVIEW_EDGE) } : {}),
    ...(painted === 0
      ? { note: 'Nothing changed. The brush only moves pixels that are not already at the end you asked for.' }
      : {})
  }
  return reply
}

/**
 * One selection instruction, applied as a single undoable step.
 *
 * The `checkpoint` happens before anything is written, so a wand click and the
 * refinement that follows it are two steps rather than one clump, and a mistaken
 * tolerance is undone without losing the click that set it.
 */
export function handleSelection(edit: string, command: SelectionCommand) {
  const handle = edits.require(edit)
  const session = handle.session
  if (!command || typeof command.kind !== 'string') {
    throw new EditError(`a selection needs a kind, got ${String(command && (command as { kind: unknown }).kind)}`)
  }

  switch (command.kind) {
    case 'wand': {
      const { x, y } = pointIn(session, command.x, command.y, 'a wand point')
      const tolerance = command.tolerance ?? 48
      if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 765) {
        throw new EditError(`tolerance must be between 0 and 765, got ${tolerance}`)
      }
      const wand = selectRegion(session.source, {
        from: 'point',
        x,
        y,
        tolerance,
        contiguous: command.contiguous ?? true
      })
      const stats = replaceMask(
        session,
        maskFromSelection(session.width, session.height, wand.selection, keepIn(command.keep)),
        'wand selection'
      )
      return reply(handle, stats.kept > 0)
    }
    case 'rect':
    case 'ellipse': {
      const box = boxIn(session, command as unknown as Record<string, unknown>)
      const result = command.kind === 'rect' ? selectRect(session.source, box) : selectEllipse(session.source, box)
      const stats = replaceMask(
        session,
        maskFromSelection(session.width, session.height, result.selection, keepIn(command.keep)),
        `${command.kind} selection`
      )
      return reply(handle, stats.kept > 0)
    }
    case 'polygon': {
      if (!Array.isArray(command.points)) {
        throw new EditError(`a polygon needs an array of points, got ${String(command.points)}`)
      }
      if (command.points.length < 3) {
        throw new EditError(`a polygon needs at least 3 points, got ${command.points.length}`)
      }
      if (command.points.length > 512) {
        throw new EditError(`a polygon can have at most 512 points, got ${command.points.length}`)
      }
      const points = command.points.map((p) => pointIn(session, p?.x, p?.y, 'a polygon point'))
      const result = selectPolygon(session.source, points)
      const stats = replaceMask(
        session,
        maskFromSelection(session.width, session.height, result.selection, keepIn(command.keep)),
        'polygon selection'
      )
      return reply(handle, stats.kept > 0)
    }
    case 'all': {
      if (command.state !== 'kept' && command.state !== 'removed') {
        throw new EditError(`state must be 'kept' or 'removed', got ${String(command.state)}`)
      }
      const value = command.state === 'removed' ? 0 : 255
      // Checkpointed by hand rather than through `replaceMask`, because this writes
      // into the existing mask in place: replacing it with a copy would be the same
      // pixels for twice the memory and one more allocation.
      session.history?.checkpoint(session, command.state === 'removed' ? 'remove the whole picture' : 'keep the whole picture')
      session.mask.values.fill(value)
      return reply(handle, true)
    }
    case 'invert': {
      replaceMask(session, invertMask(session.mask), 'invert the selection')
      return reply(handle, true)
    }
    case 'refine':
      return refine(handle, command.operation, command.radius, command.level)
    default:
      throw new EditError(`unknown selection kind '${String((command as { kind: string }).kind)}'`)
  }
}

/**
 * The edge fixes, each one undoable and each one reporting whether it moved anything.
 *
 * Grow and shrink take a radius because "grow it a bit" is the whole request, while
 * despeckle and threshold take a level. Both are optional with a sensible default,
 * so the panel can send the slider it happens to have and an agent can send the
 * operation alone.
 */
function refine(handle: EditHandle, operation: RefineOperation, radius?: number, level?: number) {
  const session = handle.session
  switch (operation) {
    case 'grow':
      replaceMask(session, growMask(session.mask, radiusIn(radius, 2)), 'grow the selection')
      break
    case 'shrink':
      replaceMask(session, shrinkMask(session.mask, radiusIn(radius, 2)), 'shrink the selection')
      break
    case 'despeckle':
      replaceMask(session, despeckleMask(session.mask, radiusIn(radius, 1)), 'despeckle the selection')
      break
    case 'fill_holes':
      replaceMask(session, fillMaskHoles(session.mask).mask, 'fill holes in the selection')
      break
    case 'keep_largest':
      replaceMask(session, keepLargestRegion(session.mask).mask, 'keep the largest region')
      break
    case 'threshold': {
      // The alpha channel is lifted into its own array first. Kept here rather than
      // changed in the core because the raster's bytes are declared `Uint8Clamped`,
      // which is the right type for a decoded picture's colour and the wrong one for
      // a buffer of 0-255 numbers that something else will iterate.
      const alpha = new Uint8Array(session.width * session.height)
      for (let i = 0; i < alpha.length; i++) alpha[i] = session.source.data[i * 4 + 3]!
      replaceMask(session, thresholdAlpha(session.mask, alpha, levelIn(level, 128)).mask, 'alpha threshold')
      break
    }
    default:
      throw new EditError(`unknown refine operation '${String(operation)}'`)
  }
  return reply(handle, true)
}

/** Describes the session and attaches a preview only when there is something to show. */
function reply(handle: EditHandle, withPreview: boolean) {
  const info = describe(handle)
  return withPreview ? { ...info, preview: toPreview(render(handle.session), PREVIEW_EDGE) } : info
}

/**
 * Drops keys whose value is undefined, so an object built by spreading and
 * overriding keeps only the settings that are actually set.
 *
 * Not cosmetic. `handleOutput` decides whether a session counts as edited by
 * counting keys, and a panel that sends `{ rotate: 1 }` after clearing a crop would
 * otherwise leave `crop: undefined` behind and make a session that has had everything
 * turned off look edited, which lets a save write out a copy of the source.
 */
function prune<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v
  }
  return out as T
}

/**
 * Output geometry and colour for the finished picture.
 *
 * Replaces the whole settings object rather than merging into it, because the panel
 * holds the full set of sliders and sending it back whole is what makes "set
 * brightness to 40" also mean "the contrast I had set is still 40". Passing null
 * clears everything.
 */
export function handleOutput(edit: string, settings: OutputSettings | null) {
  const handle = edits.require(edit)
  if (settings !== null && (typeof settings !== 'object' || Array.isArray(settings))) {
    throw new EditError(`output must be an object or null, got ${String(settings)}`)
  }
  if (settings) {
    const next: OutputSettings = prune({ ...settings })
    // An explicit crop and a trim cannot both be right: trim means "find the
    // content", and an explicit box means "use this box". Whichever the caller set
    // last is the one they meant, so the other one goes.
    if (next.crop && next.trim) delete next.trim
    if (next.trim && next.crop) delete next.crop
    // The nested objects get the same treatment, for the same reason: `adjust` is
    // counted when deciding whether a save has anything to write.
    if (next.adjust) {
      const adjust = prune(next.adjust)
      next.adjust = Object.keys(adjust).length > 0 ? adjust : undefined
    }
    if (next.resize) {
      const resize = prune(next.resize)
      next.resize = Object.keys(resize).length > 0 ? resize : undefined
    }
    // A filter left as `{ id: 'none' }` is not an edit, and counting it as one
    // would make a session that has had every setting turned off look changed and
    // offer to save a copy identical to the source. Normalising it away here means
    // the panel can be relaxed about what it sends.
    if (next.filter) {
      // Checked before it is stored, not left to `render` below. An id that cannot
      // be resolved would otherwise be written into the session first and only then
      // rejected, which leaves the session holding a filter nothing can render: the
      // throw looks like a bad request, but every later preview and save on that
      // session fails the same way, so one bad id bricks the picture until it is
      // closed. The renderer already guards this, and a session written by a newer
      // build is exactly how an id from the future turns up here.
      if (typeof next.filter.id !== 'string' || !findFilter(next.filter.id)) {
        throw new EditError(
          `unknown filter "${String(next.filter.id)}"; it has to be one of the ids in the filter catalogue`
        )
      }
      const filter = prune({ ...next.filter, amount: next.filter.amount === 100 ? undefined : next.filter.amount })
      next.filter = filter.id === NO_FILTER ? undefined : filter
    }
    handle.session.output = prune(next) as OutputSettings
    if (Object.keys(handle.session.output).length === 0) handle.session.output = undefined
  } else {
    handle.session.output = undefined
  }
  // The projected size comes back because a resize is usually asked for to hit a
  // dimension, and making the panel preview to discover whether it worked is one
  // round trip too many for something this cheap.
  const projected = render(handle.session)
  return { info: describe(handle), projected: { width: projected.width, height: projected.height } }
}

export function handleHistory(edit: string): HistoryState {
  const handle = edits.require(edit)
  const recent = handle.session.history?.recent() ?? { steps: [], canUndo: false, canRedo: false }
  return { canUndo: recent.canUndo, canRedo: recent.canRedo, steps: recent.steps }
}

function step(edit: string, direction: 'undo' | 'redo'): HistoryReply {
  const handle = edits.require(edit)
  // `history` is optional on a session, so this is the one place that has to care.
  // A session with no history reports that there is nothing to do rather than
  // throwing: the panel's buttons are disabled and an agent asking twice deserves to
  // be told it is already at the start, not handed an error.
  const label = direction === 'undo' ? handle.session.history?.undo(handle.session) : handle.session.history?.redo(handle.session)
  const recent = handle.session.history?.recent() ?? { steps: [], canUndo: false, canRedo: false }
  const state = { canUndo: recent.canUndo, canRedo: recent.canRedo, steps: recent.steps }
  return { ...reply(handle, label !== null), ...state, label: label ?? null }
}

export function handleUndo(edit: string): HistoryReply {
  return step(edit, 'undo')
}

export function handleRedo(edit: string): HistoryReply {
  return step(edit, 'redo')
}

export function handlePreview(edit: string, options: PreviewOptions = {}): EditPreview {
  const handle = edits.require(edit)
  // `render`, not `composite`: a preview that skipped the output settings would show
  // the picture uncropped and unrotated while the panel's sliders claimed otherwise,
  // which is worse than having no preview at all.
  return toPreview(render(handle.session, clampFeather(options.feather)), clampEdge(options.maxEdge))
}

export function handleApply(edit: string, options: ApplyOptions = {}): EditApplied {
  const handle = edits.require(edit)
  const info = describe(handle)
  // Output settings count as an edit on their own. They used not to: `hasEdits`
  // reports on the mask, so rotating a picture that had never been cut out was
  // refused as "nothing has been edited yet", which made a crop or a resize
  // impossible to save unless a cutout happened to have been done first.
  if (!info.hasEdits && !hasOutput(handle.session)) {
    throw new EditError('nothing has been edited yet, so there is nothing to save')
  }
  const target = options.path ? resolveOutputPath(handle.path, options.path) : defaultOutputPath(handle.path)
  const saved = savePng(render(handle.session, clampFeather(options.feather)), target, handle.path, {
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