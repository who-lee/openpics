import {
  ArrowsInSimple,
  ArrowsOutSimple,
  CaretDown,
  CaretUp,
  Columns,
  Plus,
  TerminalWindow,
  X
} from '@phosphor-icons/react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { TerminalShell } from '@shared/terminal'
import { bridge } from '@/lib/bridge'
import { useLibrary } from '@/store/library'
import { Button, IconButton } from './ui'
import '@xterm/xterm/css/xterm.css'

interface Tab {
  id: string
  label: string
  cwd: string
}

const MAX_TABS = 8
const MIN_HEIGHT = 120
/** Room left for the title bar, toolbar, panel bar and status bar when maximised. */
const MAXIMISED_HEIGHT = 'calc(100vh - 132px)'

const THEME_DARK = {
  background: '#0b0b0c',
  foreground: '#e6e6ea',
  cursor: '#e6e6ea',
  selectionBackground: '#33333d'
}

const THEME_LIGHT = {
  background: '#fafafa',
  foreground: '#1c1c1f',
  cursor: '#1c1c1f',
  selectionBackground: '#c9c9dd'
}

function labelFor(shell: TerminalShell): string {
  return shell === 'cmd' ? 'cmd' : 'PowerShell'
}

function clampHeight(value: number): number {
  const max = Math.max(MIN_HEIGHT, window.innerHeight - 160)
  return Math.round(Math.min(Math.max(value, MIN_HEIGHT), max))
}

/**
 * The terminal panel: a strip that is always on screen, and a drawer under it.
 *
 * The strip is the way in. Clicking anywhere on it opens or closes the drawer,
 * which is the part an editor user expects to find without being told about it.
 *
 * The drawer stays mounted whether or not it is showing: a shell's scrollback
 * lives in the xterm instance, so unmounting on hide would throw it away and
 * reopening would come back to a blank pane over a shell that never stopped.
 * Hiding is a `display` toggle, not a teardown.
 */
