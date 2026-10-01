import { GearSix } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { bridge } from '@/lib/bridge'
import { useLibrary } from '@/store/library'
import { Button, Toggle } from './ui'

/**
 * Settings that do not belong on the toolbar.
 *
 * The context-menu switch is here rather than in the toolbar because it writes to
 * the registry: a user who does not know what it does should not be able to
 * stumble into it while reaching for the sort order.
 */
interface SettingsPanelProps {
  onClose: () => void
}

/**
 * Credit link, opened through the main process.
 *
 * A plain anchor with target="_blank" is dead here: the window is locked down to
 * deny popups, so the click would silently do nothing.
 */
async function openCredit(): Promise<void> {
  await bridge.shell.openUrl('https://bylestramk.org')
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const settings = useLibrary((s) => s.settings)
  const patch = useLibrary((s) => s.patch)
  const drives = useLibrary((s) => s.drives)

  /**
   * Read back from the registry rather than mirrored from the setting, so the
   * switch cannot claim to be on when someone removed the entries by hand.
   */
  const [shellState, setShellState] = useState<'on' | 'off' | 'pending'>('pending')
  const [busy, setBusy] = useState(false)
  const setTerminalOpen = useLibrary((s) => s.setTerminalOpen)
  const [ptyState, setPtyState] = useState<'unknown' | 'ready' | 'unavailable'>('unknown')

  useEffect(() => {
    let live = true
    void bridge.shell.fileAssociations().then((enabled) => {
      if (live) setShellState(enabled ? 'on' : 'off')
    })
    return () => {
      live = false
    }
  }, [])

  // Asked once, on open: the engine is a native module and can be missing on an
  // unusual build. Reporting that here is better than a drawer that opens empty.
  useEffect(() => {
    let live = true
    void bridge.terminal.available().then((ok) => {
      if (live) setPtyState(ok ? 'ready' : 'unavailable')
    })
    return () => {
      live = false
    }
  }, [])

  const toggleShell = async (): Promise<void> => {
    setBusy(true)
    setShellState('pending')
    try {
      const next = await bridge.shell.setFileAssociations(!settings.shellIntegration)
      setShellState(next ? 'on' : 'off')
      // The setting was written main-process side, so mirror it locally too.
      await patch({ shellIntegration: next })
    } catch {
      setShellState(settings.shellIntegration ? 'on' : 'off')
    } finally {
      setBusy(false)
    }
  }

  const readable = drives.filter((drive) => !drive.unreadable)
  const freeTotal = readable.reduce((sum, drive) => sum + drive.freeBytes, 0)

  return (
    <div className="space-y-5 p-4">
      <section>
        <h2 className="text-[13px] font-semibold text-ink">Windows integration</h2>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12px] leading-[1.5] text-ink-2">
              Adds &ldquo;Open with OpenPics&rdquo; to the right-click menu for pictures, and
              lists OpenPics under &ldquo;Open with&rdquo;. Your default app for images is not
              changed, and it can be undone here.
            </p>
            <p className="num mt-1 text-[11px] text-ink-3">
              {shellState === 'pending'
                ? busy
                  ? 'applying…'
                  : 'checking…'
                : shellState === 'on'
                  ? 'registered for this user'
                  : 'not registered'}
            </p>
          </div>
          <Toggle
            label="Context menu"
            checked={shellState === 'on'}
            onChange={(value) => {
              if (value !== (shellState === 'on')) void toggleShell()
            }}
          />
        </div>
      </section>

      <section>
        <h2 className="text-[13px] font-semibold text-ink">This PC</h2>
        <p className="num mt-1 text-[11px] text-ink-3">
          {readable.length === 0
            ? 'no readable drives found'
            : `${readable.length} drive${readable.length === 1 ? '' : 's'}, ${(freeTotal / 1_000_000_000).toFixed(0)} GB free`}
          {drives.length > readable.length
            ? `, ${drives.length - readable.length} unreadable`
            : ''}
        </p>
      </section>

      <section>
        <h2 className="text-[13px] font-semibold text-ink">Terminal</h2>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12px] leading-[1.5] text-ink-2">
              Opens a real shell in a drawer along the bottom of the window, running with your
              normal user rights. Anything typed there can change files on this PC, so it is
              off until you switch it on. Press Ctrl+` to show or hide it.
            </p>
            <p className="num mt-1 text-[11px] text-ink-3">
              {ptyState === 'unknown'
                ? 'checking…'
                : ptyState === 'ready'
                  ? 'ready'
                  : 'unavailable on this system'}
            </p>
          </div>
          <Toggle
            label="Terminal"
            checked={settings.enableTerminal}
            onChange={(value) => {
              // Turning it off closes the drawer; no shell is left running behind a
              // setting that says there should be none.
              if (!value) setTerminalOpen(false)
              void patch({ enableTerminal: value })
            }}
          />
        </div>
      </section>

      <section>
        <h2 className="text-[13px] font-semibold text-ink">Credits</h2>
        <ul className="mt-1.5 flex flex-col gap-1 text-[12px] text-ink-2">
          <li>
            Lee Muriithi Kingori
            <span className="text-ink-3"> — built this</span>
          </li>
          <li>
            a cute Ai bot made this project
            <span className="text-ink-3"> — wrote a lot of it</span>
          </li>
          <li>
            <button
              type="button"
              onClick={() => void openCredit()}
              title="Open bylestramk.org in your browser"
              className="underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline"
            >
              bylestramk.org
            </button>
          </li>
        </ul>
      </section>

      <footer className="flex items-center justify-between border-t border-line pt-3">
        <span className="text-[11px] text-ink-3">OpenPics</span>
        <Button size="sm" onClick={onClose}>
          <GearSix size={13} weight="regular" />
          Close
        </Button>
      </footer>
    </div>
  )
}
