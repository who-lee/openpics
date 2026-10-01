import type {
  DriveInfo,
  ScanProgress,
  ScanResult,
  Settings,
  ThumbnailStats,
  WallpaperFit,
  WallpaperState
} from './protocol'
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
} from './edit'

/**
 * The entire surface the renderer is allowed to touch. It lives in `shared`
 * rather than in `electron/preload.ts` so the web TypeScript project can import
 * it without pulling Electron's ambient types across the boundary.
 */
export interface OpenPicsBridge {
  settings: {
    get(): Promise<Settings>
    patch(patch: Partial<Settings>): Promise<Settings>
  }
  library: {
    defaultRoot(): Promise<string>
    pick(): Promise<{ canceled: boolean; path?: string }>
    scan(root: string, recursive: boolean): Promise<ScanResult>
    /** Every readable drive, for the "scan this PC" source. */
    drives(): Promise<DriveInfo[]>
    /** Walks every drive. Resolves when the walk ends or is cancelled. */
    scanComputer(): Promise<ScanResult>
    /** Stops a walk in progress; its partial result is still returned. */
    cancelScan(): Promise<void>
    thumbStats(): Promise<ThumbnailStats>
    /** Live progress for a long walk. Returns an unsubscribe function. */
    onScanProgress(handler: (progress: ScanProgress) => void): () => void
    /**
     * Files handed to the app by Windows, from a context-menu or "Open with"
     * launch. Returns an unsubscribe function.
     */
    onOpenFiles(handler: (paths: string[]) => void): () => void
  }
  /**
   * Non-destructive picture editing.
   *
   * Every call names an open edit by an opaque id rather than a file, so the
   * renderer can never be holding a session onto something it did not open, and
   * the main process stays the only thing that touches bytes. Sessions are
   * dropped by the main process under a memory budget; a forgotten id reports
   * what is still open rather than failing silently.
   */
  edit: {
    /** Opens a picture and removes the background, leaving the subject. */
    cutoutAuto(path: string, options?: CutoutOptions): Promise<CutoutReply>
    /** Opens a picture with nothing done to it. */
    open(path: string, edit?: string): Promise<EditInfo>
    /** Paints a stroke. Returns a fresh preview so the change is visible at once. */
    brush(edit: string, options: BrushOptions): Promise<BrushReply>
    /** A downscaled picture of the current state, without saving anything. */
    preview(edit: string, options?: PreviewOptions): Promise<EditPreview>
    /** Writes a new PNG. Never touches the original, and never replaces a file. */
    apply(edit: string, options?: ApplyOptions): Promise<EditApplied>
    /** Current state of one edit, or of all of them when called with nothing. */
    inspect(edit?: string): Promise<{ info: EditInfo | null; open: EditInfo[] }>
    /** Throws the work away and returns the session to how it was opened. */
    reset(edit: string): Promise<EditInfo>
    /** Releases a session's memory early. */
    close(edit: string): Promise<boolean>
  }
  /**
   * The desktop background.
   *
   * Separate from the editing surface because it applies to the whole machine, not
   * to a picture being worked on: nothing here is undoable from the app, so the
   * renderer has to ask for it deliberately.
   */
  wallpaper: {
    get(): Promise<WallpaperState>
    /** Changes every desktop. Only ever called from an explicit user action. */
    set(path: string, fit?: WallpaperFit): Promise<void>
  }
  shell: {
    reveal(path: string): Promise<void>
    open(path: string): Promise<void>
    /** Opens a URL in the user's own browser. The only way out of the sandbox. */
    openUrl(url: string): Promise<void>
    /**
     * Adds or removes the context-menu and Open With entries under HKCU.
     * Resolves to the resulting state.
     */
    setFileAssociations(enabled: boolean): Promise<boolean>
    fileAssociations(): Promise<boolean>
  }
  win: {
    alwaysOnTop(value: boolean): Promise<boolean>
    fullscreen(value: boolean): Promise<boolean>
    hide(): Promise<void>
    show(): Promise<void>
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    state(): Promise<{ maximized: boolean; fullScreen: boolean; visible: boolean }>
    quit(): Promise<void>
  }
  onCommand(handler: (command: string) => void): () => void
}

export const COMMAND = {
  hide: 'hide',
  show: 'show',
  minimize: 'minimize',
  quit: 'quit',
  next: 'next',
  previous: 'previous',
  slideshow: 'slideshow',
  info: 'info'
} as const

export type Command = (typeof COMMAND)[keyof typeof COMMAND]

export const COMMAND_CHANNEL = 'opencpics:command'
export const SCAN_PROGRESS_CHANNEL = 'opencpics:scan-progress'
export const OPEN_FILES_CHANNEL = 'opencpics:open-files'
