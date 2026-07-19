<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# 🏪 App Store management for ncmake apps

This guide covers everything that connects an ncmake app to the [Nextcloud App Store](https://apps.nextcloud.com): the one-time onboarding (key, certificate, registration), publishing releases, and the read-only queries.

> [!TIP]
> **TL;DR** — `make dev-init` once per machine, `make csr` once per app (submit the printed CSR upstream, save the issued certificate), `make register` once, and from then on every release is a `make publish GH=1` after the GitHub release exists. `make help` always shows whether token, certificate and key are in place.

- [The developer module](#-the-developer-module)
- [The certificate directory](#-the-certificate-directory)
- [One-time onboarding](#-one-time-onboarding)
- [Publishing a release](#-publishing-a-release)
- [Nightly releases](#-nightly-releases)
- [Queries and housekeeping](#-queries-and-housekeeping)
- [FAQ](#-faq)

## 🧩 The developer module

The App Store targets are not part of the core Makefile: they are a **developer module**. Someone who clones your app to build and install it never needs them, so they stay out of their `make help`. As the maintainer you fetch the modules once per machine:

```sh
make dev-init
```

This caches all ncmake modules next to the core Makefile in `~/.cache/ncmake/` and loads them on every subsequent `make` run — in every ncmake app on this machine, kept current by the same TTL/ETag mechanism as the core, pinned by `NCMAKE_REF` like everything else. `make dev-clean` removes them again.

## 📁 The certificate directory

All credentials live in one directory, `~/.nextcloud/certificates/` by default (change with `cert_dir=`, e.g. in `ncmake.mk`):

| File | Purpose |
|---|---|
| `<app_id>.crt` (or `.cert`, both are accepted) | the app certificate issued via [app-certificate-requests](https://github.com/nextcloud/app-certificate-requests) |
| `<app_id>.key` | the private key |
| `appstore_api-token` | your API token from the [App Store account page](https://apps.nextcloud.com/account/token) |

`make help` shows for each of the three whether it was found (green check or red cross, with the real filename), so a missing piece is visible before any target fails.

> [!IMPORTANT]
> The key signs everything the App Store trusts about your app. Keep the directory out of every repository and back it up privately; a lost key means a new certificate request, a leaked key means strangers can publish releases in your app's name.

## 🔑 One-time onboarding

**1. Key and certificate request:**

```sh
make csr
```

generates `<app_id>.key` (chmod 600) and prints the certificate signing request. It refuses to overwrite an existing key or CSR. Submit the CSR as `<app_id>/<app_id>.csr` in a pull request to [nextcloud/app-certificate-requests](https://github.com/nextcloud/app-certificate-requests); when the PR is merged, save the issued certificate as `<app_id>.crt` in the certificate directory.

**2. Registration:**

```sh
make register
```

signs your app id with the key and registers id and certificate on the App Store. Running it again after a certificate change updates the registration.

## 🚢 Publishing a release

The App Store does not host your tarball — it stores a download URL plus your signature over the file behind it. The natural flow with ncmake: finish the release ([make version → changelog → tag](../README.md#-releasing)), publish the GitHub release so the [release workflow](WORKFLOWS.md#-the-ncmake-release-workflow) attaches the tarball asset, then:

```sh
make publish GH=1
```

`GH=1` pre-fills the canonical GitHub asset URL for the current version, so you only confirm with Enter. The target **always downloads the asset from the given URL and signs exactly those bytes** — the signature can never be computed over anything else than what the App Store will fetch. Without `GH=1` it prompts for any URL (your own server works just as well); `URL=...` sets it non-interactively. A GitHub asset is downloaded via `gh` when installed, so private repos work too.

For a manually assembled release there are the building blocks:

```sh
make sign       # sign the local tarball from make dist, print the base64 signature
make release    # dist + sign in one step
```

## 🌙 Nightly releases

The App Store has a dedicated nightly channel, and `publish` targets it with a flag:

```sh
make publish GH=1 NIGHTLY=1
```

Nightlies follow their own rules, straight from the store's API:

- The store keeps **exactly one nightly per app** — publishing a new one replaces the previous, no cleanup needed.
- A nightly does **not** need a higher version than the one before; for identical versions the upload time decides.
- Stable releases are completely unaffected: the nightly lives next to them in its own channel.

To catch mix-ups, `publish` cross-checks GitHub when it can: for a GitHub asset URL (with `gh` installed) it reads the release's **pre-release flag** and asks before publishing when it contradicts `NIGHTLY` — a pre-release without `NIGHTLY=1`, or `NIGHTLY=1` on a regular release. For non-GitHub URLs the flag alone decides.

> [!TIP]
> Mark your nightly releases as **pre-release** on GitHub. That keeps them off the repository's "Latest" badge and gives `make publish` the signal for the cross-check.

Removing a nightly from the store works through the same flag:

```sh
make delete-release NIGHTLY=1
```

## 🔍 Queries and housekeeping

| Target | What it does |
|---|---|
| `make list-releases` | your published releases, compact JSON |
| `make list-releases-full` | the full App Store entry |
| `make list-for-author` | all apps of an author (prompts for a name) |
| `make ratings` | ratings and comments for the app |
| `make delete-release` | deletes one release, interactively, with confirmation |

The read-only targets cache `apps.json` with ETag revalidation under `build/cache/`, so repeated calls are fast and gentle to the API.

## ❓ FAQ

**Can I publish without a GitHub release?** Yes — `make publish` accepts any URL that serves the tarball. GitHub is just the convenient default because the ncmake release workflow already builds and attaches the asset there.

**Why does publish download the tarball instead of signing my local build?** Because the App Store verifies the signature over the bytes it downloads. Signing the served file rules out the entire class of "local build differs from published asset" failures.

**The App Store rejected the signature (HTTP 400) — what now?** Almost always a mismatch between the URL's content and the signature: the asset was re-uploaded after signing, or the URL redirects somewhere unexpected. Re-run `make publish` so download and signature happen in one go; if it persists, check that the certificate in the store (`make register`) matches your key.

**Where do the maintainer release targets live?** `version`, `changelog` and `tag` are core targets — they need repository rights, not the App Store key. Everything that touches the store or the signing key is in this module.
