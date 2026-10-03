import { FunnelSimple, X } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { useLibrary, activeFilterCount } from '../store/library'
import { Button, Segmented } from './ui'

/** Epoch milliseconds for the start of a yyyy-mm-dd day, or null when blank. */
function dayStart(value: string): number | null {
  if (!value) return null
  const parsed = Date.parse(`${value}T00:00:00`)
  return Number.isNaN(parsed) ? null : parsed
}

/** Epoch milliseconds for the end of a yyyy-mm-dd day, or null when blank. */
function dayEnd(value: string): number | null {
  if (!value) return null
  const parsed = Date.parse(`${value}T23:59:59.999`)
  return Number.isNaN(parsed) ? null : parsed
}

/** yyyy-mm-dd for an epoch value, in local time. */
function toDateInput(value: number | null): string {
  if (value === null) return ''
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const MB = 1024 * 1024

const TYPE_OPTIONS = [
  { value: 'all' as const, label: 'All' },
  { value: 'image' as const, label: 'Images' },
  { value: 'video' as const, label: 'Videos' }
]

export function FilterBar() {
  const typeFilter = useLibrary((s) => s.typeFilter)
  const dateStart = useLibrary((s) => s.dateStart)
  const dateEnd = useLibrary((s) => s.dateEnd)
  const sizeMin = useLibrary((s) => s.sizeMin)
  const sizeMax = useLibrary((s) => s.sizeMax)
  const cameraFilter = useLibrary((s) => s.cameraFilter)
  const tagFilter = useLibrary((s) => s.tagFilter)
  const photoTags = useLibrary((s) => s.photoTags)

  const setTypeFilter = useLibrary((s) => s.setTypeFilter)
  const setDateRange = useLibrary((s) => s.setDateRange)
  const setSizeRange = useLibrary((s) => s.setSizeRange)
  const setCameraFilter = useLibrary((s) => s.setCameraFilter)
  const setTagFilter = useLibrary((s) => s.setTagFilter)
  const clearAllFilters = useLibrary((s) => s.clearAllFilters)
  const active = useLibrary((s) => activeFilterCount(s))

  const availableTags = useMemo(() => {
    const set = new Set<string>()
    for (const tags of photoTags.values()) for (const tag of tags) set.add(tag)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [photoTags])

  const inputClass =
    'h-7 rounded-[6px] border border-line bg-raised px-2 text-[12px] text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none'

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
      <FunnelSimple size={14} className="text-ink-3" aria-hidden />
      <Segmented value={typeFilter} label="Media type" options={TYPE_OPTIONS} onChange={setTypeFilter} />

      <label className="flex items-center gap-1 text-[11px] text-ink-3">
        From
        <input
          type="date"
          className={inputClass}
          value={toDateInput(dateStart)}
          onChange={(event) => setDateRange(dayStart(event.target.value), dateEnd)}
        />
      </label>
      <label className="flex items-center gap-1 text-[11px] text-ink-3">
        To
        <input
          type="date"
          className={inputClass}
          value={toDateInput(dateEnd)}
          onChange={(event) => setDateRange(dateStart, dayEnd(event.target.value))}
        />
      </label>

      <label className="flex items-center gap-1 text-[11px] text-ink-3">
        Min MB
        <input
          type="number"
          min={0}
          className={`${inputClass} w-20`}
          value={sizeMin === null ? '' : Math.round(sizeMin / MB)}
          onChange={(event) =>
            setSizeRange(event.target.value === '' ? null : Number(event.target.value) * MB, sizeMax)
          }
        />
      </label>
      <label className="flex items-center gap-1 text-[11px] text-ink-3">
        Max MB
        <input
          type="number"
          min={0}
          className={`${inputClass} w-20`}
          value={sizeMax === null ? '' : Math.round(sizeMax / MB)}
          onChange={(event) =>
            setSizeRange(sizeMin, event.target.value === '' ? null : Number(event.target.value) * MB)
          }
        />
      </label>

      <input
        type="text"
        placeholder="Camera"
        className={`${inputClass} w-32`}
        value={cameraFilter}
        onChange={(event) => setCameraFilter(event.target.value)}
      />

      {availableTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {availableTags.map((tag) => {
            const on = tagFilter.includes(tag)
            return (
              <button
                key={tag}
                type="button"
                onClick={() =>
                  setTagFilter(on ? tagFilter.filter((t) => t !== tag) : [...tagFilter, tag])
                }
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-150 ${
                  on
                    ? 'border-accent bg-accent-soft text-accent-text'
                    : 'border-line text-ink-2 hover:bg-tint hover:text-ink'
                }`}
              >
                {tag}
              </button>
            )
          })}
        </div>
      ) : null}

      {active > 0 ? (
        <Button size="sm" variant="ghost" className="ml-auto" onClick={clearAllFilters}>
          <X size={12} weight="bold" aria-hidden />
          Clear filters ({active})
        </Button>
      ) : null}
    </div>
  )
}
