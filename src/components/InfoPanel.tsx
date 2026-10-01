import { CalendarBlank, Copy, File, Folder, Image as ImageIcon, Ruler, Video } from '@phosphor-icons/react'
import { useState } from 'react'
import type { Photo } from '@shared/protocol'
import { bridge } from '@/lib/bridge'
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