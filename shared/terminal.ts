/**
 * The terminal surface, described without any Node or Electron types so it can
 * cross into the web project. A shell is named from a fixed list rather than
 * passed as a path: the renderer picks which shell, never which binary.
 */
export type TerminalShell = 'powershell' | 'cmd'

export interface TerminalCreateOptions {
  shell?: TerminalShell
  /** A directory to start in. Ignored unless it is an existing absolute path. */
  cwd?: string
  cols?: number
  rows?: number
}

/** What the renderer is told when a shell is opened. Never contains the pid. */
export interface TerminalSessionInfo {
  id: string
  /** The resolved executable, for showing which shell a tab is running. */
  shell: string
  cwd: string
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  exitCode: number
}

export interface TerminalAttachResult {
  /**
   * Output printed before the renderer attached. A ConPTY prints its banner the
   * moment it is spawned, which is before React has mounted a view to receive
   * it, so the main process holds those bytes and hands them over here.
   */
  backlog: string
}
