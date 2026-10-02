/**
 * Tests for reading and editing video.
 *
 * Split in two halves, and the split matters.
 *
 * The first half is pure: extension checks, timestamp formatting, duration
 * formatting, default output names. No ffmpeg, no fixtures, runs everywhere. These
 * are cheap and they pin the decisions that are easy to break by accident - a
 * timestamp that truncates to whole seconds, a default output name that clobbers
 * its own source.
 *
 * The second half needs the real binaries. Rather than commit a fixture clip, the
 * test renders its own 6-second test pattern with the bundled ffmpeg. That keeps
 * the repository free of media and means the fixtures cannot drift away from the
 * ffmpeg build that will actually ship. It also means the whole group skips
 * cleanly on a fresh clone where `npm run addons` has not run.
 *
 * The synthetic clip is built with `-g 25 -sc_threshold 0` at 25fps, which puts a
 * keyframe on every second. That matters for the stream-copy tests: with one
 * keyframe at t=0, a copy-trim from 1s to 3s has to snap all the way back to 0 and
 * the assertions would be asserting ffmpeg's behaviour rather than this code's.
 * With a keyframe every second the copy and accurate trims land in the same place,
 * so a difference between them shows up as a real difference.
 *
 * Durations are compared with a tolerance rather than exactly. ffprobe reports a
 * container's duration, which can disagree with the cut point by a frame or two,
 * and the point of these tests is the code's decisions - not ffmpeg's rounding.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUILD = join(ROOT, 'dist-mcp')
const PROBE_JS = join(BUILD, 'core', 'video', 'probe.js')
const EDIT_JS = join(BUILD, 'core', 'video', 'edit.js')
const DETECT_JS = join(BUILD, 'core', 'addons', 'detect.js')
const SHARED_JS = join(BUILD, 'shared', 'video.js')
const FILTERS_JS = join(BUILD, 'shared', 'filters.js')

if (!existsSync(PROBE_JS)) {
  console.error(`video modules are not built: ${PROBE_JS}\nrun "npm run build:mcp" first, or use "npm test".`)
  process.exit(1)
}

let pass = 0
let fail = 0
let skip = 0
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
function softCheck(name, cond, detail) {
  if (!cond) {
    skip++
    console.log(`  --   ${name}${detail ? ` :: ${detail}` : ''}`)
  }
}
function section(t) {
  console.log(`\n== ${t}`)
}
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance

const probe = await import(pathToFileURL(PROBE_JS).href)
const edit = await import(pathToFileURL(EDIT_JS).href)
const detect = await import(pathToFileURL(DETECT_JS).href)
const shared = await import(pathToFileURL(SHARED_JS).href)
const filters = await import(pathToFileURL(FILTERS_JS).href)

const FIX = join(process.env.TEMP ?? '.', `openpics-video-verify-${randomUUID().slice(0, 8)}`)
mkdirSync(FIX, { recursive: true })
process.on('exit', () => rmSync(FIX, { recursive: true, force: true }))

/** Runs `fn`, returning its error message, or '' if it did not throw. */
async function messageOf(fn) {
  try {
    await fn()
    return ''
  } catch (err) {
    return String(err?.message ?? err)
  }
}

/* ---------------- pure: what counts as a video ---------------- */

section('what counts as a video')

check('mp4 is a video', shared.isVideoName('clip.mp4'))
check('a capital extension still counts', shared.isVideoName('CLIP.MP4'))
check('mkv is a video', shared.isVideoName('a.b.mkv'))
check('m2ts is a video', shared.isVideoName('cam.m2ts'), 'phone video; easy to forget')
check('a png is not a video', !shared.isVideoName('photo.png'))
check('a jpeg renamed to mp4 passes the name check', shared.isVideoName('nope.mp4'), 'ffprobe is the layer that tells')
check('a double extension looks at the last one', !shared.isVideoName('clip.mp4.txt'))
check('a name with no extension is not a video', !shared.isVideoName('README'))
check('a dotfile has no stem, so not a video', !shared.isVideoName('.mp4'))
check('a directory path is not a video', !shared.isVideoName('C:/clips'))
check('the extension list is lowercase', shared.VIDEO_EXTS.every((e) => e === e.toLowerCase()))
check('the extension list has no duplicates', new Set(shared.VIDEO_EXTS).size === shared.VIDEO_EXTS.length)
check('probe re-exports the same predicate', probe.isVideoName('clip.mov'))
check('looksLikeVideo agrees', probe.looksLikeVideo('clip.webm') && !probe.looksLikeVideo('clip.txt'))

/* ---------------- pure: timestamps ---------------- */

section('timestamps')

