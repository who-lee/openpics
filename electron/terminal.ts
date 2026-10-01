import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { webContents } from 'electron'
import type { IPty } from 'node-pty'
import { TERMINAL_DATA_CHANNEL, TERMINAL_EXIT_CHANNEL } from '../shared/bridge'
import type {
  TerminalAttachResult,
  TerminalCreateOptions,
  TerminalSessionInfo,
  TerminalShell
} from '../shared/terminal'
import { loadSettings } from './settings'

type PtyModule = typeof import('node-pty')

const MAX_SESSIONS = 8
const MIN_COLS = 20
const MAX_COLS = 400
const MIN_ROWS = 4
const MAX_ROWS = 200
/** How much pre-attach output to hold. A shell banner and prompt are bytes. */
const BACKLOG_LIMIT = 65536
/** A single keystroke paste is small; anything past this is not a keystroke. */
const MAX_WRITE = 1_000_000

interface Session {
  id: string
  child: IPty
  shell: string
  cwd: string
  /** The webContents that opened it. Only that window may drive it. */
  owner: number
  /** False until the view attaches; output is held in `backlog` meanwhile. */
  live: boolean
  backlog: string
}

const sessions = new Map<string, Session>()
let seq = 0

let ptyModule: PtyModule | null = null
let ptyFailure: string | null = null

/**
 * node-pty is loaded on demand rather than imported at the top of the file.
 * Its native binding is the one part of the app that can fail to load on an
 * unusual machine, and a picture browser must not be taken down at startup by
 * a feature most people never open: a failure here only disables the terminal.
 */
async function loadPty(): Promise<PtyModule> {
  if (ptyModule) return ptyModule
  if (ptyFailure) throw new Error(ptyFailure)
  try {
    ptyModule = await import('node-pty')
    return ptyModule
  } catch {
    ptyFailure = 'The terminal engine could not start on this system.'
    throw new Error(ptyFailure)
  }
}

export async function terminalAvailable(): Promise<boolean> {
  try {
    await loadPty()
    return true
  } catch {
    return false
  }
}

/** A shell is named from the shared union, never a path from the renderer. */
function resolveShell(shell: TerminalShell | undefined): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return shell === 'cmd' ? { file: 'cmd.exe', args: [] } : { file: 'powershell.exe', args: ['-NoLogo'] }
  }
  const file = shell === 'cmd' ? '/bin/sh' : process.env.SHELL || '/bin/bash'
  return { file, args: [] }
}

/** A start directory only when it is an absolute path that really exists. */
function resolveCwd(requested: string | undefined): string {
  const home = homedir()
  if (!requested || !isAbsolute(requested)) return home
  try {
    if (statSync(requested).isDirectory()) return requested
  } catch {
    /* not a directory; fall through to home */
  }
  return home
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TERM = 'xterm-256color'
  return env
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Resolves a session only for the window that owns it. */
function own(owner: number, id: string): Session {
  const session = sessions.get(id)
  if (!session) throw new Error('That terminal is no longer open.')
  if (session.owner !== owner) throw new Error('That terminal belongs to another window.')
  return session
}

function send(owner: number, channel: string, payload: unknown): void {
  const target = webContents.fromId(owner)
  if (target && !target.isDestroyed()) target.send(channel, payload)
}

export async function createTerminal(
  owner: number,
  options: TerminalCreateOptions = {}
): Promise<TerminalSessionInfo> {
  if (!loadSettings().enableTerminal) {
    throw new Error('The terminal is turned off in Settings.')
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Close a terminal first: ${MAX_SESSIONS} can be open at once.`)
  }
  const pty = await loadPty()
  const cols = clampInt(options.cols, MIN_COLS, MAX_COLS, 80)
  const rows = clampInt(options.rows, MIN_ROWS, MAX_ROWS, 24)
  const cwd = resolveCwd(options.cwd)
  const { file, args } = resolveShell(options.shell)
  const child = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: childEnv() })

  const id = `term-${++seq}`
  const session: Session = { id, child, shell: file, cwd, owner, live: false, backlog: '' }
  sessions.set(id, session)

  child.onData((data) => {
    if (!session.live) {
      // Held until the view attaches, so the banner and first prompt survive the
      // gap between spawning the shell and React mounting something to draw it.
      session.backlog = (session.backlog + data).slice(-BACKLOG_LIMIT)
      return
    }
    send(session.owner, TERMINAL_DATA_CHANNEL, { id, data })
  })

  child.onExit(({ exitCode }) => {
    sessions.delete(id)
    send(session.owner, TERMINAL_EXIT_CHANNEL, { id, exitCode })
  })

  return { id, shell: file, cwd }
}

export function attachTerminal(owner: number, id: string): TerminalAttachResult {
  const session = own(owner, id)
  const backlog = session.backlog
  session.backlog = ''
  session.live = true
  return { backlog }
}

export function writeTerminal(owner: number, id: string, data: string): void {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_WRITE) return
  own(owner, id).child.write(data)
}

export function resizeTerminal(owner: number, id: string, cols: number, rows: number): void {
  const session = own(owner, id)
  const nextCols = clampInt(cols, MIN_COLS, MAX_COLS, session.child.cols)
  const nextRows = clampInt(rows, MIN_ROWS, MAX_ROWS, session.child.rows)
  if (nextCols === session.child.cols && nextRows === session.child.rows) return
  try {
    session.child.resize(nextCols, nextRows)
  } catch {
    /* a shell that has already exited cannot be resized */
  }
}

export function killTerminal(owner: number, id: string): void {
  const session = sessions.get(id)
  if (!session || session.owner !== owner) return
  sessions.delete(id)
  try {
    session.child.kill()
  } catch {
    /* already gone */
  }
}

/** Called when a window closes, so its shells do not outlive it. */
export function killTerminalsForOwner(owner: number): void {
  for (const session of [...sessions.values()]) {
    if (session.owner !== owner) continue
    sessions.delete(session.id)
    try {
      session.child.kill()
    } catch {
      /* already gone */
    }
  }
}

/** Called on quit: every shell goes down with the app. */
export function killAllTerminals(): void {
  for (const session of sessions.values()) {
    try {
      session.child.kill()
    } catch {
      /* already gone */
    }
  }
  sessions.clear()
}
