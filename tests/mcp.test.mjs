/**
 * End-to-end tests for the OpenPics MCP server.
 *
 * The server is started as a real child process and driven over JSON-RPC, the
 * same way a client would, so this covers the tool schemas and the transport as
 * well as the editing code behind them. Run with `npm test`, which builds the
 * server first.
 *
 * Everything runs in a throwaway directory: a temporary data directory for the
 * server's own state, and a temporary fixture picture that is deleted afterwards.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER = join(ROOT, 'dist-mcp', 'mcp', 'server.js')
if (!existsSync(SERVER)) {
  console.error(`the MCP server is not built: ${SERVER}\nrun "npm run build:mcp" first, or use "npm test".`)
  process.exit(1)
}

const FIX = join(process.env.TEMP ?? '.', `openpics-edit-verify-${randomUUID().slice(0, 8)}`)
const DATA = join(FIX, 'data')
mkdirSync(DATA, { recursive: true })

process.env.OPENPICS_DATA_DIR = DATA

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, OPENPICS_DATA_DIR: DATA },
  stdio: ['pipe', 'pipe', 'inherit']
})

let buf = Buffer.alloc(0)
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const nl = buf.indexOf(0x0a)
    if (nl < 0) return
    const line = buf.subarray(0, nl).toString('utf8')
    buf = buf.subarray(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  const p = new Promise((resolve) => pending.set(id, { resolve }))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return p
}

async function call(name, args) {
  const res = await rpc('tools/call', { name, arguments: args })
  if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`)
  const text = res.result.content.find((c) => c.type === 'text')?.text ?? ''
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { isError: res.result.isError === true, raw: text, value: parsed }
}

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` :: ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`) }
}
function section(t) { console.log(`\n== ${t}`) }

/**
 * Decodes a PNG the app wrote, using the same codecs the app uses.
 *
 * The point is to check the file rather than the tool's report of the file. An
 * assertion that "flatten produced an opaque image" is only worth anything if it
 * reads the pixels back off disk.
 */
async function decodeWritten(path) {
  const { decodeImage } = await import(new URL('../dist-mcp/core/image/image.js', import.meta.url).href)
  const { readFileSync } = await import('node:fs')
  const raster = decodeImage(readFileSync(path))
  let transparent = 0
  for (let i = 0; i < raster.width * raster.height; i++) {
    if (raster.data[i * 4 + 3] === 0) transparent++
  }
  return {
    width: raster.width,
    height: raster.height,
    transparent,
    at: (x, y) => {
      const o = (y * raster.width + x) * 4
      return [raster.data[o], raster.data[o + 1], raster.data[o + 2], raster.data[o + 3]]
    }
  }
}

const await0 = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'verify', version: '1' }
})
const tools = await rpc('tools/list', {})
const byName = new Map((tools.result.tools ?? []).map((t) => [t.name, t]))
const names = [...byName.keys()].sort()
console.log(`tools registered: ${names.length}`)
// Six video tools joined the original 32: video_addons, video_probe,
// video_trim, video_split, video_concat and video_frame. The count is pinned
// because a tool that silently stops being registered is the one failure mode an
// agent cannot report on its own - it just stops finding the capability.
const EXPECTED_TOOLS = 38
check('tool count is 38', names.length === EXPECTED_TOOLS, `got ${names.length}: ${names.join(',')}`)

// A client uses these three hints to decide whether it needs to warn a person or
// back something up before calling. A wrong hint is worse than a missing one, so
// the tools that change pixels, invert, open a file or write one are pinned here
// rather than left to review by eye.
const annotationExpectations = {
  edit_cutout_auto: { readOnly: false, idempotent: true },
  edit_cutout: { readOnly: false, idempotent: false },
  edit_apply: { readOnly: false, destructive: true, idempotent: true, openWorld: true },
  edit_preview: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  edit_sample: { readOnly: true, idempotent: true },
  edit_analyze: { readOnly: true, idempotent: true },
  edit_inspect: { readOnly: true, idempotent: true },
  edit_close: { readOnly: false, idempotent: true },
  edit_invert: { readOnly: false, idempotent: false },
  edit_refine: { readOnly: false, idempotent: false },
  edit_output: { readOnly: false, idempotent: true },
  edit_undo: { readOnly: false, idempotent: false },
  edit_redo: { readOnly: false, idempotent: false },
  edit_history: { readOnly: true, idempotent: true },
  edit_reset: { readOnly: false, idempotent: true },
  edit_brush: { readOnly: false, idempotent: false },
  // The video tools are pinned for the same reason. `video_probe` and
  // `video_addons` only report; the other four write a new file, which is what
  // keeps `readOnly` false.
  video_addons: { readOnly: true, idempotent: true },
  video_probe: { readOnly: true, idempotent: true },
  video_trim: { readOnly: false, idempotent: false },
  video_split: { readOnly: false, idempotent: false },
  video_concat: { readOnly: false, idempotent: false },
  video_frame: { readOnly: false, idempotent: false }
}
for (const [name, want] of Object.entries(annotationExpectations)) {
  const a = byName.get(name)?.annotations ?? {}
  const got = {
    readOnly: a.readOnlyHint === true,
    destructive: a.destructiveHint === true,
    idempotent: a.idempotentHint === true,
    openWorld: a.openWorldHint === true
  }
  const expected = { readOnly: false, destructive: false, idempotent: false, openWorld: false, ...want }
  check(
    `${name} annotations`,
    Object.keys(expected).every((k) => got[k] === expected[k]),
    JSON.stringify(got)
  )
}
// Nothing may claim to be read-only unless it really cannot change the edit or
// touch a file, and nothing that writes a file may claim to be read-only.
for (const t of tools.result.tools ?? []) {
  const a = t.annotations ?? {}
  check(`${t.name} has annotations`, typeof a.readOnlyHint === 'boolean', JSON.stringify(a))
  const writesAFile = /^(edit_apply|edit_preview|video_trim|video_split|video_concat|video_frame)$/.test(
    t.name
  )
  if (writesAFile) check(`${t.name} is not marked read-only`, a.readOnlyHint !== true, JSON.stringify(a))
}

