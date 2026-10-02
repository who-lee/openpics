import { useState } from 'react'
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  Eraser,
  ImageSquare,
  PaintBrush,
  SpinnerGap
} from '@phosphor-icons/react'
import type { WallpaperFit } from '@shared/protocol'
import { FILTERS, NO_FILTER, findFilter } from '@shared/filters'
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

/**
 * What each edge refinement is for, in the words someone fixing a cutout would use.
 *
 * The radius is in pixels of the source picture, so a big photo needs a bigger
 * number than a small one. It is left off the controls that do not use it rather
 * than defaulted to a number that would be wrong on half the pictures out there.
 */
const REFINES: { operation: 'grow' | 'shrink' | 'despeckle' | 'fill_holes' | 'keep_largest'; label: string; title: string }[] = [
  { operation: 'grow', label: 'Grow', title: 'Take in a few pixels around the edge' },
  { operation: 'shrink', label: 'Shrink', title: 'Give back a few pixels around the edge' },
  { operation: 'despeckle', label: 'Despeckle', title: 'Drop the isolated bits left behind' },
  { operation: 'fill_holes', label: 'Fill holes', title: 'Close the gaps inside the subject' },
  { operation: 'keep_largest', label: 'Largest only', title: 'Discard everything but the biggest piece' }
]

