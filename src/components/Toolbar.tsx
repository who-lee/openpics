import {
  ArrowsOut,
  FolderOpen,
  GearSix,
  Info,
  MagnifyingGlass,
  MonitorPlay,
  PushPin,
  Question,
  Rows,
  Sun,
  TerminalWindow,
  X
} from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import type { ScanMode, SortKey } from '@shared/protocol'
import { useLibrary } from '@/store/library'
import { formatCount } from '@/lib/format'
import { IconButton, Segmented, Toggle } from './ui'
import { SmartCollectionsMenu } from './SmartCollectionsMenu'

const SORT_OPTIONS: { value: SortKey; label: string; title: string }[] = [
  { value: 'name', label: 'Name', title: 'Sort by file name' },
  { value: 'mtime', label: 'Date', title: 'Sort by date modified' },
  { value: 'size', label: 'Size', title: 'Sort by file size' },
  { value: 'dimensions', label: 'Pixels', title: 'Sort by pixel count' }
]

const SOURCE_OPTIONS: { value: ScanMode; label: string; title: string }[] = [
  { value: 'folder', label: 'Folder', title: 'Show one folder you choose' },
  {
    value: 'computer',
    label: 'This PC',
    title: 'Scan every drive on this computer. This can take a while.'
  }
]

const DENSITY_OPTIONS = [
  { value: '120', label: 'S', title: 'Small thumbnails' },
  { value: '168', label: 'M', title: 'Medium thumbnails' },
  { value: '236', label: 'L', title: 'Large thumbnails' }
]

