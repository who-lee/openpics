import type {
  DriveInfo,
  Photo,
  ScanMode,
  ScanProgress,
  ScanResult,
  Settings,
  SortDir,
  SortKey,
  ThumbnailStats,
  WallpaperFit,
  WallpaperState
} from './types'

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
  shellIntegration: true
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
    case 'dimensions':
      return (a.width * a.height - b.width * b.height) * sign
    case 'name':
    default: {
      // Natural sort so "img2" lands before "img10" instead of after it.
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * sign
    }
  }
}

export type {
  DriveInfo,
  Photo,
  ScanMode,
  ScanProgress,
  ScanResult,
  Settings,
  SortDir,
  SortKey,
  ThumbnailStats,
  WallpaperFit,
  WallpaperState
}