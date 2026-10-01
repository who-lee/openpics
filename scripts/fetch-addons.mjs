#!/usr/bin/env node
/**
 * Fetches the FFmpeg binaries OpenPics bundles.
 *
 * Run by `npm run addons`, and automatically before `npm run package`. The two
 * executables are about 200 MB between them, which is why they are fetched here
 * rather than committed: a repository that carries them cannot be cloned, and the
 * same bytes are available from the vendor with a published checksum.
 *
 * What this script will not do is take a URL from an argument. The source is a
 * constant below, and the archive's SHA-256 is pinned. That is the whole point:
 * a build step that downloads whatever it is handed is how a compromised mirror
 * ends up executing inside everyone's app at install time. To move to a newer
 * FFmpeg, edit SOURCE and SHA256 in this file in one commit, so the change is
 * reviewable, and note that FFmpeg's own licence travels with the binaries.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'vendor', 'addons')
const CACHE = join(ROOT, 'vendor', '.cache')

/**
 * BtbN's `win64-lgpl` build of FFmpeg n9.0.
 *
 * LGPL is the whole reason for this project's choice of vendor. OpenPics is
 * Apache-2.0, and FFmpeg is used as a separate executable that the app shells out
 * to, so an LGPL build keeps the app under its own licence. Gyan's builds - the
 * more commonly linked ones - are all GPLv3, which would put GPL obligations on
 * the distributed app as a whole. BtbN publishes an LGPL line, so that is what we
 * take.
 *
 * The n9.0 branch is used rather than `master` so the pin moves when the release
 * line is rebuilt (deliberately, in one reviewable commit) instead of every day.
 * An LGPL build cannot *encode* with libx264 or libx265, so the accurate-edit
 * path uses OpenH264 (H.264) and Kvazaar (H.265) instead; see core/video/edit.ts
 * for why those two and not the MediaFoundation encoders.
 */
const SOURCE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-9.0.zip'
const SHA256 = process.env.OPENPICS_FFMPEG_SHA256 ??
  '4a2a9d422e326b879e3d9443837252c29931f0dd31074ecb9a090f2961f4387a'

/**
 * The FFmpeg source the pinned binaries were built from. LGPL section 4 lets a
 * recipient replace the library by rebuilding it, so the app has to say where the
 * matching source is; a version number alone is not enough.
 *
 * BtbN publishes the `n9.0-latest` archive from a rolling release branch, not from
 * a tag, so the archive name is not a source reference. The binaries here report
 * `n9.0.2-22-g46d8f462ee`, i.e. 22 commits past the n9.0.2 tag, which makes that
 * commit - not n9.0, and not even n9.0.2 - the source that reproduces these bits.
 * It is recorded in full here because a short sha is not something a recipient
 * can fetch.
 */
const SOURCE_INFO = {
  version: 'n9.0.2-22-g46d8f462ee',
  repository: 'https://github.com/FFmpeg/FFmpeg',
  commit: '46d8f462eeb87ee1f704d8c44a0ee24fca471ad1',
  commitUrl:
    'https://github.com/FFmpeg/FFmpeg/commit/46d8f462eeb87ee1f704d8c44a0ee24fca471ad1',
  branch: 'release/9.0'
}

/** Only these are taken out of the archive; everything else is discarded. */
const WANTED = ['ffmpeg.exe', 'ffprobe.exe']

function log(...parts) {
  console.log('[addons]', ...parts)
}

function run(bin, args) {
  return new Promise((done, fail) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error(`${bin} failed: ${String(stderr || stdout || err.message).trim()}`))
      else done(String(stdout ?? ''))
    })
  })
}

function sha256(file) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
  })
}

