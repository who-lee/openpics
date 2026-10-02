/**
 * The video types that cross the process boundary.
 *
 * `core/video/*` runs ffmpeg and cannot be imported by the renderer, so anything
 * the UI needs to know about a clip is declared here. This file imports nothing,
 * for the same reason `shared/addons.ts` does: both are read by three different
 * TypeScript projects (node, web, mcp) and pulling `node:child_process` into a
 * renderer bundle would break the build in a way that is tedious to diagnose.
 *
 * Times are seconds from the start of the file, as a plain number, rather than
 * the `HH:MM:SS.mmm` ffmpeg wants. The conversion is the node side's business -
 * it is in `core/video/probe.ts` as `toTimestamp` - because a caller should not
 * have to know that ffmpeg has a timestamp format at all.
 */

// Type-only, so this file still pulls nothing in at runtime. The filter recipes
// live in `./filters` and are resolved where ffmpeg is actually run.
import type { FilterSettings } from './filters'

/** Containers OpenPics will offer video actions for. */
export const VIDEO_EXTS: readonly string[] = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'ts',
  'mts',
  'm2ts',
  '3gp',
  'ogv'
]

/**
 * True for a filename OpenPics will treat as a video.
 *
 * Used for filtering, not for deciding anything about the file's contents. A
 * `.mp4` that is really a JPEG still passes here and is rejected later by ffprobe,
 * which is the layer that can actually tell - and which reports the reason,
 * instead of a list extension causing a video panel to appear for a still.
 */
export function isVideoName(name: string): boolean {
  const i = name.lastIndexOf('.')
  if (i <= 0) return false
  const ext = name.slice(i + 1).toLowerCase()
  return (VIDEO_EXTS as readonly string[]).includes(ext)
}

export interface VideoStream {
  index: number
  /** 'video', 'audio', 'subtitle', or whatever else ffprobe reported. */
  kind: string
  /** Codec as ffprobe spells it, e.g. 'h264'. */
  codec: string
  width: number | null
  height: number | null
  /** Frames per second as a rational string ('30000/1001'), or null. */
  frameRate: string | null
  frames: number | null
  durationSeconds: number | null
  bitRate: number | null
  /** Degrees the container asks a player to rotate by, or null for upright. */
  rotation: number | null
  channels: number | null
  sampleRate: number | null
}

export interface VideoInfo {
  path: string
  bytes: number
  /** ffprobe's container name, e.g. 'mov,mp4,m4a,3gp,3g2,mj2'. */
  formatName: string
  /** Whole-file duration. Zero is a real, reportable value, not 'unknown'. */
  durationSeconds: number
  width: number | null
  height: number | null
  frameRate: number | null
  bitRate: number | null
  videoStreams: VideoStream[]
  audioStreams: VideoStream[]
  /** Subtitles, data and anything else not picture or sound. */
  otherStreams: VideoStream[]
}

/** Encoders a caller may name. Anything else is refused before ffmpeg runs. */
export const VIDEO_CODECS = ['h264', 'h265', 'vp9', 'vp8', 'av1', 'mpeg4'] as const
export type VideoCodec = (typeof VIDEO_CODECS)[number]

export const AUDIO_CODECS = ['aac', 'mp3'] as const
export type AudioCodec = (typeof AUDIO_CODECS)[number]

export interface TrimRequest {
  path: string
  /** Where to start, in seconds from the beginning. Defaults to 0. */
  startSeconds?: number
  /** Where to stop, in seconds from the beginning. Defaults to the end. */
  endSeconds?: number
  /** Where to write. Defaults to a new file beside the source. */
  output?: string
  /**
   * Re-encode so the cut lands on the exact frame asked for.
   *
   * Off by default. Copying streams takes a second instead of a minute, but the
   * cut lands on the nearest preceding keyframe instead of the requested frame.
   */
  accurate?: boolean
  /** A named look from the shared catalogue. Defaults to none. */
  filter?: FilterSettings
}

export interface SplitRequest {
  path: string
  /** Times to cut at, in seconds. Duplicates and out-of-range values are dropped. */
  cutSeconds: number[]
  /** Defaults to the source's folder. */
  outputDir?: string
  /** Filename stem for the pieces. Defaults to the source name plus '-part'. */
  prefix?: string
  accurate?: boolean
  /** Applied to every piece. Defaults to none. */
  filter?: FilterSettings
}

export interface ConcatRequest {
  paths: string[]
  /** Where to write. Defaults to a new file beside the first input. */
  output?: string
  /**
   * Re-encode instead of copying. Only needed when the pieces do not share codecs
   * and resolution, in which case ffmpeg's own error says so and this is how the
   * caller recovers.
   */
  reencode?: boolean
  /** Applied to the joined result. Defaults to none. */
  filter?: FilterSettings
}

/** Applies a filter to a whole clip and writes a new file. */
export interface FilterRequest {
  path: string
  /** The look to apply. Required - there is nothing to do without one. */
  filter: FilterSettings
  /** Where to write. Defaults to a new file beside the source. */
  output?: string
  /** Which video codec to re-encode with. Defaults to h264. */
  videoCodec?: VideoCodec
  /** Which audio codec to re-encode with. Defaults to aac. */
  audioCodec?: AudioCodec
}

export interface FrameRequest {
  path: string
  /** Exact time to grab. Takes precedence over `fraction`. */
  atSeconds?: number
  /** Where in the clip, 0 to 1. Defaults to a quarter of the way in. */
  fraction?: number
  output?: string
  /** Scale the frame to this width, keeping aspect. */
  width?: number
}

/** The common shape of a finished operation: a new file, never the old one. */
export interface VideoOutput {
  path: string
  bytes: number
  /** True when streams were copied rather than re-encoded. */
  copied: boolean
  /** Duration of the result, when it is known without another probe. */
  durationSeconds: number
  /**
   * The filter that was applied, described, or absent when there was none.
   *
   * Reported rather than inferred from `copied`, because a filter forces a
   * re-encode and a caller that asked for `accurate: false` still gets one. A
   * reply that said only "copied: false" would leave a user wondering why their
   * trim took a minute.
   */
  filter?: string
}

export interface VideoErrorReport {
  error: string
  /** Which operation failed, so the UI can label the message. */
  operation: 'probe' | 'trim' | 'split' | 'concat' | 'frame' | 'filter'
}