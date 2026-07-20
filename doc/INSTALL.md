<!--
  SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
  SPDX-License-Identifier: MIT
-->

# 📦 Installing a Nextcloud app built with <img src="../img/ncmake-mark.svg" alt="ncmake" width="130">

This app is built and packaged with [ncmake](https://github.com/ernolf/ncmake), the shared build tool for Nextcloud apps. Installation is therefore the same for every ncmake app: this one guide covers all of it.

## 🔤 Placeholders and example values

Two placeholders stand for values specific to the app or the release. Substitute them wherever they appear:

| Placeholder | Meaning | Example |
|---|---|---|
| `APP_ID` | the app id — the value of `<id>` in the app's `appinfo/info.xml` | `twofactor_oath` |
| `<version>` | the release version you install | `1.2.0` |

The commands also use two concrete example values. Adapt both to your setup:

- **`/var/www/nextcloud`** — your Nextcloud installation directory (the one that contains `occ` and `apps/`).
- **`www-data`** — the web server user. This is the Debian/Ubuntu name; other distributions differ (see [ownership](#-the-app-directory-and-ownership)).

> [!TIP]
> **TL;DR** — Published in the App Store? Install it from there. Otherwise: download a [release tarball](#-method-1--install-a-release-tarball), extract it into `apps/`, `chown` to your web server user, `occ app:enable APP_ID`. Building from source or deploying straight into an instance needs only **podman or docker** — no PHP, no Node.

## 🧭 Which method should I use?

| Situation | Method |
|---|---|
| The app is in the App Store | Install it from the app management UI or with `occ app:enable APP_ID` — nothing here needed. |
| You have a release tarball and just want it installed | [Method 1: release tarball](#-method-1--install-a-release-tarball) — no build toolchain required. |
| There is no release for your version, or you want to build from a branch | [Method 2: build from source](#-method-2--build-the-tarball-from-source) |
| The Nextcloud instance is on a host you can reach (locally or over SSH) | [Method 3: `make rsync`](#-method-3--deploy-with-make-rsync) — deploy straight into `apps/`. |
| The instance runs inside a container (e.g. Nextcloud All-in-One) | [Method 4: `make cp`](#-method-4--deploy-into-a-running-container-with-make-cp) |

Methods 2–4 build in throwaway containers, so the host needs **no PHP and no Node** — only a container runtime (see [Container runtime](#-container-runtime)).

## 📁 The app directory and ownership

A Nextcloud app lives in an `apps/` directory as `/var/www/nextcloud/apps/APP_ID/`. After copying files in, ownership must match the web server user, then the app is enabled through `occ`.

> [!IMPORTANT]
> The directory name **must** be the app id (`APP_ID`), not the name of your checkout or the tarball. `occ app:enable` looks the app up by that directory name.

The web server user depends on your distribution:

| Distribution / setup | Web server user |
|---|---|
| Debian / Ubuntu | `www-data` |
| RHEL / CentOS / Fedora (Apache) | `apache` |
| RHEL / CentOS / Fedora (nginx) | `nginx` |
| Arch Linux | `http` |

`occ` is normally run as the web server user (`sudo -u www-data php /var/www/nextcloud/occ …`).

## 📥 Method 1 — Install a release tarball

> [!TIP]
> **TL;DR** — extract into `apps/`, `chown`, enable. No toolchain needed.

Download the latest `APP_ID-<version>.tar.gz` from the project's **Releases** page, then:

```sh
tar -xzf APP_ID-<version>.tar.gz -C /var/www/nextcloud/apps/
sudo chown -R www-data:www-data /var/www/nextcloud/apps/APP_ID
sudo -u www-data php /var/www/nextcloud/occ app:enable APP_ID
```

## 🔨 Method 2 — Build the tarball from source

> [!TIP]
> **TL;DR** — `git clone`, `make build && make dist`, then install the tarball like Method 1.

You need `git`, `make` and a container runtime (podman or docker). Clone the app and build:

```sh
git clone <app-repository-url>
cd APP_ID
make build && make dist
```

- `make build` installs the runtime PHP dependencies and builds the frontend, each in a throwaway container — nothing is installed on your host.
- `make dist` assembles the runtime file set and writes the tarball to:

  ```
  build/artifacts/dist/APP_ID-<version>.tar.gz
  ```

Install that tarball exactly as in [Method 1](#-method-1--install-a-release-tarball).

## 🚀 Method 3 — Deploy with `make rsync`

> [!TIP]
> **TL;DR** — `make build && make rsync TARGET=/var/www/nextcloud/apps OCC=1` copies the app straight into a reachable instance and enables it.

If the Nextcloud instance is reachable from where you build — the same machine or over SSH — `make rsync` copies the runtime file set straight into `apps/`, without producing a tarball.

```sh
make build
make rsync TARGET=/var/www/nextcloud/apps
```

- `TARGET` is the `apps/` **parent** directory; ncmake appends `/APP_ID` automatically.
- The sync uses `rsync --delete`, so files removed between versions disappear from the instance too.
- `TARGET` may be remote, in `user@host:` form — every step then runs over SSH:

  ```sh
  make rsync TARGET=deploy@server:/var/www/nextcloud/apps
  ```

### One-shot deploy with `OCC=1`

Add `OCC=1` to wrap the sync into the full refresh cycle, so a single command replaces the whole sequence:

```sh
make build && make rsync TARGET=/var/www/nextcloud/apps OCC=1
```

With `OCC=1`, ncmake runs, in order:

1. `occ app:disable APP_ID` (tolerated to fail on a first deploy)
2. the rsync
3. `chown -R www-data: /var/www/nextcloud/apps/APP_ID`
4. `occ app:enable APP_ID`

The disable/enable cycle makes Nextcloud re-read `info.xml` and run any pending database migrations.

> [!IMPORTANT]
> `occ` is expected at `<apps-dir>/../occ` and runs as the web server user (`web_user`, default `www-data`; via `sudo` unless you already are that user). For a **remote** `TARGET`, the SSH user needs the rights to `sudo` and `chown`.

Change the web server user with `web_user=`:

```sh
make rsync TARGET=/var/www/nextcloud/apps OCC=1 web_user=apache
```

Without `OCC=1`, only the rsync happens and the finishing commands are printed for copy and paste.

> [!NOTE]
> Updating is the same command again — `--delete` keeps the installation identical to the current source.

## 🐳 Method 4 — Deploy into a running container with `make cp`

> [!TIP]
> **TL;DR** — for AIO and other dockerized instances: `make build && make cp TARGET=<container>:<apps-dir> OCC=1`.

When the instance's filesystem cannot be reached from outside — a containerized setup such as **Nextcloud All-in-One** — `make cp` copies the runtime file set into the running container instead:

```sh
make build && make cp TARGET=nextcloud-aio-nextcloud:/var/www/html/custom_apps OCC=1
```

- `TARGET` uses `docker cp` syntax: `<container>:<apps-dir>`. The `/APP_ID` subdirectory is appended automatically and replaced as a whole, so removed files disappear too.
- `ENGINE=docker|podman` selects the container CLI. It is deliberately **independent** of `RUNTIME`: the build may use podman while the instance runs under docker, which is why docker is preferred here when both are installed.
- `OCC=1` runs the same disable → copy → chown → enable cycle as Method 3, entirely inside the container, invoking `occ` in the form the All-in-One documentation uses:

  ```sh
  docker exec --user www-data -it nextcloud-aio-nextcloud php occ <command>
  ```

## 🧰 Container runtime

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

> [!CAUTION]
> On SELinux hosts (Fedora, RHEL) bind mounts may need a `:z` label. If you hit permission errors during a build, use `RUNTIME=bare` or adjust your container policy.

## 🔄 Updating

- **Deployed with `make rsync` / `make cp`:** run the same command again after a `git pull`. The `--delete` (rsync) or whole-directory replacement (cp) removes files that no longer exist in the new version.

- **Installed from a tarball:** remove the app first, then reinstall:

  ```sh
  sudo -u www-data php /var/www/nextcloud/occ app:remove APP_ID
  # then Method 1 or 2 again
  ```

> [!IMPORTANT]
> Extracting a new tarball over an old directory can leave **stale files** from the previous version behind. Removing the app first (or deleting the directory) avoids that. The `make` deploy methods do not have this problem — they replace the directory as a whole.

## 🧹 Uninstalling

```sh
sudo -u www-data php /var/www/nextcloud/occ app:remove APP_ID
```

> [!WARNING]
> `app:remove` disables the app and **deletes its directory**. Data the app stored in the database or in the data directory is handled by the app's own removal migrations — check the app's documentation if you need to preserve it.

## ❓ FAQ

**Can I just `git clone` the app straight into `apps/`?**
You can, and it will run once you build it (`cd APP_ID && make build`). But a repository carries a lot that has no place in a running install — tests, CI configuration, dev tooling, frontend sources, screenshots. Every method above ships only the runtime file set; ncmake's [keep model](https://github.com/ernolf/ncmake#-packaging-the-shipped-file-set) strips the rest, so you get a lean install and updates never leave stale dev files behind.

**Do I need PHP or Node on the machine?**
No. `make build`, `make dist`, `make rsync` and `make cp` run their tools in throwaway containers (podman or docker); only `RUNTIME=bare` expects `composer` and `npm` on the `PATH`. Installing a release tarball (Method 1) needs neither — just `tar` and `occ`.

**Which method gives the "cleanest" install?**
All of them ship the identical runtime file set, so none is cleaner than another. Choose by access: a release tarball when you have no toolchain, `make rsync` / `make cp` when you can reach the instance and want a one-command deploy.

## 📚 More

- `make help` lists every target with the detected app, version and certificate status.
- `make help-<target>` prints extended help for one target (options and examples), e.g. `make help-rsync`.
- Full tool documentation: the [ncmake README](https://github.com/ernolf/ncmake#readme).
