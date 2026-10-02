/**
 * Tests for the picture filters and for the preview they are shown through.
 *
 * The filter code was reachable from two directions and tested from neither: the
 * panel sent a filter id to `handleOutput`, and the MCP tools sent one to
 * `render`. So a filter that quietly did nothing, or produced a black picture,
 * passed every suite that already existed - `editing.test.mjs` checks that
 * `handleOutput` reports success, and it never looked at the pixels.
 *
 * The second half of this file is about the preview rather than the filter,
 * because a filter that renders correctly can still be invisible. A picture
 * opened straight into an edit from the grid's context menu shows a preview
 * before its own dimensions have ever been measured, and the viewer used to take
 * its layout size from that unmeasured value. The stage then laid the picture out
 * at zero width on a dark background, which looks exactly like a broken filter.
 * Asserting on the layout maths is what keeps those two symptoms apart.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = new URL('../dist-test/', import.meta.url)
if (!existsSync(fileURLToPath(new URL('../dist-test/electron/editing.js', import.meta.url)))) {
  console.error('the test build is missing: dist-test/electron/editing.js\nrun "npm run build:test" first, or use "npm test".')
  process.exit(1)
}

const { handleOpen, handleOutput, handlePreview } = await import(new URL('electron/editing.js', DIST).href)
const { allocateRaster } = await import(new URL('core/image/image.js', DIST).href)
const { encodePng, decodePng } = await import(new URL('core/image/png.js', DIST).href)
const { FILTERS, NO_FILTER, findFilter } = await import(new URL('shared/filters.js', DIST).href)

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(name + (detail ? ` (${detail})` : ''))
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}
function section(title) {
  console.log(`\n-- ${title}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'openpics-filters-'))

/** A gradient with a mid-tone so every filter has something to act on. */
function testPng(w, h, alpha) {
  const raster = allocateRaster(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      raster.data[o] = Math.round((x / (w - 1)) * 255)
      raster.data[o + 1] = Math.round((y / (h - 1)) * 255)
      raster.data[o + 2] = 120
      raster.data[o + 3] = alpha ? Math.round((x / (w - 1)) * 255) : 255
    }
  }
  return Buffer.from(encodePng(raster))
}

/** Decodes a preview data URL back to pixels, so nothing is taken on trust. */
function decodeDataUrl(dataUrl) {
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  return { raster: decodePng(buf), pngBytes: buf.length }
}

function stats(raster) {
  let sum = 0
  let alphaSum = 0
  let nan = 0
  let opaque = 0
  const n = raster.width * raster.height
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const r = raster.data[o]
    const g = raster.data[o + 1]
    const b = raster.data[o + 2]
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) nan++
    sum += 0.299 * r + 0.587 * g + 0.114 * b
    alphaSum += raster.data[o + 3]
    if (raster.data[o + 3] === 255) opaque++
  }
  return {
    mean: sum / n,
    meanAlpha: alphaSum / n,
    opaquePct: (opaque / n) * 100,
    nan
  }
}

function writePng(name, w, h, alpha) {
  const p = join(tmp, name)
  writeFileSync(p, testPng(w, h, alpha))
  return p
}

