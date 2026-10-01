import { existsSync, writeFileSync as fsWriteFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { describePhoto, findPhotos } from '../core/photos'
import { dataFile, readJson } from '../core/datadir'
import { getWallpaper, setWallpaper } from '../core/wallpaper'
import { emptyBin, listBin, purge, restore, sendToBin } from '../core/recyclebin'
import { powershell, psString } from '../core/powershell'
import { paintBrush } from '../core/edit/brush'
import { defaultOutputPath, resolveOutputPath, savePng } from '../core/edit/io'
import { maskStats } from '../core/edit/mask'
import {
  despeckleMask,
  featherMaskInPlace,
  fillMaskHoles,
  growMask,
  invertMask,
  keepLargestRegion,
  shrinkMask,
  thresholdAlpha,
  thresholdMask
} from '../core/edit/maskops'
import { DEFAULT_PREVIEW_EDGE, previewRaster } from '../core/edit/preview'
import { maskBoundsToRect, selectEllipse, selectPolygon, selectRect } from '../core/edit/select'
import {
  analyseRaster,
  applySelection,
  checkpoint,
  cutoutFromBorder,
  EditError,
  inspectSession,
  maskFromSelection,
  render,
  replaceMask,
  resetSession,
  samplePixels
} from '../core/edit/session'
import { EditStore, type EditHandle } from '../core/edit/store'
import type { KeepSide, Resize } from '../core/edit/session'
import { selectRegion } from '../core/edit/wand'
import { encodePng } from '../core/image/png'
import { addonStatuses, refreshAddonStatuses } from '../core/addons/detect'
import { concatVideos, extractFrame, splitVideo, trimVideo } from '../core/video/edit'
import { formatDuration, probeVideo } from '../core/video/probe'

/**
 * Applies a geometric selection to a session as one undoable step.
 *
 * Every selection tool goes through here. The point is that the four of them - wand,
 * rectangle, ellipse, polygon - differ only in how they produce a 0/1 array and are
 * otherwise identical: record the mask as it was, work out the new one, install it.
 * Keeping that in one place is what stops the four from drifting apart as they are
 * extended.
 */
function applySelectionStep(handle: EditHandle, label: string, selection: Uint8Array, keep: KeepSide) {
  const { width, height } = handle.session
  const stats = replaceMask(handle.session, maskFromSelection(width, height, selection, keep), label)
  return { keep, stats }
}

/**
 * Whether the user has allowed the agent tools to run.
 *
 * This reads the same settings.json the application writes, so the switch in
 * Settings is the only place the decision is made. The file is re-read per call
 * rather than cached at startup: a server belongs to whichever agent launched
 * it and can outlive the window by hours, so a cached value would keep serving
 * tools long after the user switched them off.
 *
 * Absent or unreadable means allowed, matching how the app shipped.
 */
function mcpEnabled(): boolean {
  const settings = readJson<{ enableMcp?: unknown }>(dataFile('settings.json'), {})
  if (settings.enableMcp === false) return false
  return true
}

/** The single refusal point, so no tool can be reached while the switch is off. */
function assertMcpEnabled(): void {
  if (!mcpEnabled()) {
    throw new Error(
      'OpenPics MCP is turned off in Settings. Turn "Allow agent tools (MCP)" back on in the app to use these tools.'
    )
  }
}

/**
 * The application version, found by walking up from the compiled file.
 *
 * The MCP is emitted to its own directory, so a hardcoded path to package.json
 * would depend on the build layout. Reporting the real version means an agent
 * can tell which build it is talking to, which matters as soon as there is more
 * than one installed.
 */
function appVersion(): string {
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(require('node:fs').readFileSync(file, 'utf8')) as {
          name?: string
          version?: string
        }
        if (pkg.name === 'openpics' && pkg.version) return pkg.version
      } catch {
        // Fall through and keep walking.
      }
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return '0.0.0'
}

type Result = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

const ok = (text: string): Result => ({ content: [{ type: 'text', text }] })
const json = (value: unknown): Result => ok(JSON.stringify(value, null, 2))

/**
 * Where a preview goes when the caller did not say.
 *
 * Kept separate from the cutout name so that previewing and then applying do not
 * fight over the same file: an agent that previews twice and then applies gets a
 * readable preview to look at and a separate final image, rather than one file
 * being rewritten twice with different intent.
 */
function defaultPreviewPath(sourcePath: string): string {
  return defaultOutputPath(sourcePath, '-preview')
}

/**
 * Runs a tool body and turns a thrown error into a readable result.
 *
 * Reported as a normal result with `isError` rather than as a protocol error on
 * purpose. A tool that refused because a file was locked is something the model
 * should read, correct, and retry; a transport-level failure is not, and the two
 * being indistinguishable is what makes agent loops give up.
 */