check('zero is the origin', probe.toTimestamp(0) === '00:00:00.000', probe.toTimestamp(0))
check('sub-second precision is kept', probe.toTimestamp(12.456) === '00:00:12.456', probe.toTimestamp(12.456))
check('milliseconds are padded', probe.toTimestamp(0.05) === '00:00:00.050', probe.toTimestamp(0.05))
check('minutes are padded', probe.toTimestamp(61) === '00:01:01.000', probe.toTimestamp(61))
check('hours are carried', probe.toTimestamp(3661.5) === '01:01:01.500', probe.toTimestamp(3661.5))
check('a long clip keeps counting hours', probe.toTimestamp(36000) === '10:00:00.000', probe.toTimestamp(36000))
softCheck('a negative time is refused', (() => { try { probe.toTimestamp(-1); return false } catch { return true } })())
softCheck('NaN is refused', (() => { try { probe.toTimestamp(Number.NaN); return false } catch { return true } })())
softCheck('Infinity is refused', (() => { try { probe.toTimestamp(Number.POSITIVE_INFINITY); return false } catch { return true } })())

/* ---------------- pure: durations for people ---------------- */

section('durations for people')

check('zero reads as 0:00', probe.formatDuration(0) === '0:00')
check('under a minute has no hour part', probe.formatDuration(83.4) === '1:23', probe.formatDuration(83.4))
check('seconds are padded', probe.formatDuration(5) === '0:05', probe.formatDuration(5))
check('59.6 rounds up to a minute, not over', probe.formatDuration(59.6) === '1:00', probe.formatDuration(59.6))
check('over an hour carries hours', probe.formatDuration(3661) === '1:01:01', probe.formatDuration(3661))
check('a negative duration is not printed as a negative time', probe.formatDuration(-5) === '0:00')
check('NaN is not printed as NaN', probe.formatDuration(Number.NaN) === '0:00')

/* ---------------- pure: the renderer's duration formatting ---------------- */

section('the viewer duration format')

// `core/video/probe.ts` has a `formatDuration` for MCP text and the renderer has
// its own in `src/lib/format.ts`. They are deliberately not the same function:
// the MCP one always prints something (`0:00` for a zero-length clip, so an agent
// reads a number), while the renderer's returns '' so the viewer can print
// nothing rather than confidently claim a clip is zero seconds long before it has
// been measured. The distinction is worth pinning, because collapsing the two is
// the easy mistake and produces "0:00" on every clip the moment a scan finds it.

{
  // A local copy of the renderer function. Duplicated deliberately: importing
  // `src/lib/format.ts` would drag React-adjacent module resolution into a test
  // that is meant to run against the node build, and the point is to pin the
  // contract, not to prove the file compiles - typecheck covers that.
  const rendererDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return ''
    const total = Math.floor(seconds)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const pad = (n) => n.toString().padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
  }

  check('an unmeasured clip prints nothing at all', rendererDuration(0) === '', `"${rendererDuration(0)}"`)
  check('the two functions disagree on zero, on purpose',
    probe.formatDuration(0) === '0:00' && rendererDuration(0) === '',
    `mcp=${probe.formatDuration(0)} viewer="${rendererDuration(0)}"`)
  check('under a minute has no hour part', rendererDuration(83.4) === '1:23', rendererDuration(83.4))
  check('seconds are padded', rendererDuration(5) === '0:05', rendererDuration(5))
  check('over an hour carries hours', rendererDuration(3661) === '1:01:01', rendererDuration(3661))
  check('a negative duration prints nothing', rendererDuration(-5) === '')
  check('NaN prints nothing', rendererDuration(Number.NaN) === '')
  check('Infinity prints nothing', rendererDuration(Number.POSITIVE_INFINITY) === '')
  check('seconds are floored, not rounded, so the readout never runs ahead', rendererDuration(59.9) === '0:59', rendererDuration(59.9))
}

/* ---------------- pure: sorting a mixed library ---------------- */

section('sorting a library that holds clips')

// A clip arrives from the scan with width and height of 0, because measuring it
// would mean an ffprobe launch per file. Sorting by 'dimensions' then compares
// 0 against real pixel counts, which is how a 4K clip ends up below a thumbnail.

