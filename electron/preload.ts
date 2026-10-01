import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { OpenPicsBridge } from '../shared/bridge'
import {
  COMMAND_CHANNEL,
  OPEN_FILES_CHANNEL,
  SCAN_PROGRESS_CHANNEL,
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL
} from '../shared/bridge'

/** Subscribes to a main-process channel and hands back an unsubscribe function. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * File hand-off, buffered from the moment the preload script runs.
 *
 * Main can deliver a launch argument as soon as the document has loaded, which
 * on a cold start is before React has mounted and subscribed. Listening here and
 * holding anything that arrives early is what makes a cold start from "Open with"
 * work: a message dropped at that moment would leave the app showing an empty
 * library with no indication the file was ever asked for.
 */
const pendingFiles: string[][] = []
let openFilesHandler: ((paths: string[]) => void) | null = null

ipcRenderer.on(OPEN_FILES_CHANNEL, (_event, paths: string[]) => {
  if (openFilesHandler) openFilesHandler(paths)
  else pendingFiles.push(paths)
})

const bridge: OpenPicsBridge = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (patch) => ipcRenderer.invoke('settings:patch', patch)
  },
  library: {
    defaultRoot: () => ipcRenderer.invoke('library:default-root'),
    pick: () => ipcRenderer.invoke('library:pick'),
    scan: (root, recursive) => ipcRenderer.invoke('library:scan', root, recursive),
    drives: () => ipcRenderer.invoke('library:drives'),
    scanComputer: () => ipcRenderer.invoke('library:scan-computer'),
    cancelScan: () => ipcRenderer.invoke('library:cancel-scan'),
    thumbStats: () => ipcRenderer.invoke('thumb:stats'),
    onScanProgress: (handler) => subscribe(SCAN_PROGRESS_CHANNEL, handler),
    onOpenFiles: (handler) => {
      openFilesHandler = handler
      // Anything buffered before now is delivered in arrival order, before main is
      // told a listener exists, so a flush cannot interleave with this batch.
      const buffered = pendingFiles.splice(0, pendingFiles.length)
      for (const paths of buffered) handler(paths)
      // Last, once this handler is in place: main flushes anything it was still
      // holding, which lands in the handler above rather than the buffer.
      void ipcRenderer.invoke('library:renderer-ready')
      return () => {
        if (openFilesHandler === handler) openFilesHandler = null
      }
    }
  },
  edit: {
    cutoutAuto: (path, options) => ipcRenderer.invoke('edit:cutout-auto', path, options ?? {}),
    open: (path, edit) => ipcRenderer.invoke('edit:open', path, edit),
    brush: (edit, options) => ipcRenderer.invoke('edit:brush', edit, options),
    selection: (edit, command) => ipcRenderer.invoke('edit:selection', edit, command),
    output: (edit, settings) => ipcRenderer.invoke('edit:output', edit, settings),
    undo: (edit) => ipcRenderer.invoke('edit:undo', edit),
    redo: (edit) => ipcRenderer.invoke('edit:redo', edit),
    history: (edit) => ipcRenderer.invoke('edit:history', edit),
    preview: (edit, options) => ipcRenderer.invoke('edit:preview', edit, options ?? {}),
    apply: (edit, options) => ipcRenderer.invoke('edit:apply', edit, options ?? {}),
    inspect: (edit) => ipcRenderer.invoke('edit:inspect', edit),
    reset: (edit) => ipcRenderer.invoke('edit:reset', edit),
    close: (edit) => ipcRenderer.invoke('edit:close', edit)
  },
  wallpaper: {
    get: () => ipcRenderer.invoke('wallpaper:get'),
    set: (path, fit) => ipcRenderer.invoke('wallpaper:set', path, fit ?? 'fill')
  },
  terminal: {
    available: () => ipcRenderer.invoke('terminal:available'),
    create: (options) => ipcRenderer.invoke('terminal:create', options ?? {}),
    attach: (id) => ipcRenderer.invoke('terminal:attach', id),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onData: (handler) => subscribe(TERMINAL_DATA_CHANNEL, handler),
    onExit: (handler) => subscribe(TERMINAL_EXIT_CHANNEL, handler)
  },
  shell: {
    reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
    open: (path) => ipcRenderer.invoke('shell:open', path),
    openUrl: (url) => ipcRenderer.invoke('shell:open-url', url),
    setFileAssociations: (enabled) => ipcRenderer.invoke('shell:associations', enabled),
    fileAssociations: () => ipcRenderer.invoke('shell:associations-status')
  },
  win: {
    alwaysOnTop: (value) => ipcRenderer.invoke('win:always-on-top', value),
    fullscreen: (value) => ipcRenderer.invoke('win:fullscreen', value),
    hide: () => ipcRenderer.invoke('win:hide'),
    show: () => ipcRenderer.invoke('win:show'),
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    state: () => ipcRenderer.invoke('win:state'),
    quit: () => ipcRenderer.invoke('win:quit')
  },
  onCommand: (handler) => {
    return subscribe(COMMAND_CHANNEL, handler)
  }
}

contextBridge.exposeInMainWorld('opencpics', bridge)
