---
name: ncmake
description: Build, package, deploy, version, release and publish a Nextcloud app with ncmake, the generic Makefile, and manage its CI workflows. Use this whenever a repository contains appinfo/info.xml together with an ncmake Makefile, or when the task is a Nextcloud app build, dependency run, bundle size analysis, checkout audit, version bump, changelog, tag, App Store submission or workflow update.
---

<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->

# ncmake

ncmake is one generic `Makefile` that covers the whole life of a Nextcloud app: build, packaging, deployment, version bump, changelog, signed tag, App Store signing and publishing, and managed GitHub Actions workflows.

Its central property: **nothing is configured**. App id, version, PHP floor, Node version, what has to be built and what gets shipped are all derived from `appinfo/info.xml`, `composer.json`, `package.json` and `.gitignore`. Composer and npm run in throwaway containers, so the host needs neither PHP nor Node, only podman or docker.

Full documentation: <https://github.com/ernolf/ncmake/wiki>

## Recognising an ncmake app

The repository root has `appinfo/info.xml` and a `Makefile` that is either the short ncmake bootstrap stub (a dozen lines that fetch and include the real Makefile from a per-machine cache) or a committed full copy of `core/Makefile`. `make` with no target prints the annotated help with the app id, version and the available targets.

The `Makefile` must sit in the repository root. Everything derives from `$(CURDIR)`, and the CI workflows expect it there.

## Ground rules

Follow these before proposing any command. They are the mistakes that cost the most time.

1. **`make build` is the complete build.** It already runs `composer install --no-dev --no-scripts --prefer-dist --no-progress` when `composer.json` declares real runtime requirements, and `npm ci && npm run build` when `package.json` has a `scripts.build`. Never propose `make npm ARGS=ci` or `make npm ARGS="run build"` as a build step, and never propose them as a preparation for `make build`.
2. **`make help-<target>` is the authoritative reference.** Every target has extended help with its exact options and examples. Run it instead of guessing an option name.
3. **Do not add build configuration.** No wrapper scripts, no extra make targets, no CI build steps that duplicate `make build`. A genuine deviation belongs in `ncmake.mk` (plain make syntax, one variable per line).
4. **Never edit the version by hand** in `info.xml`, `composer.json` or `package.json`. `make version` does the bump, the validation and the lockfile sync.
5. **Never write a CHANGELOG section by hand.** `make changelog` generates it from the conventional commits.
6. **Maintainer targets change the world.** `version`, `changelog`, `tag`, `csr`, `register`, `sign`, `release`, `publish`, `delete-release`, `dev-init` and every `COMMIT=1` / `PR=1` variant write commits, tags, branches, pull requests or App Store entries. Run them only when the user explicitly asks for that step, one step at a time. Read-only targets (`build`, `dist`, `psalm`, `reuse`, `composer`, `npm`, `list-releases`, `workflows-list`, `help`) are free to run.
7. **`build/` is generated.** Never edit, never commit, never reference a file in it as source. `make clean` removes it.
8. **The host needs no toolchain.** Do not tell anyone to install composer, PHP or Node. podman (preferred) or docker is enough. `RUNTIME=bare` exists for hosts that deliberately run the tools directly.
9. **The checkout directory name is not the app id.** The id comes from `appinfo/info.xml` and the two often differ.
10. **Quote `ARGS`.** `make composer ARGS="install --no-dev"`. Without `ARGS`, `make composer` and `make npm` print their usage and exit 1 on purpose.

## What ncmake reads