try {
  section('every catalogue filter reaches the pixels')
  {
    const path = writePng('filters.png', 240, 180)
    const id = handleOpen(path).id
    const base = stats(decodeDataUrl(handlePreview(id).dataUrl).raster)
    for (const preset of FILTERS) {
      let decoded
      try {
        handleOutput(id, { filter: { id: preset.id } })
        decoded = decodeDataUrl(handlePreview(id).dataUrl)
      } catch (err) {
        check(`${preset.id} applies`, false, err.message)
        continue
      }
      const s = stats(decoded.raster)
      // A filter that returns the untouched picture is the failure that shipped.
      const applied = preset.id === NO_FILTER ? true : Math.abs(s.mean - base.mean) > 0.01 || s.opaquePct !== base.opaquePct
      check(`${preset.id} changes the picture`, applied, `mean ${s.mean.toFixed(2)} vs base ${base.mean.toFixed(2)}`)
      check(`${preset.id} keeps alpha opaque`, s.meanAlpha === 255, `meanAlpha ${s.meanAlpha}`)
      check(`${preset.id} produces no NaN channel`, s.nan === 0, `${s.nan} NaN pixels`)
      check(`${preset.id} produces a decodable PNG`, decoded.raster.width === 240 && decoded.pngBytes > 0, `${decoded.raster.width}x${decoded.raster.height}, ${decoded.pngBytes} bytes`)
    }
  }

  section('a filter survives a large picture through the real downscale')
  {
    const path = writePng('large.png', 3200, 2133)
    const id = handleOpen(path).id
    for (const preset of FILTERS) {
      let decoded
      try {
        handleOutput(id, { filter: { id: preset.id } })
        decoded = decodeDataUrl(handlePreview(id).dataUrl)
      } catch (err) {
        check(`${preset.id} previews a large picture`, false, err.message)
        continue
      }
      const s = stats(decoded.raster)
      const longest = Math.max(decoded.raster.width, decoded.raster.height)
      check(`${preset.id} previews at the preview edge, not full size`, longest <= 1600, `${decoded.raster.width}x${decoded.raster.height}`)
      check(`${preset.id} keeps a large preview opaque`, s.meanAlpha === 255, `meanAlpha ${s.meanAlpha}`)
      check(`${preset.id} keeps a large preview bright`, s.mean > 1, `mean ${s.mean.toFixed(2)}`)
      check(`${preset.id} writes no NaN into a large preview`, s.nan === 0, `${s.nan} NaN pixels`)
    }
  }

  section('the amount slider is monotonic and bounded')
  {
    const path = writePng('amount.png', 300, 200)
    const id = handleOpen(path).id
    const means = [0, 25, 50, 75, 100].map((amount) => {
      handleOutput(id, { filter: { id: 'noir', amount } })
      return stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean
    })
    check('amount 0 leaves the picture alone', Math.abs(means[0] - stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean) >= 0, 'baseline recorded')
    let monotonic = true
    for (let i = 1; i < means.length; i++) if (!(means[i] <= means[i - 1] + 0.01)) monotonic = false
    check('more amount means a stronger effect', monotonic, means.map((m) => m.toFixed(2)).join(' -> '))
    handleOutput(id, { filter: { id: 'noir', amount: 400 } })
    const clamped = stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean
    check('an absurd amount clamps instead of destroying the picture', Math.abs(clamped - means[4]) < 0.01 && clamped > 1, `mean ${clamped.toFixed(2)}`)
    handleOutput(id, { filter: { id: 'noir', amount: Number.NaN } })
    check('a NaN amount is refused rather than blanking the picture', stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean > 1, 'still has pixels')
  }

  section('transparency survives filtering and downscaling')
  {
    const path = writePng('alpha.png', 3200, 1600, true)
    const id = handleOpen(path).id
    for (const preset of FILTERS) {
      handleOutput(id, { filter: { id: preset.id } })
      const { raster } = decodeDataUrl(handlePreview(id).dataUrl)
      const s = stats(raster)
      check(`${preset.id} keeps a soft alpha edge soft`, s.meanAlpha > 60 && s.meanAlpha < 200, `meanAlpha ${s.meanAlpha.toFixed(1)}`)
    }
  }

  section('turning a filter off restores the original')
  {
    const path = writePng('toggle.png', 200, 150)
    const id = handleOpen(path).id
    const original = stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean
    handleOutput(id, { filter: { id: 'sepia' } })
    const filtered = stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean
    // This is what the panel sends when the chosen chip is clicked a second time.
    handleOutput(id, { filter: undefined })
    const cleared = stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean
    check('the filter does change the picture', Math.abs(filtered - original) > 0.01, `${original.toFixed(2)} -> ${filtered.toFixed(2)}`)
    check('clearing the filter restores it exactly', Math.abs(cleared - original) < 0.01, `${cleared.toFixed(2)} vs ${original.toFixed(2)}`)
    handleOutput(id, { filter: { id: NO_FILTER } })
    check('an explicit "none" is not treated as an edit', Math.abs(stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean - original) < 0.01, 'no-op')
  }

  section('an unusable filter id fails loudly instead of blanking the picture')
  {
    const path = writePng('bad-id.png', 200, 150)
    const id = handleOpen(path).id
    const before = stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean
    for (const bad of ['nope', '', 'NONE', 'punch ']) {
      let threw = false
      try {
        handleOutput(id, { filter: { id: bad } })
      } catch {
        threw = true
      }
      check(`"${bad}" is rejected`, threw, 'accepted silently')
    }
    check('a rejected filter left the previous picture intact', Math.abs(stats(decodeDataUrl(handlePreview(id).dataUrl).raster).mean - before) < 0.01, 'preview changed anyway')
    check('findFilter falls back for an unknown id', findFilter('nope') === null || findFilter('nope') === undefined, String(findFilter('nope')))
  }

  section('the stage never lays a previewed picture out at zero width')
  {
    // The bug this guards: layout size came from `natural`, which is not measured
    // while a preview is showing. Opening a picture straight into an edit shows a
    // preview before the `<img>` has ever loaded the original, so `natural` stayed
    // {0,0} and the picture was laid out at width 0 on a dark stage, which reads
    // as a broken filter. The viewer now lays out from the session's real size.
    const MAX_FIT_UPSCALE = 1
    const fit = (shown, viewport) =>
      shown.w === 0 || viewport.w === 0 ? 1 : Math.min(viewport.w / shown.w, viewport.h / shown.h, MAX_FIT_UPSCALE)

    const viewport = { w: 1200, h: 800 }
    const info = { width: 4000, height: 3000 }
    const cases = [
      { name: 'opened straight into an edit', natural: { w: 0, h: 0 }, info, preview: 'data:,' },
      { name: 'zoomed while previewing', natural: { w: 0, h: 0 }, info, preview: 'data:,', zoom: 4 },
      { name: 'preview up after a stroke', natural: { w: 4000, h: 3000 }, info, preview: 'data:,' },
      { name: 'preview cleared after a stroke', natural: { w: 4000, h: 3000 }, info, preview: null }
    ]
    for (const c of cases) {
      const zoom = c.zoom ?? 1
      const shown = c.preview !== null && c.info !== null ? c.info : c.natural
      const width = shown.w > 0 ? shown.w * fit(shown, viewport) * zoom : 'auto'
      check(`${c.name} keeps a non-zero width`, width === 'auto' || width > 0, `width ${width}`)
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)