export function TerminalPanel() {
  const open = useLibrary((s) => s.terminalOpen)
  const enabled = useLibrary((s) => s.settings.enableTerminal)
  const theme = useLibrary((s) => s.settings.theme)
  const storedHeight = useLibrary((s) => s.settings.terminalHeight)
  const setTerminalOpen = useLibrary((s) => s.setTerminalOpen)
  const patch = useLibrary((s) => s.patch)

  const [tabs, setTabs] = useState<Tab[]>([])
  /** Which session each pane is showing. Two entries means the panel is split. */
  const [panes, setPanes] = useState<(string | null)[]>([null])
  const [focusedPane, setFocusedPane] = useState(0)
  /** Bumped to ask the focused shell to take the keyboard, for clicks that never touch it. */
  const [focusRequest, setFocusRequest] = useState(0)
  const [maximised, setMaximised] = useState(false)
  const [height, setHeight] = useState(() => clampHeight(storedHeight))
  const [error, setError] = useState<string | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)

  const tabsRef = useRef<Tab[]>([])
  tabsRef.current = tabs
  const panesRef = useRef<(string | null)[]>(panes)
  panesRef.current = panes
  const focusedPaneRef = useRef(0)
  focusedPaneRef.current = focusedPane
  const heightRef = useRef(height)
  heightRef.current = height
  const wasOpen = useRef(false)
  const wasEnabled = useRef(false)

  useEffect(() => {
    let live = true
    void bridge.terminal.available().then((ok) => {
      if (live) setAvailable(ok)
    })
    return () => {
      live = false
    }
  }, [])

  // The stored height is the fallback after a restart or a settings reset; a drag
  // writes it back, so this only moves the drawer when the file behind it changed.
  useEffect(() => {
    setHeight(clampHeight(storedHeight))
  }, [storedHeight])

  const spawn = useCallback(async (shell: TerminalShell, pane: number | null): Promise<void> => {
    setError(null)
    try {
      const info = await bridge.terminal.create({ shell })
      setTabs((prev) => [...prev, { id: info.id, label: labelFor(shell), cwd: info.cwd }])
      const target = pane ?? focusedPaneRef.current
      setPanes((prev) => {
        const next = [...prev]
        while (next.length <= target) next.push(null)
        next[target] = info.id
        return next
      })
      setFocusedPane(target)
      setFocusRequest((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The terminal could not start.')
    }
  }, [])

  const closeTab = useCallback((id: string): void => {
    void bridge.terminal.kill(id)
    setTabs((prev) => prev.filter((tab) => tab.id !== id))
    setPanes((prev) => {
      const next = prev.map((pane) => (pane === id ? null : pane))
      const empty = next.indexOf(null)
      if (empty === -1) return next
      // A pane with nothing in it would be a blank rectangle, so a session that
      // no other pane is showing is pulled into the slot before it is left empty.
      const shown = new Set(next.filter((pane): pane is string => pane !== null))
      const spare = tabsRef.current.find((tab) => tab.id !== id && !shown.has(tab.id))
      if (spare === undefined) return next
      next[empty] = spare.id
      return next
    })
  }, [])

  // Spawn the first shell only on the rising edge of the drawer opening or of the
  // setting being switched on. Closing the last tab on purpose should leave an
  // empty drawer, not conjure a replacement.
  useEffect(() => {
    const rising = (open && !wasOpen.current) || (enabled && !wasEnabled.current)
    wasOpen.current = open
    wasEnabled.current = enabled
    if (!open || !enabled) return
    if (rising && tabsRef.current.length === 0) void spawn('powershell', null)
  }, [open, enabled, spawn])

  // Switching the setting off takes its shells down with it: no process is left
  // running behind a setting that claims the feature is off.
  useEffect(() => {
    if (enabled) return
    for (const tab of tabsRef.current) void bridge.terminal.kill(tab.id)
    setTabs([])
    setPanes([null])
    setFocusedPane(0)
  }, [enabled])

  const focusPane = useCallback((pane: number): void => {
    if (pane < 0) return
    setFocusedPane(pane)
    setFocusRequest((n) => n + 1)
  }, [])

  const selectTab = useCallback((id: string): void => {
    const target = focusedPaneRef.current
    setPanes((prev) => {
      if (target >= prev.length) return prev
      const next = [...prev]
      next[target] = id
      return next
    })
    setFocusRequest((n) => n + 1)
  }, [])

  const toggleSplit = useCallback((): void => {
    if (panesRef.current.length > 1) {
      // Closing the group leaves its terminal running, the way an editor does:
      // it goes back to being a tab in the single pane.
      setPanes((prev) => [prev[0] ?? prev[1] ?? null])
      setFocusedPane(0)
      setFocusRequest((n) => n + 1)
      return
    }
    const spare = tabsRef.current.find((tab) => !panesRef.current.includes(tab.id))
    setFocusedPane(1)
    if (spare !== undefined) {
      setPanes((prev) => [...prev, spare.id])
      setFocusRequest((n) => n + 1)
      return
    }
    setPanes((prev) => [...prev, null])
    void spawn('powershell', 1)
  }, [spawn])

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (maximised) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = heightRef.current
    const move = (moveEvent: PointerEvent): void => {
      setHeight(clampHeight(startHeight + (startY - moveEvent.clientY)))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      patch({ terminalHeight: heightRef.current })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const atLimit = tabs.length >= MAX_TABS
  const canSpawn = enabled && available !== false && !atLimit
  const split = panes.length > 1

  /**
   * Where a session is drawn. Every session keeps its own mounted xterm, and only
   * the box it sits in changes, so splitting and collapsing never rebuilds a
   * terminal or throws away its scrollback.
   */
  const geometryFor = (id: string): string => {
    const pane = panes.indexOf(id)
    if (pane < 0) return 'hidden'
    if (!split) return 'absolute inset-0'
    return pane === 0
      ? 'absolute inset-y-0 left-0 w-[calc(50%-3px)]'
      : 'absolute inset-y-0 right-0 w-[calc(50%-3px)]'
  }

  return (
    <>
      <div
        role="region"
        aria-label="Terminal"
        className={
          open
            ? 'relative flex shrink-0 flex-col border-t border-line-strong bg-base'
            : 'relative hidden shrink-0 flex-col border-t border-line-strong bg-base'
        }
        style={{ height: maximised ? MAXIMISED_HEIGHT : `${height}px` }}
      >
        {maximised ? null : (
          <div
            onPointerDown={onDragStart}
            title="Drag to resize"
            className="group absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
          >
            <div className="mx-auto h-[3px] w-14 rounded-full bg-line-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
          </div>
        )}

        <div className="no-drag flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
          <TerminalWindow size={15} weight="regular" className="ml-1 shrink-0 text-ink-3" />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => {
              const shown = panes.includes(tab.id)
              const inFocused = panes[focusedPane] === tab.id
              return (
                <div
                  key={tab.id}
                  className={
                    inFocused
                      ? 'flex shrink-0 items-center rounded-[6px] bg-accent-soft text-accent-text'
                      : shown
                        ? 'flex shrink-0 items-center rounded-[6px] bg-hover text-ink'
                        : 'flex shrink-0 items-center rounded-[6px] text-ink-3 hover:bg-hover hover:text-ink'
                  }
                >
                  <button
                    type="button"
                    onClick={() => selectTab(tab.id)}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return
                      event.preventDefault()
                      closeTab(tab.id)
                    }}
                    title={shown ? tab.cwd : `${tab.cwd} - click to show it in the focused pane`}
                    className="max-w-[160px] truncate px-2 py-1 text-[12px] font-medium"
                  >
                    {tab.label}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${tab.label}`}
                    title="Close terminal"
                    onClick={() => closeTab(tab.id)}
                    className="mr-1 flex h-5 w-5 items-center justify-center rounded-[4px] transition-colors duration-150 hover:bg-black/20"
                  >
                    <X size={10} weight="bold" />
                  </button>
                </div>
              )
            })}
          </div>
          <Button size="sm" disabled={!canSpawn} onClick={() => void spawn('powershell', null)}>
            <Plus size={12} weight="bold" />
            PowerShell
          </Button>
          <Button size="sm" disabled={!canSpawn} onClick={() => void spawn('cmd', null)}>
            <Plus size={12} weight="bold" />
            cmd
          </Button>
          <IconButton
            label={split ? 'Collapse the split' : 'Split the terminal'}
            size="sm"
            disabled={!canSpawn && !split}
            active={split}
            onClick={toggleSplit}
          >
            <Columns size={14} weight="regular" />
          </IconButton>
          <IconButton
            label={maximised ? 'Restore the panel' : 'Maximise the panel'}
            size="sm"
            onClick={() => setMaximised((value) => !value)}
          >
            {maximised ? (
              <ArrowsInSimple size={14} weight="regular" />
            ) : (
              <ArrowsOutSimple size={14} weight="regular" />
            )}
          </IconButton>
          <IconButton label="Hide terminal" size="sm" onClick={() => setTerminalOpen(false)}>
            <X size={14} weight="bold" />
          </IconButton>
        </div>

        <div className="relative min-h-0 flex-1">
          {!enabled ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <TerminalWindow size={22} weight="regular" className="text-ink-3" />
              <p className="max-w-[460px] text-[12px] leading-[1.6] text-ink-2">
                A terminal runs a real shell with your normal user rights. Anything typed here can
                change files on this PC, so it stays off until you ask for it.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="accent"
                  size="sm"
                  disabled={available === false}
                  onClick={() => void patch({ enableTerminal: true })}
                >
                  Enable terminal
                </Button>
                <Button size="sm" onClick={() => setTerminalOpen(false)}>
                  Cancel
                </Button>
              </div>
              {available === false ? (
                <p className="text-[11px] text-ink-3">The terminal is not available on this system.</p>
              ) : null}
            </div>
          ) : available === false ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-ink-3">
              The terminal is not available on this system.
            </div>
          ) : (
            <>
              {split ? (
                <div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-px bg-line-strong" />
              ) : null}
              {tabs.map((tab) => (
                <TerminalView
                  key={tab.id}
                  id={tab.id}
                  className={geometryFor(tab.id)}
                  active={panes[focusedPane] === tab.id}
                  visible={open}
                  theme={theme}
                  focusRequest={focusRequest}
                  onActivate={() => focusPane(panes.indexOf(tab.id))}
                />
              ))}
              {split && panes[1] === null ? (
                <div className="absolute inset-y-0 right-0 flex w-[calc(50%-3px)] items-center justify-center">
                  <Button size="sm" disabled={!canSpawn} onClick={() => void spawn('powershell', 1)}>
                    <Plus size={12} weight="bold" />
                    Start a shell here
                  </Button>
                </div>
              ) : null}
              {!split && tabs.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[12px] text-ink-3">
                  No terminal open. Start one above.
                </div>
              ) : null}
            </>
          )}
        </div>

        {error ? (
          <div className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-accent-text">
            {error}
          </div>
        ) : null}
      </div>

      <div
        onClick={() => setTerminalOpen(!open)}
        onDoubleClick={() => {
          if (open) setMaximised((value) => !value)
        }}
        className="no-drag flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 border-t border-line bg-surface px-2 transition-colors duration-150 hover:bg-hover"
      >
        {open ? (
          <CaretDown size={11} weight="bold" className="text-ink-3" />
        ) : (
          <CaretUp size={11} weight="bold" className="text-ink-3" />
        )}
        <span
          className={
            open
              ? 'border-b border-accent pb-px text-[11px] font-medium uppercase tracking-[0.06em] text-ink'
              : 'border-b border-transparent pb-px text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3'
          }
        >
          Terminal
        </span>
        {tabs.length > 0 ? (
          <span className="num text-[10px] text-ink-3">{tabs.length}</span>
        ) : null}
        <div className="flex-1" />
        <IconButton
          label={maximised ? 'Restore the panel' : 'Maximise the panel'}
          size="sm"
          onClick={(event) => {
            event.stopPropagation()
            setMaximised((value) => !value)
          }}
        >
          {maximised ? (
            <ArrowsInSimple size={13} weight="regular" />
          ) : (
            <ArrowsOutSimple size={13} weight="regular" />
          )}
        </IconButton>
        <IconButton
          label={open ? 'Hide terminal' : 'Show terminal'}
          size="sm"
          onClick={(event) => {
            event.stopPropagation()
            setTerminalOpen(!open)
          }}
        >
          <X size={13} weight="bold" />
        </IconButton>
      </div>
    </>
  )
}

interface TerminalViewProps {
  id: string
  className: string
  active: boolean
  visible: boolean
  theme: 'dark' | 'light'
  focusRequest: number
  onActivate: () => void
}

function TerminalView({
  id,
  className,
  active,
  visible,
  theme,
  focusRequest,
  onActivate
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Read at mount for the first paint, then kept in step by the effect below.
  const themeRef = useRef(theme)
  themeRef.current = theme

  // Mounted once per session. Not keyed on `active` or `visible`: the buffer has
  // to outlive both a tab switch and the drawer being hidden.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeRef.current === 'dark' ? THEME_DARK : THEME_LIGHT
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    let attached = false
    // Live output that arrives while the pre-attach backlog is still being
    // written is held back and replayed after it, so the first prompt cannot be
    // overtaken by later output on a different IPC channel.
    const pending: string[] = []

    const fitNow = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      void bridge.terminal.resize(id, term.cols, term.rows)
    }

    const offData = bridge.terminal.onData((event) => {
      if (event.id !== id) return
      if (attached) term.write(event.data)
      else pending.push(event.data)
    })
    const offExit = bridge.terminal.onExit((event) => {
      if (event.id !== id) return
      term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
    })
    const input = term.onData((data) => {
      void bridge.terminal.write(id, data)
    })

    const observer = new ResizeObserver(fitNow)
    observer.observe(host)

    void bridge.terminal
      .attach(id)
      .then(({ backlog }) => {
        if (backlog !== '') term.write(backlog)
        for (const chunk of pending) term.write(chunk)
        pending.length = 0
        attached = true
        fitNow()
      })
      .catch(() => {
        term.write('\x1b[2m[this terminal could not be attached]\x1b[0m\r\n')
      })

    return () => {
      offData()
      offExit()
      input.dispose()
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = theme === 'dark' ? THEME_DARK : THEME_LIGHT
  }, [theme])

  // Refit when this session becomes the one in the focused pane, or when the
  // drawer is shown: while hidden the host has no size, so the observer stays quiet.
  useEffect(() => {
    if (!active || !visible) return
    const host = hostRef.current
    if (!host || host.clientWidth === 0) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) void bridge.terminal.resize(id, term.cols, term.rows)
      } catch {
        /* the host can be gone between scheduling the frame and running it */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, visible, id])

  // A click on the pane, the tab strip or the panel strip all have to land the
  // keyboard in the shell the user is pointing at, not wherever it was last.
  useEffect(() => {
    if (!active) return
    termRef.current?.focus()
  }, [active, focusRequest])

  return <div ref={hostRef} className={className} onMouseDown={onActivate} />
}
