import { memo, useEffect, useRef, useState } from 'react'
import { Video } from '@phosphor-icons/react'
import { NATIVELY_DECODABLE, thumbUrl, type Photo } from '@shared/protocol'

interface ThumbProps {
  photo: Photo
  width: number
  height: number
  index: number
  selected: boolean
  onOpen: (index: number) => void
  onSelect: (index: number, mode: 'replace' | 'toggle' | 'range') => void
  /** Reports the pointer arriving and leaving, with the tile's viewport box. */
  onHover: (index: number, rect: DOMRect | null) => void
  onContext: (index: number, x: number, y: number) => void
}

/**
 * Formats Windows indexes as pictures but Chromium cannot decode. They are
 * listed so the library is honest about what is on disk, and the tile says
 * which format it is instead of showing a broken image.
 */
function isDecodable(photo: Photo): boolean {
  return NATIVELY_DECODABLE.has(photo.ext)
}

/**
 * Clips get a labelled tile rather than a thumbnail.
 *
 * A real poster frame is one ffmpeg run per clip, and a grid can be showing a
 * few hundred tiles at once, so generating them would mean fanning out into
 * hundreds of concurrent child processes and writing hundreds of files nobody
 * asked for. The viewer shows the real first frame as soon as the clip is opened,
 * which is the only moment a poster is actually worth having.
 *
 * `PLAYABLE` is the containers Chromium's media stack can decode. FLV, WMV, MPEG
 * program streams and the MPEG-TS family are not in it; those tiles say so instead
 * of implying a clip that will not play.
 */
const PLAYABLE = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', '3gp'])

function ThumbImpl({ photo, width, height, index, selected, onOpen, onSelect, onHover, onContext }: ThumbProps) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    // Re-arm the skeleton whenever the tile is recycled for a different photo.
    setState('loading')
  }, [photo.path])

  const isClip = photo.kind === 'video'
  const playable = PLAYABLE.has(photo.ext)
  // A clip never goes through the thumbnail scheme, so the image branch is off
  // and its `state` stays 'loading' forever - hence the explicit `decodable` gate
  // on the skeleton below rather than relying on the load callbacks.
  const decodable = !isClip && isDecodable(photo)

  return (
    <button
      type="button"
      data-index={index}
      aria-label={photo.name}
      aria-pressed={selected}
      onClick={(event) => {
        onSelect(index, event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'range' : 'replace')
      }}
      onDoubleClick={() => onOpen(index)}
      onContextMenu={(event) => {
        // The native menu is what Electron would otherwise put here, and it is
        // about the file rather than about what this app can do with it.
        event.preventDefault()
        onContext(index, event.clientX, event.clientY)
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return
        onHover(index, event.currentTarget.getBoundingClientRect())
      }}
      onPointerLeave={() => onHover(index, null)}
      // Dragging out of a tile to drop a file on it must not read as the pointer
      // simply resting somewhere else, or the card pops up over whatever the
      // pointer passed on the way out.
      onDragLeave={() => onHover(index, null)}
      style={{ width, height }}
      className={[
        'group relative shrink-0 overflow-hidden rounded-[3px] bg-skeleton',
        'transition-[box-shadow,transform] duration-150 active:translate-y-px',
        selected
          ? 'shadow-[0_0_0_2px_var(--c-accent)]'
          : 'shadow-[0_0_0_1px_var(--c-line)] hover:shadow-[0_0_0_1px_var(--c-line-strong)]'
      ].join(' ')}
    >
      {decodable ? (
        <img
          ref={imgRef}
          src={thumbUrl(photo.path)}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onLoad={() => setState('ready')}
          onError={() => setState('failed')}
          className={[
            'h-full w-full object-cover transition-opacity duration-200',
            state === 'ready' ? 'opacity-100' : 'opacity-0'
          ].join(' ')}
        />
      ) : null}

      {state !== 'ready' && decodable ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-pulse bg-skeleton"
          style={{ animationDelay: `${(index % 12) * 40}ms` }}
        />
      ) : null}

      {isClip ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-raised text-ink-3">
          <Video size={22} weight="regular" aria-hidden="true" />
          <span className="num rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] uppercase">
            {photo.ext}
          </span>
          {!playable ? (
            <span className="px-2 text-center text-[10px] leading-tight">No built-in player</span>
          ) : null}
        </span>
      ) : null}

      {!isClip && (!decodable || state === 'failed') ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-raised text-ink-3">
          <span className="num rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] uppercase">
            {photo.ext}
          </span>
          <span className="px-2 text-center text-[10px] leading-tight">
            {decodable ? 'Cannot preview' : 'No built-in decoder'}
          </span>
        </span>
      ) : null}

      {selected ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.55),transparent_38%)]"
        />
      ) : null}

      <span
        aria-hidden="true"
        className={[
          'num pointer-events-none absolute inset-x-0 bottom-0 truncate px-1.5 pb-1 pt-4 text-[10px] text-white/85',
          'transition-opacity duration-150',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        ].join(' ')}
      >
        {photo.name}
      </span>
    </button>
  )
}

export const Thumb = memo(ThumbImpl)