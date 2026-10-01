import type { WallpaperFit, WallpaperState } from '../shared/protocol'
import { psJson, psString, powershell } from './powershell'

export type { WallpaperFit, WallpaperState }

/**
 * `WallpaperStyle` and `TileWallpaper` under `HKCU\Control Panel\Desktop` are the
 * undocumented pair of values Explorer itself writes, and these are the numbers
 * it understands. No API sets them, which is why changing a wallpaper takes both
 * a registry write and a P/Invoke.
 */
const STYLE: Record<WallpaperFit, { style: number; tile: string }> = {
  fill: { style: 10, tile: '0' },
  fit: { style: 6, tile: '0' },
  stretch: { style: 2, tile: '0' },
  center: { style: 0, tile: '0' },
  span: { style: 22, tile: '0' },
  tile: { style: 0, tile: '1' }
}

const FIT_FROM_STYLE: Record<number, WallpaperFit> = {
  10: 'fill',
  6: 'fit',
  2: 'stretch',
  22: 'span'
}

export async function getWallpaper(): Promise<WallpaperState> {
  const state = await psJson<{ wallpaper: string; style: number | null; tile: string | null }>(`
$key = 'HKCU:\\Control Panel\\Desktop'
$wallpaper = ''
$style = $null
$tile = $null
if (Test-Path $key) {
  $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if ($null -ne $item) {
    $names = $item.PSObject.Properties.Name
    if ($names -contains 'Wallpaper') { $wallpaper = [string]$item.Wallpaper }
    if ($names -contains 'WallpaperStyle') { $style = [int]$item.WallpaperStyle }
    if ($names -contains 'TileWallpaper') { $tile = [string]$item.TileWallpaper }
  }
}
[pscustomobject]@{ wallpaper = $wallpaper; style = $style; tile = $tile } | ConvertTo-Json -Compress
`)

  let fit: WallpaperFit | null = null
  if (state.style !== null) {
    fit = state.tile === '1' && state.style === 0 ? 'tile' : (FIT_FROM_STYLE[state.style] ?? null)
  }
  return { path: state.wallpaper, fit }
}

/**
 * Sets the desktop background to `path`.
 *
 * The style is written before the P/Invoke rather than after. The broadcast makes
 * Explorer repaint from the registry, so a wallpaper applied before its style
 * would be laid out using whatever fit was left over from last time.
 */
export async function setWallpaper(path: string, fit: WallpaperFit = 'fill'): Promise<void> {
  // `fit` arrives over IPC and from MCP tool arguments, so the type is only a
  // claim at runtime. An unknown key would read as undefined here and reach
  // PowerShell as an empty style number, leaving the desktop in a strange state.
  const choice = Object.prototype.hasOwnProperty.call(STYLE, fit) ? STYLE[fit] : null
  if (choice === null) {
    throw new Error(`unknown wallpaper fit ${JSON.stringify(fit)}`)
  }
  const { style, tile } = choice

  await powershell(`
$key = 'HKCU:\\Control Panel\\Desktop'
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
New-ItemProperty -Path $key -Name 'WallpaperStyle' -Value ${style} -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $key -Name 'TileWallpaper' -Value '${tile}' -PropertyType String -Force | Out-Null
`)

  await powershell(`
Add-Type -Namespace OpenPics -Name Wallpaper -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
'@
# SPI_SETDESKWALLPAPER records the path; the flags are what make it apply now
# (SPIF_UPDATEINIFILE) and make Explorer repaint without a logoff (SPIF_SENDCHANGE).
# SystemParametersInfo returns nonzero on success, so a zero is the failure case.
$code = [OpenPics.Wallpaper]::SystemParametersInfo(0x0014, 0, ${psString(path)}, 0x03)
if ($code -eq 0) { throw "SystemParametersInfo failed with $code" }
`)
}
