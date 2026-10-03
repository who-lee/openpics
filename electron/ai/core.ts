import { existsSync } from 'node:fs'
import { loadSettings } from '../settings'
import { pickDefaultModel } from './manager'
import { ensurePromptFile, readPromptFile } from './prompt'
import { chat, ensureRuntime, getRuntimeError, isRuntimeRunning, stopRuntime, type ChatMessage } from './runtime'
import type { AiChatContext, AiChatReply } from '../../shared/ai-types'

export type AiState = {
  ready: boolean
  modelPath: string | null
  modelName: string | null
  promptPath: string | null
  thinking: boolean
  lastError: string | null
}

let state: AiState = {
  ready: false,
  modelPath: null,
  modelName: null,
  promptPath: null,
  thinking: false,
  lastError: null,
}

function getSettings() {
  return loadSettings()
}

function nameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function getAiState(): AiState {
  return { ...state }
}

export async function initAi(): Promise<AiState> {
  try {
    const settings = getSettings()
    const promptPath = await ensurePromptFile()
    let modelPath = settings.aiModelPath
    // A model path in settings can point at a file the user has since moved, so
    // it is only trusted while it still exists; otherwise fall back to whatever
    // the package shipped.
    if (modelPath && !existsSync(modelPath)) modelPath = ''
    if (!modelPath) {
      const def = pickDefaultModel()
      if (def) modelPath = def.path
    }
    state = {
      ready: !!modelPath,
      modelPath: modelPath || null,
      modelName: modelPath ? nameOf(modelPath) : null,
      promptPath,
      thinking: false,
      lastError: modelPath ? null : 'No local model was found.'
    }
    return getAiState()
  } catch (e: unknown) {
    state = { ...state, ready: false, lastError: e instanceof Error ? e.message : 'init failed' }
    return getAiState()
  }
}

export async function ensureReady(): Promise<boolean> {
  if (!state.ready) {
    await initAi()
  }
  return state.ready
}

/** Prompt text the user can edit, with a fallback if the file cannot be read. */
function systemPrompt(): string {
  try {
    const text = readPromptFile()
    if (text && text.trim() !== '') return text
  } catch {
    // Fall through to the built-in default.
  }
  return 'You are the assistant built into OpenPics, a local photo browser. Answer briefly and helpfully.'
}

/** A short, factual note about the photos the user is asking about. */
function contextNote(context?: AiChatContext): string | null {
  const paths = context?.paths ?? []
  if (paths.length === 0) return null
  const names = paths.slice(0, 20).map((p) => nameOf(p))
  const more = paths.length > names.length ? ` (and ${paths.length - names.length} more)` : ''
  return `The user has selected ${paths.length} photo${paths.length === 1 ? '' : 's'}: ${names.join(', ')}${more}.`
}

/**
 * Answer one message, streaming pieces through `onDelta`.
 *
 * History comes from the renderer because it already holds the visible
 * conversation; main only assembles the request. The selected files are passed
 * as a system note rather than being read into the prompt: the bundled model is
 * text-only, so it can reason about names and counts but cannot see the images.
 */
export async function chatAi(
  message: string,
  context: AiChatContext | undefined,
  onDelta: (delta: string) => void
): Promise<AiChatReply> {
  if (!(await ensureReady()) || !state.modelPath) {
    return {
      content:
        state.lastError ??
        'No local model is available, so I cannot answer. Run "npm run model" in a checkout or reinstall the app.'
    }
  }
  const modelPath = state.modelPath

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt() }]
  for (const turn of context?.history ?? []) {
    if (turn.content.trim() === '') continue
    messages.push({ role: turn.role, content: turn.content })
  }
  const note = contextNote(context)
  messages.push({ role: 'user', content: note ? `${note}\n\n${message}` : message })

  state = { ...state, thinking: true, lastError: null }
  try {
    const reply = await chat(modelPath, { messages }, onDelta)
    state = { ...state, thinking: false }
    return { content: reply }
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e)
    state = { ...state, thinking: false, lastError: detail }
    throw e
  }
}

/** Shut the runtime down; called when the app quits so no child is orphaned. */
export function stopAi(): void {
  stopRuntime()
}

export function aiRuntimeRunning(): boolean {
  return isRuntimeRunning()
}

export function aiRuntimeError(): string | null {
  return getRuntimeError()
}
