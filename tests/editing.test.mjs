/**
 * Tests for the editing handlers the renderer talks to.
 *
 * The MCP suite covers the same raster code from the agent's side over JSON-RPC,
 * which leaves the picture-editing path the app itself uses untested. That path is
 * where a silent failure is most expensive: `handlePreview` and `handleApply` once
 * built their picture with `composite`, which ignores `OutputSettings`, so every
 * crop, rotation, flip, resize and colour change a user made in the panel was
 * accepted, reported as applied, and then thrown away at save time. Nothing in the
 * MCP suite could see that, because the MCP tools call `render`.
 *
 * So these drive `electron/editing.ts` directly - it imports no Electron runtime, so
 * it loads under plain Node - and assert against the pixels of the file that comes
 * out, rather than against what the handler says about it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EDITING = new URL('../dist-test/electron/editing.js', import.meta.url).href
if (!existsSync(fileURLToPath(new URL('../dist-test/electron/editing.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/electron/editing.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const { handleApply, handleBrush, handleClose, handleHistory, handleInspect, handleOpen, handleOutput, handlePreview, handleRedo, handleSelection, handleUndo } =
  await import(EDITING)
const { decodeImage } = await import(new URL('../dist-test/core/image/image.js', import.meta.url).href)

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
/** Runs a handler that is expected to refuse, and reports what it said. */
function refuses(name, fn) {
  try {
    fn()
    check(name, false, 'it succeeded instead')
  } catch (err) {
    check(name, true, String(err && err.message))
  }
}

/* ---------- fixture: 60x40, blue background, red square subject at (20,10)-(39,29) ---------- */
const W = 60
const H = 40
function makePng(file) {
  const raw = Buffer.alloc((W * 4 + 1) * H)
  let p = 0
  for (let y = 0; y < H; y++) {
    raw[p++] = 0
    for (let x = 0; x < W; x++) {
      const inSubject = x >= 20 && x < 40 && y >= 10 && y < 30
      raw[p++] = inSubject ? 220 : 20
      raw[p++] = inSubject ? 30 : 40
      raw[p++] = inSubject ? 30 : 200
      raw[p++] = 255
    }
  }
  const idat = deflateSync(raw)
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]))
}

const FIX = join(process.env.TEMP ?? '.', `openpics-edit-verify-${randomUUID().slice(0, 8)}`)
mkdirSync(FIX, { recursive: true })
const SRC = join(FIX, 'subject.png')
makePng(SRC)

/** Decodes a file the app wrote, so assertions read pixels rather than reports. */
function read(path) {
  return decodeImage(readFileSync(path))
}
function pixel(raster, x, y) {
  const i = (y * raster.width + x) * 4
  return [raster.data[i], raster.data[i + 1], raster.data[i + 2], raster.data[i + 3]]
}