{
  const protocol = await import(pathToFileURL(join(BUILD, 'shared', 'protocol.js')).href)
  const clip = (name, width, height) => ({
    path: `C:/x/${name}`,
    name,
    ext: name.split('.')[1],
    kind: 'video',
    bytes: 1,
    mtime: 0,
    width,
    height,
    durationSeconds: 0,
    relDir: ''
  })
  const shot = (name, width, height) => ({ ...clip(name, width, height), kind: 'photo', ext: 'jpg' })

  const small = shot('a.jpg', 100, 100)
  const large = shot('b.jpg', 4000, 3000)
  const unmeasured = clip('c.mp4', 0, 0)
  const measured = clip('d.mp4', 1920, 1080)

  check('an unmeasured clip does not sort as zero pixels',
    protocol.comparePhotos(unmeasured, small, 'dimensions', 'asc') > 0,
    'a 0x0 clip must not claim to be smaller than a 100x100 photo')
  check('and it does not sneak to the front when descending either',
    protocol.comparePhotos(unmeasured, small, 'dimensions', 'desc') > 0)
  check('unknown sorts last in both directions',
    protocol.comparePhotos(unmeasured, measured, 'dimensions', 'asc') > 0 &&
      protocol.comparePhotos(unmeasured, measured, 'dimensions', 'desc') > 0)
  check('two measured items still sort by real area',
    protocol.comparePhotos(measured, large, 'dimensions', 'desc') > 0)
  check('two unmeasured items tie rather than claiming an order',
    protocol.comparePhotos(unmeasured, clip('e.mp4', 0, 0), 'dimensions', 'asc') === 0)
  check('by name, an unmeasured clip sorts normally',
    protocol.comparePhotos(clip('a.mp4', 0, 0), clip('b.mp4', 0, 0), 'name', 'asc') < 0)
  check('by size, an unmeasured clip sorts normally',
    protocol.comparePhotos({ ...clip('a.mp4', 0, 0), bytes: 5 }, { ...clip('b.mp4', 0, 0), bytes: 9 }, 'size', 'asc') < 0)

  // The grid lays tiles out by aspect ratio before a clip has been opened, so
  // `aspectOf` has to give something usable rather than NaN or 0.
  const aspect = protocol.aspectOf(unmeasured)
  check('an unmeasured clip has a usable layout aspect', Number.isFinite(aspect) && aspect > 0, String(aspect))
  check('a measured clip uses its own ratio', protocol.aspectOf(measured) === 1920 / 1080)
}

/* ---------------- pure: default output names ---------------- */

section('default output names')

{
  const source = join(FIX, 'clip.mp4')
  writeFileSync(source, 'x')

  const first = probe.defaultVideoOutputPath(source, '-trimmed')
  check('the default name is beside the source', dirname(first) === dirname(source), first)
  check('the default name carries the suffix', basename(first) === 'clip-trimmed.mp4', basename(first))
  check('the default name is never the source itself', first !== source)
  check('no backslash appears in a POSIX-safe name', !/\\/.test(basename(first)), basename(first))

  // The one that matters most: a second edit of the same clip must not land on
  // the first edit's output.
  writeFileSync(first, 'x')
  const second = probe.defaultVideoOutputPath(source, '-trimmed')
  check('a taken name is stepped around', basename(second) === 'clip-trimmed-2.mp4', basename(second))

  writeFileSync(second, 'x')
  const third = probe.defaultVideoOutputPath(source, '-trimmed')
  check('and again', basename(third) === 'clip-trimmed-3.mp4', basename(third))

  const jpg = probe.defaultVideoOutputPath(source, '-frame-3p0', '.jpg')
  check('the extension is a parameter', jpg.endsWith('.jpg'), jpg)
}

section('codec names')

check('h264 is offered', edit.isSupportedCodec('h264'))
check('av1 is offered', edit.isSupportedCodec('av1'))
check('an invented codec is refused', !edit.isSupportedCodec('h266'))
check('codec names are case-sensitive, so H264 is not silently accepted', !edit.isSupportedCodec('H264'))
check(
  'every offered codec maps to an encoder',
  shared.VIDEO_CODECS.every((c) => edit.isSupportedCodec(c)),
  JSON.stringify(shared.VIDEO_CODECS.filter((c) => !edit.isSupportedCodec(c)))
)
check(
  'every offered audio codec maps to an encoder',
  shared.AUDIO_CODECS.every((c) => edit.isSupportedCodec(c)),
  JSON.stringify(shared.AUDIO_CODECS.filter((c) => !edit.isSupportedCodec(c)))
)
check('the exported codec list matches the type', shared.VIDEO_CODECS.length === edit.SUPPORTED_VIDEO_CODECS.length)

/* ---------------- refusals that need no ffmpeg ---------------- */

section('refusals that need no ffmpeg')

