<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# 🔑 GitHub tokens and Personal Access Tokens (PAT)

GitHub automation acts on your repository on your behalf, and it authenticates with **tokens** rather than a username and password. This page explains the kinds of token you meet on GitHub, and walks through creating a Personal Access Token for the times a piece of automation needs one of its own.

> [!NOTE]
> The [workflow updater](AUTOUPDATE_WORKFLOW.md) authenticates with a [GitHub App](GITHUB_APP.md), not a PAT. This page is the general token reference the App guide builds on, and the how-to for when you do need a PAT.

> [!TIP]
> **TL;DR** — A **Personal Access Token (PAT)** is a token you create yourself and store as a secret when a workflow or the `gh` CLI needs to act as you. Prefer **fine-grained** tokens, scoped to specific repositories and permissions, with an expiry. The automatic `GITHUB_TOKEN` cannot change workflow files, which is one reason automation sometimes needs a PAT or a GitHub App instead.

- [What a token is](#-what-a-token-is)
- [GITHUB_TOKEN: the automatic one](#-github_token-the-automatic-one)
- [Personal Access Token: the one you create](#-personal-access-token-the-one-you-create)
- [What a secret is](#-what-a-secret-is)
- [Creating a fine-grained PAT](#️-creating-a-fine-grained-pat)
- [Storing it as a repository secret](#-storing-it-as-a-repository-secret)
- [Keeping it working: expiry and safety](#-keeping-it-working-expiry-and-safety)

## 🧩 What a token is

A token is a key that proves "I am allowed to do this". People sign in with a password; automation (workflows, scripts, the `gh` CLI) uses a token instead. A token carries two things: *who* is acting (an identity) and *what* is allowed (a set of permissions).

## 🤖 GITHUB_TOKEN: the automatic one

You never create this one. At the start of **every** workflow run, GitHub mints a fresh, temporary token and hands it to the run as `secrets.GITHUB_TOKEN`.

- **Throwaway:** valid only for that one run and that one repository, and it expires the moment the run finishes. Even if it appears in a log it is worthless afterwards.
- **Acts as `github-actions[bot]`:** commits or pull requests made with it show up as that bot, not as you.
- **Its rights** come from the `permissions:` block in the workflow (for example `contents: write`).

It has two deliberate limits worth knowing:

1. **It cannot change workflow files.** GitHub blocks any push that modifies files under `.github/workflows/` when the push is made with the `GITHUB_TOKEN`, so that a workflow cannot rewrite workflows.
2. **Its actions do not start new workflows.** A pull request opened with it does **not** trigger the repository's CI checks. This is a loop guard.

Both limits are why automation that touches workflow files (like the workflow updater) needs a PAT or a GitHub App instead of the `GITHUB_TOKEN`.

## 👤 Personal Access Token: the one you create

A PAT is a key you create by hand in your GitHub account settings, once.

- **You choose** its permissions and an expiry date, then store it (as a [secret](#-what-a-secret-is)).
- **Acts as you** (a real user), so unlike the bot token its actions *do* trigger workflows, and it *can* change workflow files once you grant it the Workflows permission.
- Two flavours exist: **classic** (broad, account-wide scopes) and **fine-grained** (limited to chosen repositories and specific permissions, with an expiry date). Prefer **fine-grained**.

## 🔒 What a secret is

A secret is an encrypted value you store in a repository's settings (*Settings → Secrets and variables → Actions*). Workflows read it as `secrets.NAME`, and GitHub masks it in the logs. This is where a PAT goes, under a name your workflow reads.

## 🛠️ Creating a fine-grained PAT

1. Avatar (top right) → **Settings** → **Developer settings** (bottom of the left menu) → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Token name:** something descriptive.
3. **Expiration:** pick a date (for example 90 days). Note it down; an expired token silently stops whatever uses it.
4. **Resource owner:** your account.
5. **Repository access:** **Only select repositories**, and choose the repositories the automation needs.
6. **Permissions → Repository permissions:** grant only what the automation needs. For example, automation that touches workflow files needs these, each **Read and write**:

   | Permission | Purpose |
   |---|---|
   | **Contents** | push branches and files |
   | **Pull requests** | open pull requests |
   | **Workflows** | change files under `.github/workflows/` |

   (*Metadata: Read* is selected automatically and is mandatory.)
7. **Generate token**, then **copy the value now**. It is shown only once.

## 📥 Storing it as a repository secret

Store it in **each** repository that needs it (personal repositories cannot share an organization secret):

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

- **Name:** the name your workflow reads (for example `MY_TOKEN`)
- **Value:** the PAT you copied

## ⏰ Keeping it working: expiry and safety

- **Renew before it expires.** A fine-grained PAT has an expiry date; once it passes, whatever uses it can no longer authenticate and its runs fail. Set a reminder, or choose a long expiry.
- **Treat it like a password.** Anyone holding the value can act on the selected repositories with the granted permissions. If it leaks, revoke it under *Fine-grained tokens* and generate a new one.
- **Scope it tightly.** Only the repositories and permissions needed, nothing more.

---

For the workflow updater specifically, use a [GitHub App](GITHUB_APP.md) rather than a PAT. This page is the general reference for GitHub tokens.
