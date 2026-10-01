import { useEffect, useState } from 'react'
import { useLibrary } from '@/store/library'
import { bridge } from '@/lib/bridge'
import type { ThumbnailStats } from '@shared/protocol'
import { formatCount } from '@/lib/format'

export function StatusBar() {
  const photos = useLibrary((s) => s.photos)
  const selected = useLibrary((s) => s.selected)
  const status = useLibrary((s) => s.status)
  const info = useLibrary((s) => s.scanInfo)
  const progress = useLibrary((s) => s.progress)
  const [stats, setStats] = useState<ThumbnailStats | null>(null)

  useEffect(() => {
    const id = window.setInterval(() => {
      void bridge.library.thumbStats().then(setStats)
    }, 1500)
    return () => window.clearInterval(id)
  }, [])

  const totalBytes = photos.reduce((sum, photo) => sum + photo.bytes, 0)
  const notes: string[] = []

  if (status === 'scanning' && progress) {
    notes.push(
      `scanning drive ${progress.rootIndex + 1}/${progress.roots.length}, ${formatCount(progress.found)} so far`
    )
  } else if (status === 'scanning') {
    notes.push('scanning')
  }
  if (info?.canceled) notes.push('scan stopped early')
  if (info?.roots && info.roots.length > 0) {
    notes.push(`${info.roots.length} drive${info.roots.length === 1 ? '' : 's'}`)
  }
  if (info?.truncated) notes.push(`stopped at the ${formatCount(photos.length)} picture limit`)
  if (info && info.unreadable > 0) notes.push(`${formatCount(info.unreadable)} unreadable`)
  if (stats) notes.push(`${stats.hits}/${stats.hits + stats.misses} thumbs cached`)

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-3 border-t border-line px-3">
      <span className="num text-[11px] text-ink-2">
        {formatCount(photos.length)} pictures
      </span>
      {selected.size > 1 ? (
        <span className="num rounded-[3px] bg-accent-soft px-1.5 py-px text-[11px] text-accent-text">
          {formatCount(selected.size)} selected
        </span>
      ) : null}
      <span className="num text-[11px] text-ink-3">
        {(totalBytes / 1_000_000_000).toFixed(2)} GB total
      </span>
      {notes.length > 0 ? (
        <span className="num truncate text-[11px] text-ink-3">{notes.join('  |  ')}</span>
      ) : null}
      <span className="ml-auto flex items-center gap-3 text-[11px] text-ink-3">
        <span>
          <kbd className="num">Space</kbd> select
        </span>
        <span>
          <kbd className="num">Enter</kbd> open
        </span>
        <span>
          <kbd className="num">S</kbd> slideshow
        </span>
        <span>
          <kbd className="num">Ctrl+H</kbd> hide
        </span>
      </span>
    </footer>
  )
}