| Source | What it decides |
| --- | --- |
| `appinfo/info.xml` | `<id>` (app id, tarball and stage directory name), `<version>`, `<dependencies><php min-version>` (the build image) |
| `composer.json` | a composer step is needed when `require` holds anything besides `php` and `ext-*`; the version is bumped here too when the key exists |
| `package.json` | an npm step is needed when `scripts.build` exists; `engines.node` picks the Node image; the version is bumped here too |
| `.gitignore` | classifies `js/` and `vendor/`: ignored means build output that must be built before shipping, committed means a fresh checkout is already dist ready |
| `.nextcloudignore` | optional, rsync exclude syntax, filters within the shipped file set |
| `ncmake.mk` | optional, overrides single variables (`keep_extra`, `php_build_cmd`, `node_build_cmd`, `web_user`, image names, `gh_key_fprs`, ...) |

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
| Install the PHP dev tools (psalm, cs) | `make composer ARGS=install` |
| Static analysis | `make psalm` (or `make psalm ARGS="--show-info=true"`) |
| Coding style | `make composer ARGS="cs:check"`, `make composer ARGS="cs:fix"` |
| Runtime dependencies only | `make composer ARGS="install --no-dev"` |
| Refresh `composer.lock` | `make composer ARGS=update` |
| Resolve against the PHP support floor | add `PHP=min` to the composer call |
| License compliance | `make reuse` |
| Release tarball | `make build && make dist` |
| Deploy to a test instance | `make build && make rsync TARGET=/var/www/nextcloud/apps OCC=1` |
| Deploy over ssh | `make build && make rsync TARGET=deploy@host:/var/www/nextcloud/apps OCC=1` |
| Deploy into a running container (All-in-One) | `make build && make cp TARGET=nextcloud-aio-nextcloud:/var/www/html/custom_apps OCC=1` |
| Remove `build/` | `make clean` |
| Remove every git-ignored build output | `make dist-clean` |
| Update ncmake itself | `make self-update` |

`TARGET` for `rsync` and `cp` is the **parent** `apps/` directory; the app subdirectory is appended automatically. `OCC=1` wraps the copy into `occ app:disable`, `chown` to `web_user` (default `www-data`) and `occ app:enable`, so `info.xml` is re-read and migrations run. Without `OCC=1` those commands are only printed. `ENGINE=docker|podman` picks the container CLI for `cp` independently of `RUNTIME`.

## Containers and images

| Image | Used by | Purpose |
| --- | --- | --- |
| `ghcr.io/nextcloud/continuous-integration-php<min-version>` | `make build` | dependencies resolve against the declared support floor, which is what a correct package needs |
| `docker.io/library/composer:2` | `make composer`, `make psalm` | newest PHP patch plus composer, git and unzip, which current dev tools need |
| `node:<engines.node major>`, fallback `node:lts` | every npm run | the Node version the app declares |
| `docker.io/fsfe/reuse` | `make reuse` | the REUSE compliance checker |

`PHP=min|max` switches the PHP side explicitly. `build` pins `PHP := min`, `psalm` pins `PHP := max`. `RUNTIME=podman|docker|docker-rootless|bare` selects the runtime; it is auto-detected with podman preferred, and `docker` maps the caller's uid and gid so no root-owned files appear in the checkout.

## The shipped file set (keep model)

A release ships an allowlist, never an exclude list, so a stray development file cannot leak into the tarball:

* directories `appinfo lib l10n templates img css js vendor LICENSES`
* files `CHANGELOG.md AUTHORS.md REUSE.toml COPYING COPYING.md LICENSE LICENSE.md`
* plus whatever `keep_extra` in `ncmake.mk` adds (for example `resources`)

Only paths that actually exist are staged. `.nextcloudignore` filters within that set. The result is materialized into `build/stage/<app_id>/` and packed into `build/artifacts/dist/<app_id>-<version>.tar.gz`. `rsync` and `cp` deploy that very same tree, so a test deployment is byte for byte what a release ships.

`check-build` demands the build outputs only when they are git-ignored. An app that commits its built `js/` stays dist ready straight from a fresh checkout.

## Release lifecycle

Exactly this order, one step per command, each on the branch it names:

