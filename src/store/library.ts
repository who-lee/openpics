import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { DEFAULT_SETTINGS, comparePhotos, type DriveInfo, type Photo, type ScanProgress, type ScanResult, type Settings, type SortDir, type SortKey } from '@shared/protocol'
import { bridge } from '@/lib/bridge'

export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'error'

/** A photo paired with its position in the full library. */
export interface PhotoEntry {
  photo: Photo
  /** Index into `photos`, which is what selection, the viewer and the tray address. */
  index: number
}

interface LibraryState {
  settings: Settings
  raw: Photo[]
  photos: Photo[]
  /**
   * Library indices in display order: sorted, then narrowed by the filter. Every
   * consumer addresses photos through this list, so a filter can never make a
   * tile, the cursor and the viewer disagree about which photo is which.
   */
  visible: number[]
  status: ScanStatus
  error: string | null
  scanInfo: Omit<ScanResult, 'photos'> | null
  /** Live progress, present only while a scan is running. */
  progress: ScanProgress | null
  /** Drives found on the machine, for the computer-scan source. */
  drives: DriveInfo[]

  /** Index into `photos`, or null when the viewer is closed. */
  openIndex: number | null
  slideshowPlaying: boolean

  cursor: number
  anchor: number
  selected: Set<number>

  showInfo: boolean
  showShortcuts: boolean
  showSettings: boolean
  /** Whether the terminal drawer is showing. Its shells keep running when hidden. */
  terminalOpen: boolean
  query: string

  boot: () => Promise<void>
  rescan: () => Promise<void>
  pickFolder: () => Promise<void>
  /** Walks every drive on the machine, reporting progress into `progress`. */
  scanComputer: () => Promise<void>
  cancelScan: () => Promise<void>
  /** Shows the file Windows handed us and focuses its folder in the grid. */
  openFiles: (paths: string[]) => Promise<void>
  patch: (patch: Partial<Settings>) => Promise<void>
  setSort: (key: SortKey) => void
  setQuery: (query: string) => void

  select: (index: number, mode: 'replace' | 'toggle' | 'range') => void
  moveCursor: (delta: number, extend?: boolean) => void
  open: (index: number) => void
  close: () => void
  step: (delta: number) => void

  setSlideshow: (playing: boolean) => void
  toggleSlideshow: () => void
  toggleInfo: () => void
  toggleShortcuts: () => void
  setShowSettings: (open: boolean) => void
  setTerminalOpen: (open: boolean) => void
  toggleTerminal: () => void
}

function sortPhotos(raw: Photo[], key: SortKey, dir: SortDir): Photo[] {
  return [...raw].sort((a, b) => comparePhotos(a, b, key, dir))
}

/**
 * Directory containing a path.
 *
 * Written out rather than imported from `node:path` because this module runs in
 * the renderer, which is sandboxed and has no Node builtins. The rules here are
 * only the ones Windows paths actually follow: separators, and a drive root with
 * nothing after it.
 */
function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut < 0) return trimmed
  // Keep the separator when what remains is a bare drive root like "C:".
  if (cut <= 2) return trimmed.slice(0, 3)
  return trimmed.slice(0, cut)
}

function visibleIndices(photos: Photo[], query: string): number[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return photos.map((_, index) => index)
  const out: number[] = []
  for (let index = 0; index < photos.length; index++) {
    const photo = photos[index]!
    if (
      photo.name.toLowerCase().includes(needle) ||
      photo.relDir.toLowerCase().includes(needle)
    ) {
      out.push(index)
    }
  }
  return out
}

const initial: Settings = { ...DEFAULT_SETTINGS }

/**
 * Monotonic id of the most recently started scan.
 *
 * A walk takes seconds, and a second one can begin before the first resolves:
 * opening a file from Windows re-points the library, and the user can hit rescan
 * again mid-walk. Without a token the slower scan would land last and overwrite
 * the newer result, so a stale result is dropped instead.
 */
let scanGeneration = 0

