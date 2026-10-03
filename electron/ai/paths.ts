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