const ROTATIONS = [0, 1, 2, 3]

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
  const [tool, setTool] = useState<'refine' | 'adjust'>('refine')
  const [edgeRadius, setEdgeRadius] = useState(2)
  const working = editor.busy !== null
  const open = editor.info !== null

  const adjust = editor.output.adjust ?? {}
  const setAdjust = (next: Partial<typeof adjust>): void => editor.setOutput({ adjust: next })
  // The preset behind whatever is currently chosen, or null when the picture is
  // unfiltered. Resolved through the catalogue rather than assumed to exist, so a
  // filter id from a session written by a newer build degrades to "no filter
  // shown" here instead of a chip that cannot be un-pressed.
  const activeFilter = findFilter(editor.output.filter?.id ?? NO_FILTER) ?? null
  const filterOn = activeFilter !== null && activeFilter.id !== NO_FILTER

  return (
    <aside className="flex w-[248px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-surface px-3 py-3">
      <div>
        <h2 className="text-[13px] font-semibold text-ink">Edit</h2>
        <p className="num mt-1 text-[11px] text-ink-3">
          {editor.info
            ? `${editor.projected ? `${editor.projected.width} x ${editor.projected.height} → ` : ''}${editor.removedPct.toFixed(1)}% removed`
            : 'Nothing open'}
        </p>
      </div>

      <Button
        variant="solid"
        size="sm"
        className="w-full"
        disabled={working || !open}
        onClick={() => void editor.cutout()}
      >
        Remove the background
      </Button>

      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="flex-1"
          disabled={working || !editor.history.canUndo}
          onClick={() => void editor.undo()}
          title="Undo the last change to the selection"
        >
          <ArrowCounterClockwise size={13} weight="regular" />
          Undo
        </Button>
        <Button
          size="sm"
          className="flex-1"
          disabled={working || !editor.history.canRedo}
          onClick={() => void editor.redo()}
          title="Redo what was just undone"
        >
          <ArrowClockwise size={13} weight="regular" />
          Redo
        </Button>
      </div>
      {editor.history.steps.length > 0 ? (
        <p className="-mt-2 text-[11px] leading-snug text-ink-3">
          {editor.history.steps.length} change{editor.history.steps.length === 1 ? '' : 's'}, newest{' '}
          <span className="text-ink-2">{editor.history.steps[editor.history.steps.length - 1]!.label}</span>
        </p>
      ) : null}

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

      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <Segmented
          label="Adjust"
          value={tool}
          onChange={setTool}
          options={[
            { value: 'refine', label: 'Selection', title: 'Tidy the cut-out edge' },
            { value: 'adjust', label: 'Picture', title: 'Crop, rotate, resize and tone' }
          ]}
        />

        {tool === 'refine' ? (
          <div className="flex flex-col gap-2">
            <Slider
              label="Edge amount"
              value={edgeRadius}
              min={1}
              max={24}
              step={1}
              onChange={setEdgeRadius}
              disabled={working}
              suffix="px"
            />
            <div className="flex flex-wrap gap-1.5">
              {REFINES.map((item) => (
                <Button
                  key={item.operation}
                  size="sm"
                  disabled={working || !open}
                  title={item.title}
                  onClick={() =>
                    void editor.select({
                      kind: 'refine',
                      operation: item.operation,
                      // The two operations that are not about the edge do not take
                      // an amount, and sending one they ignore would be a lie about
                      // what the button does.
                      ...(item.operation === 'fill_holes' || item.operation === 'keep_largest'
                        ? {}
                        : { radius: edgeRadius })
                    })
                  }
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                className="flex-1"
                disabled={working || !open}
                onClick={() => void editor.select({ kind: 'invert' })}
              >
                Invert
              </Button>
              <Button
                size="sm"
                className="flex-1"
                disabled={working || !open}
                onClick={() => void editor.select({ kind: 'all', state: 'removed' })}
                title="Hide the whole picture"
              >
                Clear
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Slider
              label="Brightness"
              value={adjust.brightness ?? 0}
              min={-100}
              max={100}
              step={2}
              onChange={(v) => setAdjust({ brightness: v === 0 ? undefined : v })}
              disabled={working}
            />
            <Slider
              label="Contrast"
              value={adjust.contrast ?? 0}
              min={-100}
              max={100}
              step={2}
              onChange={(v) => setAdjust({ contrast: v === 0 ? undefined : v })}
              disabled={working}
            />
            <Slider
              label="Saturation"
              value={adjust.saturation ?? 0}
              min={-100}
              max={100}
              step={2}
              onChange={(v) => setAdjust({ saturation: v === 0 ? undefined : v })}
              disabled={working}
            />
            {/* A named look, after the hand-tuned knobs rather than instead of them.
                They compose the way they read: the sliders set the picture up and the
                filter finishes it, so a user who has dialled in a contrast they likes
                can still put Warm on top of it. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-2">Filter</span>
              <div className="flex flex-wrap gap-1.5">
                {FILTERS.map((preset) => {
                  const chosen = (editor.output.filter?.id ?? NO_FILTER) === preset.id
                  return (
                    <Button
                      key={preset.id}
                      size="sm"
                      variant={chosen ? 'accent' : 'ghost'}
                      aria-pressed={chosen}
                      disabled={working || !open}
                      title={preset.hint}
                      onClick={() =>
                        editor.setOutput({
                          // Clicking the chosen filter again clears it, because a chip
                          // that cannot be switched off leaves a user who wants the
                          // original hunting for the Reset button, which also throws
                          // away their crop and their contrast.
                          filter: chosen ? undefined : preset.id === NO_FILTER ? undefined : { id: preset.id }
                        })
                      }
                    >
                      {preset.label}
                    </Button>
                  )
                })}
              </div>
              {filterOn && activeFilter ? <p className="text-[11px] leading-snug text-ink-3">{activeFilter.hint}</p> : null}
            </div>
            {filterOn && activeFilter && (editor.output.filter?.amount ?? 100) < 100 ? (
              <Slider
                label="Amount"
                value={editor.output.filter?.amount ?? 100}
                min={10}
                max={100}
                step={5}
                onChange={(v) =>
                  editor.setOutput({ filter: { id: activeFilter.id, ...(v === 100 ? {} : { amount: v }) } })
                }
                disabled={working}
                suffix="%"
                hint="full strength is 100%"
              />
            ) : null}
            <Slider
              label="Scale"
              value={editor.output.resize?.percent ?? 100}
              min={10}
              max={200}
              step={5}
              onChange={(v) => editor.setOutput({ resize: { percent: v === 100 ? undefined : v } })}
              disabled={working}
              suffix="%"
            />
            <div className="flex gap-1.5">
              {ROTATIONS.map((turns) => (
                <Button
                  key={turns}
                  size="sm"
                  className="flex-1"
                  disabled={working || !open}
                  onClick={() => editor.setOutput({ rotate: turns === 0 ? undefined : turns })}
                  title={turns === 0 ? 'Straighten the picture' : `Rotate ${turns * 90} degrees`}
                >
                  {turns * 90}°
                </Button>
              ))}
              <Button
                size="sm"
                className="flex-1"
                disabled={working || !open}
                onClick={() =>
                  editor.setOutput({
                    flip: editor.output.flip === 'horizontal' ? undefined : 'horizontal'
                  })
                }
                title="Mirror the picture left to right"
              >
                Flip
              </Button>
            </div>
            <Button
              size="sm"
              className="w-full"
              disabled={working || !open}
              onClick={() => editor.setOutput({ trim: editor.output.trim !== true })}
              title="Crop away the edges until only what is left is showing"
            >
              {editor.output.trim === true ? 'Keep the full picture' : 'Trim to the subject'}
            </Button>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                className="flex-1"
                disabled={working || !open}
                onClick={() =>
                  editor.setOutput({ background: editor.output.background === '#ffffff' ? undefined : '#ffffff' })
                }
                title="Put the cut-out on white instead of leaving it see-through"
              >
                {editor.output.background ? 'No fill' : 'White fill'}
              </Button>
              <Button
                size="sm"
                className="flex-1"
                disabled={working || !Object.keys(editor.output).length}
                onClick={editor.clearOutput}
                title="Put every setting on this tab back to how it was"
              >
                Reset
              </Button>
            </div>
          </div>
        )}
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
          onClick={() => {
            // The session's own reset keeps the output settings on purpose, because
            // "start over with the picture" should not throw away a crop somebody
            // chose deliberately. This button says it reverts everything, so it has
            // to mean that: the Picture tab's Reset is the one that touches only the
            // output settings.
            editor.clearOutput()
            void editor.reset()
          }}
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