async function download(url, target) {
  log('downloading', url)

  // The archive is ~160 MB and the connection is not always reliable enough to
  // finish it in one shot - a partial download that throws everything away means
  // starting from zero, which is how a release build ends up failing on the
  // build machine with no obvious cause. So: resume from whatever is already on
  // disk, and retry a few times. Both are safe because the checksum is verified
  // before a single byte is unpacked; a corrupt resume fails there, loudly.
  const ATTEMPTS = 4

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      let have = 0
      try {
        have = existsSync(target) ? statSync(target).size : 0
      } catch {
        have = 0
      }

      // A server that ignores Range answers 200 with the whole body. Writing that
      // onto the partial file would interleave two copies, so the partial file is
      // discarded and the download restarts cleanly instead.
      const headers = have > 0 ? { Range: `bytes=${have}-` } : {}
      const response = await fetch(url, { redirect: 'follow', headers })
      if (!response.ok || !response.body) {
        throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`)
      }

      const resumed = response.status === 206 && have > 0
      if (have > 0 && !resumed) {
        log('server ignored the resume request, starting over')
        rmSync(target, { force: true })
      }

      mkdirSync(dirname(target), { recursive: true })
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(target, resumed ? { flags: 'a' } : { flags: 'w' })
      )

      const mb = (statSync(target).size / 1024 / 1024).toFixed(1)
      log(`downloaded ${mb} MB${resumed ? ' (resumed)' : ''}`)
      return
    } catch (err) {
      const kept = existsSync(target) ? statSync(target).size : 0
      if (attempt === ATTEMPTS) throw err
      log(`attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)})`)
      log(`retrying from ${(kept / 1024 / 1024).toFixed(1)} MB`)
    }
  }
}

/**
 * Unpacks the archive with whatever the machine already has.
 *
 * Windows 10 and later ship bsdtar as `tar`, which reads zip files, and so do
 * macOS and most Linux images - so that is tried first. PowerShell's
 * Expand-Archive is the fallback for a Windows box where tar is missing or has
 * been shadowed. Neither path adds a dependency, and neither can be tricked into
 * extracting outside `target` because the paths come from the archive we just
 * checksummed, not from anything a caller supplied.
 */
async function unzip(archive, target) {
  mkdirSync(target, { recursive: true })
  try {
    await run('tar', ['-xf', archive, '-C', target])
    return 'tar'
  } catch (tarError) {
    if (process.platform !== 'win32') throw tarError
    log('tar could not read the archive, falling back to PowerShell')
    await run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`
    ])
    return 'powershell'
  }
}

/** Finds a file by name anywhere in the tree the archive unpacked into. */
function findBinary(dir, name) {
  const wanted = name.toLowerCase()
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        // The archive nests everything under bin/, so skipping a directory
        // called bin would skip both binaries.
        stack.push(full)
      } else if (entry.name.toLowerCase() === wanted) {
        return full
      }
    }
  }
  return null
}

/**
 * Records which archive produced the binaries now sitting in vendor/addons.
 *
 * Without this, "the binaries already exist" is the only check, and changing the
 * pinned URL or checksum leaves the *old* binaries in place - so a switch from a
 * GPL build to an LGPL one would appear to work while the GPL files kept shipping.
 * A licence change that only changes the bytes on disk is exactly the kind of
 * mistake nobody notices until it is too late, so the stamp is compared against
 * the current pin every run.
 */
function stampPath() {
  return join(DEST, 'FFMPEG-BUILD.txt')
}

/**
 * The machine-readable half of the stamp, or null when it is absent.
 *
 * Read back up to the blank line rather than compared whole, because the file
 * also carries the human-readable LGPL notice below that line. Comparing the
 * whole file against `expectedStamp()` could never succeed: the notice is
 * always there, so the equality was always false and every single run refetched
 * the archive.
 */
function readStamp() {
  try {
    return readFileSync(stampPath(), 'utf8').split('\n\n')[0] ?? null
  } catch {
    return null
  }
}

function expectedStamp() {
  return [
    `url: ${SOURCE}`,
    `sha256: ${SHA256}`,
    `version: ${SOURCE_INFO.version}`,
    `source: ${SOURCE_INFO.commitUrl}`
  ].join('\n')
}

