/**
 * One thing the library can show.
 *
 * Called `Photo` because that is what it was when the app was pictures only, and
 * renaming it would touch every grid, layout and panel for no gain. What changed
 * is `kind`: a library item is now either a still picture or a video clip, and
 * enough code branches on that to be worth having it as a field rather than
 * re-deriving it from the extension everywhere.
 *
 * A clip carries no `width`/`height` from the scan. Reading it means running
 * ffprobe, and a scan over a whole drive would then be tens of thousands of
 * process launches - minutes of fan noise before the first tile appears, for
 * numbers the viewer learns for free from the file itself the moment it opens it.
 * So a clip starts at 0 and is measured on demand. `aspectOf` falls back to 4:3
 * until then, which is why the layout code has always had that fallback.
 */
export interface Photo {
  /** Absolute path on disk. Doubles as the stable identity of the item. */
  path: string
  /** File name including extension. */
  name: string
  /** Lowercase extension without the dot, e.g. "jpg". */
  ext: string
  /** What this item is. Decided by the scanner from the file name. */
  kind: 'photo' | 'video'
  /** Size on disk in bytes. */
  bytes: number
  /** Last-modified time in epoch milliseconds. */
  mtime: number
  /** Pixel width, or 0 when not yet known. */
  width: number
  /** Pixel height, or 0 when not yet known. */
  height: number
  /** Duration in seconds for a clip, or 0 for a picture and for a not-yet-measured clip. */
  durationSeconds: number
  /** Directory the item was found in, relative to the scan root. "" for the root itself. */
  relDir: string
}

/** Where the library comes from: one chosen folder, or every drive on the machine. */
export type ScanMode = 'folder' | 'computer'

export interface ScanResult {
  root: string
  photos: Photo[]
  /** Files that looked like images but whose header could not be read. */
  unreadable: number
  /** Directories skipped, typically because they are hidden or system folders. */
  skippedDirs: number
  /** Wall-clock duration of the scan in milliseconds. */
  ms: number
  truncated: boolean
  /** Which scan produced this result. Absent on results written by older builds. */
  mode?: ScanMode
  /** Roots walked, in order. More than one only in computer mode. */
  roots?: string[]
  /** True when the user stopped the scan before it finished. */
  canceled?: boolean
}

export interface DriveInfo {
  /** Drive root, e.g. "C:\\". */
  root: string
  /** Volume label, or the root itself when the volume has none. */
  label: string
  /** Free space in bytes, or 0 when it could not be read. */
  freeBytes: number
  /** True when the root could not be listed, e.g. a drive with no disc in it. */
  unreadable: boolean
}

/** Live progress for a long scan, so the window never looks frozen. */
export interface ScanProgress {
  mode: ScanMode
  /** Number of pictures found so far. */
  found: number
  /** Directories walked so far. */
  dirs: number
  /** The directory being read right now, for a sense of place. */
  current: string
  /** Roots being walked, in order. */
  roots: string[]
  /** Which root is being walked. */
  rootIndex: number
  /** Wall-clock milliseconds since the scan began. */
  elapsedMs: number
  /** True once a hard cap stopped the walk. */
  truncated: boolean
  /** True while the walk is still going. */
  running: boolean
}

export type SortKey = 'name' | 'mtime' | 'size' | 'dimensions'

export type SortDir = 'asc' | 'desc'

export interface Settings {
  root: string
  /** Whether the gallery shows one folder or every drive on the machine. */
  scanMode: ScanMode
  recursive: boolean
  sortKey: SortKey
  sortDir: SortDir
  rowHeight: number
  slideIntervalMs: number
  alwaysOnTop: boolean
  closeToTray: boolean
  launchMinimized: boolean
  theme: 'dark' | 'light'
  /**
   * Whether OpenPics has written its context-menu and Open With entries under
   * HKCU. Only ever true because the user asked for it, and reversible.
   */
  shellIntegration: boolean
  /**
   * Whether a real shell can be opened inside the window. Off by default: a
   * terminal runs programs with the user's full rights and is not a picture
   * feature, so it stays opt-in and is confirmed the first time it is used.
   */
  enableTerminal: boolean
  /**
   * Whether the MCP server is allowed to run at all. Defaults to true because
   * that is how the app shipped, but the setting is the single gate both the
   * app and the server read, so switching it off denies every agent tool.
   *
   * A running server is not killed by this: it is a stdio process owned by the
   * agent that launched it, not by this window. Turning the switch off takes
   * effect on the next start, and refuses a tool call on an already-running one
   * only if that agent re-reads the file.
   */
  enableMcp: boolean
  /**
   * Height of the terminal drawer in pixels. Persisted so the panel comes back
   * the size it was left, the way an editor's terminal panel does.
   */
  terminalHeight: number
}

export interface ThumbnailStats {
  requests: number
  hits: number
  misses: number
  failures: number
  bytesServed: number
}

/** How a picture is arranged when it does not match the screen's aspect ratio. */
export type WallpaperFit = 'fill' | 'fit' | 'stretch' | 'center' | 'tile' | 'span'

export interface WallpaperState {
  /** Absolute path of the current background picture, or "" when none is set. */
  path: string
  /** The fit the current background was applied with, when it can be determined. */
  fit: WallpaperFit | null
}

/**
 * One item's outcome after a Recycle Bin delete.
 *
 * The delete reports per path rather than throwing, because a multi-select
 * delete is expected to be partly successful: a file that was locked or already
 * gone is recorded as failed while its neighbours go to the bin normally, and
 * the caller is the one who decides what the user is told.
 */
export interface BinResult {
  path: string
  ok: boolean
  /** Why the item was not deleted. Absent on success. */
  error?: string
}