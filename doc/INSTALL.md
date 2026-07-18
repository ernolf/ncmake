<!--
  SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  SPDX-License-Identifier: MIT
-->

# Installing a Nextcloud app built with ncmake

This app is built and packaged with [ncmake](https://github.com/ernolf/ncmake), the shared build tool for Nextcloud apps. Installation is therefore the same for every ncmake app: this one guide covers all of it.

Throughout, replace `<app>` with the app id (the value of `<id>` in the app's `appinfo/info.xml`, e.g. `twofactor_oath`), and `<ncdir>` with the path to your Nextcloud installation (the directory that contains `occ` and `apps/`).

## Which method should I use?

| Situation | Method |
|---|---|
| The app is in the App Store | Install it from the app management UI or with `occ app:enable <app>` — nothing here needed. |
| You have a release tarball and just want it installed | [Method 1: release tarball](#method-1--install-a-release-tarball) — no build toolchain required. |
| There is no release for your version, or you want to build from a branch | [Method 2: build from source](#method-2--build-the-tarball-from-source) |
| The Nextcloud instance is on a host you can reach (locally or over SSH) | [Method 3: `make rsync`](#method-3--deploy-with-make-rsync) — deploy straight into `apps/`. |
| The instance runs inside a container (e.g. Nextcloud All-in-One) | [Method 4: `make cp`](#method-4--deploy-into-a-running-container-with-make-cp) |

Methods 2–4 build in throwaway containers, so the host needs **no PHP and no Node** — only a container runtime (see [Container runtime](#container-runtime)).

## The app directory and ownership

A Nextcloud app lives in an `apps/` directory as `<ncdir>/apps/<app>/`. The directory name **must** be the app id. After copying files in, ownership must match the web server user, then the app is enabled through `occ`.

The web server user depends on your distribution:

| Distribution / setup | Web server user |
|---|---|
| Debian / Ubuntu | `www-data` |
| RHEL / CentOS / Fedora (Apache) | `apache` |
| RHEL / CentOS / Fedora (nginx) | `nginx` |
| Arch Linux | `http` |

The examples below use `www-data`; substitute yours. `occ` is normally run as the web server user (`sudo -u www-data php <ncdir>/occ …`).

## Method 1 — Install a release tarball

No build toolchain is required. Download the latest `<app>-<version>.tar.gz` from the project's **Releases** page, then:

```sh
tar -xzf <app>-<version>.tar.gz -C <ncdir>/apps/
sudo chown -R www-data:www-data <ncdir>/apps/<app>
sudo -u www-data php <ncdir>/occ app:enable <app>
```

The tarball already contains only the runtime file set (no tests, no CI files, no dev tooling), so nothing has to be cleaned up afterwards.

## Method 2 — Build the tarball from source

You need `git`, `make` and a container runtime (podman or docker). Clone the app and build:

```sh
git clone <app-repository-url>
cd <app>
make build && make dist
```

- `make build` installs the runtime PHP dependencies and builds the frontend, each in a throwaway container — nothing is installed on your host.
- `make dist` assembles the runtime file set and writes the tarball to:

  ```
  build/artifacts/dist/<app>-<version>.tar.gz
  ```

Install that tarball exactly as in [Method 1](#method-1--install-a-release-tarball).

The very first `make` downloads the shared ncmake Makefile once into `~/.cache/ncmake/`; everything after that works offline.

## Method 3 — Deploy with `make rsync`

If the Nextcloud instance is reachable from where you build — the same machine or over SSH — `make rsync` copies the runtime file set straight into `apps/`, without producing a tarball.

```sh
make build
make rsync TARGET=<ncdir>/apps
```

- `TARGET` is the `apps/` **parent** directory; ncmake appends `/<app>` automatically.
- The sync uses `rsync --delete`, so files removed between versions disappear from the instance too.
- `TARGET` may be remote, in `user@host:` form — every step then runs over SSH:

  ```sh
  make rsync TARGET=deploy@server:/var/www/nextcloud/apps
  ```

### One-shot deploy with `OCC=1`

Add `OCC=1` to wrap the sync into the full refresh cycle, so a single command replaces the whole sequence:

```sh
make build && make rsync TARGET=<ncdir>/apps OCC=1
```

With `OCC=1`, ncmake runs, in order:

1. `occ app:disable <app>` (tolerated to fail on a first deploy)
2. the rsync
3. `chown -R www-data: <ncdir>/apps/<app>`
4. `occ app:enable <app>`

The disable/enable cycle makes Nextcloud re-read `info.xml` and run any pending database migrations. `occ` is expected at `<apps-dir>/../occ` and runs as the web server user (`web_user`, default `www-data`; via `sudo` unless you already are that user). For a remote `TARGET`, the SSH user needs the rights to `sudo` and `chown`.

Change the web server user with `web_user=`:

```sh
make rsync TARGET=<ncdir>/apps OCC=1 web_user=apache
```

Without `OCC=1`, only the rsync happens and the finishing commands are printed for copy and paste.

**Updating** is the same command again — `--delete` keeps the installation identical to the current source.

## Method 4 — Deploy into a running container with `make cp`

When the instance's filesystem cannot be reached from outside — a containerized setup such as **Nextcloud All-in-One** — `make cp` copies the runtime file set into the running container instead:

```sh
make build && make cp TARGET=nextcloud-aio-nextcloud:/var/www/html/custom_apps OCC=1
```

- `TARGET` uses `docker cp` syntax: `<container>:<apps-dir>`. The `/<app>` subdirectory is appended automatically and replaced as a whole, so removed files disappear too.
- `ENGINE=docker|podman` selects the container CLI. It is deliberately **independent** of `RUNTIME`: the build may use podman while the instance runs under docker, which is why docker is preferred here when both are installed.
- `OCC=1` runs the same disable → copy → chown → enable cycle as Method 3, entirely inside the container, invoking `occ` in the form the All-in-One documentation uses:

  ```sh
  docker exec --user www-data -it nextcloud-aio-nextcloud php occ <command>
  ```

**Updating** is, again, the same command again.

## Container runtime

`make build`, `make dist`, `make rsync` and `make cp` run their package managers in throwaway containers, so your host needs no PHP and no Node. The runtime is auto-detected (podman preferred, then docker) and can be chosen per call with `RUNTIME=`:

| `RUNTIME=` | What it is | Notes |
|---|---|---|
| `podman` | rootless podman (default when present) | daemonless, files owned by you |
| `docker` | standard rootful docker | ncmake maps your uid/gid in, so no root-owned files appear |
| `docker-rootless` | rootless docker | |
| `bare` | no container | `composer` and `npm` must be on the `PATH` |

```sh
make build RUNTIME=docker
```

On SELinux hosts (Fedora, RHEL) bind mounts may need a `:z` label; if you hit permission errors, use `RUNTIME=bare` or adjust your container policy.

## Updating

- **Installed from a tarball:** remove the app first, then reinstall — this avoids stale files left over from previous versions.

  ```sh
  sudo -u www-data php <ncdir>/occ app:remove <app>
  # then Method 1 or 2 again
  ```

- **Deployed with `make rsync` / `make cp`:** run the same command again after a `git pull`. The `--delete` (rsync) or whole-directory replacement (cp) removes files that no longer exist in the new version.

## Uninstalling

```sh
sudo -u www-data php <ncdir>/occ app:remove <app>
```

`app:remove` disables the app and deletes its directory. Data the app stored in the database or in the data directory is handled by the app's own removal migrations.

## More

- `make help` lists every target with the detected app, version and certificate status.
- `make help-<target>` prints extended help for one target (options and examples), e.g. `make help-rsync`.
- Full tool documentation: the [ncmake README](https://github.com/ernolf/ncmake#readme).
