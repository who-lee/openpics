import { aspectOf, type Photo } from '@shared/protocol'
import type { PhotoEntry } from '@/store/library'

/** Aspect ratios outside this band make rows unusable, so layout clamps to it. */
const MIN_ASPECT = 0.28
const MAX_ASPECT = 4.6

export interface Placed {
  photo: Photo
  index: number
  x: number
  width: number
  height: number
}

export interface Row {
  top: number
  height: number
  items: Placed[]
}

export interface Layout {
  rows: Row[]
  height: number
  width: number
}

function safeAspect(entry: PhotoEntry): number {
  const raw = aspectOf(entry.photo)
  if (!Number.isFinite(raw) || raw <= 0) return 4 / 3
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, raw))
}

/**
 * Justified rows, the layout every serious photo browser uses: every row is
 * scaled so its images exactly fill the container width, and no image is ever
 * cropped or letterboxed. The final row keeps the target height rather than
 * stretching, so a short tail row does not look broken.
 *
 * Takes entries rather than bare photos so each tile keeps its library index
 * instead of its position in whatever subset is on screen.
 *
 * Pure function, so the virtualiser can recompute it cheaply on resize.
 */
export function layoutJustified(
  entries: PhotoEntry[],
  containerWidth: number,
  targetHeight: number,
  gap: number,
  padding: number
): Layout {
  const usable = Math.max(120, containerWidth - padding * 2)
  const target = Math.max(56, targetHeight)
  const rows: Row[] = []
  let top = 0

  let pending: PhotoEntry[] = []
  let pendingAspect = 0

  const flush = (isLast: boolean): void => {
    if (pending.length === 0) return
    const count = pending.length
    const gaps = gap * (count - 1)
    const height = isLast ? target : Math.max(48, (usable - gaps) / pendingAspect)

    let x = padding
    const items: Placed[] = []
    for (let i = 0; i < count; i++) {
      const entry = pending[i]!
      const width = safeAspect(entry) * height
      items.push({ photo: entry.photo, index: entry.index, x, width, height })
      x += width + gap
    }
    rows.push({ top, height, items })
    top += height + gap
    pending = []
    pendingAspect = 0
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    pending.push(entry)
    pendingAspect += safeAspect(entry)

    const projected = pendingAspect * target + gap * (pending.length - 1)
    if (projected >= usable) {
      const isLast = i === entries.length - 1
      flush(isLast)
    }
  }
  flush(entries.length > 0 && pending.length > 0)

  return { rows, height: Math.max(0, top - gap), width: containerWidth }
}

/** Row indices whose vertical band intersects the viewport, plus an overscan buffer. */
export function visibleRowRange(
  layout: Layout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 3
): { start: number; end: number } {
  const rows = layout.rows
  if (rows.length === 0) return { start: 0, end: 0 }

  let start = 0
  let end = rows.length - 1

  // Rows are sorted by top, so a binary search on both bounds is correct.
  const topBound = scrollTop - 1
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((rows[mid]!.top + rows[mid]!.height) < topBound) lo = mid + 1
    else hi = mid
  }
  start = lo

  const bottomBound = scrollTop + viewportHeight
  lo = start
  hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (rows[mid]!.top > bottomBound) hi = mid - 1
    else lo = mid
  }
  end = lo

  return {
    start: Math.max(0, start - overscan),
    end: Math.min(rows.length - 1, end + overscan)
  }
}