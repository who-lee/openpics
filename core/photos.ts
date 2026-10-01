import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { probeImageSize } from './image/image'
import { IMAGE_EXTS } from '../shared/protocol'
import type { Photo } from '../shared/types'

/**
 * Directories that never hold a picture worth looking at.
 *
 * Exported so the application's own scanner can adopt it rather than keep a
 * second copy that drifts. Until it does, this is the same list in
 * electron/scanner.ts and the two must be changed together.
 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '$recycle.bin',
  'system volume information',
  'windows',
  'recovery',
  'winsxs',
  'driverstore',
  'perflogs',
  'msocache',
  'config.msi',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata'
])

export interface FindOptions {
  /** Descend into subdirectories. On by default. */
  recursive?: boolean
  /**
   * Hard cap on results. Bounded on purpose: an agent asking "what is in this
   * folder" needs an answer it can read, not a walk of a whole drive that never
   * returns. The app's interactive scanner has its own, much larger caps.
   */
  limit?: number
  /** How deep to descend when `recursive` is set. */
  maxDepth?: number
  /** Substrings; a file whose name contains one is kept. Case-insensitive. */
  nameContains?: string[]
  /** Restrict to these extensions, without dots. Empty means every known type. */
  extensions?: string[]
}

/** True when the path looks like a file OpenPics knows how to list. */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase())
}

/**
 * The single place a `Photo` is built, so no caller can forget a field.
 *
 * `withSize` costs one header read per file. Listing pays it too, deliberately:
 * a caller sorting a folder by resolution or warning about files too large to
 * cutout cannot do either without dimensions, and the cap on `findPhotos` already
 * bounds the cost. A file whose header will not parse reports zero rather than
 * being dropped, because it is still a real file at a real size.
 */
function toPhoto(path: string, root: string, withSize: boolean): Photo | null {
  let bytes: number
  let mtime: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return null
    bytes = st.size
    mtime = st.mtimeMs
  } catch {
    return null
  }
  const name = path.slice(path.lastIndexOf('\\') + 1)
  const dot = name.lastIndexOf('.')
  const size = withSize ? probeImageSize(path) : null
  return {
    path,
    name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    bytes,
    mtime,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    relDir: relative(root, path.slice(0, path.lastIndexOf('\\')))
  }
}

/**
 * Lists pictures under `root`.
 *
 * Deliberately synchronous and deliberately bounded: this runs inside an MCP call
 * with a client waiting on it, so it returns what it has at the cap instead of
 * streaming progress the caller has no way to render.
 */
export function findPhotos(root: string, opts: FindOptions = {}): Photo[] {
  const { recursive = true, limit = 5000, maxDepth = 12 } = opts
  const wanted = opts.extensions?.map((e) => e.replace(/^\./, '').toLowerCase())
  const needles = opts.nameContains?.map((s) => s.toLowerCase()) ?? []

  const found: Photo[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (queue.length > 0 && found.length < limit) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number }
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }

    for (const name of names) {
      if (found.length >= limit) break
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }

      if (isDir) {
        if (!recursive || depth >= maxDepth) continue
        if (SKIP_DIRS.has(name.toLowerCase())) continue
        queue.push({ dir: full, depth: depth + 1 })
        continue
      }

      if (!isImagePath(name)) continue
      if (wanted && wanted.length > 0) {
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        if (!wanted.includes(ext)) continue
      }
      if (needles.length > 0 && !needles.some((n) => name.toLowerCase().includes(n))) continue

      const photo = toPhoto(full, root, true)
      if (photo) found.push(photo)
    }
  }

  return found
}

/** Reads one picture's basic facts, or null when the path is not an image. */
export function describePhoto(path: string): Photo | null {
  if (!isImagePath(path)) return null
  const root = path.slice(0, path.lastIndexOf('\\')) || '.'
  return toPhoto(path, root, true)
}
