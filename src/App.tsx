import { useCallback, useEffect } from 'react'
import { Titlebar } from './components/Titlebar'
import { Toolbar } from './components/Toolbar'
import { Grid } from './components/Grid'
import { Viewer } from './components/Viewer'
import { StatusBar } from './components/StatusBar'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import { SettingsPanel } from './components/SettingsPanel'
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
        } else if (event.key.toLowerCase() === 'h') {
          event.preventDefault()
          void bridge.win.hide()
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
    setQuery
  ])

  // The settings sheet has to render above the viewer, so it lives here rather
  // than inside a sibling. Escape closes it, and only it, while it is up.
  useEffect(() => {
    if (!showSettings) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismissSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSettings, onDismissSettings])

  return (
    <div className="flex h-full flex-col bg-base">
      <Titlebar />
      <Toolbar />
      <Grid />
      <StatusBar />
      <Viewer />
      <ShortcutsOverlay />
      {showSettings ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-8"
          onClick={onDismissSettings}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(event) => event.stopPropagation()}
            className="w-[520px] max-w-full rounded-[10px] border border-line-strong bg-base shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
          >
            <SettingsPanel onClose={onDismissSettings} />
          </div>
        </div>
      ) : null}
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
