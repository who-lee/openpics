# OpenPics

A fast desktop picture browser for Windows, with a built-in background remover
and an MCP server so an AI agent can search, edit, and file your photos.

Free and open source under the Apache License 2.0.

## Why

Most picture browsers are file managers with a preview bolted on. Most photo
editors are subscription products that want your whole library. OpenPics does
one thing well and keeps your pictures on your machine:

- **Nothing leaves the computer.** No upload, no telemetry, no account. The app
  has no network code at all. Your photos are read from disk and never sent
  anywhere.
- **The editing is local and real.** Background removal, brush erase, and
  restore run on your CPU. Saving writes a new PNG and leaves the original
  untouched.
- **An agent can drive it.** An MCP server exposes search, describe, edit, and
  wallpaper tools, so a coding agent can find a photo and remove its background
  without you driving the GUI.

## Install

Grab `OpenPics-1.0.0-beta.5-setup.exe` from
[releases](https://github.com/who-lee/openpics/releases) and run it. Windows
11, x64. No installer dependencies: the PNG and JPEG codecs are part of the app,
so there is no native image library to ship.

## Using it

| Key | Action |
| --- | --- |
| `E` | Edit the current picture |
| `Space` | Slideshow |
| `I` | Details |
| `S` | Sort |
| `` Ctrl + ` `` | Terminal |
| `?` | All shortcuts |

To remove a background: press `E`, then **Remove the background**. Adjust
tolerance if it missed too much or too little. Fix mistakes with the brush:
**Erase** clears, **Restore** brings pixels back. Drag on the picture to paint.

**Filters** give a finished picture a look: Punch, Mono, Sepia, Warm, Cool,
Faded, Noir, Vintage and Cinematic. Each has a strength slider, the preview
updates as you move it, and clicking the selected filter again turns it off.
Filters run after any manual adjustments, so they apply to the picture you
actually made.

**Save a copy** writes a new PNG next to the original and leaves the source
file alone. Nothing touches the disk until you do.

**Set as wallpaper** stays disabled until you have saved a copy, because
anything else would set the desktop to an image that only exists in memory.

**Terminal** is off until you switch it on in Settings. It opens a real shell,
PowerShell or cmd, in a drawer along the bottom of the window. It runs with
your normal user rights, so anything typed in it can change files on this PC.
The drawer keeps its scrollback while it is hidden, and its shells close with
the window — and switching the terminal off in Settings closes the shells that
are already open.

## Video

Clips are listed alongside pictures and open in the same viewer, which plays
them with the usual controls.

MP4, WebM, MOV, OGV and 3GP play in the viewer. FLV, WMV, MPEG and MPEG-TS are
listed and open in whatever your system uses instead, because Chromium has no
decoder for them.

Editing clips needs **FFmpeg**, which is downloaded at package time and shipped
inside the app; nothing is fetched at runtime. **Settings → External tools** shows
which tools were found, at which path, and which version. Clips are measured when
you open them, not during a scan — a scan across a whole drive would otherwise
spawn an ffprobe process per video before the first tile appeared.

Python, Node and Git are optional and used by the agent tooling. They are
detected the same way but never downloaded; the Settings panel links to each
project if you want to install one.

Copying, trimming, splitting, concatenating, extracting a frame and applying a
filter run through `core/video/edit.ts` and are exposed to agents as
`video_trim`, `video_split`, `video_concat`, `video_frame` and `video_filter`.
Every one writes a new file next to the source and refuses to overwrite it.

The same filters as pictures apply to video, from the same catalogue in
`shared/filters.ts`, so `noir` means the same thing either side. Pass one as
`filter` to `video_filter`, `video_trim`, `video_split` or `video_concat`. A
filtered clip is always re-encoded, because the picture data has changed and the
streams cannot be copied; the resolution is kept exactly, since rounding an odd
width or height would change the frame size.

FFmpeg's filters are matched to the picture maths rather than assumed to agree.
Tone work is one `lutrgb` pass and saturation uses `hue`, because this FFmpeg
build has no `eq` filter. `tests/video.test.mjs` renders every preset through
the shipped binary, so a filter that is missing from this build fails there
instead of failing for a user.

## The MCP server

```bash
npm install
npm run mcp
```

Exposes `photos_find`, `photos_describe`, `edit_cutout_auto`, `edit_brush`,
`edit_output`, `edit_preview`, `edit_apply`, `edit_inspect`, `video_addons`,
`video_probe`, `video_trim`, `video_split`, `video_concat`, `video_frame`,
`video_filter`, `wallpaper_get`, `wallpaper_set`, and a recycle bin
(`bin_list`, `bin_send`, `bin_restore`, `bin_purge`, `bin_empty`).

`edit_output` and the four writing video tools take a `filter`, named from the
shared catalogue. `edit_output` holds it between calls, so null turns it off
again; the video tools apply it per call and re-encode when one is given.

The four writing video tools take structured arguments — a start time, a frame
number, a list of paths. There is no way to pass a raw FFmpeg command line, so an
agent cannot be talked into running a flag that was not designed for.

Deletes go to a bin rather than unlinking, so a wrong agent call is
recoverable. `bin_purge` is the destructive one and is named accordingly.

The tools can be turned off from the app, under Settings → Agent (MCP). Turning
**Allow agent tools** off makes every tool refuse with an explanation, including
the ones that only read. The server re-reads that setting on every call rather
than once at startup, so a switch flipped while an agent is mid-session takes
effect immediately. An agent that launched the server before you switched it off
cannot be revoked from the app — it holds the process — so the setting is the
floor, not the ceiling.

Point an agent at it by adding the command to your MCP client config:

```json
{
  "mcpServers": {
    "openpics": {
      "command": "node",
      "args": ["C:/path/to/openpics/dist-mcp/mcp/server.js"]
    }
  }
}
```

## Building

```bash
npm install
npm run dev         # run from source
npm run typecheck   # node, web, and mcp projects
npm run addons      # download FFmpeg into vendor/ (also run by prepackage)
npm run build       # bundle to out/
npm run package:dir # unpacked build in release/win-unpacked
npm run package     # installer in release/
```

`npm run addons` downloads the FFmpeg build into `vendor/addons`, which is
gitignored and is not part of a source checkout. `npm run package` runs it
automatically through `prepackage`, so a release build has video support without
a separate step. The download is verified against a pinned SHA-256 before
anything is unpacked, and binaries matching the current pin are left alone on a
re-run.

To check a different archive, set `OPENPICS_FFMPEG_SHA256`.

### Which FFmpeg, and why

The build is BtbN's `win64-lgpl` FFmpeg for Windows. The LGPL matters because
OpenPics is Apache-2.0: an FFmpeg build containing GPL encoders would put GPL
obligations on the distributed app as a whole, whereas the LGPL line can be
shipped as a separate executable without that. Gyan's builds - the more commonly
linked ones - are all GPLv3, so they are not an option here.

The practical consequence is which encoders are available. This build has no
libx264 or libx265, so accurate edits (the frame-exact `accurate` option on trim,
split, and concat) encode H.264 with OpenH264 and H.265 with Kvazaar instead.
OpenH264 has no constant-quality mode, so it is given a bitrate derived from the
source resolution and frame rate. It is also restricted to `yuv420p`, which
cannot represent an odd width or height, so a clip with an odd dimension loses its
last row and column on an accurate re-encode - the trim succeeds, but the picture
is one pixel narrower or shorter.

FFmpeg is invoked as a separate process, never linked into OpenPics, and is
redistributed unmodified. `vendor/addons/FFMPEG-LICENSE.txt` ships alongside the
binaries and `FFMPEG-BUILD.txt` records the pinned archive plus the corresponding
FFmpeg source, which is what LGPL section 4 asks a distributor to provide.

## How it fits together

```
core/       pure TypeScript, no Electron: image codecs, editing ops, wallpaper,
            video probe/edit, external-tool detection
electron/   main process, preload bridge, filesystem scanner
shared/     wire types shared by all three layers
src/        React renderer
mcp/        Model Context Protocol server over core/
```

`core/` is deliberately free of Electron imports. That is what lets the MCP
server reuse the exact same editing code the GUI uses, and it means the image
codecs are testable without launching an app.

The renderer is sandboxed with context isolation. It has no filesystem access
except through the named channels in `electron/preload.ts`, and each of those has
a handler registered in the main process.

## Security

Report vulnerabilities through GitHub's private advisory form rather than a
public issue: **Repo → Security → Report a vulnerability**. See
[SECURITY.md](SECURITY.md) for what to include and what is in scope.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm run package:dir` before
opening a pull request that touches `core/` or `electron/` — bundling can break
code that passes typecheck.

## License

Apache License 2.0. See [LICENSE](LICENSE).

Commercial use is permitted. Any distribution must keep the NOTICE file and
credit **OpenPics by Hen (Lee Muriithi Kingori, [who-lee](https://github.com/who-lee))**,
including in an About or Credits screen.

The packaged application also ships FFmpeg, which is licensed separately under
the LGPL — see [Which FFmpeg, and why](#which-ffmpeg-and-why) above. FFmpeg is
 redistributed unmodified as a separate executable.
See [NOTICE](NOTICE) for the full terms.

## Credits

- **[OpenPics by Hen (Lee Muriithi Kingori)](https://github.com/who-lee)** ([who-lee](https://github.com/who-lee)) — design and code
- **a cute Ai bot made this project** — assistance throughout
- [bylestramk.org](https://bylestramk.org) — support
- [Donate on PayPal](https://www.paypal.com/ncp/payment/QDRSPAFCKTLXE)

## How to use it

[src/HOW-TO-USE.txt](src/HOW-TO-USE.txt) walks through the whole app in
plain text: browsing, filtering and sorting, the hover card and right-click
menu, the viewer, background removal, video, the Recycle Bin, every setting,
and what to try when something looks wrong. Press `?` inside the app for the
keyboard list.
