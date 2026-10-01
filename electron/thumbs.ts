import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage, net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { NATIVELY_DECODABLE, THUMB_MAX_EDGE, THUMB_SCHEME } from '../shared/protocol'
import { safeStat } from './imageinfo'
import { rasterize } from './raster'

/** Formats whose alpha channel must survive into the thumbnail. */
const ALPHA_FORMATS = new Set(['png', 'svg', 'avif', 'webp'])

const MEM_CACHE_MAX = 400
const DISK_CACHE_MAX = 3000

/**
 * Directories the renderer is permitted to read thumbnails from. A thumbnail URL
 * is still a file path, so the handler refuses anything outside these roots.
 */
let allowedRoots: string[] = []

export function setAllowedRoots(roots: string[]): void {
  allowedRoots = roots.map((r) => normalise(r))
}

function normalise(p: string): string {
  const resolved = p.replace(/\//g, '\\').replace(/\\+$/, '')
  return resolved.toLowerCase()
}

function isAllowed(target: string): boolean {
  const norm = normalise(target)
  return allowedRoots.some((root) => norm === root || norm.startsWith(root + '\\'))
}

/** Formats that keep a real alpha channel in the generated thumbnail. */
function wantsAlpha(ext: string): boolean {
  return ALPHA_FORMATS.has(ext.toLowerCase())
}

interface CacheEntry {
  key: string
  body: Buffer
  type: 'image/jpeg' | 'image/png'
  bytes: number
}

const mem = new Map<string, CacheEntry>()

let diskDir = ''
let diskReady = false

function cacheDir(): string {
  if (!diskReady) {
    diskDir = join(app.getPath('userData'), 'thumbcache')
    try {
      mkdirSync(diskDir, { recursive: true })
    } catch {
      diskDir = ''
    }
    diskReady = true
  }
  return diskDir
}

function diskKey(key: string): string {
  return createHash('sha1').update(key).digest('hex')
}

function diskPath(key: string): string {
  const dir = cacheDir()
  return dir === '' ? '' : join(dir, `${diskKey(key)}.bin`)
}

function touchMemory(entry: CacheEntry): void {
  // Re-insert so Map iteration order doubles as recency order.
  mem.delete(entry.key)
  mem.set(entry.key, entry)
  if (mem.size > MEM_CACHE_MAX) {
    const oldest = mem.keys().next()
    if (!oldest.done && oldest.value) mem.delete(oldest.value)
  }
}

interface Rendered {
  entry: CacheEntry | null
  /** True when the bytes came from a cache rather than a fresh decode. */
  hit: boolean
}

/** Decodes, downscales and encodes one thumbnail. Returns null when undecodable. */
async function render(path: string, edge: number): Promise<Rendered> {
  const stat = safeStat(path)
  if (!stat) return { entry: null, hit: false }
  const ext = path.slice(path.lastIndexOf('.') + 1)
  const key = `${path}|${stat.mtime}|${stat.bytes}|${edge}`

  const cached = mem.get(key)
  if (cached) {
    touchMemory(cached)
    return { entry: cached, hit: true }
  }
  const onDisk = diskPath(key)
  if (onDisk && existsSync(onDisk)) {
    try {
      const body = readFileSync(onDisk)
      const type = body[0] === 0x89 ? 'image/png' : 'image/jpeg'
      const entry: CacheEntry = { key, body, type, bytes: body.length }
      touchMemory(entry)
      return { entry, hit: true }
    } catch {
      /* a corrupt cache entry is not worth failing the request over */
    }
  }

  if (!NATIVELY_DECODABLE.has(ext.toLowerCase())) return { entry: null, hit: false }

  const lower = ext.toLowerCase()
  const alpha = wantsAlpha(lower)
  let body: Buffer | null = null
  let type: CacheEntry['type'] = alpha ? 'image/png' : 'image/jpeg'

  // nativeImage is synchronous and fast, but on Windows it only opens JPEG and PNG.
  // Everything else goes to Chromium, which decodes the full browser format set.
  let image: Electron.NativeImage
  try {
    image = nativeImage.createFromPath(path)
  } catch {
    image = nativeImage.createEmpty()
  }

  if (!image.isEmpty()) {
    const { width, height } = image.getSize()
    let scaled = image
    const longest = Math.max(width, height)
    if (longest > edge) {
      const ratio = edge / longest
      const target = {
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(height * ratio))
      }
      scaled = image.resize({ ...target, quality: 'good' })
    }
    body = alpha ? scaled.toPNG() : scaled.toJPEG(82)
  } else {
    const viaChromium = await rasterize(path, lower, edge, alpha)
    if (!viaChromium) return { entry: null, hit: false }
    body = viaChromium.body
    type = viaChromium.type
  }

  const entry: CacheEntry = { key, body, type, bytes: body.length }
  touchMemory(entry)

  if (onDisk) {
    try {
      writeFileSync(onDisk, body)
    } catch {
      /* disk cache is an optimisation, never a requirement */
    }
  }
  return { entry, hit: false }
}

