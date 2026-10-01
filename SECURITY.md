# Security Policy

OpenPics reads the photos on your machine. That makes the trust boundary the most
important thing about this project, and it is treated as a defect, not a feature
request, when something crosses it.

## Supported Versions

Security fixes land on the latest release. Older versions are not patched; please
update before reporting against them.

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

**Do not open a public issue for a security problem.**

Email **security@who-lee.dev** with:

- what the issue is, and the impact you believe it has
- the OpenPics version (`Settings` shows it) and your OS version
- steps to reproduce, ideally minimal
- any log output or a screenshot, with paths redacted if you prefer

You will get an acknowledgement within 72 hours and an assessment within seven
days. Fixes for confirmed issues ship as a new patch release, and you will be
credited in the release notes unless you ask not to be.

Please give us a reasonable window to fix a reported issue before disclosing it
publicly. We aim for 90 days, and will ship sooner when severity warrants.

### What to look for

This app reads files by path, decodes untrusted image data, and runs PowerShell
to set the desktop wallpaper. The areas most worth attacking are:

- **Image decoding.** PNG and JPEG decoders parse attacker-controlled bytes.
  Overflow, out-of-bounds reads, and unbounded allocation are all in scope.
- **Path handling.** Anything that turns a path from the renderer or from an
  OS file-open event into a filesystem read. Directory traversal and symlink
  escapes matter here.
- **IPC.** The renderer is sandboxed and should have no route to the filesystem
  except the named bridge channels. A bypass is a vulnerability.
- **Wallpaper handling.** `wallpaper:set` takes a path and a fit mode and shells
  out to PowerShell. Injection or a writable-file path is a vulnerability.

## Out of Scope

- Vulnerabilities that require an attacker to already run code on your machine
- Reports from automated scanners without a demonstrated path to impact
- Denial of service from opening an intentionally huge or corrupt image you
  already control
- Missing hardening headers on a local file:// renderer

## Responsible Disclosure

We ask that reporters make a genuine effort to avoid privacy harm, avoid
accessing other users' data, and give us the fix window above. We will not take
legal action against good-faith research that follows this policy.