/** The scan currently in flight, so a caller can wait for the library to settle. */
let pendingScan: Promise<void> | null = null

/**
 * Runs `run` as the active scan, recording it as in flight for its duration.
 *
 * Every scan goes through here so `pendingScan` cannot drift out of sync with
 * `scanGeneration`: the two are only ever assigned together.
 */
function beginScan(run: () => Promise<void>): Promise<void> {
  const promise = run().finally(() => {
    if (pendingScan === promise) pendingScan = null
  })
  pendingScan = promise
  return promise
}

type StoreGet = () => LibraryState
type StoreSet = (partial: Partial<LibraryState>) => void

/**
 * Commits a finished scan, unless a newer one has already started.
 *
 * Shared by both modes so the reset that follows a completed walk is identical:
 * any scan replaces the whole library, which means selection, cursor and the
 * viewer are all addressed against indices that no longer mean what they did.
 */
function applyScanResult(
  get: StoreGet,
  set: StoreSet,
  result: Omit<ScanResult, 'photos'> & { photos: Photo[] },
  generation: number
): void {
  if (generation !== scanGeneration) return
  const { photos: raw, ...rest } = result
  const { settings, query } = get()
  const photos = sortPhotos(raw, settings.sortKey, settings.sortDir)
  set({
    raw,
    photos,
    visible: visibleIndices(photos, query),
    status: 'ready',
    error: null,
    // Computer mode walks every drive, so there is no single root to report; the
    // list is the meaningful part and `root` falls back to the first one.
    scanInfo: { ...rest, root: result.root || result.roots?.[0] || '' },
    cursor: -1,
    anchor: -1,
    selected: new Set(),
    openIndex: null,
    slideshowPlaying: false
  })
}

