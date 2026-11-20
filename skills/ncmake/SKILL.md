---
name: ncmake
description: Build, package, deploy, version, release and publish a Nextcloud app with ncmake, the generic Makefile, and manage its CI workflows. Use this whenever a repository contains appinfo/info.xml together with an ncmake Makefile, when ncmake is to be added to a Nextcloud app or run there for the first time, or when the task is a Nextcloud app build, dependency run, bundle size analysis, checkout audit, version bump, changelog, tag, integrity signature, App Store submission or workflow update.
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

The stub must sit in the repository root. Everything derives from `$(CURDIR)`, and the CI workflows expect it there. An app below the top of its repository, as `apps/<id>` of a monorepo, still builds and is analysed locally with a stub in its own directory: the containers mount the top of the repository and start in the app's directory.

The stub also works in a repository that is no Nextcloud app. Without `appinfo/info.xml` the targets that read only the repository run: `reuse`, `secrets-audit` (its shipped scope then checks the tracked files), `consistency-audit` and every `lint-*` target. Every other target stops with "no valid <id> found in appinfo/info.xml".

## Adding ncmake to an app

ncmake goes into an existing app (`appinfo/info.xml` with `<id>` and `<version>`) as one committed file, the stub, fetched with `curl -fLO https://raw.githubusercontent.com/ernolf/ncmake/main/bootstrap/GNUmakefile` into the repository root. Nothing else is added: no build scripts, no copied Makefile, no hand-written workflows. The host needs GNU make, git, curl, openssl, rsync, python3 and podman or docker. `references/getting-started.md` is the full path for a newcomer, from the stub to the first release, with the commit subjects the changelog understands, the command-line switches and every setting of `ncmake.mk`; read it whenever someone starts with ncmake or asks what to do next.

## Ground rules

Follow these before proposing any command. They are the mistakes that cost the most time.

1. **`make build` is the complete build.** It already runs `composer install --no-dev --prefer-dist --no-progress`, with the app's own `post-install-cmd`, when `composer.json` declares real runtime requirements (anything besides `php`, `ext-*` and `bamarni/composer-bin-plugin`) or the app has `composer/autoload.php` next to a `composer.json`, or a shipped PHP file requires `vendor/autoload.php`, and `npm ci && npm run build` when `package.json` has a `scripts.build` (with `pnpm-lock.yaml` or `yarn.lock` the same through pnpm or yarn via corepack; without any lock file `npm install`, and the build says it is not reproducible). Without a `package.json` at the root, a frontend in `js/` with `js/package.json` builds in `js/`, from its own lock file. Never propose `make npm ARGS=ci` or `make npm ARGS="run build"` as a build step, and never propose them as a preparation for `make build`.
2. **`make help-<target>` is the authoritative reference.** Every target that `make help` lists has extended help with its exact options and examples. Run it instead of guessing an option name.
3. **Do not add build configuration.** No wrapper scripts, no extra make targets, no CI build steps that duplicate `make build`. A genuine deviation belongs in `ncmake.mk` (plain make syntax, one variable per line).
4. **Never edit the version by hand** in `info.xml`, `composer.json` or `package.json`. `make version` does the bump, the validation and the lockfile sync.
5. **Never write a CHANGELOG section by hand.** `make changelog` generates it from the conventional commits. A translated `CHANGELOG.<code>.md` is the exception: nothing generates it.
6. **Maintainer targets change the world.** `version`, `changelog`, `tag`, `stable-branch`, `csr`, `register`, `sign`, `release`, `publish`, `delete-release`, `integrity-enable`, `integrity-sign`, `dist-signed`, `l10n-init`, `secrets-ignore`, `dev-init` and every `COMMIT=1` / `PR=1` / `AMEND=1` variant write commits, tags, branches, pull requests, App Store entries or signatures. Run them only when the user explicitly asks for that step, one step at a time. Read-only targets (`build`, `dist`, `psalm`, `reuse`, `composer`, `npm`, `integrity-check`, `bundle-report`, `build-audit`, `consistency-audit`, `build-verify`, `changelog-lint`, `php-compat`, `install-test`, `runtime-audit`, `profile`, `deps-audit`, `php-audit`, `secrets-audit`, `l10n-check`, `l10n-lint` (without `FIX=1`), `lint` and every `lint-*` target, `list-releases`, `list-releases-full`, `ratings`, `workflows-list`, `help`) are free to run.
7. **`build/` is generated.** Never edit, never commit, never reference a file in it as source. `make clean` removes it.
8. **The host needs no toolchain.** Do not tell anyone to install composer, PHP or Node. podman (preferred) or docker is enough. `RUNTIME=bare` exists for hosts that deliberately run the tools directly.
9. **The checkout directory name is not the app id.** The id comes from `appinfo/info.xml` and the two often differ.
10. **Quote `ARGS`.** `make composer ARGS="install --no-dev"`. Without `ARGS`, `make composer` and `make npm` print their usage and exit 1 on purpose.
11. **`appinfo/signature.json` is produced at tag time, on the maintainer's machine.** Never propose `occ integrity:sign-app` (it needs a server with the app already installed), never propose writing the file into the checkout, and never propose putting the signing key into a repository secret so a workflow can sign. The signature travels to the runner, the key does not.