async function guard(fn: () => Promise<Result>): Promise<Result> {
  try {
    // Checked here rather than in each tool: all 32 handlers funnel through
    // this, so the switch cannot be bypassed by a tool that forgets it.
    assertMcpEnabled()
    return await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

const server = new McpServer({ name: 'openpics', version: appVersion() })

const absPath = z
  .string()
  .describe('Absolute path to a file or folder. Backslashes are fine on Windows.')
  .refine((p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\'), {
    message: 'must be an absolute path, e.g. C:\\Users\\me\\Pictures'
  })

server.registerTool(
  'photos_find',
  {
    title: 'Find pictures',
    description:
      'Lists the pictures under a folder. Returns name, extension, size in bytes and last-modified time for each. Use this to see what is in a library before acting on it.',
    inputSchema: {
      root: absPath.describe('Folder to search.'),
      recursive: z.boolean().optional().describe('Descend into subfolders. Default true.'),
      limit: z.number().int().positive().max(5000).optional().describe('Maximum results. Default 5000.'),
      nameContains: z
        .array(z.string())
        .optional()
        .describe('Keep only files whose name contains one of these, case-insensitive.'),
      extensions: z
        .array(z.string())
        .optional()
        .describe('Keep only these extensions, with or without the dot, e.g. ["jpg","png"].')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const photos = findPhotos(args.root, {
        recursive: args.recursive,
        limit: args.limit,
        nameContains: args.nameContains,
        extensions: args.extensions
      })
      const totalBytes = photos.reduce((n, p) => n + p.bytes, 0)
      return json({ root: args.root, count: photos.length, totalBytes, photos })
    })
)

server.registerTool(
  'photos_describe',
  {
    title: 'Describe a picture',
    description: 'Returns the basic facts about one picture file.',
    inputSchema: { path: absPath.describe('The picture to inspect.') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const photo = describePhoto(args.path)
      if (!photo) return { content: [{ type: 'text', text: `Not a picture OpenPics recognises: ${args.path}` }], isError: true }
      return json(photo)
    })
)

/**
 * Editing tools.
 *
 * An edit is a sequence of calls against one picture, not a single operation, so
 * `edit_cutout_auto` opens the picture and hands back an id that the rest of the
 * tools accept. Without that, correcting a cutout would mean re-decoding the file
 * and re-running the selection for every brush stroke, and the corrections would
 * have nowhere to live.
 *
 * Nothing here writes over the picture it read. The output is always PNG, always
 * somewhere new, and always reported back so the caller knows what was created.
 */
const edits = new EditStore()

const editId = z
  .string()
  .describe('Opaque id from edit_cutout_auto or edit_inspect. It is not a path and must be passed back exactly as given.')

const tolerance = z
  .number()
  .int()
  .min(0)
  .max(765)
  .optional()
  .describe(
    'How far a pixel may differ from the reference colour, as the sum of the absolute per-channel differences, 0-765. Default 48, roughly 16 per channel; anything under about 32 removes nothing from an ordinary photograph, since JPEG noise alone moves the background further than that. Raise it for a textured or uneven background, lower it for a flat studio one; if a cutout removes nothing, the tolerance is too low.'
  )

/** Explains a cutout that found nothing, or found everything, in terms the caller can act on. */
function cutoutHint(stats: { removed: number; kept: number; pixels: number }): string | undefined {
  if (stats.removed === 0) {
    return 'Nothing was removed: no border pixel was within the tolerance of the border average. Raise tolerance, or check the picture really has a plain background.'
  }
  if (stats.kept === 0) {
    return 'Everything was removed: the background colour ran right through the subject. Lower tolerance, or restore the subject with edit_brush.'
  }
  if (stats.removed / stats.pixels > 0.98) {
    return 'Almost everything was removed. Check the preview before applying.'
  }
  return undefined
}

server.registerTool(
  'edit_cutout_auto',
  {
    title: 'Cut out the background automatically',
    description:
      'Opens a picture for editing and removes the background, keeping whatever is not connected to the edges of the frame. Returns an edit id for edit_brush, edit_preview, edit_apply and edit_inspect. Read the result with edit_preview before applying - the tolerance is a guess about the picture, and only the preview can confirm it.',
    inputSchema: {
      path: absPath.describe('The picture to edit. It is never modified.'),
      tolerance,
      edit: editId.optional().describe('Re-cut into this existing edit instead of opening a new one, discarding its current changes.')
    },
    // Opens a session and rewrites its mask and history, so it is not a read
    // despite writing nothing to disk. Re-running it does converge on the same
    // mask, which is why it stays idempotent.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.open(args.path, args.edit)
      // Re-cutting reuses the id but replaces the pixels, so the old history is
      // about a different picture and is discarded with it.
      checkpoint(handle.session, 'cut out from border')
      const { wand, stats } = cutoutFromBorder(handle.session, args.tolerance)
      return json({
        edit: handle.id,
        path: handle.path,
        width: handle.session.width,
        height: handle.session.height,
        format: handle.format,
        reference: wand.reference,
        stats,
        hint: cutoutHint(stats)
      })
    })
)

server.registerTool(
  'edit_brush',
  {
    title: 'Erase or restore with a brush',
    description:
      'Paints the erase or restore brush onto an open edit. Erase makes the background show through, restore brings the original picture back. Changes accumulate, so a second pass over the same place moves it further. Note that restore asks the original what a pixel looked like rather than undoing a step, so restoring over a cut-out edge also brings back the background the cutout removed there - use it to fix an over-aggressive selection, not to undo an erase one dab at a time.',
    inputSchema: {
      edit: editId,
      points: z
        .array(z.object({ x: z.number(), y: z.number() }))
        .min(1)
        .describe('Points along the stroke, in picture pixels, not screen pixels. A single point is one dab.'),
      radius: z.number().positive().describe('Brush radius in picture pixels.'),
      mode: z.enum(['erase', 'restore']).describe('"erase" to make transparent, "restore" to bring the original back.'),
      hardness: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Fraction of the radius painted at full strength, 0-1. Default 0.7, which leaves a soft rim.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      // Checkpointed before painting, not after: the whole stroke is one undo step,
      // which is what a caller means by undoing a stroke. Checkpointing per dab
      // would make a drag of thirty points take thirty undos to reverse.
      const recorded = checkpoint(handle.session, args.mode === 'erase' ? 'erase brush' : 'restore brush')
      let painted = 0
      for (const point of args.points) {
        painted += paintBrush(handle.session.mask, {
          x: point.x,
          y: point.y,
          radius: args.radius,
          mode: args.mode,
          hardness: args.hardness
        })
      }
      if (recorded && painted === 0) {
        // A stroke that moved nothing pushed a duplicate step. Taking it back keeps
        // the history an account of real changes.
        handle.session.history?.undo(handle.session)
      }
      const stats = maskStats(handle.session.mask)
      return json({
        edit: handle.id,
        painted,
        stats,
        note: painted === 0 ? 'Nothing changed: the stroke was already at the requested value, or fell outside the picture.' : undefined
      })
    })
)

/**
 * How much of a selection survives, and what the caller meant by it.
 *
 * `'region'` keeps what was selected, `'rest'` keeps everything else. The default
 * is `'region'` because that is what someone naming a shape after drawing it means:
 * "keep this". The cutout tools pass `'rest'` because there the selected part *is*
 * the background, which is the whole reason the wand grows from the border.
 */
const keepSide = z
  .enum(['region', 'rest'])
  .optional()
  .describe('"region" keeps what was selected, "rest" keeps everything else. Default "region".')

const point = z.object({ x: z.number(), y: z.number() })

server.registerTool(
  'edit_select_wand',
  {
    title: 'Select with a magic wand',
    description:
      'Replaces the selection with every pixel similar to the one at a point you name. Use this when the background is a colour you can click on and edit_cutout_auto guessed wrong - clicking exactly on the background instead of sampling the border is often much more accurate. For the background, pass keep "rest"; for a named subject, "region".',
    inputSchema: {
      edit: editId,
      x: z.number().describe('X of the pixel to sample, in picture pixels.'),
      y: z.number().describe('Y of the pixel to sample, in picture pixels.'),
      tolerance,
      keep: keepSide,
      contiguous: z
        .boolean()
        .optional()
        .describe('True (default) keeps only the matching area connected to the point, which stops a matching patch of subject being swallowed. False keeps every matching pixel anywhere.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const wand = selectRegion(handle.session.source, {
        from: 'point',
        x: args.x,
        y: args.y,
        tolerance: args.tolerance,
        contiguous: args.contiguous
      })
      const applied = applySelectionStep(handle, `wand at ${Math.round(args.x)},${Math.round(args.y)}`, wand.selection, args.keep ?? 'region')
      return json({ edit: handle.id, reference: wand.reference, ...applied })
    })
)

