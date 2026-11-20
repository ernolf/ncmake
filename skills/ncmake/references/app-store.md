<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->

# App Store module

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

`publish` always signs the bytes the URL actually serves, never a local file, so the signature can never disagree with the artifact. `GH=1` pre-fills the standard GitHub release asset URL for confirmation and uses `gh` when available, which makes private repositories work. `NIGHTLY=1` publishes into the nightly channel, where the store keeps exactly one nightly per app and does not require an increasing version; for a GitHub asset the release's pre-release flag is cross-checked against `NIGHTLY` and a mismatch asks before publishing. A tagged pre-release (`vX.Y.Z-rc.N`) is no nightly: it is marked as a pre-release on GitHub and published without `NIGHTLY`, and the server offers it only to the beta, daily and git channels or with `--allow-unstable`.