## What ncmake reads

| Source | What it decides |
| --- | --- |
| `appinfo/info.xml` | `<id>` (app id, tarball and stage directory name), `<version>`, `<dependencies><php min-version>` (the build image, never below the PHP floor of the newest end-of-life Nextcloud major) |
| `composer.json` | a composer step is needed when `require` holds anything besides `php` and `ext-*`, when `composer/autoload.php` exists, or when a shipped PHP file requires `vendor/autoload.php`; the version is bumped here too when the key exists |
| `package.json` | the root one, or `js/package.json` when the root has none (a frontend in `js/`, whose npm steps and analysers all run there); an npm step is needed when `scripts.build` exists; the lock file picks npm, pnpm or yarn; `engines.node` picks the Node line, the newest LTS line it allows that is not end of life; `engines.npm` picks npm where the one that line ships is outside it, the newest release in the range that runs on the line; the version is bumped here too |
| `.gitignore` | classifies `js/` and `vendor/`: ignored means build output that must be built before shipping, committed means a fresh checkout is already dist ready; for a frontend in `js/`, an ignore rule under `js/` other than `node_modules` names its build output |
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
| Whether the packaged app installs and runs on a real server | `make build && make install-test` |
| Whether a release tarball installs and runs on a real server | `make install-test TARBALL=<file or https URL>` |
| Whether the routes, commands, jobs and settings of the app work on a real server | `make build && make runtime-audit` |
| What the app costs the requests of a server, in queries, cache operations and events | `make build && make profile` |
| Whether a dependency that ships has a published vulnerability, or a licence the app cannot ship | `make deps-audit` |
| What the PHP source of the app has, and whether the server can load and run it as the developer manual describes | `make php-audit` |
| Whether a key or a token is in what ships, or in the history | `make secrets-audit` |
| Mark findings of `secrets-audit` as false positives in `.gitleaksignore` | `make secrets-ignore` (maintainer, asks which) |
| Whether the workflows of the repository are valid | `make lint-actions` |
| Whether a workflow of the repository can be attacked | `make lint-actions-security` |
| What the lint workflow of one tool would find | `make lint-shell`, `make lint-yaml`, `make lint-markdown`, ... (see `references/lint.md`) |
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
| Mark the app as signed (once per app) | `make integrity-enable PR=1` |
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
| Install or refresh this skill | `make skill-install` |

`TARGET` for `rsync` and `cp` is the **parent** `apps/` directory; the app subdirectory is appended automatically. `OCC=1` wraps the copy into `occ app:disable`, `chown` to `web_user` (default `www-data`) and `occ app:enable`, so `info.xml` is re-read and migrations run. Without `OCC=1` those commands are only printed. `ENGINE=docker|podman` picks the container CLI for `cp` independently of `RUNTIME`.

