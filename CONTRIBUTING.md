# Contributing to OpenPics

Thanks for helping. This document covers the practical parts.

## Before you start

Open an issue before writing anything substantial. For a bug, the most useful
thing you can bring is a minimal reproduction: the image that triggers it, your
OS, and what you expected instead. For a feature, describe the workflow you are
trying to do rather than the UI you imagine.

Security issues do not go in issues. Read [SECURITY.md](SECURITY.md).

## Setup

Requires Node 22 or newer and npm.

```bash
git clone https://github.com/who-lee/openpics.git
cd openpics
npm install
npm run dev
```

`npm run dev` starts the app. `npm run build` produces `out/`.

## Checks before you open a pull request

```bash
npm run typecheck   # node, web, and mcp projects
npm run build       # must succeed
npm run package:dir # exercises the real bundled main process
```

That last one matters more than it looks. The bundler inlines modules, and code
that passes typecheck can still fail only once packaged. If you touch anything
under `core/` or `electron/`, run it and launch the result.

## Pull requests

- Branch from `main`, one topic per branch.
- Match existing style: two-space indent, no semicolons at line ends, single
  quotes in TypeScript. Read a neighbouring file and follow it.
- Write comments that explain *why*. The codebase already does this; match it.
- Keep the diff focused. Unrelated formatting changes make review harder.
- Update `SECURITY.md` if you change what the app trusts.

`main` is protected: it accepts pull requests only, requires one approving
review, and requires CI to pass. Maintainers bypass nothing.

## Commit messages

Short imperative subject, under 72 characters. Explain the reasoning in the body
when it is not obvious from the diff.

```
fix packaged image decode

A bare require('./png') survived bundling and was unresolvable in the
packaged app, so edit:open failed outside dev. Static imports fix it.
```

## Licensing

Contributions are licensed under the Apache License, Version 2.0, the same as
the project. See [LICENSE](LICENSE) and [NOTICE](NOTICE). By contributing you
agree your work is distributed under those terms, including the attribution
requirement in the NOTICE.

## Code of conduct

Be decent. Disagree with the work, not the person. Harassment of any kind is not
tolerated.
