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
6. **Maintainer targets change the world.** `version`, `changelog`, `tag`, `stable-branch`, `csr`, `register`, `sign`, `release`, `publish`, `delete-release`, `integrity-enable`, `integrity-sign`, `dist-signed`, `dev-init` and every `COMMIT=1` / `PR=1` / `AMEND=1` variant write commits, tags, branches, pull requests, App Store entries or signatures. Run them only when the user explicitly asks for that step, one step at a time. Read-only targets (`build`, `dist`, `psalm`, `reuse`, `composer`, `npm`, `integrity-check`, `bundle-report`, `build-audit`, `consistency-audit`, `build-verify`, `changelog-lint`, `list-releases`, `workflows-list`, `help`) are free to run.
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
| `package.json` | an npm step is needed when `scripts.build` exists; the lock file picks npm, pnpm or yarn; `engines.node` picks the Node image, the newest LTS line it allows that is not end of life; the version is bumped here too |
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
| Install the PHP dev tools (psalm, cs) | `make composer ARGS=install` |
| Static analysis | `make psalm` (or `make psalm ARGS="--show-info=true"`) |
| Coding style | `make composer ARGS="cs:check"`, `make composer ARGS="cs:fix"` |
| Runtime dependencies only | `make composer ARGS="install --no-dev"` |
| Refresh `composer.lock` | `make composer ARGS=update` |
| Resolve against the PHP support floor | add `PHP=min` to the composer call |
| License compliance | `make reuse` |
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
| Update ncmake itself | `make self-update` |
| Install or refresh this skill file | `make skill-install` |

`TARGET` for `rsync` and `cp` is the **parent** `apps/` directory; the app subdirectory is appended automatically. `OCC=1` wraps the copy into `occ app:disable`, `chown` to `web_user` (default `www-data`) and `occ app:enable`, so `info.xml` is re-read and migrations run. Without `OCC=1` those commands are only printed. `ENGINE=docker|podman` picks the container CLI for `cp` independently of `RUNTIME`.

## Containers and images

| Image | Used by | Purpose |
| --- | --- | --- |
| `ghcr.io/ernolf/ncmake-php:<floor>` | `make build`, anything with `PHP=min` | dependencies resolve against the PHP floor, which is what a correct package needs: the declared `min-version`, raised to the floor of the newest end-of-life Nextcloud major when it is lower; `docker.io/library/php:<floor>-cli-alpine` with the extensions a Nextcloud server offers (`php_extensions`), Composer 2, git and unzip, published by ncmake for amd64 and arm64 for every PHP minor from that floor to the ceiling of Nextcloud master and rebuilt when one of its inputs changes; pulled like any other image. `localhost/ncmake-php:<floor>` is built on the host from the same Containerfile instead when `php_extensions` in `ncmake.mk` adds an extension the published image lacks, or when no source serves the published one |
| `docker.io/library/composer:2` | `make composer`, `make psalm` | newest PHP patch plus composer, git and unzip, which current dev tools need |
| `docker.io/library/node:<major>`, the newest LTS line `engines.node` allows that is not end of life, fallback `docker.io/library/node:lts` | every npm run, `build-verify` | the Node version the app declares |
| `docker.io/library/node:lts` (`lib_node_image`) | `consistency-audit`, `changelog-lint`, `bundle-report`, `build-audit` | the analysers need Node 18 or newer and build nothing, so the app's Node does not apply |
| `docker.io/fsfe/reuse` | `make reuse` | the REUSE compliance checker |

`PHP=min|max` switches the PHP side explicitly. `build` pins `PHP := min`, `psalm` pins `PHP := max`. `RUNTIME=podman|docker|docker-rootless|bare` selects the runtime; it is auto-detected with podman preferred, and `docker` maps the caller's uid and gid so no root-owned files appear in the checkout.

Every container runs with `--rm` and `--label ncmake`. Before it starts, its image is pulled again once the last check is older than `IMAGE_CHECK_MIN` minutes (default 1440), and the image that pull superseded is removed right away. Images that a container still uses or another tag still names stay. `images.txt` records each image ncmake used, whether ncmake pulled it or found it on the host, and when it was last used and checked. It is state, not cache, and lives beside the image store it describes: `${XDG_STATE_HOME:-~/.local/state}/ncmake/` for a rootless store (podman run by a user, rootless docker), `/var/lib/ncmake/` for a store of the whole host (podman run by root, rootful docker). For rootful docker run by a member of the docker group, ncmake asks once whether to create `/var/lib/ncmake` with sudo; on no it keeps the record per user, and `make image-setup` asks again. Deleting the cache leaves the record alone.

