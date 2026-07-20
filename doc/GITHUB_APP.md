<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# 🤖 A GitHub App for the workflow updater

The [workflow updater](AUTOUPDATE_WORKFLOW.md) authenticates with a **GitHub App** rather than a token you paste in. This page explains why, and walks through creating the app, installing it and wiring up its two secrets. For the general background on tokens and secrets, see [GitHub tokens and PAT](GITHUB_PAT.md).

> [!TIP]
> **TL;DR** — Create a GitHub App with **Contents**, **Pull requests** and **Workflows** set to *Read and write*, install it on your ncmake repositories, and store its **App ID** and **private key** as the secrets **`NCMAKE_UPDATER_APP_ID`** and **`NCMAKE_UPDATER_PRIVATE_KEY`**. The updater mints a fresh one-hour token from them on every run.

- [Why a GitHub App](#-why-a-github-app)
- [Creating the app](#-creating-the-app)
- [Installing it on your repositories](#-installing-it-on-your-repositories)
- [Storing its credentials as secrets](#-storing-its-credentials-as-secrets)
- [How the workflow uses it](#-how-the-workflow-uses-it)
- [The private key: safety](#-the-private-key-safety)

## 🧭 Why a GitHub App

The updater has two hard requirements, and a GitHub App is the only clean way to satisfy both at once:

1. **It changes files under `.github/workflows/`.** GitHub does not let the automatic `GITHUB_TOKEN` push workflow files. A token with the *Workflows* permission is required.
2. **Verified (signed) commits.** If your branch protection requires signed commits, the updater's commit has to be verified.

A fine-grained PAT can do the first but **not** the second: commit signing does not work with a PAT. A GitHub App does both. Its token can push workflow files, and the pull-request action signs the commit as the app's bot, so it shows up as **Verified**. As a bonus it is more secure than a PAT: the app mints a **fresh, one-hour token per run** instead of a long-lived credential sitting in a secret. This is the same pattern Dependabot and Renovate use.

## 🛠️ Creating the app

**Settings** (your account) → **Developer settings** → **GitHub Apps** → **New GitHub App**, and work down the form. Most fields belong to features the updater does not use, so the short version is: set the name, the homepage, the three permissions and the install scope, turn the webhook off, and leave everything else at its default.

- **GitHub App name:** something globally unique, for example `ncmake updater (yourname)`.
- **Description:** optional, leave it empty.
- **Homepage URL** (required): any valid URL, your repository is fine.
- **Callback URL, Expire user authorization tokens, Request user authorization (OAuth), Enable Device Flow:** leave all at their defaults. These belong to the user-login (OAuth) flow, which the updater does not use. (`Expire user authorization tokens` stays ticked; that is the secure default and has no effect here.)
- **Setup URL, Redirect on update:** leave empty / unticked.
- **Webhook → Active:** **untick it.** The app receives no events, so there is no webhook URL or secret to set. (Left ticked without a URL, the form rejects the save.)
- **Permissions → Repository permissions**, each set to **Read and write**:

  | Permission | Why it is needed |
  |---|---|
  | **Contents** | push the update branch |
  | **Pull requests** | open the pull request |
  | **Workflows** | required to change files under `.github/workflows/` |

  *Metadata: Read-only* is selected automatically and is mandatory. Leave every other repository permission at **No access**, and the Organization and Account permissions at their defaults.
- **Where can this GitHub App be installed:** **Only on this account**.

Then **Create GitHub App**. On the app's page afterwards:

1. Under **About**, note the **App ID** (a number). It goes into the `NCMAKE_UPDATER_APP_ID` secret. GitHub also shows a **Client ID** and suggests using it instead; the App ID works just as well with the updater's workflow, so use it.
2. Scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads. That file is the app's credential and goes into the `NCMAKE_UPDATER_PRIVATE_KEY` secret.

## 📦 Installing it on your repositories

On the app's page → **Install App** → install on your account → **Only select repositories** → pick your ncmake apps → **Install**.

## 🔑 Storing its credentials as secrets

In **each** repository where the updater runs (**Settings → Secrets and variables → Actions → New repository secret**):

| Secret name | Value |
|---|---|
| `NCMAKE_UPDATER_APP_ID` | the **App ID** (the number from the app's About page) |
| `NCMAKE_UPDATER_PRIVATE_KEY` | the **full contents** of the downloaded `.pem`, including the `-----BEGIN...` and `-----END...` lines |

Personal repositories cannot share an organization secret, so add both to every repo. (Move to an organization later and org-level secrets cover all of them at once.)

## ⚙️ How the workflow uses it

`workflow-updater.yml` mints a token from the two secrets with [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token), then hands it to the pull-request step with `sign-commits: true` and `signoff: true`. The token pushes the workflow changes; the commit is signed by the app's bot (so it is **Verified**) and carries a matching `Signed-off-by` (so **DCO** passes). One hour later the token expires on its own.

## 🔒 The private key: safety

- **Treat the `.pem` like a password.** Anyone holding it can mint tokens with the app's permissions on the installed repositories. Put it only into the secret; delete the local `.pem` afterwards, or keep it somewhere safe and offline.
- **If it leaks,** revoke it on the app's page (**Private keys** → delete the key), generate a new one, and update the secret.
- **Nothing to renew.** The app itself does not expire, and only the per-run tokens are short-lived, so unlike a PAT there is no expiry date to keep an eye on.

---

Background on tokens, `GITHUB_TOKEN` and secrets: [GitHub tokens and PAT](GITHUB_PAT.md). This app is used by the [workflow updater](AUTOUPDATE_WORKFLOW.md).
