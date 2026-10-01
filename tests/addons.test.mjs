/**
 * Tests for external-tool detection.
 *
 * The interesting question here is not "is there a file called ffmpeg.exe" -
 * that is easy and almost never the right answer on Windows. It is "does running
 * it produce a version", because a Microsoft Store alias passes an existence
 * check and fails everything else. So these tests drive `core/addons/detect.ts`
 * directly and assert on what actually answered.
 *
 * They are hermetic where they can be. `OPENPICS_ADDONS_DIR` replaces the whole
 * bundled search rather than joining it, so pointing it at a folder with a broken
 * `ffmpeg.exe` in it proves the failure is reported instead of quietly falling
 * through to a working copy elsewhere.
 *
 * Two caveats worth knowing before changing this file:
 *
 *  - The built output is CommonJS, so `import()` ignores a query string and hands
 *    back the same module instance every time. Cache-busting with `?v=` does not
 *    work here; `clearAddonCache()` is the supported way to reset, and every
 *    scenario must call it after changing the environment.
 *  - A fake binary has to actually accept the probe arguments for that addon.
 *    `ffmpeg` is probed with `-hide_banner -version`, which node rejects, so a
 *    node copy can stand in for `python` (`--version`) but not for `ffmpeg`.
 *
 * The group that needs the real binaries is skipped when they are absent, because
 * a fresh clone has no `vendor/addons` until `npm run addons` has run.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILT = join(ROOT, 'dist-mcp', 'core', 'addons', 'detect.js')
const SHARED = join(ROOT, 'dist-mcp', 'shared', 'addons.js')
const VENDOR = join(ROOT, 'vendor', 'addons')

if (!existsSync(BUILT)) {
  console.error(`detect.js is not built: ${BUILT}\nrun "npm run build:mcp" first, or use "npm test".`)
  process.exit(1)
}

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`)
  }
}
function section(t) {
  console.log(`\n== ${t}`)
}

const FIX = join(process.env.TEMP ?? '.', `openpics-addon-verify-${randomUUID().slice(0, 8)}`)
mkdirSync(FIX, { recursive: true })
process.on('exit', () => rmSync(FIX, { recursive: true, force: true }))

// One module instance for the whole file, deliberately: the built output is
// CommonJS, so a fresh `import()` would hand back the same instance and any
// belief that a scenario is isolated would be false.
const detect = await import(pathToFileURL(BUILT).href)
const { ADDONS, addonSpec } = await import(pathToFileURL(SHARED).href)

const byId = (list, id) => list.find((a) => a.id === id)

/**
 * Runs `fn` with the bundled-tool search pointed at one folder, cache cleared.
 *
 * Clearing after setting the environment is the load-bearing part. The detector
 * caches for the life of the process on purpose, so without the reset every
 * scenario after the first would be asserting on the first one's answer - which
 * is exactly the kind of test that passes for the wrong reason.
 */
async function withAddonsDir(dir, fn) {
  const previous = process.env.OPENPICS_ADDONS_DIR
  process.env.OPENPICS_ADDONS_DIR = dir
  detect.clearAddonCache()
  try {
    return await fn(detect)
  } finally {
    if (previous === undefined) delete process.env.OPENPICS_ADDONS_DIR
    else process.env.OPENPICS_ADDONS_DIR = previous
    detect.clearAddonCache()
  }
}

/* ---------------- the catalogue ---------------- */

section('the catalogue')

// Read from `shared/`, not from `detect.ts`. The point of the split is that the
// renderer may import the catalogue - it must never import node:fs or electron -
// so the file is compiled to its own module and both sides import it.
check('the catalogue is a module of its own, not folded into the detector', existsSync(SHARED))
check('ffmpeg and ffprobe are required', ADDONS.filter((a) => a.need === 'required').length === 2)
check(
  'everything required is bundled',
  ADDONS.filter((a) => a.need === 'required').every((a) => a.bundled),
  'a required addon OpenPics does not ship would be a broken install on every machine'
)
check(
  'nothing optional is bundled',
  ADDONS.filter((a) => a.need === 'optional').every((a) => !a.bundled),
  'shipping a Python or a Node is not this app\'s job'
)
check(
  'every optional addon names a vendor',
  ADDONS.filter((a) => !a.bundled).every((a) => typeof a.vendor === 'string' && a.vendor.length > 0),
  'the UI offers a link for anything missing'
)
check('every addon has a label and a purpose', ADDONS.every((a) => a.label && a.purpose))
check('every addon can be asked for a version', ADDONS.every((a) => a.probeArgs.length > 0))
check('addon ids are unique', new Set(ADDONS.map((a) => a.id)).size === ADDONS.length)
check(
  'an unknown id is refused',
  (() => {
    try {
      addonSpec('nope')
      return false
    } catch {
      return true
    }
  })()
)

/* ---------------- a bundled copy that will not run ---------------- */

section('a bundled copy that will not run')

