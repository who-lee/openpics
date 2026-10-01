import { X } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { useLibrary } from '@/store/library'

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Library',
    items: [
      ['Arrow keys', 'move the selection'],
      ['Shift + arrows', 'extend the selection'],
      ['Ctrl + click', 'add or remove one picture'],
      ['Shift + click', 'select a range'],
      ['Enter or double click', 'open the viewer'],
      ['Escape', 'close the viewer'],
      ['/', 'jump to the filter box'],
      ['Ctrl + O', 'open another folder'],
      ['Ctrl + R', 'rescan the folder']
    ]
  },
  {
    title: 'Viewer',
    items: [
      ['Space or S', 'play or pause the slideshow'],
      ['Right / Left', 'next or previous shot'],
      ['Wheel or + and -', 'zoom at the pointer'],
      ['0', 'fit to the window'],
      ['Double click', 'switch between fit and 1:1'],
      ['Drag', 'pan while zoomed in'],
      ['Arrows when zoomed', 'pan instead of navigating'],
      ['E', 'edit the background away'],
      ['Drag while editing', 'paint with the brush'],
      ['Escape while editing', 'put the picture back'],
      ['F', 'full screen'],
      ['I', 'show details']
    ]
  }
]

export function ShortcutsOverlay() {
  const show = useLibrary((s) => s.showShortcuts)
  const toggle = useLibrary((s) => s.toggleShortcuts)

  // A modal dialog that documents the keyboard has to answer Escape, otherwise the
  // only ways out are a backdrop click or the close button.
  useEffect(() => {
    if (!show) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [show, toggle])

  if (!show) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={toggle}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--c-scrim)] p-6"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[620px] rounded-[6px] border border-line bg-surface shadow-[var(--shadow-tint)]"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={toggle}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <X size={14} weight="bold" />
          </button>
        </header>

        <div className="grid grid-cols-2 gap-x-8 gap-y-5 px-4 py-4">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-ink-3">
                {group.title}
              </h3>
              <dl className="space-y-1">
                {group.items.map(([key, description]) => (
                  <div key={key} className="flex items-baseline gap-2">
                    <dt className="num w-[124px] shrink-0 text-[11px] text-accent-text">{key}</dt>
                    <dd className="text-[12px] text-ink-2">{description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
