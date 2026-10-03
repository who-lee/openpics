export type AiMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export type AiModelInfo = {
  path: string
  name: string
  sizeBytes?: number
}

export type AiState = {
  ready: boolean
  modelPath: string | null
  modelName: string | null
  promptPath: string | null
  thinking: boolean
  lastError: string | null
}

export type AiChatContext = {
  photoIds?: string[]
  paths?: string[]
}

export type AiChatReply = {
  content: string
}
