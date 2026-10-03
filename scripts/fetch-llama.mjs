#!/usr/bin/env node
/**
 * Fetches the llama.cpp Windows binary OpenPics runs its local AI on.
 *
 * Run by `npm run llama`, and automatically before `npm run package`. The zip is
 * about 19 MB, so it is fetched here rather than committed: vendor/ is not in the
 * repository, and llama.cpp publishes the same bytes with a SHA-256 on every
 * release.
 *
 * Like the other vendor scripts, this will not take a URL from an argument. The
 * release tag, asset name and SHA-256 are constants in this file, so moving to a
 * newer build is one reviewable commit rather than a build step that downloads
 * whatever it is handed. llama.cpp has no "latest stable" channel, so the tag is
 * pinned explicitly; GitHub keeps release assets addressed by tag.
 *
 * Only `llama-server.exe` and the DLLs beside it are copied into vendor/llama.
 * The archive also holds cli, bench and quantise tools the app never runs.
 */

import { createHash } from 'node:crypto'
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'vendor', 'llama')
const CACHE = join(ROOT, 'vendor', '.cache')

/**
 * llama.cpp, Windows x64, CPU-only build.
 *
 * CPU-only is the universal choice: it runs on any x64 Windows machine whether
 * or not it has a usable GPU, and a half-billion-parameter Q4 model answers in a
 * second or two without one. The CUDA and Vulkan archives are hundreds of
 * megabytes and would only work on the machines that happen to match them.
 */
const TAG = 'b11379'
const ASSET = `llama-${TAG}-bin-win-cpu-x64.zip`
const SOURCE = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${ASSET}`
const SHA256 = 'ec014c2c2a27b18786d24eba3e8650d4e68b9003ca6cf91714125b71975eb7ea'
const SIZE = 19352297

const SOURCE_INFO = {
  project: 'llama.cpp',
  build: TAG,
  repository: 'https://github.com/ggml-org/llama.cpp',
  releaseUrl: `https://github.com/ggml-org/llama.cpp/releases/tag/${TAG}`,
  licence: 'MIT',
  licenceUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/LICENSE'
}

const ZIP = join(CACHE, ASSET)
const SERVER = join(DEST, 'llama-server.exe')

function log(...parts) {
  console.log('[llama]', ...parts)
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

  const ATTEMPTS = 4

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      let have = 0
      try {
        have = existsSync(target) ? statSync(target).size : 0
      } catch {
        have = 0
      }

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

/** Extracts the runtime files from the verified zip into vendor/llama. */
function unpack(zip) {
  const stage = join(CACHE, 'llama-unpacked')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  // Windows ships bsdtar as `tar.exe`; it understands .zip. Using it avoids a
  // third-party unzip dependency for a build step that has to run on a clean
  // checkout.
  const result = spawnSync('tar', ['-xf', zip, '-C', stage], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tar exited with ${result.status}`)

  mkdirSync(DEST, { recursive: true })

  const server = join(stage, 'llama-server.exe')
  if (!existsSync(server)) throw new Error(`${ASSET} did not contain llama-server.exe`)
  cpSync(server, SERVER)

  let dlls = 0
  for (const entry of readdirSync(stage, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dll')) continue
    cpSync(join(stage, entry.name), join(DEST, entry.name))
    dlls++
  }
  if (dlls === 0) throw new Error(`${ASSET} did not contain any DLLs`)

  log(`installed llama-server.exe and ${dlls} DLLs`)
}

/**
 * Records what is on disk, the way vendor/addons records its FFmpeg stamp.
 *
 * The stamp is compared on the next run so swapping the pin actually replaces
 * the binaries instead of leaving the previous build in place.
 */
function stampPath() {
  return join(DEST, 'LLAMA-BUILD.txt')
}

function expectedStamp() {
  return `${ASSET}\nsha256 ${SHA256}\nsize ${SIZE}`
}

async function readStamp() {
  try {
    return await new Promise((done, fail) => {
      let text = ''
      createReadStream(stampPath(), { encoding: 'utf8' })
        .on('error', fail)
        .on('data', (chunk) => (text += chunk))
        .on('end', () => done(text.split('\n\n')[0]))
    })
  } catch {
    return null
  }
}

function writeStamp() {
  writeFileSync(
    stampPath(),
    `${expectedStamp()}\n\n` +
      `These binaries are ${SOURCE_INFO.project}, build ${SOURCE_INFO.build}.\n` +
      `They are distributed unmodified and are run by the app's local AI runtime.\n\n` +
      `Source: ${SOURCE_INFO.repository}\n` +
      `  ${SOURCE_INFO.releaseUrl}\n` +
      `Licence: ${SOURCE_INFO.licence}\n` +
      `  ${SOURCE_INFO.licenceUrl}\n`,
    'utf8'
  )
}

async function main() {
  mkdirSync(DEST, { recursive: true })
  mkdirSync(CACHE, { recursive: true })

  const stamp = await readStamp()
  if (existsSync(SERVER) && stamp === expectedStamp()) {
    log(`already present (llama-server.exe, ${TAG}); nothing to do`)
    return
  }

  const cached = existsSync(ZIP) ? statSync(ZIP).size : 0
  if (cached !== SIZE) {
    if (cached > 0) log(`found a partial download (${(cached / 1024 / 1024).toFixed(1)} MB); resuming`)
    await download(SOURCE, ZIP)
  }

  const size = statSync(ZIP).size
  if (size !== SIZE) {
    throw new Error(`size mismatch for ${ASSET}: expected ${SIZE}, got ${size}`)
  }
  const sum = await sha256(ZIP)
  if (sum !== SHA256) {
    throw new Error(
      `checksum mismatch for ${ASSET}\n  expected ${SHA256}\n  got      ${sum}\n` +
        'Refusing to use this file. If llama.cpp moved, edit TAG, ASSET, SHA256 and SIZE in ' +
        'scripts/fetch-llama.mjs in one commit.'
    )
  }
  log('checksum verified')
  unpack(ZIP)
  writeStamp()
  log(`installed the local AI runtime into vendor/llama (${basename(SERVER)})`)
}

main().catch((err) => {
  console.error(`[llama] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
