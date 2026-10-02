import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync, unlinkSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { BinResult } from '../shared/types'
import { psJson, psStringArray } from './powershell'

/**
 * Re-exported so the MCP server keeps importing the delete result from here,
 * where it has always lived, while the shape itself sits in `shared` next to the
 * other types the renderer is allowed to see.
 */
export type { BinResult }

/** One deleted item, as recorded by the Recycle Bin. */
export interface BinEntry {
  /**
   * Opaque handle for a deleted item, shared by its `$I` record and `$R` payload.
   * This is what `restore` and `purge` take. It is not a path and must never be
   * treated as one.
   */
  id: string
  /** Where the item lived before it was deleted. */
  originalPath: string
  /** File name as it was before deletion. */
  originalName: string
  /** Size in bytes, from the record rather than from the payload on disk. */
  bytes: number
  /** When it was deleted, in epoch milliseconds. */
  deletedAt: number
  /** Extension, lowercase and without the dot. "" when there was none. */
  ext: string
  /** True while the `$R` payload is still on disk. */
  payloadPresent: boolean
}

/**
 * Directory holding the current user's Recycle Bin.
 *
 * The obvious route - asking the shell for the bit-bucket folder - does not work:
 * `NameSpace(0xA).Self.Path` answers with a shell namespace identifier such as
 * `::{645FF040-5081-101B-9F08-00AA002F954E}`, not a path anything can be read
 * from. The bin is really `<system drive>\$Recycle.Bin\<user SID>`, and the SID
 * is available without a registry read.
 *
 * The enumeration fallback covers the case where the directory is not named
 * after the SID, which happens with some domain and roaming profiles. Any
 * directory holding an `$I` record is a working bin for some user, and the
 * current user's is the one that will hold their own files.
 */
export async function binDir(): Promise<string> {
  const found = await psJson<{ path: string }>(`
$root = Join-Path $env:SystemDrive '$Recycle.Bin'
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$path = Join-Path $root $sid
if (-not (Test-Path -LiteralPath $path)) {
  $candidate = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    Where-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '$I*' -ErrorAction SilentlyContinue | Select-Object -First 1 } |
    Select-Object -First 1
  if ($null -ne $candidate) { $path = $candidate.FullName }
}
[pscustomobject]@{ path = $path } | ConvertTo-Json -Compress
`)
  return found.path
}

/**
 * Reads one `$I` record, which is what makes a deleted file recoverable.
 *
 * The format is undocumented but stable. Version 2, the only one Windows 10 and 11
 * write, is a 28-byte header followed by the original path as UTF-16LE and a
 * length in characters; version 1, from Vista through Windows 8, has the same
 * first 24 bytes and then a fixed 260-character buffer. Getting this wrong
 * produces a plausible-looking path that restores nothing, so the version is
 * checked rather than assumed.
 */
function parseInfoRecord(buf: Buffer): { originalPath: string; bytes: number; deletedAt: number } | null {
  if (buf.length < 24) return null
  const version = buf.readBigUInt64LE(0)
  const bytes = Number(buf.readBigUInt64LE(8))
  const fileTime = buf.readBigUInt64LE(16)
  // FILETIME counts 100ns ticks from 1601; the epoch offset is 11644473600000ms.
  const deletedAt = Number(fileTime / 10000n - 11644473600000n)

  if (version === 2n) {
    if (buf.length < 28) return null
    const chars = buf.readUInt32LE(24)
    if (chars === 0 || 28 + chars * 2 > buf.length + 2) return null
    const text = buf.toString('utf16le', 28, 28 + Math.max(0, chars - 1) * 2)
    return text ? { originalPath: text, bytes, deletedAt } : null
  }

  if (version === 1n) {
    const text = buf.toString('utf16le', 24, 24 + 520)
    const originalPath = text.split('\0')[0] ?? ''
    return originalPath ? { originalPath, bytes, deletedAt } : null
  }

  return null
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Turns an id back into the two files that make up one deleted item.
 *
 * The id reaches this module from a language model, so it is validated rather
 * than joined onto a path. `$Recycle.Bin` is a real directory the user can write
 * to; a crafted id containing `..` would otherwise be able to move a file out of
 * it or delete something the caller never named.
 */
function pathsFor(dir: string, id: string): { info: string; payload: string } {
  if (!id || id.length > 255) throw new Error(`invalid recycle bin id: ${JSON.stringify(id)}`)
  if (id.includes('/') || id.includes('\\') || id.includes(':') || id === '.' || id === '..') {
    throw new Error(`invalid recycle bin id: ${JSON.stringify(id)}`)
  }
  if (id.includes('..')) throw new Error(`invalid recycle bin id: ${JSON.stringify(id)}`)
  return { info: join(dir, `$I${id}`), payload: join(dir, `$R${id}`) }
}

export async function listBin(): Promise<BinEntry[]> {
  const dir = await binDir()
  if (!existsSync(dir)) return []

  const entries: BinEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('$I')) continue
    const id = name.slice(2)
    const { info, payload } = pathsFor(dir, id)
    const parsed = parseInfoRecord(readFileSync(info))
    if (!parsed) continue
    const originalName = basename(parsed.originalPath)
    entries.push({
      id,
      originalPath: parsed.originalPath,
      originalName,
      bytes: parsed.bytes,
      deletedAt: parsed.deletedAt,
      ext: extOf(originalName),
      payloadPresent: existsSync(payload)
    })
  }
  return entries.sort((a, b) => b.deletedAt - a.deletedAt)
}

