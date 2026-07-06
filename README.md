<!--
  - SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  - SPDX-License-Identifier: MIT
-->
# ncmake

The Swiss Army knife for Nextcloud app development: one generic `Makefile` for building, packaging, deploying, versioning and App Store management of a Nextcloud app.

## Installation

Put the bootstrap stub into the root of your app repository, once:

```sh
curl -fLO https://raw.githubusercontent.com/ernolf/ncmake/main/bootstrap/Makefile
```

That is all. The stub is a few lines that never change: on first use it fetches the real Makefile into `~/.cache/ncmake/` (one shared copy for all your apps) and includes it from there. The cache keeps itself up to date (checked at most once a day, silently; offline it just uses the cache), so every clone of every app always runs the current ncmake. `make self-update` forces a refresh, setting `NCMAKE_REF` in the stub to a tag pins a fixed version.

If you prefer a self-contained repository, copy the full `Makefile` instead; it never updates itself, `make self-update` fetches the newest version over it:

```sh
curl -fLO https://raw.githubusercontent.com/ernolf/ncmake/main/Makefile
```

There is nothing to configure for a standard app either way.

## Usage

```sh
make            # show all targets
make build      # build PHP dependencies and frontend
make dist       # build the distribution tarball
make rsync TARGET=/var/www/nextcloud/apps/   # deploy to a test instance
```

Everything is derived from the app itself:

- app id and version come from `appinfo/info.xml`
- build commands are detected: `composer install --no-dev ...` when `composer.json` declares runtime requirements, `npm ci && npm run build` when `package.json` has a build script
- `.gitignore` classifies the outputs: an ignored `js/` or `vendor/` is a build artifact that must be built before shipping, while a committed one (apps that ship built `js/` in git) makes a fresh checkout dist-ready as it is
- the shipped file set is an allowlist of the standard app paths (`appinfo lib l10n templates img css js vendor LICENSES` plus changelog and license files), filtered by existence
- the PHP container image is derived from the app's minimum PHP version, the Node image from `engines.node`

`composer` and `npm` run in throwaway containers (podman preferred, docker supported), so the host needs no PHP or Node toolchain. Use `RUNTIME=bare` to run them on the host instead.

## Per-app tuning (optional)

Most apps need neither of these.

**`.nextcloudignore`** excludes files from the shipped set (rsync exclude syntax, one pattern per line), for example test ballast inside shipped vendor packages:

```
/vendor/*/*/tests/
```

**`ncmake.mk`** overrides single variables in plain make syntax when an app deviates from the conventions:

```make
keep_extra     = resources                # extra runtime paths to ship
php_build_cmd  = composer install --no-dev && php bin/generate.php
node_build_cmd =                          # empty = skip the npm build
```

## Requirements

GNU make, git, curl, openssl, rsync, xmllint (libxml2), python3. Optional: podman or docker for containerized builds.

## Targets

Run `make` (or `make help`) for the full annotated list.

| Area | Targets |
|---|---|
| Release versioning | `version`, `tag` |
| Build | `build`, `dist`, `sign`, `release` |
| Local deploy | `rsync TARGET=...` |
| App Store | `register`, `publish`, `list-releases`, `list-releases-full`, `list-for-author`, `delete-release`, `ratings` |
| Utility | `clean`, `dist-clean`, `self-update`, `help` |

Targets marked `[m]` in the help are maintainer-only. The App Store targets expect the app certificate (`.crt` or `.cert`), key and API token under `~/.nextcloud/certificates/`; `make help` shows for each file whether it was found. They only work for the app owner, everything else works for anyone.

## License

[MIT](LICENSE)
