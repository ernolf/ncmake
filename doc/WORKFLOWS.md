<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# 🤖 CI workflows for ncmake apps

This guide covers everything about GitHub Actions workflows in an ncmake app: the workflow manager that installs and updates them, and the release workflow ncmake ships itself.

> [!TIP]
> **TL;DR** — `make dev-init` once per machine, then `make workflows-list` shows every available workflow with its status, `make workflows-install W="reuse lint-php"` installs the ones you pick, and a `make workflows-update` from time to time keeps them current. Commit `.github/workflows/` including the `.ncmake-workflows.json` lock file.

- [The developer module](#-the-developer-module)
- [Where the workflows come from](#-where-the-workflows-come-from)
- [Listing, installing, updating](#-listing-installing-updating)
- [Keeping them up to date automatically](#-keeping-them-up-to-date-automatically)
- [The lock file](#-the-lock-file)
- [Placeholders and runner labels](#-placeholders-and-runner-labels)
- [The ncmake release workflow](#-the-ncmake-release-workflow)
- [FAQ](#-faq)

## 🧩 The developer module

The workflow manager is not part of the core Makefile: it is a **developer module**. Someone who clones your app to build and install it never needs it, so it stays out of their `make help`. As the maintainer you fetch the modules once per machine:

```sh
make dev-init
```

This discovers all modules the ncmake repo ships (`mk/*.mk`), caches them next to the core Makefile in `~/.cache/ncmake/` and loads them on every subsequent `make` run — in every ncmake app on this machine. The cache keeps itself current with the same TTL/ETag mechanism as the core Makefile, and `NCMAKE_REF` pins the version, as everywhere. `make dev-clean` removes the modules again; `make help` then shows the plain user target set.

> [!IMPORTANT]
> Like the core Makefile, modules never land in your repository. The only workflow-related file your repo carries is what you deliberately install into `.github/workflows/` — plus its lock file, see below.

## 🌍 Where the workflows come from

The manager knows two sources, and looks them up in this order:

| Source | Content |
|---|---|
| `ncmake` | the workflows ncmake ships itself, currently the [release workflow](#-the-ncmake-release-workflow) |
| `nextcloud` | the official [nextcloud/.github workflow templates](https://github.com/nextcloud/.github/tree/master/workflow-templates): lint-php, lint-info-xml, psalm-matrix, phpunit, reuse, block-unconventional-commits and many more |

Discovery is live: the manager lists the sources via the GitHub API at run time, so a workflow added upstream appears in `make workflows-list` immediately — no ncmake update involved. On a name collision the `ncmake` source wins.

The Nextcloud templates are worth a special note: they are largely **self-configuring**. `lint-php.yml`, for example, computes its PHP version matrix at CI run time from your `appinfo/info.xml` (via the `nextcloud-version-matrix` action), so the very same file works in every app — the same DRY principle the whole of ncmake is built on. Most templates install without any per-app patching.

## 📋 Listing, installing, updating

```sh
make workflows-list
```

prints every workflow of every source with its status:

| Status | Meaning |
|---|---|
| *(empty)* | available, not installed |
| `installed` | installed and identical to the recorded state, upstream unchanged |
| `update available` | upstream changed since the install — `workflows-update` picks it up |
| `modified` | you edited the local file — never overwritten by `workflows-update` |
| `missing` | in the lock file but deleted locally — reinstalled by `workflows-update` |
| `unmanaged` | present in `.github/workflows/` but not installed through ncmake |
| `gone upstream` | managed, but the source no longer offers it |

```sh
make workflows-install W="reuse lint-php lint-info-xml"
```

fetches the named workflows (the `.yml` suffix is optional), substitutes [placeholders](#-placeholders), writes them into `.github/workflows/` and records them in the lock file. Installing over an existing file overwrites it — that is also how you adopt an `unmanaged` file into management, or reset a `modified` one back to upstream.

```sh
make workflows-update
```

brings every managed workflow to the current upstream state in one go: outdated and missing files are reinstalled, locally modified ones are skipped with a note, current ones are left alone. After installing or updating, review the diff and commit:

```sh
git add .github/workflows/
```

## 🔄 Keeping them up to date automatically

Running `make workflows-update` by hand works, but ncmake also ships a workflow that does it for you. The [workflow updater](AUTOUPDATE_WORKFLOW.md) runs `make workflows-update` on a daily schedule and opens a pull request whenever a managed workflow has changed upstream. It is what replaces Dependabot for `.github/workflows/`. See **[The workflow updater](AUTOUPDATE_WORKFLOW.md)** for installing it and the one-time token it needs.

## 🔒 The lock file

`.github/workflows/.ncmake-workflows.json` records, per managed workflow, the source it came from, the upstream blob sha at install time and the hash of the installed content. Those two fingerprints are what makes the status column possible: a differing upstream sha means `update available`, a differing content hash means `modified`.

The recorded hash is the hash of the file **as written** — after placeholder substitution and the runner rewrite below. Those transforms are deterministic, so a re-install of an unchanged upstream produces the identical bytes and the status stays `installed`; only a real upstream change or a hand edit moves it.

Next to the lock the manager writes `.ncmake-workflows.json.license`, a [REUSE sidecar](https://reuse.software/spec/) that licenses the generated JSON (which cannot carry an SPDX header of its own). It defaults to `CC0-1.0` — the license Nextcloud apps put on generated files — with a copyright line whose year is read from the clock at generation time, so a file regenerated in a later year updates on its own. Override `wf_lock_license` and `wf_lock_copyright` in `ncmake.mk`. This keeps `make reuse` green without any `REUSE.toml` edit.

**Commit the lock file and its `.license` sidecar.** They contain no secrets, and with them in the repository every machine — and every co-maintainer — sees the same status and can run `workflows-update`. Without the lock the manager would consider all workflows `unmanaged`.

## 🔤 Placeholders and runner labels

GitHub's workflow templates may contain placeholders in the form `$default-branch` (lowercase, hyphenated). The manager substitutes the ones it knows at install time:

| Placeholder | Replaced with |
|---|---|
| `$default-branch` | the default branch of your origin remote (falls back to `main`) |

Unknown placeholders of that form are left as-is and reported with a warning, so a new upstream placeholder never breaks the install — you edit the file manually and the manager treats your edit as `modified` from then on. Everything else in the files — `${{ ... }}` expressions, shell variables in `run:` blocks — is none of the manager's business and passes through untouched.

**Runner labels.** The Nextcloud templates run on the org's own runner pool, with labels like `ubuntu-latest-low`. These are configured at the organization level and are therefore *org-scoped*: a repo outside that org has no such runner, so a job on that label would queue forever and never turn green. On install the manager rewrites them to their GitHub-hosted equivalent:

| Rewritten from | to |
|---|---|
| `ubuntu-latest-low` | `ubuntu-latest` |

**Whether to rewrite is decided automatically** from the owner of your `origin` remote. A repo *inside* the org that owns those runners keeps the labels (it really has them); every other repo gets the rewrite. So a `nextcloud/…` repo and your own `you/…` repo both do the right thing with no configuration. The org is `wf_runner_org` (default `nextcloud`); the rules are `wf_runner_rewrite` (space-separated `old=new` pairs). Override either in `ncmake.mk`:

```make
wf_runner_org     = my-org          # keep the org labels for repos under my-org
wf_runner_rewrite =                 # or: never rewrite, regardless of owner
wf_runner_rewrite = big=small a=b   # or: your own rewrite rules
```

The rewrite is applied before the file is hashed, so it is invisible to the status model — a rewritten file is still `installed`, and `workflows-update` keeps it so.

> [!TIP]
> This is why the templates are installed through the manager rather than copied by hand: the same fetch that finds updates also localizes the org-specific bits (branch name, runner labels) and keeps the file REUSE-compliant.

## 🚢 The ncmake release workflow

`release.yml` — the one workflow the `ncmake` source itself provides — builds the release tarball in CI. It carries no app-specific data: the shipped file set comes entirely from ncmake (keep model + `.nextcloudignore`), so the file is byte-identical across all ncmake apps.

The workflow triggers on `release: published` (attaches `<app_id>-<version>.tar.gz` to the release) and on `workflow_dispatch` (produces the same tarball as a downloadable artifact for inspection, without publishing). The whole build is `make build && make dist`; the tarball is located by glob, so nothing in the file names the app.

`make` runs on the runner host, not in a job container: `ubuntu-latest` already carries podman (which ncmake uses for the build containers) plus git, curl, rsync, tar and python3, so the workflow needs no `setup-*` steps and no toolchain of its own. `contents: write` is the only permission, for the release upload; no secrets beyond the automatic `GITHUB_TOKEN`.

Like the bootstrap stub, the file carries ncmake's MIT header and is committed verbatim; the `LICENSES/MIT.txt` you already have for the stub covers it for REUSE.

## ❓ FAQ

**Which workflows should a typical ncmake app install?** The set the ncmake reference apps use: `release` (ncmake), plus `reuse`, `lint-php`, `lint-info-xml`, `lint-php-cs`, `psalm-matrix` and `block-unconventional-commits` from the Nextcloud templates. Apps with a frontend add `lint-eslint` and their node workflow; apps with PHPUnit tests add a phpunit template.

**Can I keep hand-written workflows next to the managed ones?** Yes. Files the manager did not install show up as `unmanaged` in the list and are never touched by `workflows-update`.

**How do I pin the workflow versions?** The lock file already pins what is installed — nothing changes until you run `workflows-update` or `workflows-install`. The `ncmake` source additionally follows `NCMAKE_REF`, so a tag there pins the release workflow's origin too.

**What about private repos or API rate limits?** The listing uses the anonymous GitHub API (60 requests per hour per IP), which is plenty for the occasional list/install. The downloads themselves come from raw.githubusercontent.com and are not rate-limited in that way.