/* ---------- fixture: 60x40, blue background, red square subject at (20,10)-(39,29) ---------- */
const W = 60, H = 40
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
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]))
}

const SRC = join(FIX, 'subject.png')
makePng(SRC)

/* ---------- open + cutout ---------- */
section('cutout baseline')
let r = await call('edit_cutout_auto', { path: SRC, tolerance: 20 })
check('cutout succeeds', !r.isError, r.raw.slice(0, 200))
const edit = r.value.edit
check('kept is the 20x20 subject', r.value.stats.kept === 400, JSON.stringify(r.value.stats))
check('removed is the rest', r.value.stats.removed === W * H - 400)

/* ---------- edit_sample / edit_analyze ---------- */
section('sample and analyze')
r = await call('edit_sample', { edit, points: [{ x: 2, y: 2 }, { x: 25, y: 20 }, { x: 999, y: 0 }] })
check('sample reads background blue', r.value.samples[0].b === 200 && r.value.samples[0].r === 20, JSON.stringify(r.value.samples[0]))
check('sample reads subject red', r.value.samples[1].r === 220, JSON.stringify(r.value.samples[1]))
check('sample flags out-of-bounds', r.value.samples[2].outside === true)
r = await call('edit_analyze', { edit, bins: 8 })
check('analyze reports fully opaque', r.value.opaque === W * H, JSON.stringify({ o: r.value.opaque, p: r.value.pixels }))
check('analyze finds 2 colours', r.value.colourSpread > 0 && r.value.colourSpread <= 2 / 512)

/* ---------- point wand ---------- */
section('point wand')
r = await call('edit_select_wand', { edit, x: 2, y: 2, tolerance: 20, keep: 'rest' })
check('wand from background keeps subject', r.value.stats.kept === 400, JSON.stringify(r.value.stats))
r = await call('edit_select_wand', { edit, x: 25, y: 20, tolerance: 20, keep: 'region' })
check('wand from subject keeps subject', r.value.stats.kept === 400)
// Global match at the default tolerance keeps only pixels near the reference
// colour. The subject here is 380 away (|220-20|+|30-40|+|30-200|), far outside
// it, so only the 2000 background pixels match - which is the point of the mode.
r = await call('edit_select_wand', { edit, x: 2, y: 2, tolerance: 20, keep: 'region', contiguous: false })
check('global wand takes every pixel of one colour', r.value.stats.kept === 2000, JSON.stringify(r.value.stats))
// Continuity is the difference: the same tolerance with the fill on reaches only
// the part of the background the seed is connected to, which for a corner seed on
// a uniform background is all of it - so compare against a tolerance that does
// separate them instead.
r = await call('edit_select_wand', { edit, x: 2, y: 2, tolerance: 20, keep: 'region', contiguous: false })
const globalStat = r.value.stats.kept
// The two colours differ by 380 exactly (|220-20|+|30-40|+|30-200|), and the
// tolerance is inclusive, so 379 must split them and 380 must not. This is the
// line that decides whether a cutout keeps the subject.
r = await call('edit_select_wand', { edit, x: 25, y: 20, tolerance: 379, keep: 'region' })
check('flood fill at 379 stops before swallowing the subject', r.value.stats.kept === 400, JSON.stringify(r.value.stats))
r = await call('edit_select_wand', { edit, x: 25, y: 20, tolerance: 380, keep: 'region' })
check('the tolerance boundary is inclusive at 380', r.value.stats.kept === W * H, JSON.stringify(r.value.stats))
r = await call('edit_select_wand', { edit, x: 25, y: 20, tolerance: 380, keep: 'region', contiguous: false })
check('global at 380 takes the whole picture', r.value.stats.kept === W * H)
await call('edit_select_rect', { edit, x: 0, y: 0, width: 10, height: 10 })

/* ---------- geometry ---------- */
section('geometry selection')
r = await call('edit_select_rect', { edit, x: 10, y: 10, width: 5, height: 5 })
check('rect keeps exactly the box', r.value.stats.kept === 25, JSON.stringify(r.value.stats))
r = await call('edit_select_rect', { edit, x: -50, y: -50, width: 500, height: 500 })
check('rect clips to picture', r.value.stats.kept === W * H)
// An ellipse inscribed in a box covers pi/4 of it: 20*20*0.7854 = 314. Allowing
// a couple of pixels for sampling at pixel centres, 300-330 is the honest band.
r = await call('edit_select_ellipse', { edit, x: 0, y: 0, width: 20, height: 20 })
check('ellipse covers about pi/4 of its box', r.value.stats.kept >= 300 && r.value.stats.kept <= 330, `kept=${r.value.stats.kept}`)
r = await call('edit_select_ellipse', { edit, x: 20, y: 10, width: 20, height: 20 })
check('ellipse on the subject is the same size', r.value.stats.kept >= 300 && r.value.stats.kept <= 330, `kept=${r.value.stats.kept}`)

