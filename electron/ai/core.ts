import { loadSettings } from '../settings'
import { pickDefaultModel } from './manager'
import { ensurePromptFile } from './prompt'

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

export function getAiState(): AiState {
  return { ...state }
}

export async function initAi(): Promise<AiState> {
  try {
    const settings = getSettings()
    const promptPath = await ensurePromptFile()
    let modelPath = settings.aiModelPath
    if (!modelPath) {
      const def = pickDefaultModel()
      if (def) modelPath = def.path
    }
    state = {
      ready: !!modelPath,
      modelPath: modelPath || null,
      modelName: modelPath ? modelPath.split(/[\\/]/).pop() || null : null,
      promptPath,
      thinking: false,
      lastError: null,
    }
    return getAiState()
  } catch (e: any) {
    state = { ...state, ready: false, lastError: e?.message || 'init failed' }
    return getAiState()
  }
}

export async function ensureReady(): Promise<boolean> {
  if (!state.ready) {
    await initAi()
  }
  return state.ready
}
