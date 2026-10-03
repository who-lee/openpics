import type {
  BinResult,
  DriveInfo,
  Photo,
  ScanMode,
  ScanProgress,
  ScanResult,
  Settings,
  SmartCollection,
  SmartCollectionRule,
  SortDir,
  SortKey,
  ThumbnailStats,
  WallpaperFit,
  WallpaperState
} from './types'
void (null as unknown as SmartCollection | null)
void (null as unknown as SmartCollectionRule | null)
void (null as unknown as WallpaperFit | null)
void (null as unknown as WallpaperState | null)
void (null as unknown as BinResult | null)
void (null as unknown as DriveInfo | null)
void (null as unknown as ScanMode | null)
void (null as unknown as ScanProgress | null)
void (null as unknown as ScanResult | null)
void (null as unknown as ThumbnailStats | null)

export const IMAGE_EXTS = new Set([
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'png',
  'gif',
  'webp',
  'bmp',
  'avif',
  'svg',
  'tif',
  'tiff',
  'heic',
  'heif'
])

/**
 * Formats the app can produce a real preview for. JPEG and PNG decode through
 * Electron's nativeImage; WebP, GIF, BMP, AVIF and SVG are rasterised by Chromium,
 * which understands the full browser format set. HEIC/HEIF and TIFF are listed by
 * Windows as images but have no decoder in either, so they are still scanned and
 * listed while their tiles keep the labelled placeholder.
 */
export const NATIVELY_DECODABLE = new Set([
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'png',
  'gif',
  'webp',
  'bmp',
  'avif',
  'svg'
])

export const DEFAULT_SETTINGS: Settings = {
  root: '',
  scanMode: 'folder',
  recursive: true,
  sortKey: 'name',
  sortDir: 'asc',
  rowHeight: 168,
  slideIntervalMs: 5000,
  alwaysOnTop: false,
  closeToTray: true,
  launchMinimized: false,
  theme: 'dark',
  // The user asked for the context-menu entry up front, so it is on by default.
  // Settings can remove it again at any time.
  shellIntegration: true,
  // Opt-in: a terminal escalates what the window can do, so it is off until the
  // user asks for it rather than shipped on.
  enableTerminal: false,
  // On by default because that is how the app shipped. Unlike the terminal this
  // is not an escalation the user opted into, it is the advertised agent
  // integration, so it is available unless it is deliberately switched off.
  enableMcp: true,
  terminalHeight: 260,
  aiEnabled: true,
  aiDockExpanded: true,
  aiDockWidth: 360,
  aiModelPath: '',
  aiPromptPath: '',
  aiCollections: []
}

export const THUMB_SCHEME = 'opencpics-thumb'
export const THUMB_MAX_EDGE = 512

/** Allowlisted thumbnail URL for a file path. */
export function thumbUrl(path: string, edge: number = THUMB_MAX_EDGE): string {
  return `${THUMB_SCHEME}://img/${encodeURIComponent(path)}?edge=${edge}`
}

/** Allowlisted original-file URL, streamed by the main process for the viewer. */
export function fullUrl(path: string): string {
  return `${THUMB_SCHEME}://img/${encodeURIComponent(path)}?full=1`
}

export function isImage(name: string): boolean {
  const i = name.lastIndexOf('.')
  if (i <= 0) return false
  return IMAGE_EXTS.has(name.slice(i + 1).toLowerCase())
}

export function aspectOf(p: Photo): number {
  if (p.width > 0 && p.height > 0) return p.width / p.height
  return 4 / 3
}

export function comparePhotos(a: Photo, b: Photo, key: SortKey, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1
  switch (key) {
    case 'mtime':
      return (a.mtime - b.mtime) * sign
    case 'size':
      return (a.bytes - b.bytes) * sign
    case 'dimensions': {
      // A clip has no measured size until it has been opened, and comparing
      // `0 * 0` would put every unopened clip at the bottom of the list as if it
      // were a zero-pixel picture. Unknown goes last in both directions instead:
      // the user asked to sort by size, not to have unmeasured files claim they
      // are smaller than everything.
      const areaA = a.width > 0 && a.height > 0 ? a.width * a.height : -1
      const areaB = b.width > 0 && b.height > 0 ? b.width * b.height : -1
      if (areaA === -1 || areaB === -1) {
        if (areaA === areaB) return 0
        return areaA === -1 ? 1 : -1
      }
      return (areaA - areaB) * sign
    }
    case 'name':
    default: {
      // Natural sort so "img2" lands before "img10" instead of after it.
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * sign
    }
  }
}

export type { Photo, Settings, SmartCollection, SmartCollectionRule, SortDir, SortKey } from './types'

export type {
  BinResult,
  DriveInfo,
  ScanMode,
  ScanProgress,
  ScanResult,
  ThumbnailStats,
  WallpaperFit,
  WallpaperState
} from './types'