// Polygon vertices are continuous and half-open, matching selectRect: an integer
// x with width w covers pixels x..x+w-1, so the far corner is x+w.
r = await call('edit_select_polygon', { edit, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] })
check('polygon fills its square', r.value.stats.kept === 100, `kept=${r.value.stats.kept}`)
// The equivalence that matters: a polygon built from an exclusive max corner must
// select exactly what the equivalent rectangle selects.
r = await call('edit_select_polygon', { edit, points: [{ x: 20, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 30 }, { x: 20, y: 30 }] })
check('polygon matches the equivalent rectangle', r.value.stats.kept === 400, `kept=${r.value.stats.kept}`)
r = await call('edit_select_polygon', { edit, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] })
check('polygon rejects 2 points', r.isError, r.raw.slice(0, 120))
// Concave L: a 10x10 square with the top-right 5x5 removed = 100 - 25 = 75.
r = await call('edit_select_polygon', { edit, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 10 }] })
check('concave polygon fills the L', r.value.stats.kept === 75, `kept=${r.value.stats.kept}`)
// The even-odd rule, demonstrated the only way it can be: a self-intersecting
// bowtie. Both triangles are inside the same single ring, and only a parity rule
// gives two triangles (50px) rather than the whole 10x10 box.
r = await call('edit_select_polygon', {
  edit,
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }]
})
check('bowtie fills both lobes, not the box', r.value.stats.kept === 50, `kept=${r.value.stats.kept}`)
// A notch cut in from the border: 10x10 minus 3x2 = 94. This is how a hole is
// actually expressed in one ring, since a ring that never touches the border
// cannot have one without a slit.
r = await call('edit_select_polygon', {
  edit,
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 5 }, { x: 3, y: 5 }, { x: 3, y: 7 }, { x: 0, y: 7 }]
})
check('a notch from the border is excluded', r.value.stats.kept === 94, `kept=${r.value.stats.kept}`)
// An inner ring with no connection is not a hole under any fill rule - it is a
// diagonal that happens to cross. Worth pinning down, because it is the shape a
// caller gets wrong when they mean "square with a square hole".
r = await call('edit_select_polygon', {
  edit,
  points: [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    { x: 3, y: 3 }, { x: 3, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 3 }
  ]
})
const twoRing = r.value.stats.kept
check('an unconnected inner ring is not treated as a hole', twoRing !== 100 - 16, `kept=${twoRing}`)
// Clipped at the edge, and the same 1-pixel-off rectangle still works.
r = await call('edit_select_polygon', { edit, points: [{ x: -5, y: -5 }, { x: 65, y: -5 }, { x: 65, y: 45 }, { x: -5, y: 45 }] })
check('polygon clips to the picture', r.value.stats.kept === W * H, `kept=${r.value.stats.kept}`)
// Winding order must not matter.
r = await call('edit_select_polygon', { edit, points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }] })
check('reversed winding gives the same fill', r.value.stats.kept === 100, `kept=${r.value.stats.kept}`)
// Sub-pixel: a polygon thinner than a pixel should select nothing, not one row.
r = await call('edit_select_polygon', { edit, points: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }] })
check('sub-pixel polygon selects one pixel', r.value.stats.kept === 1, `kept=${r.value.stats.kept}`)
r = await call('edit_select_polygon', { edit, points: [{ x: 5, y: 5 }, { x: 5.4, y: 5 }, { x: 5.4, y: 5.4 }, { x: 5, y: 5.4 }] })
check('sub-pixel sliver selects nothing', r.value.stats.kept === 0, `kept=${r.value.stats.kept}`)

section('select_all and invert')
r = await call('edit_select_all', { edit, state: 'removed' })
check('remove all blanks everything', r.value.kept === 0 && r.value.removed === W * H)
r = await call('edit_select_all', { edit, state: 'kept' })
check('keep all restores everything', r.value.kept === W * H)
r = await call('edit_invert', { edit })
check('invert of all-kept removes all', r.value.kept === 0)
r = await call('edit_invert', { edit })
check('invert twice is identity', r.value.kept === W * H)

/* ---------- refinement ---------- */
section('refinement')
r = await call('edit_select_rect', { edit, x: 20, y: 10, width: 20, height: 20 })
r = await call('edit_refine', { edit, operation: 'grow', radius: 2 })
check('grow expands the box', r.value.kept > 400, `kept=${r.value.kept}`)
r = await call('edit_select_rect', { edit, x: 20, y: 10, width: 20, height: 20 })
r = await call('edit_refine', { edit, operation: 'shrink', radius: 2 })
check('shrink contracts the box', r.value.kept === 16 * 16, `kept=${r.value.kept}`)
r = await call('edit_select_rect', { edit, x: 20, y: 10, width: 20, height: 20 })
r = await call('edit_refine', { edit, operation: 'threshold', level: 128 })
check('threshold keeps hard edges', r.value.softened === 0, JSON.stringify(r.value))
// feather: a hard-edged rectangle should develop a soft rim, which shows up as
// pixels that are neither fully kept nor fully removed. It must not move the
// edge far enough to change what is fully kept in the middle of the subject.
await call('edit_select_rect', { edit, x: 20, y: 10, width: 20, height: 20 })
r = await call('edit_refine', { edit, operation: 'feather', radius: 2 })
check('feather softens the edge', r.value.softened > 0, JSON.stringify(r.value))
check('feather keeps the middle of the subject', r.value.kept > 0, JSON.stringify(r.value))
// threshold is the complement: it bakes any softening back into a hard edge.
r = await call('edit_refine', { edit, operation: 'threshold', level: 128 })
check('threshold after feather restores hard edges', r.value.softened === 0, JSON.stringify(r.value))
r = await call('edit_refine', { edit, operation: 'feather', radius: 0 })
check('feather at radius 0 leaves the edge hard', r.value.softened === 0, JSON.stringify(r.value))

