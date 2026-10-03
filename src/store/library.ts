import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { DEFAULT_SETTINGS, comparePhotos, type DriveInfo, type Photo, type ScanProgress, type ScanResult, type Settings, type SmartCollection, type SortDir, type SortKey } from '@shared/protocol'
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

  // Filters
  typeFilter: 'all' | 'image' | 'video'
  dateStart: number | null
  dateEnd: number | null
  sizeMin: number | null
  sizeMax: number | null
  cameraFilter: string
  tagFilter: string[]

  // Smart collections
  collections: SmartCollection[]
  activeCollectionId: string | null

  // AI
  aiDockExpanded: boolean
  aiDockWidth: number
  aiOpen: boolean
  aiThinking: boolean
  aiModelReady: boolean
  aiMessages: { role: 'user' | 'assistant'; content: string }[]
  photoTags: Map<string, string[]>
  exifCache: Map<string, unknown>

  /**
   * Counts the requests to open a picture straight into the editor.
   *
   * A counter rather than a boolean because asking for the same picture to be
   * opened and edited twice has to work: a flag the viewer cleared on the way in
   * would leave the second request with nothing left to read.
   */
  editRequest: number
  /** Clears the request once the viewer has acted on it. */
  clearEditRequest: () => void

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

  // Filters
  setTypeFilter: (type: 'all' | 'image' | 'video') => void
  setDateRange: (start: number | null, end: number | null) => void
  setSizeRange: (min: number | null, max: number | null) => void
  setCameraFilter: (camera: string) => void
  setTagFilter: (tags: string[]) => void
  clearAllFilters: () => void

  select: (index: number, mode: 'replace' | 'toggle' | 'range') => void
  /** Selects every currently visible photo. */
  selectAll: () => void
  /** Flips selection across the visible photos. */
  invertSelection: () => void
  /** Clears the selection and drops the anchor. */
  clearSelection: () => void
  moveCursor: (delta: number, extend?: boolean) => void
  open: (index: number) => void
  /** Opens a picture and asks the viewer to start an edit session on it. */
  openForEdit: (index: number) => void
  close: () => void
  step: (delta: number) => void
  /**
   * Drops pictures that are no longer on disk.
   *
   * Selection, the cursor and the viewer are all indices, and every one of them
   * has to survive the removal rather than silently start pointing at whatever
   * photo slid into the old slot.
   */
  forgetPaths: (paths: readonly string[]) => void

  /**
   * Records what a clip turned out to actually be.
   *
   * The scan deliberately leaves a clip's width, height and duration at zero
   * because measuring them means an ffprobe run per file, and a whole-drive walk
   * would then be tens of thousands of child processes. The `<video>` element
   * learns all three numbers for free the moment the clip is opened, so it hands
   * them back here and the grid, the info panel and the sort order stop treating
   * it as a zero-sized unknown.
   *
   * Called once per clip per open. Writing it through the same `photos` array
   * `visible` is derived from keeps the grid tile in step without a re-scan, and
   * a second call for the same clip is a no-op by construction.
   */
  learnClip: (index: number, media: { width: number; height: number; durationSeconds: number }) => void

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

/** Everything that narrows the library, combined with AND. */
export interface FilterCriteria {
  query: string
  typeFilter: 'all' | 'image' | 'video'
  dateStart: number | null
  dateEnd: number | null
  sizeMin: number | null
  sizeMax: number | null
  cameraFilter: string
  tagFilter: string[]
}

/** Pulls the filter slice out of the whole store state. */
function criteriaOf(state: LibraryState): FilterCriteria {
  return {
    query: state.query,
    typeFilter: state.typeFilter,
    dateStart: state.dateStart,
    dateEnd: state.dateEnd,
    sizeMin: state.sizeMin,
    sizeMax: state.sizeMax,
    cameraFilter: state.cameraFilter,
    tagFilter: state.tagFilter
  }
}

/** True when any filter would hide something, so the UI can show an active count. */
export function activeFilterCount(state: LibraryState): number {
  let count = 0
  if (state.query.trim() !== '') count++
  if (state.typeFilter !== 'all') count++
  if (state.dateStart !== null || state.dateEnd !== null) count++
  if (state.sizeMin !== null || state.sizeMax !== null) count++
  if (state.cameraFilter.trim() !== '') count++
  if (state.tagFilter.length > 0) count++
  return count
}

