---
name: ncmake
description: Build, package, deploy, version, release and publish a Nextcloud app with ncmake, the generic Makefile, and manage its CI workflows. Use this whenever a repository contains appinfo/info.xml together with an ncmake Makefile, or when the task is a Nextcloud app build, dependency run, bundle size analysis, checkout audit, version bump, changelog, tag, integrity signature, App Store submission or workflow update.
---

<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->

# ncmake

ncmake is one generic `Makefile` that covers the whole life of a Nextcloud app: build, packaging, deployment, version bump, changelog, signed tag, the server-side integrity signature, App Store signing and publishing, and managed GitHub Actions workflows.

Its central property: **nothing is configured**. App id, version, PHP floor, Node version, what has to be built and what gets shipped are all derived from `appinfo/info.xml`, `composer.json`, `package.json` and `.gitignore`. Composer and npm run in throwaway containers, so the host needs neither PHP nor Node, only podman or docker.

Full documentation: <https://github.com/ernolf/ncmake/wiki>

## Recognising an ncmake app

The repository root has `appinfo/info.xml` and either the short ncmake bootstrap stub (a dozen lines that fetch and include the real Makefile from a per-machine cache) or a committed full copy of `core/Makefile`. The stub is committed as `GNUmakefile`; older apps carry it as `Makefile`, which still works. `make` with no target prints the annotated help with the app id, version and the available targets.

GNU make reads the first of `GNUmakefile`, `makefile` and `Makefile` it finds and none of the others. As `GNUmakefile` the stub is read whatever other build file the app keeps; that file runs only with `make -f <name>`. A stub as `Makefile` next to a lowercase `makefile` is never read, and no ncmake target exists; `make consistency-audit` reports which file make reads and which it hides.

The stub must sit in the repository root. Everything derives from `$(CURDIR)`, and the CI workflows expect it there.

## Ground rules

Follow these before proposing any command. They are the mistakes that cost the most time.

1. **`make build` is the complete build.** It already runs `composer install --no-dev --prefer-dist --no-progress`, with the app's own `post-install-cmd`, when `composer.json` declares real runtime requirements (anything besides `php`, `ext-*` and `bamarni/composer-bin-plugin`) or the app has `composer/autoload.php` next to a `composer.json`, and `npm ci && npm run build` when `package.json` has a `scripts.build` (with `pnpm-lock.yaml` or `yarn.lock` the same through pnpm or yarn via corepack; without any lock file `npm install`, and the build says it is not reproducible). Never propose `make npm ARGS=ci` or `make npm ARGS="run build"` as a build step, and never propose them as a preparation for `make build`.
2. **`make help-<target>` is the authoritative reference.** Every target has extended help with its exact options and examples. Run it instead of guessing an option name.
3. **Do not add build configuration.** No wrapper scripts, no extra make targets, no CI build steps that duplicate `make build`. A genuine deviation belongs in `ncmake.mk` (plain make syntax, one variable per line).
4. **Never edit the version by hand** in `info.xml`, `composer.json` or `package.json`. `make version` does the bump, the validation and the lockfile sync.
5. **Never write a CHANGELOG section by hand.** `make changelog` generates it from the conventional commits. A translated `CHANGELOG.<code>.md` is the exception: nothing generates it.
6. **Maintainer targets change the world.** `version`, `changelog`, `tag`, `stable-branch`, `csr`, `register`, `sign`, `release`, `publish`, `delete-release`, `integrity-enable`, `integrity-sign`, `dist-signed`, `l10n-init`, `dev-init` and every `COMMIT=1` / `PR=1` / `AMEND=1` variant write commits, tags, branches, pull requests, App Store entries or signatures. Run them only when the user explicitly asks for that step, one step at a time. Read-only targets (`build`, `dist`, `psalm`, `reuse`, `composer`, `npm`, `integrity-check`, `bundle-report`, `build-audit`, `consistency-audit`, `build-verify`, `changelog-lint`, `php-compat`, `deps-audit`, `l10n-check`, `l10n-lint` (without `FIX=1`), `lint` and every `lint-*` target, `list-releases`, `workflows-list`, `help`) are free to run.
7. **`build/` is generated.** Never edit, never commit, never reference a file in it as source. `make clean` removes it.
8. **The host needs no toolchain.** Do not tell anyone to install composer, PHP or Node. podman (preferred) or docker is enough. `RUNTIME=bare` exists for hosts that deliberately run the tools directly.
9. **The checkout directory name is not the app id.** The id comes from `appinfo/info.xml` and the two often differ.
10. **Quote `ARGS`.** `make composer ARGS="install --no-dev"`. Without `ARGS`, `make composer` and `make npm` print their usage and exit 1 on purpose.
11. **`appinfo/signature.json` is produced at tag time, on the maintainer's machine.** Never propose `occ integrity:sign-app` (it needs a server with the app already installed), never propose writing the file into the checkout, and never propose putting the signing key into a repository secret so a workflow can sign. The signature travels to the runner, the key does not.

## What ncmake reads

| Source | What it decides |
| --- | --- |
| `appinfo/info.xml` | `<id>` (app id, tarball and stage directory name), `<version>`, `<dependencies><php min-version>` (the build image, never below the PHP floor of the newest end-of-life Nextcloud major) |
| `composer.json` | a composer step is needed when `require` holds anything besides `php` and `ext-*`, or when `composer/autoload.php` exists; the version is bumped here too when the key exists |
| `package.json` | an npm step is needed when `scripts.build` exists; the lock file picks npm, pnpm or yarn; `engines.node` picks the Node line, the newest LTS line it allows that is not end of life; the version is bumped here too |
| `.gitignore` | classifies `js/` and `vendor/`: ignored means build output that must be built before shipping, committed means a fresh checkout is already dist ready |
| `.nextcloudignore` | optional, rsync exclude syntax, filters within the shipped file set |
| `.ncmake/certificate.crt` | optional, the committed public certificate that marks the app as signed and pins every verification against it |
| `ncmake.mk` | optional, overrides single variables (`keep_extra`, `php_build_cmd`, `node_build_cmd`, `web_user`, image names, `gh_key_fprs`, `integrity_certificate`, ...) |

## Which command for which job

| Job | Command |
| --- | --- |
| Build everything | `make build` |
| Reproducible from scratch | `make dist-clean && make build` |
| Frontend only | `make npm ARGS="run build"` |
| Watch and rebuild while developing | `make npm ARGS="run dev"` |
| Frontend tests | `make npm ARGS="run test"` |
| Frontend lint | `make npm ARGS="run lint"` |
| Add a frontend dev dependency | `make npm ARGS="install -D vitest"` |
| What the browser loads per page | `make bundle-report` |
| Why the bundle is that size | `make build-audit` |
| Whether the checkout agrees with itself | `make consistency-audit` |
| Whether the committed build output comes from this source | `make build-verify` |
| Whether the App Store finds this release in the changelog | `make changelog-lint` |
| Whether the app runs on the PHP floor and ceiling of its servers | `make build && make php-compat` |
| Whether a dependency that ships has a published vulnerability | `make deps-audit` |
| Whether the workflows of the repository are valid | `make lint-actions` |
| Whether a workflow of the repository can be attacked | `make lint-actions-security` |
| What the lint workflow of one tool would find | `make lint-shell`, `make lint-yaml`, `make lint-markdown`, ... (see the lint module) |
| Every lint the lint workflows run | `make lint` |
| Install the PHP dev tools (psalm, cs) | `make composer ARGS=install` |
| Static analysis | `make psalm` (or `make psalm ARGS="--show-info=true"`) |
| Coding style | `make composer ARGS="cs:check"`, `make composer ARGS="cs:fix"` |
| Runtime dependencies only | `make composer ARGS="install --no-dev"` |
| Refresh `composer.lock` | `make composer ARGS=update` |
| Resolve against the PHP support floor | add `PHP=min` to the composer call |
| License compliance | `make reuse` |
| Prepare the Transifex sync | `make l10n-init PR=1` |
| Whether the Transifex sync setup passes the Nextcloud check | `make l10n-check` |
| Whether the source strings pass the review of the translation team | `make l10n-lint` (`FIX=1` rewrites what has a fix) |
| Release tarball | `make build && make dist` |
| Mark the app as signed (once per app) | `make integrity-enable` |
| Verify a tree or a tarball against its signature | `make integrity-check DIR=<path>`, `make integrity-check TARBALL=<file>` |
| Signed tarball without the runner | `make dist-signed` |
| Deploy to a test instance | `make build && make rsync TARGET=/var/www/nextcloud/apps OCC=1` |
| Deploy over ssh | `make build && make rsync TARGET=deploy@host:/var/www/nextcloud/apps OCC=1` |
| Deploy into a running container (All-in-One) | `make build && make cp TARGET=nextcloud-aio-nextcloud:/var/www/html/custom_apps OCC=1` |
| Remove `build/` | `make clean` |
| Remove every git-ignored build output | `make dist-clean` |
| List the container images on the host and remove some | `make image-clean` |
| Remove the images ncmake pulled, unattended | `make image-clean OWN=1` |
| List the ncmake cache and remove some | `make cache-clean` |
| Update ncmake itself | `make self-update` |
| Install or refresh this skill file | `make skill-install` |

