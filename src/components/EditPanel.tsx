import { useState } from 'react'
import { Eraser, ImageSquare, PaintBrush, SpinnerGap } from '@phosphor-icons/react'
import type { WallpaperFit } from '@shared/protocol'
import {
  RADIUS_MAX_PCT,
  RADIUS_MIN_PCT,
  TOLERANCE_DEFAULT,
  TOLERANCE_MAX,
  TOLERANCE_MIN,
  type Editor
} from '@/lib/useEditor'
import { Button, IconButton, Segmented } from './ui'

const FITS: { value: WallpaperFit; label: string }[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'span', label: 'Span' },
  { value: 'center', label: 'Center' },
  { value: 'tile', label: 'Tile' }
]

interface EditPanelProps {
  editor: Editor
}

/**
 * The editing controls, down the side of the viewer.
 *
 * Everything here acts on the open session, so the panel stays useful no matter
 * which picture is on screen: nothing here names a file.
 */
export function EditPanel({ editor }: EditPanelProps) {
  const [fit, setFit] = useState<WallpaperFit>('fill')
  const working = editor.busy !== null

  return (
    <aside className="flex w-[248px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-surface px-3 py-3">
      <div>
        <h2 className="text-[13px] font-semibold text-ink">Edit</h2>
        <p className="num mt-1 text-[11px] text-ink-3">
          {editor.info
            ? `${editor.info.width} x ${editor.info.height} · ${editor.removedPct.toFixed(1)}% removed`
            : 'Nothing open'}
        </p>
      </div>

      <Button
        variant="solid"
        size="sm"
        className="w-full"
        disabled={working || editor.info === null}
        onClick={() => void editor.cutout()}
      >
        Remove the background
      </Button>

      <div className="flex flex-col gap-2">
        <Slider
          label="Tolerance"
          value={editor.tolerance}
          min={TOLERANCE_MIN}
          max={TOLERANCE_MAX}
          step={2}
          onChange={editor.setTolerance}
          disabled={working}
          hint={editor.tolerance === TOLERANCE_DEFAULT ? 'default' : undefined}
        />
        <Slider
          label="Brush size"
          value={editor.radiusPct}
          min={RADIUS_MIN_PCT}
          max={RADIUS_MAX_PCT}
          step={1}
          onChange={editor.setRadiusPct}
          disabled={working}
          suffix="%"
        />
        <Slider
          label="Hardness"
          value={editor.hardness}
          min={0}
          max={1}
          step={0.05}
          onChange={editor.setHardness}
          disabled={working}
        />
        <Segmented
          label="Brush"
          value={editor.mode}
          onChange={editor.setMode}
          options={[
            { value: 'erase', label: 'Erase', title: 'Hide what you paint over' },
            { value: 'restore', label: 'Restore', title: 'Bring back what you paint over' }
          ]}
        />
      </div>

      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="flex-1"
          disabled={working || editor.info?.hasEdits !== true}
          onClick={() => void editor.apply()}
        >
          Save a copy
        </Button>
        <IconButton
          label="Start over"
          size="sm"
          disabled={working || editor.info?.hasEdits !== true}
          onClick={() => void editor.reset()}
        >
          <Eraser size={14} weight="regular" />
        </IconButton>
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <Segmented label="Wallpaper fit" value={fit} onChange={setFit} options={FITS} />
        <Button
          size="sm"
          className="w-full"
          disabled={working || !editor.canSetWallpaper}
          onClick={() => void editor.setWallpaper(fit)}
          title={
            editor.canSetWallpaper
              ? 'Change the desktop background to this picture'
              : 'Save a copy first, then it can be used as a wallpaper'
          }
        >
          <ImageSquare size={13} weight="regular" />
          Set as wallpaper
        </Button>
        {!editor.canSetWallpaper && editor.info !== null ? (
          <p className="text-[11px] leading-snug text-ink-3">
            Unsaved edits only exist in this window. Save a copy first.
          </p>
        ) : null}
      </div>

      {working ? (
        <p className="flex items-center gap-1.5 text-[11px] text-ink-3">
          <SpinnerGap size={12} className="animate-spin" />
          {editor.busy}
        </p>
      ) : null}
      {editor.error !== null ? <p className="text-[11px] leading-snug text-accent-text">{editor.error}</p> : null}
      {editor.note !== null ? <p className="text-[11px] leading-snug text-ink-3">{editor.note}</p> : null}

      <p className="mt-auto flex items-start gap-1.5 text-[11px] leading-snug text-ink-3">
        <PaintBrush size={12} className="mt-0.5 shrink-0" />
        Drag on the picture to paint. Nothing is changed on disk until you save a copy.
      </p>
    </aside>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  disabled?: boolean
  suffix?: string
  hint?: string
}

/**
 * A labelled range control.
 *
 * `num` on the readout keeps the digits from shifting as the value changes, which
 * on a bare range input looks like the slider is drifting.
 */
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled = false,
  suffix = '',
  hint
}: SliderProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline gap-1.5 text-[12px] text-ink-2">
        {label}
        {hint ? <span className="text-ink-3">{hint}</span> : null}
        <span className="num ml-auto text-ink-3">
          {step < 1 ? value.toFixed(2) : Math.round(value)}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-line accent-[var(--accent)] disabled:opacity-40"
      />
    </label>
  )
}