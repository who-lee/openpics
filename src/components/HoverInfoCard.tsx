import { useLayoutEffect, useRef, useState } from 'react'
import { CalendarBlank, File, Folder, Image as ImageIcon, Ruler, Video } from '@phosphor-icons/react'
import type { Photo } from '@shared/protocol'
import {
  formatBytes,
  formatDate,
  formatDimensions,
  formatDuration,
  formatMegapixels,
  prettyPath
} from '@/lib/format'

/** Width of the card, fixed so the placement maths below can be done up front. */
const CARD_WIDTH = 248
const CARD_GAP = 10
/** Distance kept from the window edge, so the card never sits flush against it. */
const EDGE = 8

export interface HoverCard {
  photo: Photo
  /** The tile's viewport rectangle, taken when the pointer arrived. */
  rect: DOMRect
}

interface HoverInfoCardProps {
  card: HoverCard
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-[3px] text-[11px] leading-tight">
      {children}
    </div>
  )
}

/**
 * Details for a tile the pointer is resting on.
 *
 * Positioned `fixed` against the tile's viewport rectangle rather than absolutely
 * inside the tile. The grid is a virtualiser inside an `overflow-y-auto`
 * scroller, so anything anchored inside a tile is clipped by the scroller's
 * edges and scrolls away with the row it belongs to; a fixed box placed in
 * viewport coordinates stays put and can extend past the grid without being cut.
 */
export function HoverInfoCard({ card }: HoverInfoCardProps) {
  const { photo, rect } = card
  const isClip = photo.kind === 'video'
  const ref = useRef<HTMLDivElement>(null)

  const megapixels = formatMegapixels(photo.width, photo.height)
  const measured = photo.width > 0 && photo.height > 0
  const duration = formatDuration(photo.durationSeconds)

  /**
   * Placed below the tile, then flipped above it when there is not room.
   *
   * Measured after the first paint rather than guessed at. The card's height
   * depends on which rows survived - an unmeasured clip has no dimensions row and
   * no duration row - so any fixed estimate is wrong for some files, and wrong in
   * the one direction that matters: a card clipped by the bottom edge is a card
   * that loses the size and date, which is most of what it was for.
   */
  const [below, setBelow] = useState(true)
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0
    setBelow(rect.bottom + CARD_GAP + height <= window.innerHeight - EDGE)
  }, [rect, photo])

  const left = Math.min(
    Math.max(EDGE, rect.left),
    Math.max(EDGE, window.innerWidth - CARD_WIDTH - EDGE)
  )
  const anchorStyle = below
    ? { top: Math.max(EDGE, rect.bottom + CARD_GAP), left }
    : { bottom: Math.max(EDGE, window.innerHeight - rect.top + CARD_GAP), left }

  return (
    <div
      ref={ref}
      role="tooltip"
      style={{ ...anchorStyle, width: CARD_WIDTH }}
      className="pointer-events-none fixed z-40 rounded-[6px] border border-line bg-surface px-3 py-2 shadow-[var(--shadow-tint)]"
    >
      <p className="break-all pb-1.5 text-[12px] font-medium leading-snug">{photo.name}</p>

      <div className="border-t border-line pt-1.5">
        <Line>
          <span className="w-[14px] shrink-0 text-ink-3">
            {isClip ? (
              <Video size={12} weight="regular" aria-hidden="true" />
            ) : (
              <Ruler size={12} weight="regular" aria-hidden="true" />
            )}
          </span>
          <span className="num min-w-0 flex-1 truncate text-ink">
            {measured ? (
              <>
                {formatDimensions(photo.width, photo.height)}
                {megapixels ? <span className="text-ink-3"> &middot; {megapixels}</span> : null}
              </>
            ) : (
              <span className="text-ink-3">{isClip ? 'Not measured yet' : 'unknown size'}</span>
            )}
          </span>
        </Line>

        {/* A clip's duration is zero until the viewer has played it once, so this
            row is absent rather than claiming the clip is 0 seconds long. */}
        {duration ? (
          <Line>
            <span className="w-[14px] shrink-0 text-ink-3">
              <Video size={12} weight="regular" aria-hidden="true" />
            </span>
            <span className="num text-ink">{duration}</span>
          </Line>
        ) : null}

        <Line>
          <span className="w-[14px] shrink-0 text-ink-3">
            <ImageIcon size={12} weight="regular" aria-hidden="true" />
          </span>
          <span className="num text-ink">{photo.ext.toUpperCase()}</span>
        </Line>

        <Line>
          <span className="w-[14px] shrink-0 text-ink-3">
            <File size={12} weight="regular" aria-hidden="true" />
          </span>
          <span className="num text-ink">{formatBytes(photo.bytes)}</span>
        </Line>

        <Line>
          <span className="w-[14px] shrink-0 text-ink-3">
            <CalendarBlank size={12} weight="regular" aria-hidden="true" />
          </span>
          <span className="num text-ink">{formatDate(photo.mtime)}</span>
        </Line>

        {photo.relDir !== '' ? (
          <Line>
            <span className="w-[14px] shrink-0 text-ink-3">
              <Folder size={12} weight="regular" aria-hidden="true" />
            </span>
            <span className="num min-w-0 flex-1 truncate text-ink" title={photo.relDir}>
              {prettyPath(photo.relDir)}
            </span>
          </Line>
        ) : null}
      </div>
    </div>
  )
}