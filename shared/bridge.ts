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
  HistoryReply,
  HistoryState,
  OutputSettings,
  PreviewOptions,
  SelectionCommand
} from './edit'
import type {
  TerminalAttachResult,
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo
} from './terminal'

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
    /**
     * Applies one selection instruction - wand, rectangle, ellipse, polygon, invert,
     * keep-all, or one edge refinement - as a single undoable step.
     *
     * One channel for all of them on purpose. Split across seven channels the caller
     * would have to know which ones exist, and the panel would end up with a
     * half-implemented subset that looks like the tools are simply missing.
     */
    selection(edit: string, command: SelectionCommand): Promise<BrushReply>
    /**
     * Replaces the geometry and colour applied to the finished picture.
     *
     * The whole set, not a patch, because the panel holds all of it at once and
     * "set brightness to 40" has to keep the contrast the user already chose.
     * `null` clears every setting. The projected size comes back because a resize is
     * usually asked for to hit a dimension.
     */
    output(
      edit: string,
      settings: OutputSettings | null
    ): Promise<{ info: EditInfo; projected: { width: number; height: number } }>
    /** Steps back or replays one change to the selection. */
    undo(edit: string): Promise<HistoryReply>
    redo(edit: string): Promise<HistoryReply>
    /** What undo and redo currently have to work with. */
    history(edit: string): Promise<HistoryState>
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
  /**
   * A real shell, attached to a pseudoterminal in the main process.
   *
   * Off unless the user turns it on in Settings, and the shell executable is
   * chosen from a fixed pair rather than passed in, so the renderer cannot ask
   * for an arbitrary program. Sessions are named by an opaque id; output is
   * buffered until the view attaches so the first prompt is not lost.
   */
  terminal: {
    /** Whether the PTY engine loaded on this machine. */
    available(): Promise<boolean>
    create(options?: TerminalCreateOptions): Promise<TerminalSessionInfo>
    /** Consumes the pre-attach backlog and starts the live stream. */
    attach(id: string): Promise<TerminalAttachResult>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    kill(id: string): Promise<void>
    onData(handler: (event: TerminalDataEvent) => void): () => void
    onExit(handler: (event: TerminalExitEvent) => void): () => void
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
export const TERMINAL_DATA_CHANNEL = 'opencpics:terminal-data'
export const TERMINAL_EXIT_CHANNEL = 'opencpics:terminal-exit'
