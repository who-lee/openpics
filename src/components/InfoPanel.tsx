import { CalendarBlank, CaretRight, Copy, File, Folder, Image as ImageIcon, Ruler, Video } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { ExifData, Photo } from '@shared/protocol'
import { bridge } from '@/lib/bridge'
import { useLibrary } from '@/store/library'
import {
  formatBytes,
  formatCount,
  formatDate,
  formatDimensions,
  formatDuration,
  formatMegapixels,
  prettyPath
} from '@/lib/format'
import { Button } from './ui'

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5 py-[7px]">
      <span className="mt-[1px] shrink-0 text-ink-3">{icon}</span>
      <span className="w-[68px] shrink-0 text-[11px] text-ink-3">{label}</span>
      <span className="num min-w-0 flex-1 break-all text-[12px] text-ink">{value}</span>
    </div>
  )
}

/** Reads a stored "YYYY:MM:DD HH:MM:SS" stamp into epoch milliseconds. */
function parseExifDate(value?: string): number | null {
  if (!value) return null
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!match) return null
  const when = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  )
  return Number.isFinite(when.getTime()) ? when.getTime() : null
}

/** Renders an exposure time the way a camera does: 1/250s, or 2.5s. */
function formatShutter(seconds?: number): string {
  if (seconds === undefined || seconds <= 0) return ''
  if (seconds >= 1) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
  return `1/${Math.round(1 / seconds)}s`
}

function ExifSection({ photo }: { photo: Photo }) {
  const exif = useLibrary((state) => state.exifCache.get(photo.path)) as ExifData | null | undefined
  const loadExif = useLibrary((state) => state.loadExif)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setOpen(false)
    setLoading(false)
  }, [photo.path])

  const toggle = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (next && exif === undefined) {
      setLoading(true)
      try {
        await loadExif(photo.path)
      } finally {
        setLoading(false)
      }
    }
  }

  const rows: { label: string; value: string }[] = []
  if (exif) {
    const camera = exif.camera || [exif.Make, exif.Model].filter(Boolean).join(' ')
    const taken = parseExifDate(exif.DateTimeOriginal) ?? parseExifDate(exif.DateTime)
    if (camera) rows.push({ label: 'Camera', value: camera })
    if (exif.LensModel) rows.push({ label: 'Lens', value: exif.LensModel })
    if (taken !== null) rows.push({ label: 'Taken', value: formatDate(taken) })
    if (exif.FNumber) rows.push({ label: 'Aperture', value: `f/${exif.FNumber}` })
    const shutter = formatShutter(exif.ExposureTime)
    if (shutter) rows.push({ label: 'Shutter', value: shutter })
    if (exif.ISO) rows.push({ label: 'ISO', value: String(exif.ISO) })
    if (exif.FocalLength) rows.push({ label: 'Focal', value: `${Math.round(exif.FocalLength)} mm` })
    if (exif.Software) rows.push({ label: 'Software', value: exif.Software })
  }

  return (
    <div className="border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => void toggle()}
        className="flex w-full items-center gap-1.5 py-2 text-left text-[11px] text-ink-3 transition-colors duration-150 hover:text-ink"
      >
        <CaretRight
          size={10}
          weight="bold"
          className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        EXIF metadata
      </button>
      {open ? (
        loading ? (
          <p className="pb-2 text-[11px] text-ink-3">Reading…</p>
        ) : rows.length > 0 ? (
          <div className="pb-1">
            {rows.map((row) => (
              <div key={row.label} className="flex items-start gap-2.5 py-1">
                <span className="w-[68px] shrink-0 text-[11px] text-ink-3">{row.label}</span>
                <span className="num min-w-0 flex-1 break-all text-[12px] text-ink">{row.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="pb-2 text-[11px] text-ink-3">No metadata found for this file.</p>
        )
      ) : null}
    </div>
  )
}

export function InfoPanel({ photo, index, total }: { photo: Photo; index: number; total: number }) {
  const [copied, setCopied] = useState(false)

  const copyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(photo.path)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <span className="text-[12px] font-semibold">Details</span>
        <span className="num text-[11px] text-ink-3">
          {index + 1} / {total}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5">
        <p className="break-words py-2 text-[13px] font-medium leading-snug">{photo.name}</p>
        <div className="divide-y divide-line border-t border-line">
          <Row
            icon={<Ruler size={13} weight="regular" />}
            label="Pixels"
            value={`${formatDimensions(photo.width, photo.height)}${
              formatMegapixels(photo.width, photo.height) ? ` (${formatMegapixels(photo.width, photo.height)})` : ''
            }`}
          />
          {/* Only shown for a clip, and only once its duration is known. The scan
              leaves it at 0 to avoid an ffprobe run per file, so before the viewer
              has opened the clip the honest answer is that it is not measured. */}
          {photo.kind === 'video' && photo.durationSeconds > 0 ? (
            <Row
              icon={<Video size={13} weight="regular" />}
              label="Length"
              value={formatDuration(photo.durationSeconds)}
            />
          ) : null}
          <Row
            icon={<ImageIcon size={13} weight="regular" />}
            label="Format"
            value={photo.ext.toUpperCase()}
          />
          <Row
            icon={<File size={13} weight="regular" />}
            label="Size"
            value={formatBytes(photo.bytes)}
          />
          <Row
            icon={<CalendarBlank size={13} weight="regular" />}
            label="Modified"
            value={formatDate(photo.mtime)}
          />
          <Row
            icon={<Folder size={13} weight="regular" />}
            label="Folder"
            value={photo.relDir === '' ? 'folder root' : prettyPath(photo.relDir)}
          />
          <ExifSection photo={photo} />
        </div>

        <div className="border-t border-line py-2">
          <p className="mb-1.5 text-[11px] text-ink-3">Full path</p>
          <p className="num max-h-[104px] select-text overflow-y-auto break-all text-[11px] leading-relaxed text-ink-2">
            {photo.path}
          </p>
        </div>
      </div>

      <footer className="flex gap-1.5 border-t border-line p-2">
        <Button size="sm" variant="solid" className="flex-1" onClick={() => void bridge.shell.open(photo.path)}>
          Open
        </Button>
        <Button
          size="sm"
          className="flex-1"
          onClick={() => void bridge.shell.reveal(photo.path)}
        >
          <Folder size={13} weight="regular" />
          Show
        </Button>
        <Button size="sm" className="px-2" onClick={() => void copyPath()} title="Copy full path">
          <Copy size={13} weight="regular" />
          {copied ? <span className="num text-[11px] text-accent-text">ok</span> : null}
        </Button>
      </footer>
    </aside>
  )
}

export function PhotoCount({ shown, total }: { shown: number; total: number }) {
  return (
    <span className="num text-[11px] text-ink-3">
      {formatCount(shown)}
      {shown === total ? '' : ` of ${formatCount(total)}`}
    </span>
  )
}