server.registerTool(
  'edit_select_rect',
  {
    title: 'Select a rectangle',
    description:
      'Replaces the selection with a rectangle. Use it to keep a known region, or with keep "rest" to remove a region - for instance a watermark in a corner, or a strip of border. The rectangle is clipped to the picture.',
    inputSchema: {
      edit: editId,
      x: z.number().describe('Left edge, in picture pixels.'),
      y: z.number().describe('Top edge, in picture pixels.'),
      width: z.number().describe('Width in picture pixels.'),
      height: z.number().describe('Height in picture pixels.'),
      keep: keepSide
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const wand = selectRect(handle.session.source, { x: args.x, y: args.y, width: args.width, height: args.height })
      const applied = applySelectionStep(handle, 'rectangle', wand.selection, args.keep ?? 'region')
      return json({ edit: handle.id, ...applied })
    })
)

server.registerTool(
  'edit_select_ellipse',
  {
    title: 'Select an ellipse',
    description:
      'Replaces the selection with an ellipse inscribed in a box. Use it for a subject that is round - a plate, a coin, a moon - where a rectangle would take background with it.',
    inputSchema: {
      edit: editId,
      x: z.number().describe('Left edge of the box, in picture pixels.'),
      y: z.number().describe('Top edge of the box, in picture pixels.'),
      width: z.number().describe('Box width in picture pixels.'),
      height: z.number().describe('Box height in picture pixels.'),
      keep: keepSide
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const wand = selectEllipse(handle.session.source, { x: args.x, y: args.y, width: args.width, height: args.height })
      const applied = applySelectionStep(handle, 'ellipse', wand.selection, args.keep ?? 'region')
      return json({ edit: handle.id, ...applied })
    })
)

server.registerTool(
  'edit_select_polygon',
  {
    title: 'Select inside a polygon',
    description:
      'Replaces the selection with the inside of a shape you draw by listing its corners. Use it when the subject has a shape no rectangle or ellipse fits - a bottle, a person, a sign. Give at least three points; the last one connects back to the first automatically, and the points may be in any winding order. Self-intersecting shapes are filled by the even-odd rule, so a shape with a hole in it works without special care.',
    inputSchema: {
      edit: editId,
      points: z
        .array(point)
        .min(3)
        .describe('Corners in picture pixels, in order around the shape. Do not repeat the first point at the end.'),
      keep: keepSide
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const wand = selectPolygon(handle.session.source, args.points)
      const applied = applySelectionStep(handle, `polygon of ${args.points.length} points`, wand.selection, args.keep ?? 'region')
      return json({ edit: handle.id, ...applied })
    })
)

server.registerTool(
  'edit_select_all',
  {
    title: 'Keep or remove everything',
    description:
      'Sets the selection to fully kept or fully removed. "kept" is the state a freshly opened edit starts in; "removed" blanks the picture. Together with edit_grow and edit_shrink it covers the common case of "keep this rectangle but give me a margin".',
    inputSchema: {
      edit: editId,
      state: z.enum(['kept', 'removed']).describe('"kept" keeps every pixel, "removed" discards every pixel.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const all = new Uint8Array(handle.session.width * handle.session.height)
      if (args.state === 'kept') all.fill(255)
      const stats = replaceMask(handle.session, { width: handle.session.width, height: handle.session.height, values: all }, args.state === 'kept' ? 'keep all' : 'remove all')
      return json({ edit: handle.id, ...stats })
    })
)

server.registerTool(
  'edit_invert',
  {
    title: 'Flip the selection',
    description:
      'Swaps kept and removed everywhere, so what was erased becomes kept and vice versa. Use it to correct a cutout that took the subject instead of the background without re-running the cutout.',
    inputSchema: { edit: editId },
    // An involution, not an idempotent: inverting twice lands back where it
    // started, so a client that retried a "failed" invert would quietly undo it.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const stats = replaceMask(handle.session, invertMask(handle.session.mask), 'invert')
      return json({ edit: handle.id, ...stats })
    })
)

