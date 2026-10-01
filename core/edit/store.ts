import { randomUUID } from 'node:crypto'

import type { ReadableFormat } from '../image/image'
import { openSession } from './io'
import { inspectSession, type EditSession } from './session'
import { EditError } from './errors'

/**
 * Keeping edits alive between calls.
 *
 * The MCP is stateless at the transport level but an edit is not: a cutout
 * followed by two brush corrections followed by a preview is one piece of work
 * spread over four calls, and re-reading and re-cutting the file between each one
 * would throw away the corrections. So a session is opened once and referred to
 * by an opaque id afterwards, in the same spirit as the Recycle Bin ids already
 * used by the bin tools.
 *
 * Both the MCP server and the Electron main process hold one of these. They are
 * separate processes with separate stores, so an id from one is meaningless in
 * the other - which is also why the id must not be a path.
 */

export interface EditHandle {
  id: string
  path: string
  session: EditSession
  format: ReadableFormat
  bytes: number
  openedAt: number
  /**
   * Monotonic recency counter, not a clock.
   *
   * `Date.now()` only has millisecond resolution and two sessions opened by the
   * same burst of tool calls routinely land in the same millisecond. Sorting on
   * that makes eviction order arbitrary between them, and the arbitrary one that
   * dies might be the edit the caller is still working on. A counter cannot tie.
   */
  seq: number
}

export interface EditSummary {
  id: string
  path: string
  width: number
  height: number
  hasEdits: boolean
  openedAt: number
}

/**
 * Pixel budget across all live sessions.
 *
 * A session costs five bytes per pixel: four for the decoded original and one for
 * the mask. The limit is on pixels rather than on session count because the count
 * says nothing about the cost - eight 40-megapixel edits are 1.6GB and eight small
 * ones are nothing. Bounding the thing that is actually allocated is the only way
 * to make the ceiling mean anything.
 */
const DEFAULT_PIXEL_BUDGET = 80_000_000

/** Enough for a handful of pictures without ever being the reason a request fails. */
const DEFAULT_MAX_SESSIONS = 8

export class EditStore {
  private readonly handles = new Map<string, EditHandle>()
  private readonly pixelBudget: number
  private readonly maxSessions: number
  private seq = 0

  constructor(options: { pixelBudget?: number; maxSessions?: number } = {}) {
    this.pixelBudget = options.pixelBudget ?? DEFAULT_PIXEL_BUDGET
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  }

  /**
   * Opens a picture for editing.
   *
   * Passing `reuseId` re-cuts into an existing session, which is how a caller
   * starts over after a bad cutout without leaving the old buffers behind. That is
   * deliberately the only way to replace the contents of a session: an id that
   * silently pointed somewhere else would make `edit_apply` write the wrong picture.
   */
  open(path: string, reuseId?: string): EditHandle {
    const opened = openSession(path)
    const pixels = opened.session.width * opened.session.height

    if (this.pixelBudget > 0 && pixels > this.pixelBudget) {
      throw new EditError(
        `this picture is ${pixels.toLocaleString('en-US')} pixels, above the ${this.pixelBudget.toLocaleString('en-US')} kept in memory at once; edit it in the app instead`
      )
    }

    const id = reuseId ?? this.freshId()
    if (reuseId !== undefined) this.release(reuseId)
    const handle: EditHandle = {
      id,
      path,
      session: opened.session,
      format: opened.format,
      bytes: opened.bytes,
      openedAt: Date.now(),
      seq: ++this.seq
    }
    this.handles.set(id, handle)
    this.evict()
    return handle
  }

  /**
   * Fetches a live session.
   *
   * The error lists what *is* open. An agent that has lost track of an id can act
   * on that, whereas "unknown edit 4f2a" is a dead end.
   *
   * The advice names no particular tool. This module is reached from the desktop
   * app as well as from the MCP server, and telling someone using the window to
   * call `edit_cutout_auto` would be pointing them at something that does not
   * exist for them.
   */
  require(id: string): EditHandle {
    const handle = this.handles.get(id)
    if (!handle) {
      const live = this.list()
      throw new EditError(
        live.length === 0
          ? `no edit is open (${id} is not one of ours); open the picture first`
          : `unknown edit ${id}; still open: ${live.map((h) => h.id).join(', ')}`
      )
    }
    handle.seq = ++this.seq
    return handle
  }

  close(id: string): boolean {
    return this.release(id)
  }

  list(): EditSummary[] {
    return [...this.handles.values()]
      .sort((a, b) => b.seq - a.seq)
      .map((handle) => ({
        id: handle.id,
        path: handle.path,
        width: handle.session.width,
        height: handle.session.height,
        hasEdits: inspectSession(handle.session).hasEdits,
        openedAt: handle.openedAt
      }))
  }

  /** Live pixels, so a caller can see what the budget is actually being spent on. */
  pixelsInUse(): number {
    let total = 0
    for (const handle of this.handles.values()) {
      total += handle.session.width * handle.session.height
    }
    return total
  }

  private release(id: string): boolean {
    return this.handles.delete(id)
  }

  private freshId(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = randomUUID().slice(0, 8)
      if (!this.handles.has(candidate)) return candidate
    }
    throw new EditError('could not allocate an edit id')
  }

  /**
   * Drops least-recently-used sessions until everything fits.
   *
   * Evicting silently would be worse than evicting loudly: a later `edit_apply`
   * would fail with an unknown id and no explanation, so `require` carries the
   * survivor list instead. The session just opened is the most recent by
   * definition and so is never the one that goes.
   */
  private evict(): void {
    while (this.overBudget()) {
      const oldest = [...this.handles.values()].sort((a, b) => a.seq - b.seq)[0]
      if (!oldest || this.handles.size <= 1) break
      this.handles.delete(oldest.id)
    }
  }

  private overBudget(): boolean {
    if (this.handles.size > this.maxSessions) return true
    return this.pixelBudget > 0 && this.pixelsInUse() > this.pixelBudget
  }
}