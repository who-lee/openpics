import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { ADDONS, type AddonId, type AddonSource, type AddonSpec, type AddonStatus } from '../../shared/addons'

/**
 * Finding out what is actually installed.
 *
 * The rule the whole module is built around: an addon counts as available only
 * when its binary has been *run* and reported a version. Checking for a file on
 * PATH is not enough, and the reason is specific to Windows. A `python.exe` that
 * exists but is a Microsoft Store alias launches the Store, prints nothing and
 * exits non-zero; a shim left behind by an uninstalled package can do the same.
 * Every other answer - "is there a file with that name somewhere on PATH" -
 * reports those as working, and then sends the user chasing a bug that is really
 * a broken install.
 *
 * That costs one subprocess per addon, so results are cached for the life of the
 * process and `refreshAddonStatuses` forces a re-probe after the user installs
 * something.
 */

export type { AddonSource, AddonStatus }

/**
 * Folders that may hold binaries shipped with the app, most specific first.
 *
 * Three candidates rather than one, because the same code runs in three places: a
 * packaged app, the MCP server an agent launches outside Electron, and a
 * developer checkout.
 *
 * Neither Electron's `resourcesPath` nor `import.meta` is used for the latter
 * two. `resourcesPath` only exists inside Electron, and `import.meta` cannot be
 * used at all because the MCP server is compiled to CommonJS - using it would
 * fail the MCP typecheck. So the dev location is found from the entry script's own
 * path, which puts it in the repository whatever directory the server was launched
 * from. That last part matters: an agent launches the MCP server from its own
 * project directory, so `process.cwd()` alone would point at the wrong tree.
 *
 * `OPENPICS_ADDONS_DIR` replaces all of them rather than joining them. As a
 * fallback it would be untestable - a test pointing it at an empty folder would
 * still find the repository's own copy through the entry path and could not
 * observe a missing addon - and as an override it is the more useful behaviour
 * anyway: someone who wants OpenPics to use a specific FFmpeg build should get
 * that one and nothing else, not that one silently falling back to the machine's.
 */
function bundledDirs(): string[] {
  const override = process.env.OPENPICS_ADDONS_DIR
  if (override) return [resolve(override)]

  const dirs: string[] = []

  // Present only under Electron; typed locally because Node's own Process has no
  // such property and casting at the use site would hide the conditional.
  const packaged = process as NodeJS.Process & { resourcesPath?: string }
  if (typeof packaged.resourcesPath === 'string' && packaged.resourcesPath.length > 0) {
    dirs.push(join(packaged.resourcesPath, 'addons'))
  }

  // <root>/dist-mcp/mcp/server.js -> <root>/vendor/addons
  const entry = process.argv[1]
  if (entry) dirs.push(resolve(dirname(entry), '..', '..', 'vendor', 'addons'))
  dirs.push(resolve(process.cwd(), 'vendor', 'addons'))
  return dirs
}

