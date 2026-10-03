/**
 * Validation for anything that can reach the settings.
 *
 * This lives apart from `electron/settings.ts` because that file imports
 * Electron and cannot be loaded under plain Node, which is where the tests run.
 * Keeping the rules here means the same code that guards a live app is the code
 * under test, rather than a copy that can drift.
 */
import type { Settings } from './types'

/**
 * Bounds for the numeric settings, enforced on every read and every write.
 *
 * The original guard was `typeof incoming === typeof DEFAULT_SETTINGS[key]`,
 * which admits `NaN`, `Infinity` and negative values: `NaN` is a number, so a
 * cleared number field or a hand-edited file persisted it, and a `NaN` row
 * height collapses the grid with nothing to trace it to. Clamping on read as
 * well as write means a bad value already on disk cannot survive a restart.
 */
const NUMBER_BOUNDS: Partial<Record<keyof Settings, [number, number]>> = {
  rowHeight: [64, 512],
  slideIntervalMs: [500, 120_000],
  terminalHeight: [80, 4000],
  aiDockWidth: [240, 720]
}

function coerceNumber(key: keyof Settings, value: unknown, fallback: number): number {
  const bounds = NUMBER_BOUNDS[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (!bounds) return value
  const [min, max] = bounds
  // Rounded rather than truncated, so a fractional value does not bias low.
  return Math.min(max, Math.max(min, Math.round(value)))
}

const SCAN_MODES = ['folder', 'computer']
const THEMES = ['dark', 'light']
const SORT_DIRS = ['asc', 'desc']
const SORT_KEYS = ['name', 'mtime', 'size', 'dimensions']

/**
 * Copies one accepted value into `target`, leaving it alone when the value is
 * not something that setting can hold.
 *
 * `typeof` alone is not enough for a union: `theme` would take any string, so
 * each union is checked against its own members instead.
 */
export function acceptSetting(target: Settings, key: keyof Settings, incoming: unknown): void {
  const fallback = (DEFAULT_FALLBACK[key] ?? target[key]) as unknown

  if (typeof incoming === 'number') {
    set(target, key, coerceNumber(key, incoming, fallback as number))
    return
  }
  if (incoming === undefined) return

  if (typeof fallback === 'boolean') {
    if (typeof incoming === 'boolean') set(target, key, incoming)
    return
  }
  if (typeof fallback === 'string') {
    // `root` is the one free-form string, because it is a path the user chose.
    // It is identified by being absent from the union tables rather than by a
    // hardcoded name, so adding another union key cannot accidentally make a
    // path get validated against it.
    const members: string[] | null =
      key === 'scanMode'
        ? SCAN_MODES
        : key === 'theme'
          ? THEMES
          : key === 'sortDir'
            ? SORT_DIRS
            : key === 'sortKey'
              ? SORT_KEYS
              : null
    if (members === null) {
      if (typeof incoming === 'string') set(target, key, incoming)
      return
    }
    if (members.includes(incoming as string)) set(target, key, incoming)
    return
  }
  if (typeof incoming === typeof fallback) set(target, key, incoming)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function set(target: Settings, key: keyof Settings, value: unknown): void {
  ;(target as any)[key] = value
}

/**
 * Kept local so this module does not import protocol.ts.
 *
 * protocol.ts is the app's copy of the defaults, but it pulls in image-type and
 * scheme constants that a validator has no use for. These are the values that
 * decide which union a key belongs to, and they match protocol.ts.
 */
const DEFAULT_FALLBACK: Partial<Record<keyof Settings, unknown>> = {
  scanMode: 'folder',
  theme: 'dark',
  sortKey: 'name',
  sortDir: 'asc',
  aiEnabled: true,
  aiDockExpanded: true,
  aiDockWidth: 360,
  aiModelPath: '',
  aiPromptPath: '',
  aiCollections: []
}

/**
 * Builds a full settings object from an untrusted blob.
 *
 * Unknown keys are dropped rather than carried, so a corrupt or hand-edited
 * file cannot introduce a field the running app does not expect.
 */
export function sanitizeSettings(raw: unknown, defaults: Settings): Settings {
  const parsed = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>
  const merged: Settings = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    if (!(key in parsed)) continue
    acceptSetting(merged, key, parsed[key])
  }
  return merged
}

/** Applies a patch to a settings object, accepting only valid values. */
export function applyPatch(current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current }
  for (const key of Object.keys(current) as (keyof Settings)[]) {
    if (!(key in patch)) continue
    acceptSetting(next, key, patch[key])
  }
  return next
}