server.registerTool(
  'edit_refine',
  {
    title: 'Refine the selection edge',
    description:
      'One tool for the fixes that make a cutout look finished. Each is a single real operation on the mask and each can be undone. "grow" pushes the kept area outward to eat the halo the wand left, in pixels - start at 1. "shrink" pulls it back in to take back background that was wrongly kept. "feather" softens a hard edge into a gradient a few pixels wide, which is what stops a cutout looking like it was cut out with scissors; it is the opposite of "threshold". "despeckle" removes JPEG noise specks and is usually a single call worth trying after any cutout. "fill_holes" closes gaps inside the subject, such as a highlight the wand cut out. "keep_largest" drops every part of the selection except the biggest connected piece, which removes stray islands of background that happened to match. "threshold" turns a soft edge into a hard one at the given level, the complement of "feather".',
    inputSchema: {
      edit: editId,
      operation: z
        .enum(['grow', 'shrink', 'feather', 'despeckle', 'fill_holes', 'keep_largest', 'threshold'])
        .describe('Which refinement to apply.'),
      radius: z
        .number()
        .int()
        .min(0)
        .max(64)
        .optional()
        .describe(
          'Pixels for "grow" and "shrink". For "despeckle" it is how far the selection has to clear its own neighbours, so anything narrower than twice this plus one pixel is removed. Default 1, which takes single stray pixels. Ignored by the other operations.'
        ),
      level: z
        .number()
        .int()
        .min(0)
        .max(255)
        .optional()
        .describe('Cut point for "threshold": pixels at or above this mask value are kept, below it removed. Default 128.')
    },
    // Grow, shrink and despeckle move pixels every time they run, so a retry
    // moves the edge twice. Claiming idempotence here would invite that.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const mask = handle.session.mask
      switch (args.operation) {
        case 'grow': {
          const stats = replaceMask(handle.session, growMask(mask, args.radius ?? 1), `grow ${args.radius ?? 1}px`)
          return json({ edit: handle.id, operation: 'grow', radius: args.radius ?? 1, ...stats })
        }
        case 'shrink': {
          const stats = replaceMask(handle.session, shrinkMask(mask, args.radius ?? 1), `shrink ${args.radius ?? 1}px`)
          return json({ edit: handle.id, operation: 'shrink', radius: args.radius ?? 1, ...stats })
        }
        case 'feather': {
          // Softens the edge by averaging the mask over a window, which turns a
          // hard silhouette into a gradient a few pixels wide. The mirror image
          // of "threshold": that one bakes a gradient into a hard edge, this one
          // spreads a hard edge into a gradient. Defaults to 1 because softening
          // by more than a couple of pixels reads as a blur, not a cutout.
          const radius = args.radius ?? 1
          const next = featherMaskInPlace(mask, radius)
          const stats = replaceMask(handle.session, next, `feather ${radius}px`)
          return json({
            edit: handle.id,
            operation: 'feather',
            radius,
            ...stats,
            note:
              radius === 0
                ? 'A radius of 0 leaves the edge exactly as it was.'
                : `The edge now fades over about ${radius}px. Use edit_refine "threshold" to make it hard again.`
          })
        }
        case 'despeckle': {
          // Defaults to 1, which erases anything that cannot keep a full 3x3
          // neighbourhood. Zero is honoured as a no-op rather than quietly
          // promoted to 1, so "erase nothing" means what it says.
          const radius = args.radius ?? 1
          const next = despeckleMask(mask, radius)
          const stats = replaceMask(handle.session, next, `despeckle ${radius}px`)
          return json({
            edit: handle.id,
            operation: 'despeckle',
            radius,
            ...stats,
            note:
              stats.kept > 0
                ? `Parts narrower than ${2 * radius + 1}px were removed. Anything that survived is at least that wide.`
                : 'The selection was already free of specks at this size.'
          })
        }
        case 'fill_holes': {
          const result = fillMaskHoles(mask)
          const stats = replaceMask(handle.session, result.mask, 'fill holes')
          return json({ edit: handle.id, operation: 'fill_holes', filled: result.filled, ...stats })
        }
        case 'keep_largest': {
          const result = keepLargestRegion(mask)
          const stats = replaceMask(handle.session, result.mask, 'keep largest')
          return json({
            edit: handle.id,
            operation: 'keep_largest',
            dropped: result.dropped,
            ...stats,
            note:
              result.dropped > 0
                ? 'Parts of the selection were dropped because they were not connected to the largest piece. If part of the subject was one of them, restore it with edit_brush or select it separately.'
                : 'The selection was already one connected piece.'
          })
        }
        case 'threshold': {
          const level = args.level ?? 128
          const result = thresholdMask(mask, level)
          const stats = replaceMask(handle.session, result.mask, `threshold at ${level}`)
          return json({ edit: handle.id, operation: 'threshold', level, ...stats })
        }
      }
    })
)