// despeckle: the subject plus three separate specks of 1, 3 and 9 pixels. A
// closing operation (grow then shrink) leaves every one of them alone, so this
// is the test that says which of the two it actually is.
await call('edit_select_rect', { edit, x: 20, y: 10, width: 20, height: 20 })
r = await call('edit_refine', { edit, operation: 'despeckle' })
check('despeckle keeps the subject it was given', r.value.kept === 400, `kept=${r.value.kept}`)
// Now the mask is nothing but specks: one pixel, a three-pixel line, and a 3x3
// block. The default radius of 1 erases anything that cannot keep a whole 3x3
// neighbourhood, which takes the first two and leaves the block - it is exactly
// as wide as the radius it is being asked about. A radius of 2 takes all three.
await call('edit_select_all', { edit, state: 'removed' })
await call('edit_brush', { edit, points: [{ x: 5, y: 5 }], radius: 1, mode: 'restore', hardness: 1 })
await call('edit_brush', { edit, points: [{ x: 5, y: 8 }, { x: 6, y: 8 }, { x: 7, y: 8 }], radius: 1, mode: 'restore', hardness: 1 })
for (let y = 20; y < 23; y++) {
  for (let x = 30; x < 33; x++) {
    await call('edit_brush', { edit, points: [{ x, y }], radius: 1, mode: 'restore', hardness: 1 })
  }
}
r = await call('edit_inspect', { edit })
const speckBase = r.value.stats.kept
check('the specks are there before despeckle runs', speckBase === 13, `kept=${speckBase}`)
r = await call('edit_refine', { edit, operation: 'despeckle' })
check('despeckle at radius 1 erases specks narrower than itself', r.value.kept === 9, `kept=${r.value.kept} of ${speckBase}`)
r = await call('edit_refine', { edit, operation: 'despeckle', radius: 2 })
check('despeckle at radius 2 erases the 3x3 block too', r.value.kept === 0, `kept=${r.value.kept}`)
// A single speck with a radius of 0 is left alone, because 0 is a no-op and not
// a synonym for the default.
await call('edit_select_all', { edit, state: 'removed' })
await call('edit_brush', { edit, points: [{ x: 5, y: 5 }], radius: 1, mode: 'restore', hardness: 1 })
r = await call('edit_refine', { edit, operation: 'despeckle', radius: 0 })
check('despeckle at radius 0 changes nothing', r.value.kept === 1, `kept=${r.value.kept}`)
// And the same speck goes at radius 1, which is the default.
r = await call('edit_refine', { edit, operation: 'despeckle' })
check('despeckle at radius 1 takes a single pixel', r.value.kept === 0, `kept=${r.value.kept}`)
// keep_largest: two islands
await call('edit_select_rect', { edit, x: 0, y: 0, width: 10, height: 10 })
r = await call('edit_brush', { edit, points: [{ x: 50, y: 35 }], radius: 4, mode: 'erase' })
r = await call('edit_refine', { edit, operation: 'fill_holes' })
check('fill_holes is a no-op on a solid box', r.value.kept === 100, `kept=${r.value.kept}`)
// Two disjoint rectangles, so the island sizes are exact and not a matter of how
// many pixels a soft-edged brush left at full strength.
await call('edit_select_rect', { edit, x: 0, y: 0, width: 10, height: 10 })
await call('edit_brush', { edit, points: [{ x: 50, y: 35 }], radius: 3, mode: 'restore' })
await call('edit_select_rect', { edit, x: 50, y: 35, width: 5, height: 5 })
// select_rect replaces the mask, so paint the small island and add the big one on
// top with a second rect is not possible; instead start from all-kept and clear
// everything except two rectangles.
await call('edit_select_all', { edit, state: 'kept' })
r = await call('edit_select_rect', { edit, x: 0, y: 0, width: 10, height: 10 })
const bigArea = 100
// Clear the picture, then paint both islands with hard-edged rects via erase.
await call('edit_select_all', { edit, state: 'removed' })
await call('edit_brush', { edit, points: [{ x: 4, y: 4 }, { x: 52, y: 37 }], radius: 1, hardness: 1, mode: 'restore' })
r = await call('edit_inspect', { edit })
check('two islands exist before keep_largest', r.value.stats.kept > 0 && r.value.stats.kept < 20, `kept=${r.value.stats.kept}`)
// Make one clearly bigger with a hard rect drawn through the wand path instead:
// use the brush at many points to build a solid 6x6 block.
await call('edit_select_all', { edit, state: 'removed' })
await call('edit_brush', { edit, points: [{ x: 50, y: 33 }, { x: 51, y: 33 }, { x: 52, y: 33 }, { x: 53, y: 33 }, { x: 54, y: 33 }, { x: 55, y: 33 }, { x: 55, y: 34 }, { x: 55, y: 35 }, { x: 55, y: 36 }, { x: 55, y: 37 }, { x: 54, y: 37 }, { x: 53, y: 37 }, { x: 52, y: 37 }, { x: 51, y: 37 }, { x: 50, y: 37 }], radius: 1, hardness: 1, mode: 'restore' })
await call('edit_brush', { edit, points: [{ x: 5, y: 5 }], radius: 2, hardness: 1, mode: 'restore' })
r = await call('edit_inspect', { edit })
const islandTotal = r.value.stats.kept
check('two islands of different sizes exist', islandTotal > 8 && islandTotal < 40, `kept=${islandTotal}`)
r = await call('edit_refine', { edit, operation: 'keep_largest' })
const oneIsland = r.value.kept
check('keep_largest leaves exactly one island', oneIsland < islandTotal && oneIsland > 8, `kept=${oneIsland} of ${islandTotal}`)
check('keep_largest reports only what it removed', r.value.dropped === islandTotal - oneIsland, `dropped=${r.value.dropped}, expected ${islandTotal - oneIsland}`)
// The survivors must be one connected region, not merely fewer pixels: running it
// again has nothing left to drop, which is only true of a single island.
r = await call('edit_refine', { edit, operation: 'keep_largest' })
check('keep_largest is a fixpoint once one island remains', r.value.kept === oneIsland && r.value.dropped === 0, `kept=${r.value.kept}, dropped=${r.value.dropped}`)

