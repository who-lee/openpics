/**
 * The catalogue of external tools OpenPics can use, and the shape the UI shows.
 *
 * This file is shared, not node-only, because it is pure data and the renderer
 * needs to know what a status means before it has asked for one. It deliberately
 * imports nothing: no `node:fs`, no `electron`. The code that actually finds
 * these binaries lives in `core/addons/detect.ts` and runs only in main.
 *
 * Each entry is a *requirement*, not a vendor. OpenPics does not decide where
 * Python or Node came from; it decides what it needs to find and whether it
 * found something that works. That split is why an entry carries no download URL
 * and no install logic: an addon the app ships (ffmpeg) and an addon the user
 * already has (node) are detected by exactly the same code, and only the first
 * kind has anything bundled with it.
 *
 * The `probeArgs` exist because "is it installed" is not the same question as "is
 * it the right version". A `python` on PATH can be the Microsoft Store stub that
 * exits with an error and prints nothing, which is the single most common way a
 * Windows user believes they have Python and does not. Asking the binary to
 * identify itself is the only reliable check, and letting each entry say how to
 * ask keeps that knowledge next to the requirement instead of in one big switch.
 */

export type AddonId = 'ffmpeg' | 'ffprobe' | 'node' | 'python' | 'git'

/** How much of the app breaks when this is missing. */
export type AddonNeed = 'required' | 'optional'

/** Where the working copy was found. Bundled always wins over PATH. */
export type AddonSource = 'bundled' | 'path'

export interface AddonSpec {
  id: AddonId
  /** Name shown in the UI. */
  label: string
  /** One line saying what OpenPics uses it for. */
  purpose: string
  /**
   * Executable names to look for, in order of preference. Windows resolves
   * `.exe` implicitly, and a user who installed Python from the Store often has
   * only `python3`, so both spellings are tried.
   */
  commands: readonly string[]
  /** Arguments that make the tool print a version and exit successfully. */
  probeArgs: readonly string[]
  /** Whether the app ships this itself. */
  bundled: boolean
  need: AddonNeed
  /**
   * Undefined for anything not shipped with the app. Shown in the UI as where to
   * get one, because the app will not install a Python or a Node on the user's
   * behalf.
   */
  vendor?: string
}

/** What the renderer and the MCP server both receive per addon. */
export interface AddonStatus {
  id: AddonId
  label: string
  purpose: string
  need: AddonNeed
  /** True when the binary ran and answered. This is the tick in the UI. */
  available: boolean
  source: AddonSource | null
  /** Absolute path to the binary that answered, or null. */
  path: string | null
  /** First line of its version output, e.g. "9.0.2". Null when unavailable. */
  version: string | null
  /** Why it is not available. Null when it is. */
  problem: string | null
  bundled: boolean
  /** Where to get it, for anything not shipped with the app. */
  vendor: string | null
  /**
   * True when OpenPics cannot do this without the addon. Optional addons being
   * absent is normal and must not read as an error anywhere in the UI.
   */
  blocking: boolean
}

export const ADDONS: readonly AddonSpec[] = [
  {
    id: 'ffmpeg',
    label: 'FFmpeg',
    purpose: 'Runs every video edit, and exports.',
    commands: ['ffmpeg'],
    probeArgs: ['-hide_banner', '-version'],
    bundled: true,
    need: 'required'
  },
  {
    id: 'ffprobe',
    label: 'FFprobe',
    purpose: 'Reads a video\'s duration and streams so cuts land accurately.',
    commands: ['ffprobe'],
    probeArgs: ['-hide_banner', '-version'],
    bundled: true,
    need: 'required'
  },
  {
    id: 'node',
    label: 'Node.js',
    purpose: 'Runs the MCP server when a coding agent starts OpenPics itself.',
    commands: ['node'],
    probeArgs: ['--version'],
    bundled: false,
    need: 'optional',
    vendor: 'nodejs.org'
  },
  {
    id: 'python',
    label: 'Python',
    purpose: 'Runs local models and helper scripts. Nothing in the app needs it.',
    commands: ['python3', 'python'],
    probeArgs: ['--version'],
    bundled: false,
    need: 'optional',
    vendor: 'python.org'
  },
  {
    id: 'git',
    label: 'Git',
    purpose: 'Only if you keep OpenPics itself under version control.',
    commands: ['git'],
    probeArgs: ['--version'],
    bundled: false,
    need: 'optional',
    vendor: 'git-scm.com'
  }
]

export function addonSpec(id: AddonId): AddonSpec {
  const spec = ADDONS.find((a) => a.id === id)
  if (!spec) throw new Error(`unknown addon: ${id}`)
  return spec
}