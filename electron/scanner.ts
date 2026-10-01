import { readdir } from 'node:fs/promises'
import { readdirSync, statfsSync, statSync, type Dirent } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { isImage, type DriveInfo, type Photo, type ScanMode, type ScanProgress, type ScanResult } from '../shared/protocol'
import { isVideoName } from '../shared/video'
import { probeDimensions, safeStat } from './imageinfo'

/** Upper bound on returned entries. A mis-picked drive root should not hang the UI. */
const MAX_PHOTOS = 20000

/** Upper bound on directories walked, guards against symlink loops and deep trees. */
const MAX_DIRS = 6000

/** A whole-PC walk sees orders of magnitude more files, so it gets its own caps. */
const COMPUTER_MAX_PHOTOS = 50000
const COMPUTER_MAX_DIRS = 200000

/** Folders that never contain a picture worth looking at, at any depth. */
const SKIP_DIRS = new Set([
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

/**
 * How often the walk hands control back to the event loop, and how often it
 * reports. Both matter: a directory holding thousands of entries would otherwise
 * block the main process long enough to stall the thumbnail protocol and the
 * window's own IPC, which is the same "app has frozen" symptom as a sync scan.
 */
const YIELD_EVERY = 200
const PROGRESS_EVERY_MS = 120

function isHidden(name: string): boolean {
  return name.startsWith('.') || name.startsWith('$') || name.startsWith('~')
}

interface WalkOptions {
  recursive: boolean
  maxPhotos: number
  maxDirs: number
  /** Roots walked one after another. More than one only in computer mode. */
  roots: string[]
  mode: ScanMode
  /** Label for the scan, shown to the user. */
  label: string
  /** Reports drive-relative or root-relative folder names. */
  driveRelative: boolean
}

interface WalkState {
  photos: Photo[]
  unreadable: number
  skippedDirs: number
  dirs: number
  truncated: boolean
  canceled: boolean
  current: string
  rootIndex: number
  startedAt: number
  lastReportAt: number
  entriesSinceYield: number
  lastYieldAt: number
}

/** Set while a walk is running so cancelScan() can reach it. */
let running: { canceled: boolean } | null = null

/**
 * Walks the roots breadth-first, yielding to the event loop as it goes.
 *
 * Breadth-first rather than depth-first on purpose: a user's own Pictures folder
 * is far more likely to be near the top of a drive than deep inside Program Files,
 * so the grid fills with the pictures they actually want first.
 */
async function walk(opts: WalkOptions, onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
  const state: WalkState = {
    photos: [],
    unreadable: 0,
    skippedDirs: 0,
    dirs: 0,
    truncated: false,
    canceled: false,
    current: opts.roots[0] ?? '',
    rootIndex: 0,
    startedAt: Date.now(),
    lastReportAt: 0,
    entriesSinceYield: 0,
    lastYieldAt: Date.now()
  }
  const token = { canceled: false }
  running = token

  const report = (force: boolean): void => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - state.lastReportAt < PROGRESS_EVERY_MS) return
    state.lastReportAt = now
    onProgress({
      mode: opts.mode,
      found: state.photos.length,
      dirs: state.dirs,
      current: state.current,
      roots: opts.roots,
      rootIndex: state.rootIndex,
      elapsedMs: now - state.startedAt,
      truncated: state.truncated,
      running: true
    })
  }

  // Hands the loop back often enough that IPC and thumbnail decoding keep moving.
  const breathe = async (): Promise<void> => {
    state.entriesSinceYield += 1
    const now = Date.now()
    const due = state.entriesSinceYield >= YIELD_EVERY || now - state.lastYieldAt >= 40
    if (!due) return
    state.entriesSinceYield = 0
    state.lastYieldAt = now
    await yieldToLoop()
  }

  for (let r = 0; r < opts.roots.length; r++) {
    const root = opts.roots[r]!
    state.rootIndex = r
    state.current = root
    report(true)

    const queue: string[] = [root]
    while (queue.length > 0) {
      if (token.canceled) {
        state.canceled = true
        break
      }
      if (state.photos.length >= opts.maxPhotos || state.dirs >= opts.maxDirs) {
        state.truncated = true
        break
      }

      const dir = queue.shift()!
      state.current = dir

      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        // A locked, vanished or unreadable folder is normal on a real machine.
        state.skippedDirs += 1
        continue
      }
      state.dirs += 1
      report(false)

      for (const entry of entries) {
        if (token.canceled) {
          state.canceled = true
          break
        }
        if (state.photos.length >= opts.maxPhotos) {
          state.truncated = true
          break
        }
        const name = entry.name
        if (isHidden(name)) continue
        const full = join(dir, name)

        if (entry.isDirectory()) {
          if (!opts.recursive) continue
          if (SKIP_DIRS.has(name.toLowerCase())) continue
          // Junctions and symlinked directories are followed in folder mode today
          // only when they resolve as directories; in a whole-PC walk they are the
          // main source of cycles, so they are never queued.
          if (opts.mode === 'computer' && entry.isSymbolicLink()) continue
          queue.push(full)
          continue
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue

        // Pictures and clips are both library items now, but they are recognised
        // by different lists. Video extensions live in `shared/video.ts` so the
        // MCP tools and the renderer agree with the scanner on what a clip is.
        const kind: 'photo' | 'video' | null = isImage(name)
          ? 'photo'
          : isVideoName(name)
            ? 'video'
            : null
        // Written as a null check rather than a truthiness check so the narrowing
        // carries into `kind` below; `if (!kind)` leaves it `| null` for tsc.
        if (kind === null) continue

        const stat = safeStat(full)
        if (!stat || stat.bytes === 0) continue

        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        // Only a picture's header is read here. A clip would need ffprobe, and a
        // whole-drive scan would then be one process launch per video; the viewer
        // gets the real size off the file for free when it opens it.
        const dims = kind === 'photo' ? probeDimensions(full, ext) : { width: 0, height: 0 }
        // Only a picture that failed to parse counts as unreadable. A clip with
        // no dimensions yet is expected, and counting it would report thousands
        // of broken files on a perfectly healthy machine.
        if (kind === 'photo' && (dims.width === 0 || dims.height === 0)) state.unreadable += 1

        const rel = relative(root, dir).replace(/\\/g, '/')
        // In computer mode every root is a drive, so the label is the drive letter.
        // Anything else would produce a path-like label, which is noise in the
        // info panel and the filter.
        const label = opts.driveRelative && /^[A-Za-z]:\\$/.test(root) ? root.slice(0, 2) : ''
        const relDir = label !== '' ? `${label}/${rel}` : rel

        state.photos.push({
          path: full,
          name,
          ext,
          kind,
          bytes: stat.bytes,
          mtime: stat.mtime,
          width: dims.width,
          height: dims.height,
          durationSeconds: 0,
          relDir: relDir === '.' ? '' : relDir
        })
        await breathe()
      }

      if (state.canceled) break
    }

    if (state.canceled || state.truncated) break
  }

  running = null

  const result: ScanResult = {
    root: opts.label,
    photos: state.photos,
    unreadable: state.unreadable,
    skippedDirs: state.skippedDirs,
    ms: Date.now() - state.startedAt,
    truncated: state.truncated,
    mode: opts.mode,
    roots: opts.roots,
    canceled: state.canceled
  }
  onProgress?.({
    mode: opts.mode,
    found: state.photos.length,
    dirs: state.dirs,
    current: state.current,
    roots: opts.roots,
    rootIndex: state.rootIndex,
    elapsedMs: result.ms,
    truncated: state.truncated,
    running: false
  })
  return result
}

