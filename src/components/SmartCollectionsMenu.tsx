import { CaretDown, Check, FolderSimplePlus, Trash } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { activeFilterCount, useLibrary } from '@/store/library'

export function SmartCollectionsMenu() {
  const collections = useLibrary((s) => s.collections)
  const activeId = useLibrary((s) => s.activeCollectionId)
  const filterCount = useLibrary((s) => activeFilterCount(s))
  const { setActiveCollection, addCollectionFromFilters, removeCollection } = useLibrary()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const active = collections.find((collection) => collection.id === activeId) ?? null

  const saveCurrent = () => {
    const suggestion = active ? `${active.name} copy` : 'My collection'
    const name = window.prompt('Name this collection', suggestion)
    if (name === null) return
    addCollectionFromFilters(name)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Smart collections"
        onClick={() => setOpen((value) => !value)}
        className={`flex h-8 items-center gap-1.5 rounded-[6px] border px-2.5 text-[13px] transition-colors duration-150 ${
          active
            ? 'border-line-strong bg-raised text-ink'
            : 'border-line bg-raised text-ink-2 hover:text-ink'
        }`}
      >
        <FolderSimplePlus size={14} weight={active ? 'fill' : 'regular'} />
        <span className="max-w-[140px] truncate">{active ? active.name : 'Collections'}</span>
        <CaretDown size={11} weight="bold" className="text-ink-3" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 w-64 overflow-hidden rounded-[8px] border border-line bg-raised py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setActiveCollection(null)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink transition-colors duration-150 hover:bg-hover"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              {active === null ? <Check size={12} weight="bold" /> : null}
            </span>
            All pictures
          </button>

          {collections.length > 0 ? <div className="my-1 h-px bg-line" /> : null}

          {collections.map((collection) => (
            <div key={collection.id} className="group flex items-center">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setActiveCollection(collection.id)
                  setOpen(false)
                }}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink transition-colors duration-150 hover:bg-hover"
              >
                <span className="flex h-4 w-4 items-center justify-center">
                  {collection.id === activeId ? <Check size={12} weight="bold" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                <span className="num text-[11px] text-ink-3">{collection.rules.length}</span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${collection.name}`}
                title="Delete collection"
                onClick={() => removeCollection(collection.id)}
                className="mr-1 flex h-6 w-6 items-center justify-center rounded-[6px] text-ink-3 opacity-0 transition-colors duration-150 hover:bg-hover hover:text-ink group-hover:opacity-100"
              >
                <Trash size={13} weight="regular" />
              </button>
            </div>
          ))}

          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            disabled={filterCount === 0}
            onClick={saveCurrent}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink transition-colors duration-150 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              <FolderSimplePlus size={13} weight="regular" />
            </span>
            {active ? 'Save current filters as new' : 'New from current filters'}
          </button>
          {filterCount === 0 && !active ? (
            <p className="px-3 pb-1.5 pt-0.5 text-[11px] text-ink-3">
              Set a filter first to save it here.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
