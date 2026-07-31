<!--
  SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  SPDX-License-Identifier: MIT
-->

# Contributing to ncmake

Thanks for your interest in improving ncmake. This document describes how
changes get into the project.

## The golden rule: `main` is a live channel

Every ncmake app fetches `core/Makefile` from `main` at build time. A broken
`main` breaks every consuming app at once. Therefore:

- **No direct pushes to `main`.** Every change lands through a pull request.
- CI must be green and the branch up to date before a PR can merge.
- History stays linear, and commits are signed and carry a DCO sign-off.

## Branch naming

Use `ernolf/<type>/<short-description>`, where `<type>` follows Conventional
Commits (`feat`, `fix`, `docs`, `ci`, `refactor`, `chore`, …), for example
`ernolf/fix/psalm-guard`.

## Commits

- Follow [Conventional Commits](https://www.conventionalcommits.org/): a
  `type: summary` subject, optionally followed by a body of single-line bullets.
- Sign off every commit (DCO): `git commit --signoff`.
- Sign commits cryptographically. `main` requires signed commits.

## Testing a change before it merges

Because apps consume `core/Makefile` by reference, you can point any app at an
unmerged revision without merging or releasing it:

```sh
NCMAKE_REF=<commit-sha> make <target>
```

Use a commit SHA, not a slashed branch name: the local cache path
`~/.cache/ncmake/Makefile-<ref>` cannot contain slashes.

## What CI checks

- **Lint** (`.github/workflows/lint.yml`): yamllint, actionlint (the self-CI
  workflows *and* the templates in `workflows/`), markdownlint, and REUSE
  licensing.
- Additional functional checks build a throwaway fixture app end to end with
  ncmake (`make build`, `dist`, `composer`, `psalm`).

## Licensing

ncmake is [REUSE](https://reuse.software/) compliant. Every file declares its
copyright and `SPDX-License-Identifier`; files that cannot carry an inline
header are covered by `REUSE.toml`. New files must do the same. Verify locally
with `reuse lint`.