1. On `main`, with a clean tree: `make version`. It prompts for the new version, validates that it is greater than the latest tag (`sort -V`), creates the branch `ncmake/release/X.Y.Z`, bumps `info.xml`, `composer.json` and `package.json`, re-syncs the lockfiles in the containers and commits the bump with `-s`. It warns when the composer or package description has drifted away from the `info.xml` summary.
2. On that branch: `make changelog`. It generates the `## [X.Y.Z]` section from the conventional commits since the last tag (`feat` to Added, `fix` to Fixed, `perf` to Changed; `build`, `ci`, `test`, `chore`, `docs`, `refactor`, `style`, merges and the Transifex `fix(l10n)` commits are skipped), inserts it together with its `[X.Y.Z]:` link reference and prints the exact commit command. While the bump commit is still unpushed that command is `git commit --amend --no-edit`, so a release stays one commit. Rerunning the target is safe. An app-provided `cliff.toml` overrides the built-in configuration.
3. Push the branch, open the pull request, let CI pass, merge it.
4. `git checkout main && git pull`, then `make tag`. It refuses to re-tag, refuses when `CHANGELOG.md` has no section for the version, and creates and pushes the signed tag after a confirmation prompt.
5. Publish the GitHub release for that tag. The shipped `release.yml` workflow builds and attaches the tarball.
6. App Store: `make publish GH=1` (see below).

## Developer modules

The App Store, CI workflow, bundle analysis, checkout audit and gh targets are optional modules that live in the ncmake repository under `mk/`. `make dev-init` fetches them into the same per-machine cache as the core Makefile, from where every ncmake app on that machine sees them. The module list is discovered live through the GitHub contents API, so new modules arrive without an ncmake update. `make dev-clean` removes them again, which restores the plain user target set.

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

`publish` always signs the bytes the URL actually serves, never a local file, so the signature can never disagree with the artifact. `GH=1` pre-fills the standard GitHub release asset URL for confirmation and uses `gh` when available, which makes private repositories work. `NIGHTLY=1` publishes into the nightly channel, where the store keeps exactly one nightly per app and does not require an increasing version; for a GitHub asset the release's pre-release flag is cross-checked against `NIGHTLY` and a mismatch asks before publishing.

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

Two more analysers, in `mk/audit.mk`, about the checkout rather than the bundle. They share the report core with the bundle analysers, so findings read the same way everywhere.

| Target | Reads | Answers |
| --- | --- | --- |
| `make consistency-audit` | the metadata: `appinfo/info.xml`, `package.json`, `composer.json`, `.nvmrc`, the installed workflows | whether the checkout agrees with itself, and what a release still needs |
| `make build-verify` | the tracked source, rebuilt twice outside the app | whether the build output committed to the checkout comes from that source |

`consistency-audit` holds the statements a checkout makes against each other: the version in `appinfo/info.xml` against the one in `package.json`, the PHP floor in `info.xml` against `composer.json`, the Node version in `package.json` against `.nvmrc` and against the installed workflows. A linter checks one file against a rule and cannot see any of that. The second half is what a release needs and a checkout can be missing: the `<repository>` and `<bugs>` links, a `<nextcloud>` range that names servers that exist, one lockfile rather than two, a licence stated the same way everywhere, a linter a script calls while no configuration for it is in the tree. Metadata only, no build, no install, no network, which makes it useful on a fresh clone and on an app that never heard of ncmake. The list of released Nextcloud majors is written into the analyser for that reason, and the report names the month the list is from.

`build-verify` answers the other question: it copies the tracked files into a scratch tree outside the app, installs the locked dependencies there, runs the build - twice - and compares the result against what the checkout carries. Twice, because one build cannot separate a difference of the source from output that is not reproducible: what both builds wrote byte for byte the same is what this source produces, so a difference against the checkout is the checkout's, while a file the two builds disagree on is named and gets no verdict. Hashed file names are paired by content, so `app-3f9c1a2b.mjs` and `app-8b20de41.mjs` are one file under two names and a reference carrying the hash counts as build metadata rather than a difference; a source map is compared as the map it is, by what it was compiled from. The checkout is only read: nothing is installed into it and the scratch tree is removed again.

`build-verify` is the one analyser that installs and builds, so it needs the network and takes minutes rather than a second, and it needs git and npm where it runs. `ARGS=--once` builds once and states the open question instead of answering it, `ARGS=--build=dist` verifies another output directory. `make help-consistency-audit` and `make help-build-verify` list every option.

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

