<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->

# CI workflows

## CI workflow manager

`make workflows-list` (alias `make workflows`) shows every workflow the configured sources offer, with source, status and description. Sources, in lookup order: `local`, the folder `ncmake-workflows/` of the app; `ncmake`, the templates of [ernolf/ncmake-workflows](https://github.com/ernolf/ncmake-workflows); `nextcloud`, the `nextcloud/.github` templates. On a name collision the first listed source wins, so an app's own workflow overrides a template of the same name. Discovery is live through the GitHub API, so new upstream workflows appear without an ncmake update.

The templates of ernolf/ncmake-workflows, all of them generic:

| File | What it does |
| --- | --- |
| `lint-actions.yml` | runs `make lint-actions`: actionlint, with shellcheck over the `run:` scripts, over every tracked workflow, with the self-hosted runners of Nextcloud as known labels when the repository has no actionlint configuration; a repository without workflows passes |
| `lint-actions-security.yml` | runs `make lint-actions-security`: zizmor offline over every tracked workflow and action definition; findings of medium and high severity fail, and `ZIZMOR_CODE_SCANNING=true` uploads them to code scanning |
| `lint-containerfiles.yml` | hadolint, with shellcheck on every `RUN`, over every tracked Containerfile and Dockerfile; a repository without one passes |
| `lint-markdown.yml` | markdownlint-cli2 over every tracked Markdown file, with the repository's configuration or a default without the rules GitHub Markdown breaks on purpose; a repository without Markdown passes |
| `lint-php-syntax.yml` | `php -l` over every tracked PHP file, without composer and without `appinfo/info.xml`; the version matrix comes from the `PHP_VERSIONS` variable, a `.php-version` file or the template default |
| `lint-shell.yml` | shellcheck over every tracked shell script, found by extension or by shebang, so extensionless commands are covered; a repository without shell scripts passes |
| `lint-version.yml` | runs `make lint-version`: fails when `package.json`, `composer.json` or `package-lock.json` states a version other than `appinfo/info.xml`; a repository without `appinfo/info.xml` passes |
| `lint-vue-imports.yml` | fails when a tracked source file imports the `@nextcloud/vue` root instead of a per-component entry point, which pulls the whole library into the module graph before tree shaking; a repository without a hit passes |
| `lint-web.yml` | ESLint, Stylelint and html-validate over the tracked JavaScript, CSS and HTML of a repository without a Node project, each at a pinned version; a configuration in the repository root wins over the tool's recommended set; a repository with a `package.json`, which lints through its own scripts, or without such files passes |
| `lint-yaml.yml` | yamllint over every tracked YAML file, with the repository's configuration or a default made for GitHub workflows; a repository without YAML passes |
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

On install, GitHub's template placeholders are substituted (`$default-branch` from the origin HEAD; unknown ones are reported and left as they are) and the org-scoped runner labels of `data/github-runners.json` are rewritten to `ubuntu-latest` unless the origin owner is `wf_runner_org`, default `nextcloud`. Source, upstream sha and content hash go into `.github/workflows/.ncmake-workflows.json`, accompanied by a `.license` sidecar that keeps `make reuse` green without a `REUSE.toml` edit. Commit the lock and its sidecar together with the workflows.

Both targets take `COMMIT=1` and `PR=1`. They must run on `main` or a `stable*` branch. `COMMIT=1` opens the branch (`ncmake/ci/workflows-install` or `ncmake/ci/workflow-update`; on `stableX.Y` with the line appended, for example `ncmake/ci/workflows-install-stable0.7`), commits with `Signed-off-by` and one bullet per changed file, and prints the push command without pushing. `PR=1` implies `COMMIT=1` and additionally pushes and opens the pull request through `gh`, against the branch the target started from. Both refuse when the branch already exists locally or on origin, and discard the branch again when there was nothing to commit.

## Workflow updater and the comment commands

The shipped `workflow-updater.yml` keeps the managed workflows current on its own: a daily cron at 05:30 UTC plus `workflow_dispatch`. It runs `make dev-init` and `make workflows-update` and hands the result to `peter-evans/create-pull-request`, which commits through the API with `sign-commits` and `signoff`, so the commits are verified. Besides the default branch it refreshes every `stable*` branch that carries `.github/workflows/.ncmake-workflows.json`, each through a PR of its own against the line from `ncmake/ci/workflow-update-<branch>`; only the workflows the line already has are refreshed. Authentication is a GitHub App, through the repository secrets `NCMAKE_UPDATER_CLIENT_ID` and `NCMAKE_UPDATER_PRIVATE_KEY` (setup: <https://github.com/ernolf/ncmake/wiki/GitHub-App>). Once one of its pull requests is merged, a cleanup job deletes its branch.

**The rebase comment command.** When a pull request of the updater has fallen behind its base, comment on it:

```text
@ncmake-updater rebase
```

The workflow re-runs the update against the current base of that pull request, the default branch or the line, so `create-pull-request` rebuilds the branch from scratch. It reacts with 👀 when it picks the comment up and with 🚀 when it is finished, both through the default `github.token` with `issues: write` and `pull-requests: write`; a reaction on a comment of a pull request needs the latter.

Two things about it are worth knowing:

* The trigger is gated. Only a comment on a **pull request of the updater**, whose author association is `OWNER`, `MEMBER` or `COLLABORATOR`, starts the job. A comment on an issue or on any other pull request, or from anyone else, does nothing, so another workflow that opens pull requests through the same app can answer the command on its own pull request.
* Use it instead of GitHub's "Update with rebase" button. That button, like a `git rebase` in the runner, pushes commits that carry no signature, so the pull request loses its verified status. Going through the API keeps every commit verified.

**The backport comment command.** The template `backport.yml` (`make workflows-install W=backport`, same GitHub App and secrets) carries a merged change to a maintenance line. Comment on the pull request, one line per target branch:

```text
/backport to stable0.7
```

* On a merged pull request it runs at once; on an open one it waits for the merge, which reads all comments again, the newest per branch counting. The author association gate is the same as for the rebase command.
* It cherry-picks the pull request's own non-merge commits from `refs/pull/<n>/head` with `--no-commit` onto the target branch and commits the result through `create-pull-request` as one verified, signed-off commit on `ncmake/backport/<n>/<branch>`, with the original messages and their `(cherry picked from commit …)` lines. The title is the original one with `[<branch>]` appended.
* Reactions on the command: 👀 picked up, 🚀 pull request open, 👎 failed (a comment names the conflicting files or the missing branch and gives the manual commands), 😕 not understood.
* The merge trigger is `pull_request_target`, which runs the workflow copy of the base branch with secrets, also for a fork. A command that waits on a pull request against `stableX.Y` therefore needs the workflow on that branch too; otherwise write it after the merge.