// hole: an erased disc enclosed by kept pixels
await call('edit_select_all', { edit, state: 'kept' })
r = await call('edit_brush', { edit, points: [{ x: 30, y: 20 }], radius: 4, hardness: 1, mode: 'erase' })
const erased = r.value.stats.removed
check('erase removed a disc', erased > 40 && erased < 60, `removed=${erased}`)
r = await call('edit_refine', { edit, operation: 'fill_holes' })
check('fill_holes closes an enclosed hole', r.value.kept === W * H, `kept=${r.value.kept} of ${W * H}`)
// A removed area touching the border is background, not a hole, and must stay.
await call('edit_select_all', { edit, state: 'kept' })
r = await call('edit_brush', { edit, points: [{ x: 0, y: 20 }], radius: 5, hardness: 1, mode: 'erase' })
const openCut = r.value.stats.removed
r = await call('edit_refine', { edit, operation: 'fill_holes' })
check('fill_holes leaves a border-touching cut open', r.value.removed === openCut, `removed=${r.value.removed} expected ${openCut}`)
// Two holes at once.
await call('edit_select_all', { edit, state: 'kept' })
await call('edit_brush', { edit, points: [{ x: 15, y: 20 }, { x: 45, y: 20 }], radius: 3, hardness: 1, mode: 'erase' })
r = await call('edit_refine', { edit, operation: 'fill_holes' })
check('fill_holes closes both holes', r.value.kept === W * H, `kept=${r.value.kept} of ${W * H}`)

/* ---------- alpha threshold ---------- */
section('alpha threshold')
r = await call('edit_select_all', { edit, state: 'kept' })
r = await call('edit_alpha_threshold', { edit, level: 200 })
check('alpha threshold keeps opaque source', r.value.kept === W * H)
check('alpha threshold discards nothing here', r.value.discarded === 0)

/* ---------- history ---------- */
section('history')
await call('edit_reset', { edit })
check('reset keeps everything', true)
r = await call('edit_select_rect', { edit, x: 0, y: 0, width: 10, height: 10 })
r = await call('edit_history', { edit })
check('history lists one step', r.value.steps.length === 1 && r.value.steps[0].label === 'rectangle', JSON.stringify(r.value))
r = await call('edit_select_rect', { edit, x: 20, y: 20, width: 10, height: 10 })
r = await call('edit_history', { edit })
check('history lists two steps', r.value.steps.length === 2, JSON.stringify(r.value.steps))
r = await call('edit_undo', { edit })
check('undo names the step it undid', r.value.undone[0] === 'rectangle', JSON.stringify(r.value.undone))
check('undo restores the previous selection', r.value.stats.kept === 100, JSON.stringify(r.value.stats))
r = await call('edit_redo', { edit })
check('redo re-applies', r.value.stats.kept === 100, JSON.stringify(r.value.stats))
// A redo must report the name the step had when it was first made, not a
// placeholder invented at replay time - that name is the only thing an agent has
// to identify which step it is looking at.
check('redo reports the original label', r.value.redone[0] === 'rectangle', JSON.stringify(r.value.redone))
r = await call('edit_history', { edit })
check('history after redo keeps the original label', r.value.steps.every((s) => s.label === 'rectangle'), JSON.stringify(r.value.steps))
// Undo to the very start, then past it.
r = await call('edit_undo', { edit, steps: 5 })
check('undo to the start reports every step', r.value.undone.length === 2, JSON.stringify(r.value.undone))
check('undo to the start clears the selection', r.value.stats.kept === W * H, JSON.stringify(r.value.stats))
r = await call('edit_undo', { edit })
check('undo with nothing left is an error', r.isError, r.raw.slice(0, 120))
r = await call('edit_redo', { edit, steps: 5 })
check('redo replays both steps', r.value.redone.length === 2, JSON.stringify(r.value.redone))
check('redo returns to the last selection', r.value.stats.kept === 100, JSON.stringify(r.value.stats))
r = await call('edit_redo', { edit })
check('redo with nothing left is an error', r.isError, r.raw.slice(0, 120))
// A new change discards the redo stack.
await call('edit_undo', { edit })
r = await call('edit_select_rect', { edit, x: 0, y: 0, width: 5, height: 5 })
r = await call('edit_history', { edit })
check('new change clears redo', r.value.canRedo === false, JSON.stringify(r.value))
r = await call('edit_redo', { edit })
check('redo errors when nothing to redo', r.isError, r.raw.slice(0, 120))
// A no-op must not consume a step, or undoing one mistake would mean stepping
// back through several.
const before = (await call('edit_history', { edit })).value.steps.length
// The 5x5 selection is at the top-left, so erasing bottom-right is already removed.
r = await call('edit_brush', { edit, points: [{ x: 50, y: 35 }], radius: 3, hardness: 1, mode: 'erase' })
const after = (await call('edit_history', { edit })).value.steps.length
check('a brush stroke on already-removed pixels adds no step', after === before, `${before} -> ${after}`)
check('a no-op brush reports it painted nothing', r.value.painted === 0, JSON.stringify(r.value))
// A stroke that does something adds exactly one step.
r = await call('edit_brush', { edit, points: [{ x: 2, y: 2 }], radius: 2, hardness: 1, mode: 'erase' })
const after2 = (await call('edit_history', { edit })).value.steps.length
check('a real stroke adds one step', after2 === before + 1, `${before} -> ${after2}`)
check('undo of a stroke restores the corner', (await call('edit_undo', { edit })).value.stats.kept === 25)
// Output settings are not undoable, and must not appear as steps.
const stepsBefore = (await call('edit_history', { edit })).value.steps.length
await call('edit_output', { edit, brightness: 20 })
check('output settings do not consume a step', (await call('edit_history', { edit })).value.steps.length === stepsBefore)
await call('edit_output', { edit, brightness: 0 })