Both targets take `COMMIT=1` and `PR=1`. They must run on `main`. `COMMIT=1` opens the branch (`ncmake/ci/workflows-install` or `ncmake/ci/workflow-update`), commits with `Signed-off-by` and one bullet per changed file, and prints the push command without pushing. `PR=1` implies `COMMIT=1` and additionally pushes and opens the pull request through `gh`. Both refuse when the branch already exists locally or on origin, and discard the branch again when there was nothing to commit.

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

## Self-update and pinning

In stub mode the per-machine cache refreshes itself at most once per `NCMAKE_TTL_MIN` (default 1440 minutes) with a conditional GET, so being offline or an unchanged upstream costs nothing. A committed full copy never modifies itself. `make self-update` fetches the newest Makefile immediately and drops the ETag. `NCMAKE_REF` pins ncmake to a branch or tag, and the cache is keyed by that ref, so pinned and unpinned apps coexist on one machine.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `no container runtime found` | install podman (`apt-get install podman`), or use `RUNTIME=bare` with composer and npm on the `PATH` |
| `check-app` fails | the command is not running in an app root; `appinfo/info.xml` is missing |
| `check-build` fails | the git-ignored build outputs are absent; run `make build` |
| `make psalm` reports a missing `vendor/bin/psalm` | the dev tools are not installed; run `make composer ARGS=install` |
| Usage message from `composer` or `npm` | `ARGS` was empty; it is mandatory |
| `dev-init` or `workflows-list` hits a rate limit | anonymous API budget exhausted; export `GITHUB_TOKEN` or `GH_TOKEN` |
| `make version` refuses | not on `main`, or the entered version is not greater than the latest tag |
| `make tag` refuses | the tag exists, or `CHANGELOG.md` has no section for this version; run `make changelog` |
| `workflows-install` or `workflows-update` refuses | the branch exists locally or on origin; merge, close or delete it, then run the target again |
| `could not fetch .../lib/<file> - network?` | the analysers are not in the cache and the download failed; check the network and run the target again |
| `bundle-report` names no packages | the build ships no source maps, so the bytes cannot be attributed; the per-file sizes still hold |
| `build-verify` names a file as differing | the committed build output did not come from this source; run `make dist-clean && make build` and commit what the build writes |
| `build-verify` fails before it builds | it needs git and npm where it runs and the network to install; the default node image carries git and npm, a slim one does not |
| A target behaves like an older ncmake | `make self-update` |

## Conventions ncmake assumes

Conventional commit subjects (the changelog is generated from them), `main` as the default branch, `git commit -s` (the modules pass `-s`, so DCO checks pass), signed tags, and REUSE-compliant licensing (`make reuse` checks it).

## Further reading

* [Getting started](https://github.com/ernolf/ncmake/wiki/Getting-started) and the [step-by-step walkthrough](https://github.com/ernolf/ncmake/wiki/Step-by-step)
* [How ncmake understands your app](https://github.com/ernolf/ncmake/wiki/How-ncmake-understands-your-app), [Building and packaging](https://github.com/ernolf/ncmake/wiki/Building-and-packaging), [Bundle report](https://github.com/ernolf/ncmake/wiki/Bundle-report), [Per-app tuning](https://github.com/ernolf/ncmake/wiki/Per-app-tuning), [Target reference](https://github.com/ernolf/ncmake/wiki/Target-reference)
* [Releasing](https://github.com/ernolf/ncmake/wiki/Releasing), [App Store](https://github.com/ernolf/ncmake/wiki/App-Store)
* [Workflows](https://github.com/ernolf/ncmake/wiki/Workflows), [Workflow updater](https://github.com/ernolf/ncmake/wiki/Workflow-updater), [GitHub App](https://github.com/ernolf/ncmake/wiki/GitHub-App), [GitHub PAT](https://github.com/ernolf/ncmake/wiki/GitHub-PAT), [Deleting merged branches](https://github.com/ernolf/ncmake/wiki/Deleting-merged-branches)
