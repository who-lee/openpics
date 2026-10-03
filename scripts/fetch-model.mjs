#!/usr/bin/env node
/**
 * Fetches the GGUF model OpenPics runs its local AI on.
 *
 * Run by `npm run model`, and automatically before `npm run package`. The file
 * is about 470 MB, which is why it is fetched here rather than committed: vendor/
 * is not in the repository, and the same bytes are available from Hugging Face
 * with a published checksum.
 *
 * Like scripts/fetch-addons.mjs, this will not take a URL from an argument. The
 * source and the SHA-256 are constants in this file, so moving to a newer model
 * is one reviewable commit rather than a build step that downloads whatever it
 * is handed. The URL pins a commit, not `main`, so the file behind it cannot
 * change under the checksum.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'vendor', 'models')

/**
 * Qwen2.5-0.5B-Instruct, quantised to Q4_K_M.
 *
 * A half-billion-parameter instruct model is the honest choice for a bundled
 * model: it runs on a laptop CPU without a GPU, answers a photo-tagging or
 * grouping question in a second or two, and keeps the installer under half a
 * gigabyte. The weights are Apache-2.0, which matches this project's licence, so
 * nothing here relicenses the app.
 *
 * `resolve/<commit>/<file>` rather than `resolve/main/<file>`: a branch moves, a
 * commit does not, so the pinned SHA-256 always describes the bytes this URL
 * serves.
 */
const REVISION = '9217f5db79a29953eb74d5343926648285ec7e67'
const FILENAME = 'qwen2.5-0.5b-instruct-q4_k_m.gguf'
const SOURCE = `https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/${REVISION}/${FILENAME}`
const SHA256 = '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db'
const SIZE = 491400032

const SOURCE_INFO = {
  model: 'Qwen2.5-0.5B-Instruct',
  quantisation: 'Q4_K_M',
  repository: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF',
  revision: REVISION,
  revisionUrl: `https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/commit/${REVISION}`,
  licence: 'Apache-2.0',
  licenceUrl: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/LICENSE'
}

const TARGET = join(DEST, FILENAME)

function log(...parts) {
  console.log('[model]', ...parts)
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

  // A 470 MB transfer over a home connection fails often enough that throwing
  // away a partial file would make packaging flaky. Resume from what is on disk
  // and retry; both are safe because the checksum is checked before the file is
  // accepted, so a bad resume fails there rather than in the model loader.
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

/**
 * Records what is on disk, the way vendor/addons records its FFmpeg stamp.
 *
 * The stamp is what lets a person receiving the installed app find the exact
 * weights and their licence, and it is compared on the next run so swapping the
 * pin actually replaces the file instead of leaving the previous model in place.
 */
function stampPath() {
  return join(DEST, 'MODEL-BUILD.txt')
}

function expectedStamp() {
  return `${FILENAME}\nsha256 ${SHA256}\nsize ${SIZE}`
}

async function main() {
  mkdirSync(DEST, { recursive: true })

  let stamp = null
  try {
    stamp = await new Promise((done, fail) => {
      let text = ''
      createReadStream(stampPath(), { encoding: 'utf8' })
        .on('error', fail)
        .on('data', (chunk) => (text += chunk))
        .on('end', () => done(text.split('\n\n')[0]))
    })
  } catch {
    stamp = null
  }

  const already = existsSync(TARGET) ? statSync(TARGET).size : 0
  if (already === SIZE) {
    const sum = await sha256(TARGET)
    if (sum === SHA256) {
      if (stamp === expectedStamp()) {
        log(`already present (${FILENAME}, ${(SIZE / 1024 / 1024).toFixed(1)} MB); nothing to do`)
        return
      }
      log('the file matches the pin but the stamp is missing or stale; rewriting it')
      writeStamp()
      return
    }
    log('the file on disk is not the pinned model; refetching')
    rmSync(TARGET, { force: true })
  } else if (already > 0 && already < SIZE) {
    log(`found a partial download (${(already / 1024 / 1024).toFixed(1)} MB); resuming`)
  } else if (already > SIZE) {
    log('the file on disk is larger than the pin; refetching')
    rmSync(TARGET, { force: true })
  }

  await download(SOURCE, TARGET)

  const size = statSync(TARGET).size
  if (size !== SIZE) {
    throw new Error(`size mismatch for ${FILENAME}: expected ${SIZE}, got ${size}`)
  }
  const sum = await sha256(TARGET)
  if (sum !== SHA256) {
    throw new Error(
      `checksum mismatch for ${FILENAME}\n  expected ${SHA256}\n  got      ${sum}\n` +
        'Refusing to use this file. If the model was updated, edit REVISION, SHA256 and SIZE in ' +
        'scripts/fetch-model.mjs in one commit.'
    )
  }
  log('checksum verified')
  writeStamp()
  log(`installed ${FILENAME} into vendor/models (${(SIZE / 1024 / 1024).toFixed(1)} MB)`)
}

function writeStamp() {
  writeFileSync(
    stampPath(),
    `${expectedStamp()}\n\n` +
      `These weights are ${SOURCE_INFO.model}, quantised to ${SOURCE_INFO.quantisation}.\n` +
      `They are distributed unmodified and are loaded by the app's local AI runtime.\n\n` +
      `Source: ${SOURCE_INFO.repository}\n` +
      `  revision ${SOURCE_INFO.revision}\n` +
      `  ${SOURCE_INFO.revisionUrl}\n` +
      `Licence: ${SOURCE_INFO.licence}\n` +
      `  ${SOURCE_INFO.licenceUrl}\n`,
    'utf8'
  )
}

main().catch((err) => {
  console.error(`[model] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