{
  // The single most important behaviour in this module. A corrupt `ffmpeg.exe` -
  // an interrupted download, a quarantined file - still exists, so a
  // file-existence check would call it installed. Two things must be true: it is
  // reported as unavailable, and it does NOT quietly fall back to a working copy
  // on PATH, because succeeding silently would leave the user with a broken
  // install who never finds out.
  const dir = join(FIX, 'broken-bundled')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ffmpeg.exe'), 'this is not a program')

  await withAddonsDir(dir, async (d) => {
    const ffmpeg = byId(await d.addonStatuses(), 'ffmpeg')
    check('a bundled ffmpeg that will not run is not available', ffmpeg.available === false)
    check(
      'the failure is reported as a bad install, not a missing one',
      /reinstall/i.test(ffmpeg.problem ?? ''),
      ffmpeg.problem
    )
    check(
      'a broken bundled copy does not fall back to PATH',
      ffmpeg.source === null,
      'it must not report the PATH copy, because that hides the broken install'
    )
    check('a required addon that failed is blocking', ffmpeg.blocking === true)
    check('an unavailable addon has no path to report', ffmpeg.path === null)
  })
}

/* ---------------- nothing bundled ---------------- */

section('nothing bundled')

{
  const dir = join(FIX, 'empty')
  mkdirSync(dir, { recursive: true })
  await withAddonsDir(dir, async (d) => {
    const ffmpeg = byId(await d.addonStatuses(), 'ffmpeg')
    // Whether PATH happens to have an ffmpeg depends on the machine, so the one
    // thing asserted is that nothing is claimed to be bundled.
    check(
      'with nothing bundled, ffmpeg is not claimed to be bundled',
      ffmpeg.source !== 'bundled',
      `source was ${ffmpeg.source}`
    )
    check(
      'a missing ffmpeg is either absent or a PATH copy',
      ffmpeg.available === false || ffmpeg.source === 'path',
      JSON.stringify(ffmpeg)
    )
    check('a missing ffmpeg explains itself', (ffmpeg.problem ?? '').length > 0)
  })
}

/* ---------------- the bundled folder is the one used ---------------- */

section('the bundled folder is the one used')

{
  // Stands in for any binary that starts and prints a version. Python is
  // probed with `--version`, which node accepts, so a copy of node answers and
  // exits 0 - enough to exercise the available path, the source, the path
  // reported and the non-ffmpeg branch of the version parser, all without
  // shipping a fixture binary.
  const dir = join(FIX, 'answers')
  mkdirSync(dir, { recursive: true })
  copyFileSync(process.execPath, join(dir, 'python.exe'))

  await withAddonsDir(dir, async (d) => {
    const python = byId(await d.addonStatuses(), 'python')
    check('a bundled binary that answers is available', python.available === true, python.problem)
    check('it is reported as bundled', python.source === 'bundled', python.source)
    check('the path points at the bundled copy', (python.path ?? '').includes('answers'), python.path)
    check('it is not blocking, because Python is optional', python.blocking === false)
  })
}

section('version output')

{
  const dir = join(FIX, 'version-parse')
  mkdirSync(dir, { recursive: true })
  copyFileSync(process.execPath, join(dir, 'python.exe'))
  await withAddonsDir(dir, async (d) => {
    const python = byId(await d.addonStatuses(), 'python')
    check('a version string is captured', typeof python.version === 'string' && python.version.length > 0)
    check('a leading v is stripped', !(python.version ?? '').startsWith('v'), python.version)
    check('the version is one line', !/[\r\n]/.test(python.version ?? ''), python.version)
    check('the version has no leading or trailing space', python.version === python.version?.trim())
    check('an available addon has no problem to report', python.problem === null)
  })
}

/* ---------------- caching ---------------- */

section('caching')

{
  const dir = join(FIX, 'cache')
  mkdirSync(dir, { recursive: true })
  await withAddonsDir(dir, async (d) => {
    const first = await d.addonStatuses()
    const second = await d.addonStatuses()
    check('a second call is answered from the cache', first === second)

    const third = await d.refreshAddonStatuses()
    check('refresh re-probes rather than reusing the cache', third !== first)
    check('refresh reports the same tools', third.length === first.length)

    d.clearAddonCache()
    const fourth = await d.addonStatuses()
    check('clearAddonCache drops the answer', fourth !== third)
  })
}

/* ---------------- requireAddon ---------------- */

section('requiring an addon')

{
  const dir = join(FIX, 'require')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ffmpeg.exe'), 'not a program')
  await withAddonsDir(dir, async (d) => {
    let message = ''
    try {
      await d.requireAddon('ffmpeg')
    } catch (err) {
      message = err.message
    }
    check('asking for an unusable addon throws', message.length > 0)
    check('the error names the tool', /ffmpeg/i.test(message), message)
    check('the error says what to do', /reinstall/i.test(message), message)
    check('hasAddon agrees with the failure', (await d.hasAddon('ffmpeg')) === false)
  })
}

