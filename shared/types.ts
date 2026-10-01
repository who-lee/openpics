export interface Photo {
  /** Absolute path on disk. Doubles as the stable identity of the photo. */
  path: string
  /** File name including extension. */
  name: string
  /** Lowercase extension without the dot, e.g. "jpg". */
  ext: string
  /** Size on disk in bytes. */
  bytes: number
  /** Last-modified time in epoch milliseconds. */
  mtime: number
  /** Pixel width, or 0 when the header could not be parsed. */
  width: number
  /** Pixel height, or 0 when the header could not be parsed. */
  height: number
  /** Directory the photo was found in, relative to the scan root. "" for the root itself. */
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