/** Windows executable name for a bare command, and the bare name elsewhere. */
function exeName(command: string): string {
  return process.platform === 'win32' ? `${command}.exe` : command
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs a binary and reports how it went, never throwing.
 *
 * `execFile` reports a non-zero exit through its callback, but it *throws
 * synchronously* when the file exists and cannot be started at all - which on
 * Windows is what a corrupt download and a non-executable file both look like. A
 * throw from inside the Promise executor would reject the promise, and with five
 * addons probed in parallel that rejection escapes `addonStatuses` and takes the
 * caller down with it. Detection has to survive precisely the case it exists to
 * diagnose, so the synchronous throw is caught here and folded into the same
 * "could not be started" answer as a failed spawn.
 */
function run(bin: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((done) => {
    const notStarted: RunResult = { code: -1, stdout: '', stderr: '' }
    try {
      execFile(bin, [...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        // execFile reports a non-zero exit as an error whose `code` is the child's
        // exit status, while a spawn failure has a string `code` such as 'ENOENT'.
        // Both are folded into one number here so callers compare against a single
        // thing instead of having to know which kind of failure occurred.
        let code = 0
        if (err) {
          const raw = (err as NodeJS.ErrnoException).code
          code = typeof raw === 'number' ? raw : -1
        }
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    } catch {
      done(notStarted)
    }
  })
}

/** First line of the output, stripped of the parts that are noise on a version. */
function parseVersion(spec: AddonSpec, out: string): string | null {
  const line = (out.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim()
  if (!line) return null
  if (spec.id === 'ffmpeg' || spec.id === 'ffprobe') {
    // "ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright (c) ..."
    return line.match(/\bversion\s+(\S+)/i)?.[1] ?? line
  }
  return line.replace(/^v/, '')
}

/**
 * Turns a failure into something the user can act on.
 *
 * "exited with code 1" is not that. The Store-alias case gets named explicitly
 * because it is the one that looks like a bug and is not: the binary is present,
 * the name resolves, and it will never produce output.
 */
function explain(spec: AddonSpec, result: RunResult | null): string {
  // -1 is this module's marker for "the process could not be started at all",
  // which on Windows means the name did not resolve - so the tool is *not*
  // installed. Saying "installed but did not answer" here would be the exact
  // wrong thing to tell someone, and Git in particular is often absent.
  if (!result || result.code === -1) {
    return spec.vendor
      ? `${spec.label} was not found on PATH. Install it from ${spec.vendor} if you need it.`
      : `${spec.label} was not found on PATH.`
  }
  const text = `${result.stderr}\n${result.stdout}`
  if (/app execution alias|windows store/i.test(text)) {
    const where = spec.vendor ? ` at ${spec.vendor}` : ' from the vendor installer'
    return `${spec.label} on PATH is a Microsoft Store placeholder, not the real program. Install it${where}.`
  }
  if (result.code === 1 && spec.id === 'python') {
    return `${spec.label} on PATH did not run. This is usually a Store placeholder; install Python from python.org.`
  }
  return `${spec.label} is installed but did not answer correctly (exit ${result.code}).`
}

/** The shared fields, so every status agrees on them whatever else happened. */
function baseOf(spec: AddonSpec): Omit<AddonStatus, 'available' | 'source' | 'path' | 'version' | 'problem'> {
  return {
    id: spec.id,
    label: spec.label,
    purpose: spec.purpose,
    need: spec.need,
    bundled: spec.bundled,
    vendor: spec.vendor ?? null,
    // A missing optional addon is normal and must not be presented as a fault
    // anywhere in the UI. Bundled addons are required: OpenPics ships them, so
    // failing to find one means a broken install, not a missing dependency.
    blocking: spec.need === 'required'
  }
}

function missing(spec: AddonSpec, problem: string): AddonStatus {
  return { ...baseOf(spec), available: false, source: null, path: null, version: null, problem }
}

/**
 * Locates one addon: bundled copy first, then PATH.
 *
 * Bundled wins even when PATH also has one, and that ordering is deliberate. The
 * bundled FFmpeg is the build OpenPics was tested against, so a user's older
 * `ffmpeg.exe` earlier on PATH should not silently become the thing that cuts
 * their video. A user who wants theirs can be given that choice later; nobody
 * should get a different toolchain by accident.
 */
async function locate(spec: AddonSpec): Promise<AddonStatus> {
  const attempts: Array<{ bin: string; source: AddonSource }> = []

  // Only bundled locations are checked for existence before running. A bare
  // command name is left to execFile, which uses the OS's own resolution;
  // duplicating that with a PATH walk here is how a module ends up disagreeing
  // with the shell about what a command means.
  for (const dir of bundledDirs()) {
    for (const command of spec.commands) attempts.push({ bin: join(dir, exeName(command)), source: 'bundled' })
  }
  for (const command of spec.commands) attempts.push({ bin: command, source: 'path' })

  let lastFailure: RunResult | null = null

  for (const attempt of attempts) {
    if (attempt.source === 'bundled' && !existsSync(attempt.bin)) continue
    const result = await run(attempt.bin, spec.probeArgs, 8000)
    if (result.code === 0) {
      return {
        ...baseOf(spec),
        available: true,
        source: attempt.source,
        path: attempt.bin,
        version: parseVersion(spec, `${result.stdout}\n${result.stderr}`),
        problem: null
      }
    }
    lastFailure = result
    if (attempt.source === 'bundled') {
      // The shipped copy is broken. Falling through to PATH would hide a corrupt
      // install behind a working one, so it is reported as the installer's fault.
      return missing(spec, `The bundled ${spec.label} did not run (${result.code}). Reinstall OpenPics.`)
    }
  }

  return missing(spec, explain(spec, lastFailure))
}

let cache: AddonStatus[] | null = null

/** Probes every addon, caching the answer for the life of the process. */
export async function addonStatuses(): Promise<AddonStatus[]> {
  if (cache) return cache
  cache = await Promise.all(ADDONS.map(locate))
  return cache
}

/** Forces a fresh probe, for after the user installs something. */
export async function refreshAddonStatuses(): Promise<AddonStatus[]> {
  cache = null
  return addonStatuses()
}

/**
 * The working binary for one addon, or an error explaining why there isn't one.
 *
 * The error is written for the caller to show. `VideoError` is not used here
 * because a missing addon is not a video problem - the same message appears in
 * Settings, in a scan and over MCP.
 */
export async function requireAddon(id: AddonId): Promise<{ path: string; source: AddonSource }> {
  const status = (await addonStatuses()).find((s) => s.id === id)
  const spec = ADDONS.find((a) => a.id === id)
  if (!status || !status.available || !status.path || !status.source) {
    const label = spec?.label ?? id
    const reason = status?.problem ?? `${label} was not found.`
    throw new Error(`${label} is not available. ${reason}`)
  }
  return { path: status.path, source: status.source }
}

/** Whether an addon answered. Cheap enough to skip work up front. */
export async function hasAddon(id: AddonId): Promise<boolean> {
  const status = (await addonStatuses()).find((s) => s.id === id)
  return Boolean(status?.available)
}

/**
 * Drops the cache without probing.
 *
 * For tests, and for the one place where the answer may have changed underneath
 * us: a bundled addon can be installed or removed while the app is running.
 */
export function clearAddonCache(): void {
  cache = null
}