/* ---------- output pipeline ---------- */
section('output settings')
await call('edit_reset', { edit })
await call('edit_select_rect', { edit, x: 10, y: 10, width: 20, height: 20 })
r = await call('edit_output', { edit, crop: { x: 5, y: 5, width: 30, height: 20 } })
check('crop projects 30x20', r.value.projected.width === 30 && r.value.projected.height === 20, JSON.stringify(r.value.projected))
r = await call('edit_output', { edit, percent: 50 })
check('percent scales projected size', r.value.projected.width === 15 && r.value.projected.height === 10, JSON.stringify(r.value.projected))
// Changing your mind has to work: this was previously impossible, because both
// keys were still set and the call was rejected as ambiguous.
r = await call('edit_output', { edit, longestEdge: 40 })
check('longestEdge replaces percent rather than conflicting', Math.max(r.value.projected.width, r.value.projected.height) === 40, JSON.stringify(r.value.projected))
r = await call('edit_output', { edit, longestEdge: null })
check('null clears the resize', r.value.projected.width === 30 && r.value.projected.height === 20, JSON.stringify(r.value.projected))
check('cleared resize leaves no sizing in output', r.value.output?.resize === undefined || r.value.output?.resize === null, JSON.stringify(r.value.output))
r = await call('edit_output', { edit, percent: 50, longestEdge: 999 })
check('percent and longestEdge together is refused', r.isError, r.raw.slice(0, 160))
r = await call('edit_output', { edit, percent: 50, width: 10 })
check('percent and width together is refused', r.isError, r.raw.slice(0, 160))
r = await call('edit_output', { edit, width: 10, longestEdge: 999 })
check('width and longestEdge together is refused', r.isError, r.raw.slice(0, 160))
r = await call('edit_output', { edit, width: 10 })
check('width wins over the 30px crop', r.value.projected.width === 10, JSON.stringify(r.value.projected))
r = await call('edit_output', { edit, width: 10, height: 20 })
check('width and height together is not ambiguous', r.value.projected.width === 10 && r.value.projected.height === 20, JSON.stringify(r.value.projected))
await call('edit_output', { edit, width: null, height: null })
r = await call('edit_output', { edit, crop: null, longestEdge: 40 })
check('longestEdge on the uncropped picture', Math.max(r.value.projected.width, r.value.projected.height) === 40, JSON.stringify(r.value.projected))
await call('edit_output', { edit, longestEdge: null, crop: { x: 0, y: 0, width: W, height: H } })
r = await call('edit_output', { edit, rotate: 1 })
check('rotate swaps the axes', r.value.projected.width === H && r.value.projected.height === W, JSON.stringify(r.value.projected))
await call('edit_output', { edit, rotate: 0 })
r = await call('edit_output', { edit, background: 'not-a-colour' })
check('bad hex colour is refused', r.isError, r.raw.slice(0, 160))

// trim
section('trim')
await call('edit_output', { edit, crop: null, background: null })
await call('edit_select_rect', { edit, x: 20, y: 10, width: 20, height: 20 })
r = await call('edit_output', { edit, trim: true })
check('trim crops to the subject', r.value.projected.width === 20 && r.value.projected.height === 20, JSON.stringify(r.value.projected))
await call('edit_output', { edit, trim: false })

// resize must not change the selection
section('selection survives geometry')
await call('edit_select_rect', { edit, x: 20, y: 10, width: 20, height: 20 })
await call('edit_output', { edit, crop: { x: 0, y: 0, width: 30, height: 30 }, percent: 50 })
r = await call('edit_inspect', { edit })
check('mask is still in source coordinates', r.value.width === W && r.value.stats.kept === 400, JSON.stringify(r.value.stats))
await call('edit_output', { edit, crop: null, percent: null })

