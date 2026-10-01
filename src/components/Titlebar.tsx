import { ImageSquare } from '@phosphor-icons/react'
import { useLibrary } from '@/store/library'
import { prettyPath } from '@/lib/format'

/**
 * The window uses a native caption overlay, so this strip is our own titlebar:
 * a drag region that also carries the wordmark and the folder being shown.
 * The right padding keeps content clear of the system caption buttons.
 */
export function Titlebar() {
  const root = useLibrary((s) => s.settings.root)
  const count = useLibrary((s) => s.photos.length)

  return (
    <header className="drag caption-safe flex h-[var(--titlebar-h)] shrink-0 items-center gap-2.5 border-b border-line px-3">
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] bg-accent">
        <ImageSquare size={12} weight="fill" color="#ffffff" />
      </span>
      <span className="text-[13px] font-semibold tracking-[-0.01em]">OpenPics</span>
      <span className="h-3 w-px bg-line-strong" aria-hidden="true" />
      <span className="min-w-0 truncate text-[12px] text-ink-2" title={root}>
        {prettyPath(root)}
      </span>
      <span className="num ml-auto shrink-0 text-[11px] text-ink-3">
        {count.toLocaleString()}
      </span>
    </header>
  )
}