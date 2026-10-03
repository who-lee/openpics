import { useCallback, useEffect } from 'react'
import { ArrowLeft } from '@phosphor-icons/react'
import { Titlebar } from './components/Titlebar'
import { Toolbar } from './components/Toolbar'
import { Breadcrumbs } from './components/Breadcrumbs'
import { FilterBar } from './components/FilterBar'
import { Grid } from './components/Grid'
import { AiDock } from './components/AiDock'
import { Viewer } from './components/Viewer'
import { StatusBar } from './components/StatusBar'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { SettingsPanel } from './components/SettingsPanel'
import { TerminalPanel } from './components/TerminalPanel'
import { useLibrary, useOpenFilesSubscription } from './store/library'
import { bridge } from './lib/bridge'

export default function App() {
  const {
    boot,
    settings,
    showSettings,
    setShowSettings,
    step,
    toggleInfo,
    toggleShortcuts,
    toggleSlideshow,
    toggleTerminal,
    selectAll,
    invertSelection,
    toggleAi,
    open,
    cursor,
    select,
    moveCursor,
    setQuery,
    rescan,
    pickFolder
  } = useLibrary()

  useEffect(() => {
    void boot()
  }, [boot])

  // Windows can hand the app file paths at any time, including before boot has
  // finished, so the subscription is owned here rather than by a child.
  useOpenFilesSubscription()

  const onDismissSettings = useCallback(() => setShowSettings(false), [setShowSettings])

  // Theme lives on the document element so both the UI and the native caption
  // overlay can read it, rather than duplicating the tokens in JS.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // Tray menu and close-to-tray both arrive on one channel.
  useEffect(() => {
    return bridge.onCommand((command) => {
      switch (command) {
        case 'hide':
          void bridge.win.hide()
          break
        case 'show':
          void bridge.win.show()
          break
        case 'minimize':
          void bridge.win.minimize()
          break
        case 'quit':
          void bridge.win.quit()
          break
        case 'next':
          step(1)
          break
        case 'previous':
          step(-1)
          break
        case 'slideshow':
          toggleSlideshow()
          break
        case 'info':
          toggleInfo()
          break
        default:
          break
      }
    })
  }, [step, toggleInfo, toggleSlideshow])

  // Global shortcuts. While the viewer is open it owns the keyboard, so this
  // handler steps aside: both used to act on the same key press, which made an
  // arrow in the viewer skip two photos and left I dead on arrival.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (typing) return

      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'o') {
          event.preventDefault()
          void pickFolder()
        } else if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          void rescan()
        } else if (event.key.toLowerCase() === 'a') {
          event.preventDefault()
          if (event.shiftKey) toggleAi()
          else selectAll()
        } else if (event.key.toLowerCase() === 'i') {
          event.preventDefault()
          invertSelection()
        } else if (event.key.toLowerCase() === 'h') {
          event.preventDefault()
          void bridge.win.hide()
        } else if (event.key === '`') {
          event.preventDefault()
          toggleTerminal()
        }
        return
      }

      // Help is the one shortcut that stays available everywhere.
      if (event.key === '?') {
        event.preventDefault()
        toggleShortcuts()
        return
      }

      if (useLibrary.getState().openIndex !== null) return

      // Settings is a page now, not a dialog over the grid, so nothing here is
      // modal about it. But the library it replaced is unmounted, so arrows would
      // move a cursor nothing can see and keys like space would start a slideshow
      // over a selection the user cannot see. While it is up, only the modifier
      // shortcuts above and Back apply; everything else belongs to the page.
      // Escape is handled by the listener below, not here.
      if (useLibrary.getState().showSettings) return

      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault()
          moveCursor(1, event.shiftKey)
          break
        case 'ArrowLeft':
          event.preventDefault()
          moveCursor(-1, event.shiftKey)
          break
        case 'ArrowDown':
          event.preventDefault()
          moveCursor(rowStep(), event.shiftKey)
          break
        case 'ArrowUp':
          event.preventDefault()
          moveCursor(-rowStep(), event.shiftKey)
          break
        case 'Home': {
          event.preventDefault()
          const first = useLibrary.getState().visible[0]
          if (first !== undefined) select(first, 'replace')
          break
        }
        case 'End': {
          event.preventDefault()
          const visible = useLibrary.getState().visible
          const last = visible[visible.length - 1]
          if (last !== undefined) select(last, 'replace')
          break
        }
        case 'Enter':
          event.preventDefault()
          open(cursor)
          break
        case ' ':
        case 's':
        case 'S':
          event.preventDefault()
          toggleSlideshow()
          break
        case 'i':
        case 'I':
          event.preventDefault()
          toggleInfo()
          break
        case 'Escape':
          event.preventDefault()
          // The shortcuts overlay and the viewer are modal and own Escape
          // themselves, so App only clears a filter when neither is showing.
          if (useLibrary.getState().showShortcuts) break
          if (useLibrary.getState().query !== '') setQuery('')
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    cursor,
    moveCursor,
    select,
    open,
    pickFolder,
    rescan,
    toggleShortcuts,
    toggleSlideshow,
    toggleInfo,
    toggleTerminal,
    selectAll,
    invertSelection,
    toggleAi,
    setQuery
  ])

  // Escape leaves Settings. It is handled here rather than only in the page's own
  // header so that the habit of Escape-means-back carries over from the dialog
  // this replaced, and the grid handler above stops at the settings branch rather
  // than also clearing the filter behind it.
  useEffect(() => {
    if (!showSettings) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Inside a field, Escape has to mean "stop editing", not "leave the page".
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      event.preventDefault()
      onDismissSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSettings, onDismissSettings])

  return (
    <div className="flex h-full flex-col bg-base">
      <Titlebar />
      {showSettings ? (
        // Settings replaces the library rather than covering it. Keeping the grid
        // mounted underneath would leave it scrolling and selectable through a
        // "modal" that no longer looks like one, and the panel is tall enough that
        // a floating card either clipped its own content or covered the whole window.
        <>
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <button
              type="button"
              onClick={onDismissSettings}
              className="flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-tint hover:text-ink"
            >
              <ArrowLeft size={14} weight="bold" aria-hidden />
              Library
            </button>
            <h1 className="text-[13px] font-semibold text-ink">Settings</h1>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SettingsPanel />
          </div>
        </>
      ) : (
        <>
          <Toolbar />
          <Breadcrumbs />
          <FilterBar />
          <div className="flex min-h-0 flex-1">
            <Grid />
            <AiDock />
          </div>
          <TerminalPanel />
          <StatusBar />
          <Viewer />
        </>
      )}
      <ShortcutsOverlay />
    </div>
  )
}

/** Vertical arrow step, derived from the current row height so it tracks density. */
function rowStep(): number {
  const rowHeight = useLibrary.getState().settings.rowHeight
  const width = window.innerWidth - 24
  const perRow = Math.max(1, Math.floor(width / (rowHeight * 1.3 + 6)))
  return Math.max(1, Math.round(perRow * 0.5))
}
