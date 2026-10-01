import { memo, useEffect, useRef, useState } from 'react'
import { NATIVELY_DECODABLE, thumbUrl, type Photo } from '@shared/protocol'

interface ThumbProps {
  photo: Photo
  width: number
  height: number
  index: number
  selected: boolean
  onOpen: (index: number) => void
  onSelect: (index: number, mode: 'replace' | 'toggle' | 'range') => void
}

/**
 * Formats Windows indexes as pictures but Chromium cannot decode. They are
 * listed so the library is honest about what is on disk, and the tile says
 * which format it is instead of showing a broken image.
 */
function isDecodable(photo: Photo): boolean {
  return NATIVELY_DECODABLE.has(photo.ext)
}

function ThumbImpl({ photo, width, height, index, selected, onOpen, onSelect }: ThumbProps) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    // Re-arm the skeleton whenever the tile is recycled for a different photo.
    setState('loading')
  }, [photo.path])

  const decodable = isDecodable(photo)

  return (
    <button
      type="button"
      data-index={index}
      title={`${photo.name}${photo.relDir ? ` in ${photo.relDir}` : ''}`}
      aria-label={photo.name}
      aria-pressed={selected}
      onClick={(event) => {
        onSelect(index, event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'range' : 'replace')
      }}
      onDoubleClick={() => onOpen(index)}
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

      {!decodable || state === 'failed' ? (
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