## Reference files

The detail of each module is in `references/` next to this file. Read the one that matches the task before proposing a command of that module; the rest of this file is enough for building, deploying and releasing.

| File | Read it for |
| --- | --- |
| `references/getting-started.md` | adding ncmake to an app, what the host needs, the first steps in order, the commit subjects the changelog uses, the command-line switches, every `ncmake.mk` setting |
| `references/containers.md` | the container images and what runs in which, `PHP=min\|max`, `RUNTIME=`, the image record, registry fallback, `image-clean`, `cache-clean`, idle cleanup |
| `references/app-store.md` | certificate, `csr`, `register`, `sign`, `release`, `publish`, `delete-release`, `list-releases` |
| `references/integrity.md` | `appinfo/signature.json`: `integrity-enable`, `integrity-sign`, `integrity-check`, `dist-signed`, the committed certificate |
| `references/bundle-analysis.md` | `bundle-report` and `build-audit` |
| `references/checkout-audit.md` | `consistency-audit`, `build-verify`, `changelog-lint`, `php-compat`, `deps-audit`, `secrets-audit`, `secrets-ignore` and the other checkout analysers |
| `references/lint.md` | `lint` and every `lint-*` target |
| `references/workflows.md` | the workflow manager (`workflows-*`, sources, `.ncmake/workflows/`), the shipped workflows, the workflow updater and the comment commands |
| `references/translations.md` | `l10n-init`, `l10n-check`, `l10n-lint` |

## The shipped file set (keep model)

A release ships an allowlist, never an exclude list, so a stray development file cannot leak into the tarball:

* directories `appinfo lib l10n templates img css js vendor composer LICENSES`
* files `CHANGELOG.md CHANGELOG.*.md AUTHORS AUTHORS.md REUSE.toml COPYING COPYING.md LICENSE LICENSE.md`, each with its REUSE sidecar `<file>.license` when it has one
* plus whatever `keep_extra` in `ncmake.mk` adds (for example `resources`)

Only paths that actually exist are staged. `js/node_modules/` never ships. `.nextcloudignore` filters within that set, and a directory left empty, such as the submodule placeholder of a vendor package, is not staged. The result is materialized into `build/stage/<app_id>/` and packed into `build/artifacts/dist/<app_id>-<version>.tar.gz`. `rsync` and `cp` deploy that very same tree, so a test deployment is byte for byte what a release ships.

`check-build` demands the build outputs only when they are git-ignored. An app that commits its built `js/` stays dist ready straight from a fresh checkout. For a frontend in `js/`, it demands the ignored build output inside `js/`.

## Release lifecycle

Between releases, `make changelog` without a pending bump writes the new entries under `## [Unreleased]`, which is what the App Store shows for a nightly. Run it after a change and fold the result into that commit (`AMEND=1`, or the printed `git commit --amend --no-edit`), or let `COMMIT=1` / `PR=1` put it on `ncmake/docs/changelog`. What is already in `CHANGELOG.md`, generated or written by hand, is kept word for word; a `CHANGELOG.md` with uncommitted changes stops the run.

Exactly this order, one step per command, each on the branch it names:

