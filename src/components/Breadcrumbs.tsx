import { CaretRight, ArrowUp } from '@phosphor-icons/react'
import { useLibrary } from '../store/library'

interface Crumb {
  label: string
  path: string
}

/** Splits a Windows or POSIX path into clickable segments, drive letter included. */
function splitPath(path: string): Crumb[] {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (!trimmed) return []
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const parts = trimmed.split(/[\\/]/)
  const crumbs: Crumb[] = []
  let accumulated = ''
  for (let index = 0; index < parts.length; index++) {
    accumulated = index === 0 ? parts[index]! : `${accumulated}${sep}${parts[index]}`
    crumbs.push({ label: parts[index]!, path: accumulated })
  }
  return crumbs
}

/** Parent of a path, or null when there is nowhere left to go. */
function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  // A drive root such as "C:" or "C:\" has no parent.
  if (cut < 0 || cut <= 2) return null
  return trimmed.slice(0, cut)
}

export function Breadcrumbs() {
  const root = useLibrary((s) => s.settings.root)
  const scanMode = useLibrary((s) => s.settings.scanMode)
  const status = useLibrary((s) => s.status)
  const patch = useLibrary((s) => s.patch)

  if (scanMode === 'computer') {
    return (
      <nav
        aria-label="Location"
        className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-[12px]"
      >
        <span className="text-ink-2">This PC</span>
      </nav>
    )
  }

  const crumbs = splitPath(root)
  const parent = parentOf(root)
  const busy = status === 'scanning'

  function go(path: string) {
    if (busy || path === root) return
    void patch({ root: path, scanMode: 'folder' })
  }

  return (
    <nav
      aria-label="Location"
      className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5 text-[12px]"
    >
      <button
        type="button"
        aria-label="Up one folder"
        disabled={!parent || busy}
        onClick={() => parent && go(parent)}
        className="flex h-6 w-6 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-150 hover:bg-tint hover:text-ink disabled:pointer-events-none disabled:opacity-30"
      >
        <ArrowUp size={13} weight="bold" aria-hidden />
      </button>
      <div className="mx-0.5 h-4 w-px bg-line" />
      <ol className="flex min-w-0 items-center gap-0.5">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <li key={crumb.path} className="flex min-w-0 items-center gap-0.5">
              {index > 0 ? (
                <CaretRight size={11} weight="bold" className="shrink-0 text-ink-3" aria-hidden />
              ) : null}
              {last ? (
                <span className="truncate font-medium text-ink" title={crumb.path}>
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => go(crumb.path)}
                  disabled={busy}
                  className="truncate rounded-[5px] px-1 py-0.5 text-ink-2 transition-colors duration-150 hover:bg-tint hover:text-ink disabled:pointer-events-none"
                  title={crumb.path}
                >
                  {crumb.label}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
