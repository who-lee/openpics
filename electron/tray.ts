import { Menu, nativeImage, Tray, type NativeImage } from 'electron'

export interface TrayHandlers {
  onShow: () => void
  onCommand: (command: string) => void
  onQuit: () => void
}

export interface TrayRef {
  tray: Tray
  /** Rebuilds the context menu and swaps the icon for the current state. */
  render: (state: TrayState) => void
  /** Draws attention once when a close-to-tray hide happens. */
  flash: () => void
}

export interface TrayState {
  slideshow: boolean
  count: number
}

/**
 * Builds a 16x16 PNG on the fly so the app has a real icon without shipping a
 * binary asset through the build pipeline. The mark is a safelight dot inside a
 * frame, matching the in-app accent.
 */
function makeIcon(active: boolean): NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)

  const put = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = a
  }

  const frame = active ? [226, 84, 46] : [142, 142, 151]
  const dot = active ? [255, 150, 110] : [120, 120, 128]

  // Rounded 1px frame drawn as four 2px bars.
  for (let x = 1; x < size - 1; x++) {
    put(x, 1, frame[0]!, frame[1]!, frame[2]!, 255)
    put(x, 2, frame[0]!, frame[1]!, frame[2]!, 255)
    put(x, size - 3, frame[0]!, frame[1]!, frame[2]!, 255)
    put(x, size - 2, frame[0]!, frame[1]!, frame[2]!, 255)
  }
  for (let y = 1; y < size - 1; y++) {
    put(1, y, frame[0]!, frame[1]!, frame[2]!, 255)
    put(2, y, frame[0]!, frame[1]!, frame[2]!, 255)
    put(size - 3, y, frame[0]!, frame[1]!, frame[2]!, 255)
    put(size - 2, y, frame[0]!, frame[1]!, frame[2]!, 255)
  }

  // Centre dot with a soft falloff so it does not read as a hard hole.
  for (let y = 4; y < 12; y++) {
    for (let x = 4; x < 12; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5)
      const a = Math.max(0, Math.min(1, 3.6 - d))
      if (a > 0) put(x, y, dot[0]!, dot[1]!, dot[2]!, Math.round(a * 255))
    }
  }

  // Raw RGBA pixels, so this must be createFromBitmap. createFromBuffer
  // expects an encoded PNG or JPEG and would silently yield an empty image.
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 1 })
}

export function buildTray(handlers: TrayHandlers): TrayRef {
  const tray = new Tray(makeIcon(false))
  tray.setToolTip('OpenPics')

  let flashed = false
  const ref: TrayRef = {
    tray,
    // Replaced immediately below, once the menu builder is in scope.
    render: () => undefined,
    flash: () => {
      if (flashed) return
      flashed = true
      tray.displayBalloon?.({
        title: 'OpenPics is still running',
        content: 'Click the tray icon to bring the window back.'
      })
    }
  }

  const render = (state: TrayState): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: state.count > 0 ? `${state.count} pictures loaded` : 'No folder scanned',
          enabled: false
        },
        { type: 'separator' },
        { label: 'Open OpenPics', click: () => handlers.onShow() },
        { type: 'separator' },
        { label: 'Previous', click: () => handlers.onCommand('previous') },
        {
          label: state.slideshow ? 'Stop slideshow' : 'Start slideshow',
          click: () => handlers.onCommand('slideshow')
        },
        { label: 'Next', click: () => handlers.onCommand('next') },
        { type: 'separator' },
        { label: 'Quit OpenPics', click: () => handlers.onQuit() }
      ])
    )
    tray.setImage(makeIcon(state.slideshow))
  }

  ref.render = render
  tray.on('click', () => handlers.onShow())
  tray.on('double-click', () => handlers.onShow())
  render({ slideshow: false, count: 0 })
  return ref
}

export function updateTray(ref: TrayRef | null, state: TrayState): void {
  if (!ref) return
  ref.render(state)
}