<!--
  SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  SPDX-License-Identifier: MIT
-->

# Contributing to ncmake

Thanks for your interest in improving ncmake. This document describes how changes get into the project.

## `main` is a protected, live channel

Every ncmake app fetches `core/Makefile` from `main` at build time, so a broken `main` breaks every consuming app at once. `main` is therefore a protected branch, and the protection is enforced, not merely requested:

- No direct pushes. Every change lands through a pull request.
- All required checks must pass and the branch must be up to date with `main` before a pull request can merge.
- History stays linear.
- Every commit is cryptographically signed and carries a DCO sign-off.
- Force-pushes to `main` and its deletion are blocked.

## Branch naming

Branch from `main` and name your branch `<your-github-username>/<type>/<short-description>`, where `<type>` follows the Conventional Commits vocabulary (`feat`, `fix`, `docs`, `ci`, `refactor`, `chore`, …). Use your own GitHub handle as the prefix: a contributor with the handle `octocat` fixing the psalm guard would use `octocat/fix/psalm-guard`.

## Commits

- Follow [Conventional Commits](https://www.conventionalcommits.org/): a `type: summary` subject, optionally followed by a body of single-line bullets. The `Block unconventional commits` check rejects any commit whose subject does not parse.
- Sign off every commit ([DCO](https://developercertificate.org/)): `git commit -s` (or `--signoff`). The `DCO` check blocks the merge if a commit is missing its `Signed-off-by` line, or if that line's email does not match the commit author. `-s` derives the line from your git identity, so it matches by construction.
- Sign every commit cryptographically: `git commit -S` (or `--gpg-sign`). `main` requires signed commits, so an unsigned commit cannot be merged.

In practice both flags go together. Git accepts stacked short flags, so `git commit -s -S` and `git commit -sS` are the same thing.

## Test a change before you open a PR

The pull request runs a full functional smoke test (see below), and on a fork that smoke test is the real gate: it runs against the pull request's own head commit, so it covers your change wherever the branch lives. But you do not have to wait for the PR to catch a regression. You can run the same pipeline locally first, against a real consuming app that you build with your candidate `core/Makefile`. The latest `twofactor_oath` release is a good fixture; it is the one the smoke test uses itself.

How you feed your change into that build depends on whether you can push to this repository.

### With push access to `ernolf/ncmake`

Right now that is only me, but memory is short, so it is written down here. Push your feature branch (only `main` is protected, feature branches are not), then in the fixture app's checkout point `NCMAKE_REF` at your commit:

```sh
export NCMAKE_REF=<commit-sha>
make dist-clean build dist
make composer ARGS=install psalm
make reuse
```

The `export` applies the variable to every command in the shell session. If you would rather not touch your environment, prefix each `make` call inline instead, which scopes it to that one command:

```sh
NCMAKE_REF=<commit-sha> make dist-clean build dist
NCMAKE_REF=<commit-sha> make composer ARGS=install psalm
NCMAKE_REF=<commit-sha> make reuse
```

Use the commit SHA, not the slashed branch name: the cache path `~/.cache/ncmake/Makefile-<ref>` cannot contain a slash. `NCMAKE_REF` is fetched from this repository over HTTPS, so the commit has to be reachable here first; a purely local commit is not.

### From a fork (no push access)

Your commit lives in your own fork, so `NCMAKE_REF` cannot reach it here. Point `NCMAKE` at your working copy of `core/Makefile` instead. Because `NCMAKE` names a file that already exists on disk, nothing is fetched and your version is used verbatim, so this covers uncommitted changes too and does not depend on the branch having been pushed anywhere. Use an absolute path:

```sh
export NCMAKE=/abs/path/to/ncmake/core/Makefile
make dist-clean build dist
make composer ARGS=install psalm
make reuse
```

The same export-or-inline choice applies (`NCMAKE=/abs/path/... make ...` scopes it to a single command).

One caveat: pointing `NCMAKE` at a file reuses the same self-refresh the per-machine cache relies on, so a copy left untouched for longer than `NCMAKE_TTL_MIN` (24 h by default) is refreshed from `main` before the build. A file you are actively editing is fresh, so a normal edit-then-test cycle is never affected; if a working copy has been sitting for a day, just save it again first.

## What CI checks

Every check below is required: a pull request cannot merge until all of them pass and the branch is up to date with `main`.

- **Conventional commits** (`Block unconventional commits`) — every commit subject must parse as a Conventional Commit.
- **DCO** — every commit must carry a valid `Signed-off-by` line.
- **Lint** (`lint.yml`), three independent checks:
  - `yamllint` — all YAML.
  - `actionlint` — the self-CI workflows *and* the templates in `workflows/` that ncmake deploys into apps.
  - `markdownlint` — all Markdown.
- **REUSE** (`reuse-compliance-check`) — licensing, see below.
- **Smoke** (`build twofactor_oath with this revision`) — builds a real consuming app end to end against this exact revision, each heavy target from a pristine tree: introspection (`help`, `help-build`, `help-dist`), `build`, `dist`, a repeat `dist` to prove repeatability, `composer install` plus `psalm`, and `reuse`. A red run here is always an ncmake regression, never a flaky fixture.

Beyond the checks, the branch protection also requires signed commits and a linear history, and blocks force-pushes and deletion of `main`.

## Licensing

ncmake is [REUSE](https://reuse.software/) compliant. Every file declares its copyright and `SPDX-License-Identifier`; files that cannot carry an inline header are covered by `REUSE.toml`. New files must do the same. Verify locally with `reuse lint`.
