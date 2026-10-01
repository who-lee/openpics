import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/protocol'
import { applyPatch, sanitizeSettings } from '../shared/settings-schema'

let cache: Settings | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  if (cache) return cache
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    parsed = {}
  }
  // Whitelist merge: an unknown or corrupt key can never reach the running app.
  const merged = sanitizeSettings(parsed, DEFAULT_SETTINGS)
  if (merged.root === '') merged.root = defaultRoot()
  cache = merged
  return merged
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = applyPatch(loadSettings(), patch)
  cache = next
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* a read-only profile should not take the window down */
  }
  return next
}

/**
 * First launch scans the Desktop. Reads the shell folder rather than hardcoding
 * a path, so it follows a redirected or OneDrive-backed Desktop.
 */
export function defaultRoot(): string {
  return app.getPath('desktop')
}