async function main() {
  const already = WANTED.filter((name) => existsSync(join(DEST, name)))
  const want = expectedStamp()
  if (already.length === WANTED.length && readStamp() === want) {
    log(`already present in vendor/addons (${already.join(', ')}); nothing to do`)
    return
  }
  if (already.length === WANTED.length) {
    log('the installed binaries were built from a different source; refetching')
    rmSync(DEST, { recursive: true, force: true })
  }

  mkdirSync(CACHE, { recursive: true })
  const archive = join(CACHE, SOURCE.split('/').pop())

  if (existsSync(archive)) {
    const sum = await sha256(archive)
    if (sum !== SHA256) {
      // A cached archive that no longer matches is worse than no cache: it would
      // be extracted as though it were the pinned build.
      log('cached archive does not match the pinned checksum, refetching')
      rmSync(archive, { force: true })
    }
  }
  if (!existsSync(archive)) await download(SOURCE, archive)

  const sum = await sha256(archive)
  if (sum !== SHA256) {
    throw new Error(
      `checksum mismatch for ${SOURCE}\n  expected ${SHA256}\n  got      ${sum}\n` +
        'Refusing to use this archive. If FFmpeg has released a newer build, update SOURCE and SHA256 ' +
        'in scripts/fetch-addons.mjs, or set OPENPICS_FFMPEG_SHA256 for a one-off.'
    )
  }
  log('checksum verified')

  const staged = join(CACHE, 'unpacked')
  rmSync(staged, { recursive: true, force: true })
  const used = await unzip(archive, staged)

  const found = []
  mkdirSync(DEST, { recursive: true })
  for (const name of WANTED) {
    const path = findBinary(staged, name)
    if (!path) throw new Error(`${name} was not in the archive`)
    copyFileSync(path, join(DEST, name))
    found.push(name)
  }

  // The licence travels with the binaries. Shipping FFmpeg without the text that
  // says what it is licensed under would be the worst kind of oversight for a
  // project that took care to licence its own code, so this step is a hard
  // failure rather than a best effort: an archive that cannot supply the licence
  // is not one to ship.
  let licenceCopied = false
  for (const licence of ['LICENSE.txt', 'LICENSE', 'COPYING.LGPLv3', 'LICENSE.md']) {
    const path = findBinary(staged, licence)
    if (path) {
      copyFileSync(path, join(DEST, 'FFMPEG-LICENSE.txt'))
      log(`copied ${licence} as FFMPEG-LICENSE.txt`)
      licenceCopied = true
      break
    }
  }
  if (!licenceCopied) {
    throw new Error(
      'the archive contained no licence text. Refusing to install FFmpeg binaries whose licence ' +
        'cannot be shipped alongside them.'
    )
  }

  // LGPL section 4 lets someone receiving the binaries rebuild and replace them,
  // which means the app has to point at the matching source rather than only
  // naming a version. The unpinned "latest" tag is what makes this file worth
  // writing: it is the record of what was actually fetched.
  writeFileSync(
    stampPath(),
    `${want}\n\n` +
      'These binaries are FFmpeg, built by BtbN for Windows, licensed under the LGPL.\n' +
      'They are distributed unmodified and are executed as a separate process.\n\n' +
      `Corresponding source: ${SOURCE_INFO.repository}\n` +
      `  commit ${SOURCE_INFO.commit} (branch ${SOURCE_INFO.branch})\n` +
      `  ${SOURCE_INFO.commitUrl}\n\n` +
      'Recipients may rebuild and replace these binaries with their own build of\n' +
      'that source. Nothing here restricts reverse engineering for that purpose.\n',
    'utf8'
  )

  rmSync(staged, { recursive: true, force: true })
  const mb = WANTED.reduce((total, n) => total + statSync(join(DEST, n)).size, 0) / 1024 / 1024
  log(`installed ${found.join(', ')} into vendor/addons (${mb.toFixed(1)} MB, unpacked with ${used})`)
}

main().catch((err) => {
  console.error(`[addons] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})