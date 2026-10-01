import { cloneMask, type Mask } from './mask'
import type { EditSession } from './session'

/**
 * Undo for the mask.
 *
 * Only the mask is remembered, never the pixels. That is possible because of the
 * arrangement the rest of the editor is built on: the original raster is never
 * modified, and every operation only writes to the mask. So undoing is putting an
 * older mask back, not reconstructing pixels that were already thrown away - which
 * means undo is exact, cheap, and costs one byte per pixel per step instead of
 * four.
 *
 * Each step carries the name of the change it sits in front of, so `edit_history`
 * can name them. An agent working through a cutout needs to know which step it was
 * looking at when it decided to go back, and "the state before" is not an answer.
 */

/**
 * Ceiling on remembered pixels, across all steps of all sessions.
 *
 * A mask is one byte per pixel, so this is 16MB of history however it is spent:
 * a hundred steps on a small picture, or about thirty on a 12-megapixel one, or
 * three on a 40-megapixel one. Fixed in total rather than per session because the
 * cost that matters is the process's, not any one edit's, and because a per-session
 * cap lets one large picture quietly take a quarter of a gigabyte.
 *
 * The number is deliberately small. Undo that survives forty steps is undo nobody
 * uses, because the mistake being corrected is always the last one or two.
 */
const HISTORY_BUDGET_PIXELS = 16_000_000

/** Cap on step count as well, so many identical tiny steps cannot fill the log. */
const MAX_STEPS = 100

export interface HistoryStep {
  label: string
  pixels: number
}

/**
 * One remembered mask plus the name of the change it belongs to.
 *
 * `past` holds the mask as it was *before* the change and `future` holds the mask
 * as it was *after* it. They are different snapshots of the same edit, which is
 * why they are separate types rather than one array reused for both: keeping the
 * label on both sides is what lets a redo report the same name the original step
 * did, instead of inventing one at the moment it is replayed.
 */
interface Entry {
  label: string
  mask: Mask
}

export class EditHistory {
  /** Most recent last. Each entry is the mask as it was before the named step. */
  private past: Entry[] = []
  /** Most recent last. Each entry is the mask as it was after the named step. */
  private future: Entry[] = []
  private used = 0

  constructor(private readonly budget: number = HISTORY_BUDGET_PIXELS) {}

  /**
   * Records the mask as it stands before a change.
   *
   * Called *before* mutating, so the caller does not have to remember to copy the
   * mask first and undo silently fails when they forget. A step identical to the
   * one already on top is dropped: an operation that changed nothing - a brush
   * stroke entirely on already-transparent pixels, a shrink of nothing - should
   * not consume a step, or an agent correcting one thing would have to undo
   * through ten no-ops to reach the mistake before it.
   *
   * The test is against the top of `past`, which is the snapshot taken before the
   * last recorded step. If that equals where the mask is now, the last recorded
   * step never actually moved the mask. After an undo this comparison is still
   * sound: undo pops one entry, so the new top is an older snapshot and a real
   * change made from there does not match it.
   */
  checkpoint(session: EditSession, label: string): boolean {
    const current = session.mask
    const top = this.past[this.past.length - 1]
    if (top && sameMask(top.mask, current)) return false

    const pixels = current.width * current.height

    // Any redo is abandoned: the timeline branches, and keeping a future that
    // does not follow the branch taken would mean "undo" meaning two things.
    this.dropFuture()

    this.past.push({ label, mask: cloneMask(current) })
    this.used += pixels
    this.trim()
    return true
  }

  canUndo(): boolean {
    return this.past.length > 0
  }

  canRedo(): boolean {
    return this.future.length > 0
  }

  /** Names the last few steps so a caller can see what it is about to undo. */
  recent(limit = 10): { steps: HistoryStep[]; canUndo: boolean; canRedo: boolean } {
    const out: HistoryStep[] = []
    for (let i = Math.max(0, this.past.length - limit); i < this.past.length; i++) {
      const entry = this.past[i]!
      out.push({ label: entry.label, pixels: entry.mask.width * entry.mask.height })
    }
    return { steps: out, canUndo: this.canUndo(), canRedo: this.canRedo() }
  }

  /**
   * Steps back one change, remembering the current mask so it can be replayed.
   *
   * Returns the name of the change undone, or null if there was nothing to undo.
   */
  undo(session: EditSession): string | null {
    const entry = this.past.pop()
    if (!entry) return null
    // Counted because it is now retained memory. Forgetting this was how the
    // budget silently stopped describing reality after an undo: the snapshot was
    // still held, just not counted, so a session could be undone and redone
    // repeatedly and grow past the cap that was supposed to bound it.
    this.future.push({ label: entry.label, mask: cloneMask(session.mask) })
    this.used += entry.mask.width * entry.mask.height
    session.mask = entry.mask
    return entry.label
  }

  /** Replays one undone change, under the name it had when it was first made. */
  redo(session: EditSession): string | null {
    const entry = this.future.pop()
    if (!entry) return null
    this.past.push({ label: entry.label, mask: cloneMask(session.mask) })
    this.used += entry.mask.width * entry.mask.height
    session.mask = entry.mask
    return entry.label
  }

  /** Forgets everything. Used when a session is reused for a different cutout. */
  clear(): void {
    this.used = 0
    this.past = []
    this.future = []
  }

  private dropFuture(): void {
    for (const entry of this.future) {
      this.used -= entry.mask.width * entry.mask.height
    }
    this.future = []
  }

  /**
   * Drops the oldest steps until the budget is met.
   *
   * Oldest first, because recent steps are the ones being corrected. If even a
   * single step does not fit, the newest is kept anyway and the rest are dropped:
   * refusing to remember the last change would make the feature worse than having
   * no history at all, since undo would still appear to work and do nothing.
   */
  private trim(): void {
    while (this.past.length > MAX_STEPS || (this.used > this.budget && this.past.length > 1)) {
      const dropped = this.past.shift()!
      this.used -= dropped.mask.width * dropped.mask.height
    }
    // A single step larger than the whole budget is kept anyway. Dropping it would
    // leave undo reporting that it works and doing nothing, which is worse than a
    // smaller history; the cost is reported by `recent` so it is not a secret.
    if (this.used > this.budget) this.dropFuture()
  }
}

function sameMask(a: Mask, b: Mask): boolean {
  if (a.width !== b.width || a.height !== b.height) return false
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] !== b.values[i]) return false
  }
  return true
}
