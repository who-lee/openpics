import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function getUserDataDir(): string {
  return app.getPath('userData')
}

export function getPromptUserPath(): string {
  return join(getUserDataDir(), 'openpics-ai-prompt.txt')
}

export function getDefaultPromptTemplateName(): string {
  return 'openpics-ai-prompt-default.txt'
}

export function getBundledPromptPath(): string | null {
  const candidates = [
    resolve(process.resourcesPath, getDefaultPromptTemplateName()),
    resolve(process.resourcesPath, 'ai', getDefaultPromptTemplateName()),
    resolve(process.resourcesPath, 'models', '..', getDefaultPromptTemplateName()),
    resolve(process.cwd(), getDefaultPromptTemplateName()),
    resolve(process.cwd(), 'build', getDefaultPromptTemplateName()),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {}
  }
  return null
}

export function getModelsDir(): string {
  const candidates = [
    resolve(process.resourcesPath, 'models'),
    resolve(process.resourcesPath, 'ai', 'models'),
    resolve(process.cwd(), 'models'),
    resolve(process.cwd(), 'build', 'models'),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {}
  }
  return resolve(process.resourcesPath, 'models')
}

export function ensureUserDataDir(): void {
  try {
    mkdirSync(getUserDataDir(), { recursive: true })
  } catch {}
}

/**
 * The llama.cpp runtime, shipped as extraResources under `llama/`.
 *
 * The packaged path is checked first so a release always runs the binary the
 * build put there; `vendor/llama` is what `npm run llama` fills in a checkout,
 * and is absent from the installed app. Windows resolves the sibling DLLs from
 * the executable's own directory, so callers should spawn with this as cwd.
 */
export function getLlamaDir(): string {
  const candidates = [
    resolve(process.resourcesPath, 'llama'),
    resolve(process.cwd(), 'vendor', 'llama'),
    resolve(process.cwd(), 'llama'),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(join(p, 'llama-server.exe'))) return p
    } catch {}
  }
  return resolve(process.resourcesPath, 'llama')
}

export function getLlamaServerPath(): string {
  return join(getLlamaDir(), 'llama-server.exe')
}
