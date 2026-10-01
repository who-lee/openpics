import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, parse } from 'node:path'
import { requireAddon } from '../addons/detect'
import { isVideoName, VIDEO_EXTS, type VideoInfo, type VideoStream } from '../../shared/video'

/**
 * Reading a video file.
 *
 * Everything here shells out to ffprobe rather than parsing containers in
 * TypeScript. That is not laziness: an MP4 is an ISO base-media file with `stsd`
 * boxes whose codec four-character codes sit behind `avcC`/`hvcC` records, an MKV
 * is EBML with a codec string in a different place per codec, and MOV is the same
 * boxes under a different brand. Getting even the common cases right by hand is a
 * project on its own, and a wrong answer here fails silently - a trim lands in
 * the wrong place and the user finds out when they play the result. ffprobe
 * already knows all of it and is already installed.
 *
 * The types it returns live in `shared/video.ts`, because the renderer needs
 * them and cannot import this file.
 */

export { VIDEO_EXTS, isVideoName }
export type { VideoInfo, VideoStream }

/** Raised for anything a user can do something about, as opposed to a bug. */
export class VideoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoError'
  }
}

interface ProbeStream {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  nb_frames?: number | string
  duration?: number | string
  bit_rate?: number | string
  channels?: number
  sample_rate?: number | string
  tags?: Record<string, string>
  side_data_list?: Array<{ rotation?: number }>
}

interface ProbeJson {
  streams?: ProbeStream[]
  format?: {
    format_name?: string
    duration?: number | string
    bit_rate?: number | string
    size?: number | string
  }
}

/**
 * ffprobe numbers can arrive as JSON strings, and a missing one arrives as
 * neither a number nor a string. Both are folded to `number | null` here so no
 * caller has to care which.
 */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * '30000/1001' as 29.97.
 *
 * The rational form is kept on the stream because it is exact and this is not:
 * 29.97002997... is what a NTSC recording actually is, and rounding it to 30
 * before computing a frame count is how a trim ends up one frame long. The
 * summary number is for display and for anything that only needs "about 30".
 */
function fps(raw: string | null | undefined): number | null {
  if (!raw) return null
  const [numPart, denPart] = raw.split('/')
  const n = Number(numPart)
  const d = denPart === undefined ? 1 : Number(denPart)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null
  const value = n / d
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Rotation the container asks a player to apply.
 *
 * Read from two places because the two disagree in the wild: newer muxers write a
 * `side_data_list` display matrix, older ones leave a `rotate` tag in degrees.
 * A value that lands on a multiple of 360 is no rotation at all, so it is
 * reported as absent rather than as 0 - a caller deciding whether to rotate
 * pixels should not be handed a no-op and have to special-case it.
 */
function rotationOf(stream: ProbeStream): number | null {
  const side = stream.side_data_list?.find((s) => typeof s.rotation === 'number')
  const raw = side && typeof side.rotation === 'number' ? side.rotation : num(stream.tags?.rotate)
  if (raw === null) return null
  const normalised = ((raw % 360) + 360) % 360
  return normalised === 0 ? null : normalised
}

/**
 * The frame rate to report.
 *
 * `avg_frame_rate` first, because it is the real average including variable
 * frame rate material, and `r_frame_rate` only as a fallback - for a file with a
 * single frame the average is 0/0 and the nominal rate is all there is.
 */
function frameRateOf(stream: ProbeStream): string | null {
  const avg = stream.avg_frame_rate
  if (avg && avg !== '0/0' && fps(avg) !== null) return avg
  const rate = stream.r_frame_rate
  if (rate && rate !== '0/0' && fps(rate) !== null) return rate
  return null
}

function toStream(raw: ProbeStream): VideoStream {
  return {
    index: raw.index ?? -1,
    kind: raw.codec_type ?? 'unknown',
    codec: raw.codec_name ?? 'unknown',
    width: num(raw.width),
    height: num(raw.height),
    frameRate: frameRateOf(raw),
    frames: num(raw.nb_frames),
    durationSeconds: num(raw.duration),
    bitRate: num(raw.bit_rate),
    rotation: rotationOf(raw),
    channels: num(raw.channels),
    sampleRate: num(raw.sample_rate)
  }
}

function probeJson(path: string, bin: string): Promise<ProbeJson> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-hide_banner', '-loglevel', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // A non-zero exit can still carry usable JSON - ffprobe exits 1 on a
        // container it dislikes but prints what it managed to read - so the
        // output is preferred and only a completely empty result is fatal.
        const text = String(stdout ?? '')
        if (text.trim()) {
          try {
            resolve(JSON.parse(text) as ProbeJson)
            return
          } catch {
            reject(new VideoError(`ffprobe returned something that is not JSON for ${path}`))
            return
          }
        }
        if (err) {
          const detail = String(stderr ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join('; ')
          reject(new VideoError(detail ? `${path}: ${detail}` : `ffprobe could not read ${path}`))
          return
        }
        reject(new VideoError(`ffprobe found no streams in ${path}`))
      }
    )
  })
}