const SHELL_OP = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace OpenPics {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    public IntPtr pFrom;
    public IntPtr pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    public IntPtr lpszProgressTitle;
  }
  public static class ShellFileOp {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint SHFileOperation(ref SHFILEOPSTRUCT op);
  }
}
'@
`

/**
 * Moves files to the Recycle Bin, the way Explorer does.
 *
 * `FOF_ALLOWUNDO` is the entire difference between this and a permanent delete,
 * so it is the flag that matters; the rest only keep the operation silent. A
 * silent move is not a cosmetic choice here: the same call is made from an agent,
 * and a confirmation dialog would leave the process blocked on input that nothing
 * is going to answer.
 *
 * Items are sent one at a time so a single locked or vanished file cannot fail
 * the batch, which is what Explorer does and what makes a partial result useful.
 */
export async function sendToBin(paths: readonly string[]): Promise<BinResult[]> {
  if (paths.length === 0) return []

  const script = `${SHELL_OP}
$results = @()
foreach ($path in ${psStringArray(paths)}) {
  $code = 0
  $ptr = [IntPtr]::Zero
  try {
    if (-not (Test-Path -LiteralPath $path)) { throw 'file no longer exists' }
    # SHFileOperation wants a double-null-terminated list, not a bare string.
    $ptr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($path + [char]0 + [char]0)
    $op = New-Object OpenPics.SHFILEOPSTRUCT
    $op.hwnd = [IntPtr]::Zero
    $op.wFunc = 3                                   # FO_DELETE
    $op.pFrom = $ptr
    $op.pTo = [IntPtr]::Zero
    $op.fFlags = 0x0004 -bor 0x0010 -bor 0x0040 -bor 0x0400
    # SILENT | NOCONFIRMATION | ALLOWUNDO | NOERRORUI
    $op.fAnyOperationsAborted = $false
    $op.hNameMappings = [IntPtr]::Zero
    $op.lpszProgressTitle = [IntPtr]::Zero
    $code = [OpenPics.ShellFileOp]::SHFileOperation([ref]$op)
    if ($code -ne 0) { throw "SHFileOperation returned $code" }
    if ($op.fAnyOperationsAborted) { throw 'operation aborted' }
    $results += [pscustomobject]@{ path = $path; ok = $true; error = $null }
  } catch {
    $results += [pscustomobject]@{ path = $path; ok = $false; error = $_.Exception.Message }
  } finally {
    if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @($results)
`

  return psJson<BinResult[]>(script).then((r) => (Array.isArray(r) ? r : [r]))
}

export interface RestoreOptions {
  /** Replace a file already sitting at the original path. Off by default. */
  overwrite?: boolean
}

/**
 * Puts a deleted item back where it came from.
 *
 * The original path comes from the `$I` record, so it is the user's own history
 * rather than anything the caller supplied. It is still resolved and checked to
 * be absolute before anything is written, because this is the one operation here
 * that creates a file at a path the caller did not name.
 */
export async function restore(id: string, opts: RestoreOptions = {}): Promise<string> {
  const dir = await binDir()
  const { info, payload } = pathsFor(dir, id)
  if (!existsSync(info)) throw new Error(`no recycle bin item with id ${id}`)
  if (!existsSync(payload)) throw new Error(`item ${id} has no payload on disk; it cannot be restored`)

  const parsed = parseInfoRecord(readFileSync(info))
  if (!parsed) throw new Error(`recycle bin record for ${id} could not be read`)
  const target = resolve(parsed.originalPath)
  if (!isAbsolute(parsed.originalPath)) {
    throw new Error(`item ${id} records a relative path and cannot be restored safely`)
  }

  if (existsSync(target) && !opts.overwrite) {
    throw new Error(`${target} already exists; pass overwrite to replace it`)
  }
  mkdirSync(dirname(target), { recursive: true })

  try {
    renameSync(payload, target)
  } catch (err) {
    // A rename across volumes fails, which happens when a drive letter changed
    // since the deletion. Copying and unlinking is slower but still correct.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw err
    copyFileSync(payload, target)
    unlinkSync(payload)
  }

  rmSync(info, { force: true })
  return target
}

/** Permanently removes one item. There is no undo for this. */
export async function purge(id: string): Promise<void> {
  const dir = await binDir()
  const { info, payload } = pathsFor(dir, id)
  if (!existsSync(info) && !existsSync(payload)) throw new Error(`no recycle bin item with id ${id}`)
  rmSync(payload, { force: true })
  rmSync(info, { force: true })
}

/** Permanently removes everything in the bin. There is no undo for this. */
export async function emptyBin(): Promise<number> {
  const entries = await listBin()
  for (const entry of entries) await purge(entry.id)
  return entries.length
}

function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || (p.startsWith(sep) && p.length > 1)
}

/** Bytes on disk in the bin's payload directory, for a quick summary. */
export async function binStats(): Promise<{ items: number; bytes: number }> {
  const dir = await binDir()
  if (!existsSync(dir)) return { items: 0, bytes: 0 }
  let bytes = 0
  let items = 0
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('$R')) continue
    try {
      bytes += statSync(join(dir, name)).size
      items++
    } catch {
      // A payload can vanish under us if the bin is being emptied in Explorer.
    }
  }
  return { items, bytes }
}