server.registerTool(
  'edit_alpha_threshold',
  {
    title: 'Cut on transparency',
    description:
      'Keeps only the pixels that are already at least this opaque, discarding the rest. Use it on a PNG that is already transparent but has a soft or dirty edge from whatever made it - the tolerance of a colour wand cannot help there, because the problem is those pixels\' alpha, not their colour.',
    inputSchema: {
      edit: editId,
      level: z.number().int().min(0).max(255).describe('Alpha at or above which a pixel is kept, 0-255. Default 128.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const level = args.level ?? 128
      const alpha = new Uint8Array(handle.session.width * handle.session.height)
      for (let i = 0; i < alpha.length; i++) alpha[i] = handle.session.source.data[i * 4 + 3]!
      const result = thresholdAlpha(handle.session.mask, alpha, level)
      const stats = replaceMask(handle.session, result.mask, `alpha threshold at ${level}`)
      return json({
        edit: handle.id,
        level,
        ...stats,
        discarded: result.removed,
        note:
          result.removed === 0
            ? 'Nothing was discarded, so every pixel was already at least this opaque.'
            : undefined
      })
    })
)

server.registerTool(
  'edit_output',
  {
    title: 'Set what the finished picture looks like',
    description:
      'Records crop, rotate, flip, resize and colour adjustments for the finished picture. These are applied after the selection, so they never invalidate a selection already made, and they apply to both edit_preview and edit_apply - you set them once and both see them. Pass any subset of the fields; a field you leave out is unchanged. Call again with the same field to change it, or with crop false and trim false to turn trimming off.',
    inputSchema: {
      edit: editId,
      crop: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .nullable()
        .optional()
        .describe('Crop to this box in source pixels. Null clears an explicit crop.'),
      trim: z.boolean().optional().describe('Crop to the non-transparent content instead, removing the empty margin.'),
      rotate: z
        .number()
        .int()
        .min(-3)
        .max(3)
        .optional()
        .describe('Quarter turns clockwise: 1 is 90 degrees, -1 is 90 anticlockwise.'),
      flip: z.enum(['horizontal', 'vertical']).nullable().optional().describe('Mirror the picture. Null clears it.'),
      width: z.number().int().positive().nullable().optional().describe('Exact output width in pixels; the height follows to keep the shape. Null clears resizing.'),
      height: z.number().int().positive().nullable().optional().describe('Exact output height in pixels; the width follows to keep the shape. Null clears resizing.'),
      percent: z.number().positive().nullable().optional().describe('Scale by this percentage, e.g. 50 for half size. Null clears resizing.'),
      longestEdge: z.number().positive().nullable().optional().describe('Scale so the longest edge is this many pixels. Null clears resizing.'),
      brightness: z.number().min(-100).max(100).optional().describe('-100 to 100. Positive lightens.'),
      contrast: z.number().min(-100).max(100).optional().describe('-100 to 100. Positive raises contrast.'),
      saturation: z.number().min(-100).max(100).optional().describe('-100 to 100. Positive saturates.'),
      opacity: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Multiply alpha by this, 0-1. Below 1 softens a hard cutout.'),
      background: z
        .string()
        .nullable()
        .optional()
        .describe('6-digit hex colour like "#ffffff" to lay the cutout on instead of leaving it transparent. Null restores transparency.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const current = handle.session.output ?? {}
      const next = { ...current }

      if (args.crop !== undefined) {
        next.crop = args.crop ?? undefined
        if (args.crop) next.trim = false
      }
      if (args.trim !== undefined) {
        next.trim = args.trim
        if (args.trim) next.crop = undefined
      }
      if (args.rotate !== undefined) next.rotate = args.rotate === 0 ? undefined : args.rotate
      if (args.flip !== undefined) next.flip = args.flip ?? undefined
      if (args.background !== undefined) next.background = args.background ?? undefined

      // Sizing is replaced, not merged. Merging is what made it impossible to
      // change your mind: a session set to `percent` could not then be given
      // `longestEdge`, because both keys were still present and the call was
      // rejected as ambiguous, and `percent: null` was stored as a real `null`
      // instead of clearing the setting, which then scaled by NaN. Passing any
      // sizing field now means "use this one", and null means "no resize".
      // `width` and `height` are the one pair that may be given together, since
      // they are not alternatives but two halves of one target size. Every other
      // combination is genuinely ambiguous - "50 percent or 999 px?" has no
      // right answer, and picking one silently hides the mistake.
      const sizeKeys = ['width', 'height', 'percent', 'longestEdge'] as const
      const given = sizeKeys.filter((k) => args[k] !== undefined)
      const conflicting = given.filter((k) => !(k === 'width' || k === 'height'))
      if (conflicting.length > 0 && given.length > 1) {
        throw new Error(
          `give only one of percent or longestEdge, optionally alongside width or height; got ${given.join(', ')}`
        )
      }
      if (given.length === 0) {
        next.resize = current.resize
      } else {
        // Sized from what was passed, not from the current setting: a previous
        // percent must not survive into a new width, or the two would fight.
        const next_resize: Resize = {}
        if (args.width !== undefined && args.width !== null) next_resize.width = args.width
        if (args.height !== undefined && args.height !== null) next_resize.height = args.height
        if (args.percent !== undefined && args.percent !== null) next_resize.percent = args.percent
        if (args.longestEdge !== undefined && args.longestEdge !== null) next_resize.longestEdge = args.longestEdge
        next.resize = Object.keys(next_resize).length > 0 ? next_resize : undefined
      }

      const adjust = {
        ...(current.adjust ?? {}),
        ...(args.brightness !== undefined ? { brightness: args.brightness } : {}),
        ...(args.contrast !== undefined ? { contrast: args.contrast } : {}),
        ...(args.saturation !== undefined ? { saturation: args.saturation } : {}),
        ...(args.opacity !== undefined ? { opacity: args.opacity } : {})
      }
      next.adjust = Object.keys(adjust).length > 0 ? adjust : undefined

      handle.session.output = Object.keys(next).length > 0 ? next : undefined

      // The projected size is reported because a resize is usually asked for to hit
      // a dimension, and the caller should not have to preview to learn whether it
      // worked.
      const projected = render(handle.session)
      return json({
        edit: handle.id,
        output: handle.session.output ?? null,
        projected: { width: projected.width, height: projected.height },
        note: next.trim ? 'Trimming to the non-transparent content. If the subject is only part of the picture, set an explicit crop instead.' : undefined
      })
    })
)

server.registerTool(
  'edit_sample',
  {
    title: 'Read pixel colours',
    description:
      'Reads the colour of the pixels you name, in the original picture. Use it before choosing a tolerance or clicking for edit_select_wand: knowing the exact background colour is how you set a tolerance from evidence instead of guessing.',
    inputSchema: {
      edit: editId,
      points: z.array(point).min(1).max(256).describe('Points in picture pixels. Up to 256.')
    },
    // Reading is repeatable: the same points always name the same untouched source.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      return json({ edit: handle.id, samples: samplePixels(handle.session.source, args.points) })
    })
)

server.registerTool(
  'edit_analyze',
  {
    title: 'Analyse the picture',
    description:
      'Reports how much of the picture is opaque, and a coarse colour histogram of what it contains. Use it to choose a tolerance: a picture with a wide colour spread needs a bigger one than a flat studio shot. Reports on the original, not the current edit.',
    inputSchema: {
      edit: editId,
      bins: z.number().int().min(2).max(32).optional().describe('Histogram resolution per channel. Default 8.')
    },
    // Reading is repeatable: the histogram is a function of the untouched source.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      return json({ edit: handle.id, ...analyseRaster(handle.session.source, args.bins ?? 8) })
    })
)

server.registerTool(
  'edit_undo',
  {
    title: 'Undo the last change',
    description:
      'Steps back one operation on the selection. The original pixels are never touched, so this is exact rather than an approximation. Works for every selection and refinement tool. edit_history shows what the steps were.',
    inputSchema: {
      edit: editId,
      steps: z.number().int().min(1).max(50).optional().describe('How many steps to go back. Default 1.')
    },
    // Repeating an undo steps back again, so a client that retried one would
    // discard more work than it meant to.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const history = handle.session.history
      if (!history) throw new EditError('this edit has no history, so there is nothing to undo')
      const count = args.steps ?? 1
      const undone: string[] = []
      for (let i = 0; i < count; i++) {
        const label = history.undo(handle.session)
        if (label === null) break
        undone.push(label)
      }
      if (undone.length === 0) throw new EditError('there is nothing left to undo')
      return json({ edit: handle.id, undone, stats: maskStats(handle.session.mask), ...history.recent() })
    })
)

