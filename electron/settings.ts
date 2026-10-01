import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/protocol'

let cache: Settings | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  if (cache) return cache
  let parsed: Partial<Settings> = {}
  try {
    parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>
  } catch {
    parsed = {}
  }
  // Whitelist merge: an unknown or corrupt key can never reach the running app.
  const merged: Settings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const incoming = parsed[key]
    if (typeof incoming === typeof DEFAULT_SETTINGS[key]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(merged as any)[key] = incoming
    }
  }
  if (merged.root === '') merged.root = defaultRoot()
  cache = merged
  return merged
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const current = loadSettings()
  const next: Settings = { ...current }
  for (const key of Object.keys(current) as (keyof Settings)[]) {
    if (!(key in patch)) continue
    const incoming = patch[key]
    if (typeof incoming === typeof current[key]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(next as any)[key] = incoming
    }
  }
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