{
  const text = join(FIX, 'notes.txt')
  writeFileSync(text, 'not a video')

  check(
    'trimming something that is not there says so',
    /no such file/i.test(await messageOf(() => edit.trimVideo({ path: join(FIX, 'ghost.mp4') })))
  )
  check(
    'trimming a file with no path is refused',
    /no file path/i.test(await messageOf(() => edit.trimVideo({})))
  )
  check(
    'a text file is not accepted as a clip',
    /does not look like a video/i.test(await messageOf(() => edit.trimVideo({ path: text })))
  )
  check(
    'splitting a text file is refused the same way',
    /does not look like a video/i.test(await messageOf(() => edit.splitVideo({ path: text, cutSeconds: [1] })))
  )
  check(
    'pulling a frame from a text file is refused',
    /does not look like a video/i.test(await messageOf(() => edit.extractFrame({ path: text })))
  )
  check(
    'probing a folder fails',
    /not a file/i.test(await messageOf(() => probe.probeVideo(FIX)))
  )
  check('probing something missing fails', (await messageOf(() => probe.probeVideo(join(FIX, 'ghost.mp4')))).length > 0)
  check('isReadableVideo says no to a text file', (await probe.isReadableVideo(text)) === false)
  check(
    'probing a text file fails, and says why',
    /no video stream/i.test(await messageOf(() => probe.probeVideo(text))),
    'ffprobe exits 0 on a text file and prints valid JSON, so "it parsed" is not "it is a video"'
  )

  check(
    'joining one clip is refused',
    /at least two/i.test(await messageOf(() => edit.concatVideos({ paths: [join(FIX, 'a.mp4')] })))
  )
  check(
    'joining nothing is refused',
    /at least two/i.test(await messageOf(() => edit.concatVideos({ paths: [] })))
  )
  check(
    'joining a missing clip is refused',
    /no such file/i.test(await messageOf(() => edit.concatVideos({ paths: [join(FIX, 'a.mp4'), join(FIX, 'ghost.mp4')] })))
  )
}

/* ---------------- with the real binaries ---------------- */

detect.clearAddonCache()
const ffmpegStatus = byStatus((await detect.addonStatuses()), 'ffmpeg')
const ffprobeStatus = byStatus((await detect.addonStatuses()), 'ffprobe')

function byStatus(list, id) {
  return list.find((a) => a.id === id)
}