/** Stops a walk in progress. The partial result is still returned to the caller. */
export function cancelScan(): void {
  if (running) running.canceled = true
}

/**
 * Every readable drive and mapped network share, found by probing the 26 letters.
 *
 * Probing beats asking WMI or spawning PowerShell: it is 26 cheap stat calls, it
 * needs no subprocess, it cannot be broken by a deprecated `wmic` being removed
 * from Windows, and it picks up mapped network drives, which a gallery wants.
 */
export function listDrives(): DriveInfo[] {
  const drives: DriveInfo[] = []
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`
    let isDir = false
    try {
      isDir = statSync(root).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue

    // An empty optical drive answers the stat but not the listing. Marking it
    // unreadable keeps it out of the walk instead of counting it as a failure.
    let readable = true
    try {
      readdirSync(root)
    } catch {
      readable = false
    }

    let freeBytes = 0
    try {
      const stats = statfsSync(root)
      freeBytes = Number(stats.bavail) * Number(stats.bsize)
    } catch {
      /* some virtual and network volumes do not report a size */
    }

    drives.push({ root, label: root, freeBytes, unreadable: !readable })
  }
  return drives
}

/**
 * One chosen folder, as before. Now async so a deep tree cannot freeze the app.
 *
 * `onProgress` is optional: a desktop folder usually finishes fast enough that
 * the caller has nothing useful to show, but the hook exists so the walk is
 * observable and cancellable at any point regardless of mode.
 */
export async function scanFolder(
  root: string,
  recursive: boolean,
  onProgress?: (p: ScanProgress) => void
): Promise<ScanResult> {
  // A new scan supersedes one already in flight.
  cancelScan()
  return walk(
    {
      recursive,
      maxPhotos: MAX_PHOTOS,
      maxDirs: MAX_DIRS,
      roots: [resolve(root)],
      mode: 'folder',
      label: resolve(root),
      driveRelative: false
    },
    onProgress
  )
}

/** Every readable drive on the machine, or a pre-resolved root list. */
export async function scanComputer(
  onProgress?: (p: ScanProgress) => void,
  roots?: string[]
): Promise<ScanResult> {
  cancelScan()
  const walkRoots =
    roots ??
    listDrives()
      .filter((drive) => !drive.unreadable)
      .map((drive) => drive.root)
  // Nothing readable at all is a real possibility on a locked-down machine, and an
  // empty root list would otherwise report a clean scan of nothing.
  if (walkRoots.length === 0) {
    return {
      root: 'This PC',
      photos: [],
      unreadable: 0,
      skippedDirs: 0,
      ms: 0,
      truncated: false,
      mode: 'computer',
      roots: [],
      canceled: false
    }
  }
  return walk(
    {
      recursive: true,
      maxPhotos: COMPUTER_MAX_PHOTOS,
      maxDirs: COMPUTER_MAX_DIRS,
      roots: walkRoots,
      mode: 'computer',
      label: 'This PC',
      driveRelative: true
    },
    onProgress
  )
}
