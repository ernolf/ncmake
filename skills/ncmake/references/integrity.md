<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->

# Integrity signature module

`appinfo/signature.json` is the per-file hash list a Nextcloud **server** reads to tell an installed app apart from a modified one. It is not the App Store signature: `make sign` proves to the store where a tarball came from, this file lets a server verify an installation. An app without it is not integrity-checked at all, and the server says so only at `-vvv`.

The module writes the file itself, from `mk/integrity.mk` plus a Python helper, against the format in the server's `lib/private/IntegrityCheck/Checker.php`: a sha512 per file keyed by the app-root-relative path, signed with RSA-PSS (digest sha1, MGF1 sha512, salt length 0, which makes it deterministic and therefore byte-identical to what `occ` produces). It needs only `openssl` and `python3` - no Nextcloud installation, which is the reason it exists, since the documented route is `occ integrity:sign-app` on a server that already has the app.

It uses the App Store certificate and key from `cert_dir`, so an app is onboarded to the store first.

| Target | Effect |
| --- | --- |
| `make integrity-enable [COMMIT=1\|PR=1]` | copies the public certificate to `.ncmake/certificate.crt`, gives it a `.license` sidecar with the copyright and license `REUSE.toml` states for itself where the app follows REUSE, and prints the commit command, or commits both on a branch; that committed file is the whole switch |
| `make integrity-sign [DIR=<path>]` | writes `appinfo/signature.json` into the staged tree, or into a tree that already exists; refuses the checkout itself |
| `make integrity-check [DIR=<path>] [TARBALL=<file>] [ROOT_CERT=<file>] [JSON=<file>]` | holds a tree or a packed release against its own `signature.json`; needs no key and is a core target, not part of the module, so the release runner has it without `make dev-init` |
| `make dist-signed` | stage, sign, check, pack - the tarball the runner would have produced, for a release attached by hand |
| `make integrity-tag` | the step `make tag` runs; not called by hand |
| `make integrity-gist-drop` | the step `make publish` runs; not called by hand |

**`.ncmake/certificate.crt` does two things.** It marks the app as signed, so `make tag` offers the signature and the release workflow fails a release that carries none; and it pins the certificate every verification is held against. It holds no key material, and it lies outside the keep model, so it never reaches the tarball. Removing it from the repository stops the signing; the next release then ships unsigned.

**How a signed release runs.** After the confirmation in `make tag`, and before the tag exists, ncmake asks `Generate appinfo/signature.json for this release? [Y/n]`. On yes it builds and stages in a fresh clone of `HEAD`, as the runner builds from the tag, signs, verifies the result against the pinned certificate, uploads the file as a **secret gist** and writes one line into the tag message, `ncmake-signature: <gist id>`, which the tag's own GPG signature then covers. The release workflow reads that id back, fetches the gist into `appinfo/signature.json` **without a token** (a secret gist is readable by anyone holding its id, and `GITHUB_TOKEN` cannot read gists at all), and runs `make integrity-check` before `make dist`, so nothing is packed that did not verify. No id while `.ncmake/certificate.crt` is committed fails the job. `make publish` deletes the gist once the store has answered 200 or 201 - not earlier, because a failed release job has to stay re-runnable.

That detour is the point: the signature travels to CI, the signing key never does.

**What gets hashed is the staged tree**, never the checkout, so the hashed file set is the shipped file set. That also makes build reproducibility a release gate - the hashes were taken over a build on the maintainer's machine, so a runner build that does not reproduce it fails with `INVALID_HASH` instead of shipping. `make build-verify` is the target that asks that question ahead of time.

`integrity-check` reports `EXTRA_FILE`, `FILE_MISSING` and `INVALID_HASH` (the classes `Checker::verify()` itself uses), plus `CERTIFICATE_CN` when the certificate's CN is neither the app id nor `core`, `CERTIFICATE_MISMATCH` when the signature was made with a certificate other than the pinned one, and `INVALID_SIGNATURE`. Who issued the certificate is checked only with `ROOT_CERT=<file>`, for example the server's `resources/codesigning/root.crt`, which ncmake does not carry: every certificate in the file is a root, and a certificate none of them issued is `CERTIFICATE_UNTRUSTED`. The files of one of the first three classes below one top-level directory, or in the app root, are one finding with the class, the directory and its paths; `FILE_MISSING` says when the signed paths lie outside the keep model, which means the signature was made over another tree, such as a checkout with its build dependencies. `JSON=<file>` writes the state (`valid`, `invalid`, `unsigned`) and one finding per problem or group; the exit code stays the same.
