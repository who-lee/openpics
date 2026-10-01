import { execFile } from 'node:child_process'
import { app } from 'electron'
import { promisify } from 'node:util'
import { IMAGE_EXTS } from '../shared/protocol'

const run = promisify(execFile)

/**
 * Context-menu and "Open with" registration for OpenPics.
 *
 * Everything is written under HKCU, so no administrator rights are needed and
 * nothing outside this user's profile is touched.
 *
 * Two separate registrations, because Windows reads them from different places:
 *
 *  1. `SystemFileAssociations\.<ext>\shell\OpenPics` is the context-menu verb.
 *     Adding a verb here is purely additive: the default handler for the
 *     extension is never written, so this cannot steal a user's file association.
 *
 *  2. `Applications\OpenPics.exe` is what populates the "Open with" list, via
 *     `shell\open\command` plus `SupportedTypes`.
 *
 * The verb is deliberately created without an `Extended` subkey, so it appears on
 * a plain right-click rather than only on Shift+right-click.
 */

/** Verb name. Must be a plain identifier: it is the registry key name. */
const VERB = 'OpenPics'

/** The Open With entry is keyed by the executable's own name, as Explorer expects. */
const APP_KEY = 'OpenPics.exe'

/** Only the bits of Electron this module needs, so the logic can be tested alone. */
export interface ShellContext {
  /** A development binary must never register itself as a user's image app. */
  isPackaged: boolean
  exe: string
}

function liveContext(): ShellContext {
  return { isPackaged: app.isPackaged, exe: app.getPath('exe') }
}

/**
 * The command string stored under `shell\open\command`.
 *
 * Plain quotes, not escaped ones. `reg.exe` is invoked without a shell here, so
 * the argv reaches it verbatim and any backslashes before a quote would be stored
 * as literal characters, leaving Windows with a malformed command line. The quotes
 * are needed because the install path contains spaces.
 */
function commandValue(exe: string): string {
  return `"${exe}" "%1"`
}

function iconValue(exe: string): string {
  return `"${exe}",0`
}

async function regAdd(key: string, valueName: string | null, data: string): Promise<void> {
  const args = ['add', key]
  // /ve targets the key's default value; /v names a value explicitly.
  if (valueName === null) args.push('/ve')
  else args.push('/v', valueName)
  args.push('/d', data, '/f')
  await run('reg.exe', args, { windowsHide: true })
}

async function regDelete(key: string): Promise<void> {
  try {
    await run('reg.exe', ['delete', key, '/f'], { windowsHide: true })
  } catch {
    /* deleting something that was never there is the desired end state */
  }
}

async function regExists(key: string): Promise<boolean> {
  try {
    await run('reg.exe', ['query', key], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Tells Explorer the association tables changed, so a new context-menu entry
 * shows up without restarting the shell.
 *
 * Best effort by design: a failure here costs an Explorer restart at worst, never
 * correctness, so it must never reject.
 */
async function notifyShell(): Promise<void> {
  const signature =
    '[DllImport("shell32.dll")] public static extern void ' +
    'SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'
  const script = [
    'Add-Type -Namespace Win -Name Shell -MemberDefinition',
    `'${signature}'`,
    '-Name Space',
    '[Win.Shell]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)'
  ].join(' ')
  try {
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 8000 }
    )
  } catch {
    /* Explorer picks the change up on its own eventually */
  }
}

/** True when the entries are present, according to the registry itself. */
export async function fileAssociationsEnabledWith(
  ctx: ShellContext,
  classesRoot = 'HKCU\\Software\\Classes'
): Promise<boolean> {
  if (!ctx.isPackaged) return false
  const first = [...IMAGE_EXTS][0]
  if (!first) return false
  return regExists(`${classesRoot}\\SystemFileAssociations\\.${first}\\shell\\${VERB}`)
}

/** Adds or removes every entry. Resolves to the resulting state. */
export async function setFileAssociationsWith(
  ctx: ShellContext,
  enabled: boolean,
  classesRoot = 'HKCU\\Software\\Classes'
): Promise<boolean> {
  // Registering the development binary would put a bogus "electron.exe" entry in
  // the user's Open With list, so dev runs deliberately do nothing.
  if (!ctx.isPackaged) return false

  const appRoot = `${classesRoot}\\Applications\\${APP_KEY}`

  if (!enabled) {
    for (const ext of IMAGE_EXTS) {
      await regDelete(`${classesRoot}\\SystemFileAssociations\\.${ext}\\shell\\${VERB}`)
    }
    await regDelete(appRoot)
    await notifyShell()
    return false
  }

  await regAdd(appRoot, 'ApplicationName', 'OpenPics')
  // DefaultIcon is a key whose default value holds the icon reference, not a
  // value named DefaultIcon: Windows only reads it in the key form.
  await regAdd(`${appRoot}\\DefaultIcon`, null, iconValue(ctx.exe))
  await regAdd(`${appRoot}\\shell\\open\\command`, null, commandValue(ctx.exe))

  for (const ext of IMAGE_EXTS) {
    const verbRoot = `${classesRoot}\\SystemFileAssociations\\.${ext}\\shell\\${VERB}`
    await regAdd(verbRoot, 'MUIVerb', 'Open with OpenPics')
    await regAdd(verbRoot, 'Icon', iconValue(ctx.exe))
    await regAdd(`${verbRoot}\\command`, null, commandValue(ctx.exe))
    // Empty data is what marks a type as handled; the value name is the extension.
    await regAdd(`${appRoot}\\SupportedTypes`, `.${ext}`, '')
  }

  await notifyShell()
  return true
}

/**
 * Brings the registry in line with the requested state, but only when they
 * actually disagree. Called at startup, so the common case is one `reg query`.
 */
export async function ensureFileAssociationsWith(
  ctx: ShellContext,
  enabled: boolean,
  classesRoot = 'HKCU\\Software\\Classes'
): Promise<boolean> {
  if (!ctx.isPackaged) return false
  const current = await fileAssociationsEnabledWith(ctx, classesRoot)
  if (current === enabled) return current
  return setFileAssociationsWith(ctx, enabled, classesRoot)
}

export const fileAssociationsEnabled = (): Promise<boolean> =>
  fileAssociationsEnabledWith(liveContext())

export const setFileAssociations = (enabled: boolean): Promise<boolean> =>
  setFileAssociationsWith(liveContext(), enabled)

export const ensureFileAssociations = (enabled: boolean): Promise<boolean> =>
  ensureFileAssociationsWith(liveContext(), enabled)
