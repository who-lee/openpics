import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { layoutJustified, visibleRowRange } from '@/lib/layout'
import { useLibrary, useVisibleEntries } from '@/store/library'
import { Thumb } from './Thumb'
import { EmptyState, ScanningState } from './EmptyState'

const GAP = 6
const PADDING = 12

export function Grid() {
  const entries = useVisibleEntries()
  const query = useLibrary((s) => s.query)
  const status = useLibrary((s) => s.status)
  const totalCount = useLibrary((s) => s.photos.length)
  const rowHeight = useLibrary((s) => s.settings.rowHeight)
  const cursor = useLibrary((s) => s.cursor)
  const selected = useLibrary((s) => s.selected)
  const { select, open } = useLibrary()

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const frameRef = useRef(0)
  const detachRef = useRef<(() => void) | null>(null)

  /**
   * A callback ref, not a mount-once effect: the scroller is unmounted while the
   * empty state shows, so a `useLayoutEffect(..., [])` measured a null node, never
   * re-ran when the scan filled the library, and left the grid laid out at zero
   * usable width (one photo per row). Attaching on the node itself also re-attaches
   * the scroll listener, which has the same empty-state problem and would otherwise
   * stop the virtualiser tracking scroll position.
   */
  const attachScroller = useCallback((el: HTMLDivElement | null): void => {
    detachRef.current?.()
    detachRef.current = null
    scrollerRef.current = el
    if (!el) return

    const measure = (): void => {
      setWidth(el.clientWidth)
      setViewportHeight(el.clientHeight)
    }
    measure()

    // A virtualiser genuinely needs scroll position, so it reads it here and
    // coalesces to one state write per frame instead of per scroll event.
    const onScroll = (): void => {
      if (frameRef.current !== 0) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0
        setScrollTop(el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    const observer = new ResizeObserver(measure)
    observer.observe(el)

    detachRef.current = () => {
      observer.disconnect()
      el.removeEventListener('scroll', onScroll)
      if (frameRef.current !== 0) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
      }
    }
  }, [])

  useEffect(() => () => detachRef.current?.(), [])

  const layout = useMemo(
    () => layoutJustified(entries, width, rowHeight, GAP, PADDING),
    [entries, width, rowHeight]
  )

  const range = useMemo(
    () => visibleRowRange(layout, scrollTop, viewportHeight, 4),
    [layout, scrollTop, viewportHeight]
  )

  // Keyboard navigation moves the cursor, so bring the new tile into view.
  useEffect(() => {
    if (cursor < 0) return
    const el = scrollerRef.current?.querySelector(`[data-index="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [cursor])

  // The filter case is checked before the scanning one: a rescan of a filtered
  // library would otherwise replace "nothing matches" with a progress readout.
  if (entries.length === 0 && totalCount > 0) return <EmptyState filtered />
  if (totalCount === 0) {
    // Mounting the scroller while empty is what made the layout measure zero, so
    // the walk gets a placeholder that is not the virtualised container.
    return status === 'scanning' ? <ScanningState /> : <EmptyState />
  }

  const rows = layout.rows.slice(range.start, range.end + 1)

  return (
    <div ref={attachScroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div className="relative" style={{ height: layout.height, width: layout.width }}>
        {rows.map((row, rowOffset) => {
          const realIndex = range.start + rowOffset
          return (
            <div
              key={realIndex}
              className="absolute left-0 flex"
              style={{ top: row.top, height: row.height }}
            >
              {row.items.map((item) => (
                <Thumb
                  key={item.photo.path}
                  photo={item.photo}
                  index={item.index}
                  width={item.width}
                  height={item.height}
                  selected={selected.has(item.index)}
                  onOpen={open}
                  onSelect={select}
                />
              ))}
            </div>
          )
        })}
      </div>
      {query.trim() !== '' ? (
        <p className="px-3 py-6 text-center text-[12px] text-ink-3">
          <span className="num">{entries.length}</span> of{' '}
          <span className="num">{totalCount}</span> match the filter
        </p>
      ) : null}
    </div>
  )
}