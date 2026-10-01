import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditInfo, HistoryState, OutputSettings, SelectionCommand } from '@shared/edit'
import type { WallpaperFit } from '@shared/protocol'
import { bridge } from './bridge'
import type { StrokePoint } from './geometry'

export type { StrokePoint } from './geometry'

export type BrushMode = 'erase' | 'restore'

/** Slider positions rather than source pixels, so the panel is resolution independent. */
export const TOLERANCE_MIN = 0
export const TOLERANCE_MAX = 200
export const TOLERANCE_DEFAULT = 48
export const RADIUS_MIN_PCT = 1
export const RADIUS_MAX_PCT = 40
const RADIUS_DEFAULT_PCT = 6
const HARDNESS_DEFAULT = 0.7

/**
 * How long the panel waits after a slider stops moving before it tells the main
 * process about it.
 *
 * Long enough that dragging a slider is one update rather than sixty, short enough
 * that the preview has caught up by the time the hand leaves the control.
 */
const OUTPUT_SETTLE_MS = 140

/**
 * Folds a change to the output settings into the whole set.
 *
 * `adjust` merges, because brightness and contrast are independent knobs and
 * moving one must not throw away the other. `resize` replaces outright: it has
 * several ways to be set and they contradict each other, so a percent left over
 * from an earlier choice would quietly win over the longest edge just asked for.
 */
function mergeOutput(current: OutputSettings, next: OutputSettings): OutputSettings {
  const merged: OutputSettings = { ...current, ...next }
  if (next.adjust) merged.adjust = { ...current.adjust, ...next.adjust }
  if (next.resize) merged.resize = next.resize
  // A cropped or trimmed picture cannot also be the other one.
  if (merged.crop && merged.trim) delete merged.trim
  if (merged.trim && merged.crop) delete merged.crop
  return merged
}

/** Whether a settings object holds anything worth sending. */
export function hasOutputSettings(settings: OutputSettings): boolean {
  return Object.values(settings).some((v) => v !== undefined)
}

export interface Editor {
  /** Whether a session is held open for the current picture. */
  active: boolean
  busy: string | null
  info: EditInfo | null
  /** A PNG data URL of the edited state, or null to show the original untouched. */
  preview: string | null
  /** Advice from the last operation, such as which knob to turn next. */
  note: string | null
  error: string | null
  tolerance: number
  radiusPct: number
  hardness: number
  mode: BrushMode
  setTolerance: (value: number) => void
  setRadiusPct: (value: number) => void
  setHardness: (value: number) => void
  setMode: (value: BrushMode) => void
  /** How far the last successful operation left things, as a share of the picture. */
  removedPct: number
  begin: () => Promise<void>
  end: () => Promise<void>
  cutout: () => Promise<void>
  stroke: (points: StrokePoint[]) => Promise<void>
  reset: () => Promise<void>
  apply: () => Promise<string | null>
  /** Where the last save went, so the wallpaper can point at it. */
  appliedPath: string | null
  /**
   * False when there are unsaved edits, because those exist only as a preview in
   * this process and Windows cannot use that as a desktop.
   */
  canSetWallpaper: boolean
  setWallpaper: (fit: WallpaperFit) => Promise<void>
  /** Crop, rotate, flip, resize, tone and background, as currently chosen. */
  output: OutputSettings
  /** Replaces the output settings. Cheap to call on every slider frame. */
  setOutput: (next: OutputSettings) => void
  /** Turns every output setting off at once. */
  clearOutput: () => void
  /** The size the picture will be saved at, which a resize may have changed. */
  projected: { width: number; height: number } | null
  /** One selection instruction, applied as a single undoable step. */
  select: (command: SelectionCommand) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  /** What undo and redo currently have to work with. */
  history: HistoryState
}

/**
 * Owns one open edit session for the renderer.
 *
 * The renderer never holds a picture in an editable form: it asks the main process
 * for a session, sends brush strokes in picture coordinates, and shows the PNG data
 * URL that comes back. Everything is in the main process's hands, which is what
 * keeps the sandboxed renderer from being a file editor.
 */
