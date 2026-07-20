<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# 🔑 GitHub tokens and Personal Access Tokens (PAT)

Some ncmake automation acts on your repository on your behalf. The clearest example is the [workflow updater](AUTOUPDATE_WORKFLOW.md), which opens a pull request when your CI workflows have upstream updates. Automation authenticates with **tokens**, not with a username and password. This page explains the two kinds you will meet and walks through creating the one ncmake needs.

> [!TIP]
> **TL;DR** — The workflow updater needs a **fine-grained Personal Access Token** with **Contents**, **Pull requests** and **Workflows** set to *Read and write*, stored as the repository secret **`NCMAKE_UPDATE_TOKEN`**. The automatic `GITHUB_TOKEN` cannot do the job, because GitHub forbids it from changing workflow files.

- [What a token is](#-what-a-token-is)
- [GITHUB_TOKEN: the automatic one](#-github_token-the-automatic-one)
- [Personal Access Token: the one you create](#-personal-access-token-the-one-you-create)
- [What a secret is](#-what-a-secret-is)
- [Creating the PAT for the workflow updater](#️-creating-the-pat-for-the-workflow-updater)
- [Storing it as a repository secret](#-storing-it-as-a-repository-secret)
- [Keeping it working: expiry and safety](#-keeping-it-working-expiry-and-safety)

## 🧩 What a token is

A token is a key that proves "I am allowed to do this". People sign in with a password; automation (workflows, scripts, the `gh` CLI) uses a token instead. A token carries two things: *who* is acting (an identity) and *what* is allowed (a set of permissions).

## 🤖 GITHUB_TOKEN: the automatic one

You never create this one. At the start of **every** workflow run, GitHub mints a fresh, temporary token and hands it to the run as `secrets.GITHUB_TOKEN`.

- **Throwaway:** valid only for that one run and that one repository, and it expires the moment the run finishes. Even if it appears in a log it is worthless afterwards.
- **Acts as `github-actions[bot]`:** commits or pull requests made with it show up as that bot, not as you.
- **Its rights** come from the `permissions:` block in the workflow (for example `contents: write`).

It has two deliberate limits that matter here:

1. **It cannot change workflow files.** GitHub blocks any push that modifies files under `.github/workflows/` when the push is made with the `GITHUB_TOKEN`, so that a workflow cannot rewrite workflows.
2. **Its actions do not start new workflows.** A pull request opened with it does **not** trigger the repository's CI checks. This is a loop guard.

Both limits are exactly why the workflow updater needs a PAT instead.

## 👤 Personal Access Token: the one you create

A PAT is a key you create by hand in your GitHub account settings, once.

- **You choose** its permissions and an expiry date, then store it (as a [secret](#-what-a-secret-is)).
- **Acts as you** (a real user), so unlike the bot token its actions *do* trigger workflows, and it *can* change workflow files once you grant it the Workflows permission.
- Two flavours exist: **classic** (broad, account-wide scopes) and **fine-grained** (limited to chosen repositories and specific permissions, with an expiry date). Prefer **fine-grained**.

## 🔒 What a secret is

A secret is an encrypted value you store in a repository's settings (*Settings → Secrets and variables → Actions*). Workflows read it as `secrets.NAME`, and GitHub masks it in the logs. This is where the PAT goes, under the name `NCMAKE_UPDATE_TOKEN`.

## 🛠️ Creating the PAT for the workflow updater

1. Avatar (top right) → **Settings** → **Developer settings** (bottom of the left menu) → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Token name:** `ncmake workflow updater`.
3. **Expiration:** pick a date (for example 90 days). Note it down; an expired token stops the updater silently.
4. **Resource owner:** your account.
5. **Repository access:** **Only select repositories**, and choose every repository the updater runs in (your ncmake apps).
6. **Permissions → Repository permissions**, each set to **Read and write**:

   | Permission | Why it is needed |
   |---|---|
   | **Contents** | push the update branch |
   | **Pull requests** | open the pull request |
   | **Workflows** | required to change files under `.github/workflows/` |

   (*Metadata: Read* is selected automatically and is mandatory.)
7. **Generate token**, then **copy the value now**. It is shown only once.

## 📥 Storing it as a repository secret

Do this in **each** repository where the updater runs (personal repositories cannot share an organization secret):

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

- **Name:** `NCMAKE_UPDATE_TOKEN`
- **Value:** the PAT you copied

## ⏰ Keeping it working: expiry and safety

- **Renew before it expires.** A fine-grained PAT has an expiry date; once it passes, the updater can no longer push and its runs fail. Set a reminder, or choose a long expiry.
- **Treat it like a password.** Anyone holding the token value can act on the selected repositories with the granted permissions. If it leaks, revoke it under *Fine-grained tokens* and generate a new one.
- **Scope it tightly.** Only the repositories and permissions listed above, nothing more.

---

This token is consumed by the [workflow updater](AUTOUPDATE_WORKFLOW.md); see there for how the updater uses it.
