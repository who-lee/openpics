import { ensureReady, getAiState } from './core'
import { chat } from './runtime'

export type AutotagResult = {
  photoId: string
  tags: string[]
  confidence: number
}

/**
 * Suggests tags for one photo.
 *
 * The bundled model is text-only, so tags are inferred from the file name and
 * its folder rather than from the image itself; a model that can see pixels is a
 * separate decision (and a much larger download). Tags are always suggestions:
 * an empty list is a normal answer, not a failure.
 */
export async function autotagPhoto(photoId: string, path: string): Promise<AutotagResult> {
  if (!(await ensureReady())) return { photoId, tags: [], confidence: 0 }

  const modelPath = getAiState().modelPath
  if (!modelPath) return { photoId, tags: [], confidence: 0 }

  const name = path.split(/[\\/]/).pop() || ''
  try {
    const reply = await chat(
      modelPath,
      {
        messages: [
          {
            role: 'system',
            content:
              'You suggest tags for a photo library. Reply with up to five short lowercase tags, comma-separated, and nothing else.'
          },
          { role: 'user', content: `File name: ${name}` }
        ],
        maxTokens: 32,
        temperature: 0.2
      },
      () => {}
    )
    const tags = Array.from(
      new Set(
        reply
          .split(',')
          .map((tag) => tag.trim().toLowerCase())
          .filter((tag) => tag !== '' && tag.length <= 24)
      )
    ).slice(0, 5)
    return { photoId, tags, confidence: tags.length > 0 ? 0.5 : 0 }
  } catch {
    return { photoId, tags: [], confidence: 0 }
  }
}
