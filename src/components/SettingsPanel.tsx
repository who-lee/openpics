import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  GithubLogo,
  HandHeart,
  WarningCircle,
  XCircle
} from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { bridge } from '@/lib/bridge'
import { useLibrary } from '@/store/library'
import type { AddonStatus } from '@shared/addons'
import { Segmented, Toggle } from './ui'

/**
 * Slideshow speeds, in seconds.
 *
 * The stored value is milliseconds so the timer is not rounded every frame,
 * but nobody wants to choose 3.5s, so the control works in seconds.
 */
const SLIDESHOW_CHOICES = [
  { value: '2', label: '2s' },
  { value: '5', label: '5s' },
  { value: '10', label: '10s' },
  { value: '30', label: '30s' }
]

/**
 * Settings that do not belong on the toolbar.
 *
 * The context-menu switch is here rather than in the toolbar because it writes to
 * the registry: a user who does not know what it does should not be able to
 * stumble into it while reaching for the sort order.
 *
 * This is a page rather than a dialog. It is taller than a comfortable sheet, and
 * cramming it into one meant the last section was only reachable by scrolling
 * inside a floating card, with the library still visible behind it. Leaving the
 * page takes no setting with it, so nothing has to be saved or reverted - which is
 * why there is no Close button here either. The header's Back arrow is the only
 * way out, and it matches what every other page in every other app does.
 */

/**
 * Where the project lives, and where to send money.
 *
 * Named rather than inlined at the call sites so the URLs are in one place and
 * there is no chance of the two credit rows drifting apart from the README and
 * the package manifest.
 */
const AUTHOR_URL = 'https://github.com/who-lee'
const SITE_URL = 'https://bylestramk.org'
const DONATE_URL = 'https://www.paypal.com/ncp/payment/QDRSPAFCKTLXE'

/**
 * Credit link, opened through the main process.
 *
 * A plain anchor with target="_blank" is dead here: the window is locked down to
 * deny popups, so the click would silently do nothing.
 */
async function openUrl(url: string): Promise<void> {
  await bridge.shell.openUrl(url)
}

/**
 * One external tool, as a row.
 *
 * The three states it can be in are worth distinguishing in the design: present,
 * absent, and present-but-broken. The third is the one that matters. A path in
 * `PATH` can be a Microsoft Store alias that opens the Store, or a shim left by a
 * failed install, and both of those would earn a tick from a file-existence check
 * and then fail the first time somebody edits a clip. So the row shows what
 * answered, and a required tool that did not answer says so in the same red as one
 * that is missing - from the user's side the two are equally unusable, and the
 * difference only matters to whoever is debugging.
 */
function AddonRow({ addon }: { addon: AddonStatus }) {
  const ok = addon.available
  const Icon = ok ? CheckCircle : addon.blocking ? XCircle : WarningCircle
  const tint = ok ? 'text-ink' : addon.blocking ? 'text-accent-text' : 'text-ink-3'

  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <Icon size={15} weight="fill" className={`mt-px shrink-0 ${tint}`} aria-hidden />
        <div className="min-w-0">
          <p className="text-[12px] text-ink">
            {addon.label}
            {addon.bundled ? (
              <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 py-px text-[10px] text-accent-text">
                included
              </span>
            ) : null}
          </p>
          <p className="num mt-0.5 truncate text-[11px] text-ink-3">
            {ok
              ? [addon.version, addon.source === 'bundled' ? 'bundled with OpenPics' : addon.source, addon.path]
                  .filter(Boolean)
                  .join(' · ')
              : (addon.problem ?? 'not found')}
          </p>
        </div>
      </div>
      {!ok && addon.vendor ? (
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 text-[11px] text-ink-2 hover:text-ink"
          onClick={() => {
            void bridge.shell.openUrl(`https://${addon.vendor}`)
          }}
        >
          Get it
          <ArrowSquareOut size={11} aria-hidden />
        </button>
      ) : null}
    </div>
  )
}