Which registry serves an image is data, not code: `core/image-sources` in the ncmake repo lists, per image reference prefix, the registries to try in order (for the Docker Official Images ECR Public, then `mirror.gcr.io`, then Docker Hub, whose anonymous pull limit is the strictest). A pull that fails, through a rate limit or otherwise, falls through to the next source. The image is tagged with its reference afterwards, so the host keeps one name whatever served it. The list is cached and refreshed like the Makefile; `IMAGE_SOURCES=<file>` uses a list of one's own instead.

`make image-clean` lists the images of every container CLI on the host with size, last use and status (`ncmake`, `built`, `ncmake-used`, `dangling`, `foreign`, `in use`) and removes the ones picked at the prompt. `OWN=1` picks every image ncmake pulled but not the one it built, `OLD=1` every dangling image and every image ncmake pulled or built unused for `IMAGE_IDLE_MIN` minutes (default 10), `DRY=1` only shows the pick. The flags never pick a foreign image or one in use, and nothing is removed with `-f`. It removes images from the host, so run it only when the user asks for it.

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

1. On `main`, with a clean tree: `make version`. It prompts for the new version, `X.Y.Z` or a pre-release `X.Y.Z-alpha.N`, `-beta.N`, `-rc.N`, validates that it is greater than the latest tag in the order of PHP `version_compare` (`1.2.0-rc.1` before `1.2.0`), creates the branch `ncmake/release/X.Y.Z`, bumps `info.xml`, `composer.json` and `package.json`, re-syncs the lockfiles in the containers and commits the bump with `-s`. It warns when the composer or package description has drifted away from the `info.xml` summary.
2. On that branch: `make changelog`. It moves everything under `## [Unreleased]`, together with the conventional commits since the last change to `CHANGELOG.md` (`feat` to Added, `fix` to Fixed, `perf` to Changed; `build`, `ci`, `test`, `chore`, `docs`, `refactor`, `style`, merges and the Transifex `fix(l10n)` commits are skipped), into the `## [X.Y.Z]` section, inserts it below `## [Unreleased]` together with its `[X.Y.Z]:` link reference and prints the exact commit command. While the bump commit is still unpushed that command is `git commit --amend --no-edit`, so a release stays one commit; `make changelog AMEND=1` runs it, and `AMEND=1 PR=1` also pushes the branch and opens the pull request. Rerunning the target is safe. An app-provided `cliff.toml` overrides the built-in configuration.
3. Push the branch, open the pull request, let CI pass, merge it.
4. `git checkout main && git pull`, then `make tag`. It refuses to re-tag, refuses a working tree that is not clean (untracked files included, because the release is packed from the checkout), checks the changelog before the confirmation, and creates and pushes the signed tag after a confirmation prompt. For an app marked as signed it offers the signature between the confirmation and the tag (see below). With the audit module the changelog check is `make changelog-lint` and refuses on a `[!]` finding; without it, `make tag` refuses when `CHANGELOG.md` has no section for the version. `make tag NO_CHANGELOG_LINT=1` skips the check, for a release that is meant to go out regardless.
5. Publish the GitHub release for that tag. The shipped `release.yml` workflow builds and attaches the tarball, verifying the signature before it packs when the app is signed.
6. App Store: `make publish GH=1` (see below).

### Maintenance lines

An older release line, for example 0.7 while `main` is at 0.8, gets its own `stable*` branch and its own releases:

