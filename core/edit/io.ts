import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, parse, resolve } from 'node:path'

import { decodeImage, ImageError, sniffFormat, type ReadableFormat, type Raster } from '../image/image'
import { encodePng } from '../image/png'
import { createSession, type EditSession } from './session'

/**
 * Getting a picture in and putting a cutout back out.
 *
 * The rule that shapes all of it: an edit never writes over the file it read.
 * Losing the original to a mis-typed tolerance is not recoverable, and the
 * Recycle Bin is a poor place to look for it.
 */

/** Refuse to slurp anything that large; it is not a picture, it is a mistake. */
const MAX_FILE_BYTES = 256 * 1024 * 1024

export interface LoadedImage {
  raster: Raster
  format: ReadableFormat
  bytes: number
}

export function loadRaster(path: string): LoadedImage {
  if (!existsSync(path)) throw new ImageError(`no such file: ${path}`)
  const stat = statSync(path)
  if (!stat.isFile()) throw new ImageError(`not a file: ${path}`)
  if (stat.size > MAX_FILE_BYTES) {
    throw new ImageError(`${path} is ${stat.size} bytes, too large to edit`)
  }
  const buf = readFileSync(path)
  // The bytes decide, not the name: photos get renamed to .jpg while still being
  // PNG, and the extension is the least reliable thing about a file.
  const format = sniffFormat(buf)
  if (!format) throw new ImageError(`${path} is neither a PNG nor a JPEG`)
  return { raster: decodeImage(buf), format, bytes: stat.size }
}

export interface OpenedEdit {
  path: string
  session: EditSession
  format: ReadableFormat
  bytes: number
}

export function openSession(path: string): OpenedEdit {
  const loaded = loadRaster(path)
  return {
    path,
    session: createSession(loaded.raster),
    format: loaded.format,
    bytes: loaded.bytes
  }
}

/**
 * A path that does not exist yet, beside the source and ending in `.png`.
 *
 * The editor can only write PNG, because PNG is the only format here that keeps
 * an alpha channel, so a cutout saved as `.jpg` would arrive as a black
 * rectangle. Renaming the extension rather than the contents is therefore not an
 * option, and neither is silently overwriting an existing picture.
 */
export function defaultOutputPath(inputPath: string, suffix = '-cutout'): string {
  const { dir, name } = parse(inputPath)
  const base = `${name}${suffix}.png`
  if (!existsSync(join(dir, base))) return join(dir, base)
  for (let n = 2; n < 1000; n++) {
    const candidate = join(dir, `${name}${suffix}-${n}.png`)
    if (!existsSync(candidate)) return candidate
  }
  throw new ImageError(`too many ${name}${suffix}*.png files already in ${dir}`)
}

export interface SavedImage {
  path: string
  bytes: number
}

/**
 * Whether two paths name the same file on disk.
 *
 * Both sides are resolved and the result is case-folded, because Windows treats
 * paths case-insensitively and `C:\a\..\a\photo.png` is the same file as
 * `C:\a\photo.png`. A plain string comparison misses both and lets the one rule
 * that matters here - never write over the picture that was read - be sidestepped
 * by typing the path a slightly different way.
 */
function isSamePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

export interface SaveOptions {
  /** Replace a picture that is already at the target path. Default false. */
  overwrite?: boolean
}

export function savePng(raster: Raster, path: string, sourcePath?: string, options: SaveOptions = {}): SavedImage {
  if (sourcePath && isSamePath(path, sourcePath)) {
    throw new ImageError('refusing to overwrite the original picture')
  }
  // Guarding only against the source is not enough. A caller-supplied path can
  // name some unrelated picture, and quietly replacing it would be the same
  // mistake wearing a different hat.
  if (!options.overwrite && existsSync(path)) {
    throw new ImageError(`${path} already exists; choose another path or pass overwrite`)
  }
  const dir = dirname(path)
  if (!existsSync(dir)) throw new ImageError(`no such folder: ${dir}`)
  const buf = encodePng(raster)
  writeFileSync(path, buf)
  return { path, bytes: buf.length }
}

/**
 * Suggests where a cutout should be written.
 *
 * An extension the caller supplied wins, and a `.jpg` is corrected to `.png`
 * rather than honoured: writing PNG bytes under a JPEG name produces a file
 * that most programs will refuse to open, which is a worse outcome than the
 * caller not getting exactly the name it asked for.
 */
export function resolveOutputPath(sourcePath: string, requested?: string): string {
  if (!requested) return defaultOutputPath(sourcePath)
  const ext = extname(requested).toLowerCase()
  const stem = ext === '' ? requested : requested.slice(0, -ext.length)
  return `${stem}.png`
}