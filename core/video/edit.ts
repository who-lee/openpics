import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, basename, resolve } from 'node:path'
import { requireAddon } from '../addons/detect'
import {
  AUDIO_CODECS,
  VIDEO_CODECS,
  type ConcatRequest,
  type FrameRequest,
  type SplitRequest,
  type TrimRequest,
  type VideoCodec,
  type VideoInfo,
  type VideoOutput
} from '../../shared/video'
import { defaultVideoOutputPath, formatDuration, isVideoName, probeVideo, toTimestamp, VideoError } from './probe'

/**
 * Editing a video.
 *
 * Two rules govern everything here.
 *
 * The first is that an edit never writes over the file it read. Trimming is easy
 * to get wrong by a frame and impossible to undo, so every operation produces a
 * new file and leaves the original untouched - the same promise `core/edit/io.ts`
 * makes for pictures, and for the same reason.
 *
 * The second is about what `-c copy` does and does not mean. Copying streams
 * rather than re-encoding is what makes a trim take a second instead of a minute,
 * and it is frame-exact as long as the cut lands on a keyframe. It is not
 * otherwise: ffmpeg copies from the nearest preceding keyframe, so the result can
 * start early or late. That is a real trade rather than a free win, so it is the
 * default with an explicit opt-out (`accurate`) instead of a hidden one - a
 * caller who needs the exact frame asked for can ask for it, and a caller who
 * does not is not silently given a minute-long render.
 */

/**
 * How a codec name maps onto the bundled FFmpeg, and how it is asked to encode.
 *
 * `h264` and `h265` deliberately do not name libx264 and libx265, which is what
 * anyone reaching for FFmpeg would expect. The build OpenPics ships is LGPL, and
 * libx264/libx265 are GPL - naming them would make every accurate trim fail on a
 * codec this build does not contain. OpenH264 (Cisco, BSD-2-Clause) and Kvazaar
 * (LGPL) encode the same two formats under terms the app is allowed to
 * redistribute, and both are compiled into the bundled build.
 *
 * The other names are unchanged and are all fine under LGPL: libvpx and libsvtav1
 * are BSD, the native mpeg4 encoder is FFmpeg's own, libmp3lame is LGPL.
 */
interface CodecSpec {
  /** The name ffmpeg knows the encoder by. */
  encoder: string
  /**
   * Rate control for this encoder.
   *
   * The GPL encoders took `-crf 20` and `-preset veryfast`. Neither option means
   * anything to OpenH264 or Kvazaar - worse, ffmpeg accepts them silently as
   * generic AVCodecContext settings and ignores them, so leaving them in place
   * would look like quality control while actually producing whatever the
   * encoder's defaults happen to be. These take real effect.
   */
  rateArgs: (info: VideoInfo) => string[]
}

/**
 * Target video bitrate for an OpenH264 encode.
 *
 * OpenH264 has no constant-quality mode, so a bitrate is the only knob, and one
 * fixed number cannot be right for every clip: 6 Mbps is generous for a 640x480
 * phone video and visibly soft on a 4K one. This is the ordinary bits-per-pixel-
 * per-frame heuristic used by streaming encoders, clamped at both ends so a
 * misreported frame rate cannot produce an absurd number.
 */
export function videoBitrateFor(info: Pick<VideoInfo, 'width' | 'height' | 'frameRate'>): string {
  const width = info.width ?? 0
  const height = info.height ?? 0
  const frameRate = info.frameRate ?? 25
  if (width <= 0 || height <= 0) return '4000000'
  const bps = width * height * Math.min(Math.max(frameRate, 1), 60) * 0.08
  return `${Math.round(Math.min(Math.max(bps, 250_000), 20_000_000))}`
}

const ENCODERS: Record<string, CodecSpec> = {
  h264: {
    encoder: 'libopenh264',
    rateArgs: (info) => ['-rc_mode', 'quality', '-b:v', videoBitrateFor(info)]
  },
  h265: {
    encoder: 'libkvazaar',
    // Kvazaar does take a CRF, so this is the same quality-relative knob as before.
    rateArgs: () => ['-crf', '28']
  },
  vp9: { encoder: 'libvpx-vp9', rateArgs: () => ['-crf', '28', '-b:v', '0', '-row-mt', '1'] },
  vp8: { encoder: 'libvpx', rateArgs: () => ['-crf', '10', '-b:v', '1M'] },
  av1: { encoder: 'libsvtav1', rateArgs: () => ['-crf', '32'] },
  mpeg4: { encoder: 'mpeg4', rateArgs: () => ['-q:v', '3'] },
  aac: { encoder: 'aac', rateArgs: () => [] },
  mp3: { encoder: 'libmp3lame', rateArgs: () => [] }
}

