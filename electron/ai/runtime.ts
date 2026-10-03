/**
 * The local llama.cpp runtime.
 *
 * OpenPics ships `llama-server.exe` (see scripts/fetch-llama.mjs) and drives it
 * over its loopback HTTP API. A server rather than one process per message: the
 * GGUF's own chat template is applied by llama-server, and keeping the model
 * resident means the second question is answered without re-reading half a
 * gigabyte from disk.
 *
 * Nothing here leaves the machine. The server binds 127.0.0.1 on a port chosen
 * free at launch, and it is shut down after a period of inactivity so the app is
 * not holding several hundred megabytes of RAM while the user browses.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { getLlamaDir, getLlamaServerPath } from './paths'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatOptions = {
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
}

/** Model keeps the server alive for this long after the last reply. */
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000
/** A cold load of a 0.5B Q4 model is quick; this is generous for a slow disk. */
const STARTUP_TIMEOUT_MS = 120 * 1000

let child: ChildProcess | null = null
let port = 0
let starting: Promise<number> | null = null
let idleTimer: NodeJS.Timeout | null = null
let lastError: string | null = null
const recentLog: string[] = []

function remember(line: string): void {
  const trimmed = line.trim()
  if (trimmed === '') return
  recentLog.push(trimmed)
  if (recentLog.length > 40) recentLog.shift()
}

function tail(): string {
  return recentLog.slice(-8).join('\n')
}

export function isRuntimeRunning(): boolean {
  return child !== null && port > 0
}

export function getRuntimeError(): string | null {
  return lastError
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(chosen))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function waitForHealth(serverPort: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`the local AI runtime exited during startup${tail() ? `\n${tail()}` : ''}`)
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const res = await fetch(`http://127.0.0.1:${serverPort}/health`, { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        const body = (await res.json()) as { status?: string }
        if (body.status === 'ok') return
      }
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    await sleep(250)
  }
  throw new Error(`the local AI runtime did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`)
}

function clearIdle(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function touchIdle(): void {
  clearIdle()
  idleTimer = setTimeout(() => {
    stopRuntime()
  }, IDLE_SHUTDOWN_MS)
  idleTimer.unref?.()
}

async function start(modelPath: string): Promise<number> {
  const exe = getLlamaServerPath()
  if (!existsSync(exe)) {
    throw new Error(
      'The local AI runtime is missing. Run "npm run llama" in a checkout, or reinstall the app.'
    )
  }

  const chosen = await freePort()
  const threads = Math.max(2, Math.min(8, cpus().length - 1))
  const args = [
    '-m',
    modelPath,
    '-c',
    '4096',
    '-t',
    String(threads),
    '--host',
    '127.0.0.1',
    '--port',
    String(chosen)
  ]

  recentLog.length = 0
  const proc = spawn(exe, args, {
    cwd: getLlamaDir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child = proc
  port = chosen

  proc.stdout?.on('data', (chunk: Buffer) => remember(chunk.toString()))
  proc.stderr?.on('data', (chunk: Buffer) => remember(chunk.toString()))
  proc.on('exit', () => {
    const wasRunning = child === proc
    if (wasRunning) {
      child = null
      port = 0
      clearIdle()
    }
  })
  proc.on('error', (err) => {
    lastError = err.message
    if (child === proc) {
      child = null
      port = 0
    }
  })

  try {
    await waitForHealth(chosen, proc)
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    stopRuntime()
    throw err
  }

  lastError = null
  touchIdle()
  return chosen
}

export async function ensureRuntime(modelPath: string): Promise<number> {
  if (isRuntimeRunning()) {
    touchIdle()
    return port
  }
  if (!starting) {
    starting = start(modelPath).finally(() => {
      starting = null
    })
  }
  return starting
}

/**
 * Streams a completion, invoking `onDelta` as text arrives.
 *
 * Returns the full reply once the stream ends. Deltas are what make the dock feel
 * alive; the return value is what the store settles on so a dropped delta cannot
 * leave a half-written answer on screen.
 */
export async function chat(
  modelPath: string,
  options: ChatOptions,
  onDelta: (delta: string) => void
): Promise<string> {
  const serverPort = await ensureRuntime(modelPath)
  touchIdle()

  const response = await fetch(`http://127.0.0.1:${serverPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: options.messages,
      max_tokens: options.maxTokens ?? 512,
      temperature: options.temperature ?? 0.7,
      stream: true
    })
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(`the local AI returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  const consume = (line: string): boolean => {
    if (!line.startsWith('data:')) return false
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return payload === '[DONE]'
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; text?: string }>
      }
      const choice = parsed.choices?.[0]
      const piece = choice?.delta?.content ?? choice?.text ?? ''
      if (piece) {
        full += piece
        onDelta(piece)
      }
    } catch {
      // A partial SSE frame; the next read completes it.
    }
    return false
  }

  let done = false
  while (!done) {
    const { value, done: finished } = await reader.read()
    if (finished) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (consume(line)) {
        done = true
        break
      }
      newline = buffer.indexOf('\n')
    }
  }
  if (buffer.trim() !== '') {
    for (const line of buffer.split('\n')) consume(line.replace(/\r$/, ''))
  }

  touchIdle()
  return full
}

export function stopRuntime(): void {
  clearIdle()
  const proc = child
  child = null
  port = 0
  if (proc && proc.exitCode === null) {
    try {
      proc.kill()
    } catch {
      // Already gone.
    }
  }
}
