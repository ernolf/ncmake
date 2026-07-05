# ncmake

The Swiss Army knife for Nextcloud app development.

A single generic `Makefile` that covers the day-to-day lifecycle of a Nextcloud app: building frontend and PHP dependencies in throwaway containers, packaging the distribution tarball, deploying to a test instance, versioning and tagging releases, and talking to the Nextcloud App Store (register, publish, list, delete, ratings).

It started in [files_sharing_raw](https://github.com/ernolf/files_sharing_raw) and matured in [twofactor_oath](https://github.com/ernolf/twofactor_oath); this repository is its home as a standalone, app-independent tool.

## Status

Imported as-is from twofactor_oath, where it is in productive use. The generalization work happens here; see the roadmap below.

## How it works

Drop the `Makefile` into the root of a Nextcloud app repository. Everything is derived, nothing is configured twice:

- the app id comes from the directory name
- the version comes from `appinfo/info.xml`
- build commands and the packaging exclude list come from `krankerl.toml` (`before_cmds`, `exclude`)
- the PHP container image is derived from the app's minimum PHP version in `info.xml`, the Node image from `engines.node` in `package.json`

`composer` and `npm` run in throwaway containers (podman preferred, docker supported), so the host needs no PHP or Node toolchain. `RUNTIME=bare` runs them on the host instead.

## Requirements

GNU make, git, curl, openssl, rsync, xmllint (libxml2), python3. Optional: podman or docker for containerized builds.

The App Store targets additionally expect the app certificate, key and API token under `~/.nextcloud/certificates/`. They only work for the app owner; everything else works for anyone.

## Targets

Run `make` (or `make help`) for the full annotated list.

| Area | Targets |
|---|---|
| Release versioning | `version`, `tag` |
| Build | `build`, `dist`, `sign`, `release` |
| Local deploy | `rsync TARGET=...` |
| App Store | `register`, `publish`, `list-releases`, `list-releases-full`, `list-for-author`, `delete-release`, `ratings` |
| Utility | `clean`, `dist-clean`, `help` |

Targets marked `[m]` in the help are maintainer-only (they need repository write access and/or the signing key).

## Roadmap

- Own configuration file as the primary source, with `krankerl.toml` still recognized as a fallback
- A lightweight update mechanism so consuming apps always run the current Makefile
- Changelog tooling and a fully documented release lifecycle
- Documentation of every target in this repository

## License

[MIT](LICENSE)
