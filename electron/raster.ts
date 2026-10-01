import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { pathToFileURL } from 'node:url'

/**
 * Thumbnail decoding for the formats Electron's nativeImage cannot open.
 *
 * nativeImage on Windows decodes JPEG and PNG and little else, so WebP, GIF, BMP
 * and SVG used to fall through to a "Cannot preview" tile even though Chromium
 * renders every one of them. This module borrows Chromium's decoder: a hidden
 * window loads the file as an image, draws it into a canvas at the requested edge,
 * and hands the encoded bytes back to the main process.
 *
 * The JPEG/PNG fast path in thumbs.ts is untouched, so a library of ordinary photos
 * never creates this window at all.
 */

/** Formats Chromium can decode, and therefore the ones worth asking it for. */
const CHROMIUM_DECODABLE = new Set(['webp', 'avif', 'gif', 'bmp', 'svg'])

/** Guards against a hidden window that outlives the app. */
const RASTER_TIMEOUT_MS = 20000

/** How many files may decode at once. Chromium parallelises these internally. */
const MAX_IN_FLIGHT = 4

let worker: BrowserWindow | null = null
let ready: Promise<BrowserWindow> | null = null
let inFlight = 0
const queue: (() => void)[] = []

/** Bounded concurrency without pulling in a dependency. */
function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    queue.push(() => {
      inFlight += 1
      resolve()
    })
  })
}

function release(): void {
  inFlight -= 1
  const next = queue.shift()
  if (next) next()
}

function rendererSource(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>openpics rasterizer</title>
<script>
  // Runs inside a sandboxed, context-isolated window with no Node access. The only
  // path this can read is one the main process already allowlisted.
  window.__raster = async (fileUrl, edge, mime) => {
    const img = new Image()
    img.src = fileUrl
    // decode() rejects rather than firing onerror, and does the work off the
    // compositor so a large file cannot stall the hidden window.
    await img.decode()
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) throw new Error('no intrinsic size')
    const longest = Math.max(w, h)
    const scale = longest > edge ? edge / longest : 1
    const tw = Math.max(1, Math.round(w * scale))
    const th = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0, tw, th)
    return canvas.toDataURL(mime, 0.82)
  }
</script>`
}

function ensureWorker(): Promise<BrowserWindow> {
  if (worker && !worker.isDestroyed()) return Promise.resolve(worker)
  if (ready) return ready

  ready = (async () => {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    const page = join(dir, 'rasterizer.html')
    writeFileSync(page, rendererSource(), 'utf8')

    const win = new BrowserWindow({
      show: false,
      // Keeps the worker out of the taskbar and Alt+Tab; it is never a real window.
      skipTaskbar: true,
      width: 64,
      height: 64,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The page is a file:// document so it may load file:// images, which is
        // how the bytes reach Chromium without copying them across the bridge.
        webSecurity: true,
        backgroundThrottling: false,
        devTools: false
      }
    })
    await win.loadURL(pathToFileURL(page).toString())
    worker = win
    // A crash or a window close must not poison later thumbnails.
    win.on('closed', () => {
      if (worker === win) {
        worker = null
        ready = null
      }
    })
    return win
  })()

  ready.catch(() => {
    ready = null
  })
  return ready
}

export interface RasterResult {
  body: Buffer
  type: 'image/jpeg' | 'image/png'
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

/**
 * Decodes one file with Chromium and returns encoded thumbnail bytes, or null when
 * the format is unsupported, the file is undecodable, or the worker misbehaves. The
 * caller treats null as "no preview" and the tile falls back to its labelled state.
 */
export async function rasterize(
  path: string,
  ext: string,
  edge: number,
  alpha: boolean
): Promise<RasterResult | null> {
  if (!CHROMIUM_DECODABLE.has(ext.toLowerCase())) return null

  await acquire()
  try {
    const win = await ensureWorker()
    const mime = alpha ? 'image/png' : 'image/jpeg'
    // JSON.stringify escapes the path, so a quote or backslash in a filename cannot
    // break out of the string literal.
    const script = `window.__raster(${JSON.stringify(pathToFileURL(path).toString())}, ${edge}, ${JSON.stringify(mime)})`
    const dataUrl = await withTimeout(win.webContents.executeJavaScript(script, true), RASTER_TIMEOUT_MS)
    if (typeof dataUrl !== 'string') return null
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    const body = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    if (body.length === 0) return null
    return { body, type: alpha ? 'image/png' : 'image/jpeg' }
  } catch {
    return null
  } finally {
    release()
  }
}

/** Called on quit so the worker never outlives the app. */
export function disposeRasterizer(): void {
  const win = worker
  worker = null
  ready = null
  inFlight = 0
  queue.length = 0
  if (win && !win.isDestroyed()) win.destroy()
  // The helper page is rebuilt on demand, so do not leave it in the profile.
  try {
    unlinkSync(join(app.getPath('userData'), 'rasterizer.html'))
  } catch {
    /* it may never have been written, which is fine */
  }
}

app.once('before-quit', disposeRasterizer)