export function useEditor(path: string): Editor {
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [info, setInfo] = useState<EditInfo | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tolerance, setTolerance] = useState(TOLERANCE_DEFAULT)
  const [radiusPct, setRadiusPct] = useState(RADIUS_DEFAULT_PCT)
  const [hardness, setHardness] = useState(HARDNESS_DEFAULT)
  const [mode, setMode] = useState<BrushMode>('erase')
  const [appliedPath, setAppliedPath] = useState<string | null>(null)
  const [output, setOutputState] = useState<OutputSettings>({})
  const [projected, setProjected] = useState<{ width: number; height: number } | null>(null)
  const [history, setHistory] = useState<HistoryState>({ canUndo: false, canRedo: false, steps: [] })

  // The session id is the only thing that has to survive a re-render without
  // causing one, and it is also what tells us a late reply belongs to this
  // picture rather than the one the user has since moved on to.
  const editRef = useRef<string | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  // The settings are mirrored into a ref because the push that follows a slider
  // drag runs on a timer, long after the render that set them.
  const outputRef = useRef<OutputSettings>({})
  outputRef.current = output
  const outputTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Hands a session's memory back to the main process.
   *
   * Without this, stepping through the gallery would leave a decoded copy of every
   * picture behind, held in the main process until its budget evicted them.
   */
  const releaseSession = useCallback((): void => {
    // A slider push that is still waiting must not fire at a session that is on its
    // way out: the reply would either fail on a closed id or, worse, land against
    // the picture the user has just navigated to.
    if (outputTimer.current) {
      clearTimeout(outputTimer.current)
      outputTimer.current = null
    }
    const id = editRef.current
    editRef.current = null
    if (id) void bridge.edit.close(id).catch(() => undefined)
  }, [])