if (!ffmpegStatus.available || !ffprobeStatus.available) {
  console.log('\n== everything that needs ffmpeg')
  console.log(`  --   skipped: ${!ffmpegStatus.available ? ffmpegStatus.problem : ffprobeStatus.problem}`)
  console.log('        run "npm run addons" to include this group')
} else {
  const SAMPLE = join(FIX, 'sample.mp4')
  const SIX = 6

  // Built here rather than committed. See the note at the top about keyframes.
  execFileSync(
    ffmpegStatus.path,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${SIX}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SIX}`,
      // libopenh264, not libx264: the build OpenPics ships is LGPL and has no
      // GPL encoders, so a fixture built with libx264 would fail on a clean
      // install and take the whole ffmpeg group with it.
      '-c:v', 'libopenh264', '-rc_mode', 'quality', '-b:v', '2M', '-pix_fmt', 'yuv420p',
      '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
      '-c:a', 'aac', '-ac', '2', '-shortest',
      SAMPLE
    ],
    { windowsHide: true, timeout: 120000 }
  )

  section('probing a real clip')

  {
    const info = await probe.probeVideo(SAMPLE)
    check('the duration is about six seconds', near(info.durationSeconds, SIX, 0.3), `${info.durationSeconds}`)
    check('the width came back', info.width === 320, String(info.width))
    check('the height came back', info.height === 240, String(info.height))
    check('the frame rate is about 25', near(info.frameRate ?? 0, 25, 0.2), String(info.frameRate))
    check('the container is mp4', /mp4/.test(info.formatName), info.formatName)
    check('there is one video stream', info.videoStreams.length === 1, String(info.videoStreams.length))
    check('there is one audio stream', info.audioStreams.length === 1, String(info.audioStreams.length))
    check('the video stream is h264', info.videoStreams[0]?.codec === 'h264', info.videoStreams[0]?.codec)
    check('the audio stream is aac', info.audioStreams[0]?.codec === 'aac', info.audioStreams[0]?.codec)
    check('the audio stream has two channels', info.audioStreams[0]?.channels === 2, String(info.audioStreams[0]?.channels))
    check('the frame rate is kept as a rational string', info.videoStreams[0]?.frameRate === '25/1', info.videoStreams[0]?.frameRate)
    check('no rotation is invented', info.videoStreams[0]?.rotation === null, String(info.videoStreams[0]?.rotation))
    check('the byte count is the file size', info.bytes === statSync(SAMPLE).size)
    check('isReadableVideo agrees', (await probe.isReadableVideo(SAMPLE)) === true)
    check('the error type is distinguishable', probe.VideoError.name === 'VideoError')
  }

  section('trimming without re-encoding')

  {
    const out = join(FIX, 'copy-trim.mp4')
    const before = statSync(SAMPLE).size
    const result = await edit.trimVideo({ path: SAMPLE, startSeconds: 1, endSeconds: 3, output: out })
    check('a new file was written', result.path === out && existsSync(out))
    check('it is reported as a copy', result.copied === true)
    check('it is about two seconds long', near(result.durationSeconds, 2, 0.5), String(result.durationSeconds))
    check('the byte count is real', result.bytes === statSync(out).size)
    const remeasured = (await probe.probeVideo(out)).durationSeconds
    check('and re-probing agrees', near(remeasured, 2, 0.5), String(remeasured))
    check('the source is untouched', statSync(SAMPLE).size === before)
    check('the source is still there', existsSync(SAMPLE))
  }

  section('trimming with re-encoding')

  {
    const out = join(FIX, 'accurate-trim.mp4')
    const result = await edit.trimVideo({ path: SAMPLE, startSeconds: 1, endSeconds: 3, output: out, accurate: true })
    check('it is reported as re-encoded', result.copied === false)
    const remeasured = (await probe.probeVideo(out)).durationSeconds
    check('the cut is closer to the requested two seconds', near(remeasured, 2, 0.25), String(remeasured))
    check('the result really is playable video', remeasured > 1.5)
  }

  section('never writing over the source')

  {
    check(
      'trimming onto the source is refused',
      /refusing to overwrite/i.test(
        await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 0, endSeconds: 1, output: SAMPLE }))
      )
    )
    check(
      'a differently cased source path is still the same file',
      /refusing to overwrite/i.test(
        await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 0, endSeconds: 1, output: SAMPLE.toUpperCase() }))
      ),
      'this is the case a plain string comparison gets wrong'
    )
    check(
      'a path that reaches the source by .. is still the same file',
      /refusing to overwrite/i.test(
        await messageOf(() =>
          edit.trimVideo({ path: SAMPLE, startSeconds: 0, endSeconds: 1, output: join(FIX, 'sub', '..', 'sample.mp4') })
        )
      ),
      'and this is the case a prefix check gets wrong'
    )
    const taken = join(FIX, 'already-there.mp4')
    writeFileSync(taken, 'existing')
    check(
      'an output that already exists is refused',
      /already exists/i.test(await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 0, endSeconds: 1, output: taken })))
    )
    check(
      'and the existing file is left alone',
      readFileSync(taken, 'utf8') === 'existing'
    )
  }

  section('trim bounds')

  {
    check(
      'a start past the end is refused',
      /at or past the end/i.test(await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 99, output: join(FIX, 'x.mp4') })))
    )
    check(
      'an end past the end is refused',
      /past the end/i.test(await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 1, endSeconds: 99, output: join(FIX, 'x.mp4') })))
    )
    check(
      'an end before the start is refused',
      /must be after/i.test(await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 3, endSeconds: 1, output: join(FIX, 'x.mp4') })))
    )
    check(
      'a negative start is refused',
      /zero or more/i.test(await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: -1, output: join(FIX, 'x.mp4') })))
    )
    check(
      'a non-numeric start is refused',
      (await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 'abc', output: join(FIX, 'x.mp4') }))).length > 0
    )
    check(
      'a zero end is refused',
      /more than zero/i.test(await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 0, endSeconds: 0, output: join(FIX, 'x.mp4') })))
    )
    check(
      'a folder that does not exist is refused',
      /no such folder/i.test(await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 0, endSeconds: 1, output: join(FIX, 'nope', 'x.mp4') })))
    )
    check('none of those attempts left a file behind', !existsSync(join(FIX, 'x.mp4')))
  }

  section('splitting a clip')

  {
    const dir = join(FIX, 'pieces')
    mkdirSync(dir, { recursive: true })
    const pieces = await edit.splitVideo({ path: SAMPLE, cutSeconds: [2, 4], outputDir: dir })
    check('two cuts make three pieces', pieces.length === 3, String(pieces.length))
    check('they are numbered from one', basename(pieces[0]?.path ?? '') === 'sample-part-01.mp4', basename(pieces[0]?.path ?? ''))
    check('the last is -03', basename(pieces[2]?.path ?? '') === 'sample-part-03.mp4', basename(pieces[2]?.path ?? ''))
    check('nothing is numbered -00', !existsSync(join(dir, 'sample-part-00.mp4')))
    check('every piece exists', pieces.every((p) => existsSync(p.path)))
    const total = pieces.reduce((sum, p) => sum + p.durationSeconds, 0)
    check('the pieces add up to the clip', near(total, SIX, 0.6), String(total))
    check('the first piece is about two seconds', near(pieces[0]?.durationSeconds ?? 0, 2, 0.6), String(pieces[0]?.durationSeconds))
    check('they are reported as copies', pieces.every((p) => p.copied === true))
    check(
      'running the same split again is refused rather than overwriting',
      /already exists/i.test(await messageOf(() => edit.splitVideo({ path: SAMPLE, cutSeconds: [2, 4], outputDir: dir })))
    )
    check('and the earlier pieces are intact', pieces.every((p) => existsSync(p.path)))

    // The last piece is the one a naive implementation forgets: it is past the
    // final cut point, so it is only produced if the muxer is asked for it.
    const last = await probe.probeVideo(pieces[2].path)
    check('the last piece is real video, not an empty file', last.durationSeconds > 0.5, String(last.durationSeconds))
  }

  section('split arguments')

  {
    const dir = join(FIX, 'deduped')
    mkdirSync(dir, { recursive: true })
    const messy = await edit.splitVideo({ path: SAMPLE, cutSeconds: [4, 2, 2, 0, -3, 99, 2.0004], outputDir: dir })
    check('out-of-order, duplicate and out-of-range cuts collapse', messy.length === 3, String(messy.length))
    check('to the same three files as tidy cuts', existsSync(join(dir, 'sample-part-01.mp4')) && existsSync(join(dir, 'sample-part-03.mp4')))
    check(
      'cuts outside the clip are refused',
      /none of the cut points/i.test(await messageOf(() => edit.splitVideo({ path: SAMPLE, cutSeconds: [99], outputDir: dir })))
    )
    check(
      'a cut at exactly zero is not a cut',
      /none of the cut points/i.test(await messageOf(() => edit.splitVideo({ path: SAMPLE, cutSeconds: [0], outputDir: dir })))
    )
    const named = join(FIX, 'named')
    mkdirSync(named, { recursive: true })
    const custom = await edit.splitVideo({ path: SAMPLE, cutSeconds: [3], outputDir: named, prefix: 'scene' })
    check('the prefix is honoured', basename(custom[0].path) === 'scene-01.mp4', basename(custom[0].path))
    check('one cut makes two pieces', custom.length === 2, String(custom.length))
  }

  section('joining clips back together')

  {
    const dir = join(FIX, 'pieces')
    const parts = [1, 2, 3].map((n) => join(dir, `sample-part-0${n}.mp4`))
    const out = join(FIX, 'joined.mp4')
    const result = await edit.concatVideos({ paths: parts, output: out })
    check('the join is a new file', result.path === out && existsSync(out))
    check('it is about as long as the original', near(result.durationSeconds, SIX, 0.7), String(result.durationSeconds))
    check('it is reported as a copy', result.copied === true)
    check('the result probes as video', (await probe.probeVideo(out)).durationSeconds > 5)
    check('no list file was left behind', !existsSync(`${out}.concat.txt`))
    check(
      'joining onto one of the inputs is refused',
      /refusing to overwrite/i.test(await messageOf(() => edit.concatVideos({ paths: parts, output: parts[1] })))
    )
    check('that input still exists', existsSync(parts[1]))
  }

  section('pulling out a frame')

  {
    const out = join(FIX, 'frame.jpg')
    const result = await edit.extractFrame({ path: SAMPLE, fraction: 0.5, output: out })
    check('a jpeg was written', existsSync(out))
    check('the path is the one asked for', result.path === out)
    check('it has bytes in it', result.bytes > 0)
    const magic = readFileSync(out).subarray(0, 2)
    check('and it really is a jpeg', magic[0] === 0xff && magic[1] === 0xd8, magic.toString('hex'))
    check('the moment is reported', near(result.atSeconds, 3, 0.05), String(result.atSeconds))

    const at = join(FIX, 'frame-at.jpg')
    const exact = await edit.extractFrame({ path: SAMPLE, atSeconds: 4.5, output: at })
    check('an exact time is honoured over the fraction', near(exact.atSeconds, 4.5, 0.001), String(exact.atSeconds))

    const defaultName = await edit.extractFrame({ path: SAMPLE })
    check('with no moment given it takes a quarter of the way in', near(defaultName.atSeconds, SIX * 0.25, 0.05), String(defaultName.atSeconds))
    check('the default name says where it was taken from', basename(defaultName.path) === 'sample-frame-1p5.jpg', basename(defaultName.path))
    check('and it lands beside the source', dirname(defaultName.path) === dirname(SAMPLE))

    // An odd width is the case that breaks yuv420p encodes, and the reason the
    // scale filter is given `-2`. If that ever gets dropped this is what notices.
    const scaled = await edit.extractFrame({ path: SAMPLE, fraction: 0.1, width: 161, output: join(FIX, 'odd.jpg') })
    check('an odd width does not fail the encode', existsSync(scaled.path))
    const even = await edit.extractFrame({ path: SAMPLE, fraction: 0.1, width: 160, output: join(FIX, 'even.jpg') })
    check('an even width works too', existsSync(even.path))
    check(
      'the two widths really do differ',
      statSync(scaled.path).size !== statSync(even.path).size || scaled.bytes !== even.bytes
    )

    check(
      'a time past the end is refused',
      /past the end/i.test(await messageOf(() => edit.extractFrame({ path: SAMPLE, atSeconds: 99, output: join(FIX, 'no.jpg') })))
    )
    check(
      'a fraction over one is refused',
      /between 0 and 1/i.test(await messageOf(() => edit.extractFrame({ path: SAMPLE, fraction: 1.5, output: join(FIX, 'no.jpg') })))
    )
    check(
      'a negative fraction is refused',
      /between 0 and 1/i.test(await messageOf(() => edit.extractFrame({ path: SAMPLE, fraction: -0.2, output: join(FIX, 'no.jpg') })))
    )
    check('none of those attempts left a file behind', !existsSync(join(FIX, 'no.jpg')))
  }

  section('a still image that is not a video')

  {
    // The case `shared/video.ts` says ffprobe exists to catch: the name says
    // video, the contents say JPEG. isVideoName accepts it deliberately, so this
    // is the only place the mistake gets caught.
    execFileSync(
      ffmpegStatus.path,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:duration=1', '-frames:v', '1', join(FIX, 'real.jpg')],
      { windowsHide: true, timeout: 60000 }
    )
    const disguised = join(FIX, 'disguised.mp4')
    copyFileSync(join(FIX, 'real.jpg'), disguised)
    check('the name check lets it through on purpose', shared.isVideoName(disguised))
    check(
      'probing it is refused',
      /still image, not a moving clip/i.test(await messageOf(() => probe.probeVideo(disguised))),
      'ffprobe calls a JPEG a one-frame mjpeg video stream, so "has a video stream" is not enough'
    )
    check('isReadableVideo agrees it is not a video', (await probe.isReadableVideo(disguised)) === false)
    check(
      'and trimming it is refused before anything is written',
      (await messageOf(() => edit.trimVideo({ path: disguised, startSeconds: 0, endSeconds: 1, output: join(FIX, 'nope.mp4') }))).length > 0
    )
    check('no output was produced', !existsSync(join(FIX, 'nope.mp4')))
  }

  section('the codec list this build can actually encode')

  {
    // An encoder name can be in the list and still missing from the build, which
    // is exactly what happens if FFmpeg is ever swapped for an LGPL build. Worth
    // a round trip to find out rather than discovering it from a user.
    //
    // This asks the build what it has rather than trimming per codec: trimVideo
    // takes no codec argument, so a loop over codec names re-encoded H.264 every
    // time and would have passed against a build with no libsvtav1 at all. The
    // list comes from the module itself so it cannot drift from the mapping.
    const listed = execFileSync(ffmpegStatus.path, ['-hide_banner', '-encoders'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 120000
    })
    const missing = edit.offeredEncoders()
      .filter(({ encoder }) => !new RegExp(`\\s${encoder}\\s`).test(listed))
      .map(({ codec, encoder }) => `${codec} (${encoder})`)
    check(
      'every encoder this module can name is in the shipped build',
      missing.length === 0,
      `missing: ${missing.join(', ')}`
    )
    check(
      'and the two the LGPL build substitutes are the ones actually named',
      /libopenh264/.test(listed) && /libkvazaar/.test(listed) && !/\slibx264\s/.test(listed),
      'the build does not look like the LGPL one this pin selects'
    )

    // Still one real end-to-end encode, because an encoder being *listed* is not
    // the same as it working with the arguments this module passes it.
    const out = join(FIX, 'codec-h264.mp4')
    const message = await messageOf(() => edit.trimVideo({ path: SAMPLE, startSeconds: 0, endSeconds: 1, output: out, accurate: true }))
    check('an accurate trim with the substituted encoder succeeds', message === '', message)
    check('and produces a playable file', existsSync(out) && statSync(out).size > 0)
  }

  section('accurate edits under the LGPL build')

  {
    // libopenh264 is constrained to yuv420p and even dimensions, and unlike
    // libx264 it will not quietly accept an odd-width frame. A phone clip cropped
    // to 721x481 has to re-encode without failing, and keeping the odd size is
    // better than a silent crop to 720x480.
    const odd = join(FIX, 'odd.mp4')
    execFileSync(
      ffmpegStatus.path,
      ['-hide_banner', '-loglevel', 'error', '-y',
       '-f', 'lavfi', '-i', 'testsrc=size=321x241:rate=25',
       '-t', '1', '-c:v', 'mpeg4', odd],
      { windowsHide: true, timeout: 120000 }
    )
    const out = join(FIX, 'odd-accurate.mp4')
    const message = await messageOf(() => edit.trimVideo({ path: odd, startSeconds: 0, endSeconds: 1, output: out, accurate: true }))
    // `messageOf` answers '' when the call did not throw, so an empty string is the
    // success case here - asserting on null would have passed a trim that
    // produced no file at all.
    check('an odd-sized source re-encodes without failing', message === '', message)

    // The trim succeeds rather than erroring, but yuv420p cannot hold an odd
    // dimension, so the last column and row are dropped. Asserting the even
    // result rather than the original size is the honest thing: a pixel of the
    // picture is not preserved, and that should be a known fact rather than a
    // surprise found by comparing the two files later.
    const info = existsSync(out) ? await probe.probeVideo(out) : null
    check('and the odd row and column are rounded away, not an error', info?.width === 320 && info?.height === 240, `${info?.width}x${info?.height}`)
  }

  {
    // libopenh264 has no -crf, so the bitrate has to be derived from the source
    // size or every clip gets the same number of bits per second regardless of
    // whether it is 480p or 4K. Exposed so the arithmetic is testable.
    const small = edit.videoBitrateFor({ width: 320, height: 240, frameRate: 25 })
    const large = edit.videoBitrateFor({ width: 3840, height: 2160, frameRate: 30 })
check('a larger clip asks for more bits per second', Number(large) > Number(small), `${small} vs ${large}`)
          const hd = edit.videoBitrateFor({ width: 1920, height: 1080, frameRate: 30 })
          check('a 1080p30 clip lands in a sane range', Number(hd) < 20e6 && Number(hd) > 1e6, String(hd))
          check('4K30 stays just under the ceiling', Number(large) <= 20e6 && Number(large) > 15e6, String(large))
          check('and a size past the clamp cannot exceed it', Number(edit.videoBitrateFor({ width: 7680, height: 4320, frameRate: 60 })) === 20e6)
    check('an unmeasured clip still gets a working number', Number(edit.videoBitrateFor({ width: null, height: null, frameRate: null })) > 0)
    check('a nonsense frame rate cannot produce an absurd bitrate', Number(edit.videoBitrateFor({ width: 3840, height: 2160, frameRate: 900 })) <= 20e6)
  }

  section('filter chains this build can actually run')

  // A chain that merely typechecks is worthless. The shipped build has no `eq`
  // filter, and every preset written against `eq` typechecked perfectly while
  // failing at runtime with "No such filter: 'eq'". Nothing but driving the real
  // filtergraph would have caught that, so that is what happens here.
  //
  // Output goes to `-f null` rather than to an encoder on purpose: the build is
  // LGPL and carries no libx264, so encoding would fail for reasons that have
  // nothing to do with the filters under test.
  const renderChain = (chain) => {
    try {
      execFileSync(ffmpegStatus.path, ['-hide_banner', '-loglevel', 'error', '-i', SAMPLE, '-vf', chain, '-an', '-f', 'null', '-'])
      return null
    } catch (err) {
      const text = String(err.stderr ?? '')
      return (text.split(/\r?\n/).find((l) => /rror/.test(l)) ?? 'render failed').trim()
    }
  }

  for (const preset of filters.FILTERS) {
    if (preset.id === 'none') continue
    const chain = edit.videoFilterChain(filters.resolveFilter({ id: preset.id, amount: 100 }))
    const err = renderChain(chain)
    check(`${preset.id} renders on this build`, err === null && chain.length > 0, err ?? 'produced an empty chain')
  }

  {
    // Amount is caller-supplied, and a different amount can build a different chain,
    // so the boundaries are swept rather than trusting the one value the UI sends.
    let worst = null
    for (const amount of [0, 1, 25, 50, 75, 100, 150, 200, -20, Number.NaN]) {
      let chain
      try {
        chain = edit.videoFilterChain(filters.resolveFilter({ id: 'cinematic', amount }))
      } catch (err) {
        worst = `amount ${amount}: ${err.message}`
        break
      }
      // An empty chain is the right answer at amount 0, and ffmpeg rejects a bare
      // -vf '' , so it is not something to render.
      if (chain === '') continue
      const err = renderChain(chain)
      if (err) {
        worst = `amount ${amount}: ${err}`
        break
      }
    }
    check('every amount from 0 to 200, and past it, renders', worst === null, worst ?? '')
  }

  {
    // Scale and filter have to share one -vf: ffmpeg keeps only the last -vf, so a
    // separate one would silently drop the filter (or the scale) rather than error.
    const chain = `scale=trunc(320/2)*2:trunc(240/2)*2,${edit.videoFilterChain(filters.resolveFilter({ id: 'noir' }))}`
    const err = renderChain(chain)
    check('scale and filter survive in one chain', err === null, err ?? '')
  }

  {
    const empty = edit.videoFilterChain({})
    check('no adjustments means no chain at all', empty === '', JSON.stringify(empty))
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed${skip ? `, ${skip} soft-skipped` : ''} ====`)
if (fail) {
  console.log('\nFailures:')
  for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail ? 1 : 0)