export function SettingsPanel() {
  const settings = useLibrary((s) => s.settings)
  const patch = useLibrary((s) => s.patch)
  const drives = useLibrary((s) => s.drives)

  /**
   * Read back from the registry rather than mirrored from the setting, so the
   * switch cannot claim to be on when someone removed the entries by hand.
   */
  const [shellState, setShellState] = useState<'on' | 'off' | 'pending' | 'unknown'>('pending')
  const [busy, setBusy] = useState(false)
  const setTerminalOpen = useLibrary((s) => s.setTerminalOpen)
  const [ptyState, setPtyState] = useState<'unknown' | 'ready' | 'unavailable'>('unknown')

  /**
   * Addon detection.
   *
   * `null` while the probe is in flight, which is distinct from an empty list:
   * an empty list would render as "nothing is installed" and read as a finding
   * rather than as not-yet-known. The probe runs a real executable, so it is
   * slower than reading a settings file and is why this is a spinner and not a
   * skeleton.
   */
  const [addons, setAddons] = useState<AddonStatus[] | null>(null)
  const [reprobing, setReprobing] = useState(false)

  useEffect(() => {
    let live = true
    void bridge.shell
      .fileAssociations()
      .then((enabled) => {
        if (live) setShellState(enabled ? 'on' : 'off')
      })
      .catch(() => {
        // The probe reads the registry, so it can fail on a locked-down or redirected
        // hive. That is not the same as 'off', and it is not 'pending' either:
        // staying in the initial state left this row saying "checking…" forever,
        // which reads as a hang and gives the user nothing to act on. So the
        // failure gets its own state, which says the state could not be read.
        if (live) setShellState('unknown')
      })
    return () => {
      live = false
    }
  }, [])

  // Asked once, on open: the engine is a native module and can be missing on an
  // unusual build. Reporting that here is better than a drawer that opens empty.
  useEffect(() => {
    let live = true
    void bridge.terminal
      .available()
      .then((ok) => {
        if (live) setPtyState(ok ? 'ready' : 'unavailable')
      })
      .catch(() => {
        if (live) setPtyState('unavailable')
      })
    return () => {
      live = false
    }
  }, [])

  // Asked once, on open.
  //
  // This calls `refresh()`, not `list()`, and the comment used to claim it
  // refreshed while calling `list()`. That is the one case where the two differ:
  // `list()` returns the process cache, and the cache is only ever written by a
  // refresh or by a scan-triggered probe. So a user who installed ffmpeg and
  // reopened Settings saw the same "not found" they saw before, which is exactly
  // what this panel exists to fix.
  //
  // Every mount probes, which means opening Settings costs one `ffmpeg -version`
  // and one `ffprobe -version` per tool - milliseconds, and it is the only way to
  // tell the user the truth about their machine rather than about startup.
  useEffect(() => {
    let live = true
    void bridge.addons
      .refresh()
      .then((list) => {
        if (live) setAddons(list)
      })
      .catch(() => {
        // A rejected probe is not a list of missing tools. Leaving it null keeps
        // the section honest instead of claiming the machine has nothing.
        if (live) setAddons([])
      })
    return () => {
      live = false
    }
  }, [])

  /**
   * Re-runs every probe.
   *
   * Only for after the user installed something in this session: they closed
   * Settings, went off to python.org, and came back. Without this the row would
   * still say "not found" and the user would conclude the install failed.
   */
  const reprobeAddons = async (): Promise<void> => {
    setReprobing(true)
    try {
      setAddons(await bridge.addons.refresh())
    } catch {
      /* keep the previous answer; a failed refresh is not new information */
    } finally {
      setReprobing(false)
    }
  }

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

  /**
   * Snapped to the nearest offered speed.
   *
   * The stored interval is free-form, so a value set elsewhere (or by an older
   * build) can fall between two choices. Snapping rather than defaulting to 5s
   * means the control shows the closest real option instead of silently
   * rewriting the user's setting to something they did not pick.
   */
  const slideshowChoice = (() => {
    const seconds = settings.slideIntervalMs / 1000
    let best = SLIDESHOW_CHOICES[0]?.value ?? '5'
    let bestGap = Infinity
    for (const choice of SLIDESHOW_CHOICES) {
      const gap = Math.abs(Number(choice.value) - seconds)
      if (gap < bestGap) {
        bestGap = gap
        best = choice.value
      }
    }
    return best
  })()

  const readable = drives.filter((drive) => !drive.unreadable)
  const freeTotal = readable.reduce((sum, drive) => sum + drive.freeBytes, 0)

  return (
    <div className="mx-auto w-full max-w-[560px] space-y-6 px-6 py-6">
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
                : shellState === 'unknown'
                  ? 'could not read the registry for this user'
                  : shellState === 'on'
                    ? 'registered for this user'
                    : 'not registered'}
            </p>
          </div>
          <Toggle
            label="Context menu"
            checked={shellState === 'on'}
            // Registry writes are not atomic, so a second click mid-apply could
            // interleave an add with a delete and leave the entry half-written.
            disabled={busy}
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
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[13px] font-semibold text-ink">External tools</h2>
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-ink-2 hover:text-ink disabled:opacity-40"
            disabled={reprobing || addons === null}
            onClick={() => {
              void reprobeAddons()
            }}
          >
            {reprobing ? (
              <CircleNotch size={11} className="animate-spin" aria-hidden />
            ) : (
              <ArrowClockwise size={11} aria-hidden />
            )}
            Check again
          </button>
        </div>
        <p className="mt-1 text-[12px] leading-[1.5] text-ink-2">
          OpenPics uses these to edit video. FFmpeg comes with the app, so video editing works
          straight away. The others are only used if you install them yourself &mdash; nothing here
          is downloaded or changed without you asking.
        </p>
        <div className="mt-1 divide-y divide-line border-t border-line">
          {addons === null ? (
            <p className="num flex items-center gap-2 py-2 text-[11px] text-ink-3">
              <CircleNotch size={12} className="animate-spin" aria-hidden />
              looking for them&hellip;
            </p>
          ) : addons.length === 0 ? (
            <p className="py-2 text-[11px] text-ink-3">Could not check. Restart OpenPics and try again.</p>
          ) : (
            addons.map((addon) => <AddonRow key={addon.id} addon={addon} />)
          )}
        </div>
      </section>

      <section>
        <h2 className="text-[13px] font-semibold text-ink">Agent (MCP)</h2>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12px] leading-[1.5] text-ink-2">
              Lets a coding agent drive OpenPics over the Model Context Protocol: find pictures,
              describe them, remove backgrounds, and file things into the Recycle Bin. Turning this
              off makes every one of those tools refuse.
            </p>
            <p className="num mt-1 text-[11px] text-ink-3">
              {settings.enableMcp
                ? 'agent tools allowed'
                : 'agent tools blocked for this profile'}
            </p>
          </div>
          <Toggle
            label="Allow agent tools"
            checked={settings.enableMcp}
            onChange={(value) => {
              void patch({ enableMcp: value })
            }}
          />
        </div>
      </section>

      <section>
        <h2 className="text-[13px] font-semibold text-ink">Slideshow</h2>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12px] leading-[1.5] text-ink-2">
              How long each picture is held before the next one appears.
            </p>
          </div>
          <Segmented
            label="Advance after"
            value={String(slideshowChoice)}
            options={SLIDESHOW_CHOICES}
            onChange={(value) => {
              const seconds = Number(value)
              if (Number.isFinite(seconds)) void patch({ slideIntervalMs: seconds * 1000 })
            }}
          />
        </div>
      </section>

      <section>
        <h2 className="text-[13px] font-semibold text-ink">Closing</h2>
        <div className="mt-2 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[12px] leading-[1.5] text-ink-2">
                Closing the window keeps OpenPics in the tray so it stays available from the right
                -click menu. Quit it from the tray instead.
              </p>
            </div>
            <Toggle
              label="Close to tray"
              checked={settings.closeToTray}
              onChange={(value) => {
                void patch({ closeToTray: value })
              }}
            />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[12px] leading-[1.5] text-ink-2">
                Starts in the tray without showing the window.
              </p>
            </div>
            <Toggle
              label="Start minimised"
              checked={settings.launchMinimized}
              onChange={(value) => {
                void patch({ launchMinimized: value })
              }}
            />
          </div>
        </div>
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
                  ? settings.enableTerminal
                    ? 'ready'
                    : 'ready, but currently switched off'
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
          <li className="flex items-center gap-1.5">
            <GithubLogo size={13} weight="fill" className="shrink-0 text-ink-3" aria-hidden="true" />
            <button
              type="button"
              onClick={() => void openUrl(AUTHOR_URL)}
              title="Open github.com/who-lee in your browser"
              className="underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline"
            >
              Lee Muriithi Kingori
            </button>
            <span className="text-ink-3">— who-lee, built this</span>
          </li>
          <li>
            a cute Ai bot made this project
            <span className="text-ink-3"> — wrote a lot of it</span>
          </li>
          <li>
            <button
              type="button"
              onClick={() => void openUrl(SITE_URL)}
              title="Open bylestramk.org in your browser"
              className="underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline"
            >
              bylestramk.org
            </button>
          </li>
        </ul>

        {/*
         * Donate sits under Credits rather than in the toolbar because it is not a
         * thing you use to browse photos. It opens the PayPal page in the browser,
         * which is the only way a payment can be completed - and it is the same
         * openUrl path as the credit links, so a popup-blocked window cannot make it
         * fail silently.
         */}
        <button
          type="button"
          onClick={() => void openUrl(DONATE_URL)}
          title="Support the project on PayPal"
          className={[
            'mt-3 inline-flex items-center gap-1.5 rounded-[6px] border border-line px-2.5 py-1.5',
            'text-[12px] font-medium text-ink-2',
            'transition-[background-color,color,border-color,transform] duration-150',
            'hover:border-line-strong hover:bg-hover hover:text-ink active:translate-y-px'
          ].join(' ')}
        >
          <HandHeart size={14} weight="bold" className="shrink-0" aria-hidden="true" />
          Donate
        </button>
      </section>

      <footer className="border-t border-line pt-3">
        <span className="text-[11px] text-ink-3">
          OpenPics &middot; settings apply as you change them
        </span>
      </footer>
    </div>
  )
}