1. On `main`, with a clean tree: `make version`. It prompts for the new version, `X.Y.Z` or a pre-release `X.Y.Z-alpha.N`, `-beta.N`, `-rc.N`, validates that it is greater than the latest tag in the order of PHP `version_compare` (`1.2.0-rc.1` before `1.2.0`), creates the branch `ncmake/release/X.Y.Z`, bumps `info.xml`, `composer.json` and `package.json`, re-syncs the lockfiles in the containers, moves the `<screenshot>` URLs of `info.xml` that are pinned to a release tag of the app's own repository to the new tag, and commits the bump with `-s`. It warns when the composer or package description has drifted away from the `info.xml` summary.
2. On that branch: `make changelog`. It moves everything under `## [Unreleased]`, together with the conventional commits since the last change to `CHANGELOG.md` (`feat` to Added, `fix` to Fixed, `perf` to Changed; `build`, `ci`, `test`, `chore`, `docs`, `refactor`, `style`, merges and the Transifex `fix(l10n)` commits are skipped), into the `## [X.Y.Z]` section, inserts it below `## [Unreleased]` together with its `[X.Y.Z]:` link reference and prints the exact commit command. While the bump commit is still unpushed that command is `git commit --amend --no-edit`, so a release stays one commit; `make changelog AMEND=1` runs it, and `AMEND=1 PR=1` also pushes the branch and opens the pull request. Rerunning the target is safe. An app-provided `cliff.toml` overrides the built-in configuration.
3. Push the branch, open the pull request, let CI pass, merge it.
4. `git checkout main && git pull`, then `make tag`. It refuses to re-tag, refuses a working tree that is not clean (untracked files included, because the release is packed from the checkout), checks the changelog before the confirmation, and creates and pushes the signed tag after a confirmation prompt. For an app marked as signed it offers the signature between the confirmation and the tag (see `references/integrity.md`). With the audit module the changelog check is `make changelog-lint` and refuses on a `[!]` finding; without it, `make tag` refuses when `CHANGELOG.md` has no section for the version. `make tag NO_CHANGELOG_LINT=1` skips the check, for a release that is meant to go out regardless. With the audit module, `make tag` also runs `make secrets-audit SCOPE=shipped` before the confirmation and refuses on a secret in what ships; `NO_SECRETS_AUDIT=1` skips that check.
5. Publish the GitHub release for that tag. The shipped `release.yml` workflow builds and attaches the tarball, verifying the signature before it packs when the app is signed.
6. App Store: `make publish GH=1` (see `references/app-store.md`).

### Maintenance lines

An older release line, for example 0.7 while `main` is at 0.8, gets its own `stable*` branch and its own releases. The branch is named `stableX.Y` after the line by default, but any name with the `stable` prefix works, because every target recognises a maintenance branch by that prefix alone: `stable0.8` from `v0.7.3` carries a new minor for the servers `main` at 0.9 no longer supports, and `stable32` serves Nextcloud 32, however the app counts its versions there. Each branch owns a range of versions that no other branch reaches into, and `make version` and `make tag` hold every version to it:

