<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# 🧹 Automatically deleting merged branches

A merged pull request leaves its source branch — the *head branch* — behind. Nothing removes it on its own, so over time a repository collects a long list of stale branches: your own feature branches, and the `ncmake/…` branches ncmake opens for you (`make version` releases on `ncmake/release/x.y.z`, the [COMMIT/PR flags](WORKFLOWS.md#-committing-and-opening-a-pr-commit-and-pr) and the [workflow updater](AUTOUPDATE_WORKFLOW.md) on `ncmake/ci/…`).

GitHub has a single repository setting that cleans them up: it deletes each head branch the moment its pull request is merged. This is a general GitHub feature, not an ncmake one — it applies to *every* branch merged through a pull request — but ncmake apps benefit from it, which is why it is documented here.

> [!TIP]
> **TL;DR** — **Settings → General → Pull Requests → tick "Automatically delete head branches".** From then on every branch merged through a pull request is removed automatically. Nothing else is touched, and a deleted branch can be restored from its pull request.

- [Turning it on](#-turning-it-on)
- [What it deletes, and what it does not](#-what-it-deletes-and-what-it-does-not)
- [Restoring a branch](#-restoring-a-branch)
- [One repository at a time](#-one-repository-at-a-time)

## ⚙️ Turning it on

1. Open the repository's **Settings** tab.
2. On **General** (the default page), scroll to the **Pull Requests** section.
3. Tick **Automatically delete head branches**.

That is the whole setup. It takes effect immediately and needs no workflow, token or permission of its own.

## 🎯 What it deletes, and what it does not

It deletes **only the head branch of a pull request, and only once that pull request is merged**. Concretely:

- The base branch of the merge (`main`) is never touched — only the branch that was merged *into* it.
- A branch is left alone as long as it still has **another open pull request**; it is removed only when no open PR points at it any more.
- Only branches **in this repository** are affected. A pull request opened from a fork never has the fork's branch deleted.
- Branches that were **never opened as a pull request** are outside its scope entirely — it is a merge-time cleanup, nothing more.

## ♻️ Restoring a branch

Deletion is not final. Every merged pull request keeps a **Restore branch** button on its page, so a branch removed by mistake — or one you want back to keep working on — is one click away, with its commits intact.

## 🔁 One repository at a time

The setting lives on the repository, so it is enabled **per repository**; a new ncmake app does not inherit it. Turn it on once in each repo where you want merged branches cleaned up.