export function Toolbar() {
  const settings = useLibrary((s) => s.settings)
  const query = useLibrary((s) => s.query)
  const status = useLibrary((s) => s.status)
  const photos = useLibrary((s) => s.photos)
  const progress = useLibrary((s) => s.progress)
  const showSettings = useLibrary((s) => s.showSettings)
  const terminalOpen = useLibrary((s) => s.terminalOpen)
  const {
    patch,
    setSort,
    setQuery,
    pickFolder,
    toggleInfo,
    toggleShortcuts,
    toggleSlideshow,
    toggleTerminal
  } = useLibrary()
  const setShowSettings = useLibrary((s) => s.setShowSettings)
  const cancelScan = useLibrary((s) => s.cancelScan)

  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const hasPhotos = photos.length > 0
  const dir = settings.sortDir === 'asc' ? 'ascending' : 'descending'
  // A walk has no knowable total in either mode, so the bar stays an indeterminate
  // sweep rather than a percentage that would be invented. It is shown for folder
  // scans too, not just whole-PC ones, because the previous results stay on screen
  // while a new walk runs: a rescan over a loaded library keeps the grid full of
  // photos, so the grid's own scanning state is not rendered and the toolbar is the
  // only place a Stop can live. Gating it on whole-PC mode left folder rescans with
  // no way out at all.
  const scanning = status === 'scanning'
  const computer = settings.scanMode === 'computer'
  const foundLabel = progress
    ? `${formatCount(progress.found)}${progress.dirs > 0 ? ` in ${formatCount(progress.dirs)} folders` : ''}`
    : 'scanning'

  return (
    <div className="no-drag flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2">
      <button
        type="button"
        onClick={() => void pickFolder()}
        className="inline-flex h-8 max-w-[280px] items-center gap-2 rounded-[6px] border border-line bg-raised px-3 text-[13px] font-medium transition-colors duration-150 hover:border-line-strong hover:bg-hover active:translate-y-px"
        title="Choose a different folder"
      >
        <FolderOpen size={15} weight="regular" />
        <span className="truncate">Change folder</span>
      </button>

      <Segmented
        label="What to show"
        value={settings.scanMode}
        options={SOURCE_OPTIONS}
        onChange={(value) => void patch({ scanMode: value as ScanMode })}
      />

      <div className="relative flex h-8 items-center">
        <MagnifyingGlass
          size={14}
          weight="regular"
          className="pointer-events-none absolute left-2.5 text-ink-3"
        />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('')
              event.currentTarget.blur()
            }
          }}
          placeholder="Filter by name"
          aria-label="Filter pictures by name"
          spellCheck={false}
          className="h-8 w-[190px] rounded-[6px] border border-line bg-raised pl-8 pr-7 text-[13px] text-ink placeholder:text-ink-3 transition-colors duration-150 focus:border-line-strong focus:outline-none"
        />
        {query !== '' ? (
          <button
            type="button"
            aria-label="Clear filter"
            title="Clear filter"
            onClick={() => setQuery('')}
            className="absolute right-1 flex h-6 w-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <X size={12} weight="bold" />
          </button>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        <Rows size={14} weight="regular" className="text-ink-3" />
        <Segmented
          label="Sort pictures"
          value={settings.sortKey}
          options={SORT_OPTIONS}
          onChange={setSort}
        />
        <span className="num text-[11px] text-ink-3">{dir}</span>
      </div>

      <Segmented
        label="Thumbnail size"
        value={String(settings.rowHeight)}
        options={DENSITY_OPTIONS}
        onChange={(value) => void patch({ rowHeight: Number(value) })}
      />

      <Toggle
        label="Subfolders"
        checked={settings.recursive}
        onChange={(value) => void patch({ recursive: value })}
      />

      <SmartCollectionsMenu />

      <div className="ml-auto flex items-center gap-1">
        <IconButton
          label="Play slideshow (S)"
          disabled={!hasPhotos}
          onClick={() => toggleSlideshow()}
        >
          <MonitorPlay size={16} weight="regular" />
        </IconButton>
        <IconButton
          label="Toggle always on top"
          active={settings.alwaysOnTop}
          onClick={() => void patch({ alwaysOnTop: !settings.alwaysOnTop })}
        >
          <PushPin size={16} weight={settings.alwaysOnTop ? 'fill' : 'regular'} />
        </IconButton>
        <IconButton
          label="Details of selected picture (I)"
          disabled={!hasPhotos}
          onClick={toggleInfo}
        >
          <Info size={16} weight="regular" />
        </IconButton>
        <IconButton
          label={settings.theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          onClick={() => void patch({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
        >
          {settings.theme === 'dark' ? (
            <Sun size={16} weight="regular" />
          ) : (
            <ArrowsOut size={16} weight="regular" />
          )}
        </IconButton>
        <IconButton label="Terminal (Ctrl+`)" active={terminalOpen} onClick={() => toggleTerminal()}>
          <TerminalWindow size={16} weight="regular" />
        </IconButton>
        <IconButton
          label="Settings"
          active={showSettings}
          onClick={() => setShowSettings(!showSettings)}
        >
          <GearSix size={16} weight="regular" />
        </IconButton>
        <IconButton label="Keyboard shortcuts (?)" onClick={toggleShortcuts}>
          <Question size={16} weight="regular" />
        </IconButton>
      </div>

      {scanning ? (
        <div className="flex min-w-[240px] flex-1 items-center gap-2">
          <div
            className="h-[3px] min-w-[100px] flex-1 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-label={computer ? 'Scanning this PC' : 'Scanning folder'}
            aria-valuetext={
              computer
                ? `${foundLabel}, drive ${(progress?.rootIndex ?? 0) + 1} of ${progress?.roots.length ?? 0}`
                : foundLabel
            }
          >
            {/* A sweep, not a fill: a walk has no total to divide by, and a
                bar that implies a percentage it cannot compute would be a lie. */}
            <div className="opbar-sweep h-full w-1/3 rounded-full bg-accent" />
          </div>
          <span className="num shrink-0 text-[11px] text-ink-3">{foundLabel}</span>
          <button
            type="button"
            onClick={() => void cancelScan()}
            className="shrink-0 rounded-[6px] border border-line px-2 py-1 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:border-line-strong hover:bg-hover hover:text-ink"
            title="Stop scanning and keep what has been found so far"
          >
            Stop
          </button>
        </div>
      ) : null}
    </div>
  )
}