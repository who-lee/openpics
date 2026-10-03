import { ensureReady } from './core'

export type AutotagResult = {
  photoId: string
  tags: string[]
  confidence: number
}

export async function autotagPhoto(photoId: string, path: string): Promise<AutotagResult> {
  // Placeholder for local model inference (llama.cpp/gguf) integration.
  // For now, return empty tags to keep scaffolding non-blocking.
  await ensureReady()
  return { photoId, path: path as any, tags: [], confidence: 0 } as any
}
