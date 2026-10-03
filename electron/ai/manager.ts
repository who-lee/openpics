import { existsSync, readdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { getModelsDir } from './paths'

export type AiModelInfo = {
  path: string
  name: string
  sizeBytes?: number
}

export function findBundledModels(): AiModelInfo[] {
  const dir = getModelsDir()
  if (!existsSync(dir)) return []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const models: AiModelInfo[] = []
    for (const e of entries) {
      if (!e.isFile()) continue
      const ext = extname(e.name).toLowerCase()
      if (ext === '.gguf' || ext === '.bin' || ext === '.ggml' || ext === '.ggjt' || ext === '.ggla') {
        const full = join(dir, e.name)
        models.push({ path: full, name: e.name })
      }
    }
    return models.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function pickDefaultModel(): AiModelInfo | null {
  const models = findBundledModels()
  if (models.length === 0) return null
  // Prefer smallest or common names? keep first by name as stable default
  return models[0] ?? null
}