try {
  /* ---------- output settings actually reach the picture ---------- */
  section('output settings')
  {
    const id = handleOpen(SRC).id
    // Rotate a quarter turn on a 60x40 picture: the result must be 40x60. Under the
    // old `composite` call this returned 60x40 and every panel lied.
    const { projected } = handleOutput(id, { rotate: 1 })
    check('rotate reports the projected size', projected.width === 40 && projected.height === 60, JSON.stringify(projected))

    const preview = handlePreview(id)
    check('preview is the rotated picture', preview.width === 40 && preview.height === 60, `${preview.width}x${preview.height}`)

    const out = join(FIX, 'rotated.png')
    const saved = handleApply(id, { path: out })
    check('apply saves without complaint', !saved.isError)
    const r = read(out)
    check('the saved file is rotated', r.width === 40 && r.height === 60, `${r.width}x${r.height}`)
    // The top-left of the rotated picture came from the top-left of the original.
    const [rr, gg, bb] = pixel(r, 0, 0)
    check('rotated pixels came from the source', rr === 20 && gg === 40 && bb === 200, `${rr},${gg},${bb}`)
    handleClose(id)
  }

  {
    // The bug this suite exists for: a crop with no mask edit at all must be
    // savable. `hasEdits` reports on the mask, so this used to be refused as
    // "nothing has been edited yet".
    const id = handleOpen(SRC).id
    refuses('apply with no edits and no output is refused', () => handleApply(id, { path: join(FIX, 'nothing.png') }))
    handleOutput(id, { crop: { x: 0, y: 0, width: 20, height: 10 } })
    const out = join(FIX, 'cropped-only.png')
    handleApply(id, { path: out })
    const r = read(out)
    check('a crop on its own can be saved', r.width === 20 && r.height === 10, `${r.width}x${r.height}`)
    handleClose(id)
  }

  {
    // hasEdits is what the renderer uses to decide there are unsaved changes, and
    // what decides whether Save is offered at all. A picture that has only been
    // cropped or rotated has been edited, and reporting otherwise would let it be
    // handed to the desktop as the untouched original.
    const id = handleOpen(SRC).id
    check('a freshly opened session is unedited', handleInspect(id).info.hasEdits === false)
    handleOutput(id, { rotate: 90 })
    check('a rotation alone counts as an edit', handleInspect(id).info.hasEdits === true)
    handleOutput(id, { adjust: { brightness: 20 } })
    check('a colour change alone counts as an edit', handleInspect(id).info.hasEdits === true)
    handleOutput(id, null)
    check('clearing the settings goes back to unedited', handleInspect(id).info.hasEdits === false)
    handleClose(id)
  }

  {
    const id = handleOpen(SRC).id
    handleOutput(id, { resize: { percent: 50 } })
    const r0 = handleOutput(id, null)
    check('null clears every output setting', r0.projected.width === W && r0.projected.height === H, JSON.stringify(r0.projected))
    const preview = handlePreview(id)
    check('cleared output previews at source size', preview.width === W && preview.height === H)
    handleClose(id)
  }

  {
    // A panel holds a fixed set of sliders and sends the whole object back, so
    // cleared sliders arrive as keys with no value. Counting those as settings made
    // a session that had been turned all the way back look edited, which let a save
    // write out a copy of the untouched source and report it as an edit.
    const id = handleOpen(SRC).id
    handleOutput(id, { resize: { percent: 50 }, adjust: { brightness: 40 } })
    handleOutput(id, { resize: undefined, adjust: undefined })
    let refused = false
    try {
      handleApply(id, { path: join(FIX, 'all-cleared.png') })
    } catch (err) {
      refused = err instanceof Error
    }
    check('cleared sliders leave nothing to save', refused, 'a save went through with every setting off')
    // The same trap one level down: adjust set then adjust emptied.
    handleOutput(id, { adjust: { contrast: 30 } })
    handleOutput(id, { adjust: { contrast: undefined } })
    let refused2 = false
    try {
      handleApply(id, { path: join(FIX, 'adjust-cleared.png') })
    } catch (err) {
      refused2 = err instanceof Error
    }
    check('an emptied adjust block is not an edit', refused2, 'a save went through with adjust empty')
    handleClose(id)
  }

  {
    const id = handleOpen(SRC).id
    handleOutput(id, { adjust: { brightness: 100 } })
    const out = join(FIX, 'bright.png')
    handleApply(id, { path: out })
    const r = read(out)
    const [, , , a] = pixel(r, 0, 0)
    check('brightness reached the saved file', a === 255 && pixel(r, 0, 0)[0] > 20, JSON.stringify(pixel(r, 0, 0)))
    handleClose(id)
  }

  {
    // A background colour is what flattens a cutout onto something. It only works
    // if the renderer is used, so this doubles as a check that it was.
    const id = handleOpen(SRC).id
    handleSelection(id, { kind: 'all', state: 'removed' })
    handleSelection(id, { kind: 'rect', x: 20, y: 10, width: 20, height: 20, keep: 'region' })
    handleOutput(id, { background: '#00ff00' })
    const out = join(FIX, 'flatten.png')
    handleApply(id, { path: out })
    const r = read(out)
    const outside = pixel(r, 0, 0)
    check('background filled what was removed', outside[0] === 0 && outside[1] === 255 && outside[3] === 255, outside.join(','))
    handleClose(id)
  }

  /* ---------- selection ---------- */
  section('selection')
  {
    const id = handleOpen(SRC).id
    const kept = handleSelection(id, { kind: 'rect', x: 20, y: 10, width: 20, height: 20, keep: 'region' })
    check('rect keeps the region it was given', kept.stats.kept === 400, `kept ${kept.stats.kept}`)
    check('a selection comes back with a preview', typeof kept.preview?.dataUrl === 'string')

    const rest = handleSelection(id, { kind: 'rect', x: 20, y: 10, width: 20, height: 20, keep: 'rest' })
    check('the other side can be kept instead', rest.stats.kept === W * H - 400, `kept ${rest.stats.kept}`)

    const ellipse = handleSelection(id, { kind: 'ellipse', x: 0, y: 0, width: 60, height: 40, keep: 'region' })
    check('ellipse over the whole picture is less than all of it', ellipse.stats.kept > 0 && ellipse.stats.kept < W * H, `kept ${ellipse.stats.kept}`)

    const poly = handleSelection(id, {
      kind: 'polygon',
      points: [{ x: 20, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 30 }],
      keep: 'region'
    })
    // A right triangle of legs 20 covers 200 pixels of area, but a scanline fill
    // includes the pixels the edges pass through, so the count is a little higher.
    // Asserted as a range rather than an exact figure because the exact figure is a
    // property of the fill rule, not of this handler.
    check('polygon selects the triangle', poly.stats.kept > 180 && poly.stats.kept < 260, `kept ${poly.stats.kept}`)

    const wand = handleSelection(id, { kind: 'wand', x: 2, y: 2, tolerance: 20, keep: 'rest' })
    check('wand finds the background', wand.stats.kept === 400, `kept ${wand.stats.kept}`)

    handleSelection(id, { kind: 'invert' })
    const inverted = handleSelection(id, { kind: 'all', state: 'kept' })
    check('all/invert/invert round trips', inverted.stats.kept === W * H, `kept ${inverted.stats.kept}`)
    handleClose(id)
  }

  {
    const id = handleOpen(SRC).id
    handleSelection(id, { kind: 'all', state: 'kept' })
    const removed = handleSelection(id, { kind: 'all', state: 'removed' })
    check('remove everything is honoured', removed.stats.kept === 0 && removed.stats.removed === W * H, `kept ${removed.stats.kept}`)
    handleClose(id)
  }

  {
    // Refinement, each undoable and each reporting whether it moved anything.
    const id = handleOpen(SRC).id
    handleSelection(id, { kind: 'rect', x: 25, y: 15, width: 10, height: 10, keep: 'region' })
    const grow = handleSelection(id, { kind: 'refine', operation: 'grow', radius: 2 })
    check('grow enlarges the selection', grow.stats.kept > 100, `kept ${grow.stats.kept}`)
    const shrink = handleSelection(id, { kind: 'refine', operation: 'shrink', radius: 4 })
    check('shrink reduces it again', shrink.stats.kept < grow.stats.kept, `${shrink.stats.kept} vs ${grow.stats.kept}`)
    handleSelection(id, { kind: 'refine', operation: 'keep_largest' })
    handleSelection(id, { kind: 'refine', operation: 'fill_holes' })
    handleSelection(id, { kind: 'refine', operation: 'despeckle', radius: 1 })
    // Not every call is guaranteed a step: the history deliberately drops one that
    // leaves the mask exactly as it was, which is what keep_largest and fill_holes do
    // to an already-clean rectangle. So the count is bounded rather than exact, and
    // the steps that did change pixels are the ones that must be there.
    const refined = handleHistory(id)
    const labels = refined.steps.map((s) => s.label)
    check('the selections and the changes they made are all steps', refined.steps.length >= 3, `${refined.steps.length} steps`)
    check('grow and shrink are named in the history', labels.includes('grow the selection') && labels.includes('shrink the selection'), JSON.stringify(labels))
    handleSelection(id, { kind: 'refine', operation: 'threshold', level: 200 })
    check('threshold runs without complaint', true)
    handleClose(id)
  }

  /* ---------- refusals ---------- */
  section('refusals')
  {
    const id = handleOpen(SRC).id
    refuses('a bad tolerance is refused', () => handleSelection(id, { kind: 'wand', x: 1, y: 1, tolerance: 9999, keep: 'rest' }))
    refuses('a negative tolerance is refused', () => handleSelection(id, { kind: 'wand', x: 1, y: 1, tolerance: -1, keep: 'rest' }))
    refuses('a two-point polygon is refused', () => handleSelection(id, { kind: 'polygon', points: [{ x: 1, y: 1 }, { x: 5, y: 5 }], keep: 'region' }))
    refuses('a non-finite point is refused', () => handleSelection(id, { kind: 'wand', x: Number.NaN, y: 0, keep: 'rest' }))
    refuses('a zero-sized box is refused', () => handleSelection(id, { kind: 'rect', x: 0, y: 0, width: 0, height: 10, keep: 'region' }))
    refuses('a box entirely outside the picture is refused', () => handleSelection(id, { kind: 'rect', x: 500, y: 500, width: 10, height: 10, keep: 'region' }))
    refuses('an unknown refine operation is refused', () => handleSelection(id, { kind: 'refine', operation: 'feather' }))
    refuses('an unknown kind is refused', () => handleSelection(id, { kind: 'nonsense' }))
    refuses('a bad keep is refused', () => handleSelection(id, { kind: 'all', state: 'maybe' }))
    // A drag that runs off the edge of the canvas is normal, not a mistake, so it
    // clips instead of failing.
    const clipped = handleSelection(id, { kind: 'rect', x: -20, y: -20, width: 40, height: 30, keep: 'region' })
    check('a box overhanging the picture is clipped', clipped.stats.kept === 20 * 10, `kept ${clipped.stats.kept}`)
    handleClose(id)
  }

  /* ---------- history ---------- */
  section('history')
  {
    const id = handleOpen(SRC).id
    const start = handleHistory(id)
    check('a fresh session has nothing to undo', start.canUndo === false && start.steps.length === 0)

    handleSelection(id, { kind: 'all', state: 'removed' })
    handleSelection(id, { kind: 'rect', x: 20, y: 10, width: 20, height: 20, keep: 'region' })
    const two = handleHistory(id)
    check('two selections are two steps', two.steps.length === 2 && two.canUndo === true, JSON.stringify(two.steps))
    check('the newest step is last', two.steps[1].label === 'rect selection', JSON.stringify(two.steps))

    const undone = handleUndo(id)
    check('undo names the step it walked back', undone.label === 'rect selection', String(undone.label))
    check('undo brings a preview', typeof undone.preview?.dataUrl === 'string')
    check('undo leaves something to redo', handleHistory(id).canRedo === true)

    const redone = handleRedo(id)
    check('redo replays the same step under the same name', redone.label === 'rect selection', String(redone.label))
    check('redo restores both steps of history', handleHistory(id).steps.length === 2)

    // Two selections means two undos before the start, not one: the first undo
    // reverses the rectangle, which returns the session to the state the second
    // step left behind, and only then is there nothing left to walk back.
    handleUndo(id)
    const backOne = handleUndo(id)
    check('the second undo names the first selection', backOne.label === 'remove the whole picture', String(backOne.label))
    const past = handleUndo(id)
    check('undo at the start says so rather than failing', past.label === null, String(past.label))

    // A brush stroke must be a step too, or the panel and the agent disagree about
    // what undo reaches.
    const id2 = handleOpen(SRC).id
    handleBrush(id2, { points: [{ x: 30, y: 20 }], radius: 3, mode: 'erase' })
    check('a brush stroke is undoable', handleHistory(id2).steps.length === 1, `${handleHistory(id2).steps.length} steps`)
    check('the stroke actually removed something', handleInspect(id2).info.stats.removed > 0)
    // Read rather than re-select: asking for "keep everything" would overwrite the
    // mask and prove nothing about whether undo restored it.
    handleUndo(id2)
    check('undoing the stroke brings the pixels back', handleInspect(id2).info.stats.removed === 0, `removed ${handleInspect(id2).info.stats.removed}`)

    // A stroke that paints nothing must not push a step, or the next undo reaches a
    // no-op instead of the change the user actually wants to reverse. The mask is
    // fully restored at this point, so the first stroke here is a real change and
    // the second is the repeat that must not count.
    handleBrush(id2, { points: [{ x: 5, y: 5 }], radius: 1, mode: 'erase' })
    check('a real stroke adds one step', handleHistory(id2).steps.length === 1, `${handleHistory(id2).steps.length} steps`)
    handleBrush(id2, { points: [{ x: 5, y: 5 }], radius: 1, mode: 'erase' })
    check('repeating that exact stroke adds no step', handleHistory(id2).steps.length === 1, `${handleHistory(id2).steps.length} steps`)
    const repeat = handleBrush(id2, { points: [{ x: 5, y: 5 }], radius: 1, mode: 'erase' })
    check('the repeat says it changed nothing', typeof repeat.note === 'string', String(repeat.note))
    handleClose(id2)
    handleClose(id)
  }

  /* ---------- cutout still works through the same handlers ---------- */
  section('existing behaviour')
  {
    const id = handleOpen(SRC).id
    handleSelection(id, { kind: 'wand', x: 2, y: 2, tolerance: 20, keep: 'rest' })
    const out = join(FIX, 'cutout.png')
    handleApply(id, { path: out })
    const r = read(out)
    const [, , , outsideAlpha] = pixel(r, 0, 0)
    check('the background is still removable', outsideAlpha === 0, `alpha ${outsideAlpha}`)
    const [sr, sg, sb, sa] = pixel(r, 25, 20)
    check('the subject is still intact', sr === 220 && sg === 30 && sa === 255, `${sr},${sg},${sa}`)
    handleClose(id)
  }
} finally {
  try {
    rmSync(FIX, { recursive: true, force: true })
  } catch {}
}