// Moving to another picture while a session is open would silently edit the
// wrong bytes, so the session is released first rather than just forgotten.
useEffect(() => {
    releaseSession()
    setActive(false)
    setInfo(null)
    setPreview(null)
    setNote(null)
    setError(null)
    setAppliedPath(null)
    setOutputState({})
    setProjected(null)
    setHistory({ canUndo: false, canRedo: false, steps: [] })
  }, [path])

  // Closing the viewer is the other way a session is left behind.
  useEffect(() => releaseSession, [])

  /**
   * Runs one main-process call, keeping busy and error state honest.
   *
   * The path is re-checked afterwards: a reply for a picture the user has already
   * navigated away from is dropped rather than shown against the new one.
   */
  const run = useCallback(
    async <T,>(label: string, task: () => Promise<T>): Promise<T | null> => {
      setBusy(label)
      setError(null)
      try {
        const result = await task()
        if (pathRef.current !== path) return null
        return result
      } catch (err) {
        if (pathRef.current === path) {
          setError(err instanceof Error ? err.message : String(err))
        }
        return null
      } finally {
        setBusy((current) => (current === label ? null : current))
      }
    },
    [path]
  )

  const begin = useCallback(async (): Promise<void> => {
    const opened = await run('Opening', () => bridge.edit.open(path))
    if (!opened) return
    editRef.current = opened.id
    setInfo(opened)
    setActive(true)
  }, [path, run])

  const end = useCallback(async (): Promise<void> => {
    releaseSession()
    setActive(false)
    setInfo(null)
    setPreview(null)
    setNote(null)
  }, [releaseSession])

  const cutout = useCallback(async (): Promise<void> => {
    const id = editRef.current
    if (!id) return
    const reply = await run('Removing the background', async () => {
      const picked = await bridge.edit.cutoutAuto(path, { edit: id, tolerance })
      const steps = await bridge.edit.history(id)
      return { picked, steps }
    })
    if (!reply) return
    setInfo(reply.picked.info)
    setPreview(reply.picked.preview ? reply.picked.preview.dataUrl : null)
    setNote(reply.picked.note ?? null)
    setHistory(reply.steps)
  }, [path, tolerance, run])

  const stroke = useCallback(
    async (points: StrokePoint[]): Promise<void> => {
      const id = editRef.current
      const current = info
      if (!id || !current || points.length === 0) return
      const radius = Math.max(
        1,
        Math.round((Math.min(current.width, current.height) * radiusPct) / 100)
      )
      const reply = await run('Painting', async () => {
        const painted = await bridge.edit.brush(id, { points, radius, mode, hardness })
        // A stroke is an undoable step now, so the buttons have to hear about it.
        const steps = await bridge.edit.history(id)
        return { painted, steps }
      })
      if (!reply) return
      setInfo(reply.painted)
      setPreview(reply.painted.preview ? reply.painted.preview.dataUrl : null)
      setNote(reply.painted.note ?? null)
      setHistory(reply.steps)
    },
    [hardness, info, mode, radiusPct, run]
  )

  const reset = useCallback(async (): Promise<void> => {
    const id = editRef.current
    if (!id) return
    const restored = await run('Starting over', () => bridge.edit.reset(id))
    if (!restored) return
    setInfo(restored)
    setPreview(null)
    setNote(null)
    setAppliedPath(null)
    // Reset clears the mask and the mask history but keeps the output settings,
    // because "start over" means start over with the picture, not throw away a crop
    // the user deliberately chose. So only the mask-side history is emptied here.
    setHistory({ canUndo: false, canRedo: false, steps: [] })
  }, [run])

  /**
   * Sends the chosen output settings to the main process and refreshes the preview.
   *
   * Called on a timer rather than on every slider frame: each call re-renders and
   * re-encodes the picture, which is far too much work to do sixty times a second.
   */
  const pushOutput = useCallback(async (): Promise<void> => {
    const id = editRef.current
    if (!id) return
    const next = outputRef.current
    const reply = await run('Adjusting', async () => {
      const sent = await bridge.edit.output(id, hasOutputSettings(next) ? next : null)
      const shown = await bridge.edit.preview(id)
      return { sent, shown }
    })
    if (!reply) return
    setInfo(reply.sent.info)
    setProjected(reply.sent.projected)
    setPreview(reply.shown.dataUrl)
  }, [run])

  const setOutput = useCallback((next: OutputSettings): void => {
    setOutputState((current) => mergeOutput(current, next))
  }, [])

  const clearOutput = useCallback((): void => {
    setOutputState({})
  }, [])

  // Every change to the settings schedules one push, and moving a slider restarts
  // the wait, so the picture is re-encoded once the hand settles rather than once
  // per pixel of travel.
  useEffect(() => {
    if (!active) return
    if (outputTimer.current) clearTimeout(outputTimer.current)
    outputTimer.current = setTimeout(() => {
      outputTimer.current = null
      void pushOutput()
    }, OUTPUT_SETTLE_MS)
    return () => {
      if (outputTimer.current) clearTimeout(outputTimer.current)
    }
  }, [output, active, pushOutput])

  /**
   * Applies one selection instruction.
   *
   * Every selection tool goes through here rather than through the brush, so they
   * all share one undo step each, one preview, and one history refresh.
   */
  const select = useCallback(
    async (command: SelectionCommand): Promise<void> => {
      const id = editRef.current
      if (!id) return
      const reply = await run('Selecting', async () => {
        const picked = await bridge.edit.selection(id, command)
        const steps = await bridge.edit.history(id)
        return { picked, steps }
      })
      if (!reply) return
      setInfo(reply.picked)
      setPreview(reply.picked.preview ? reply.picked.preview.dataUrl : null)
      setNote(reply.picked.note ?? null)
      setHistory(reply.steps)
    },
    [run]
  )

  const step = useCallback(
    async (direction: 'undo' | 'redo'): Promise<void> => {
      const id = editRef.current
      if (!id) return
      const reply = await run(direction === 'undo' ? 'Undoing' : 'Redoing', () =>
        direction === 'undo' ? bridge.edit.undo(id) : bridge.edit.redo(id)
      )
      if (!reply) return
      setInfo(reply)
      setHistory({ canUndo: reply.canUndo, canRedo: reply.canRedo, steps: reply.steps })
      // A step that moved nothing comes back with no preview, because there is
      // nothing new to show. The existing one is then still correct.
      if (reply.preview) setPreview(reply.preview.dataUrl)
      setNote(reply.label ? `${direction === 'undo' ? 'Undid' : 'Redid'} ${reply.label}` : null)
    },
    [run]
  )

  const undo = useCallback(async (): Promise<void> => step('undo'), [step])
  const redo = useCallback(async (): Promise<void> => step('redo'), [step])

  const apply = useCallback(async (): Promise<string | null> => {
    const id = editRef.current
    if (!id) return null
    const result = await run('Saving', () => bridge.edit.apply(id))
    if (!result) return null
    setAppliedPath(result.path)
    setNote(`Saved as ${result.path}`)
    return result.path
  }, [run])

  /**
   * Points the desktop at a picture on disk.
   *
   * A session's work only exists as a preview data URL in the renderer, which
   * Windows cannot use as a wallpaper. So an edited picture has to be saved before
   * it can be applied, and `canSetWallpaper` is what the panel uses to say so rather
   * than quietly setting the pre-edit original instead.
   */
  const canSetWallpaper = info !== null && (!info.hasEdits || appliedPath !== null)

  const setWallpaper = useCallback(
    async (fit: WallpaperFit): Promise<void> => {
      // Unsaved edits live only in this renderer as a preview data URL, so there
      // is no file on disk to hand the desktop. Checked here as well as on the
      // button, so the rule holds however it is called.
      if (!canSetWallpaper) {
        setError('Save a copy first, then it can be used as a wallpaper.')
        return
      }
      const target = appliedPath ?? path
      await run('Setting the wallpaper', () => bridge.wallpaper.set(target, fit))
    },
    [appliedPath, canSetWallpaper, path, run]
  )

  const removedPct =
    info === null || info.stats.pixels === 0 ? 0 : (info.stats.removed / info.stats.pixels) * 100

  return {
    active,
    busy,
    info,
    preview,
    note,
    error,
    tolerance,
    radiusPct,
    hardness,
    mode,
    setTolerance,
    setRadiusPct,
    setHardness,
    setMode,
    removedPct,
    begin,
    end,
    cutout,
    stroke,
    reset,
    apply,
    appliedPath,
    canSetWallpaper,
    setWallpaper,
    output,
    setOutput,
    clearOutput,
    projected,
    select,
    undo,
    redo,
    history
  }
}