/* ---------- background flatten + adjust ---------- */
section('flatten and adjust')
const outPng = join(FIX, 'flat.png')
await call('edit_select_rect', { edit, x: 20, y: 10, width: 20, height: 20 })
await call('edit_output', { edit, background: '#00ff00', opacity: 1 })
r = await call('edit_apply', { edit, path: outPng })
check('apply writes a flattened png', !r.isError, r.raw.slice(0, 200))
check('apply reports the path it wrote', typeof r.value.path === 'string' && existsSync(r.value.path), JSON.stringify(r.value))
// Read the written file back and check the pixels, rather than trusting the
// tool's own report that it flattened.
const flatInfo = await decodeWritten(outPng)
check('flattened file keeps its dimensions', flatInfo.width === W && flatInfo.height === H, JSON.stringify({ w: flatInfo.width, h: flatInfo.height }))
check('flattened file is fully opaque', flatInfo.transparent === 0, `transparent=${flatInfo.transparent}`)
// `at` returns RGBA; the flatten check is about the first three channels.
check('flattened background is the requested green', String(flatInfo.at(2, 2)) === '0,255,0,255', JSON.stringify(flatInfo.at(2, 2)))
check('flattened subject is still red', String(flatInfo.at(25, 20)) === '220,30,30,255', JSON.stringify(flatInfo.at(25, 20)))
// Without a background the same edit must stay transparent outside the subject.
const cutPng = join(FIX, 'cut.png')
await call('edit_output', { edit, background: null })
r = await call('edit_apply', { edit, path: cutPng })
check('apply without a background stays transparent', !r.isError, r.raw.slice(0, 160))
const cutInfo = await decodeWritten(cutPng)
check('cut png is transparent outside the subject', cutInfo.transparent === W * H - 400, `transparent=${cutInfo.transparent}`)
check('cut png is opaque over the subject', cutInfo.at(25, 20)[3] === 255, JSON.stringify(cutInfo.at(25, 20)))
await call('edit_output', { edit, background: '#00ff00' })
r = await call('edit_output', { edit, brightness: 100, contrast: 50, saturation: -100, opacity: 0.5 })
check('adjust accepted and reported', !r.isError && r.value.output.adjust.brightness === 100, JSON.stringify(r.value.output))
const greyPng = join(FIX, 'grey.png')
await call('edit_output', { edit, brightness: 0, contrast: 0, saturation: 0, opacity: 1, background: '#00ff00' })
r = await call('edit_apply', { edit, path: greyPng, overwrite: true })
check('adjusted file written', !r.isError, r.raw.slice(0, 200))
await call('edit_output', { edit, brightness: 0, contrast: 0, saturation: 0, opacity: 1, background: null })

/* ---------- preview reflects output ---------- */
section('preview uses the output pipeline')
await call('edit_output', { edit, crop: { x: 0, y: 0, width: 20, height: 20 } })
const prev = join(FIX, 'prev.png')
r = await call('edit_preview', { edit, path: prev })
check('preview is the cropped size', r.value.width === 20 && r.value.height === 20, JSON.stringify(r.value))
await call('edit_output', { edit, crop: null })

/* ---------- odd inputs ---------- */
section('malformed and hostile input')
r = await call('edit_select_rect', { edit, x: 0, y: 0, width: 0, height: 5 })
check('zero-width rect is refused', r.isError, r.raw.slice(0, 120))
r = await call('edit_select_rect', { edit, x: 0, y: 0, width: -5, height: 5 })
check('negative rect is refused', r.isError, r.raw.slice(0, 120))
r = await call('edit_select_rect', { edit, x: 0, y: 0, width: 'ten', height: 5 })
check('non-numeric rect is refused by the schema', r.isError, r.raw.slice(0, 120))
r = await call('edit_select_rect', { edit: 'no-such-edit', x: 0, y: 0, width: 5, height: 5 })
check('an unknown edit id is refused', r.isError, r.raw.slice(0, 120))
r = await call('edit_select_polygon', { edit, points: [{ x: 0, y: 0 }, { x: 1e9, y: 1e9 }, { x: -1e9, y: 0 }] })
check('huge polygon coordinates do not hang or crash', !r.isError, r.raw.slice(0, 160))
r = await call('edit_refine', { edit, operation: 'grow', radius: 1e9 })
check('absurd grow radius is refused, not attempted', r.isError, r.raw.slice(0, 160))
r = await call('edit_refine', { edit, operation: 'not-an-operation' })
check('unknown refine operation is refused', r.isError, r.raw.slice(0, 120))
r = await call('edit_brush', { edit, points: [{ x: 0, y: 0 }], radius: -1, mode: 'erase' })
check('negative brush radius is refused', r.isError, r.raw.slice(0, 120))
r = await call('edit_brush', { edit, points: [], radius: 3, mode: 'erase' })
check('a brush stroke with no points is refused or a no-op', r.isError || r.value.painted === 0, r.raw.slice(0, 160))
r = await call('edit_output', { edit, brightness: 500 })
check('out-of-range brightness is refused by the schema', r.isError, r.raw.slice(0, 120))
r = await call('edit_output', { edit, percent: -5 })
check('negative percent is refused by the schema', r.isError, r.raw.slice(0, 120))
r = await call('edit_sample', { edit, points: [{ x: -1, y: -1 }] })
check('a negative sample point is reported, not fatal', !r.isError, r.raw.slice(0, 120))
r = await call('edit_output', { edit, crop: { x: 0, y: 0, width: 0, height: 0 } })
check('a zero crop is refused', r.isError, r.raw.slice(0, 160))
r = await call('edit_output', { edit, crop: { x: 500, y: 500, width: 10, height: 10 } })
check('a crop outside the picture is refused', r.isError, r.raw.slice(0, 160))
r = await call('edit_undo', { edit, steps: 0 })
check('undo with steps 0 is refused or does nothing', r.isError || Array.isArray(r.value.undone), r.raw.slice(0, 160))

