import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { layoutJustified, visibleRowRange } from '@/lib/layout'
import { useLibrary, useVisibleEntries, type PhotoEntry } from '@/store/library'
import { Thumb } from './Thumb'
import { EmptyState, ScanningState } from './EmptyState'
import { HoverInfoCard, type HoverCard } from './HoverInfoCard'
import { PhotoContextMenu, type MenuRequest } from './PhotoContextMenu'
import { SelectionBar } from './SelectionBar'

const GAP = 6
const PADDING = 12

/**
 * How long the pointer must rest on a tile before its details appear.
 *
 * Without a wait, sweeping the hand across the grid strobes a card per tile,
 * which is worse than no card at all. Long enough to be deliberate, short enough
 * that a user who has stopped moving has it immediately.
 */
const HOVER_DELAY_MS = 260

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
   * The tile the pointer is resting on, and the right-click menu.
   *
   * Held here rather than inside a tile because both are positioned against the
   * viewport and outlive the virtualised row that produced them: a card anchored
   * to a tile that has since been recycled would describe a different picture.
   */
  const [hover, setHover] = useState<HoverCard | null>(null)
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const hoverTimer = useRef(0)
  /**
   * The request waiting on the hover delay, if any.
   *
   * Kept outside the render so a tile that is recycled while the pointer is still
   * down cannot resurrect a card for a picture that has been virtualised away.
   */
  const pendingHover = useRef<{ index: number; rect: DOMRect } | null>(null)

  /**
   * Retires the hover card and the menu together, and cancels a hover still waiting
   * on its delay, so a card cannot appear after the pointer has already left.
   *
   * Declared before the scroller wiring because scrolling is one of the things that
   * has to dismiss it.
   */
  const dismiss = useCallback((): void => {
    window.clearTimeout(hoverTimer.current)
    pendingHover.current = null
    setHover(null)
    setMenu(null)
  }, [])

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

    /**
     * Scrolling also retires the hover card and the menu.
     *
     * Both are placed against a rectangle measured when the pointer arrived, so the
     * moment the grid moves that rectangle describes a different place on screen and
     * the card drifts away from its own tile. The menu has the same problem, and
     * worse: its rows would act on a selection whose rows have since moved. This
     * covers cursor navigation too, because that scrolls the grid.
     *
     * Bound here rather than in an effect so it survives the empty state swapping
     * the scroller out and back.
     */
    el.addEventListener('scroll', dismiss, { passive: true })

    const observer = new ResizeObserver(measure)
    observer.observe(el)

    detachRef.current = () => {
      observer.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('scroll', dismiss)
      if (frameRef.current !== 0) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = 0
      }
    }
  }, [dismiss])

  useEffect(() => () => detachRef.current?.(), [])

  const layout = useMemo(
    () => layoutJustified(entries, width, rowHeight, GAP, PADDING),
    [entries, width, rowHeight]
  )

  const range = useMemo(
    () => visibleRowRange(layout, scrollTop, viewportHeight, 4),
    [layout, scrollTop, viewportHeight]
  )

  // Keyboard navigation moves the cursor, so bring the new tile into view. This
  // scrolls the grid, which dismisses the overlays below, so it has to be declared
  // before them: `scrollIntoView` moves a row under the pointer and a card left in
  // place would then be describing wherever that row ended up.
  useEffect(() => {
    if (cursor < 0) return
    const el = scrollerRef.current?.querySelector(`[data-index="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [cursor])

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  /**
   * Shows a tile's details once the pointer has rested on it.
   *
   * Only fires for the tile it was called for. A fast pass across the grid calls
   * this repeatedly, and a card that appeared for whatever tile was last under
   * the pointer would flicker through every picture between two.
   */
  const onHover = useCallback((index: number, rect: DOMRect | null): void => {
    window.clearTimeout(hoverTimer.current)
    pendingHover.current = rect === null ? null : { index, rect }
    if (rect === null) {
      setHover(null)
      return
    }
    hoverTimer.current = window.setTimeout(() => {
      const waiting = pendingHover.current
      pendingHover.current = null
      if (waiting === null || waiting.index !== index) return
      // `entries` is the visible list, so the tile's library index is looked up
      // rather than used to index the array; a filtered library would otherwise
      // show the details of whichever photo happened to sit in that slot.
      const photo = entries.find((item) => item.index === index)?.photo
      if (photo) setHover({ photo, rect: waiting.rect })
    }, HOVER_DELAY_MS)
  }, [entries])

  /**
   * Opens the menu for a right-click, aimed at the clicked tile or, when the
   * pointer landed on a tile that is already selected, at the whole selection.
   *
   * The same rule Windows uses: right-clicking inside an existing selection keeps
   * it, because the user is addressing the selection and not asking to start a
   * new one.
   */
  const onContext = useCallback(
    (index: number, x: number, y: number): void => {
      const withinSelection = selected.size > 1 && selected.has(index)
      if (!withinSelection) select(index, 'replace')
      const indices = withinSelection ? [...selected].sort((a, b) => a - b) : [index]
      // `indices` are library indices, so the visible rows have to be searched for
      // them. Indexing `entries` by them instead would pick out whatever photos
      // happened to sit in those slots, which under a filter is a different set.
      const targets = indices
        .map((wanted) => entries.find((item) => item.index === wanted))
        .filter((item): item is PhotoEntry => item !== undefined)
      if (targets.length === 0) return
      window.clearTimeout(hoverTimer.current)
      setHover(null)
      setMenu({ x, y, entries: targets })
    },
    [selected, entries, select]
  )

  /**
   * A card or menu outlives the rows that produced them, and a resize re-flows the
   * layout, so either can be left describing a picture at a position that no longer
   * exists. The row count is the cheapest signal for that; a resize that changes
   * nothing about the layout leaves them alone, and a resize is not something that
   * should interrupt a user reading them.
   */
  const rowCount = layout.rows.length
  useEffect(() => {
    dismiss()
  }, [rowCount, dismiss])

  /**
   * Drops the overlays once there is nothing left for them to describe.
   *
   * An effect rather than a call in the empty-state branch further down, because
   * setting state while rendering is not allowed and that branch returns before the
   * overlays would otherwise be reached.
   */
  useEffect(() => {
    if (entries.length === 0 || totalCount === 0) dismiss()
  }, [entries.length, totalCount, dismiss])

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
    <>
      <SelectionBar />
      <div
        ref={attachScroller}
        onPointerDown={dismiss}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
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
                    onHover={onHover}
                    onContext={onContext}
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

      {hover ? <HoverInfoCard card={hover} /> : null}
      {menu ? <PhotoContextMenu request={menu} onClose={() => setMenu(null)} /> : null}
    </>
  )
}




