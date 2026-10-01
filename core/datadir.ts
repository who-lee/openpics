import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where OpenPics keeps per-user state.
 *
 * This mirrors what `app.getPath('userData')` resolves to inside the app, so the
 * MCP and the running application read and write the same files instead of
 * keeping two copies of the same truth.
 *
 * `OPENPICS_DATA_DIR` overrides it. That is not only for tests: an agent working
 * on a real library needs somewhere disposable to prove a destructive operation
 * before it touches anything the user actually cares about.
 */
export function dataDir(): string {
  const override = process.env.OPENPICS_DATA_DIR
  if (override) return override
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'openpics')
}

export function dataFile(name: string): string {
  return join(dataDir(), name)
}

/** Reads a JSON file, falling back when it is absent or unreadable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Writes a JSON file, creating the directory first. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}