/* ---------------- the real thing ---------------- */

section('the bundled binaries')

if (!existsSync(join(VENDOR, 'ffmpeg.exe'))) {
  console.log('  --  skipped: no vendor/addons; run "npm run addons" to include this group')
} else {
  detect.clearAddonCache()
  const list = await detect.addonStatuses()

  for (const id of ['ffmpeg', 'ffprobe']) {
    const addon = byId(list, id)
    check(`${id} is available`, addon.available === true, addon.problem)
    check(`${id} came from the bundle`, addon.source === 'bundled', addon.source)
    check(`${id} reported a version`, typeof addon.version === 'string' && addon.version.length > 0)
    check(`${id} has no problem to report`, addon.problem === null)
    check(`${id} has no stray newline in the version`, !/[\r\n]/.test(addon.version ?? ''))
  }

  const ffmpeg = byId(list, 'ffmpeg')
  check(
    'the reported version looks like a version and not a whole banner',
    // FFmpeg reports a git-describe string, not semver: a tagged release is
    // `n9.0`, and a rebuild of the branch is
    // `n9.0.2-22-g46d8f462ee-20261001` - release, commits since it, abbreviated
    // hash, build date. The optional `n` accepts both, and anchoring the match at
    // the start still rejects the whole `-version` banner if parsing ever picks
    // up the wrong line.
    /^n?\d+\.\d+/.test(ffmpeg.version ?? ''),
    ffmpeg.version
  )
  check(
    'the bundled path is inside vendor/addons',
    (ffmpeg.path ?? '').replace(/\\/g, '/').includes('vendor/addons'),
    ffmpeg.path
  )

  // Optional addons are genuinely optional, so a machine without them is normal.
  // What must never happen is one being reported as blocking, or being absent
  // without an explanation the user could act on.
  check(
    'no optional addon is blocking',
    list.filter((a) => a.need === 'optional').every((a) => a.blocking === false)
  )
  check(
    'every optional addon that is absent explains itself',
    list.filter((a) => a.need === 'optional' && !a.available).every((a) => (a.problem ?? '').length > 0)
  )
  check(
    'an available optional addon points at a real path',
    list.filter((a) => a.available && a.source === 'path').every((a) => (a.path ?? '').length > 0)
  )
}

/* ---------------- the licence travels with the binaries ---------------- */

section('the licence travels with the binaries')

if (!existsSync(join(VENDOR, 'ffmpeg.exe'))) {
  console.log('  --  skipped: no vendor/addons')
} else {
  const licence = join(VENDOR, 'FFMPEG-LICENSE.txt')
  check('the FFmpeg licence was copied out of the archive', existsSync(licence))
  if (existsSync(licence)) {
    const text = readFileSync(licence, 'utf8')
    check(
      'the licence is the LGPL text, which is what this build is',
      /GNU LESSER GENERAL PUBLIC LICENSE/i.test(text),
      text.slice(0, 80)
    )
  }

  // The stamp is what makes a changed pin take effect, so it has to record the
  // pin *and* be written so that a second run can recognise its own work. It
  // previously stored a machine-readable block followed by the LGPL notice and
  // then compared the whole file against the block, which could never match, so
  // every run refetched 160 MB.
  const stamp = join(VENDOR, 'FFMPEG-BUILD.txt')
  check('a build stamp records which archive was fetched', existsSync(stamp))
  if (existsSync(stamp)) {
    const text = readFileSync(stamp, 'utf8')
    const [pin] = text.split('\n\n')
    check(
      'the stamp pins the LGPL archive by checksum',
      /^url: .*win64-lgpl/m.test(pin ?? '') && /^sha256: [0-9a-f]{64}$/m.test(pin ?? ''),
      (pin ?? '').slice(0, 80)
    )
    check(
      'the stamp points at an exact FFmpeg commit, not just a version, because a tag is not the source of a rolling-branch build',
      /^source: https:\/\/github\.com\/FFmpeg\/FFmpeg\/commit\/[0-9a-f]{40}$/m.test(pin ?? ''),
      (pin ?? '').slice(0, 120)
    )
    check(
      'and the reported version is the full git describe of those binaries',
      /^version: n\d+\.\d+\.\d+-\d+-g[0-9a-f]{7,}$/m.test(pin ?? ''),
      (pin ?? '').slice(0, 120)
    )
    check(
      'and the human-readable licence notice sits below the machine-readable half',
      /GNU LESSER|little.*Free|LGPL/i.test(text) && (pin ?? '').length < text.length,
      text.slice(0, 60)
    )
    check(
      'the notice says the binaries may be rebuilt, so the LGPL obligations are stated not just referenced',
      /rebuild and replace/i.test(text),
      'no rebuild-and-replace wording in the stamp'
    )
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (fail) {
  console.log('\nFailures:')
  for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail ? 1 : 0)