server.registerTool(
  'edit_redo',
  {
    title: 'Redo an undone change',
    description:
      'Steps forward again after edit_undo. Any new change discards the redo stack, so redo is only available while walking back through what you just did.',
    inputSchema: {
      edit: editId,
      steps: z.number().int().min(1).max(50).optional().describe('How many steps to go forward. Default 1.')
    },
    // Same reasoning as edit_undo, forwards this time.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const history = handle.session.history
      if (!history) throw new EditError('this edit has no history, so there is nothing to redo')
      const count = args.steps ?? 1
      const redone: string[] = []
      for (let i = 0; i < count; i++) {
        const label = history.redo(handle.session)
        if (label === null) break
        redone.push(label)
      }
      if (redone.length === 0) throw new EditError('there is nothing to redo; make a change first')
      return json({ edit: handle.id, redone, stats: maskStats(handle.session.mask) })
    })
)

server.registerTool(
  'edit_history',
  {
    title: 'Show the undo steps',
    description:
      'Lists the operations this edit has made, most recent last, and whether undo and redo are available. Use it before undoing several steps so you know what you are about to pass over.',
    inputSchema: {
      edit: editId,
      limit: z.number().int().min(1).max(100).optional().describe('How many of the most recent steps to list. Default 10.')
    },
    // Reading is repeatable: asking again returns the same list until something changes.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      if (!handle.session.history) throw new EditError('this edit has no history')
      return json({ edit: handle.id, ...handle.session.history.recent(args.limit ?? 10) })
    })
)

server.registerTool(
  'edit_reset',
  {
    title: 'Discard the edits',
    description:
      'Throws away every change to this edit and keeps the whole picture, which is where a freshly opened edit starts. The edit stays open so you can start again. Output settings such as crop and resize are kept, since those are statements about the picture rather than the selection.',
    inputSchema: { edit: editId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      resetSession(handle.session)
      return json({ edit: handle.id, stats: maskStats(handle.session.mask) })
    })
)

server.registerTool(
  'edit_close',
  {
    title: 'Close an edit',
    description:
      'Releases the memory this edit was holding and forgets its id. Always do this once a picture is finished: an open edit keeps several bytes per pixel resident, and a caller that opens pictures in a loop without closing them will fill memory and start losing edits to eviction at random. Save with edit_apply first - closing discards the edit, not the file.',
    inputSchema: { edit: editId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const closed = edits.close(args.edit)
      return json({ edit: args.edit, closed, pixelsInUse: edits.pixelsInUse() })
    })
)

server.registerTool(
  'edit_preview',
  {
    title: 'Preview an edit',
    description:
      'Renders the edit so far as a downscaled PNG and writes it to disk, leaving the original alone. The result is a view of what edit_apply would write, so look at it before applying rather than after.',
    inputSchema: {
      edit: editId,
      feather: z
        .number()
        .int()
        .min(0)
        .max(64)
        .optional()
        .describe('Soften the cut edge over this many pixels. Default 0. One pixel usually hides a jagged edge; more than a few just looks out of focus.'),
      maxEdge: z.number().int().positive().optional().describe(`Longest edge of the preview. Default ${DEFAULT_PREVIEW_EDGE}.`),
      path: absPath.optional().describe('Where to write the preview. Defaults to a new file beside the original.'),
      inline: z
        .boolean()
        .optional()
        .describe('Also return the preview as an image in the reply. Costs a large base64 payload, so only ask for it when you need to look at the result.')
    },
    // It will not replace an existing file, so nothing is destroyed, but each call
    // writes another PNG beside the original - the default path is a new name each
    // time, not a fixed one. Repeating a preview therefore leaves more files behind.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const feather = args.feather ?? 0
      const small = previewRaster(render(handle.session, feather), args.maxEdge ?? DEFAULT_PREVIEW_EDGE)
      const buf = encodePng(small)
      const target = args.path ? resolveOutputPath(handle.path, args.path) : defaultPreviewPath(handle.path)
      if (existsSync(target)) {
        throw new Error(`${target} already exists; pass a different path, since a preview will not replace a file`)
      }
      fsWriteFileSync(target, buf)
      const stats = inspectSession(handle.session)
      const reply = { edit: handle.id, path: target, width: small.width, height: small.height, bytes: buf.length, stats }
      if (args.inline) {
        return {
          content: [
            { type: 'text', text: JSON.stringify(reply, null, 2) },
            { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }
          ]
        }
      }
      return json(reply)
    })
)

server.registerTool(
  'edit_apply',
  {
    title: 'Write an edit to a new PNG',
    description:
      'Writes the finished edit as a PNG beside the original. The original is never modified, and the output is never allowed to land on top of it. Pass the path from edit_preview if you want to see it in place first.',
    inputSchema: {
      edit: editId,
      feather: z
        .number()
        .int()
        .min(0)
        .max(64)
        .optional()
        .describe('Soften the cut edge over this many pixels. Default 0.'),
      path: absPath.optional().describe('Where to write the PNG. The extension is corrected to .png, and the original is refused.'),
      overwrite: z
        .boolean()
        .optional()
        .describe('Replace a picture that already exists at that path. Default false.')
    },
    // Writes a file, and with overwrite it replaces one - that is a destructive
    // update by the MCP definition, even though the source is never at risk.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const info = inspectSession(handle.session)
      if (!info.hasEdits) {
        throw new Error('nothing has been edited yet; run edit_cutout_auto or edit_brush first')
      }
      const target = resolveOutputPath(handle.path, args.path)
      const saved = savePng(render(handle.session, args.feather ?? 0), target, handle.path, {
        overwrite: args.overwrite
      })
      return json({ edit: handle.id, source: handle.path, ...saved, stats: info })
    })
)

server.registerTool(
  'edit_inspect',
  {
    title: 'Inspect open edits',
    description:
      'Reports what an edit currently holds - how much is kept, softened and removed, and the box it occupies. Call it with no arguments to list every open edit, which is how to recover an edit id that was lost.',
    inputSchema: { edit: editId.optional().describe('Which edit to report on. Omit to list them all.') },
    // Reading is repeatable, and the no-argument form lists all open edits.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      if (args.edit === undefined) {
        return json({ open: edits.list(), pixelsInUse: edits.pixelsInUse() })
      }
      const handle = edits.require(args.edit)
      return json({
        edit: handle.id,
        path: handle.path,
        width: handle.session.width,
        height: handle.session.height,
        format: handle.format,
        stats: inspectSession(handle.session)
      })
    })
)

