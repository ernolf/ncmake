# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: GitHub CLI (gh) setup.
#
# gh-install configures the official gh package source for the host's package
# manager and installs gh, following the upstream install guide:
# https://github.com/cli/cli/blob/trunk/docs/install_linux.md
# The manager is auto-detected (apt, dnf5, dnf4, yum, zypper, pacman, apk,
# brew, conda). Debian/Ubuntu get a deb822 .sources file with the signing key
# ASCII-armored INSIDE the file, so there is no separate keyring file to
# manage; when gpg is present the key is verified against the fingerprints
# documented in the install guide. The check runs --show-keys (parse only, no
# import) inside a throwaway GNUPGHOME, because a first gpg call would
# otherwise scaffold ~/.gnupg on a pristine account. Idempotent: an existing
# source reports
# "already up to date". Privileged steps run directly as root, via sudo (which
# prompts at the step) as a regular user, and without sudo the target says so
# and asks to be re-run as root.

# == Config ==
gh_sources_file = /etc/apt/sources.list.d/github-cli.sources
gh_pkg_url      = https://cli.github.com/packages
gh_key_url      = $(gh_pkg_url)/githubcli-archive-keyring.asc
gh_rpm_repo     = $(gh_pkg_url)/rpm/gh-cli.repo
gh_rpm_repofile = gh-cli.repo
# Signing key fingerprints from the install guide; override in ncmake.mk when
# GitHub rotates the key before the module catches up.
gh_key_fprs    ?= 2C6106201985B60E6C7AC87323F3D4EA75716059 7F38BBB59D064DBCB3D84D725612B36462313325

.PHONY: gh-install