`TARGET` for `rsync` and `cp` is the **parent** `apps/` directory; the app subdirectory is appended automatically. `OCC=1` wraps the copy into `occ app:disable`, `chown` to `web_user` (default `www-data`) and `occ app:enable`, so `info.xml` is re-read and migrations run. Without `OCC=1` those commands are only printed. `ENGINE=docker|podman` picks the container CLI for `cp` independently of `RUNTIME`.

## Containers and images

| Image | Used by | Purpose |
| --- | --- | --- |
| `ghcr.io/ernolf/ncmake-php:<floor>` | `make build`, anything with `PHP=min`, `php-compat` (one image per minor it checks), the composer half of `deps-audit` | dependencies resolve against the PHP floor, which is what a correct package needs: the declared `min-version`, raised to the floor of the newest end-of-life Nextcloud major when it is lower; `docker.io/library/php:<floor>-cli-alpine` with the extensions a Nextcloud server offers (`php_extensions`), Composer 2, git and unzip, published from `php/Containerfile` of [ncmake-images](https://github.com/ernolf/ncmake-images) for amd64 and arm64 for every PHP minor from that floor to the ceiling of Nextcloud master and rebuilt when one of its inputs changes; pulled like any other image. `localhost/ncmake-php:<floor>` is built on the host from the same Containerfile, which ncmake caches, instead when `php_extensions` in `ncmake.mk` adds an extension the published image lacks, or when no source serves the published one |
| `ghcr.io/ernolf/ncmake-php:<minor>-next`, `ghcr.io/ernolf/ncmake-php:next` | `php-compat`, for a `<php max-version>` above the ceiling of Nextcloud master or with `NEXT=1` | the same Containerfile for every PHP minor above the ceiling of Nextcloud master, built from its release or, before it, from the newest alpha, beta or RC (`docker.io/library/php:<minor>-rc-cli-alpine`), published by ncmake-images for amd64 and arm64; `next` names the newest of those minors, and the label `ncmake.php` the exact PHP, for example `8.6.0RC3`. An extension of `php_extensions` that does not build or does not load on that PHP yet is left out, and the label `ncmake.missing` names it. Once master allows a minor, it moves to `ncmake-php:<minor>` and its `-next` image is no longer built. Nothing is built on the host in its place |
| `docker.io/library/composer:2` | `make composer`, `make psalm` | newest PHP patch plus composer, git and unzip, which current dev tools need |
| `ghcr.io/ernolf/ncmake-node:latest` (`node_image`, `lib_node_image`) | every npm run, `consistency-audit`, `changelog-lint`, `php-compat`, `deps-audit`, `bundle-report`, `build-audit`, `build-verify`, every `lint-*` target | one image for every Node line: Debian slim with git, the CA certificates, the compiler node-gyp needs (python3, make, g++), python3-setuptools for the distutils a node-gyp before 10 imports, and Yarn 1, which the official Node images carry for a build script that calls `yarn` without a `yarn.lock`, published by ncmake-images for amd64 and arm64. Node itself is the official build from nodejs.org, checked against its `SHASUMS256.txt`, kept per line in `node/` of the ncmake cache and mounted read-only at `/usr/local`: for npm the newest LTS line `engines.node` allows that is not end of life (without `engines.node` the newest LTS line), for the analysers the newest LTS line, and `build-verify` and `deps-audit` put the app's line first on PATH for the build steps and the audit. When no source serves the image, `docker.io/library/buildpack-deps:trixie` runs instead, which carries no Yarn 1. A `node_image` or `lib_node_image` set in `ncmake.mk` runs as it is |
| `docker.io/fsfe/reuse` | `make reuse` | the REUSE compliance checker |
| `docker.io/library/php:<version>-cli-alpine` | `make lint-php-syntax` | the plain PHP image, one per version the target checks; `php -l` needs no extension |

`PHP=min|max` switches the PHP side explicitly. `build` pins `PHP := min`, `psalm` pins `PHP := max`. `RUNTIME=podman|docker|docker-rootless|bare` selects the runtime; it is auto-detected with podman preferred, and `docker` maps the caller's uid and gid so no root-owned files appear in the checkout.

Every Node container mounts `npm/` and `corepack/` of the per-machine ncmake cache (`${XDG_CACHE_HOME:-~/.cache}/ncmake/`) read-write as the download cache of npm and corepack, so the tarballs of a lockfile and the package managers corepack fetches are downloaded once per host, and `make build`, `build-verify` and the next app share them; `npm ci` checks every tarball against the `integrity` the lockfile records. `RUNTIME=bare` keeps the npm cache of the host.

Every container runs with `--rm` and `--label ncmake`. Before it starts, its image is pulled again once the last check is older than `IMAGE_CHECK_MIN` minutes (default 1440), and the image that pull superseded is removed right away. Images that a container still uses or another tag still names stay. `images.txt` records each image ncmake used, whether ncmake pulled it or found it on the host, and when it was last used and checked. It is state, not cache, and lives beside the image store it describes: `${XDG_STATE_HOME:-~/.local/state}/ncmake/` for a rootless store (podman run by a user, rootless docker), `/var/lib/ncmake/` for a store of the whole host (podman run by root, rootful docker). For rootful docker run by a member of the docker group, ncmake asks once whether to create `/var/lib/ncmake` with sudo; on no it keeps the record per user, and `make image-setup` asks again. Deleting the cache leaves the record alone.

Which registry serves an image is data, not code: `core/image-sources` in the ncmake repo lists, per image reference prefix, the registries to try in order (for the Docker Official Images ECR Public, then `mirror.gcr.io`, then Docker Hub, whose anonymous pull limit is the strictest). A pull that fails, through a rate limit or otherwise, falls through to the next source. The image is tagged with its reference afterwards, so the host keeps one name whatever served it. The list is cached and refreshed like the Makefile; `IMAGE_SOURCES=<file>` uses a list of one's own instead.

`make image-clean` lists the images of every container CLI on the host with size, last use and status (`ncmake`, `built`, `ncmake-used`, `dangling`, `foreign`, `in use`) and removes the ones picked at the prompt. `OWN=1` picks every image ncmake pulled but not the one it built, `OLD=1` every dangling image and every image ncmake pulled or built unused for `IMAGE_IDLE_MIN` minutes (default 10), `DRY=1` only shows the pick. The flags never pick a foreign image or one in use, and nothing is removed with `-f`. It removes images from the host, so run it only when the user asks for it.

`make cache-clean` lists the per-machine ncmake cache entry by entry, with size, last change and status (`ncmake`, `leftover`, `in use`, `foreign`): the core, developer modules, analyser libraries and registry list of each ref, every Node.js line, the release index of nodejs.org, `npm/`, `corepack/`, each tool the lint module fetched into `tools/`, `last-run` and what an interrupted download left. It removes the entries picked at the prompt, by number or `all`; `ALL=1` picks every entry but a foreign one, `DRY=1` only shows the pick. An entry a running ncmake container mounts stays, `all` and `ALL=1` are refused while one runs, and the directory itself goes only once it is empty. The next run fetches a removed entry again, except the developer modules, which come back only with `make dev-init`. It removes files from the host, so run it only when the user asks for it.

Once no ncmake container has run for `IMAGE_IDLE_MIN` minutes (default 10), the images ncmake pulled itself are removed, as `make image-clean OWN=1` does; a PHP floor image it built on the host stays. A detached waiter that each container run starts does this, so a sequence of targets reuses the images in between. `KEEP=1` starts no waiter, for a series of runs that should keep the images; CI (`CI` set) and `RUNTIME=bare` start none either.

## The shipped file set (keep model)

A release ships an allowlist, never an exclude list, so a stray development file cannot leak into the tarball:

* directories `appinfo lib l10n templates img css js vendor composer LICENSES`
* files `CHANGELOG.md CHANGELOG.*.md AUTHORS AUTHORS.md REUSE.toml COPYING COPYING.md LICENSE LICENSE.md`, each with its REUSE sidecar `<file>.license` when it has one
* plus whatever `keep_extra` in `ncmake.mk` adds (for example `resources`)

Only paths that actually exist are staged. `.nextcloudignore` filters within that set. The result is materialized into `build/stage/<app_id>/` and packed into `build/artifacts/dist/<app_id>-<version>.tar.gz`. `rsync` and `cp` deploy that very same tree, so a test deployment is byte for byte what a release ships.

`check-build` demands the build outputs only when they are git-ignored. An app that commits its built `js/` stays dist ready straight from a fresh checkout.

## Release lifecycle

Between releases, `make changelog` without a pending bump writes the new entries under `## [Unreleased]`, which is what the App Store shows for a nightly. Run it after a change and fold the result into that commit (`AMEND=1`, or the printed `git commit --amend --no-edit`), or let `COMMIT=1` / `PR=1` put it on `ncmake/docs/changelog`. What is already in `CHANGELOG.md`, generated or written by hand, is kept word for word; a `CHANGELOG.md` with uncommitted changes stops the run.

Exactly this order, one step per command, each on the branch it names:

1. On `main`, with a clean tree: `make version`. It prompts for the new version, `X.Y.Z` or a pre-release `X.Y.Z-alpha.N`, `-beta.N`, `-rc.N`, validates that it is greater than the latest tag in the order of PHP `version_compare` (`1.2.0-rc.1` before `1.2.0`), creates the branch `ncmake/release/X.Y.Z`, bumps `info.xml`, `composer.json` and `package.json`, re-syncs the lockfiles in the containers, moves the `<screenshot>` URLs of `info.xml` that are pinned to a release tag of the app's own repository to the new tag, and commits the bump with `-s`. It warns when the composer or package description has drifted away from the `info.xml` summary.
2. On that branch: `make changelog`. It moves everything under `## [Unreleased]`, together with the conventional commits since the last change to `CHANGELOG.md` (`feat` to Added, `fix` to Fixed, `perf` to Changed; `build`, `ci`, `test`, `chore`, `docs`, `refactor`, `style`, merges and the Transifex `fix(l10n)` commits are skipped), into the `## [X.Y.Z]` section, inserts it below `## [Unreleased]` together with its `[X.Y.Z]:` link reference and prints the exact commit command. While the bump commit is still unpushed that command is `git commit --amend --no-edit`, so a release stays one commit; `make changelog AMEND=1` runs it, and `AMEND=1 PR=1` also pushes the branch and opens the pull request. Rerunning the target is safe. An app-provided `cliff.toml` overrides the built-in configuration.
3. Push the branch, open the pull request, let CI pass, merge it.
4. `git checkout main && git pull`, then `make tag`. It refuses to re-tag, refuses a working tree that is not clean (untracked files included, because the release is packed from the checkout), checks the changelog before the confirmation, and creates and pushes the signed tag after a confirmation prompt. For an app marked as signed it offers the signature between the confirmation and the tag (see below). With the audit module the changelog check is `make changelog-lint` and refuses on a `[!]` finding; without it, `make tag` refuses when `CHANGELOG.md` has no section for the version. `make tag NO_CHANGELOG_LINT=1` skips the check, for a release that is meant to go out regardless.
5. Publish the GitHub release for that tag. The shipped `release.yml` workflow builds and attaches the tarball, verifying the signature before it packs when the app is signed.
6. App Store: `make publish GH=1` (see below).

### Maintenance lines

An older release line, for example 0.7 while `main` is at 0.8, gets its own `stable*` branch and its own releases. The branch is named `stableX.Y` after the line by default, but any name with the `stable` prefix works, because every target recognises a maintenance branch by that prefix alone: `stable0.8` from `v0.7.3` carries a new minor for the servers `main` at 0.9 no longer supports, and `stable32` serves Nextcloud 32, however the app counts its versions there. Each branch owns a range of versions that no other branch reaches into, and `make version` and `make tag` hold every version to it:

1. On `main`: `make stable-branch`. It lists the release lines from the tags, each with the `stable*` branches on origin whose newest tag is in it, prompts for one (`X.Y`) and refuses a line without a tag, the current line of `main` (the line of the `info.xml` version on `main` once that is above the newest tag) and a newer one. Then it prompts for the branch name, `stableX.Y` by default, and refuses one without the `stable` prefix or one that already exists locally or on origin. The branch starts at the newest tag of the line, never at `main`. Before it is created, it shows the Nextcloud and PHP ranges at that tag next to those of `main` and notes when the line still reaches into the Nextcloud versions `main` covers; capping `max-version` is then the first PR against the branch. After a confirmation it creates and pushes the branch.
2. Protect the branch on GitHub like `main`.
3. Changes reach the branch only through PRs against it. With the `backport` workflow installed, a comment of `/backport to stableX.Y` on the PR against `main` opens that PR (see below). By hand: `git switch -c <branch> stableX.Y && git cherry-pick -x <commit>`.
4. A workflow that `main` gained after the line's tag, for example one whose check the repository rules require, comes over on `stableX.Y` with `make workflows-install W=<name> PR=1`. The workflow updater never reaches a `stable*` branch, so `make workflows-update PR=1` runs there by hand.
5. For an app with `.tx/config`: the Nextcloud Transifex bot syncs only the branches that `.tx/backport` on `main` lists (one per line, replacing the server's `stable*` names), so `stableX.Y` goes into that file through a PR against `main`, together with a `REUSE.toml` entry for it. `make stable-branch` offers that PR after the branch is pushed: on yes it commits both on `ncmake/l10n/tx-backport-stableX.Y` off `main`, opens the PR through gh and checks `stableX.Y` out again. The bot pushes its commits directly, so it needs write access as a collaborator and a bypass on the rule that protects the branch, as on `main`; `make stable-branch` prints that step. Once the PR is merged, `make l10n-check` validates the new branch together with the others the bot syncs.
6. Release from it exactly as from `main`, with `stableX.Y` in place of `main`. `make version` prints the range of the branch before the prompt: above the newest tag reachable from it, below the lowest tag it does not contain that is above that one and has another major.minor (or the `info.xml` version on `main` while that is not tagged yet), and never in a major.minor that a tag outside the branch has. So `stable0.7` from `v0.7.3` releases 0.7.x below `main`'s 0.8.0, and `stable0.8` from the same tag releases 0.8.x below `main`'s 0.9.0; on `main` the version is above every tag of the repository. `make tag` checks the same range again. `make changelog` keeps the tags of the other lines out, and `make tag` runs on `stableX.Y` after the merge. When publishing the GitHub release, untick "Set as the latest release".

## Developer modules

The App Store, CI workflow, bundle analysis, checkout audit, lint, integrity signature, translations, gh and git targets are optional modules that live in the ncmake repository under `mk/`. `make dev-init` fetches them into the same per-machine cache as the core Makefile, from where every ncmake app on that machine sees them. The module list is discovered live through the GitHub contents API, so new modules arrive without an ncmake update. `make dev-clean` removes them again, which restores the plain user target set.

The anonymous GitHub API allows 60 requests an hour per IP. Exporting `GITHUB_TOKEN` or `GH_TOKEN` raises that to 5000 and is worth doing on a machine that runs `dev-init` or `workflows-list` regularly.

Someone who only builds and installs an app never needs `dev-init`.

## App Store module

Certificate directory: `~/.nextcloud/certificates` (`cert_dir`), holding `<app_id>.crt` or `<app_id>.cert`, `<app_id>.key` and `appstore_api-token`. `make help` shows the presence of all three.

One-time setup:

1. `make csr` generates `<app_id>.key` (mode 600) and prints the certificate request. It refuses to overwrite an existing key or CSR.
2. Submit the CSR as `<app_id>/<app_id>.csr` in a pull request to <https://github.com/nextcloud/app-certificate-requests>.
3. Save the issued certificate as `<app_id>.crt` in the certificate directory.
4. `make register` registers the app id and the certificate on the App Store.

Ongoing:

| Target | Effect |
| --- | --- |
| `make sign` | signs the built tarball and prints the base64 signature |
| `make release` | `dist` plus `sign` in one step |
| `make publish [GH=1] [URL=...] [NIGHTLY=1]` | downloads the tarball from the given URL, signs exactly those bytes and posts URL plus signature |
| `make list-releases`, `make list-releases-full` | the published releases, compact or as the full store entry |
| `make list-for-author` | every app by an author (prompts for the name) |
| `make delete-release [NIGHTLY=1]` | deletes a release after showing the list and prompting |
| `make ratings` | the app ratings |

`publish` always signs the bytes the URL actually serves, never a local file, so the signature can never disagree with the artifact. `GH=1` pre-fills the standard GitHub release asset URL for confirmation and uses `gh` when available, which makes private repositories work. `NIGHTLY=1` publishes into the nightly channel, where the store keeps exactly one nightly per app and does not require an increasing version; for a GitHub asset the release's pre-release flag is cross-checked against `NIGHTLY` and a mismatch asks before publishing. A tagged pre-release (`vX.Y.Z-rc.N`) is no nightly: it is marked as a pre-release on GitHub and published without `NIGHTLY`, and the server offers it only to the beta, daily and git channels or with `--allow-unstable`.

## Integrity signature module

`appinfo/signature.json` is the per-file hash list a Nextcloud **server** reads to tell an installed app apart from a modified one. It is not the App Store signature: `make sign` proves to the store where a tarball came from, this file lets a server verify an installation. An app without it is not integrity-checked at all, and the server says so only at `-vvv`.

The module writes the file itself, from `mk/integrity.mk` plus a Python helper, against the format in the server's `lib/private/IntegrityCheck/Checker.php`: a sha512 per file keyed by the app-root-relative path, signed with RSA-PSS (digest sha1, MGF1 sha512, salt length 0, which makes it deterministic and therefore byte-identical to what `occ` produces). It needs only `openssl` and `python3` - no Nextcloud installation, which is the reason it exists, since the documented route is `occ integrity:sign-app` on a server that already has the app.

It uses the App Store certificate and key from `cert_dir`, so an app is onboarded to the store first.

| Target | Effect |
| --- | --- |
| `make integrity-enable` | copies the public certificate to `.ncmake/certificate.crt` and prints the commit command; that committed file is the whole switch |
| `make integrity-sign [DIR=<path>]` | writes `appinfo/signature.json` into the staged tree, or into a tree that already exists; refuses the checkout itself |
| `make integrity-check [DIR=<path>] [TARBALL=<file>]` | holds a tree or a packed release against its own `signature.json`; needs no key and is a core target, not part of the module, so the release runner has it without `make dev-init` |
| `make dist-signed` | stage, sign, check, pack - the tarball the runner would have produced, for a release attached by hand |
| `make integrity-tag` | the step `make tag` runs; not called by hand |
| `make integrity-gist-drop` | the step `make publish` runs; not called by hand |

**`.ncmake/certificate.crt` does two things.** It marks the app as signed, so `make tag` offers the signature and the release workflow fails a release that carries none; and it pins the certificate every verification is held against. It holds no key material, and it lies outside the keep model, so it never reaches the tarball. Removing it from the repository stops the signing; the next release then ships unsigned.

**How a signed release runs.** After the confirmation in `make tag`, and before the tag exists, ncmake asks `Generate appinfo/signature.json for this release? [Y/n]`. On yes it stages, signs, verifies the result against the pinned certificate, uploads the file as a **secret gist** and writes one line into the tag message, `ncmake-signature: <gist id>`, which the tag's own GPG signature then covers. The release workflow reads that id back, fetches the gist into `appinfo/signature.json` **without a token** (a secret gist is readable by anyone holding its id, and `GITHUB_TOKEN` cannot read gists at all), and runs `make integrity-check` before `make dist`, so nothing is packed that did not verify. No id while `.ncmake/certificate.crt` is committed fails the job. `make publish` deletes the gist once the store has answered 200 or 201 - not earlier, because a failed release job has to stay re-runnable.

That detour is the point: the signature travels to CI, the signing key never does.

**What gets hashed is the staged tree**, never the checkout, so the hashed file set is the shipped file set. That also makes build reproducibility a release gate - the hashes were taken over a build on the maintainer's machine, so a runner build that does not reproduce it fails with `INVALID_HASH` instead of shipping. `make build-verify` is the target that asks that question ahead of time.

`integrity-check` reports `EXTRA_FILE`, `FILE_MISSING` and `INVALID_HASH` (the classes `Checker::verify()` itself uses), plus `CERTIFICATE_CN` when the certificate's CN is not the app id, `CERTIFICATE_MISMATCH` when the signature was made with a certificate other than the pinned one, and `INVALID_SIGNATURE`. It does not check the certificate chain: that the certificate was issued by Nextcloud is what the server verifies against its own `resources/codesigning/root.crt`.

## Bundle analysis module

Two analysers on one set of measurements, for an app with a frontend. Neither builds, installs nor touches dependencies, and neither writes anything into the app: no configuration to add, no file to commit, no file to ignore.

| Target | Reads | Answers |
| --- | --- | --- |
| `make bundle-report` | the built directory (default `js/`) | what a browser downloads when a page of this app opens, and which packages those bytes are |
| `make build-audit` | the checkout: bundler config, `package.json`, `src/` | why the bundle is the size it is, priced in the bytes the build delivers |

`bundle-report` counts every file that no other file in the built directory imports as an entry, follows the static import graph to its closure, and adds the stylesheet named after that entry with everything it `@import`s, because entry plus stylesheet is the pairing the app makes in PHP with `addScript` and `addStyle`. Each file is compressed on its own, never concatenated, since each is its own HTTP response. Where the build ships source maps, the delivered bytes are charged back to the modules they came from, so the report names the packages the bundle is actually made of; without maps the file sizes still hold and the per-package breakdown does not.

`build-audit` reads the half that never ships and prices what it finds there through the same maps, so a statement about how this app imports something comes with what that costs here. It names only what the app itself can change: the toolchain the checkout is built with, whether the build emits source maps, a page that arrives as one chunk, every package the source imports by its root together with what the build delivers of that package, and moment or a set of statically bound date-fns locales where the source is what pulls them in. What the bundler or a library decides on its own is measured and tabled under `--details` instead of dressed up as a verdict.

Both mark findings `[!]` worth changing, `[i]` worth knowing, `[ok]` nothing found, and each finding says what it is derived from. `ARGS="--details"` adds the tables behind them, `ARGS=--json` emits the whole result for a script, and `JSON=<file>` writes that result to a file from the same run that prints the report. `make help-bundle-report` and `make help-build-audit` list every option.

The analysers are dependency-free ESM files that share their measuring core, so both count the same way. They are fetched into the per-machine ncmake cache on first use, on the same TTL and ETag terms as the modules, and mounted read-only into the throwaway Node container, so the host needs no Node. The fetch happens only when one of the two targets is on the command line, so no other target in any app pays for it.

## Checkout audit module

Five more analysers, in `mk/audit.mk`, about the checkout rather than the bundle. They share the report core with the bundle analysers, so findings read the same way everywhere.

| Target | Reads | Answers |
| --- | --- | --- |
| `make consistency-audit` | the metadata: `appinfo/info.xml`, `package.json`, `composer.json`, `.nvmrc`, the installed workflows | whether the checkout agrees with itself, and what a release still needs |
| `make build-verify` | the tracked source, rebuilt twice outside the app | whether the build output committed to the checkout comes from that source |
| `make changelog-lint` | `CHANGELOG.md`, `CHANGELOG.<code>.md`, the version in `appinfo/info.xml` | whether the App Store finds this release in the changelog |
| `make php-compat` | the checkout run on the PHP floor and ceiling, `appinfo/info.xml`, the installed packages | whether the app runs on the PHP versions its servers run it on |
| `make deps-audit` | `composer.lock` and the npm lock file, through the package managers' own audits | whether a dependency that ships has a published vulnerability, and whether an update can reach the fix |

`consistency-audit` holds the statements a checkout makes against each other: the version in `appinfo/info.xml` against the one in `package.json`, the PHP floor in `info.xml` against `composer.json`, every PHP extension that `composer.json` or a package in `composer.lock` requires against the `<lib>` entries in `info.xml`, unless every Nextcloud server has it, the Node version in `package.json` against `.nvmrc` and against the installed workflows. A linter checks one file against a rule and cannot see any of that. The second half is what a release needs and a checkout can be missing: the `<repository>` and `<bugs>` links, a `<nextcloud>` range that names servers that exist, one lockfile rather than two, a licence stated the same way everywhere, a linter a script calls while no configuration for it is in the tree. Metadata only, no build, no install, which makes it useful on a fresh clone and on an app that never heard of ncmake. The list of released Nextcloud majors is written into the analyser, and the report names the month the list is from. The major on nextcloud/server master is read from its `version.php` instead, and a `<nextcloud max-version>` beyond it is `[!]`; offline the list stands in for it.

`build-verify` answers the other question: it copies the tracked files into a scratch tree outside the app, installs the locked dependencies there, runs the build - twice, the second time in another directory - and compares the result against what the checkout carries. Twice, because one build cannot separate a difference of the source from output that is not reproducible: what both builds wrote byte for byte the same is what this source produces, so a difference against the checkout is the checkout's, while a file the two builds disagree on is named and gets no verdict. With `ARGS=--fresh`, after a `make build` on this working tree, an output the checkout does not commit and that matches the first build on every file name and every byte but build metadata stands in for the second build, which then does not run. Hashed file names are paired by content, so `app-3f9c1a2b.mjs` and `app-8b20de41.mjs` are one file under two names and a reference carrying the hash counts as build metadata rather than a difference; a source map is compared as the map it is, by what it was compiled from. The checkout is only read: nothing is installed into it and the scratch tree is removed again.

`build-verify` is the one analyser that installs and builds, so it needs the network and takes minutes rather than a second, and it needs git and npm where it runs. `ARGS=--once` builds once and states the open question instead of answering it, `ARGS=--build=dist` verifies another output directory.

`changelog-lint` reads the changelogs as the App Store does when a release is published. The store reads `CHANGELOG.md` for English and `CHANGELOG.<code>.md` for each language of its list (`CHANGELOG.de.md`, `CHANGELOG.pt-br.md`), under exactly those names, decodes them as UTF-8 and shows the section whose heading begins with `## 1.2.3`, `## [1.2.3]` or `## v1.2.3` for the version in `info.xml`; a version with a `-`, and a nightly (`ARGS=--nightly`), is read from `## [Unreleased]`. A tagged pre-release is a release of its own, and the lint asks for its own section `## [X.Y.Z-rc.N]`, as `make changelog` writes it; the store shows that section with the stable `X.Y.Z`, below its own, and reads the page of the pre-release from `## [Unreleased]`, which the lint reports with `[i]`. What the store does not find, the release is published without, silently. `[!]` marks a missing `CHANGELOG.md`, a name that differs only in its spelling (with the `git mv` that fixes it), an unknown language code, a file that is not UTF-8 and a missing or empty section; `[i]` a changelog under a name the store never reads. It exits 1 on a `[!]` finding, and `make tag` runs it before the confirmation and refuses on that exit code (`NO_CHANGELOG_LINT=1` tags regardless); it is worth running on its own right after `make changelog`.

`php-compat` runs the checkout on two PHP versions, each in the build image of that minor (`ghcr.io/ernolf/ncmake-php:<minor>`): the floor `make build` resolves against, and the ceiling, the newest PHP minor that the server of `<nextcloud max-version>` runs on, read from `lib/versioncheck.php` of its stable branch, or of master for a major without one; a higher `<php max-version>` raises it, but no further than the ceiling of master. `PHP=all` adds every minor in between. On each it runs `composer check-platform-reqs --no-dev` and `php -l` over `appinfo/`, `lib/`, `templates/` and `vendor/`. `[!]` marks a package or the app's `composer.json` that refuses one of those PHP versions, a shipped file that does not parse, a `<php max-version>` below the ceiling (a server on a newer PHP refuses to enable the app), a `<php max-version>` above the ceiling of master (a PHP no server runs yet, on which a server would later enable the app unchecked) and a PHP version that could not be checked; `[i]` a deprecation, an extension the build image lacks, a file of a dev package and a check without `vendor/` or `composer.lock`. Run it after `make build`, so `vendor/` holds what ships; the output of each run stays in `build/php-compat/<minor>`. A `<php max-version>` above the ceiling of master runs once more, in `ghcr.io/ernolf/ncmake-php:<minor>-next`, and `NEXT=1` runs the newest PHP ahead of master, `ghcr.io/ernolf/ncmake-php:next`, for any app; the findings of that run are `[i]`, named after the exact PHP (`8.6.0RC3`), and the report says whether that PHP has a release yet. Its output stays in `build/php-compat/next`; `RUNTIME=bare` leaves it out. It needs the network and exits 1 on a `[!]` finding.

`deps-audit` asks the package managers' own audits about what ships, dev dependencies left out: `composer audit --locked --no-dev` in the build image of the PHP floor, and `npm audit --omit=dev`, `pnpm audit --prod`, `yarn npm audit --environment production --recursive` or, for Yarn 1, `yarn audit --groups dependencies`, as the lock file decides, on the Node line the app declares, pnpm and yarn through corepack. Each vulnerable package is one `[!]` finding with its advisories, the highest severity among them and the first released version above the locked one that fixes them all; `vulnerable-dependency` when the declared constraints allow that version, with the update command, `vulnerable-dependency-pinned` when a constraint excludes it, naming the constraint and who declares it. composer decides that with `composer why-not`; for npm the ranges come from `package-lock.json` or `yarn.lock`, and `pnpm-lock.yaml` records only those of `package.json`, which the finding says for a package further down. `[i]` marks an abandoned composer package with its replacement (`abandoned-dependency`), an advisory source that did not answer (`audit-unavailable`, nothing of that lock file checked) and dependencies without a lock file (`lock-missing`). Both vulnerability findings carry `"security": true` in the JSON. The report goes to `build/reports/deps-audit.txt` and `.json`, the raw output of the audits to `build/deps-audit`, and the target exits 0 with findings: the gate is the lint-deps workflow of ncmake-workflows. It needs the network for the advisories and the released versions; it reads `vendor/` and `node_modules/` not at all, so it runs on a fresh clone.

Like the bundle analysers, each takes `ARGS=--json` and `JSON=<file>`. `make help-consistency-audit`, `make help-build-verify`, `make help-changelog-lint`, `make help-php-compat` and `make help-deps-audit` list every option.

## Lint module

The lint workflows of ncmake-workflows as make targets, in `mk/lint.mk`. Each target collects the same files, runs the same tool in the same version and fails where its workflow fails, so a finding shows on the maintainer's machine before it shows in a public CI log. The tool versions are pinned in the module and nowhere else. The targets read the checkout, write nothing into it and need no token.

| Target | What it checks |
| --- | --- |
| `make lint-actions [JSON=<file>]` | actionlint, with shellcheck over the `run:` scripts, over every tracked workflow: whether it is valid |
| `make lint-actions-security [JSON=<file>] [SARIF=<file>]` | zizmor over every tracked workflow and action definition: what makes a workflow attackable |
| `make lint-containerfiles [JSON=<file>]` | hadolint over every tracked Containerfile and Dockerfile |
| `make lint-markdown [JSON=<file>]` | markdownlint-cli2 over every tracked Markdown file |
| `make lint-php-syntax [PHP_VERSIONS="<versions>"] [JSON=<file>]` | `php -l` over every tracked PHP file, once per PHP version |
| `make lint-shell [JSON=<file>]` | shellcheck over every tracked shell script |
| `make lint-vue-imports [JSON=<file>]` | imports of the `@nextcloud/vue` root in the tracked source files |
| `make lint-web [JSON=<file>]` | ESLint, Stylelint and html-validate over the plain web files of a repository without a `package.json` |
| `make lint-yaml [JSON=<file>]` | yamllint over every tracked YAML file |
| `make lint` | every target of the module, one after the other |

Every target collects its files with `git ls-files`, as its template does, and leaves out `node_modules/` and `vendor/` where the template does. A configuration of the tool in the repository wins; without one, `lint-markdown`, `lint-web` and `lint-yaml` apply the default of their template. A repository without files of the kind passes. `[!]` marks what fails the template and exits 1, `[i]` what passes it: a warning of ESLint, Stylelint, markdownlint or yamllint (unless the yamllint configuration sets `strict`), a hadolint finding below its `failure-threshold` (`info` unless the configuration sets one), and a warning or deprecation of `php -l`. Every error of actionlint and every finding of shellcheck and of `lint-vue-imports` is `[!]`. Each finding names file, line, rule and the page of the rule. Each target takes `ARGS=--json` and `JSON=<file>`, and `ARGS=--details` lists the files it checked.

`lint-actions` checks what `lint-actions-security` checks, without the action definitions, and reads `.github/actionlint.yaml` or `.yml`. `lint-shell` takes every `*.sh` and `*.bash`, and every other file whose shebang names sh, bash, dash or ksh, and reads `.shellcheckrc`. `lint-containerfiles` takes `Containerfile`, `Dockerfile`, `*.containerfile` and `*.dockerfile` and reads `.hadolint.yaml` or `.yml`. `lint-vue-imports` finds a static or dynamic import, a re-export, a `require` and a `vi.mock` or `jest.mock` of the root, in `.vue`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx` files; an entry point such as `@nextcloud/vue/components/NcButton` passes. `lint-web` passes a repository with a `package.json`, which lints through its own scripts, and leaves out minified `*.min.js` and `*.min.css`. `lint-php-syntax` checks the PHP versions of `PHP_VERSIONS`, of a `.php-version` file or the default `8.2 8.4`, separated by spaces, commas or semicolons, and refuses a word that is not digits and dots; a parse or fatal error is `[!]` under the version that reports it.

The tools are pinned in the module: actionlint, shellcheck, hadolint and zizmor as the Linux binaries of their GitHub releases, checked against their sha256 digests; yamllint with pathspec and PyYAML as source distributions from PyPI, checked against their digests, which run on the Python of the analysers' Node image without pip; markdownlint-cli2, ESLint, Stylelint and html-validate installed by npm in the analysers' container, each pinned to a version and checked against the integrity the registry records. All of them are kept in `tools/` of the ncmake cache, fetched once per version and mounted read-only, so the host needs none of them; a version a newer one supersedes is removed once no ncmake container runs. `lint-php-syntax` runs each version in `docker.io/library/php:<version>-cli-alpine`. With `RUNTIME=bare` the tools run on the host: an npm package whose `engines.node` the host's Node does not meet stops the run with that range, and `lint-php-syntax` runs the host's `php<version>`, or its `php` when that is the version, and reports a version it has neither for as not run.

`lint-actions-security` checks the tracked files under `.github/workflows` and `.ncmake/workflows`, every `action.yml` or `action.yaml` outside `node_modules/` and `vendor/`, and every YAML file with a `.properties.json` beside it, the form of a workflow template. zizmor runs offline and reads the repository's own `.github/zizmor.yml` or `zizmor.yml`. Findings of medium and high severity are `[!]` and exit 1, low and informational ones `[i]`; each names file and line, the zizmor audit and its page. Every finding in the JSON carries `"security": true`. `SARIF=<file>` writes the findings for GitHub code scanning as well. The zizmor binary is the one of its GitHub release, checked against its digest, kept in `tools/` of the ncmake cache and run in the analysers' Node container, so the host needs neither zizmor nor Node. A repository without workflows passes.

`make lint` runs each target in a make of its own, so a failed one does not stop the next, and fails when one failed. `ARGS`, `JSON=` and `SARIF=` belong to a single target, and `make lint` refuses them. `make help-<target>` lists every option of a target.

## CI workflow manager

`make workflows-list` (alias `make workflows`) shows every workflow the configured sources offer, with source, status and description. Sources, in lookup order: `local`, the folder `ncmake-workflows/` of the app; `ncmake`, the templates of [ernolf/ncmake-workflows](https://github.com/ernolf/ncmake-workflows); `nextcloud`, the `nextcloud/.github` templates. On a name collision the first listed source wins, so an app's own workflow overrides a template of the same name. Discovery is live through the GitHub API, so new upstream workflows appear without an ncmake update.

The templates of ernolf/ncmake-workflows, all of them generic:

| File | What it does |
| --- | --- |
| `lint-php-syntax.yml` | `php -l` over every tracked PHP file, without composer and without `appinfo/info.xml`; the version matrix comes from the `PHP_VERSIONS` variable, a `.php-version` file or the template default |
| `lint-shell.yml` | shellcheck over every tracked shell script, found by extension or by shebang, so extensionless commands are covered; a repository without shell scripts passes |
| `lint-vue-imports.yml` | fails when a tracked source file imports the `@nextcloud/vue` root instead of a per-component entry point, which pulls the whole library into the module graph before tree shaking; a repository without a hit passes |
| `lint-web.yml` | ESLint, Stylelint and html-validate over the tracked JavaScript, CSS and HTML of a repository without a Node project, each at a pinned version; a configuration in the repository root wins over the tool's recommended set; a repository with a `package.json`, which lints through its own scripts, or without such files passes |
| `backport.yml` | answers a `/backport to <branch>` comment on a pull request with a verified, signed-off pull request that carries its change to that branch; on an open pull request it runs at the merge (see below) |
| `branch-cleanup.yml` | deletes a merged pull request's head branch if it still exists, a workflow-shipped equivalent of the repository setting |
| `release.yml` | builds the release tarball with ncmake and attaches it to the published GitHub release |
| `workflow-updater.yml` | refreshes the managed workflows on a schedule and opens a pull request when anything changed (see below) |

A workflow of the app's own lives in `.ncmake/workflows/<name>.yml`, optionally with `<name>.properties.json` for its description, and is installed into `.github/workflows/` like any template. Dependabot keeps that folder current with `directory: "/.ncmake/workflows"`, which never touches `.github/workflows/`; `make workflows-update` then installs the change. Once such a workflow is generic, it belongs in ernolf/ncmake-workflows.

A further source is one line in `ncmake.mk`, `wf_sources += <owner>/<repo>[@<ref>][:<dir>]`, for a GitHub repository with the same layout (`dir` defaults to `workflows`, `ref` to the default branch); it ranks after `local` and before `ncmake` and `nextcloud`. For anything not GitHub-shaped, add a name instead and define `wf_src_<name>_list` (a GitHub contents API URL) and `wf_src_<name>_raw` (the prefix the files are downloaded from). The source `ncmake` reads `main`; `NCMAKE_WORKFLOWS_REF=<ref>` reads another branch or a tag. Each remote source costs one GitHub API call per run; `GITHUB_TOKEN` or `GH_TOKEN` raises the anonymous limit.

Status per file: `installed`, `update available`, `modified` (local edits, never overwritten), `missing` (in the lock but deleted locally), `unmanaged` (present but not installed through ncmake), `gone upstream`.

| Command | Effect |
| --- | --- |
| `make workflows-install W="lint-php,psalm-matrix"` | fetches the named workflows (the `.yml` suffix is optional, comma or space separated) |
| `make workflows-update` | brings every managed workflow to the current upstream state, skipping locally modified ones with a note |

On install, GitHub's template placeholders are substituted (`$default-branch` from the origin HEAD; unknown ones are reported and left as they are) and the org-scoped runner labels are rewritten (`ubuntu-latest-low` to `ubuntu-latest`) unless the origin owner is `wf_runner_org`, default `nextcloud`. Source, upstream sha and content hash go into `.github/workflows/.ncmake-workflows.json`, accompanied by a `.license` sidecar that keeps `make reuse` green without a `REUSE.toml` edit. Commit the lock and its sidecar together with the workflows.

Both targets take `COMMIT=1` and `PR=1`. They must run on `main` or a `stable*` branch. `COMMIT=1` opens the branch (`ncmake/ci/workflows-install` or `ncmake/ci/workflow-update`; on `stableX.Y` with the line appended, for example `ncmake/ci/workflows-install-stable0.7`), commits with `Signed-off-by` and one bullet per changed file, and prints the push command without pushing. `PR=1` implies `COMMIT=1` and additionally pushes and opens the pull request through `gh`, against the branch the target started from. Both refuse when the branch already exists locally or on origin, and discard the branch again when there was nothing to commit.

## Workflow updater and the comment commands

The shipped `workflow-updater.yml` keeps the managed workflows current on its own: a daily cron at 05:30 UTC plus `workflow_dispatch`. It runs `make dev-init` and `make workflows-update` and hands the result to `peter-evans/create-pull-request`, which commits through the API with `sign-commits` and `signoff`, so the commits are verified. Authentication is a GitHub App, through the repository secrets `NCMAKE_UPDATER_CLIENT_ID` and `NCMAKE_UPDATER_PRIVATE_KEY` (setup: <https://github.com/ernolf/ncmake/wiki/GitHub-App>). When the pull request is closed, a cleanup job deletes the branch `ncmake/ci/workflow-update`.

**The rebase comment command.** When the updater's pull request has fallen behind the default branch, comment on it:

```text
@ncmake-updater rebase
```

The workflow re-runs the update against the current default branch, so `create-pull-request` rebuilds the branch from scratch. It reacts with 👀 when it picks the comment up and with 🚀 when it is finished, both through the default `github.token` with `issues: write`.

Two things about it are worth knowing:

* The trigger is gated. Only a comment on a **pull request**, whose author association is `OWNER`, `MEMBER` or `COLLABORATOR`, starts the job. A comment on an issue, or from anyone else, does nothing.
* Use it instead of GitHub's "Update with rebase" button. That button, like a `git rebase` in the runner, pushes commits that carry no signature, so the pull request loses its verified status. Going through the API keeps every commit verified.

**The backport comment command.** The template `backport.yml` (`make workflows-install W=backport`, same GitHub App and secrets) carries a merged change to a maintenance line. Comment on the pull request, one line per target branch:

```text
/backport to stable0.7
```

* On a merged pull request it runs at once; on an open one it waits for the merge, which reads all comments again, the newest per branch counting. The author association gate is the same as for the rebase command.
* It cherry-picks the pull request's own non-merge commits from `refs/pull/<n>/head` with `--no-commit` onto the target branch and commits the result through `create-pull-request` as one verified, signed-off commit on `ncmake/backport/<n>/<branch>`, with the original messages and their `(cherry picked from commit …)` lines. The title is the original one with `[<branch>]` appended.
* Reactions on the command: 👀 picked up, 🚀 pull request open, 👎 failed (a comment names the conflicting files or the missing branch and gives the manual commands), 😕 not understood.
* The merge trigger is `pull_request_target`, which runs the workflow copy of the base branch with secrets, also for a fork. A command that waits on a pull request against `stableX.Y` therefore needs the workflow on that branch too; otherwise write it after the merge.

## Translations module

The repository side of the Nextcloud Transifex sync, in `mk/l10n.mk`. Transifex itself is not touched: no API call and no token, the sync stays with the Nextcloud bot.

| Target | What it does |
| --- | --- |
| `make l10n-init [COMMIT=1\|PR=1]` | writes `l10n/.gitkeep`, `.l10nignore` and `.tx/config` where they are missing and covers them in `REUSE.toml`, then prints the steps outside the repository |
| `make l10n-check` | validates the setup on every branch the bot syncs, as the request check of nextcloud/docker-ci does |
| `make l10n-lint [FIX=1] [L10N_RULES=<file>]` | holds the English source strings against the rules of the translation team and names file and line of each finding |

`l10n-init` derives everything from what ncmake reads anyway. `.tx/config` is the template of the translation request with the app id from `info.xml` as the resource and in the `.po` and `.pot` names, which is the name the translation tool writes. `.l10nignore` lists `js/` and `vendor/` where `.gitignore` marks them as build output or they exist, and `vendor-bin/` where it exists. An existing file is left as it is. In `REUSE.toml` the new files join the annotation that already covers one of the sync files, or get one of their own under the copyright and license the file states in its header. The printed steps are, for an app outside the nextcloud organisation, inviting `nextcloud-bot` with write access and exempting it from the ruleset that protects `main`, then opening the translation request at nextcloud/docker-ci.

`l10n-check` fetches origin and checks the branches the bot syncs as origin has them: `main`, `master` and those in `.tx/backport` on `main`, or without that file the default list of `validateSyncSetup.sh`, read from that script at run time. Per branch it runs the translation tool's `prepare-source-validation` and `validateTranslationFiles.sh` over a copy of the branch, in the image the bot runs in (`ghcr.io/nextcloud/continuous-integration-translations`), so the validation is the Nextcloud one. On top of that it reports what makes a sync fail or extract the wrong strings without a message: an `.l10nignore` that misses a build output or third-party tree (a line with a carriage return, trailing blanks or a leading slash never matches, because the tool compares it unchanged), a `.tx/config` whose resource or file names are not the app id, and a `.tx/backport` entry that is not a `stable*` branch on origin. Findings are marked `[!]` and `[i]`; a `[!]` or a failed validation exits non-zero. It writes nothing into the checkout, the copies stay under `build/cache/l10n-check`, and it needs podman or docker.

`l10n-lint` catches what the translation team rejects in its review before the first sync, after which it locks the resource until the strings are fixed: a typographic apostrophe, three dots instead of the ellipsis, a contraction, a number without the plural form, a plural without `%n`. The strings are the template the translation tool writes, in the bot's image, for a copy of the working tree; each is located in the sources as the literal of a `t()` or `n()` call or as an element of `appinfo/info.xml`, and every finding names the rules, the fix and the file and line. `FIX=1` rewrites the strings with a fix in the sources and never touches `l10n/*.json`, which come from Transifex. The rules are not code: `lib/l10n-rules.json` in the ncmake repository holds each rule with its weight (`must` is what the review rejects, `should` a style call), its source, its pattern or requirement, its replacement and examples, and a rule whose examples do not hold stops the run. A new rule is a pull request against that file. `L10N_RULES=<file>` uses a rule file of one's own, `ARGS=--self-test` only tests the rule file. It needs podman or docker.

## gh module

`make gh-install` sets up the official GitHub CLI package source and installs `gh`, following the upstream install guide. The package manager is auto-detected: apt, dnf5, dnf4, yum, zypper, pacman, apk, brew or conda. On Debian and Ubuntu the source is written in deb822 format as `/etc/apt/sources.list.d/github-cli.sources` with the ASCII-armored signing key inside the file, so no separate keyring is left behind, and the key is verified against the documented fingerprints when gpg is available (override `gh_key_fprs` in `ncmake.mk` after a key rotation). The target is idempotent: an existing source reports that it is up to date, an installed `gh` gets the upgrade command printed instead of being reinstalled. Privileged steps announce themselves and run through sudo; brew and conda never need root.

## git module

`make git-aliases` writes the git aliases of the wiki page [Git tips](https://github.com/ernolf/ncmake/wiki/Git-tips) into the global git configuration of the calling user: the short forms `ci`, `p`, `pf`, `pu`, `amend`, `st`, `lg`, `last` and `alias`, the guarded first push `puh`, the post-merge cleanup `merged` and `gone`, which deletes local branches whose upstream is gone. An alias that is not defined yet is set, one with the same command is reported as up to date, and one the user defined with a different command is left as it is and reported with both commands; `FORCE=1` overwrites it. It needs no root. The commands live in one table in `mk/git.mk`, one line per alias.

## Self-update and pinning

In stub mode the per-machine cache refreshes itself at most once per `NCMAKE_TTL_MIN` (default 1440 minutes) with a conditional GET, so being offline or an unchanged upstream costs nothing. A committed full copy never modifies itself. `make self-update` fetches the newest Makefile immediately and drops the ETag. `NCMAKE_REF` pins ncmake to a branch or tag, and the cache is keyed by that ref, so pinned and unpinned apps coexist on one machine.

This skill file is a copy that does not refresh itself. `make skill-install` fetches it from the same `NCMAKE_REF` into `skill_dir` (default `~/.claude/skills/ncmake`) and says whether it was installed, updated or already current; run it again after `make self-update`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `no container runtime found` | install podman (`apt-get install podman`), or use `RUNTIME=bare` with composer and npm on the `PATH` |
| `check-app` fails | the command is not running in an app root, or `appinfo/info.xml` is missing or has no valid `<id>` |
| `check-build` fails | the git-ignored build outputs are absent; run `make build` |
| `make psalm` reports a missing `vendor/bin/psalm` | the dev tools are not installed; run `make composer ARGS=install` |
| Usage message from `composer` or `npm` | `ARGS` was empty; it is mandatory |
| `dev-init` or `workflows-list` hits a rate limit | anonymous API budget exhausted; export `GITHUB_TOKEN` or `GH_TOKEN` |
| `make version` refuses | not on `main` or a `stable*` branch, the tag exists, or the entered version is outside the range the branch owns, which it prints before the prompt: on `main` not above every tag, on a `stable*` branch not above its newest tag or not below the next tag of a newer line, or in a major.minor that a tag of another branch has; "not in this checkout: git pull first" means origin has a newer tag of the same branch |
| `make stable-branch` refuses | not on `main`, uncommitted changes, the line has no tag, is the current or a newer line, the branch name lacks the `stable` prefix, or the branch exists locally or on origin (then `git switch <branch>`) |
| `make tag` refuses | the tag exists, `make changelog-lint` reports a `[!]` finding or, without the audit module, `CHANGELOG.md` has no section for this version (run `make changelog`; `NO_CHANGELOG_LINT=1` tags regardless), or the working tree is not clean - commit, stash or remove what `git status --short` lists, untracked files included |
| `workflows-install` or `workflows-update` refuses | with `COMMIT=1`/`PR=1` not on `main` or a `stable*` branch, or the branch exists locally or on origin; merge, close or delete it, then run the target again |
| `could not fetch .../lib/<file> - network?` | the analysers are not in the cache and the download failed; check the network and run the target again |
| `bundle-report` names no packages | the build ships no source maps, so the bytes cannot be attributed; the per-file sizes still hold |
| `build-verify` names a file as differing | the committed build output did not come from this source; run `make dist-clean && make build` and commit what the build writes |
| `build-verify` fails before it builds | it needs git and npm where it runs and the network to install; ncmake's Node image carries git and the mounted Node line npm, a `node_image` of one's own must carry both |
| `this module needs a newer ncmake core` | a cached analyser module expects the core's analyser library section; `make self-update` fetches the current core |
| `integrity-check` reports `CERTIFICATE_MISMATCH` | the signature was made with a different certificate than the committed `.ncmake/certificate.crt`; sign again with the key belonging to that certificate, or re-run `make integrity-enable` if the certificate was legitimately reissued |
| The release job fails with no signature id | the app is marked as signed but the tag message carries no `ncmake-signature:` line, so the signature step was declined or the tag predates it; `make dist-signed` and attach the tarball by hand, or re-tag |
| `integrity-check` reports `INVALID_HASH` in the runner for untouched files | the runner's build output differs from the one the signature was taken over; `make build-verify` locates it, `make dist-signed` gets the release out meanwhile |
| A target behaves like an older ncmake | `make self-update` |

## Conventions ncmake assumes

Conventional commit subjects (the changelog is generated from them), `main` as the default branch, `git commit -s` (the modules pass `-s`, so DCO checks pass), signed tags, and REUSE-compliant licensing (`make reuse` checks it).

## Further reading

* [Getting started](https://github.com/ernolf/ncmake/wiki/Getting-started) and the [step-by-step walkthrough](https://github.com/ernolf/ncmake/wiki/Step-by-step)
* [How ncmake understands your app](https://github.com/ernolf/ncmake/wiki/How-ncmake-understands-your-app), [Building and packaging](https://github.com/ernolf/ncmake/wiki/Building-and-packaging), [Bundle analysis](https://github.com/ernolf/ncmake/wiki/Bundle-analysis), [Checkout audit](https://github.com/ernolf/ncmake/wiki/Checkout-audit), [Per-app tuning](https://github.com/ernolf/ncmake/wiki/Per-app-tuning), [Target reference](https://github.com/ernolf/ncmake/wiki/Target-reference)
* [Releasing](https://github.com/ernolf/ncmake/wiki/Releasing), [App Store](https://github.com/ernolf/ncmake/wiki/App-Store), [Integrity signature](https://github.com/ernolf/ncmake/wiki/Integrity-signature)
* [Workflows](https://github.com/ernolf/ncmake/wiki/Workflows), [Workflow updater](https://github.com/ernolf/ncmake/wiki/Workflow-updater), [Backport](https://github.com/ernolf/ncmake/wiki/Backport), [GitHub App](https://github.com/ernolf/ncmake/wiki/GitHub-App), [GitHub PAT](https://github.com/ernolf/ncmake/wiki/GitHub-PAT), [Deleting merged branches](https://github.com/ernolf/ncmake/wiki/Deleting-merged-branches)