const H264 = ENCODERS.h264 as CodecSpec
const AAC = ENCODERS.aac as CodecSpec

/** A stand-in for a clip whose size was never measured. See `targetBitrate`. */
const UNKNOWN_SIZE = { width: null, height: null, frameRate: null } as VideoInfo

/** True when a name is one this module will accept. Checked before ffmpeg runs. */
export function isSupportedCodec(name: string): boolean {
  return name in ENCODERS
}

/**
 * Every codec this module accepts, with the encoder name each one needs.
 *
 * Exported so the vendored FFmpeg can be checked against the list rather than
 * against a hand-written duplicate of it. A codec name can sit in a test
 * asserting it encodes and still never reach an encoder - `trimVideo` takes no
 * codec argument, so a loop over codec names exercises H.264 every time and
 * passes whatever the build contains. This is what makes such a check real.
 */
export function offeredEncoders(): { codec: string; encoder: string }[] {
  return Object.entries(ENCODERS).map(([codec, spec]) => ({ codec, encoder: spec.encoder }))
}

/**
 * The spec for a codec name, or the h264 default if the name is unknown.
 *
 * Declared as a function rather than an `as CodecSpec` at the call site so the
 * fallback lives in one place: there are three call sites, and a caller-supplied
 * name that quietly became `undefined` at one of them would put a literal
 * "undefined" on the ffmpeg command line.
 */
function codecFor(name: string | undefined, fallback: CodecSpec): CodecSpec {
  return (name && ENCODERS[name]) || fallback
}

/**
 * Whether two paths name the same file.
 *
 * Resolved first and case-folded second, because Windows paths are
 * case-insensitive and `C:\clips\..\clips\a.mp4` is the same file as
 * `C:\clips\a.mp4`. A plain string comparison misses both, and would let the
 * never-overwrite rule be sidestepped by writing the path a slightly different
 * way - which is exactly the mistake this check exists to catch.
 */
function isSamePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

/**
 * Checks a destination before anything is written to it.
 *
 * The source path is passed in rather than looked up, because every caller has
 * more than one file it must not clobber: a join writes from N inputs and any of
 * them being the output would destroy the original.
 */
function assertWritable(target: string, sources: readonly string[], overwrite: boolean): string {
  for (const source of sources) {
    if (isSamePath(target, source)) throw new VideoError('refusing to overwrite one of the source videos')
  }
  if (!overwrite && existsSync(target)) {
    throw new VideoError(`${target} already exists; choose another path`)
  }
  const dir = dirname(target)
  if (!existsSync(dir)) throw new VideoError(`no such folder: ${dir}`)
  mkdirSync(dir, { recursive: true })
  return target
}

/**
 * Rejects anything that cannot be a source before ffmpeg is involved.
 *
 * The typeof checks are not paranoia about the type checker. These requests
 * arrive over IPC and over MCP, where the value is whatever JSON was sent, and
 * `existsSync(undefined)` is a hard deprecation in current Node - it throws a
 * warning that will become an error, and it would be thrown from the middle of a
 * path check rather than reported as a bad request.
 */
function requireReadable(path: string): void {
  if (typeof path !== 'string' || path.trim() === '') throw new VideoError('no file path was given')
  if (!existsSync(path)) throw new VideoError(`no such file: ${path}`)
  if (!isVideoName(path)) throw new VideoError(`${path} does not look like a video file`)
}