1. On `main`: `make stable-branch`. It lists the release lines from the tags, prompts for one (`X.Y`) and refuses a line without a tag, the current line of `main`, a newer one, and a `stableX.Y` that already exists locally or on origin. The branch starts at the newest tag of the line, never at `main`. Before it is created, it shows the Nextcloud and PHP ranges at that tag next to those of `main` and notes when the line still reaches into the Nextcloud versions `main` covers; capping `max-version` is then the first PR against the branch. After a confirmation it creates and pushes the branch.
2. Protect the branch on GitHub like `main`.
3. Changes reach the branch only through PRs against it. A backport: `git switch -c <branch> stableX.Y && git cherry-pick -x <commit>`.
4. A workflow that `main` gained after the line's tag, for example one whose check the repository rules require, comes over on `stableX.Y` with `make workflows-install W=<name> PR=1`. The workflow updater never reaches a `stable*` branch, so `make workflows-update PR=1` runs there by hand.
5. For an app with `.tx/config`: the Nextcloud Transifex bot syncs only the branches that `.tx/backport` on `main` lists (one per line, replacing the server's `stable*` names), so `stableX.Y` goes into that file through a PR against `main`, together with a `REUSE.toml` entry for it. The bot pushes its commits directly, so it needs write access as a collaborator and a bypass on the rule that protects the branch, as on `main`. `make stable-branch` prints both steps.
6. Release from it exactly as from `main`, with `stableX.Y` in place of `main`: `make version` keeps the major.minor of the line and compares against the tags reachable from the branch, `make changelog` keeps the tags of the other lines out, and `make tag` runs on `stableX.Y` after the merge. When publishing the GitHub release, untick "Set as the latest release".

## Developer modules

The App Store, CI workflow, bundle analysis, checkout audit, integrity signature, gh and git targets are optional modules that live in the ncmake repository under `mk/`. `make dev-init` fetches them into the same per-machine cache as the core Makefile, from where every ncmake app on that machine sees them. The module list is discovered live through the GitHub contents API, so new modules arrive without an ncmake update. `make dev-clean` removes them again, which restores the plain user target set.

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
| `make integrity-check [DIR=<path>] [TARBALL=<file>]` | holds a tree or a packed release against its own `signature.json`; needs no key, which is why the runner can run it |
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

Both mark findings `[!]` worth changing, `[i]` worth knowing, `[ok]` nothing found, and each finding says what it is derived from. `ARGS="--details"` adds the tables behind them, `ARGS=--json` emits the whole result for a script. `make help-bundle-report` and `make help-build-audit` list every option.

The analysers are dependency-free ESM files that share their measuring core, so both count the same way. They are fetched into the per-machine ncmake cache on first use, on the same TTL and ETag terms as the modules, and mounted read-only into the throwaway Node container, so the host needs no Node. The fetch happens only when one of the two targets is on the command line, so no other target in any app pays for it.

## Checkout audit module

Three more analysers, in `mk/audit.mk`, about the checkout rather than the bundle. They share the report core with the bundle analysers, so findings read the same way everywhere.

| Target | Reads | Answers |
| --- | --- | --- |
| `make consistency-audit` | the metadata: `appinfo/info.xml`, `package.json`, `composer.json`, `.nvmrc`, the installed workflows | whether the checkout agrees with itself, and what a release still needs |
| `make build-verify` | the tracked source, rebuilt twice outside the app | whether the build output committed to the checkout comes from that source |
| `make changelog-lint` | `CHANGELOG.md`, `CHANGELOG.<code>.md`, the version in `appinfo/info.xml` | whether the App Store finds this release in the changelog |

`consistency-audit` holds the statements a checkout makes against each other: the version in `appinfo/info.xml` against the one in `package.json`, the PHP floor in `info.xml` against `composer.json`, every PHP extension that `composer.json` or a package in `composer.lock` requires against the `<lib>` entries in `info.xml`, unless every Nextcloud server has it, the Node version in `package.json` against `.nvmrc` and against the installed workflows. A linter checks one file against a rule and cannot see any of that. The second half is what a release needs and a checkout can be missing: the `<repository>` and `<bugs>` links, a `<nextcloud>` range that names servers that exist, one lockfile rather than two, a licence stated the same way everywhere, a linter a script calls while no configuration for it is in the tree. Metadata only, no build, no install, no network, which makes it useful on a fresh clone and on an app that never heard of ncmake. The list of released Nextcloud majors is written into the analyser for that reason, and the report names the month the list is from.

`build-verify` answers the other question: it copies the tracked files into a scratch tree outside the app, installs the locked dependencies there, runs the build - twice, the second time in another directory - and compares the result against what the checkout carries. Twice, because one build cannot separate a difference of the source from output that is not reproducible: what both builds wrote byte for byte the same is what this source produces, so a difference against the checkout is the checkout's, while a file the two builds disagree on is named and gets no verdict. Hashed file names are paired by content, so `app-3f9c1a2b.mjs` and `app-8b20de41.mjs` are one file under two names and a reference carrying the hash counts as build metadata rather than a difference; a source map is compared as the map it is, by what it was compiled from. The checkout is only read: nothing is installed into it and the scratch tree is removed again.

`build-verify` is the one analyser that installs and builds, so it needs the network and takes minutes rather than a second, and it needs git and npm where it runs. `ARGS=--once` builds once and states the open question instead of answering it, `ARGS=--build=dist` verifies another output directory.

`changelog-lint` reads the changelogs as the App Store does when a release is published. The store reads `CHANGELOG.md` for English and `CHANGELOG.<code>.md` for each language of its list (`CHANGELOG.de.md`, `CHANGELOG.pt-br.md`), under exactly those names, decodes them as UTF-8 and shows the section whose heading begins with `## 1.2.3`, `## [1.2.3]` or `## v1.2.3` for the version in `info.xml`; a version with a `-`, and a nightly (`ARGS=--nightly`), is read from `## [Unreleased]`. A tagged pre-release is a release of its own, and the lint asks for its own section `## [X.Y.Z-rc.N]`, as `make changelog` writes it; the store shows that section with the stable `X.Y.Z`, below its own, and reads the page of the pre-release from `## [Unreleased]`, which the lint reports with `[i]`. What the store does not find, the release is published without, silently. `[!]` marks a missing `CHANGELOG.md`, a name that differs only in its spelling (with the `git mv` that fixes it), an unknown language code, a file that is not UTF-8 and a missing or empty section; `[i]` a changelog under a name the store never reads. It exits 1 on a `[!]` finding, and `make tag` runs it before the confirmation and refuses on that exit code (`NO_CHANGELOG_LINT=1` tags regardless); it is worth running on its own right after `make changelog`.

`make help-consistency-audit`, `make help-build-verify` and `make help-changelog-lint` list every option.

## CI workflow manager

`make workflows-list` (alias `make workflows`) shows every workflow the configured sources offer, with source, status and description. Sources are ncmake's own workflows and the `nextcloud/.github` templates; on a name collision ncmake wins. Discovery is live through the GitHub API, so new upstream workflows appear without an ncmake update.

The workflows ncmake ships itself, all of them generic:

| File | What it does |
| --- | --- |
| `lint-php-syntax.yml` | `php -l` over every tracked PHP file, without composer and without `appinfo/info.xml`; the version matrix comes from the `PHP_VERSIONS` variable, a `.php-version` file or the template default |
| `lint-shell.yml` | shellcheck over every tracked shell script, found by extension or by shebang, so extensionless commands are covered; a repository without shell scripts passes |
| `lint-vue-imports.yml` | fails when a tracked source file imports the `@nextcloud/vue` root instead of a per-component entry point, which pulls the whole library into the module graph before tree shaking; a repository without a hit passes |
| `branch-cleanup.yml` | deletes a merged pull request's head branch if it still exists, a workflow-shipped equivalent of the repository setting |
| `release.yml` | builds the release tarball with ncmake and attaches it to the published GitHub release |
| `workflow-updater.yml` | refreshes the managed workflows on a schedule and opens a pull request when anything changed (see below) |

A further source is a three-line addition to `ncmake.mk`: append a name to `wf_sources` and define `wf_src_<name>_list` (a GitHub contents API URL) and `wf_src_<name>_raw` (the prefix the files are downloaded from). Lookup follows the order of `wf_sources`, so the first source listed wins a name collision.

Status per file: `installed`, `update available`, `modified` (local edits, never overwritten), `missing` (in the lock but deleted locally), `unmanaged` (present but not installed through ncmake), `gone upstream`.

| Command | Effect |
| --- | --- |
| `make workflows-install W="lint-php,psalm-matrix"` | fetches the named workflows (the `.yml` suffix is optional, comma or space separated) |
| `make workflows-update` | brings every managed workflow to the current upstream state, skipping locally modified ones with a note |

On install, GitHub's template placeholders are substituted (`$default-branch` from the origin HEAD; unknown ones are reported and left as they are) and the org-scoped runner labels are rewritten (`ubuntu-latest-low` to `ubuntu-latest`) unless the origin owner is `wf_runner_org`, default `nextcloud`. Source, upstream sha and content hash go into `.github/workflows/.ncmake-workflows.json`, accompanied by a `.license` sidecar that keeps `make reuse` green without a `REUSE.toml` edit. Commit the lock and its sidecar together with the workflows.

Both targets take `COMMIT=1` and `PR=1`. They must run on `main` or a `stable*` branch. `COMMIT=1` opens the branch (`ncmake/ci/workflows-install` or `ncmake/ci/workflow-update`; on `stableX.Y` with the line appended, for example `ncmake/ci/workflows-install-stable0.7`), commits with `Signed-off-by` and one bullet per changed file, and prints the push command without pushing. `PR=1` implies `COMMIT=1` and additionally pushes and opens the pull request through `gh`, against the branch the target started from. Both refuse when the branch already exists locally or on origin, and discard the branch again when there was nothing to commit.

## Workflow updater and the rebase comment command

The shipped `workflow-updater.yml` keeps the managed workflows current on its own: a daily cron at 05:30 UTC plus `workflow_dispatch`. It runs `make dev-init` and `make workflows-update` and hands the result to `peter-evans/create-pull-request`, which commits through the API with `sign-commits` and `signoff`, so the commits are verified. Authentication is a GitHub App, through the repository secrets `NCMAKE_UPDATER_CLIENT_ID` and `NCMAKE_UPDATER_PRIVATE_KEY` (setup: <https://github.com/ernolf/ncmake/wiki/GitHub-App>). When the pull request is closed, a cleanup job deletes the branch `ncmake/ci/workflow-update`.

**The rebase comment command.** When the updater's pull request has fallen behind the default branch, comment on it:

```text
@ncmake-updater rebase
```

The workflow re-runs the update against the current default branch, so `create-pull-request` rebuilds the branch from scratch. It reacts with 👀 when it picks the comment up and with 🚀 when it is finished, both through the default `github.token` with `issues: write`.

Two things about it are worth knowing:

* The trigger is gated. Only a comment on a **pull request**, whose author association is `OWNER`, `MEMBER` or `COLLABORATOR`, starts the job. A comment on an issue, or from anyone else, does nothing.
* Use it instead of GitHub's "Update with rebase" button. That button, like a `git rebase` in the runner, pushes commits that carry no signature, so the pull request loses its verified status. Going through the API keeps every commit verified.

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
| `make version` refuses | not on `main` or a `stable*` branch, the tag exists, the entered version is not greater than the newest tag reachable from the branch, or on a `stable*` branch it leaves the major.minor of the line |
| `make stable-branch` refuses | not on `main`, uncommitted changes, the line has no tag, is the current or a newer line, or `stableX.Y` exists locally or on origin (then `git switch stableX.Y`) |
| `make tag` refuses | the tag exists, `make changelog-lint` reports a `[!]` finding or, without the audit module, `CHANGELOG.md` has no section for this version (run `make changelog`; `NO_CHANGELOG_LINT=1` tags regardless), or the working tree is not clean - commit, stash or remove what `git status --short` lists, untracked files included |
| `workflows-install` or `workflows-update` refuses | with `COMMIT=1`/`PR=1` not on `main` or a `stable*` branch, or the branch exists locally or on origin; merge, close or delete it, then run the target again |
| `could not fetch .../lib/<file> - network?` | the analysers are not in the cache and the download failed; check the network and run the target again |
| `bundle-report` names no packages | the build ships no source maps, so the bytes cannot be attributed; the per-file sizes still hold |
| `build-verify` names a file as differing | the committed build output did not come from this source; run `make dist-clean && make build` and commit what the build writes |
| `build-verify` fails before it builds | it needs git and npm where it runs and the network to install; the default node image carries git and npm, a slim one does not |
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
* [Workflows](https://github.com/ernolf/ncmake/wiki/Workflows), [Workflow updater](https://github.com/ernolf/ncmake/wiki/Workflow-updater), [GitHub App](https://github.com/ernolf/ncmake/wiki/GitHub-App), [GitHub PAT](https://github.com/ernolf/ncmake/wiki/GitHub-PAT), [Deleting merged branches](https://github.com/ernolf/ncmake/wiki/Deleting-merged-branches)
