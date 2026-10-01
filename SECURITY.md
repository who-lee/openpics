## Security

Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests. Use the private reporting flow instead:

**Repo → Security → Report a vulnerability** (green "New draft security
advisory" button)

That opens a private thread visible only to you and the maintainer, which means
a vulnerability is not published before a fix exists. Please include:

- what the issue is, and the impact you believe it has
- the OpenPics version (`Settings` shows it) and your OS version
- steps to reproduce, ideally minimal
- any log output or a screenshot, with local paths redacted if you prefer

You can expect an acknowledgement within 72 hours and an assessment within seven
days. Confirmed issues are fixed in a new patch release, and you are credited in
the release notes unless you ask not to be. Please allow a reasonable window
(90 days) before public disclosure.

### What to look for

This app reads the photos on your machine, decodes untrusted image bytes, and
shells out to PowerShell to set the desktop wallpaper. The highest-value targets
are:

- **Image decoding** (`core/image/`) — the PNG and JPEG decoders parse
  attacker-controlled bytes. Overflow, out-of-bounds reads, and unbounded
  allocation are all in scope.
- **Path handling** — anything turning a path from the renderer or an OS
  file-open event into a filesystem read. Traversal and symlink escapes matter.
- **IPC** (`electron/preload.ts`, `electron/main.ts`) — the renderer is sandboxed
  and should reach the filesystem only through the named bridge channels. A
  bypass is a vulnerability.
- **Terminal sessions** (`electron/terminal.ts`) — the renderer asks for a shell
  from a fixed list and then drives it by opaque id. Every call must be refused
  unless it came from the window that opened the session, and the setting that
  turns the feature off has to be enforced in the main process rather than taken
  on trust from the renderer. Reaching a shell without that setting is a
  vulnerability.
- **Wallpaper handling** (`core/wallpaper.ts`) — takes a path and a fit mode and
  shells out to PowerShell. Injection, or a path that is not a real saved image,
  is a vulnerability.

## Out of scope

- Anything requiring an attacker to already run code on your machine
- Automated scanner output with no demonstrated path to impact
- Denial of service from a huge or corrupt image you already control
- Missing hardening headers on a local `file://` renderer

We ask that reporters avoid privacy harm, avoid accessing other users' data, and
give us the fix window above. We will not take legal action against good-faith
research that follows this policy.
