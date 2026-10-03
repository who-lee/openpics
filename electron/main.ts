import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, shell } from 'electron'
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DriveInfo, ScanProgress, ScanResult, Settings, ThumbnailStats, WallpaperFit } from '../shared/protocol'
import type {
  ApplyOptions,
  BrushOptions,
  CutoutOptions,
  OutputSettings,
  PreviewOptions,
  SelectionCommand
} from '../shared/edit'
import { isImage, THUMB_SCHEME } from '../shared/protocol'
import { OPEN_FILES_CHANNEL, SCAN_PROGRESS_CHANNEL } from '../shared/bridge'
import { cancelScan, listDrives, scanComputer, scanFolder } from './scanner'
import {
  disposeEdits,
  handleApply,
  handleBrush,
  handleClose,
  handleCutoutAuto,
  handleHistory,
  handleInspect,
  handleOpen,
  handleOutput,
  handlePreview,
  handleRedo,
  handleReset,
  handleSelection,
  handleUndo
} from './editing'
import { clearThumbMemory, registerThumbScheme, setAllowedRoots, thumbStats } from './thumbs'
import { defaultRoot, loadSettings, saveSettings } from './settings'
import {
  attachTerminal,
  createTerminal,
  killAllTerminals,
  killTerminal,
  killTerminalsForOwner,
  resizeTerminal,
  terminalAvailable,
  writeTerminal
} from './terminal'
import type { TerminalCreateOptions } from '../shared/terminal'
import { ensureFileAssociations, fileAssociationsEnabled, setFileAssociations } from './shellassoc'
import { getWallpaper, setWallpaper } from '../core/wallpaper'
import { sendToBin } from '../core/recyclebin'
import { addonStatuses, refreshAddonStatuses } from '../core/addons/detect'
import { concatVideos, extractFrame, splitVideo, trimVideo } from '../core/video/edit'
import { probeVideo } from '../core/video/probe'
import { isVideoName, type ConcatRequest, type FrameRequest, type SplitRequest, type TrimRequest } from '../shared/video'
import { buildTray, updateTray, type TrayRef } from './tray'

const WINDOW_W = 1280
const WINDOW_H = 840
const MIN_W = 720
const MIN_H = 520
const TITLEBAR_H = 44

let win: BrowserWindow | null = null
let tray: TrayRef | null = null
let quitting = false