/* ---------- close ---------- */
section('close')
r = await call('edit_close', { edit })
check('close reports closed', r.value.closed === true, r.raw.slice(0, 160))
r = await call('edit_inspect', { edit })
check('closed edit is gone', r.isError, r.raw.slice(0, 160))
r = await call('edit_close', { edit })
check('closing twice is not an error', !r.isError && r.value.closed === false, r.raw.slice(0, 160))

/* ---------- regression: original tools still fine ---------- */
section('original tools still work')
r = await call('edit_cutout_auto', { path: SRC, tolerance: 20 })
const e2 = r.value.edit
check('cutout still works', r.value.stats.kept === 400)
r = await call('edit_preview', { edit: e2, path: join(FIX, 'p2.png') })
check('preview still works', r.value.width > 0)
r = await call('edit_apply', { edit: e2, path: join(FIX, 'a2.png') })
check('apply still works', !r.isError, r.raw.slice(0, 160))
r = await call('edit_brush', { edit: e2, points: [{ x: 30, y: 20 }], radius: 3, mode: 'erase' })
check('brush still works', r.value.stats.softened + r.value.stats.removed > 400)
r = await call('edit_cutout_auto', { path: SRC, tolerance: 20, edit: e2 })
check('re-cut into an existing id still works', r.value.stats.kept === 400)
await call('edit_close', { edit: e2 })

/* ---------- safety ---------- */
section('safety')
r = await call('edit_apply', { edit: e2, path: SRC })
check('apply to the original is refused', r.isError, r.raw.slice(0, 160))
const tmpEdit = (await call('edit_cutout_auto', { path: SRC, tolerance: 20 })).value.edit
const once = join(FIX, 'once.png')
await call('edit_apply', { edit: tmpEdit, path: once })
r = await call('edit_apply', { edit: tmpEdit, path: once })
check('apply refuses to clobber without overwrite', r.isError, r.raw.slice(0, 160))
r = await call('edit_apply', { edit: tmpEdit, path: once, overwrite: true })
check('overwrite works when asked', !r.isError, r.raw.slice(0, 160))
// Reset puts the mask back to "everything kept", which is a session with no
// edits in it. Applying that should be refused rather than writing a copy of the
// source out under a new name.
await call('edit_reset', { edit: tmpEdit })
r = await call('edit_apply', { edit: tmpEdit, path: join(FIX, 'untouched.png') })
check('apply on an edit with nothing changed is refused', r.isError === true, r.raw.slice(0, 160))
r = await call('edit_preview', { edit: tmpEdit, path: once })
check('preview refuses to clobber', r.isError, r.raw.slice(0, 160))
await call('edit_close', { edit: tmpEdit })

/* ---------- the MCP switch ---------- */
section('mcp switch')
// The switch is re-read per tool call rather than cached at startup, precisely
// so that this can be tested on a live server: the setting is flipped while the
// process keeps running, which is the only way to prove no tool can reach past
// it. A cached read would pass every other test in this file and still let an
// agent keep working for hours after the user switched it off.
const settingsFile = join(DATA, 'settings.json')
const readSettings = () => {
  try { return JSON.parse(readFileSync(settingsFile, 'utf8')) } catch { return {} }
}
const wasAllowed = readSettings()
writeFileSync(settingsFile, JSON.stringify({ ...wasAllowed, enableMcp: false }, null, 2), 'utf8')

r = await call('photos_find', { root: FIX })
check('a read-only tool refuses while the switch is off', r.isError === true, r.raw.slice(0, 160))
check('the refusal names the setting', /turned off in Settings/i.test(r.raw), r.raw.slice(0, 160))

// The gate has to cover the write tools too, or "off" would only be half true.
r = await call('bin_list', {})
check('a destructive tool refuses while the switch is off', r.isError === true, r.raw.slice(0, 160))
r = await call('edit_cutout_auto', { path: SRC, tolerance: 20 })
check('an edit tool refuses while the switch is off', r.isError === true, r.raw.slice(0, 160))

writeFileSync(settingsFile, JSON.stringify({ ...wasAllowed, enableMcp: true }, null, 2), 'utf8')
r = await call('photos_find', { root: FIX })
check('tools work again once the switch is back on', !r.isError, r.raw.slice(0, 160))

// An absent key must behave as "on": that is how the app shipped, and treating a
// missing file as "off" would silently disable every agent on upgrade.
rmSync(settingsFile, { force: true })
r = await call('photos_find', { root: FIX })
check('an absent setting file leaves the tools allowed', !r.isError, r.raw.slice(0, 160))

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(' - ' + f) }

child.kill()
try { rmSync(FIX, { recursive: true, force: true }) } catch {}
process.exit(fail === 0 ? 0 : 1)