1. On `main`: `make stable-branch`. It lists the release lines from the tags, each with the `stable*` branches on origin whose newest tag is in it, prompts for one (`X.Y`) and refuses a line without a tag, the current line of `main` (the line of the `info.xml` version on `main` once that is above the newest tag) and a newer one. Then it prompts for the branch name, `stableX.Y` by default, and refuses one without the `stable` prefix or one that exists only locally. For a branch that is on origin already it creates nothing and offers only the steps on `main` (5 and 6). The branch starts at the newest tag of the line, never at `main`. Before it is created, it shows the Nextcloud and PHP ranges at that tag next to those of `main` and notes when the line still reaches into the Nextcloud versions `main` covers; capping `max-version` is then the first PR against the branch. After a confirmation it creates and pushes the branch.
2. Protect the branch on GitHub like `main`.
3. Changes reach the branch only through PRs against it. With the `backport` workflow installed, a comment of `/backport to stableX.Y` on the PR against `main` opens that PR (see `references/workflows.md`). By hand: `git switch -c <branch> stableX.Y && git cherry-pick -x <commit>`.
4. A workflow that `main` gained after the line's tag, for example one whose check the repository rules require, comes over on `stableX.Y` with `make workflows-install W=<name> PR=1`. The workflow updater refreshes the workflows the line has through a PR of its own against `stableX.Y` from `ncmake/ci/workflow-update-stableX.Y`; `make workflows-update PR=1` on `stableX.Y` does the same without waiting for the schedule.
5. For an app with `.tx/config`: the Nextcloud Transifex bot syncs only the branches that `.tx/backport` on `main` lists (one per line, replacing the server's `stable*` names), so `stableX.Y` goes into that file through a PR against `main`, together with a `REUSE.toml` entry for it. `make stable-branch` offers that change after the branch is pushed. The bot pushes its commits directly, so it needs write access as a collaborator and a bypass on the rule that protects the branch, as on `main`; `make stable-branch` prints that step. Once the PR is merged, `make l10n-check` validates the new branch together with the others the bot syncs.
6. For an app with `.github/dependabot.yml`: Dependabot checks the default branch only, unless an entry names a `target-branch`. `make stable-branch` offers a change on `main` that copies every entry without `target-branch` for the branch: same schedule, groups and options, plus an `ignore` rule for patch updates only for composer and no major updates for the other ecosystems, as on the stable branches of Nextcloud. `github-actions` is not copied, and an entry that has a copy for the branch already is skipped. Security updates always run on `main` and reach the branch as backports. The steps answered with yes go into one commit on `ncmake/chore/add-stableX.Y` off `main` and one PR against `main`, opened through gh, so a rule that requires an up-to-date branch does not hold back a second PR; `stableX.Y` is checked out again afterwards. Once that PR is open, its local branch is deleted: origin keeps it, and `git switch <branch>` fetches it again for a change. After the merge, `git pull` on `main` is all that is left.
7. Release from it exactly as from `main`, with `stableX.Y` in place of `main`. `make version` prints the range of the branch before the prompt: above the newest tag reachable from it, below the lowest tag it does not contain that is above that one and has another major.minor (or the `info.xml` version on `main` while that is not tagged yet), and never in a major.minor that a tag outside the branch has. So `stable0.7` from `v0.7.3` releases 0.7.x below `main`'s 0.8.0, and `stable0.8` from the same tag releases 0.8.x below `main`'s 0.9.0; on `main` the version is above every tag of the repository. `make tag` checks the same range again. `make changelog` keeps the tags of the other lines out, and `make tag` runs on `stableX.Y` after the merge. When publishing the GitHub release, untick "Set as the latest release".
8. Once a line is no longer maintained: `make stable-branch RETIRE=1` on `main`. It removes the branch from `.tx/backport` and its entries from `.github/dependabot.yml` through one PR from `ncmake/chore/retire-stableX.Y`. `.tx/backport` stays even when it is empty, because only an absent file makes the bot sync the server's `stable*` names. Then it offers to delete the branch on origin, unless the branch has commits after its newest tag; the tags and releases stay, and `make stable-branch` opens it again from that tag. The local branch of its PR is deleted as in step 6.

## Developer modules

The App Store, CI workflow, bundle analysis, checkout audit, lint, integrity signature, translations, gh and git targets are optional modules that live in the ncmake repository under `mk/`. `make dev-init` fetches them into the same per-machine cache as the core Makefile, from where every ncmake app on that machine sees them. The module list is discovered live through the GitHub contents API, so new modules arrive without an ncmake update. `make dev-clean` removes them again, which restores the plain user target set.

The anonymous GitHub API allows 60 requests an hour per IP. Exporting `GITHUB_TOKEN` or `GH_TOKEN` raises that to 5000 and is worth doing on a machine that runs `dev-init` or `workflows-list` regularly.

Someone who only builds and installs an app never needs `dev-init`.

## gh module

`make gh-install` sets up the official GitHub CLI package source and installs `gh`, following the upstream install guide. The package manager is auto-detected: apt, dnf5, dnf4, yum, zypper, pacman, apk, brew or conda. On Debian and Ubuntu the source is written in deb822 format as `/etc/apt/sources.list.d/github-cli.sources` with the ASCII-armored signing key inside the file, so no separate keyring is left behind, and the key is verified against the documented fingerprints when gpg is available (override `gh_key_fprs` in `ncmake.mk` after a key rotation). The target is idempotent: an existing source reports that it is up to date, an installed `gh` gets the upgrade command printed instead of being reinstalled. Privileged steps announce themselves and run through sudo; brew and conda never need root.

## git module

`make git-aliases` writes the git aliases of the wiki page [Git tips](https://github.com/ernolf/ncmake/wiki/Git-tips) into the global git configuration of the calling user: the short forms `ci`, `p`, `pf`, `pu`, `co`, `br`, `sw`, `unstage`, `amend` (with `-a`), `st`, `lg`, `last` and `alias`, the guarded branch creation `swc`, the guarded first push `puh` (`-y` skips the prompt, a branch whose upstream is gone is refused), the post-merge cleanup `merged` (`into <base>` for a base other than `main`) and `gone`, which deletes local branches whose upstream is gone. An alias that is not defined yet is set, one with the same command is reported as up to date, and one the user defined with a different command is left as it is and reported with both commands; `FORCE=1` overwrites it. It needs no root. The commands live in one table in `mk/git.mk`, one line per alias.

## Self-update and pinning

In stub mode the per-machine cache refreshes itself at most once per `NCMAKE_TTL_MIN` (default 1440 minutes) with a conditional GET, so being offline or an unchanged upstream costs nothing. A committed full copy never modifies itself. `make self-update` fetches the newest Makefile immediately and drops the ETag. `NCMAKE_REF` pins ncmake to a branch or tag, and the cache is keyed by that ref, so pinned and unpinned apps coexist on one machine.

This skill is a copy that does not refresh itself. `make skill-install` fetches `SKILL.md` and `references/` from the same `NCMAKE_REF` into `skill_dir` (default `~/.claude/skills/ncmake`), removes a reference file the ref no longer has, and says whether the skill was installed, updated or already current; run it again after `make self-update`.

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
| `make stable-branch` refuses | not on `main`, uncommitted changes, the line has no tag, is the current or a newer line, the branch name lacks the `stable` prefix, or the branch exists only locally (then `git switch <branch>`) |
| `make tag` refuses | the tag exists, `make changelog-lint` reports a `[!]` finding or, without the audit module, `CHANGELOG.md` has no section for this version (run `make changelog`; `NO_CHANGELOG_LINT=1` tags regardless), `make secrets-audit` found a key or a token in what ships (take it out and revoke it; `NO_SECRETS_AUDIT=1` tags regardless), or the working tree is not clean - commit, stash or remove what `git status --short` lists, untracked files included |
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

Conventional commit subjects (the changelog is generated from them: `feat` becomes Added, `fix` Fixed, `perf` Changed, every other type and every unconventional subject is left out, a breaking change is kept and marked; see `references/getting-started.md`), `main` as the default branch, `git commit -s` (the modules pass `-s`, so DCO checks pass), signed tags, and REUSE-compliant licensing (`make reuse` checks it).

## Further reading

* [Getting started](https://github.com/ernolf/ncmake/wiki/Getting-started) and the [step-by-step walkthrough](https://github.com/ernolf/ncmake/wiki/Step-by-step)
* [How ncmake understands your app](https://github.com/ernolf/ncmake/wiki/How-ncmake-understands-your-app), [Building and packaging](https://github.com/ernolf/ncmake/wiki/Building-and-packaging), [Bundle analysis](https://github.com/ernolf/ncmake/wiki/Bundle-analysis), [Checkout audit](https://github.com/ernolf/ncmake/wiki/Checkout-audit), [Per-app tuning](https://github.com/ernolf/ncmake/wiki/Per-app-tuning), [Target reference](https://github.com/ernolf/ncmake/wiki/Target-reference)
* [Releasing](https://github.com/ernolf/ncmake/wiki/Releasing), [App Store](https://github.com/ernolf/ncmake/wiki/App-Store), [Integrity signature](https://github.com/ernolf/ncmake/wiki/Integrity-signature)
* [Workflows](https://github.com/ernolf/ncmake/wiki/Workflows), [Workflow updater](https://github.com/ernolf/ncmake/wiki/Workflow-updater), [Backport](https://github.com/ernolf/ncmake/wiki/Backport), [GitHub App](https://github.com/ernolf/ncmake/wiki/GitHub-App), [GitHub PAT](https://github.com/ernolf/ncmake/wiki/GitHub-PAT), [Deleting merged branches](https://github.com/ernolf/ncmake/wiki/Deleting-merged-branches)