/**
 * The thumbnail protocol must be declared privileged before the app is ready,
 * otherwise Chromium treats it as an opaque scheme with no fetch support.
 *
 * `bypassCSP` is required, not cosmetic. It defaults to false, and without it
 * Chromium's CSP parser does not recognise a runtime-registered scheme, so the
 * renderer's own `img-src 'self' openpics-thumb: data: blob:` blocks every
 * thumbnail and every full-size viewer image. Only this one allowlisted scheme
 * is exempt; scripts, inline script and foreign connections stay blocked.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: THUMB_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

function broadcast(command: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('opencpics:command', command)
}

/** Locks the renderer down: no popups, no foreign navigation, no device permissions. */
function hardenWindow(target: BrowserWindow): void {
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  target.webContents.on('will-navigate', (event, url) => {
    const here = target.webContents.getURL()
    try {
      if (new URL(url).origin === new URL(here).origin) return
    } catch {
      /* an unparseable target is not a same-origin navigation */
    }
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  target.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  target.webContents.session.setPermissionCheckHandler(() => false)
}

function createWindow(): BrowserWindow {
  const settings = loadSettings()

  const created = new BrowserWindow({
    width: WINDOW_W,
    height: WINDOW_H,
    minWidth: MIN_W,
    minHeight: MIN_H,
    show: false,
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
    // Native caption buttons drawn over our own titlebar. CSS reserves the right
    // padding via --titlebar-h so nothing renders underneath them.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0b0c',
      symbolColor: '#8e8e97',
      height: TITLEBAR_H
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  hardenWindow(created)

  // Captured now: a destroyed webContents cannot be asked for its id later.
  const owner = created.webContents.id
  // A reload wipes the renderer's tabs, so any shell it started would be orphaned
  // with no way to reach it. Taking them down with the document is the safe read.
  created.webContents.on('did-navigate', () => killTerminalsForOwner(owner))

  created.once('ready-to-show', () => {
    if (settings.launchMinimized) {
      created.hide()
      broadcast('hide')
    } else {
      created.show()
    }
  })

  created.on('close', (event) => {
    if (quitting) return
    if (loadSettings().closeToTray) {
      event.preventDefault()
      created.hide()
      broadcast('hide')
      tray?.flash()
    }
  })

  created.on('closed', () => {
    killTerminalsForOwner(owner)
    win = null
    // A closed window reloads with a fresh renderer, which must re-announce.
    rendererReady = false
  })

  void created.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? join(__dirname, '../renderer/index.html'))

  return created
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Image paths handed to us by Windows, from the context-menu verb or an
 * "Open with" launch.
 *
 * Queued until the renderer announces it is listening, rather than until the
 * document finishes loading. `did-finish-load` fires before React has mounted and
 * subscribed, so it is too early: a cold start from "Open with" would deliver the
 * paths to a preload buffer nobody was reading yet. The renderer announces itself
 * once its subscription exists, and the preload script buffers anything that
 * arrives even earlier, so no delivery can be lost in between.
 */
let pendingFiles: string[] = []
let rendererReady = false

function deliverFiles(paths: string[]): void {
  if (paths.length === 0) return
  if (!rendererReady) {
    pendingFiles = [...pendingFiles, ...paths]
    return
  }
  if (win && !win.isDestroyed()) win.webContents.send(OPEN_FILES_CHANNEL, paths)
}

/**
 * Picks openable files out of an argv vector: pictures and clips.
 *
 * Chromium injects its own switches (`--user-data-dir=...` in particular, which
 * the test harness relies on), so anything starting with a dash is skipped, and
 * each remaining argument is confirmed to be an existing file rather than trusted
 * on the strength of its extension alone.
 *
 * Renamed from `imagePathsFromArgv` because it no longer opens only images. The
 * name was the reason a clip on the command line was silently dropped: the
 * extension check read `isImage`, and the old name made that look deliberate.
 */
function libraryPathsFromArgv(argv: string[]): string[] {
  const found: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-')) continue
    if (!isImage(arg) && !isVideoName(arg)) continue
    try {
      const full = resolve(arg)
      if (statSync(full).isFile()) found.push(full)
    } catch {
      /* a path that no longer exists is not worth reporting */
    }
  }
  return found
}

/** Forwards a walk's progress to the renderer, which is the only thing that can show it. */
function sendProgress(progress: ScanProgress): void {
  if (win && !win.isDestroyed()) win.webContents.send(SCAN_PROGRESS_CHANNEL, progress)
}

import { autotagPhoto, ensurePromptFile, findBundledModels, getAiState, initAi, pickDefaultModel } from './ai'

function wireIpc(): void {
  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:patch', (_e, patch: Partial<Settings>) => {
    const wasTerminalOn = loadSettings().enableTerminal
    const next = saveSettings(patch)
    nativeTheme.themeSource = next.theme
    // Turning the terminal off only stopped *new* shells from being created:
    // `createTerminal` re-reads the setting and refuses, but every already-open
    // PTY kept running with full filesystem access. A user who switches it off
    // expects the shells to go, not to go quiet.
    if (wasTerminalOn && !next.enableTerminal) killAllTerminals()
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(next.alwaysOnTop)
      win.setTitleBarOverlay?.({
        color: next.theme === 'dark' ? '#0b0b0c' : '#fafafa',
        symbolColor: next.theme === 'dark' ? '#8e8e97' : '#55555c',
        height: TITLEBAR_H
      })
    }
    return next
  })

  ipcMain.handle('library:default-root', () => defaultRoot())

  ipcMain.handle(
    'library:pick',
    async (): Promise<{ canceled: boolean; path?: string }> => {
      if (!win) return { canceled: true }
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose a folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: loadSettings().root || defaultRoot()
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      return { canceled: false, path: result.filePaths[0]! }
    }
  )

  ipcMain.handle('library:scan', async (_e, root: string, recursive: boolean): Promise<ScanResult> => {
    // Every scan re-pins the allowlist, so the protocol can never serve a path
    // from a folder the user did not just choose.
    setAllowedRoots([root])
    clearThumbMemory()
    // Folder walks report progress too: a deep tree on a spinning disk takes
    // long enough that the window would otherwise look frozen.
    return scanFolder(root, recursive, sendProgress)
  })

  ipcMain.handle('library:drives', (): DriveInfo[] => listDrives())

  ipcMain.handle('library:scan-computer', async (): Promise<ScanResult> => {
    // Computer mode needs thumbnails from every drive, so the allowlist becomes
    // the whole machine. This is the same trust decision as a folder scan, just
    // wider: the protocol can only serve an image path, and the renderer already
    // has arbitrary code execution over the user's own pictures.
    const drives = listDrives().filter((drive) => !drive.unreadable)
    setAllowedRoots(drives.map((drive) => drive.root))
    clearThumbMemory()
    return scanComputer(sendProgress)
  })

  ipcMain.handle('library:cancel-scan', () => {
    cancelScan()
  })

  // Sent by the preload script the moment the renderer has a file listener, which
  // is strictly later than the document load and strictly earlier than any user
  // interaction. Only then is it safe to hand over queued paths.
  ipcMain.handle('library:renderer-ready', () => {
    rendererReady = true
    if (pendingFiles.length === 0) return
    const queued = pendingFiles
    pendingFiles = []
    if (win && !win.isDestroyed()) win.webContents.send(OPEN_FILES_CHANNEL, queued)
  })

  ipcMain.handle('thumb:stats', (): ThumbnailStats => ({ ...thumbStats }))

  ipcMain.handle('edit:cutout-auto', (_e, path: string, options: CutoutOptions) => handleCutoutAuto(path, options))
  ipcMain.handle('edit:open', (_e, path: string, edit?: string) => handleOpen(path, edit))
  ipcMain.handle('edit:brush', (_e, edit: string, options: BrushOptions) => handleBrush(edit, options))
  ipcMain.handle('edit:selection', (_e, edit: string, command: SelectionCommand) => handleSelection(edit, command))
  ipcMain.handle('edit:output', (_e, edit: string, settings: OutputSettings | null) => handleOutput(edit, settings))
  ipcMain.handle('edit:undo', (_e, edit: string) => handleUndo(edit))
  ipcMain.handle('edit:redo', (_e, edit: string) => handleRedo(edit))
  ipcMain.handle('edit:history', (_e, edit: string) => handleHistory(edit))
  ipcMain.handle('edit:preview', (_e, edit: string, options: PreviewOptions) => handlePreview(edit, options))
  ipcMain.handle('edit:apply', (_e, edit: string, options: ApplyOptions) => handleApply(edit, options))
  ipcMain.handle('edit:inspect', (_e, edit?: string) => handleInspect(edit))
  ipcMain.handle('edit:reset', (_e, edit: string) => handleReset(edit))
  ipcMain.handle('edit:close', (_e, edit: string) => handleClose(edit))

  ipcMain.handle('ai:init', async () => {
    const state = await initAi()
    return state
  })

  ipcMain.handle('ai:state', async () => getAiState())

  ipcMain.handle('ai:listModels', async () => findBundledModels())

  ipcMain.handle('ai:setModel', async (_e, path: string) => {
    const s = getAiState()
    const next = { ...s, modelPath: path, modelName: path.split(/[\\\\\\/]/).pop() || null, ready: !!path }
    return next
  })

  ipcMain.handle('ai:getPrompt', async () => {
    const p = await ensurePromptFile()
    const { readPromptFile } = await import('./ai/prompt')
    return { path: p, content: readPromptFile() }
  })

  ipcMain.handle('ai:setPrompt', async (_e, content: string) => {
    const { writePromptFile } = await import('./ai/prompt')
    await writePromptFile(content)
    const p = await ensurePromptFile()
    const { readPromptFile } = await import('./ai/prompt')
    return { path: p, content: readPromptFile() }
  })

  ipcMain.handle('ai:chat', async (_e, message: string) => {
    // Placeholder: return acknowledgment; real llama.cpp integration later
    return { content: '' }
  })

  ipcMain.handle('ai:autotag', async (_e, photoIds: string[]) => {
    const res: Array<{ photoId: string; tags: string[] }> = []
    for (const id of photoIds) res.push({ photoId: id, tags: [] })
    return res
  })
  ipcMain.handle('wallpaper:get', () => getWallpaper())
  // Deliberately not debounced or rate-limited: the user asked for this desktop
  // and is watching it change. Nothing else in the app calls it.
  ipcMain.handle('wallpaper:set', (_e, path: string, fit: WallpaperFit) => setWallpaper(path, fit))

  ipcMain.handle('shell:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
  })
  ipcMain.handle('shell:open', async (_e, path: string) => {
    await shell.openPath(path)
  })