/** Names the encoder flags only when re-encoding is actually happening. */
function encodeArgs(
  accurate: boolean | undefined,
  videoCodec?: string,
  audioCodec?: string,
  info?: VideoInfo
): string[] {
  if (!accurate) return ['-c', 'copy']
  // Falling back to the default rather than throwing: the name is validated at the
  // edge, and rejecting an unknown codec after the user has already waited through a
  // trim would be the worse failure. `info` is optional for the same reason - a
  // caller without measurements still gets a working edit, at a bitrate chosen for
  // an unknown size rather than a crash.
  const source = info ?? UNKNOWN_SIZE
  const v = codecFor(videoCodec, H264)
  const a = codecFor(audioCodec, AAC)
  // Every encoder here is restricted to yuv420p, whose chroma planes are half
  // height and width, so an odd dimension has nowhere to put its last row or
  // column. ffmpeg handles this by inserting a scaling filter that silently drops
  // the remainder, which loses a pixel the user cannot see was dropped. Doing it
  // explicitly, and only for the odd case, keeps a 4K trim from paying for a
  // resample it does not need and turns a hidden behaviour into a documented one.
  const args: string[] = ['-c:v', v.encoder, ...v.rateArgs(source)]
  if (source.width && source.height && (source.width % 2 || source.height % 2)) {
    args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2')
  }
  // 192k of AAC because that is the near-universal floor for stereo speech and
  // music alike; a re-encode that quietly cut the audio to 64k would be noticed
  // immediately on anything with music in it.
  // 192k of AAC because that is the near-universal floor for stereo speech and
  // music alike; a re-encode that quietly cut the audio to 64k would be noticed
  // immediately on anything with music in it. `pix_fmt` is named rather than
  // left to the encoder because these encoders would otherwise negotiate it
  // themselves and pick differently per codec.
  return [...args, '-pix_fmt', 'yuv420p', '-c:a', a.encoder, '-b:a', '192k']
}

/**
 * Runs ffmpeg, turning a non-zero exit into something worth reading.
 *
 * The useful part is on stderr at `-loglevel error`, and it is the *last* lines -
 * ffmpeg narrates and then complains. `windowsHide` matches `core/powershell.ts`:
 * no console flash for an operation the user did not ask to watch.
 */
function runFfmpeg(bin: string, args: readonly string[], timeoutMs = 900000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) {
        resolve()
        return
      }
      const detail = String(stderr ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(-4)
        .join('; ')
      reject(new VideoError(detail ? `ffmpeg failed: ${detail}` : 'ffmpeg failed'))
    })
  })
}

/**
 * Keeps only the part of a clip between two times.
 *
 * Bounds are checked against the measured duration rather than against each other,
 * because a caller that asks to cut past the end of a clip should be told, rather
 * than handed a shorter file and no explanation.
 */
export async function trimVideo(request: TrimRequest): Promise<VideoOutput> {
  requireReadable(request.path)
  const info = await probeVideo(request.path)
  const duration = info.durationSeconds
  if (duration <= 0) throw new VideoError('this clip reports a zero duration, so it cannot be trimmed')

  const start = request.startSeconds ?? 0
  if (!Number.isFinite(start) || start < 0) throw new VideoError(`startSeconds must be zero or more, got ${String(request.startSeconds)}`)
  if (start >= duration) throw new VideoError(`startSeconds ${start} is at or past the end of the clip (${formatDuration(duration)})`)

  const end = request.endSeconds ?? duration
  if (!Number.isFinite(end) || end <= 0) throw new VideoError(`endSeconds must be more than zero, got ${String(request.endSeconds)}`)
  // Half a second of slack, because a container's duration can disagree with the
  // last frame by a frame or two and "cut to the very end" is a normal request.
  if (end > duration + 0.5) throw new VideoError(`endSeconds ${end} is past the end of the clip (${formatDuration(duration)})`)
  if (end <= start) throw new VideoError(`endSeconds ${end} must be after startSeconds ${start}`)

  const target = assertWritable(
    request.output ? resolve(request.output) : defaultVideoOutputPath(request.path, '-trimmed'),
    [request.path],
    false
  )

  const { path: ffmpeg } = await requireAddon('ffmpeg')
  // `-ss` before `-i` seeks via the container index, which is fast. `-t` goes
  // *after* the input, so it is measured from where the seek landed; putting it
  // before `-i` would measure from the original start and cut far too little.
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', toTimestamp(start),
    '-i', request.path,
    '-t', toTimestamp(end - start),
    ...encodeArgs(request.accurate, 'h264', undefined, info),
    // Moves the index to the front so playback starts before the file is read
    // from the end, and works for the mp4/mov output this always produces.
    '-movflags', '+faststart',
    target
  ]
  await runFfmpeg(ffmpeg, args)
  return { path: target, bytes: statSync(target).size, copied: !request.accurate, durationSeconds: end - start }
}

