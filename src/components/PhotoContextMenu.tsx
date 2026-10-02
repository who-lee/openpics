import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowSquareOut,
  Copy,
  FolderOpen,
  Info,
  Monitor,
  PaintBrush,
  Trash,
  Warning
} from '@phosphor-icons/react'
import { bridge } from '@/lib/bridge'
import { useLibrary, type PhotoEntry } from '@/store/library'

const EDGE = 6

/**
 * Where a right-click menu is wanted, and what it is aimed at.
 *
 * `entries` is the resolved target list: the whole selection when the clicked
 * tile was already part of one, and just that tile otherwise. Every row acts on
 * this list, so a multi-select delete really does delete every selected file
 * rather than only the one the pointer was on. Entries carry the library index
 * the viewer and editor address, which `Photo` itself does not know.
 */
export interface MenuRequest {
  x: number
  y: number
  entries: PhotoEntry[]
}

interface PhotoContextMenuProps {
  request: MenuRequest
  onClose: () => void
}

/**
 * Extensions Windows will decode as a desktop background.
 *
 * `webp` is deliberately absent. Explorer renders it in most places, so it looks
 * like it belongs here, but the wallpaper path is the old one that goes through
 * SPI_SETDESKWALLPAPER, and on several builds it accepts a WebP path and then
 * paints nothing. Offering the row and getting a black desktop is worse than not
 * offering it, and the editor's own fit picker has the same limit.
 */
const DECODABLE = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'bmp', 'tif', 'tiff'])

function basenameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * A right-click menu for pictures in the grid.
 *
 * Rendered in a portal at `document.body` and placed against viewport
 * coordinates, for the same reason as the hover card: the grid's scroller clips
 * anything anchored inside it.
 */