ipcMain.handle('shell:open-url', async (_e, url: string) => {
      // Anything but http(s) is refused rather than handed to the OS: file:// and
      // smb:// would let a compromised renderer open local content off-screen.
      if (!/^https?:\/\//i.test(url)) return
      await shell.openExternal(url)
    })

    ipcMain.handle('shell:bin', (_e, paths: string[]) => sendToBin(paths))

  ipcMain.handle('shell:associations', async (_e, enabled: boolean) => {
    const next = await setFileAssociations(enabled)
    // The setting is the user's stated preference, so keep the two in step.
    saveSettings({ shellIntegration: next })
    return next
  })
  ipcMain.handle('shell:associations-status', () => fileAssociationsEnabled())

  ipcMain.handle('win:always-on-top', (_e, value: boolean) => {
    win?.setAlwaysOnTop(value)
    return win?.isAlwaysOnTop() ?? value
  })
  ipcMain.handle('win:fullscreen', (_e, value: boolean) => {
    win?.setFullScreen(value)
    return win?.isFullScreen() ?? value
  })
  ipcMain.handle('win:hide', () => win?.hide())
  ipcMain.handle('win:show', () => showWindow())
  ipcMain.handle('win:minimize', () => win?.minimize())
  ipcMain.handle('win:state', () => ({
    maximized: win?.isMaximized() ?? false,
    fullScreen: win?.isFullScreen() ?? false,
    visible: win?.isVisible() ?? false
  }))
  ipcMain.handle('win:toggle-maximize', () => {
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('win:quit', () => {
    quitting = true
    app.quit()
  })

  // The renderer never names a program: it opens a shell from the fixed list and
  // then talks to it by opaque id. Every call is scoped to the window that owns
  // the session, so one window cannot drive another's shell.
  ipcMain.handle('terminal:available', () => terminalAvailable())
  ipcMain.handle('terminal:create', (event, options: TerminalCreateOptions) =>
    createTerminal(event.sender.id, options ?? {})
  )
  ipcMain.handle('terminal:attach', (event, id: string) => attachTerminal(event.sender.id, id))
  ipcMain.handle('terminal:write', (event, id: string, data: string) => {
    writeTerminal(event.sender.id, id, data)
  })
  ipcMain.handle('terminal:resize', (event, id: string, cols: number, rows: number) => {
    resizeTerminal(event.sender.id, id, cols, rows)
  })
  ipcMain.handle('terminal:kill', (event, id: string) => {
    killTerminal(event.sender.id, id)
  })

  // Addon detection. `list` is cached inside core, so repeated calls from the
  // Settings panel cost nothing; `refresh` exists because the user may have
  // installed something since the app started, and a stale tick would be worse
  // than a re-probe.
  //
  // There is no `install` handler, and that is deliberate. Everything OpenPics
  // ships is already inside the installer, so there is nothing for it to fetch,
  // and a handler taking a URL would let a renderer name any binary on the disk.
  // A missing optional tool gets a link to its vendor instead.
  ipcMain.handle('addons:list', () => addonStatuses())
  ipcMain.handle('addons:refresh', () => refreshAddonStatuses())

  // Video. All of these write a new file and refuse to touch a source, so there is
  // no confirmation prompt here - unlike shell:associations, nothing the renderer
  // can ask for is irreversible.
  ipcMain.handle('video:probe', (_e, path: string) => probeVideo(path))
  ipcMain.handle('video:trim', (_e, request: TrimRequest) => trimVideo(request))
  ipcMain.handle('video:split', (_e, request: SplitRequest) => splitVideo(request))
  ipcMain.handle('video:concat', (_e, request: ConcatRequest) => concatVideos(request))
  ipcMain.handle('video:frame', (_e, request: FrameRequest) => extractFrame(request))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A second launch, from the context menu or "Open with", carries the file
  // arguments. The first element is always the executable, so it is skipped.
  app.on('second-instance', (_event, argv) => {
    showWindow()
    deliverFiles(libraryPathsFromArgv(argv.slice(1)))
  })

  app.whenReady().then(() => {
    const settings = loadSettings()
    nativeTheme.themeSource = settings.theme

    registerThumbScheme()
    wireIpc()
    win = createWindow()
    win.setAlwaysOnTop(settings.alwaysOnTop)

    // A cold start with files on the command line: the window is not listening
    // yet, so these queue until did-finish-load.
    deliverFiles(libraryPathsFromArgv(process.argv.slice(1)))

    // Registering the context-menu entries is a handful of registry writes plus a
    // PowerShell round trip, which has no business blocking first paint. The
    // setting stays the source of truth; the registry is reconciled to it.
    //
    // A failure here is not fatal: the app works with the entries absent, and the
    // toggle in Settings reports the real state next time it is opened. Swallowing
    // it keeps a locked-down or policy-restricted registry from surfacing as an
    // unhandled rejection with nothing to show for it.
    void ensureFileAssociations(settings.shellIntegration).catch(() => false)

    tray = buildTray({
      onShow: showWindow,
      onCommand: broadcast,
      onQuit: () => {
        quitting = true
        app.quit()
      }
    })
    updateTray(tray, { slideshow: false, count: 0 })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
      else showWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    disposeEdits()
    // Shells are child processes of the app: they must not be left running.
    killAllTerminals()
  })

  app.on('window-all-closed', () => {
    // Close-to-tray prevents the close entirely, so this only fires on a real quit.
    app.quit()
  })
}



