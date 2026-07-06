# ncmake

The Swiss Army knife for Nextcloud app development: one generic `Makefile` for building, packaging, deploying, versioning and App Store management of a Nextcloud app.

## Installation

Copy the `Makefile` into the root of your app repository. That is all; there is nothing to configure for a standard app.

```sh
curl -fLO https://raw.githubusercontent.com/ernolf/ncmake/main/Makefile
```

## Usage

```sh
make            # show all targets
make build      # build PHP dependencies and frontend
make dist       # build the distribution tarball
make rsync TARGET=/var/www/nextcloud/apps/   # deploy to a test instance
```

Everything is derived from the app itself:

- app id and version come from `appinfo/info.xml` (never from the directory name)
- build commands are detected: `composer install --no-dev ...` when `composer.json` declares runtime requirements, `npm ci && npm run build` when `package.json` has a build script
- the shipped file set is an allowlist of the standard app paths (`appinfo lib l10n templates img css js vendor LICENSES` plus changelog and license files), filtered by existence
- the PHP container image is derived from the app's minimum PHP version, the Node image from `engines.node`

`composer` and `npm` run in throwaway containers (podman preferred, docker supported), so the host needs no PHP or Node toolchain. Use `RUNTIME=bare` to run them on the host instead.

## Per-app tuning (optional)

Most apps need neither of these.

**`.nextcloudignore`** excludes files from the shipped set (rsync exclude syntax, one pattern per line), for example generated source maps:

```
/js/*.map
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
| Utility | `clean`, `dist-clean`, `help` |

Targets marked `[m]` in the help are maintainer-only. The App Store targets expect the app certificate, key and API token under `~/.nextcloud/certificates/`; they only work for the app owner, everything else works for anyone.

## License

[MIT](LICENSE)