export const useLibrary = create<LibraryState>((set, get) => ({
  settings: initial,
  raw: [],
  photos: [],
  visible: [],
  status: 'idle',
  error: null,
  scanInfo: null,
  progress: null,
  drives: [],

  openIndex: null,
  slideshowPlaying: false,

  cursor: -1,
  anchor: -1,
  selected: new Set(),

  showInfo: false,
  showShortcuts: false,
  showSettings: false,
  terminalOpen: false,
  query: '',

  async boot() {
    const settings = await bridge.settings.get()
    set({ settings })
    // Probing 26 drive letters is cheap, and knowing what is attached before the
    // user reaches for the button avoids a "no drives" surprise.
    const drives = await bridge.library.drives()
    set({ drives })
    // The persisted mode is the source the user last chose, so a machine left on
    // "This PC" has to come back up scanning drives rather than a stale folder.
    const scan = get().settings.scanMode === 'computer' ? get().scanComputer : get().rescan
    // Not awaited. On a cold start from "Open with", the file hand-off resolves
    // and calls `patch`, which starts a scan of the file's own folder; awaiting
    // here would make the hand-off wait on a scan whose result is about to be
    // thrown away, delaying the file the user actually asked to see.
    void scan()
  },

  async rescan() {
    return beginScan(async () => {
      const { settings } = get()
      const generation = ++scanGeneration
      // Same subscription as the computer walk, for the same reason: a deep
      // folder on a slow disk is not visibly different from a hang.
      const stop = bridge.library.onScanProgress((progress) => {
        if (progress.running && generation === scanGeneration) set({ progress })
      })
      set({ status: 'scanning', error: null, progress: null })
      try {
        const { root, photos: raw, ...rest } = await bridge.library.scan(
          settings.root,
          settings.recursive
        )
        applyScanResult(get, set, { ...rest, root, photos: raw }, generation)
      } catch (err) {
        if (generation !== scanGeneration) return
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'The folder could not be read.'
        })
      } finally {
        stop?.()
        if (generation === scanGeneration) set({ progress: null })
      }
    })
  },

  async scanComputer() {
    return beginScan(async () => {
      // Subscribed here rather than at module scope: a listener registered once
      // and never torn down leaks across hot reloads, and the progress channel is
      // only meaningful while a walk is actually running.
      const generation = ++scanGeneration
      const stop = bridge.library.onScanProgress((progress) => {
        // A progress event from a superseded walk would show the wrong numbers
        // over the scan the user is actually watching.
        if (progress.running && generation === scanGeneration) set({ progress })
      })
      set({ status: 'scanning', error: null, progress: null })
      try {
        const { root, photos: raw, ...rest } = await bridge.library.scanComputer()
        applyScanResult(get, set, { ...rest, root, photos: raw }, generation)
      } catch (err) {
        if (generation !== scanGeneration) return
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'This PC could not be scanned.'
        })
      } finally {
        stop?.()
        if (generation === scanGeneration) set({ progress: null })
      }
    })
  },

  async cancelScan() {
    await bridge.library.cancelScan()
  },

  async openFiles(paths) {
    if (paths.length === 0) return
    const first = paths[0]!
    const folder = parentDir(first)
    // The file may sit outside the current library, in computer mode or in
    // another folder entirely. Re-pointing at its folder and rescanning is what
    // guarantees the photo is actually in `photos` when it is opened.
    const { settings } = get()
    const needsRescan = settings.root !== folder || settings.scanMode !== 'folder'
    if (needsRescan) {
      await get().patch({ root: folder, scanMode: 'folder' })
    }
    // A scan started before this hand-off, such as the one `boot()` kicks off,
    // would otherwise land after the selection is made and clear it. Waiting
    // here costs nothing when the library is already settled.
    if (pendingScan) await pendingScan
    const { photos } = get()
    const wanted = new Set(paths.map((p) => p.toLowerCase()))
    const indices = photos
      .map((photo, index) => ({ photo, index }))
      .filter(({ photo }) => wanted.has(photo.path.toLowerCase()))
      .map(({ index }) => index)
    if (indices.length === 0) return
    const selected = new Set<number>(indices)
    set({ selected, cursor: indices[0]!, anchor: indices[0]!, openIndex: indices[0]! })
  },

  async pickFolder() {
    const result = await bridge.library.pick()
    if (result.canceled || !result.path) return
    // Choosing a folder is itself the choice of source. Without the explicit
    // mode, a user coming from "This PC" would pick a folder and watch a
    // whole-machine scan run instead of seeing what they just selected.
    await get().patch({ root: result.path, scanMode: 'folder' })
  },

  async patch(patch) {
    const settings = await bridge.settings.patch(patch)
    const state = get()
    const sortChanged = patch.sortKey !== undefined || patch.sortDir !== undefined
    const photos = sortChanged
      ? sortPhotos(state.raw, settings.sortKey, settings.sortDir)
      : state.photos
    set({ settings, photos, visible: visibleIndices(photos, state.query) })
    // Which source and how deep to walk both decide what exists on disk, so any
    // change to them has to re-read from disk rather than relabel the old set.
    if (patch.root !== undefined || patch.recursive !== undefined || patch.scanMode !== undefined) {
      if (settings.scanMode === 'computer') {
        await get().scanComputer()
      } else {
        await get().rescan()
      }
    }
  },

  setSort(key) {
    const { settings } = get()
    // Clicking the active key flips direction, which is what a sortable header should do.
    const dir: SortDir =
      settings.sortKey === key ? (settings.sortDir === 'asc' ? 'desc' : 'asc') : 'asc'
    void get().patch({ sortKey: key, sortDir: dir })
  },

  setQuery(query) {
    const { photos, cursor } = get()
    const visible = visibleIndices(photos, query)
    // Focus has to follow the filter, or the cursor would sit on a photo the
    // grid is no longer showing and Enter would open something invisible.
    const keepsCursor = visible.includes(cursor)
    set({
      query,
      visible,
      cursor: keepsCursor ? cursor : (visible[0] ?? -1),
      anchor: -1,
      selected: new Set()
    })
  },

  select(index, mode) {
    const { photos, anchor } = get()
    if (index < 0 || index >= photos.length) return
    const selected = new Set<number>()
    if (mode === 'replace') {
      selected.add(index)
    } else if (mode === 'toggle') {
      const current = get().selected
      for (const i of current) selected.add(i)
      if (current.has(index)) selected.delete(index)
      else selected.add(index)
    } else {
      const from = anchor < 0 ? index : anchor
      const lo = Math.min(from, index)
      const hi = Math.max(from, index)
      for (let i = lo; i <= hi; i++) selected.add(i)
    }
    set({ cursor: index, anchor: mode === 'range' ? anchor : index, selected })
  },

  moveCursor(delta, extend = false) {
    const { visible, cursor } = get()
    if (visible.length === 0) return
    const at = visible.indexOf(cursor)
    const from = at >= 0 ? at : delta > 0 ? -1 : visible.length
    const next = Math.min(visible.length - 1, Math.max(0, from + delta))
    get().select(visible[next]!, extend ? 'range' : 'replace')
  },

  open(index) {
    if (index < 0) return
    set({ openIndex: index, slideshowPlaying: false })
  },

  close() {
    set({ openIndex: null, slideshowPlaying: false, showInfo: false })
  },

  step(delta) {
    const { photos, openIndex, visible } = get()
    if (photos.length === 0) return
    const from = openIndex ?? get().cursor
    if (from < 0) return
    // Navigate the same set the grid shows, so a filtered library never
    // advances into a photo the user cannot see.
    const order = visible.length > 0 ? visible : photos.map((_, index) => index)
    const at = order.indexOf(from)
    const next = at < 0 ? order[0]! : order[(at + delta + order.length) % order.length]!
    set({ openIndex: next, cursor: next, anchor: next, selected: new Set([next]) })
  },

  setSlideshow(playing) {
    set({ slideshowPlaying: playing })
  },

  toggleSlideshow() {
    const { openIndex, slideshowPlaying } = get()
    if (openIndex === null) {
      const { cursor, visible } = get()
      const start = visible.includes(cursor) ? cursor : (visible[0] ?? -1)
      if (start < 0) return
      get().select(start, 'replace')
      set({ openIndex: start, slideshowPlaying: true })
      return
    }
    set({ slideshowPlaying: !slideshowPlaying })
  },

  toggleInfo() {
    const { openIndex, showInfo, cursor, visible } = get()
    if (openIndex === null) {
      // Asked for details from the grid, so open the picture being asked about.
      const target = visible.includes(cursor) ? cursor : (visible[0] ?? -1)
      if (target < 0) return
      get().select(target, 'replace')
      set({ openIndex: target, showInfo: true, slideshowPlaying: false })
      return
    }
    set({ showInfo: !showInfo })
  },

  toggleShortcuts() {
    set({ showShortcuts: !get().showShortcuts })
  },

  setShowSettings(open) {
    set({ showSettings: open })
  },

  setTerminalOpen(open) {
    set({ terminalOpen: open })
  },

  toggleTerminal() {
    set({ terminalOpen: !get().terminalOpen })
  }
}))

/**
 * Wires Windows' file hand-off into the store, once for the life of the window.
 *
 * Returns nothing and renders nothing; it exists to own the subscription so the
 * listener is not re-registered on every render of the component that calls it.
 */
export function useOpenFilesSubscription(): void {
  useEffect(() => {
    // No handshake to send here. Preload holds a file that arrives before this
    // effect exists and flushes it as soon as the listener is attached, and main
    // queues anything that arrives before the renderer is loaded at all. The
    // overlap those two buffers cover is why `openFiles` can await the boot scan
    // rather than racing it.
    return bridge.library.onOpenFiles((paths) => {
      void useLibrary.getState().openFiles(paths)
    })
  }, [])
}

export function useVisibleEntries(): PhotoEntry[] {
  const photos = useLibrary((s) => s.photos)
  const visible = useLibrary((s) => s.visible)
  return useMemo(
    () => visible.map((index) => ({ photo: photos[index]!, index })),
    [photos, visible]
  )
}