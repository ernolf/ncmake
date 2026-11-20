<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->

# Getting started with ncmake

Read this when ncmake is to be added to an app, when someone runs it for the first time, or when they ask what to do next. It is the path in the order a newcomer meets it, with what to do and what not to do at each step.

## Contents

* [What the host needs](#what-the-host-needs)
* [1. Add ncmake to the app](#1-add-ncmake-to-the-app)
* [2. Run make and read the help](#2-run-make-and-read-the-help)
* [3. Build, package, deploy](#3-build-package-deploy)
* [4. Fetch the developer modules](#4-fetch-the-developer-modules)
* [5. Check the app](#5-check-the-app)
* [6. Install the CI workflows](#6-install-the-ci-workflows)
* [7. App Store and signature (once per app)](#7-app-store-and-signature-once-per-app)
* [8. Release](#8-release)
* [Commits the changelog understands](#commits-the-changelog-understands)
* [Switches on the command line](#switches-on-the-command-line)
* [Settings in ncmake.mk](#settings-in-ncmakemk)

## What the host needs

GNU make, git, curl, openssl, rsync and python3. `xmllint` is optional: without it ncmake reads `info.xml` with python3. For the builds podman (preferred) or docker; without either, `RUNTIME=bare` runs composer and npm from the `PATH`. `gh` is needed for every `PR=1` and for publishing the asset of a private repository; `make gh-install` (developer module) installs it.

Never tell anyone to install PHP, composer or Node for ncmake: they run in throwaway containers.

## 1. Add ncmake to the app

ncmake needs an existing app: `appinfo/info.xml` with a valid `<id>` and `<version>`. It has no target that creates an app skeleton.

Commit the bootstrap stub in the repository root as `GNUmakefile`, once:

```sh
curl -fLO https://raw.githubusercontent.com/ernolf/ncmake/main/bootstrap/GNUmakefile
git add GNUmakefile
```

* That file is all the repository carries. The real Makefile lives in the per-machine cache (`~/.cache/ncmake/`) and refreshes itself; never copy it from there into the repository.
* Do not edit the stub. The only line one may change is `NCMAKE_REF ?= main`, to pin a tag (`NCMAKE_REF ?= v1.0.0`); it has to be set in the stub, because `ncmake.mk` is read only after the Makefile is fetched.
* Keep an existing build file of the app: as `GNUmakefile` the stub is read first, and the old file still runs with `make -f <name>`. Do not port its targets into ncmake; `make build` replaces a build step, and a genuine deviation goes into `ncmake.mk`.
* The alternative to the stub is a committed full copy, `curl -fLo GNUmakefile https://raw.githubusercontent.com/ernolf/ncmake/main/core/Makefile`, which never changes itself; `make self-update` replaces it and the diff is committed like any change.
* `build/` belongs in `.gitignore`, as in every Nextcloud app; whether `js/` and `vendor/` are ignored or committed decides whether a fresh checkout needs `make build` before shipping. ncmake adds nothing else to the checkout.

## 2. Run make and read the help

`make` without a target prints the help with the app id, version and certificate status it detected. The first run needs the network once to fill the cache. `make help-<target>` explains one target with its options; read it before using an option.

## 3. Build, package, deploy

```sh
make build                                                   # composer + npm, each in a container
make dist                                                    # build/artifacts/dist/<app_id>-<version>.tar.gz
make build && make rsync TARGET=/var/www/nextcloud/apps OCC=1  # test instance
```

`rsync`, `cp` and `dist` ship the same staged tree, so a test deploy is what a release ships. `TARGET` is the parent `apps/` directory.

## 4. Fetch the developer modules

`make dev-init` fetches the audit, lint, workflow, App Store, integrity, translation, gh and git modules into the cache, for every ncmake app on the machine. Someone who only builds and deploys never needs it. It is a maintainer target: run it when the user asks for it.

## 5. Check the app

`consistency-audit`, `php-compat`, `deps-audit`, `secrets-audit`, `build-verify`, `bundle-report`, `build-audit` and the `lint-*` targets only report and are free to run (see `references/checkout-audit.md`, `references/bundle-analysis.md`, `references/lint.md`).

## 6. Install the CI workflows

`make workflows-list` shows what is available, `make workflows-install W="<names>" PR=1` installs them with their lock file in one pull request (see `references/workflows.md`).

* Never write or edit a managed file under `.github/workflows/` by hand: the next install or update overwrites it. A workflow of the app's own goes into `.ncmake/workflows/` (`wf_local_dir`) and is installed from there.
* Commit `.ncmake-workflows.json` and its `.license` sidecar with the workflows.
* `block-unconventional-commits` enforces the commit subjects the changelog needs.

## 7. App Store and signature (once per app)

`make csr`, then after the certificate is issued `make register` (see `references/app-store.md`). Optionally `make integrity-enable PR=1` marks the app as signed (see `references/integrity.md`). The key stays on the maintainer's machine in `cert_dir` (`~/.nextcloud/certificates` by default); never commit it and never put it into a repository secret.

## 8. Release

`make version` on `main`, `make changelog` on the release branch, merge, `make tag` on `main`, publish the GitHub release, `make publish GH=1`. The order and the rules are in the release lifecycle of `SKILL.md`; every step is a maintainer target, run one at a time when the user asks.

## Commits the changelog understands

`make changelog` builds the entries from Conventional Commit subjects with git-cliff:

| Subject starts with | Section |
| --- | --- |
| `feat` | Added |
| `fix` | Fixed |
| `perf` | Changed |
| `build`, `ci`, `chore`, `docs`, `refactor`, `style`, `test`, merge commits | not listed |

A subject that is no conventional commit is left out. A breaking change (`feat!:` or a `BREAKING CHANGE:` footer) is never left out and is marked **BREAKING**. The Transifex bot's `fix(l10n): Update translations` commits are skipped. Write a user-visible change as `feat` or `fix`, or it does not reach the changelog; an app's own `cliff.toml` replaces these rules.

## Switches on the command line

| Switch | Effect |
| --- | --- |
| `COMMIT=1` | a writing target puts its change on a branch of its own and commits it, without pushing |
| `PR=1` | as `COMMIT=1`, then pushes and opens the pull request through `gh` |
| `AMEND=1` | `make changelog` folds the entries into the current, unpushed commit |
| `BODY=<path>` | with `PR=1`, the text below the bullet list of the pull request, read from a file |
| `RUNTIME=podman\|docker\|docker-rootless\|bare` | the container runtime, auto-detected with podman preferred |
| `PHP=min\|max` | the PHP side of `make composer` (see `references/containers.md`) |
| `KEEP=1` | keeps the pulled images after the run |

## Settings in ncmake.mk

`ncmake.mk` in the app root is optional, plain make syntax, one variable per line. A standard app needs none; add a line only for a real deviation.

| Variable | What it changes |
| --- | --- |
| `keep_extra` | further paths to ship, for example `resources` |
| `php_build_cmd`, `node_build_cmd` | the composer or npm command of `make build` |
| `php_extensions` | the PHP extensions of the build image; one the published image lacks makes ncmake build the image on the host |
| `web_user` | the owner `OCC=1` hands the deployed app to, `www-data` by default |
| `cert_dir` | where the App Store key, certificate and API token are |
| `integrity_certificate` | the committed certificate, `.ncmake/certificate.crt` by default |
| `wf_sources +=` | a further workflow source, `<owner>/<repo>[@<ref>][:<dir>]` |
| `wf_local_dir` | the folder of the app's own workflows, `.ncmake/workflows` by default |
| `wf_runner_org`, `wf_runner_rewrite` | whether the org-scoped runner labels of the Nextcloud templates are rewritten to `ubuntu-latest` (only outside `wf_runner_org`, `nextcloud` by default) |
| `wf_lock_license`, `wf_lock_copyright` | license and copyright line of the lock file's sidecar |
| `php_image`, `analysis_image`, `composer_image`, `node_image`, `lib_node_image`, `reuse_image`, `l10n_image` | the container images (see `references/containers.md`) |
| `gh_key_fprs` | the fingerprints `make gh-install` checks the GitHub CLI key against |
| `skill_dir` | where `make skill-install` puts this skill |