/**
 * Cuts one clip into pieces at the given times.
 *
 * Every piece comes out of a single ffmpeg run through the segment muxer, rather
 * than from one `trimVideo` call per piece. That is both faster - one decode
 * instead of N - and more correct: separate runs each snap to their own nearest
 * keyframe, so the pieces would not join back up on the frame the caller cut on,
 * which is the whole point of cutting a clip apart.
 */
export async function splitVideo(request: SplitRequest): Promise<VideoOutput[]> {
  requireReadable(request.path)
  const info = await probeVideo(request.path)
  const duration = info.durationSeconds

  // Deduped to milliseconds and sorted, so "cut at 5, 5, 2" is the two cuts the
  // caller meant rather than three, two of which are the same instant.
  const cuts = [...new Set(request.cutSeconds.map((c) => Number(Number(c).toFixed(3))))]
    .filter((c) => Number.isFinite(c) && c > 0 && c < duration)
    .sort((a, b) => a - b)

  if (cuts.length === 0) {
    throw new VideoError(`none of the cut points fall inside the clip (0 to ${formatDuration(duration)})`)
  }

  const dir = resolve(request.outputDir ?? dirname(resolve(request.path)))
  if (!existsSync(dir)) throw new VideoError(`no such folder: ${dir}`)
  // Taken from the source's own filename rather than from a generated output path.
  // `defaultVideoOutputPath` appends a counter when its preferred name is taken,
  // so asking it for a name to slice apart would turn `clip.mp4` into `clip-2`
  // purely because the source exists - which is always.
  const sourceStem = basename(request.path).replace(/\.[^.]+$/, '') || 'video'
  const stem = request.prefix ?? `${sourceStem}-part`

  // N cut points are N boundaries, so they divide the clip into N+1 pieces: cuts
  // at 2s and 5s in an 8s clip are 0-2, 2-5 and 5-8. Expecting one file per cut
  // would leave the last piece unreported *and* skip the overwrite check on it,
  // which is how a second run quietly destroys its own earlier output.
  const expected = Array.from({ length: cuts.length + 1 }, (_, i) =>
    resolve(dir, `${stem}-${String(i + 1).padStart(2, '0')}.mp4`)
  )
  for (const target of expected) assertWritable(target, [request.path], false)

  const { path: ffmpeg } = await requireAddon('ffmpeg')
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', request.path]
  if (!request.accurate) args.push('-c', 'copy')
  args.push(
    '-f', 'segment',
    '-segment_times', cuts.map(toTimestamp).join(','),
    // Without this each piece starts at the timestamp it was cut on rather than
    // at zero, so the second piece plays with a gap where nothing was removed.
    '-reset_timestamps', '1',
    '-segment_format', 'mp4',
    // The muxer numbers from 0 by default, which would make the first piece
    // `-00` and read as though something were missing. Set explicitly rather
    // than worked around, so the names on disk match what the caller was told.
    '-segment_start_number', '1',
    ...encodeArgs(request.accurate, 'h264', undefined, info),
    resolve(dir, `${stem}-%02d.mp4`)
  )
  await runFfmpeg(ffmpeg, args)

  // Re-probed rather than assumed, because the segment muxer writes fewer files
  // than cut points when an interval is shorter than one frame, and the caller
  // needs the real list and the real lengths.
  const written: VideoOutput[] = []
  for (const target of expected) {
    if (!existsSync(target)) continue
    let seconds = 0
    try {
      seconds = (await probeVideo(target)).durationSeconds
    } catch {
      seconds = 0
    }
    written.push({ path: target, bytes: statSync(target).size, copied: !request.accurate, durationSeconds: seconds })
  }
  if (written.length === 0) throw new VideoError('ffmpeg produced no output files')
  return written
}

/**
 * Joins clips into one.
 *
 * The concat *demuxer* with a list file, not the concat *filter*. The filter can
 * join anything, which sounds better, but it decodes and re-encodes every frame -
 * a two-minute join becomes minutes of work. The demuxer is a file-level
 * operation that needs the inputs to share codecs and resolution, which is the
 * normal case for pieces of one recording. When they do not match, ffmpeg says so
 * in terms a user can act on and the caller recovers with `reencode`.
 */
