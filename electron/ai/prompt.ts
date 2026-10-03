import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { getBundledPromptPath, getPromptUserPath, ensureUserDataDir } from './paths'

export async function ensurePromptFile(): Promise<string> {
  ensureUserDataDir()
  const userPath = getPromptUserPath()
  if (existsSync(userPath)) return userPath
  const bundled = getBundledPromptPath()
  if (bundled && existsSync(bundled)) {
    try {
      await copyFile(bundled, userPath)
      return userPath
    } catch {}
  }
  const defaultPrompt = `# OpenPics AI Prompt
# This prompt is user-editable. Changes persist in your user data directory.
You are OpenPics AI, a fully local assistant for this photo library.

Instructions:
- Answer concisely and help with photo library tasks.
- Be truthful about local-only capabilities.
- When asked about photos, reference filenames and paths carefully.
`
  try {
    writeFileSync(userPath, defaultPrompt, 'utf8')
  } catch {}
  return userPath
}

export function readPromptFile(): string {
  try {
    return readFileSync(getPromptUserPath(), 'utf8')
  } catch {
    return ''
  }
}

export async function writePromptFile(content: string): Promise<void> {
  ensureUserDataDir()
  writeFileSync(getPromptUserPath(), content, 'utf8')
}
