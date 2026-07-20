<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# 🔄 The workflow updater

The [workflow manager](WORKFLOWS.md) lets you install and update your CI workflows from their upstream templates by hand (`make workflows-update`). The **workflow updater** automates the update side: on a schedule it runs `make workflows-update` for you and opens a pull request whenever a managed workflow has changed upstream. It is what replaces Dependabot for the files under `.github/workflows/`.

> [!TIP]
> **TL;DR** — Install with `make workflows-install W=workflow-updater`, set up the [GitHub App](GITHUB_APP.md) it authenticates with, and from then on you get a pull request whenever your managed workflows drift from upstream. Locally modified workflows are left untouched.

- [What it does](#-what-it-does)
- [Installing it](#-installing-it)
- [The GitHub App it needs](#-the-github-app-it-needs)
- [When it runs](#-when-it-runs)
- [What a run does](#-what-a-run-does)
- [The pull request it opens](#-the-pull-request-it-opens)
- [Why not Dependabot](#-why-not-dependabot)

## 🔍 What it does

`workflow-updater.yml` is a workflow ncmake ships itself (source `ncmake`, like `release.yml`). Once installed and scheduled it:

1. fetches the ncmake modules (`make dev-init`),
2. refreshes the managed workflows from their upstream templates (`make workflows-update`),
3. opens a pull request if anything changed.

It only ever touches workflows that are **managed** (listed in `.ncmake-workflows.json`) and **not locally modified**. Anything you edited by hand is left alone, exactly as with a manual `make workflows-update`.

## 🧩 Installing it

It is a normal ncmake-provided workflow, so it installs through the manager:

```sh
make workflows-install W=workflow-updater
git add .github/workflows/
```

Commit and merge that like any other workflow adoption. From then on `workflow-updater.yml` lives in `.github/workflows/` and is itself managed, so a later run keeps it up to date too.

## 🔑 The GitHub App it needs

The updater changes files under `.github/workflows/`, which the automatic `GITHUB_TOKEN` may not push, and its commit must be verified when your branch protection requires signed commits. A **GitHub App** covers both: its token pushes the workflow files, and the pull request is committed as the app's bot with a verified signature. It also triggers your CI checks (a real actor, unlike the `GITHUB_TOKEN`), so you see whether a template update breaks anything before you merge.

> [!IMPORTANT]
> Set the app up once, following **[A GitHub App for the workflow updater](GITHUB_APP.md)**. It needs Contents, Pull requests and Workflows (each Read and write), installed on the repository, with its App ID and private key stored as the `NCMAKE_UPDATER_APP_ID` and `NCMAKE_UPDATER_PRIVATE_KEY` secrets. Without it the run fails the moment there is a workflow change to push.

## ⏰ When it runs

- **On a schedule:** daily at 05:30 UTC (the `cron` line in the workflow). Standard runners are free on public repositories and a run with nothing to do is a quiet no-op, so a daily check costs nothing and picks up an upstream change within a day. Adjust the `cron` if you prefer.
- **On demand:** *Actions* tab → **ncmake workflow update** → **Run workflow** (`workflow_dispatch`).

The manual trigger only appears once the workflow is on your default branch. That is how `workflow_dispatch` works, and it is why installing the updater means merging it to `main` first. It stays idle until the schedule fires or you trigger it.

## ⚙️ What a run does

The single job mints the app token, checks out the repository, runs `make dev-init` then `make workflows-update`, and hands any resulting changes to the pull-request step. `ubuntu-latest` already carries make, git, curl and python3, so there is nothing to set up. The commit is signed by the app's bot (so it is verified) and carries a matching `Signed-off-by`, so the DCO check passes.

## 🚀 The pull request it opens

If `make workflows-update` changed anything, the updater opens a pull request titled **`ci: update managed CI workflows from upstream`** on the branch `ncmake/ci/workflow-update`, containing only the refreshed files under `.github/workflows/` (plus the updated lock). Review the diff and merge it like the original adoption.

If nothing changed upstream, no pull request is opened and the run is quiet.

## 🤝 Why not Dependabot

Dependabot's `github-actions` ecosystem and this updater both change the same files, so running both makes them fight: each edit flags the workflows as locally modified for the other. The upstream templates already keep their action pins current, and `make workflows-update` brings those along, so the updater is the single source of truth. Remove the `github-actions` ecosystem from `dependabot.yml` and let the updater own `.github/workflows/`; keep npm and Composer under Dependabot.