export const thumbStats = {
  requests: 0,
  hits: 0,
  misses: 0,
  failures: 0,
  bytesServed: 0
}
function notFound(reason: string): Response {
  return new Response(reason, {
    status: 404,
    headers: { 'content-type': 'text/plain' }
  })
}

/** Keeps the on-disk cache from growing without bound across long sessions. */
function pruneDisk(): void {
  const dir = cacheDir()
  if (dir === '') return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  if (names.length <= DISK_CACHE_MAX) return
  const dated = names
    .map((name) => {
      const full = join(dir, name)
      try {
        return { full, mtime: statSync(full).mtimeMs }
      } catch {
        return { full, mtime: 0 }
      }
    })
    .sort((a, b) => a.mtime - b.mtime)

  const drop = dated.slice(0, Math.ceil(dated.length * 0.25))
  for (const entry of drop) {
    try {
      unlinkSync(entry.full)
    } catch {
      /* ignore */
    }
  }
}

let pruneCountdown = 0

async function handleThumb(request: Request): Promise<Response> {
  thumbStats.requests += 1
  try {
    const url = new URL(request.url)
    // The first path segment is the opaque host; the encoded file path follows.
    const encoded = url.pathname.replace(/^\//, '')
    if (encoded === '') return notFound('empty path')

    const path = decodeURIComponent(encoded)
    if (!isAllowed(path)) {
      thumbStats.failures += 1
      return new Response('path outside the scanned folders', { status: 403 })
    }

    // Full-size mode streams the original file so a 40MP photo is never held in
    // memory. A file:// URL is not reachable from the dev server's http origin,
    // so the viewer reads originals through this same allowlisted protocol.
    if (url.searchParams.get('full') === '1') {
      try {
        const upstream = await net.fetch(pathToFileURL(path).toString())
        if (!upstream.ok) return notFound('cannot read original')
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'content-type': guessMime(path),
            'content-length': String(statSync(path).size)
          }
        })
      } catch {
        thumbStats.failures += 1
        return notFound('cannot stream original')
      }
    }

    const requested = Number.parseInt(url.searchParams.get('edge') ?? '', 10)
    const edge = Number.isFinite(requested)
      ? Math.min(2048, Math.max(64, requested))
      : THUMB_MAX_EDGE

    const { entry, hit } = await render(path, edge)
    if (!entry) {
      thumbStats.failures += 1
      return notFound('unsupported or corrupt image')
    }
    if (hit) thumbStats.hits += 1
    else thumbStats.misses += 1
    thumbStats.bytesServed += entry.bytes

    if (pruneCountdown-- <= 0) {
      pruneCountdown = 200
      pruneDisk()
    }

    return new Response(new Uint8Array(entry.body), {
      status: 200,
      headers: {
        'content-type': entry.type,
        'content-length': String(entry.bytes),
        'cache-control': 'no-store'
      }
    })
  } catch (err) {
    thumbStats.failures += 1
    return notFound(err instanceof Error ? err.message : 'thumbnail failed')
  }
}

export function registerThumbScheme(): void {
  protocol.handle(THUMB_SCHEME, handleThumb)
}

export function clearThumbMemory(): void {
  mem.clear()
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif'
}

function guessMime(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}