/* ---------- settings validation ---------- */
section('settings validation')
// The app used to accept any value whose `typeof` matched the default, which
// admits NaN. A cleared number field sends `Number('')`, and a NaN row height
// collapses the grid with no error to trace it to, and it survives every restart
// because the same loose check runs on the way back in. These assert the bounds
// hold on both paths: a corrupt file, and a patch from the renderer.
{
  const { sanitizeSettings, applyPatch } = await import(
    new URL('../dist-test/shared/settings-schema.js', import.meta.url).href
  )
  const { DEFAULT_SETTINGS } = await import(new URL('../dist-test/shared/protocol.js', import.meta.url).href)

  let s = sanitizeSettings({ rowHeight: Number('') }, DEFAULT_SETTINGS)
  check('a cleared number field cannot persist NaN', Number.isFinite(s.rowHeight), `rowHeight ${s.rowHeight}`)

  s = sanitizeSettings({ rowHeight: 'huge' }, DEFAULT_SETTINGS)
  check('a string cannot be written into a numeric setting', s.rowHeight === DEFAULT_SETTINGS.rowHeight, `rowHeight ${s.rowHeight}`)

  s = sanitizeSettings({ rowHeight: -50 }, DEFAULT_SETTINGS)
  check('a negative row height is clamped', s.rowHeight === 64, `rowHeight ${s.rowHeight}`)

  s = sanitizeSettings({ rowHeight: 99_999 }, DEFAULT_SETTINGS)
  check('an absurd row height is clamped', s.rowHeight === 512, `rowHeight ${s.rowHeight}`)

  s = sanitizeSettings({ rowHeight: 200.4 }, DEFAULT_SETTINGS)
  check('a fractional row height is rounded', s.rowHeight === 200, `rowHeight ${s.rowHeight}`)

  // A NaN already sitting in settings.json must not survive a restart.
  s = sanitizeSettings({ terminalHeight: NaN }, DEFAULT_SETTINGS)
  check('a NaN on disk falls back to the default', s.terminalHeight === DEFAULT_SETTINGS.terminalHeight, `terminalHeight ${s.terminalHeight}`)

  s = sanitizeSettings({ theme: 'chartreuse' }, DEFAULT_SETTINGS)
  check('an invented theme is refused', s.theme === 'dark', `theme ${s.theme}`)
  s = sanitizeSettings({ theme: 'light' }, DEFAULT_SETTINGS)
  check('a real theme is accepted', s.theme === 'light', `theme ${s.theme}`)

  s = sanitizeSettings({ scanMode: 'everything' }, DEFAULT_SETTINGS)
  check('an invented scan mode is refused', s.scanMode === 'folder', `scanMode ${s.scanMode}`)
  s = sanitizeSettings({ sortKey: 'colour' }, DEFAULT_SETTINGS)
  check('an invented sort key is refused', s.sortKey === 'name', `sortKey ${s.sortKey}`)
  s = sanitizeSettings({ sortDir: 'sideways' }, DEFAULT_SETTINGS)
  check('an invented sort direction is refused', s.sortDir === 'asc', `sortDir ${s.sortDir}`)

  s = sanitizeSettings({ enableTerminal: 'yes' }, DEFAULT_SETTINGS)
  check('a string cannot turn the terminal on', s.enableTerminal === DEFAULT_SETTINGS.enableTerminal, `enableTerminal ${s.enableTerminal}`)

  // Unknown keys must be dropped, not carried through to the running app.
  s = sanitizeSettings({ root: 'C:\\Pics', somethingElse: 42 }, DEFAULT_SETTINGS)
  check('a valid path is kept', s.root === 'C:\\Pics', `root ${s.root}`)
  check('an unknown key is dropped', !('somethingElse' in s), Object.keys(s).join(','))

  // The patch path is a separate function, so it is checked separately.
  let p = applyPatch(DEFAULT_SETTINGS, { rowHeight: 0 })
  check('a patch of zero is clamped', p.rowHeight === 64, `rowHeight ${p.rowHeight}`)
  p = applyPatch(DEFAULT_SETTINGS, { slideIntervalMs: 10 })
  check('an unusably fast slideshow is clamped', p.slideIntervalMs === 500, `slideIntervalMs ${p.slideIntervalMs}`)
  p = applyPatch(DEFAULT_SETTINGS, { enableMcp: false })
  check('the MCP switch can be turned off', p.enableMcp === false, `enableMcp ${p.enableMcp}`)
  p = applyPatch(DEFAULT_SETTINGS, { enableMcp: true })
  check('the MCP switch can be turned back on', p.enableMcp === true, `enableMcp ${p.enableMcp}`)

  // An unrelated setting must not be disturbed by a patch that does not mention it.
  p = applyPatch(DEFAULT_SETTINGS, { rowHeight: 240 })
  check('a patch leaves other settings alone', p.theme === DEFAULT_SETTINGS.theme && p.enableMcp === DEFAULT_SETTINGS.enableMcp, JSON.stringify(p))
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
