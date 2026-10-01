/** 1.4 MB. Not rounded to a fake tidy number, because a tidy number is a lie. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat(undefined).format(n)
}

export function formatDimensions(width: number, height: number): string {
  if (width <= 0 || height <= 0) return 'unknown size'
  return `${formatCount(width)} x ${formatCount(height)}`
}

export function formatMegapixels(width: number, height: number): string {
  if (width <= 0 || height <= 0) return ''
  const mp = (width * height) / 1_000_000
  return mp >= 1 ? `${mp.toFixed(1)} MP` : `${Math.round(mp * 1000)} kpx`
}

/** Path with the home directory replaced by a tilde, so long paths stay readable. */
export function prettyPath(full: string): string {
  const marker = '\\Users\\'
  const idx = full.indexOf(marker)
  if (idx > 0) {
    const rest = full.slice(idx + marker.length)
    const slash = rest.indexOf('\\')
    if (slash > 0) return `~\\${rest.slice(slash + 1)}`
  }
  return full
}

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(new Date(ms))
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function formatSeconds(ms: number): string {
  const s = Math.round(ms / 100) / 10
  return `${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`
}

/**
 * A clip's running time, as `m:ss`, or `h:mm:ss` past an hour.
 *
 * Distinct from `formatSeconds`, which formats a slideshow interval in
 * milliseconds. Overloading one of them for two units is exactly how a viewer
 * ends up labelling a 6-minute clip "0.4s".
 *
 * Returns '' for an unknown duration so a caller can print nothing rather than
 * a confident `0:00` for a clip it has not measured yet.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}