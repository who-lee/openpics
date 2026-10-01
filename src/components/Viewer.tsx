import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowsIn, ArrowsOut, Info, PaintBrush, Pause, Play, X } from '@phosphor-icons/react'
import { fullUrl, type Photo } from '@shared/protocol'
import { useLibrary } from '@/store/library'
import { bridge } from '@/lib/bridge'
import { clamp, formatCount, formatSeconds } from '@/lib/format'
import { picturePointAt, type StrokePoint } from '@/lib/geometry'
import { useEditor } from '@/lib/useEditor'
import { EditPanel } from './EditPanel'
import { InfoPanel } from './InfoPanel'
import { IconButton, Button } from './ui'

const FADE_OUT_MS = 130
const MAX_FIT_UPSCALE = 2

interface Size {
  w: number
  h: number
}

export function Viewer() {
  const photos = useLibrary((s) => s.photos)
  const openIndex = useLibrary((s) => s.openIndex)
  const playing = useLibrary((s) => s.slideshowPlaying)
  const showInfo = useLibrary((s) => s.showInfo)
  const interval = useLibrary((s) => s.settings.slideIntervalMs)
  const { close, step, setSlideshow, toggleInfo } = useLibrary()

  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [natural, setNatural] = useState<Size>({ w: 0, h: 0 })
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [opacity, setOpacity] = useState(1)
  const [progress, setProgress] = useState(0)
  const [failure, setFailure] = useState(false)
  const [cursor, setCursor] = useState<{ x: number; y: number; r: number } | null>(null)

  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const swapTimer = useRef(0)
  const strokeRef = useRef<StrokePoint[]>([])

  const photo: Photo | null = openIndex === null ? null : (photos[openIndex] ?? null)

  const editor = useEditor(photo?.path ?? '')
  const painting = editor.active

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => {
      setViewport({ w: el.clientWidth, h: el.clientHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [openIndex])

  // Reset the view whenever the photo changes.
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setNatural({ w: 0, h: 0 })
    setFailure(false)
    setProgress(0)
  }, [openIndex])

  // Crossfade: fade out, swap the source under cover, fade back in.
  useEffect(() => {
    window.clearTimeout(swapTimer.current)
    if (photo === null) return
    setOpacity(0)
    swapTimer.current = window.setTimeout(() => setOpacity(1), FADE_OUT_MS)
    return () => window.clearTimeout(swapTimer.current)
  }, [photo?.path])

  // Warm the neighbours so stepping feels instant rather than fetching on click.
  useEffect(() => {
    if (openIndex === null || photos.length < 2) return
    for (const offset of [1, -1]) {
      const next = photos[(openIndex + offset + photos.length) % photos.length]
      if (next && NATIVE_OK(next)) {
        const img = new Image()
        img.src = fullUrl(next.path)
      }
    }
  }, [openIndex, photos])

  // Slideshow clock. One timer drives both the image swap and the accent
  // progress bar, so the bar cannot drift out of step with the advance.
  useEffect(() => {
    if (!playing || photo === null) return
    const started = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      const ratio = clamp((now - started) / interval, 0, 1)
      setProgress(ratio)
      if (ratio >= 1) step(1)
      else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, photo, interval, step])

  const fitScale = useMemo(() => {
    if (natural.w === 0 || viewport.w === 0) return 1
    return Math.min(viewport.w / natural.w, viewport.h / natural.h, MAX_FIT_UPSCALE)
  }, [natural, viewport])

  const displayW = natural.w * fitScale * zoom
  const displayH = natural.h * fitScale * zoom

  const clampPan = useCallback(
    (next: { x: number; y: number }, z: number): { x: number; y: number } => {
      const maxX = Math.max(0, (natural.w * fitScale * z - viewport.w) / 2)
      const maxY = Math.max(0, (natural.h * fitScale * z - viewport.h) / 2)
      return {
        x: clamp(next.x, -maxX, maxX),
        y: clamp(next.y, -maxY, maxY)
      }
    },
    [natural, fitScale, viewport]
  )

  const applyZoom = useCallback(
    (nextZoom: number, anchorX?: number, anchorY?: number): void => {
      setZoom((current) => {
        const z = clamp(nextZoom, 1, 12)
        if (anchorX === undefined || anchorY === undefined) {
          setPan((p) => clampPan(p, z))
          return z
        }
        // Keep the pixel under the cursor pinned while the scale changes.
        const ratio = z / current
        setPan((p) =>
          clampPan({ x: anchorX - (anchorX - p.x) * ratio, y: anchorY - (anchorY - p.y) * ratio }, z)
        )
        return z
      })
    },
    [clampPan]
  )

  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      // Zooming under a brush mid-stroke would move the picture out from under the
      // pointer, so the wheel does nothing while editing.
      if (painting) return
      event.preventDefault()
      const el = stageRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ax = event.clientX - rect.left - rect.width / 2
      const ay = event.clientY - rect.top - rect.height / 2
      const factor = Math.exp(-event.deltaY * 0.0016)
      applyZoom(zoom * factor, ax, ay)
    }
    const el = stageRef.current
    el?.addEventListener('wheel', onWheel, { passive: false })
    return () => el?.removeEventListener('wheel', onWheel)
  }, [zoom, applyZoom, painting])

  useEffect(() => {
    if (photo === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT') return
      const zoomed = zoom > 1.02
      const panStep = 48
      const nudge = (dx: number, dy: number): void => {
        event.preventDefault()
        setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }, zoom))
      }

      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          // Editing is the innermost thing open, so it is the first Escape takes
          // back. Dropping straight to the gallery would throw away a session's
          // work, which is exactly what a stray Escape should not do.
          if (painting) void editor.end()
          else if (showInfo) toggleInfo()
          else close()
          return
        case 'ArrowRight':
          event.preventDefault()
          if (zoomed) nudge(-panStep, 0)
          else step(1)
          return
        case 'ArrowLeft':
          event.preventDefault()
          if (zoomed) nudge(panStep, 0)
          else step(-1)
          return
        case 'ArrowUp':
          event.preventDefault()
          if (zoomed) nudge(0, panStep)
          return
        case 'ArrowDown':
          event.preventDefault()
          if (zoomed) nudge(0, -panStep)
          return
        case ' ':
        case 's':
        case 'S':
          event.preventDefault()
          setSlideshow(!playing)
          return
        case '+':
        case '=':
          event.preventDefault()
          applyZoom(zoom * 1.25)
          return
        case '-':
        case '_':
          event.preventDefault()
          applyZoom(zoom / 1.25)
          return
        case '0':
          event.preventDefault()
          applyZoom(1)
          return
        case 'f':
        case 'F':
          event.preventDefault()
          void bridge.win.fullscreen(true)
          return
        case 'i':
        case 'I':
          event.preventDefault()
          toggleInfo()
          return
        case 'e':
        case 'E':
          event.preventDefault()
          if (painting) void editor.end()
          else void editor.begin()
          return
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom, playing, showInfo, painting, step, close, setSlideshow, toggleInfo, applyZoom, clampPan, editor])

  if (photo === null || openIndex === null) return null

  const zoomPct = Math.round(zoom * 100)
  const oneToOne = natural.w > 0 ? natural.w / (natural.w * fitScale) : 1

  /** The size to lay out by: the picture's own size, even while a preview is up. */
  const shown: Size = editor.preview !== null && editor.info !== null
    ? { w: editor.info.width, h: editor.info.height }
    : natural

  /**
   * Maps the pointer onto the picture, in picture pixels.
   */
  const pointAt = (clientX: number, clientY: number): StrokePoint | null => {
    const img = imgRef.current
    if (!img || editor.info === null) return null
    return picturePointAt(img.getBoundingClientRect(), clientX, clientY, editor.info.width, editor.info.height)
  }

  /** Cursor ring radius, in stage pixels, so it shows the brush's true footprint. */
  const brushRadiusPx = (): number => {
    const img = imgRef.current
    if (!img || editor.info === null) return 0
    const rect = img.getBoundingClientRect()
    const scale = rect.width / editor.info.width
    return Math.max(1, Math.min(editor.info.width, editor.info.height) * (editor.radiusPct / 100)) * scale
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if (painting) {
      const point = pointAt(event.clientX, event.clientY)
      if (!point) return
      strokeRef.current = [point]
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (zoom <= 1.02) return
    dragRef.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (painting) {
      const stage = stageRef.current
      if (stage) {
        const rect = stage.getBoundingClientRect()
        setCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top, r: brushRadiusPx() })
      }
      // No pointer-down drag record is needed here: painting claims the pointer,
      // and a stroke that has started is the state being tracked.
      const point = pointAt(event.clientX, event.clientY)
      if (!point) return
      // Dropping points that sit almost on the last one keeps a slow drag from
      // handing over thousands of them.
      const previous = strokeRef.current[strokeRef.current.length - 1]
      if (previous && Math.abs(previous.x - point.x) < 1 && Math.abs(previous.y - point.y) < 1) return
      strokeRef.current.push(point)
      return
    }
    const drag = dragRef.current
    if (!drag) return
    setPan(clampPan({ x: drag.px + (event.clientX - drag.x), y: drag.py + (event.clientY - drag.y) }, zoom))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (strokeRef.current.length > 0) {
      const points = strokeRef.current
      strokeRef.current = []
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      void editor.stroke(points)
      return
    }
    if (dragRef.current) {
      event.currentTarget.releasePointerCapture(event.pointerId)
      dragRef.current = null
    }
  }

  const onPointerLeave = (): void => {
    // A stroke owns the pointer once it starts, so the ring is still wanted then.
    // The capture ends at pointerup, which fires the leave that clears it.
    if (strokeRef.current.length === 0) setCursor(null)
  }

  return (
    <div className="fixed inset-0 z-40 flex bg-base">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="drag caption-safe flex h-[var(--titlebar-h)] shrink-0 items-center gap-3 border-b border-line px-3">
          <span className="truncate text-[13px] font-medium">{photo.name}</span>
          <span className="num shrink-0 text-[11px] text-ink-3">
            {formatCount(openIndex + 1)} of {formatCount(photos.length)}
          </span>

          <div className="no-drag ml-auto flex items-center gap-1">
            <IconButton
              label="Zoom out"
              onClick={() => applyZoom(zoom / 1.25)}
              disabled={zoom <= 1}
            >
              <ArrowsIn size={15} weight="regular" />
            </IconButton>
            <button
              type="button"
              onClick={() => applyZoom(1)}
              title="Reset to fit"
              className="num h-7 min-w-[52px] rounded-[6px] px-1.5 text-[11px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              {zoomPct}%
            </button>
            <IconButton
              label="Zoom in"
              onClick={() => applyZoom(zoom * 1.25)}
              disabled={zoom >= 12}
            >
              <ArrowsOut size={15} weight="regular" />
            </IconButton>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
            <IconButton
              label="Edit this picture (E)"
              active={painting}
              onClick={() => (painting ? void editor.end() : void editor.begin())}
            >
              <PaintBrush size={15} weight="regular" />
            </IconButton>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
            <IconButton
              label="Slideshow (Space)"
              active={playing}
              onClick={() => setSlideshow(!playing)}
            >
              {playing ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
            </IconButton>
            <IconButton label="Details (I)" active={showInfo} onClick={toggleInfo}>
              <Info size={15} weight="regular" />
            </IconButton>
            <IconButton label="Close viewer (Escape)" onClick={close}>
              <X size={15} weight="bold" />
            </IconButton>
          </div>
        </header>

        <div
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={onPointerLeave}
          onDoubleClick={() => applyZoom(zoom > 1.02 ? 1 : oneToOne)}
          className={[
            'relative min-h-0 flex-1 overflow-hidden bg-base',
            painting ? 'cursor-none' : zoom > 1.02 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
          ].join(' ')}
        >
          {failure ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="text-[13px] text-ink-2">
                {photo.ext.toUpperCase()} cannot be displayed in the viewer.
              </p>
              <Button size="sm" variant="solid" onClick={() => void bridge.shell.open(photo.path)}>
                Open in the default app
              </Button>
            </div>
          ) : (
            <img
              ref={imgRef}
              src={editor.preview ?? fullUrl(photo.path)}
              alt={photo.name}
              draggable={false}
              decoding="async"
              onLoad={(event) => {
                // A preview is downscaled, so trusting its own natural size would
                // change the fit and make the picture jump under the cursor after
                // every stroke. The session's size is the picture's real size.
                if (editor.preview !== null) return
                const img = event.currentTarget
                setNatural({ w: img.naturalWidth, h: img.naturalHeight })
              }}
              onError={() => setFailure(true)}
              style={{
                width: shown.w > 0 ? displayW : 'auto',
                height: shown.h > 0 ? displayH : 'auto',
                transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                opacity: failure ? 0 : opacity,
                maxWidth: zoom > 1.02 ? 'none' : '100%',
                maxHeight: zoom > 1.02 ? 'none' : '100%',
                objectFit: 'contain'
              }}
              className={[
                'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
                'transition-opacity ease-out will-change-transform'
              ].join(' ')}
            />
          )}

          {painting && cursor !== null ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute rounded-full border border-white/70"
              style={{
                left: cursor.x,
                top: cursor.y,
                width: cursor.r * 2,
                height: cursor.r * 2,
                transform: 'translate(-50%, -50%)',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.5)'
              }}
            />
          ) : null}

          {zoom > 1.02 && !painting ? (
            <p className="num pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-[6px] border border-line bg-surface/90 px-2 py-1 text-[11px] text-ink-3">
              {zoomPct}% · drag to pan
            </p>
          ) : null}
        </div>

        <footer className="flex h-[30px] shrink-0 items-center gap-3 border-t border-line px-3">
          <span className="num text-[11px] text-ink-3">
            {formatSeconds(interval)} per shot
          </span>
          {playing ? (
            <div className="flex items-center gap-2">
              <div
                role="progressbar"
                aria-label="Slideshow progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                className="h-[3px] w-[180px] overflow-hidden rounded-full bg-line"
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <button
                type="button"
                onClick={() => setSlideshow(false)}
                title="Stop slideshow"
                className="num text-[11px] text-ink-3 transition-colors duration-150 hover:text-ink"
              >
                stop
              </button>
            </div>
          ) : null}
          <span className="num ml-auto text-[11px] text-ink-3">
            {natural.w > 0 ? `${natural.w} x ${natural.h}` : ''}
          </span>
        </footer>
      </div>

      {painting ? <EditPanel editor={editor} /> : null}
      {showInfo ? <InfoPanel photo={photo} index={openIndex} total={photos.length} /> : null}
    </div>
  )
}

function NATIVE_OK(photo: Photo): boolean {
  return !['heic', 'heif', 'tif', 'tiff'].includes(photo.ext)
}