/** Camera/model recorded for a path, when EXIF has been read. Empty otherwise. */
function cameraOf(cache: Map<string, unknown>, path: string): string {
  const entry = cache.get(path)
  if (entry && typeof entry === 'object') {
    const value = entry as { camera?: unknown; model?: unknown; Make?: unknown; Model?: unknown }
    for (const candidate of [value.camera, value.model, value.Make, value.Model]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
  }
  return ''
}

function matchesFilters(
  photo: Photo,
  filters: FilterCriteria,
  tags: Map<string, string[]>,
  exif: Map<string, unknown>
): boolean {
  const needle = filters.query.trim().toLowerCase()
  if (
    needle !== '' &&
    !photo.name.toLowerCase().includes(needle) &&
    !photo.relDir.toLowerCase().includes(needle)
  ) {
    return false
  }
  if (filters.typeFilter === 'image' && photo.kind !== 'photo') return false
  if (filters.typeFilter === 'video' && photo.kind !== 'video') return false
  if (filters.dateStart !== null && photo.mtime < filters.dateStart) return false
  if (filters.dateEnd !== null && photo.mtime > filters.dateEnd) return false
  if (filters.sizeMin !== null && photo.bytes < filters.sizeMin) return false
  if (filters.sizeMax !== null && photo.bytes > filters.sizeMax) return false
  const camera = filters.cameraFilter.trim().toLowerCase()
  if (camera !== '' && !cameraOf(exif, photo.path).toLowerCase().includes(camera)) return false
  if (filters.tagFilter.length > 0) {
    const owned = tags.get(photo.path) ?? []
    if (!filters.tagFilter.every((tag) => owned.includes(tag))) return false
  }
  return true
}

function visibleIndices(
  photos: Photo[],
  filters: FilterCriteria,
  tags: Map<string, string[]>,
  exif: Map<string, unknown>
): number[] {
  const out: number[] = []
  for (let index = 0; index < photos.length; index++) {
    if (matchesFilters(photos[index]!, filters, tags, exif)) out.push(index)
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
 * Applies a filter change and re-derives everything that depends on the filter.
 *
 * Cursor, anchor and selection are all library indices, so narrowing the set can
 * leave any of them pointing at a photo the grid no longer shows. Recomputing the
 * visible list first and then settling each reference is what keeps a tile, the
 * cursor and the viewer from disagreeing about which picture is which.
 */
function applyFilterChange(
  get: StoreGet,
  set: StoreSet,
  patch: Partial<FilterCriteria>
): void {
  const state = get()
  const criteria: FilterCriteria = { ...criteriaOf(state), ...patch }
  const visible = visibleIndices(state.photos, criteria, state.photoTags, state.exifCache)
  const keepsCursor = visible.includes(state.cursor)
  set({
    ...patch,
    visible,
    cursor: keepsCursor ? state.cursor : (visible[0] ?? -1),
    anchor: -1,
    selected: new Set()
  })
}

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
  const { settings } = get()
  const photos = sortPhotos(raw, settings.sortKey, settings.sortDir)
  set({
    raw,
    photos,
    visible: visibleIndices(photos, criteriaOf(get()), get().photoTags, get().exifCache),
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

  typeFilter: 'all',
  dateStart: null,
  dateEnd: null,
  sizeMin: null,
  sizeMax: null,
  cameraFilter: '',
  tagFilter: [],

  collections: [],
  activeCollectionId: null,

  aiDockExpanded: initial.aiDockExpanded ?? true,
  aiDockWidth: initial.aiDockWidth ?? 360,
  aiOpen: initial.aiDockExpanded ?? true,
  aiThinking: false,
  aiModelReady: false,
  aiMessages: [],
  photoTags: new Map(),
  exifCache: new Map(),

  editRequest: 0,

  clearEditRequest() {
    if (get().editRequest !== 0) set({ editRequest: 0 })
  },

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
    set({ settings, photos, visible: visibleIndices(photos, criteriaOf(state), state.photoTags, state.exifCache) })
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
    applyFilterChange(get, set, { query })
  },

  setTypeFilter(typeFilter) {
    applyFilterChange(get, set, { typeFilter })
  },

  setDateRange(dateStart, dateEnd) {
    applyFilterChange(get, set, { dateStart, dateEnd })
  },

  setSizeRange(sizeMin, sizeMax) {
    applyFilterChange(get, set, { sizeMin, sizeMax })
  },

  setCameraFilter(cameraFilter) {
    applyFilterChange(get, set, { cameraFilter })
  },

  setTagFilter(tagFilter) {
    applyFilterChange(get, set, { tagFilter })
  },

  clearAllFilters() {
    applyFilterChange(get, set, {
      query: '',
      typeFilter: 'all',
      dateStart: null,
      dateEnd: null,
      sizeMin: null,
      sizeMax: null,
      cameraFilter: '',
      tagFilter: []
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

  selectAll() {
    const { visible, cursor } = get()
    set({
      selected: new Set(visible),
      anchor: -1,
      cursor: visible.includes(cursor) ? cursor : (visible[0] ?? -1)
    })
  },

  invertSelection() {
    const { visible, selected } = get()
    const next = new Set<number>()
    for (const index of visible) {
      if (!selected.has(index)) next.add(index)
    }
    set({ selected: next, anchor: -1 })
  },

  clearSelection() {
    if (get().selected.size === 0 && get().anchor === -1) return
    set({ selected: new Set(), anchor: -1 })
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

  openForEdit(index) {
    const { photos } = get()
    if (index < 0 || index >= photos.length) return
    // A clip has no picture to edit, and the viewer's editor is built for stills.
    if (photos[index]?.kind !== 'photo') return
    get().open(index)
    set({ editRequest: get().editRequest + 1 })
  },

  close() {
    set({ openIndex: null, slideshowPlaying: false, showInfo: false })
  },

  forgetPaths(paths) {
    if (paths.length === 0) return
    const { raw, photos, cursor, anchor, selected, openIndex } = get()
    // Windows compares paths without regard to case, so this has to as well. A
    // mismatch here would leave a deleted file sitting in the grid forever.
    const gone = new Set(paths.map((path) => path.toLowerCase()))
    const keep = (list: Photo[]): Photo[] => list.filter((photo) => !gone.has(photo.path.toLowerCase()))
    const nextPhotos = keep(photos)
    const nextRaw = keep(raw)
    if (nextPhotos.length === photos.length) return

    /**
     * Where each surviving photo ended up.
     *
     * Built from the photo's own path rather than by counting removals, so a
     * path the caller did not mention cannot shift an index that matters.
     */
    const moved = new Map<string, number>()
    nextPhotos.forEach((photo, index) => moved.set(photo.path, index))
    const remap = (path: string | undefined): number =>
      path === undefined ? -1 : (moved.get(path) ?? -1)

    /**
     * Keeps an index meaningful after the list it points into has shrunk.
     *
     * A surviving photo keeps pointing at itself; one that was deleted falls back
     * to the nearest photo still standing, which is the row the user is now
     * looking at anyway.
     */
    const settle = (index: number): number => {
      if (index < 0) return -1
      const survived = remap(photos[index]?.path)
      if (survived >= 0) return survived
      for (let i = index; i < photos.length; i++) {
        const found = remap(photos[i]?.path)
        if (found >= 0) return found
      }
      for (let i = index - 1; i >= 0; i--) {
        const found = remap(photos[i]?.path)
        if (found >= 0) return found
      }
      return -1
    }

    const nextSelected = new Set<number>()
    for (const index of selected) {
      const found = remap(photos[index]?.path)
      if (found >= 0) nextSelected.add(found)
    }

    /**
     * What to do with the viewer, given the file it was showing.
     *
     * If the open file was deleted, the viewer has to close: it would be showing
     * bytes that are gone, and any editor session belongs to those bytes. If the
     * open file survived, the viewer stays open but has to follow it to its new
     * index, or deleting some *other* picture in the same row would silently swap
     * the viewer onto a different one.
     */
    const viewer =
      openIndex === null
        ? {}
        : remap(photos[openIndex]?.path) < 0
          ? { openIndex: null, slideshowPlaying: false, showInfo: false }
          : { openIndex: remap(photos[openIndex]?.path) }

    set({
      raw: nextRaw,
      photos: nextPhotos,
      visible: visibleIndices(nextPhotos, criteriaOf(get()), get().photoTags, get().exifCache),
      cursor: settle(cursor),
      anchor: settle(anchor),
      selected: nextSelected,
      ...viewer
    })
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

  learnClip(index, media) {
    const { photos } = get()
    const current = photos[index]
    // A failed or zero-length read leaves the item exactly as the scan wrote it,
    // which is better than storing a width of 0 next to a real duration.
    if (!current || current.kind !== 'video') return
    if (media.width <= 0 || media.height <= 0) return
    const next = [...photos]
    next[index] = { ...current, ...media }
    set({ photos: next })
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