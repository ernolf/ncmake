<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# ncmake

The Swiss Army knife for Nextcloud app development: one generic `Makefile` for building, packaging, deploying, versioning and App Store management of a Nextcloud app.

Everything is derived from the app itself, so there is nothing to configure for a standard app: drop it in, run `make`, done. The package managers run in throwaway containers, so the host needs neither PHP nor Node.

- [Installation](#installation)
- [What happens when you run make](#what-happens-when-you-run-make)
- [How ncmake understands your app](#how-ncmake-understands-your-app)
- [The container runtime](#the-container-runtime)
- [Building](#building)
- [Packaging: the shipped file set](#packaging-the-shipped-file-set)
- [Deploying to a test instance](#deploying-to-a-test-instance)
- [Releasing](#releasing)
- [The release workflow](#the-release-workflow)
- [App Store management](#app-store-management)
- [Per-app tuning](#per-app-tuning)
- [Variables](#variables)
- [Target reference](#target-reference)
- [Requirements](#requirements)
- [Show that your app uses ncmake](#show-that-your-app-uses-ncmake)

## Installation

### The bootstrap stub (recommended)

Put the bootstrap stub into the root of your app repository, once:

```sh
curl -fLO https://raw.githubusercontent.com/ernolf/ncmake/main/bootstrap/Makefile
git add Makefile
```

The stub is a dozen lines that never change. It fetches the real Makefile into a per-machine cache and includes it from there. Every developer who clones your app and runs `make` automatically gets the current ncmake, on every machine, for every app, from one shared cache.

**What lands in your repository: only the stub.** The stub file you committed stays byte-identical forever; the fetched Makefile lives in `~/.cache/ncmake/`, outside of every project. Running `make` creates or modifies nothing in your checkout (apart from the usual build outputs such as `build/`, `js/` and `vendor/`, which belong in your `.gitignore` anyway, as in every Nextcloud app). `git status` stays clean; there is nothing extra to ignore.

**How the cache stays current.** At most once per day (`NCMAKE_TTL_MIN`, default 1440 minutes) the cached Makefile checks upstream with a conditional GET (ETag): unchanged or offline keeps the cache, a new version replaces it and is used from the next run on. `make self-update` forces a refresh at any time.

**Pinning a version.** By default the stub follows the `main` branch. To pin your app to a fixed ncmake version, set `NCMAKE_REF` in the stub to a tag:

```make
NCMAKE_REF ?= v1.0.0
```

### The full copy (self-contained alternative)

If you prefer a repository without any fetch-at-build-time behavior, commit the full `Makefile` instead:

```sh
curl -fLo Makefile https://raw.githubusercontent.com/ernolf/ncmake/main/core/Makefile
```

A committed copy never modifies itself. `make self-update` downloads the newest version over it; review the diff and commit it like any other change.

## What happens when you run make

```mermaid
flowchart TD
    A["make &lt;target&gt;"] --> B{Stub or full copy?}
    B -- stub --> C{"~/.cache/ncmake/<br>Makefile present?"}
    C -- no --> D[fetch once from GitHub]
    C -- yes --> E{"older than<br>NCMAKE_TTL_MIN?"}
    E -- yes --> F["conditional GET (ETag):<br>new version → refresh cache<br>unchanged/offline → keep cache"]
    E -- no --> G
    D --> G[include cached Makefile]
    F --> G
    B -- full copy --> H[use the committed Makefile as is]
    G --> I[run the target]
    H --> I
```

The first `make` after a fresh `git clone` needs network once (to fill the cache); after that everything works offline.

## How ncmake understands your app

Nothing is configured twice, everything is read from files your app has anyway:

| Fact | Source |
|---|---|
| App id | `<id>` in `appinfo/info.xml` |
| Version | `<version>` in `appinfo/info.xml` |
| PHP build needed? | `composer.json` declares runtime requirements (anything besides `php` and `ext-*`) |
| Frontend build needed? | `package.json` has a `build` script |
| Is `js/` (or `vendor/`) a build artifact? | `.gitignore` (evaluated via `git check-ignore`) |
| PHP container image | minimum PHP version in `appinfo/info.xml` |
| Node container image | `engines.node` in `package.json` |

The `.gitignore` line deserves a word: when `js/` is gitignored, it is a build output and must exist before packaging (`make dist` refuses otherwise and tells you to run `make build`). When `js/` is committed, as in apps that ship their built frontend in git, a fresh checkout is already complete and packages without building. The same logic applies to `vendor/`.

The tarball and the deployed directory are always named after the **app id**, regardless of what your checkout directory is called.

## The container runtime

`composer` and `npm` never run on your host by default. Each invocation starts a throwaway container (`--rm`), does its work in your bind-mounted checkout and disappears. Your host needs no PHP, no Node, no version juggling, and you can build against exactly the PHP the app declares as its minimum.

The runtime is auto-detected (podman preferred, then docker) and can be chosen per call, for example `make build RUNTIME=docker`:

| `RUNTIME=` | What it is | Notes |
|---|---|---|
| `podman` | rootless podman (default when podman exists) | daemonless, no idle cost, files owned by you |
| `docker` | standard rootful docker | ncmake maps your uid/gid into the container, so no root-owned files appear |
| `docker-rootless` | rootless docker | |
| `bare` | no container | composer and npm must be on the PATH |

The images are derived, never hardcoded: PHP runs in `ghcr.io/nextcloud/continuous-integration-php<min>` (the same images the Nextcloud CI uses, with all required extensions), Node in `node:<major>` from your `engines.node`. Both can be overridden (see [Variables](#variables)).

On SELinux hosts (Fedora, RHEL) bind mounts may need a `:z` label; if you hit permission errors there, run with `RUNTIME=bare` or adjust your container policy.

## Building

```sh
make build
```

runs the detected build commands, each in its container:

- `composer install --no-dev --no-scripts --prefer-dist --no-progress` when `composer.json` declares runtime requirements
- `npm ci && npm run build` when `package.json` has a `build` script

When a side does not apply, it is skipped with a note. Apps with special build steps override the commands in `ncmake.mk` (see [Per-app tuning](#per-app-tuning)).

For everything beyond the release build there are generic pass-through targets running in the same throwaway containers — the host needs no toolchain even for the dev setup:

```sh
make composer ARGS=install       # install dependencies INCLUDING dev tools (vendor-bin etc.)
make composer ARGS="cs:check"    # run a composer script
make npm ARGS=ci                 # install frontend dependencies
make npm ARGS="run test"         # run the frontend tests
```

`make dist-clean` resets to a pristine checkout first (it removes every git-ignored build output: `vendor/`, `node_modules/`, `js/`, caches), so

```sh
make dist-clean && make build
```

is the reproducible from-scratch build.

## Packaging: the shipped file set

What ends up in a release is defined as an **allowlist** (the keep model), not as an exclude list. Shipped are the standard app paths, each only when it exists:

```
appinfo/ lib/ l10n/ templates/ img/ css/ js/ vendor/ LICENSES/
CHANGELOG.md AUTHORS.md REUSE.toml COPYING COPYING.md LICENSE LICENSE.md
```

A new dev file in your repository can never leak into the tarball, because it is not on the list. A missing runtime directory fails loudly instead of silently shipping a broken app.

```mermaid
flowchart LR
    A[working tree] -- "allowlist<br>+ .nextcloudignore" --> B["build/stage/&lt;app_id&gt;/"]
    B -- "tar (make dist)" --> C["build/artifacts/dist/<br>&lt;app_id&gt;-&lt;version&gt;.tar.gz"]
    B -- "rsync (make rsync)" --> D["&lt;apps-dir&gt;/&lt;app_id&gt;/"]
    B -- "docker cp (make cp)" --> E["&lt;container&gt;:&lt;apps-dir&gt;/&lt;app_id&gt;/"]
```

`make dist` materializes the file set once into a staging directory and packs it; `make rsync` and `make cp` deploy the very same staging directory. One mechanism, one source of truth: what you deploy for testing is byte-for-byte what a release ships.

## Deploying to a test instance

```sh
make build
make rsync TARGET=/var/www/nextcloud/apps OCC=1
```

`TARGET` is the `apps/` parent directory, locally or over SSH (`user@host:/var/www/nextcloud/apps`); the app subdirectory is appended automatically and synced with `--delete`, so removed files disappear from the instance too.

`OCC=1` wraps the sync into the full refresh cycle, so one short command replaces the chain you would otherwise have to remember and retype:

1. `occ app:disable <app>` — tolerated to fail on a first deploy
2. the rsync itself
3. `chown -R www-data: <apps-dir>/<app>`
4. `occ app:enable <app>`

The disable/enable cycle makes Nextcloud re-read `info.xml` and run pending migrations. `occ` is expected at `<apps-dir>/../occ` and runs as the web server user (`web_user`, default `www-data`; via `sudo` unless you already are that user). On a remote `TARGET` each step runs through `ssh`, so the ssh user needs the rights for `sudo` and `chown`. Without `OCC=1` only the rsync happens, and the finishing commands are printed ready for copy and paste.

When the instance runs inside a container whose filesystem rsync cannot reach from outside — a setup like Nextcloud All-in-One — `make cp` deploys the same staged file set into the running container:

```sh
make cp TARGET=nextcloud-aio-nextcloud:/var/www/html/custom_apps OCC=1
```

`TARGET` uses `docker cp` syntax (`<container>:<apps-dir>`); the app subdirectory is appended automatically and replaced as a whole, so removed files disappear too. `ENGINE=docker|podman` picks the container CLI — it is independent of `RUNTIME`, because builds may use podman while the instance runs under docker; that is why docker is preferred here when both are installed.

`OCC=1` runs the same four-step cycle as above, entirely inside the container. `occ` is invoked in the form the [All-in-One documentation](https://github.com/nextcloud/all-in-one#how-to-run-occ-commands) uses:

```sh
docker exec --user www-data -it nextcloud-aio-nextcloud php occ <command>
```

One detail worth knowing: `-it` (keep stdin open, allocate a terminal) belongs in commands you type into an interactive terminal, and is required as soon as an `occ` command prompts for input. Non-interactive commands such as `chown` do not need it, and automated calls must not use it — without a terminal attached, `-t` fails with "the input device is not a TTY". That is why the copy-and-paste lines ncmake prints carry `-it` on the `occ` call, while the calls it executes itself do not.

## Releasing

The release flow assumes a protected `main` (required checks, no direct pushes), which is good practice anyway:

```mermaid
flowchart LR
    A["make version<br>(on main)"] -- "branch ncmake/release/X.Y.Z<br>bump + lockfile sync + commit" --> B["make changelog<br>review, extend, commit"]
    B --> C[push, PR, merge]
    C --> D["git pull<br>make tag"]
    D -- "signed tag vX.Y.Z" --> E[GitHub release<br>+ tarball asset]
    E --> F["make publish<br>(App Store)"]
```

**`make version`** (run on `main`) prompts for the new version, validates it against the latest tag (`sort -V`, must be greater), branches off into `ncmake/release/X.Y.Z` (branches created by ncmake always carry the `ncmake/` prefix, so they are immediately distinguishable from hand-made branches) and commits the bump there: `appinfo/info.xml`, plus `composer.json`/`package.json` when present, plus the re-synced lockfiles (synced inside the containers, so the bump commit is complete and CI-clean).

**`make changelog`** (on the release branch) generates the `## [X.Y.Z]` section for the version in `info.xml` from the conventional commits since the last tag, and inserts it above the previous release, together with its `[X.Y.Z]:` link reference to the GitHub release tag (the repository URL is derived from the origin remote). Only user-visible changes make it in: `feat` becomes *Added*, `fix` becomes *Fixed*, `perf` becomes *Changed*; build, ci, test, chore, docs, refactor, style, merge commits and the daily Transifex bot commits are left out. The rest of the file is never touched, so the generated section can be freely edited and extended before committing, and hand-written history survives. It also prints the exact commit command: while the bump commit from make version is still unpushed, the changelog is folded into it via git commit --amend --no-edit (one commit per release); otherwise it suggests a separate build(release): update changelog for X.Y.Z commit. Rerunning is safe: an existing section is not duplicated, and when nothing user-visible happened since the last tag it says so (add a hand-written section then, for example for translation updates). It runs `git-cliff` via `npx` in the node container; an app-provided `cliff.toml` overrides the built-in configuration.

**`make tag`** (back on `main`, after the merge) refuses to re-tag, refuses when `CHANGELOG.md` has no `## [X.Y.Z]` section, shows a fat reminder that a tag freezes the current commit, then creates and pushes the **signed** `vX.Y.Z` tag after your confirmation.

`make dist` builds the tarball to attach to the GitHub release, `make sign` prints its base64 signature, `make release` does both in one step.

## The release workflow

ncmake ships one GitHub Actions workflow that builds the release tarball in CI. It carries no app-specific data — the shipped file set comes entirely from ncmake (keep model + `.nextcloudignore`) — so it is byte-identical across all ncmake apps. Install it once, into `.github/workflows/`:

```sh
curl -fL --create-dirs -o .github/workflows/release.yml \
  https://raw.githubusercontent.com/ernolf/ncmake/main/workflows/release.yml
git add .github/workflows/release.yml
```

It triggers on `release: published` (attaches `<app_id>-<version>.tar.gz` to the release) and on `workflow_dispatch` (produces the same tarball as a downloadable artifact for inspection, without publishing). The whole build is `make build && make dist`; the tarball is located by glob, so nothing in the file names the app.

`make` runs on the runner host, not in a job container: `ubuntu-latest` already carries podman (which ncmake uses for the build containers) plus git, curl, rsync, tar and python3, so the workflow needs no `setup-*` steps and no toolchain of its own. `contents: write` is the only permission, for the release upload; no secrets beyond the automatic `GITHUB_TOKEN`.

Like the bootstrap stub, the file carries ncmake's MIT header and is committed verbatim; the `LICENSES/MIT.txt` you already have for the stub covers it for REUSE.

## App Store management

The maintainer targets talk directly to the [App Store REST API](https://nextcloudappstore.readthedocs.io/en/latest/developer.html). They expect three files under `~/.nextcloud/certificates/` (change with `cert_dir=`):

| File | Purpose |
|---|---|
| `<app_id>.crt` (or `.cert`, both are accepted) | the app certificate issued via [app-certificate-requests](https://github.com/nextcloud/app-certificate-requests) |
| `<app_id>.key` | the private key |
| `appstore_api-token` | your API token from the App Store account page |

`make help` shows for each of the three whether it was found (green check or red cross, with the real filename).

| Target | What it does |
|---|---|
| `make register` | registers the app id and certificate, one time |
| `make publish` | submits a release: downloads the tarball from the given URL, signs exactly those bytes and posts it. Prompts for the URL (any host, `curl`; a GitHub release asset uses `gh` when installed, so private repos work); `GH=1` pre-fills the standard GitHub release URL to just confirm, `URL=` sets it directly |
| `make list-releases` | your published releases, compact JSON |
| `make list-releases-full` | the full App Store entry |
| `make list-for-author` | all apps of an author (prompts for a name) |
| `make delete-release` | deletes one release, interactively, with confirmation |
| `make ratings` | ratings and comments for the app |

The read-only list targets cache `apps.json` with ETag revalidation under `build/cache/`, so repeated calls are fast and gentle to the API.

## Per-app tuning

Most apps need none of this.

**`.nextcloudignore`** removes files from within the shipped set (rsync exclude syntax, one pattern per line), for example test ballast inside shipped vendor packages:

```
/vendor/*/*/tests/
```

**`ncmake.mk`** in the app root overrides single variables in plain make syntax. It is included first, so anything set there wins:

```make
keep_extra     = resources               # extra runtime paths to ship
php_build_cmd  = composer install --no-dev && php bin/generate.php
node_build_cmd =                         # empty = skip the npm build
php_image      = ghcr.io/nextcloud/continuous-integration-php8.2:latest
```

## Variables

Set on the command line (`make build RUNTIME=bare`), in the environment, or persistently in `ncmake.mk`.

| Variable | Default | Purpose |
|---|---|---|
| `RUNTIME` | auto (`podman`, else `docker`) | container runtime: `podman`, `docker`, `docker-rootless`, `bare` |
| `TARGET` | (required by `make rsync`/`make cp`) | apps parent directory: local, `user@host:` (rsync) or `<container>:` (cp) |
| `OCC` | (unset) | `OCC=1` wraps a deploy into occ app:disable → chown → occ app:enable |
| `web_user` | `www-data` | web server user of the target instance (file owner, runs occ) |
| `ENGINE` | auto (`docker`, else `podman`) | container CLI for `make cp` (independent of `RUNTIME`) |
| `cert_dir` | `~/.nextcloud/certificates` | location of certificate, key and API token |
| `php_image` | `ghcr.io/nextcloud/continuous-integration-php<min>` | PHP container image |
| `node_image` | `node:<engines.node major>` | Node container image |
| `keep_extra` | (empty) | additional paths for the shipped file set |
| `php_build_cmd` | auto-detected | PHP-side build command, empty skips |
| `node_build_cmd` | auto-detected | frontend build command, empty skips |
| `NCMAKE_REF` | `main` | branch or tag the stub fetches |
| `NCMAKE_DIR` | `$XDG_CACHE_HOME/ncmake`, else `~/.cache/ncmake` | cache location of the shared Makefile |
| `NCMAKE_TTL_MIN` | `1440` | minutes between upstream freshness checks |

## Target reference

`make` without a target prints the annotated help, including the detected app, version and certificate status.

| Area | Targets |
|---|---|
| Release versioning | `version`, `changelog`, `tag` |
| Build | `build`, `dist`, `sign`, `release`, `composer ARGS=...`, `npm ARGS=...` |
| Local deploy | `rsync TARGET=...`, `cp TARGET=...` |
| App Store | `register`, `publish`, `list-releases`, `list-releases-full`, `list-for-author`, `delete-release`, `ratings` |
| Utility | `clean`, `dist-clean`, `self-update`, `help` |

Targets marked `[m]` in the help are maintainer-only: they need repository write access and/or the App Store signing key. Everything else works for anyone who clones the app.

## Requirements

GNU make, git, curl, openssl, rsync, xmllint (libxml2), python3. Optional: podman or docker for containerized builds (strongly recommended; without them use `RUNTIME=bare` and provide composer and npm yourself).

## Show that your app uses ncmake

If ncmake is useful to you, add a badge to your app's README:

[![Built with ncmake](https://img.shields.io/badge/built%20with-ncmake-0082c9)](https://github.com/ernolf/ncmake)

```markdown
[![Built with ncmake](https://img.shields.io/badge/built%20with-ncmake-0082c9)](https://github.com/ernolf/ncmake)
```

The badge is served by shields.io and links here; it is purely cosmetic and reports nothing back. To actually find the apps that use ncmake, search GitHub's code search for the fetch URL every stub carries — that signal does not depend on the badge:

<https://github.com/search?q=%22raw.githubusercontent.com%2Fernolf%2Fncmake%22&type=code>

The same from the command line needs a recent `gh` (2.10 or newer, for the `search` command):

```sh
gh search code 'raw.githubusercontent.com/ernolf/ncmake' --json repository --jq '.[].repository.full_name' | sort -u
```

Both queries hit the same code-search index, so an empty result early on is expected: GitHub only searches public repositories it has already indexed, and a freshly created repo can take weeks to be picked up (the REST `search/code` API uses an even older, sparser index — prefer the browser query above). The bootstrap stub is committed regardless, so a consumer becomes findable the moment its repo is indexed.

## License

[MIT](LICENSE)