# priv runs a command that needs root: directly as root, via sudo (announced,
# sudo prompts at the step) as a regular user, and without sudo it explains how
# to re-run. Unprivileged work (key download, verification, file assembly) has
# already happened by the time priv is first called, so a plain user on a
# sudo-less host loses nothing but the final copy/install steps.
gh-install:
	@set -e; \
	as_root=; [ "$$(id -u)" = "0" ] && as_root=1; \
	have_sudo=; command -v sudo >/dev/null 2>&1 && have_sudo=1; \
	priv() { \
		if [ -n "$$as_root" ]; then echo "+ $$*"; "$$@"; \
		elif [ -n "$$have_sudo" ]; then echo "==> Root required, running: sudo $$*"; sudo "$$@"; \
		else \
			echo "ERROR: root privileges required for: $$*" >&2; \
			echo "       No sudo found - re-run this target as root, e.g.: su -c 'make gh-install'" >&2; \
			exit 1; \
		fi; \
	}; \
	have_gh=; command -v gh >/dev/null 2>&1 && have_gh=1; \
	if command -v apt-get >/dev/null 2>&1 && [ -d /etc/apt ]; then \
		if [ -f "$(gh_sources_file)" ] && grep -qxF 'URIs: $(gh_pkg_url)' "$(gh_sources_file)"; then \
			echo "==> gh sources are already up to date: $(gh_sources_file)"; \
		else \
			echo "==> Fetching the gh signing key ($(gh_key_url))..."; \
			key=$$(mktemp); curl -fsSL "$(gh_key_url)" -o "$$key"; \
			grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "$$key" \
				|| { echo "ERROR: $(gh_key_url) did not return an ASCII-armored PGP key" >&2; exit 1; }; \
			if command -v gpg >/dev/null 2>&1; then \
				gnupghome=$$(mktemp -d); chmod 700 "$$gnupghome"; \
				fprs=$$(GNUPGHOME="$$gnupghome" gpg --batch --quiet --show-keys --with-colons "$$key" 2>/dev/null | awk -F: '$$1=="pub"{want=1;next} $$1=="fpr"&&want{print $$10;want=0}'); \
				rm -rf "$$gnupghome"; \
				[ -n "$$fprs" ] || { echo "ERROR: could not read any key fingerprint from $(gh_key_url)" >&2; exit 1; }; \
				for fpr in $$fprs; do \
					case " $(gh_key_fprs) " in \
						*" $$fpr "*) echo "==> Signing key verified: $$fpr";; \
						*) echo "ERROR: key fingerprint $$fpr is not in the pinned list." >&2; \
						   echo "       Compare with the install guide and, if the key rotated, override gh_key_fprs in ncmake.mk." >&2; exit 1;; \
					esac; \
				done; \
			else \
				echo "==> gpg not found - skipping the fingerprint check"; \
			fi; \
			tmp=$$(mktemp); \
			{ printf '%s\n' \
				'## github-cli (gh) repository' \
				'# $(gh_pkg_url)' \
				"# created $$(date '+%F %R %Z') by ncmake (https://github.com/ernolf/ncmake)" \
				'## Deb822-style format' \
				'Enabled: yes' \
				'Types: deb' \
				'URIs: $(gh_pkg_url)' \
				'Suites: stable' \
				'Components: main' \
				"Architectures: $$(dpkg --print-architecture)" \
				'Signed-By:'; \
			  awk '/^-----BEGIN PGP PUBLIC KEY BLOCK-----$$/{p=1} p{print ($$0=="" ? " ." : " " $$0)} /^-----END PGP PUBLIC KEY BLOCK-----$$/{p=0}' "$$key"; \
			} > "$$tmp"; rm -f "$$key"; \
			priv install -m 0644 "$$tmp" "$(gh_sources_file)"; \
			rm -f "$$tmp"; \
			echo "==> Created $(gh_sources_file)"; \
		fi; \
		if [ -n "$$have_gh" ]; then \
			echo "==> gh $$(gh --version 2>/dev/null | awk 'NR==1{print $$3}') is already installed (apt-get install gh upgrades it)"; \
		else \
			priv apt-get update; \
			priv apt-get install -y gh; \
		fi; \
	elif command -v dnf5 >/dev/null 2>&1; then \
		if [ -f "/etc/yum.repos.d/$(gh_rpm_repofile)" ]; then \
			echo "==> gh sources are already up to date: /etc/yum.repos.d/$(gh_rpm_repofile)"; \
		else \
			priv dnf install -y dnf5-plugins; \
			priv dnf config-manager addrepo --from-repofile=$(gh_rpm_repo); \
		fi; \
		if [ -n "$$have_gh" ]; then echo "==> gh is already installed (dnf update gh upgrades it)"; \
		else priv dnf install -y gh; fi; \
	elif command -v dnf >/dev/null 2>&1; then \
		if [ -f "/etc/yum.repos.d/$(gh_rpm_repofile)" ]; then \
			echo "==> gh sources are already up to date: /etc/yum.repos.d/$(gh_rpm_repofile)"; \
		else \
			priv dnf install -y 'dnf-command(config-manager)'; \
			priv dnf config-manager --add-repo $(gh_rpm_repo); \
		fi; \
		if [ -n "$$have_gh" ]; then echo "==> gh is already installed (dnf update gh upgrades it)"; \
		else priv dnf install -y gh; fi; \
	elif command -v yum >/dev/null 2>&1; then \
		if [ -f "/etc/yum.repos.d/$(gh_rpm_repofile)" ]; then \
			echo "==> gh sources are already up to date: /etc/yum.repos.d/$(gh_rpm_repofile)"; \
		else \
			priv yum install -y yum-utils; \
			priv yum-config-manager --add-repo $(gh_rpm_repo); \
		fi; \
		if [ -n "$$have_gh" ]; then echo "==> gh is already installed (yum update gh upgrades it)"; \
		else priv yum install -y gh; fi; \
	elif command -v zypper >/dev/null 2>&1; then \
		if [ -f "/etc/zypp/repos.d/$(gh_rpm_repofile)" ]; then \
			echo "==> gh sources are already up to date: /etc/zypp/repos.d/$(gh_rpm_repofile)"; \
		else \
			priv zypper addrepo $(gh_rpm_repo); \
			priv zypper ref; \
		fi; \
		if [ -n "$$have_gh" ]; then echo "==> gh is already installed (zypper update gh upgrades it)"; \
		else priv zypper install -y gh; fi; \
	elif command -v pacman >/dev/null 2>&1; then \
		if [ -n "$$have_gh" ]; then echo "==> gh is already installed (pacman -Syu upgrades it)"; \
		else priv pacman -S github-cli; fi; \
	elif command -v apk >/dev/null 2>&1; then \
		if [ -n "$$have_gh" ]; then echo "==> gh is already installed (apk upgrade github-cli upgrades it)"; \
		else priv apk add github-cli; fi; \
	elif command -v brew >/dev/null 2>&1; then \
		if [ -n "$$have_gh" ]; then echo "==> gh is already installed (brew upgrade gh upgrades it)"; \
		else echo "+ brew install gh"; brew install gh; fi; \
	elif command -v conda >/dev/null 2>&1; then \
		if [ -n "$$have_gh" ]; then echo "==> gh is already installed (conda update gh upgrades it)"; \
		else echo "+ conda install gh --channel conda-forge"; conda install gh --channel conda-forge; fi; \
	else \
		echo "ERROR: no supported package manager found (apt, dnf5, dnf4, yum, zypper, pacman, apk, brew, conda)." >&2; \
		echo "       Precompiled binaries: https://github.com/cli/cli/releases/latest" >&2; \
		echo "       Install guide: https://github.com/cli/cli/blob/trunk/docs/install_linux.md" >&2; \
		exit 1; \
	fi

define help_gh-install
make gh-install

Sets up the official GitHub CLI package source and installs gh, following
https://github.com/cli/cli/blob/trunk/docs/install_linux.md. The host's package
manager is auto-detected: apt, dnf5, dnf4, yum, zypper, pacman, apk, brew or
conda.

On Debian/Ubuntu the source is written in the deb822 format as
/etc/apt/sources.list.d/github-cli.sources with the signing key ASCII-armored
inside the file (Signed-By block), so no separate keyring file is left behind.
When gpg is available the downloaded key is verified against the fingerprints
documented in the install guide (override gh_key_fprs in ncmake.mk after a key
rotation).

The target is idempotent: an existing source prints "already up to date", an
installed gh prints the upgrade command instead of reinstalling. Privileges are
handled per step: as root everything runs directly; as a regular user each
privileged step announces itself and runs through sudo, which prompts right
there; without sudo the target stops with a message to re-run it as root.
brew and conda never need root and always run directly.
endef

help::
	@echo ""
	@echo "$(ch)GitHub CLI (developer module):$(c0)"
	@echo "  $(ct)gh-install$(c0)           Set up the official gh package source and install gh (auto-detected package manager)"
