/**
 * The wire types for the picture editor.
 *
 * They live in `shared` because both sides of the bridge speak them: the main
 * process runs the edits, and the renderer needs to describe what it wants
 * without knowing anything about rasters, masks or PNG encoding.
 *
 * The renderer never sees pixels and never sees a file handle. It holds an opaque
 * edit id and asks for pictures back as data URLs, which is the only image source
 * the renderer's CSP already permits alongside the thumbnail protocol.
 */

/** Which way the brush is working. */
export type BrushMode = 'erase' | 'restore'

/** One dab. Strokes are a list of these, painted in order. */
export interface BrushDab {
  /** Centre in image pixels, not screen pixels. */
  x: number
  y: number
}

/** What the mask is doing to the picture, in pixels. */
export interface EditStats {
  width: number
  height: number
  pixels: number
  /** Left fully opaque. */
  kept: number
  /** Faded part of the way. */
  softened: number
  /** Made transparent. */
  removed: number
  /**
   * True when the source had no alpha to begin with, so every change is a change
   * in coverage rather than in colour.
   */
  opaqueSource: boolean
  /** False while the session is exactly as it was opened. */
  hasEdits: boolean
}

/** Everything known about one open edit. */
export interface EditInfo {
  id: string
  /** The file being edited, as it exists on disk. */
  path: string
  /** 'jpeg' or 'png', decided by reading the bytes rather than the extension. */
  format: string
  width: number
  height: number
  stats: EditStats
  /** True once anything has been cut out or painted. */
  hasEdits: boolean
}

/**
 * A picture for the renderer to show.
 *
 * Sent as a data URL rather than a path because the preview exists only in memory
 * until somebody saves it. The renderer paints it in an <img>; nothing on disk
 * moves.
 */
export interface EditPreview {
  /** A `data:image/png;base64,...` URL. */
  dataUrl: string
  width: number
  height: number
}

/** The common part of every edit reply. */
export interface EditResult {
  info: EditInfo
  /** Present when the operation produced a picture worth showing. */
  preview?: EditPreview
  /** Set when the call did what was asked but left nothing visible behind. */
  note?: string
}

/** The result of saving. */
export interface EditApplied extends EditResult {
  path: string
  bytes: number
}

export interface CutoutOptions {
  /**
   * How far a pixel may differ from the background and still count as background,
   * summed across the three colour channels (0 to 765). Default 48, about 16
   * per channel. Anything under about 32 removes nothing from an ordinary
   * photograph, because JPEG noise moves the background further than that.
   */
  tolerance?: number
  /** Re-cut into this existing edit instead of opening a second one. */
  edit?: string
}

export interface BrushOptions {
  /** Reuse an open edit rather than opening the file again. */
  edit?: string
  points: BrushDab[]
  /** Radius in image pixels. */
  radius: number
  mode: BrushMode
  /**
   * 0 fades across the whole radius, 1 is a flat edge. Default 0.7.
   */
  hardness?: number
}

export interface PreviewOptions {
  /** Widens the edge by this many pixels. Default 0, a hard edge. */
  feather?: number
  /** Longest edge of the returned picture. Default 1600. */
  maxEdge?: number
}

export interface ApplyOptions {
  feather?: number
  /** Where to write. The extension is corrected to .png. */
  path?: string
  /** Replace a picture that is already there. Default false. */
  overwrite?: boolean
}

/** One line of advice, returned when an operation completed but found nothing. */
export interface CutoutHint {
  stats: EditStats
  hint: string
}

export interface CutoutReply extends EditResult {
  reference: [number, number, number]
}

/**
 * What a stroke came back with.
 *
 * `note` is here for the same reason as on a cutout: a stroke that changed nothing
 * still succeeded, and saying so is more useful than returning an identical
 * picture and letting the caller wonder whether it landed.
 */
export interface BrushReply extends EditInfo {
  /** Present only when something was painted and a fresh picture came back. */
  preview?: EditPreview
  /** Present only when nothing changed. */
  note?: string
}