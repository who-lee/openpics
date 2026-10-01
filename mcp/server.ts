import { existsSync, writeFileSync as fsWriteFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { describePhoto, findPhotos } from '../core/photos'
import { getWallpaper, setWallpaper } from '../core/wallpaper'
import { emptyBin, listBin, purge, restore, sendToBin } from '../core/recyclebin'
import { powershell, psString } from '../core/powershell'
import { paintBrush } from '../core/edit/brush'
import { defaultOutputPath, resolveOutputPath, savePng } from '../core/edit/io'
import { maskStats } from '../core/edit/mask'
import { DEFAULT_PREVIEW_EDGE, previewRaster } from '../core/edit/preview'
import { composite, cutoutFromBorder, inspectSession } from '../core/edit/session'
import { EditStore } from '../core/edit/store'
import { encodePng } from '../core/image/png'

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
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  (args) =>
    guard(async () => {
      const handle = edits.open(args.path, args.edit)
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
      const stats = maskStats(handle.session.mask)
      return json({
        edit: handle.id,
        painted,
        stats,
        note: painted === 0 ? 'Nothing changed: the stroke was already at the requested value, or fell outside the picture.' : undefined
      })
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const feather = args.feather ?? 0
      const small = previewRaster(composite(handle.session, feather), args.maxEdge ?? DEFAULT_PREVIEW_EDGE)
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (args) =>
    guard(async () => {
      const handle = edits.require(args.edit)
      const info = inspectSession(handle.session)
      if (!info.hasEdits) {
        throw new Error('nothing has been edited yet; run edit_cutout_auto or edit_brush first')
      }
      const target = resolveOutputPath(handle.path, args.path)
      const saved = savePng(composite(handle.session, args.feather ?? 0), target, handle.path, {
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
    annotations: { readOnlyHint: true, openWorldHint: false }
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
 * Nothing may reach stdout except protocol messages.
 *
 * The transport frames replies on stdout, so a stray `console.log` anywhere in
 * this process - including from a dependency - corrupts the stream and the
 * client drops the connection with no useful error. Diagnostics therefore go to
 * stderr, which the transport ignores.
 */
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