export async function concatVideos(request: ConcatRequest): Promise<VideoOutput> {
  const paths = request.paths.filter((p) => typeof p === 'string' && p.length > 0)
  if (paths.length < 2) throw new VideoError(`need at least two clips to join, got ${paths.length}`)
  for (const p of paths) requireReadable(p)

  const target = assertWritable(
    request.output ? resolve(request.output) : defaultVideoOutputPath(paths[0] as string, '-joined'),
    paths,
    false
  )

  const { path: ffmpeg } = await requireAddon('ffmpeg')

  // Only measured when a re-encode is actually going to happen, because that is
  // the only case where the encoder needs to know how big the picture is, and
  // probing on every join would add work to the fast path for nothing.
  let sourceInfo: VideoInfo | undefined
  if (request.reencode) {
    try {
      sourceInfo = await probeVideo(paths[0] as string)
    } catch {
      sourceInfo = undefined
    }
  }

  // The list has to exist as a real file, which is why this is not an argument.
  // It is written beside the output and removed afterwards, and each entry is
  // single-quoted with `'\''` escaping because a Windows path can contain an
  // apostrophe and would otherwise end the line early.
  const listFile = `${target}.concat.txt`
  const body = paths.map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`).join('\n')
  try {
    writeFileSync(listFile, `${body}\n`, 'utf8')
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat',
      // `safe 0` is required because the inputs are absolute paths from anywhere
      // on the disk, and the default `safe 1` refuses anything outside the list
      // file's own folder.
      '-safe', '0',
      '-i', listFile,
      ...encodeArgs(request.reencode, 'h264', undefined, sourceInfo),
      '-movflags', '+faststart',
      target
    ])
  } finally {
    // A leftover list file is untidy, not a failure worth reporting over a
    // successful join.
    try {
      unlinkSync(listFile)
    } catch {
      /* ignore */
    }
  }

  const info = await probeVideo(target)
  return { path: target, bytes: statSync(target).size, copied: !request.reencode, durationSeconds: info.durationSeconds }
}

/**
 * Pulls one frame out as a JPEG, for a thumbnail or a contact sheet.
 *
 * The moment is a fraction of the clip by default, so "a quarter of the way in"
 * means the same thing for a three-second clip and a three-hour one.
 */
export async function extractFrame(request: FrameRequest): Promise<VideoOutput & { atSeconds: number }> {
  requireReadable(request.path)
  const info = await probeVideo(request.path)
  const duration = info.durationSeconds
  if (duration <= 0) throw new VideoError('this clip has a zero duration, so no frame can be chosen')

  let at: number
  if (request.atSeconds !== undefined) {
    if (!Number.isFinite(request.atSeconds) || request.atSeconds < 0) {
      throw new VideoError(`atSeconds must be zero or more, got ${request.atSeconds}`)
    }
    if (request.atSeconds > duration) {
      throw new VideoError(`atSeconds ${request.atSeconds} is past the end of the clip (${formatDuration(duration)})`)
    }
    at = request.atSeconds
  } else {
    const fraction = request.fraction ?? 0.25
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw new VideoError(`fraction must be between 0 and 1, got ${String(request.fraction)}`)
    }
    at = duration * fraction
  }

  const target = assertWritable(
    request.output ? resolve(request.output) : defaultVideoOutputPath(request.path, `-frame-${at.toFixed(1).replace('.', 'p')}`, '.jpg'),
    [request.path],
    false
  )

  const { path: ffmpeg } = await requireAddon('ffmpeg')
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', request.path]
  // Seeking *after* `-i` is slow and exact; before it is fast and keyframe-accurate,
  // which is the wrong side of the trade when the caller asked for a moment. A
  // thumbnail is not on the hot path, so it pays for the accurate version.
  args.push('-ss', toTimestamp(at))
  if (request.width) {
    // `-2` is ffmpeg's "make this dimension even" rule. Without it, an odd width
    // makes the encoder fail on a yuv420p frame, which cannot have odd chroma rows.
    args.push('-vf', `scale=${Math.max(2, Math.round(request.width))}:-2`)
  }
  args.push('-frames:v', '1', '-q:v', '3', target)
  await runFfmpeg(ffmpeg, args)

  return { path: target, bytes: statSync(target).size, copied: true, durationSeconds: 0, atSeconds: at }
}

/** The encoder names this build accepts, for the UI to offer. */
export const SUPPORTED_VIDEO_CODECS = VIDEO_CODECS
export const SUPPORTED_AUDIO_CODECS = AUDIO_CODECS