server.registerTool(
  'wallpaper_get',
  {
    title: 'Get the desktop background',
    description: 'Returns the current desktop background image path and how it is fitted.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  () => guard(async () => json(await getWallpaper()))
)

server.registerTool(
  'wallpaper_set',
  {
    title: 'Set the desktop background',
    description:
      'Sets the Windows desktop background to a picture. Check the file exists with photos_describe first; the file is not copied anywhere, so deleting it later leaves a blank background.',
    inputSchema: {
      path: absPath.describe('The picture to use as the background.'),
      fit: z
        .enum(['fill', 'fit', 'stretch', 'center', 'tile', 'span'])
        .optional()
        .describe('How to fit a picture that does not match the screen. Default "fill".')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      if (!existsSync(args.path)) throw new Error(`no such file: ${args.path}`)
      await setWallpaper(args.path, args.fit ?? 'fill')
      return ok(`Desktop background set to ${args.path} (${args.fit ?? 'fill'}).`)
    })
)

const binId = z
  .string()
  .min(1)
  .describe('Opaque id from bin_list. It is not a path and must be passed back exactly as given.')

server.registerTool(
  'bin_list',
  {
    title: 'List the Recycle Bin',
    description:
      'Lists everything in the Windows Recycle Bin with the path each item was deleted from, its size, and when it was deleted. Each entry has an id used by bin_restore and bin_purge.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  () =>
    guard(async () => {
      const entries = await listBin()
      return json({ count: entries.length, entries })
    })
)

server.registerTool(
  'bin_send',
  {
    title: 'Move pictures to the Recycle Bin',
    description:
      'Moves files to the Windows Recycle Bin, exactly as pressing Delete in Explorer would. This is recoverable via bin_restore. Each file is reported separately so one locked file does not fail the rest.',
    inputSchema: { paths: z.array(absPath).min(1).describe('The files to delete.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  (args) =>
    guard(async () => {
      const results = await sendToBin(args.paths)
      const failed = results.filter((r) => !r.ok)
      const body = { deleted: results.length - failed.length, failed }
      return {
        ...json(body),
        isError: failed.length > 0 && failed.length === results.length ? true : undefined
      }
    })
)

server.registerTool(
  'bin_restore',
  {
    title: 'Restore from the Recycle Bin',
    description: 'Puts a deleted item back where it came from, using the original path recorded by Windows.',
    inputSchema: {
      id: binId,
      overwrite: z
        .boolean()
        .optional()
        .describe('Replace a file that already exists at the original path. Default false.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (args) => guard(async () => ok(`Restored to ${await restore(args.id, { overwrite: args.overwrite })}`))
)

server.registerTool(
  'bin_purge',
  {
    title: 'Permanently delete from the Recycle Bin',
    description: 'Erases a single item from the Recycle Bin for good. This cannot be undone.',
    inputSchema: { id: binId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      await purge(args.id)
      return ok(`Permanently deleted item ${args.id}.`)
    })
)

server.registerTool(
  'bin_empty',
  {
    title: 'Empty the Recycle Bin',
    description: 'Permanently deletes everything in the Recycle Bin. This cannot be undone.',
    inputSchema: { confirm: z.literal(true).describe('Must be true. Guards against calling this by accident.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      if (args.confirm !== true) throw new Error('confirm must be true')
      return ok(`Permanently deleted ${await emptyBin()} item(s) from the Recycle Bin.`)
    })
)

server.registerTool(
  'reveal',
  {
    title: 'Show a file in Explorer',
    description: 'Opens Explorer with the file selected. Useful for showing a person where something ended up.',
    inputSchema: { path: absPath.describe('File or folder to reveal.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  (args) =>
    guard(async () => {
      if (!existsSync(args.path)) throw new Error(`no such path: ${args.path}`)
      await powershell(`Start-Process -FilePath explorer.exe -ArgumentList @(, '/select,${args.path.replace(/'/g, "''")}')`)
      return ok(`Revealed ${args.path} in Explorer.`)
    })
)

server.registerTool(
  'open',
  {
    title: 'Open a picture',
    description: 'Opens a picture with whatever program Windows uses for it.',
    inputSchema: { path: absPath.describe('The picture to open.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  (args) =>
    guard(async () => {
      if (!existsSync(args.path)) throw new Error(`no such file: ${args.path}`)
      await powershell(`Start-Process -FilePath ${psString(args.path)}`)
      return ok(`Opened ${parse(args.path).base} with the default program.`)
    })
)

/**
 * A duration in a sentence a model can use.
 *
 * Seconds alone make an agent do arithmetic it will get wrong, and `83.4000000001`
 * invites a false claim of precision the file does not have.
 */
function sayDuration(seconds: number): string {
  return `${formatDuration(seconds)} (${seconds.toFixed(3)}s)`
}

/**
 * Nothing may reach stdout except protocol messages.
 *
 * The transport frames replies on stdout, so a stray `console.log` anywhere in
 * this process - including from a dependency - corrupts the stream and the
 * client drops the connection with no useful error. Diagnostics therefore go to
 * stderr, which the transport ignores.
 */
/**
 * Nothing may reach stdout except protocol messages.
 *
 * The transport frames replies on stdout, so a stray `console.log` anywhere in
 * this process - including from a dependency - corrupts the stream and the
 * client drops the connection with no useful error. Diagnostics therefore go to
 * stderr, which the transport ignores.
 */

server.registerTool(
  'video_addons',
  {
    title: 'Check which external tools are available',
    description:
      'Reports whether FFmpeg, FFprobe, Node, Python and Git are installed, and which copy is being used. OpenPics ships its own FFmpeg, so `bundled: true` is the normal answer and is not a problem. Call this before a video edit if one reports that a tool is missing, to tell "not installed" from "installed but broken".',
    inputSchema: {
      refresh: z
        .boolean()
        .optional()
        .describe('Re-run every probe instead of using the cached answer. Default false.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const list = args.refresh ? await refreshAddonStatuses() : await addonStatuses()
      // Text lines rather than the raw array: a model reading this wants to know
      // which tool to avoid, not to parse a nested object to find out.
      const lines = list.map((a) => {
        if (a.available) return `[ok]   ${a.label} ${a.version ?? ''} (${a.source}) - ${a.path}`
        const tag = a.blocking ? 'REQUIRED' : 'optional'
        return `[--]   ${a.label} not available (${tag}) - ${a.problem ?? 'unknown'}${a.vendor ? ` - see https://${a.vendor}` : ''}`
      })
      const missingRequired = list.filter((a) => a.blocking && !a.available)
      const tail = missingRequired.length
        ? `\n\nVideo editing is unavailable: ${missingRequired.map((a) => a.label).join(', ')} missing. Reinstall OpenPics if these were expected to be bundled.`
        : ''
      return ok(lines.join('\n') + tail)
    })
)

server.registerTool(
  'video_probe',
  {
    title: 'Inspect a video',
    description:
      'Reads a video\'s duration, dimensions, frame rate and stream layout without changing anything. Call this before trimming or splitting: it is the only way to know a clip\'s real length, and cutting to an end time past the clip is refused rather than guessed.',
    inputSchema: { path: absPath.describe('The video to inspect.') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const info = await probeVideo(args.path)
      const size = info.width && info.height ? `${info.width}x${info.height}` : 'unknown size'
      const rate = info.frameRate ? `${info.frameRate.toFixed(3)} fps` : 'unknown frame rate'
      const v = info.videoStreams[0]
      const a = info.audioStreams[0]
      const head =
        `${parse(args.path).base}: ${sayDuration(info.durationSeconds)}, ${size}, ${rate}, ` +
        `${(info.bytes / 1024 / 1024).toFixed(1)} MB`
      const detail = [
        `video: ${v ? `${v.codec}, ${v.width}x${v.height}, ${v.frameRate ?? '?'} fps${v.rotation ? `, rotated ${v.rotation}°` : ''}` : 'none'}`,
        `audio: ${a ? `${a.codec}, ${a.channels ?? '?'} channel(s)${a.sampleRate ? `, ${a.sampleRate} Hz` : ''}` : 'none'}`
      ]
      return ok([head, ...detail].join('\n'))
    })
)

server.registerTool(
  'video_trim',
  {
    title: 'Trim a video',
    description:
      'Keeps the part of a clip between two times and writes a NEW file. The original is never modified. By default the streams are copied, which takes about a second but cuts on the nearest keyframe, so the result can start slightly early or late. Set accurate: true to re-encode and land on exactly the requested frame.',
    inputSchema: {
      path: absPath.describe('The clip to trim. It is not modified.'),
      startSeconds: z.number().min(0).optional().describe('Where to start, in seconds. Default 0.'),
      endSeconds: z.number().positive().optional().describe('Where to stop, in seconds. Default the end of the clip.'),
      output: absPath.optional().describe('Where to write the result. Default a new file beside the source.'),
      accurate: z
        .boolean()
        .optional()
        .describe('Re-encode so the cut lands exactly where asked. Much slower. Default false.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const out = await trimVideo(args)
      return ok(
        `Wrote ${out.path} - ${sayDuration(out.durationSeconds)}, ${(out.bytes / 1024 / 1024).toFixed(1)} MB. ` +
          `Streams were ${out.copied ? 'copied, so the cut is on the nearest keyframe' : 're-encoded, so the cut is frame-exact'}. ` +
          `The source is unchanged.`
      )
    })
)

server.registerTool(
  'video_split',
  {
    title: 'Split a video into pieces',
    description:
      'Cuts a clip at the given times and writes the pieces as new files. Two cuts make THREE pieces, because each cut is a boundary. The source is never modified. Cut points outside the clip are dropped rather than refused, and duplicates collapse.',
    inputSchema: {
      path: absPath.describe('The clip to split. It is not modified.'),
      cutSeconds: z
        .array(z.number().positive())
        .min(1)
        .describe('Times to cut at, in seconds. Two cuts produce three pieces.'),
      outputDir: absPath.optional().describe('Where to put the pieces. Default the source\'s folder.'),
      prefix: z.string().optional().describe('Filename stem for the pieces. Default the source name plus "-part".'),
      accurate: z.boolean().optional().describe('Re-encode instead of copying. Default false.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const pieces = await splitVideo(args)
      const list = pieces.map((p, i) => `  ${i + 1}. ${p.path} - ${sayDuration(p.durationSeconds)}`).join('\n')
      return ok(`Split into ${pieces.length} piece(s):\n${list}\nThe source is unchanged.`)
    })
)

server.registerTool(
  'video_concat',
  {
    title: 'Join videos together',
    description:
      'Joins clips end to end into one new file and leaves every source alone. Pieces are joined without re-encoding when they share codecs and resolution, which is the normal case for cuts of one recording. Set reencode: true when they do not match, or when ffmpeg reports that it cannot copy the streams.',
    inputSchema: {
      paths: z.array(absPath).min(2).describe('The clips to join, in order. Two or more.'),
      output: absPath.optional().describe('Where to write the result. Default a new file beside the first input.'),
      reencode: z.boolean().optional().describe('Re-encode instead of copying. Default false.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const out = await concatVideos(args)
      return ok(
        `Joined ${args.paths.length} clips into ${out.path} - ${sayDuration(out.durationSeconds)}, ` +
          `${(out.bytes / 1024 / 1024).toFixed(1)} MB, streams ${out.copied ? 'copied' : 're-encoded'}. ` +
          `Every source is unchanged.`
      )
    })
)

server.registerTool(
  'video_frame',
  {
    title: 'Save a frame from a video as an image',
    description:
      'Writes one still frame from a clip as a JPEG, for a thumbnail or for looking at a clip without playing it. Seeks exactly, so the frame is the moment asked for. Writes a new file; nothing is modified.',
    inputSchema: {
      path: absPath.describe('The clip to read. It is not modified.'),
      atSeconds: z.number().min(0).optional().describe('Exact moment to grab, in seconds. Takes precedence over fraction.'),
      fraction: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Where in the clip to grab, 0 to 1. Default 0.25, a quarter of the way in.'),
      output: absPath.optional().describe('Where to write the JPEG. Default a new file beside the source.'),
      width: z.number().int().positive().optional().describe('Scale the frame to this width, keeping the aspect ratio.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const out = await extractFrame(args)
      return ok(`Saved the frame at ${out.atSeconds.toFixed(3)}s to ${out.path} (${(out.bytes / 1024).toFixed(0)} KB).`)
    })
)

process.on('uncaughtException', (err) => {
  console.error('[openpics-mcp] uncaught:', err)
})

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

void main().catch((err: unknown) => {
  console.error('[openpics-mcp] failed to start:', err)
  process.exit(1)
})