/**
 * Describes one video file.
 *
 * A zero duration is reported as zero rather than null: a genuinely empty clip is
 * something the caller can act on, whereas null would read as "unknown" and get
 * quietly treated as either.
 *
 * A file with no video stream in it is refused, and so is a single still image.
 * ffprobe is happy to describe anything and exits 0 on a text file or a JPEG -
 * a JPEG in particular comes back as a perfectly valid one-frame `mjpeg` video
 * stream - so "it parsed" is not the same as "it is a video". Without these checks
 * `photo.mp4` probes cleanly and the caller goes on to open a video panel for a
 * still image. The message names what was actually found, because "this is not a
 * video" with no reason is useless when the file is a video in the user's mind.
 */
export async function probeVideo(path: string): Promise<VideoInfo> {
  if (!existsSync(path)) throw new VideoError(`no such file: ${path}`)
  const stat = statSync(path)
  if (!stat.isFile()) throw new VideoError(`not a file: ${path}`)

  const { path: ffprobe } = await requireAddon('ffprobe')
  const raw = await probeJson(path, ffprobe)
  const streams = (raw.streams ?? []).map(toStream)
  const format = raw.format ?? {}

  const video = streams.find((s) => s.kind === 'video') ?? null
  if (!video) throw new VideoError(`${path} has no video stream in it${describeStreams(streams)}`)

  const duration = num(format.duration) ?? video?.durationSeconds ?? 0

  // ffprobe also calls a still image a video: a JPEG is a video stream of `mjpeg`
  // with one frame and no duration, and it is happy to tell you so. So "there is
  // a video stream" is not sufficient - a clip has to have a time dimension too.
  // This is what stops `photo.mp4` from opening a video panel that can only ever
  // play one frame.
  if (duration <= 0 && (video.frames === null || video.frames <= 1)) {
    throw new VideoError(`${path} is a single still image, not a moving clip - ffprobe found one frame and no duration`)
  }

  return {
    path,
    bytes: stat.size,
    formatName: format.format_name ?? 'unknown',
    durationSeconds: duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    frameRate: fps(video?.frameRate),
    bitRate: num(format.bit_rate),
    videoStreams: streams.filter((s) => s.kind === 'video'),
    audioStreams: streams.filter((s) => s.kind === 'audio'),
    otherStreams: streams.filter((s) => s.kind !== 'video' && s.kind !== 'audio')
  }
}

/** True when ffprobe recognises the file as a video. Cheap enough to run over a scan. */
export async function isReadableVideo(path: string): Promise<boolean> {
  try {
    await probeVideo(path)
    return true
  } catch {
    return false
  }
}

/**
 * What was in the file instead, for the "no video stream" message.
 *
 * Saying "this is not a video" and leaving it there is unhelpful when the file is
 * a song with a misleading name, or an empty placeholder - both of which are
 * common in a library folder.
 */
function describeStreams(streams: readonly VideoStream[]): string {
  if (streams.length === 0) return ' - ffprobe found no streams at all'
  const kinds = [...new Set(streams.map((s) => s.kind))]
  return ` - ffprobe found ${kinds.join(' and ')} only`
}

/**
 * Seconds as the `HH:MM:SS.mmm` ffmpeg expects.
 *
 * Millisecond precision is kept rather than truncating to whole seconds, because
 * video edits are specified in milliseconds and a caller that has already
 * computed 12.456 should not be told it got 12.
 */
export function toTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new VideoError(`not a usable time: ${seconds}`)
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const milli = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`
}

/** `83.4` for a duration, because a cut list reads better in minutes. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** The name with no folder and no extension, for defaulting output filenames. */
function baseName(path: string): string {
  return parse(path).name || 'video'
}

/**
 * A `.mp4` beside the source that does not exist yet.
 *
 * Never returns the input path: an edit that wrote over its own source would be
 * unrecoverable, and the caller has no way to know that check happened.
 */
export function defaultVideoOutputPath(inputPath: string, suffix = '-edited', ext = '.mp4'): string {
  const { dir, name } = parse(inputPath)
  const stem = name || baseName(inputPath)
  // `join`, not a literal `\\`. A hardcoded separator makes the "beside the
  // source" promise true only on Windows: on a POSIX path it produces one file
  // name containing a backslash, which lands in the working directory instead of
  // next to the clip, and the caller has no way to tell that from the returned
  // string.
  const candidate = join(dir, `${stem}${suffix}${ext}`)
  if (!existsSync(candidate)) return candidate
  for (let n = 2; n < 1000; n++) {
    const next = join(dir, `${stem}${suffix}-${n}${ext}`)
    if (!existsSync(next)) return next
  }
  throw new VideoError(`too many ${stem}${suffix}* files already in ${dir}`)
}

/** True when the extension is one ffmpeg will be asked about. */
export function looksLikeVideo(path: string): boolean {
  return isVideoName(path)
}