import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Fail on the first error rather than letting a cmdlet write to stderr and carry
 * on, and force UTF-8 on the way out so non-ASCII paths survive the pipe.
 */
const PRELUDE = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.Encoding]::UTF8;'

/**
 * Runs a PowerShell script and returns stdout with the BOM removed.
 *
 * The script travels as `-EncodedCommand` (base64 of UTF-16LE) rather than as an
 * inline command. PowerShell re-parses its own argv, and an inline script long
 * enough to contain a path is exactly where that re-parsing goes wrong; encoding
 * the whole thing makes the round trip exact.
 *
 * `windowsHide` matches the convention in electron/shellassoc.ts: no console
 * window flashes for an operation the user never asked to see.
 */
export async function powershell(script: string, timeoutMs = 30000): Promise<string> {
  const encoded = Buffer.from(PRELUDE + script, 'utf16le').toString('base64')
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }
  )
  return stdout.replace(/^\uFEFF/, '')
}

/**
 * A PowerShell expression yielding the UTF-8 text of `value`.
 *
 * Paths reaching these scripts come from a language model, so they are never
 * pasted in as PowerShell literals. A single-quoted literal would need every `'
 * doubled, would still let a `$` expand inside a double-quoted one, and would
 * leave a path in the clear in a transcript. Carrying the bytes as base64 and
 * decoding at runtime removes the escaping problem and makes it impossible for a
 * path to be read as code.
 */
export function psString(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`
}

/** A PowerShell expression yielding a `[string[]]`, from a list of values. */
export function psStringArray(values: readonly string[]): string {
  return `(@(${values.map(psString).join(',')}))`
}

/**
 * Runs a script that prints a JSON document, and parses it.
 *
 * This deliberately does not append a `ConvertTo-Json` of its own. It did, and
 * that meant every caller's output was serialised twice - the second pass quoted
 * the first pass's JSON as a plain string, so the parse produced a string where
 * an object was expected and every field read as undefined. Serialising in one
 * place, at the point where the object is built, is also what lets the object
 * cross the pipe as real JSON instead of something PowerShell reformats for us.
 */
export function psJson<T>(body: string): Promise<T> {
  return powershell(body).then((out) => JSON.parse(out.trim()) as T)
}