export function PhotoContextMenu({ request, onClose }: PhotoContextMenuProps) {
  const { open, openForEdit, toggleInfo, select, forgetPaths } = useLibrary()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const entries = request.entries
  const first = entries[0]
  const many = entries.length > 1
  if (!first) return null

  /**
   * Deletes every target and drops the ones that worked from the library.
   *
   * Reported per path rather than as one verdict, because a partly successful
   * delete is normal: a file open in another program, or on a read-only share,
   * fails while its neighbours go to the bin, and the grid should show the truth
   * about which of them are still there.
   */
  const sendToBin = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const results = await bridge.shell.sendToBin(entries.map((entry) => entry.photo.path))
      const gone = results.filter((result) => result.ok).map((result) => result.path)
      if (gone.length > 0) forgetPaths(gone)
      const refused = results.filter((result) => !result.ok)
      if (refused.length === 0) {
        onClose()
        return
      }
      setFailures(
        refused.map((result) => `${basenameOf(result.path)}: ${result.error ?? 'not deleted'}`)
      )
      setConfirming(false)
    } catch (err) {
      setFailures([err instanceof Error ? err.message : String(err)])
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }, [entries, forgetPaths, onClose])

  /**
   * Points the desktop at a picture, keeping the desktop's current fit.
   *
   * Runs through PowerShell and a P/Invoke, so it can genuinely fail on a locked
   * or redirected registry hive. Reporting that here is the difference between
   * "it did not work" and "the menu vanished and the desktop did not change".
   */
  const applyWallpaper = async (path: string): Promise<void> => {
    try {
      const current = await bridge.wallpaper.get()
      await bridge.wallpaper.set(path, current.fit ?? 'fill')
      onClose()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  interface Item {
    id: string
    label: string
    icon: React.ReactNode
    danger?: boolean
    /** Hidden entirely when this returns false, so the menu has no dead rows. */
    shown?: () => boolean
    run: () => void
    /**
     * Rows that do not close the menu when chosen.
     *
     * Every other row acts and is finished, which is what a native menu does. The
     * two exceptions need the menu to stay: the delete swaps itself for a
     * confirmation, and the wallpaper reports its own failure.
     */
    keepOpen?: boolean
  }

  const items: Item[] = [
    {
      id: 'open',
      label: 'Open',
      icon: <ArrowSquareOut size={14} weight="regular" aria-hidden="true" />,
      run: () => {
        select(first.index, 'replace')
        open(first.index)
      }
    },
    {
      id: 'open-external',
      label: 'Open in default app',
      icon: <ArrowSquareOut size={14} weight="regular" aria-hidden="true" />,
      // Only for a single file: opening three videos at once is not something a
      // menu can usefully do, and Windows has no way to be asked to do it.
      shown: () => !many,
      run: () => void bridge.shell.open(first.photo.path)
    },
    {
      id: 'reveal',
      label: 'Show in folder',
      icon: <FolderOpen size={14} weight="regular" aria-hidden="true" />,
      run: () => void bridge.shell.reveal(first.photo.path)
    },
    {
      id: 'copy-path',
      label: many ? 'Copy all paths' : 'Copy path',
      icon: <Copy size={14} weight="regular" aria-hidden="true" />,
      run: () => {
        // One path plain, so pasting into a file field gives a usable value.
        // Several quoted, because Windows paths contain spaces.
        const text =
          entries.length === 1
            ? entries[0]!.photo.path
            : entries.map((entry) => `"${entry.photo.path}"`).join(' ')
        void navigator.clipboard.writeText(text)
      }
    },
    {
      id: 'wallpaper',
      label: 'Set as wallpaper',
      icon: <Monitor size={14} weight="regular" aria-hidden="true" />,
      // The desktop takes one picture, and only in a format Windows can decode as
      // one. A clip or an HEIC has no business being offered here.
      shown: () => !many && first.photo.kind === 'photo' && DECODABLE.has(first.photo.ext),
      /**
       * Keeps the desktop's own fit rather than imposing one.
       *
       * `fill` is what the bridge and the MCP tool default to, and it is the right
       * answer when nothing is known. But someone whose background is set to "Fit"
       * and who picks a new picture from here did not ask to have the screen
       * cropped, and the style is a registry value they may have chosen by hand.
       * So the current fit is read first and only falls back when it cannot be.
       */
      run: () => void applyWallpaper(first.photo.path)
    },
    {
      id: 'edit',
      label: 'Edit picture',
      icon: <PaintBrush size={14} weight="regular" aria-hidden="true" />,
      shown: () => !many && first.photo.kind === 'photo',
      run: () => openForEdit(first.index)
    },
    {
      id: 'details',
      label: 'Details',
      icon: <Info size={14} weight="regular" aria-hidden="true" />,
      shown: () => !many,
      run: () => {
        select(first.index, 'replace')
        toggleInfo()
      }
    },
    {
      id: 'delete',
      label: many ? `Move ${entries.length} to Recycle Bin` : 'Move to Recycle Bin',
      icon: <Trash size={14} weight="regular" aria-hidden="true" />,
      danger: true,
      keepOpen: true,
      run: () => setConfirming(true)
    }
  ]

  /**
   * Placed against the click, flipped when the window has no room.
   *
   * Measured after the first paint rather than before, because the menu's height
   * depends on which rows survived the `shown` checks.
   */
  const [pos, setPos] = useState({ left: request.x, top: request.y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.min(Math.max(EDGE, request.x), Math.max(EDGE, window.innerWidth - width - EDGE)),
      top: Math.min(Math.max(EDGE, request.y), Math.max(EDGE, window.innerHeight - height - EDGE))
    })
  }, [request.x, request.y])

  // Clicking away, scrolling, a resize or Escape all dismiss it, the way a native
  // menu behaves. Without these a menu can be left open over a picture that has
  // since scrolled away, and its rows would act on a selection that moved on.
  useEffect(() => {
    const dismiss = (): void => onClose()
    const onDown = (event: PointerEvent): void => {
      // A press inside the menu is a choice being made, not a dismissal. This
      // listener runs in the capture phase, before the pressed row's own click,
      // so closing unconditionally here would unmount the button before the
      // click ever arrived and no menu item would ever do anything.
      if (ref.current?.contains(event.target as Node)) return
      dismiss()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Stopped here so the grid's own Escape handler does not also run and reset
      // the selection the menu was aimed at.
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', dismiss, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Picture actions"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 w-[214px] rounded-[6px] border border-line bg-surface py-1 shadow-[var(--shadow-tint)]"
    >
      <p className="truncate px-3 pb-1 pt-0.5 text-[11px] text-ink-3">
        {many ? `${entries.length} pictures` : first.photo.name}
      </p>

      {confirming ? (
        <div className="px-3 pb-1.5 pt-1">
          <p className="mb-2 flex items-start gap-1.5 text-[11px] leading-snug text-ink-2">
            <Warning
              size={13}
              weight="fill"
              aria-hidden="true"
              className="mt-[1px] shrink-0 text-warn"
            />
            <span>
              Move{' '}
              <span className="num">{many ? `${entries.length} pictures` : first.photo.name}</span> to
              the Recycle Bin? It can be undone from there.
            </span>
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendToBin()}
              className="h-7 flex-1 rounded-[5px] bg-accent text-[12px] font-medium text-white transition-[filter] duration-150 hover:brightness-110 active:translate-y-px disabled:opacity-50"
            >
              {busy ? 'Moving...' : 'Move to bin'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="h-7 rounded-[5px] border border-line px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {items.map((item) => {
            if (item.shown?.() === false) return null
            return (
              <div key={item.id}>
                {/* The delete is the one irreversible row here, so it is kept apart
                    from the rest rather than sitting under "Copy path". */}
                {item.danger ? <div className="my-1 border-t border-line" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  /**
                   * A chosen row has done its job, so the menu gets out of the way,
                   * the way the Windows one does. Closing is not deferred to a
                   * dismiss listener, because the press that chose the row is
                   * already inside the menu and is correctly not treated as one.
                   */
                  onClick={() => {
                    item.run()
                    if (!item.keepOpen) onClose()
                  }}
                  className={[
                    'flex w-full items-center gap-2.5 px-3 py-[6px] text-left text-[12px]',
                    'transition-colors duration-100 hover:bg-hover',
                    item.danger ? 'text-accent-text hover:bg-accent-soft' : 'text-ink'
                  ].join(' ')}
                >
                  <span className="shrink-0 text-ink-3">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              </div>
            )
          })}
        </>
      )}

      {notice !== null ? (
        <p className="mt-1 border-t border-line px-3 pb-1 pt-1.5 text-[10px] leading-tight text-warn">
          {notice}
        </p>
      ) : null}

      {failures.length > 0 ? (
        <div className="mt-1 border-t border-line px-3 pb-1 pt-1.5">
          <p className="mb-1 text-[11px] font-medium text-warn">
            {failures.length === 1
              ? '1 could not be deleted'
              : `${failures.length} could not be deleted`}
          </p>
          <ul className="num max-h-[92px] space-y-0.5 overflow-y-auto text-[10px] leading-tight text-ink-3">
            {failures.slice(0, 6).map((line) => (
              <li key={line} className="break-all">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>,
    document.body
  )
}