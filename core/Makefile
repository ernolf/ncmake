# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake - the generic Makefile for Nextcloud app build, release and App Store management
#
# Everything is derived from the app itself (appinfo/info.xml, composer.json,
# package.json); there is nothing to configure for a standard app. The optional
# ncmake.mk (plain make syntax) overrides single variables where an app deviates
# from the conventions, e.g.:
#   keep_extra     = resources          # extra runtime paths to ship
#   php_build_cmd  = composer install --no-dev && php bin/generate.php
#   node_build_cmd =                    # empty = skip the npm build

# == Self-update ==
# this_ncmake is this very file: the per-machine cache when included via the
# bootstrap stub (NCMAKE set there), or the committed copy in the app repo.
# In stub mode the cache refreshes itself at most once per TTL via a conditional
# GET (ETag); offline or unchanged keeps the cache. A committed copy never
# modifies itself; use 'make self-update' explicitly.
this_ncmake    := $(abspath $(lastword $(MAKEFILE_LIST)))
ncmake_raw      = https://raw.githubusercontent.com/ernolf/ncmake/$(or $(NCMAKE_REF),main)
ncmake_url      = $(ncmake_raw)/core/Makefile
NCMAKE_TTL_MIN ?= 1440
ifneq ($(NCMAKE),)
  ifneq ($(shell find "$(NCMAKE)" -mmin +$(NCMAKE_TTL_MIN) 2>/dev/null),)
    $(shell curl -fsSL --etag-compare "$(NCMAKE).etag" --etag-save "$(NCMAKE).etag" "$(ncmake_url)" -o "$(NCMAKE).new" 2>/dev/null; \
      if [ -s "$(NCMAKE).new" ]; then mv "$(NCMAKE).new" "$(NCMAKE)"; else rm -f "$(NCMAKE).new"; fi; touch "$(NCMAKE)")
  endif
endif

-include ncmake.mk

# App id and version come from appinfo/info.xml - the checkout directory name is
# NOT the app id (they often differ), so it is never used for anything.
# xmllint is preferred but not always present (e.g. minimal CI runners); fall
# back to grep so 'make' works on any host without libxml2-utils.
app_id        = $(shell xmllint --xpath 'string(/info/id)' appinfo/info.xml 2>/dev/null || grep -oPm1 '(?<=<id>)[^<]+' appinfo/info.xml 2>/dev/null)
version       = $(shell xmllint --xpath 'string(/info/version)' appinfo/info.xml 2>/dev/null || grep -oPm1 '(?<=<version>)[^<]+' appinfo/info.xml 2>/dev/null)
dist_dir      = $(CURDIR)/build/artifacts/dist
stage_dir     = $(CURDIR)/build/stage
cache_dir     = $(CURDIR)/build/cache
apps_cache    = $(cache_dir)/apps.json
apps_etag     = $(cache_dir)/apps.etag
cert_dir     ?= $(HOME)/.nextcloud/certificates
# Make a missing cert dir obvious: cert_dir_note is appended wherever cert_dir is shown,
# require_cert_dir aborts the maintainer targets that need it with a clear message.
cert_dir_note = $(if $(wildcard $(cert_dir)),, [NOT FOUND])
require_cert_dir = @test -d "$(cert_dir)" || { echo "cert dir not found: $(cert_dir) - create it and add the App Store cert/key/token." >&2; exit 1; }
tarball       = $(dist_dir)/$(app_id)-$(version).tar.gz
# owner/repo from the origin remote (ssh or https), and the canonical download URL
# of the release tarball asset - the default the 'make publish GH=1' prompt offers.
gh_slug       = $(shell git remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$$##')
release_url   = https://github.com/$(gh_slug)/releases/download/v$(version)/$(app_id)-$(version).tar.gz
appstore_api  = https://apps.nextcloud.com/api/v1
api_token     = $(shell cat $(cert_dir)/appstore_api-token 2>/dev/null | tr -d '[:space:]')
# The App Store issues the certificate as .crt; some setups store it as .cert.
# Both are accepted; when neither exists, .crt is shown as the expected name.
cert_file     = $(firstword $(wildcard $(cert_dir)/$(app_id).crt $(cert_dir)/$(app_id).cert))
cert_display  = $(or $(cert_file),$(cert_dir)/$(app_id).crt)
key_file      = $(cert_dir)/$(app_id).key
token_file    = $(cert_dir)/appstore_api-token
# == Help palette ==
# Real ESC bytes (not the literal \033 string) so plain `echo` in the recipes
# passes them straight through. Colors are on when writing to a terminal and
# off otherwise (piped/redirected output stays clean) or when NO_COLOR is set
# (https://no-color.org). MAKE_TERMOUT is empty when stdout is not a terminal;
# on make < 4.1 it is undefined, so colors default on there.
ncmake_tty := $(if $(filter undefined,$(origin MAKE_TERMOUT)),1,$(MAKE_TERMOUT))
ifeq ($(strip $(NO_COLOR)),)
  ifneq ($(strip $(ncmake_tty)),)
    ESC := $(shell printf '\033')
    c0  := $(ESC)[0m
    ch  := $(ESC)[1;36m
    ct  := $(ESC)[32m
    cd  := $(ESC)[2m
    cv  := $(ESC)[33m
    cm  := $(ESC)[35m
    cok := $(ESC)[32m
    cno := $(ESC)[31m
  endif
endif

# Green check / red cross for the help listing, depending on file existence.
mark          = $(if $(wildcard $(1)),$(cok)✓$(c0),$(cno)✗$(c0))

# == Shipped file set (keep model) ==
# The runtime file set is an allowlist, not an exclude list: ship these paths when
# they exist, nothing else. A forgotten exclude can never leak into the tarball,
# and a missing runtime directory fails loudly. keep_extra (ncmake.mk) extends it.
keep_dirs     = appinfo lib l10n templates img css js vendor LICENSES
keep_files    = CHANGELOG.md AUTHORS.md REUSE.toml COPYING COPYING.md LICENSE LICENSE.md
keep_existing = $(wildcard $(keep_dirs) $(keep_files) $(keep_extra))
# Optional excludes WITHIN the shipped set come from .nextcloudignore (the
# ecosystem convention; rsync exclude syntax: anchored /path, dir/, wildcards).
stage_excludes = $(if $(wildcard .nextcloudignore),--exclude-from=.nextcloudignore)

# == Build heuristics ==
# composer runs when composer.json declares real runtime requirements (anything
# besides php/ext-*); npm runs when package.json has a build script. Both are
# overridable in ncmake.mk (set to empty to skip).
need_composer = $(shell python3 -c 'import json;d=json.load(open("composer.json"));print(1 if [k for k in d.get("require",{}) if k!="php" and not k.startswith("ext-")] else "")' 2>/dev/null)
need_npm      = $(shell python3 -c 'import json;d=json.load(open("package.json"));print(1 if "build" in d.get("scripts",{}) else "")' 2>/dev/null)
# .gitignore classifies the outputs: an ignored js/ or vendor/ is a build
# artifact that must be built before shipping; a committed one (apps that ship
# built js/ in git) makes a fresh checkout dist-ready. git check-ignore applies
# the full .gitignore semantics.
# The trailing slash matters: it makes directory-only patterns like "/js/" match
# even while the directory does not exist yet (fresh checkout before the build).
js_ignored     = $(shell git check-ignore -q js/ 2>/dev/null && echo 1)
vendor_ignored = $(shell git check-ignore -q vendor/ 2>/dev/null && echo 1)
php_build_cmd  ?= $(if $(need_composer),composer install --no-dev --no-scripts --prefer-dist --no-progress)
node_build_cmd ?= $(if $(need_npm),npm ci && npm run build)

# == Container runtime (used by 'make version' and 'make build') ==
# composer/npm run in throwaway containers, so the host needs no PHP/Node toolchain.
# The runtime is auto-detected
# (podman preferred, then docker); if neither is installed, the container targets abort with
# a hint to install podman. Override on the command line, e.g. 'make build RUNTIME=docker':
#   podman           podman (rootless by design)
#   docker           standard rootful docker (maps your uid to avoid root-owned files)
#   docker-rootless  rootless docker
#   bare             no container; composer and npm must be on PATH
have_podman := $(shell command -v podman 2>/dev/null)
have_docker := $(shell command -v docker 2>/dev/null)
ifneq ($(have_podman),)
  default_runtime := podman
else ifneq ($(have_docker),)
  default_runtime := docker
else
  default_runtime := none
endif
RUNTIME     ?= $(default_runtime)
no_runtime   = sh -c 'echo "ERROR: no container runtime found (podman/docker). Install podman: apt-get install podman, or use RUNTIME=bare to build on the host." >&2; exit 1'
# Image tags are derived from the declared support range, never hardcoded: the PHP CI
# image from info.xml's min-version, the Node image from package.json's engines.node.
php_min     = $(shell xmllint --xpath 'string(//dependencies/php/@min-version)' appinfo/info.xml 2>/dev/null || grep -oPm1 '(?<=<php min-version=")[^"]+' appinfo/info.xml 2>/dev/null)
node_major  = $(shell python3 -c 'import json,re;print(re.search(r"[0-9]+", json.load(open("package.json"))["engines"]["node"]).group())' 2>/dev/null)
php_image   ?= ghcr.io/nextcloud/continuous-integration-php$(php_min):latest
node_image  ?= node:$(or $(node_major),lts)
reuse_image ?= docker.io/fsfe/reuse:latest

ifeq ($(RUNTIME),bare)
  php_run   = sh -lc
  node_run  = sh -lc
  reuse_run = reuse
else ifeq ($(RUNTIME),none)
  php_run   = $(no_runtime)
  node_run  = $(no_runtime)
  reuse_run = $(no_runtime)
else ifeq ($(RUNTIME),podman)
  container = podman run --rm -v "$(CURDIR)":/app -w /app
else ifeq ($(RUNTIME),docker-rootless)
  container = docker run --rm -v "$(CURDIR)":/app -w /app
else ifeq ($(RUNTIME),docker)
  container = docker run --rm --user $(shell id -u):$(shell id -g) -v "$(CURDIR)":/app -w /app
else
  $(error Unknown RUNTIME '$(RUNTIME)'. Use: podman | docker | docker-rootless | bare)
endif

ifeq ($(filter $(RUNTIME),bare none),)
  php_run   = $(container) -e COMPOSER_HOME=/tmp/composer -e COMPOSER_ALLOW_SUPERUSER=1 $(php_image) sh -lc
  node_run  = $(container) $(node_image) sh -lc
  reuse_run = $(container) $(reuse_image)
endif

.PHONY: all version changelog tag build check-app check-build stage dist sign release rsync cp composer npm reuse \
        fetch-apps \
        csr register publish list-releases list-releases-full list-for-author delete-release ratings \
        clean dist-clean self-update workflows help

# == Changelog configuration (git-cliff) ==
# Keep a Changelog sections from Conventional Commits, user-visible changes only:
# feat -> Added, fix -> Fixed, perf -> Changed; build/ci/test/chore/docs/refactor/
# style and merge commits are left out. The daily Transifex bot commits
# (fix(l10n): Update translations...) are skipped too - they would produce piles
# of identical bullets; describe translation updates by hand where they matter.
# An app can ship its own cliff.toml to override all of this.
define cliff_config
[changelog]
header = ""
body = """
## [{{ version | trim_start_matches(pat="v") }}] - {{ timestamp | date(format="%Y-%m-%d") }}
{% for group, commits in commits | group_by(attribute="group") %}
### {{ group }}

{% for commit in commits -%}
- {% if commit.breaking %}**BREAKING** {% endif %}{{ commit.message | upper_first }}
{% endfor %}
{%- endfor %}
"""
trim = true

[git]
conventional_commits = true
filter_unconventional = true
protect_breaking_commits = true
tag_pattern = "v[0-9].*"
sort_commits = "oldest"
commit_parsers = [
  { message = "^fix\\(l10n\\): Update translations", skip = true },
  { message = "^feat", group = "Added" },
  { message = "^fix", group = "Fixed" },
  { message = "^perf", group = "Changed" },
  { message = ".*", skip = true },
]
endef
export cliff_config

# `make` with no target shows the help instead of building anything.
.DEFAULT_GOAL := help

all: dist

# Every functional target needs the app id; help stays runnable anywhere.
check-app:
	@test -n "$(app_id)" || { echo "ERROR: no <id> found in appinfo/info.xml - run make from a Nextcloud app root." >&2; exit 1; }

# == Release versioning (maintainer only) ==

# Open the next release (maintainer only - needs repo write access). Runs from main, explains
# itself, and warns when a manifest description drifts from the info.xml summary (the
# single source of truth - absent description fields are fine and never warned about).
# Prompts + validates the version (> latest tag, empty = abort), then branches off into
# ncmake/release/X.Y.Z (branches created by ncmake carry the ncmake/ prefix) and commits the
# bump there: info.xml/composer.json/package.json plus the
# re-synced lockfiles (via RUNTIME). 'main' is protected, so the bump lands through that branch
# and a PR, not a direct push. Fill the CHANGELOG on the branch; after the PR is merged, run
# 'make tag' on main.
version: check-app
	@cur=$$(git rev-parse --abbrev-ref HEAD 2>/dev/null); \
	if [ "$$cur" != "main" ]; then echo "make version must run on 'main' (you are on '$$cur')." >&2; exit 1; fi; \
	echo "Maintainer target: opens a release branch with the version bump for a PR"; \
	echo "(main is protected, no direct push); after the merge you tag it with 'make tag'."; \
	latest=$$(git tag --list 'v*' --sort=-v:refname | head -1 | sed 's/^v//'); \
	latest=$${latest:-0.0.0}; \
	printf 'New version (latest tag: %s, empty = abort): ' "$$latest"; read new; \
	[ -z "$$new" ] && { echo "Aborted."; exit 0; }; \
	echo "$$new" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "Not a X.Y.Z version: $$new" >&2; exit 1; }; \
	high=$$(printf '%s\n%s\n' "$$latest" "$$new" | sort -V | tail -1); \
	if [ "$$new" = "$$latest" ] || [ "$$high" != "$$new" ]; then echo "Version $$new must be greater than the latest tag $$latest" >&2; exit 1; fi; \
	branch="ncmake/release/$$new"; \
	git rev-parse --verify --quiet "refs/heads/$$branch" >/dev/null && { echo "Branch $$branch already exists - delete it or pick another version." >&2; exit 1; }; \
	git checkout -b "$$branch" || exit 1; \
	sed -i -E "s|<version>[0-9.]+</version>|<version>$$new</version>|" appinfo/info.xml; \
	[ -f composer.json ] && sed -i -E "s|(\"version\"[[:space:]]*:[[:space:]]*)\"[0-9.]+\"|\1\"$$new\"|" composer.json || true; \
	[ -f package.json ] && sed -i -E "s|(\"version\"[[:space:]]*:[[:space:]]*)\"[0-9.]+\"|\1\"$$new\"|" package.json || true; \
	if [ -f composer.json ] && [ -f composer.lock ]; then echo "==> Syncing composer.lock ($(RUNTIME))..."; $(php_run) 'composer update --lock' || { echo "composer.lock sync failed" >&2; exit 1; }; fi; \
	if [ -f package.json ] && [ -f package-lock.json ]; then echo "==> Syncing package-lock.json ($(RUNTIME))..."; $(node_run) 'npm install --package-lock-only' || { echo "package-lock.json sync failed" >&2; exit 1; }; fi; \
	git add appinfo/info.xml; \
	[ -f composer.json ] && git add composer.json; [ -f composer.lock ] && git add composer.lock; \
	[ -f package.json ] && git add package.json; [ -f package-lock.json ] && git add package-lock.json; \
	git commit -s -m "build(release): bump version to $$new"; \
	echo; \
	summary="$$(xmllint --xpath 'string(/info/summary)' appinfo/info.xml 2>/dev/null)"; \
	for f in composer.json package.json; do \
		[ -f "$$f" ] || continue; \
		d="$$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("description",""))' "$$f" 2>/dev/null)"; \
		if [ -n "$$d" ] && [ "$$d" != "$$summary" ]; then \
			echo "WARNING: the description in $$f differs from the info.xml summary - sync it or drop the field."; \
		fi; \
	done; \
	echo "==> Bumped to $$new on branch $$branch and committed."; \
	echo "==> Next: run 'make changelog' - it generates the '## [$$new]' section and prints"; \
	echo "    the exact commit command (folded into this bump commit while it is unpushed)."; \
	echo "    Then:"; \
	echo "      git push -u origin $$branch"; \
	echo "    Open a PR and merge it; afterwards on main: git pull && make tag"

# Generate the '## [X.Y.Z]' CHANGELOG section for the current info.xml version
# from the conventional commits since the last tag (git-cliff via npx, in the
# node container). The section is inserted above the previous release, followed
# by its '[X.Y.Z]:' link reference to the GitHub release tag; the rest of the
# file - header, preamble and hand-written or hand-extended sections - is
# never touched, so generated entries can be freely edited before committing.
# Refuses to duplicate an existing section; reports when there is nothing to
# document. An app-provided cliff.toml overrides the built-in configuration.
changelog: check-app
	@ver="$(version)"; \
	test -f CHANGELOG.md || { echo "ERROR: no CHANGELOG.md - create it once (Keep a Changelog header), then rerun." >&2; exit 1; }; \
	if grep -q "^## \[$$ver\]" CHANGELOG.md; then \
		echo "CHANGELOG.md already has a '## [$$ver]' section - nothing to do."; exit 0; \
	fi; \
	mkdir -p "$(cache_dir)"; \
	if [ -f cliff.toml ]; then cfg="cliff.toml"; else cfg="build/cache/cliff.toml"; printf '%s\n' "$$cliff_config" > "$$cfg"; fi; \
	echo "==> Generating changelog for $$ver from commits since the last tag ($(RUNTIME))..."; \
	$(node_run) "git config --global --add safe.directory /app 2>/dev/null; npx --yes git-cliff@2 --config $$cfg --unreleased --tag v$$ver --strip all" > "$(cache_dir)/changelog_new.md" || { echo "git-cliff failed" >&2; exit 1; }; \
	if ! grep -q '[^[:space:]]' "$(cache_dir)/changelog_new.md" || ! grep -q '^### ' "$(cache_dir)/changelog_new.md"; then \
		echo "No undocumented user-visible changes since the last tag (only skipped commit types)."; \
		echo "Add a hand-written '## [$$ver]' section if this release still warrants an entry (e.g. translation updates)."; \
		exit 0; \
	fi; \
	if [ -n "$(gh_slug)" ]; then \
		printf '\n[%s]: https://github.com/%s/releases/tag/v%s\n' "$$ver" "$(gh_slug)" "$$ver" >> "$(cache_dir)/changelog_new.md"; \
	fi; \
	awk -v new="$(cache_dir)/changelog_new.md" ' \
		/^## \[/ && !done { while ((getline line < new) > 0) print line; print ""; done=1 } \
		{ print } \
		END { if (!done) { while ((getline line < new) > 0) print line } }' CHANGELOG.md > "$(cache_dir)/changelog_merged.md"; \
	mv "$(cache_dir)/changelog_merged.md" CHANGELOG.md; \
	echo "==> Inserted '## [$$ver]' and its link reference into CHANGELOG.md."; \
	echo "==> Review and extend it, then commit:"; \
	if [ "$$(git log -1 --pretty=%s 2>/dev/null)" = "build(release): bump version to $$ver" ] \
		&& [ "$$(git rev-parse HEAD 2>/dev/null)" != "$$(git rev-parse @{u} 2>/dev/null)" ]; then \
		echo "      git add CHANGELOG.md && git commit --amend --no-edit"; \
		echo "    which folds the changelog into the unpushed bump commit - one commit per release."; \
		echo "    Then:"; \
		echo "      git push -u origin $$(git rev-parse --abbrev-ref HEAD)"; \
		echo "    Open a PR and merge it; afterwards on main: git pull && make tag"; \
	else \
		echo "      git add CHANGELOG.md && git commit -s -m 'build(release): update changelog for $$ver'"; \
	fi

# Freeze the current HEAD as a signed release tag. Everything that belongs in the
# release must already be committed (CHANGELOG and all content). Refuses to re-tag.
tag: check-app
	@ver="$(version)"; \
	latest=$$(git tag --list 'v*' --sort=-v:refname | head -1 | sed 's/^v//'); \
	latest=$${latest:-0.0.0}; \
	high=$$(printf '%s\n%s\n' "$$latest" "$$ver" | sort -V | tail -1); \
	if [ "$$ver" = "$$latest" ] || [ "$$high" != "$$ver" ]; then echo "info.xml version $$ver is not greater than the latest tag $$latest - run 'make version' first" >&2; exit 1; fi; \
	echo "############################################################################"; \
	echo "##  About to create the signed tag v$$ver at the CURRENT commit."; \
	echo "##  EVERYTHING that belongs in this release MUST be committed NOW:"; \
	echo "##  CHANGELOG.md (## [$$ver]) and all release content. A tag is frozen."; \
	echo "############################################################################"; \
	if [ -f CHANGELOG.md ] && ! grep -q "^## \[$$ver\]" CHANGELOG.md; then \
		echo "ERROR: no '## [$$ver]' section in CHANGELOG.md - run 'make changelog' (and merge it) first." >&2; exit 1; \
	fi; \
	printf 'Create and push the signed tag v%s now? [y/N] ' "$$ver"; read yn; \
	if [ "$$yn" = y ] || [ "$$yn" = Y ]; then \
		git tag -s "v$$ver" -m "Release $$ver" && git push origin "v$$ver"; \
	else \
		echo "Aborted. To do it manually:"; \
		echo "  git tag -s v$$ver -m \"Release $$ver\" && git push origin v$$ver"; \
	fi

# == Build ==

# Build the app's dependencies and frontend. What runs is auto-detected (see the
# build heuristics at the top) and routed to its container via RUNTIME.
build: check-app
	@echo "==> Building via RUNTIME=$(RUNTIME)"
	@if [ -n "$(php_build_cmd)" ]; then \
		echo "+ $(php_build_cmd)"; $(php_run) '$(php_build_cmd)' || exit 1; \
	else echo "(composer: nothing to build)"; fi
	@if [ -n "$(node_build_cmd)" ]; then \
		echo "+ $(node_build_cmd)"; $(node_run) '$(node_build_cmd)' || exit 1; \
	else echo "(npm: nothing to build)"; fi

# Generic pass-through into the throwaway containers: run any composer or npm
# command inside the same containers 'make build' uses, so the host needs no
# toolchain even for the dev setup, e.g.:
#   make composer ARGS=install         install dependencies INCLUDING dev tools
#   make composer ARGS="cs:check"      run a composer script
#   make npm ARGS="run test"           run the frontend tests
composer: check-app
	@test -n "$(ARGS)" || { echo "Usage: make composer ARGS=\"<composer arguments>\"" >&2; exit 1; }
	@echo "==> composer $(ARGS) (RUNTIME=$(RUNTIME))"
	@$(php_run) 'composer $(ARGS)'

npm: check-app
	@test -n "$(ARGS)" || { echo "Usage: make npm ARGS=\"<npm arguments>\"" >&2; exit 1; }
	@echo "==> npm $(ARGS) (RUNTIME=$(RUNTIME))"
	@$(node_run) 'npm $(ARGS)'

# REUSE compliance check (https://reuse.software) with the official fsfe/reuse
# container image; RUNTIME=bare expects the reuse tool on the host.
reuse: check-app
	@echo "==> reuse lint (RUNTIME=$(RUNTIME))"
	@$(reuse_run) lint

# Abort (do not ship a broken file set) when a build output is missing. Only
# gitignored outputs are demanded: a committed js/ or vendor/ ships as-is.
check-build:
	@if [ -n "$(need_npm)" ] && [ -n "$(js_ignored)" ] && { [ ! -d js ] || [ -z "$$(ls -A js 2>/dev/null)" ]; }; then \
		echo "ERROR: js/ is missing or empty - run 'make build' first." >&2; exit 1; \
	fi
	@if [ -n "$(need_composer)" ] && [ -n "$(vendor_ignored)" ] && [ ! -f vendor/autoload.php ]; then \
		echo "ERROR: vendor/autoload.php is missing - run 'make build' first." >&2; exit 1; \
	fi

# Materialize the shipped runtime file set once, under the APP ID (the checkout
# directory name may differ). dist tars this staging tree, rsync deploys it - one
# mechanism, one source of truth.
stage: check-app check-build
	@rm -rf "$(stage_dir)"
	@mkdir -p "$(stage_dir)/$(app_id)"
	rsync -a --relative $(stage_excludes) $(addprefix ./,$(keep_existing)) "$(stage_dir)/$(app_id)/"

# Build the distribution tarball from the staged file set
dist: stage
	@rm -rf "$(dist_dir)"
	@mkdir -p "$(dist_dir)"
	tar czf "$(tarball)" -C "$(stage_dir)" "$(app_id)"
	@echo "Built: $(tarball)"

# Sign the tarball — output is the base64 signature to paste into GitHub Release
sign: check-app $(tarball)
	$(require_cert_dir)
	@echo "Signing $(tarball)..."
	openssl dgst -sha512 -sign "$(key_file)" $(tarball) | openssl base64

# Build tarball and sign in one step
release: dist sign

# == Local deploy ==

# The web server user of the target instance: owns the deployed files, and occ
# runs as it. Override in ncmake.mk when your instance differs.
web_user ?= www-data

# Deploy the staged runtime file set straight into an apps/ directory via rsync -
# the same files as the dist tarball, without packing and unpacking. Works locally
# and over SSH. TARGET is the apps/ PARENT directory; the app subdir is appended
# automatically. Run 'make build' first so vendor/ (no dev) and js/ are
# production-ready.
# OCC=1 runs the full refresh cycle around the sync: occ app:disable, rsync,
# chown to $(web_user), occ app:enable. occ is expected at <apps-dir>/../occ and
# runs as $(web_user) (via sudo unless you already are that user); on a remote
# TARGET every step goes through ssh, so the ssh user needs the rights for sudo
# and chown. Without OCC=1 only the rsync happens and the finishing commands are
# printed ready for copy and paste.
rsync: stage
	@test -n "$(TARGET)" || { echo "Usage: make rsync TARGET=<apps-dir | user@host:apps-dir> [OCC=1]" >&2; exit 1; }
	@t="$(TARGET)"; t="$${t%/}"; \
	case "$$t" in \
	  *:*) host="$${t%%:*}"; dir="$${t#*:}";; \
	  *)   host="";          dir="$$t";; \
	esac; \
	app_dir="$$dir/$(app_id)"; \
	if [ -z "$$host" ] && [ "$$(id -un)" = "$(web_user)" ]; then occ_run="php $${dir%/*}/occ"; \
	else occ_run="sudo -u $(web_user) php $${dir%/*}/occ"; fi; \
	run() { if [ -n "$$host" ]; then ssh "$$host" "$$1"; else eval "$$1"; fi; }; \
	if [ -n "$(OCC)" ]; then \
		echo "+ $$occ_run app:disable $(app_id)"; \
		run "$$occ_run app:disable $(app_id)" || echo "(app:disable failed - continuing; first deploy?)"; \
	fi; \
	echo "rsync -> $$t/$(app_id)/"; \
	rsync -a --delete "$(stage_dir)/$(app_id)/" "$$t/$(app_id)/" || exit 1; \
	if [ -n "$(OCC)" ]; then \
		echo "+ chown -R $(web_user): $$app_dir"; run "chown -R $(web_user): $$app_dir" || exit 1; \
		echo "+ $$occ_run app:enable $(app_id)"; run "$$occ_run app:enable $(app_id)" || exit 1; \
	else \
		echo; \
		echo "Deployed without the occ cycle. Finish$${host:+ on $$host} (copy & paste):"; \
		echo "  chown -R $(web_user): $$app_dir && $$occ_run app:enable $(app_id)"; \
		echo "Next time 'make rsync TARGET=$(TARGET) OCC=1' runs app:disable, rsync, chown and app:enable in one go."; \
	fi

# The container CLI used by 'make cp'. Deliberately independent of RUNTIME:
# builds may prefer podman while the Nextcloud instance runs under docker
# (e.g. All-in-One), so docker is preferred here.
ENGINE ?= $(if $(have_docker),docker,$(if $(have_podman),podman,))

# Deploy the staged runtime file set into a RUNNING container's apps/ directory -
# for instances whose filesystem rsync cannot reach from outside, e.g. Nextcloud
# All-in-One. TARGET uses docker-cp syntax (<container>:<apps-dir>); the app
# subdir is appended automatically and replaced as a whole, so removed files
# disappear too.
# OCC=1 runs the full refresh cycle inside the container: occ app:disable, copy,
# chown to $(web_user), occ app:enable. occ is invoked in the form the All-in-One
# documentation uses ('exec --user www-data ... php occ'), with occ resolved at
# <apps-dir>/../occ. The printed copy-and-paste lines carry -it because they are
# meant for an interactive terminal; the automated calls run without a TTY and
# therefore without -it.
cp: stage
	@test -n "$(ENGINE)" || { echo "ERROR: no container CLI found (docker/podman)." >&2; exit 1; }
	@t="$(TARGET)"; c="$${t%%:*}"; d="$${t#*:}"; \
	if [ -z "$$t" ] || [ "$$c" = "$$t" ] || [ -z "$$c" ] || [ -z "$$d" ]; then \
		echo "Usage: make cp TARGET=<container>:<apps-dir> [OCC=1]" >&2; exit 1; \
	fi; \
	d="$${d%/}"; app_dir="$$d/$(app_id)"; occ="$${d%/*}/occ"; \
	occ_run="$(ENGINE) exec --user $(web_user) $$c php $$occ"; \
	if [ -n "$(OCC)" ]; then \
		echo "+ $$occ_run app:disable $(app_id)"; \
		$$occ_run app:disable $(app_id) || echo "(app:disable failed - continuing; first deploy?)"; \
	fi; \
	echo "$(ENGINE) cp -> $$c:$$app_dir/"; \
	{ $(ENGINE) exec "$$c" rm -rf "$$app_dir" && \
	  $(ENGINE) cp "$(stage_dir)/$(app_id)" "$$c:$$d/"; } || exit 1; \
	if [ -n "$(OCC)" ]; then \
		echo "+ $(ENGINE) exec $$c chown -R $(web_user): $$app_dir"; \
		$(ENGINE) exec "$$c" chown -R "$(web_user):" "$$app_dir" || exit 1; \
		echo "+ $$occ_run app:enable $(app_id)"; \
		$$occ_run app:enable $(app_id) || exit 1; \
	else \
		echo; \
		echo "Deployed without the occ cycle. Finish (copy & paste):"; \
		echo "  $(ENGINE) exec $$c chown -R $(web_user): $$app_dir && $(ENGINE) exec --user $(web_user) -it $$c php $$occ app:enable $(app_id)"; \
		echo "Next time 'make cp TARGET=$(TARGET) OCC=1' runs app:disable, copy, chown and app:enable in one go."; \
	fi

# == App Store cache ==

# Fetch apps.json with ETag caching (always runs as prerequisite).
# 304 Not Modified → use cached file.
# 200 OK           → update cache and save new ETag.
# Error + cache    → warn and use stale cache.
# Error, no cache  → fail.
fetch-apps:
	@mkdir -p "$(cache_dir)"; \
	_etag=""; \
	test -f "$(apps_etag)" && _etag=$$(cat "$(apps_etag)"); \
	if [ -n "$$_etag" ] && [ -f "$(apps_cache)" ]; then \
		_http=$$(curl -sL --compressed -D /tmp/.ncmake_hdrs -o /tmp/.ncmake_apps_new -w "%{http_code}" \
			-H "If-None-Match: $$_etag" "$(appstore_api)/apps.json"); \
	else \
		_http=$$(curl -sL --compressed -D /tmp/.ncmake_hdrs -o /tmp/.ncmake_apps_new -w "%{http_code}" \
			"$(appstore_api)/apps.json"); \
	fi; \
	case "$$_http" in \
		304) rm -f /tmp/.ncmake_apps_new; \
			echo "(apps.json not modified — using cache)";; \
		200) mv /tmp/.ncmake_apps_new "$(apps_cache)"; \
			_new_etag=$$(grep -i '^etag:' /tmp/.ncmake_hdrs | head -1 \
				| sed 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//' | tr -d '\r\n'); \
			[ -n "$$_new_etag" ] && printf '%s' "$$_new_etag" > "$(apps_etag)"; \
			echo "(apps.json updated)";; \
		*)  rm -f /tmp/.ncmake_apps_new; \
			if [ -f "$(apps_cache)" ]; then \
				echo "(apps.json fetch failed HTTP $$_http — using stale cache)"; \
			else \
				echo "Failed to fetch apps.json (HTTP $$_http)."; exit 1; \
			fi;; \
	esac

# == App Store ==

# Generate the signing key and certificate signing request (one-time setup,
# first step of the store onboarding). Prints the CSR for the pull request to
# https://github.com/nextcloud/app-certificate-requests; the certificate issued
# there goes into $(cert_dir) as $(app_id).crt, then 'make register' follows.
# Refuses to overwrite an existing key or CSR.
csr: check-app
	@mkdir -p "$(cert_dir)"
	@test ! -f "$(key_file)" || { echo "ERROR: $(key_file) already exists - refusing to overwrite." >&2; exit 1; }
	@csr="$(cert_dir)/$(app_id).csr"; \
	test ! -f "$$csr" || { echo "ERROR: $$csr already exists - refusing to overwrite." >&2; exit 1; }; \
	echo "Generating key + CSR for '$(app_id)' in $(cert_dir)..."; \
	openssl req -nodes -newkey rsa:4096 -sha256 -keyout "$(key_file)" -out "$$csr" -subj "/CN=$(app_id)" || exit 1; \
	chmod 600 "$(key_file)"; \
	echo; \
	echo "CSR - submit as $(app_id)/$(app_id).csr in a PR to"; \
	echo "https://github.com/nextcloud/app-certificate-requests:"; \
	echo; \
	cat "$$csr"; \
	echo; \
	echo "After the PR is merged, save the issued certificate as $(cert_display)"; \
	echo "and run 'make register'."

# Register the app on the App Store (one-time setup).
# Requires the app certificate (.crt or .cert) and .key in $(cert_dir).
register: check-app
	$(require_cert_dir)
	@set -e; \
	test -n "$(cert_file)" || { echo "Certificate not found: $(cert_dir)/$(app_id).crt (or .cert)"; exit 1; }; \
	test -f "$(key_file)"  || { echo "Key not found: $(key_file)"; exit 1; }; \
	echo "Computing signature over app id '$(app_id)'..."; \
	echo -n "$(app_id)" | openssl dgst -sha512 -sign "$(key_file)" | openssl base64 | tr -d '\n' > /tmp/.ncmake_sig; \
	python3 -c "import json;cert=open('$(cert_file)').read().strip().replace('\n','\r\n');sig=open('/tmp/.ncmake_sig').read();print(json.dumps({'certificate':cert,'signature':sig}))" > /tmp/.ncmake_body; \
	echo "Registering $(app_id) on the App Store..."; \
	http=$$(curl -s -o /tmp/.ncmake_resp -w "%{http_code}" \
		-X POST \
		-H "Authorization: Token $(api_token)" \
		-H "Content-Type: application/json" \
		--data-binary @/tmp/.ncmake_body \
		"$(appstore_api)/apps"); \
	case "$$http" in \
		201) echo "Success — app registered.";; \
		204) echo "Success — registration updated (certificate changed).";; \
		400) echo "HTTP 400 — invalid data or signature:"; cat /tmp/.ncmake_resp; echo; exit 1;; \
		401) echo "HTTP 401 — check $(cert_dir)/appstore_api-token"; exit 1;; \
		403) echo "HTTP 403 — not authorized."; exit 1;; \
		*)   echo "HTTP $$http:"; cat /tmp/.ncmake_resp; echo; exit 1;; \
	esac

# Publish a new release to the App Store. The download URL is ALWAYS required, and
# the tarball is ALWAYS downloaded from it and signed - so the signature can never
# be computed over other bytes than the App Store fetches. The asset may be hosted
# anywhere (curl handles it, including your own server); only when the URL is a
# GitHub release asset AND gh is installed does gh do the download (so private
# repos work too). Two ways to give the URL:
#   make publish              prompt for the download URL (any host)
#   make publish GH=1         pre-fill the standard GitHub release URL for the
#                             current version, so you only press Enter to confirm
# URL=<download-url> sets it non-interactively in either case.
publish: check-app
	$(require_cert_dir)
	@set -e; \
	url="$(URL)"; \
	if [ -z "$$url" ]; then \
		if [ -n "$(GH)" ]; then read -p "Download URL [$(release_url)]: " url; url="$${url:-$(release_url)}"; \
		else read -p "Download URL: " url; fi; \
	fi; \
	test -n "$$url" || { echo "Aborted."; exit 0; }; \
	tmpd=/tmp/.ncmake_publish; rm -rf "$$tmpd"; mkdir -p "$$tmpd"; \
	file="$${url##*/}"; asset="$$tmpd/$$file"; \
	rest="$${url#https://github.com/}"; gh_ok=; \
	if [ "$$rest" != "$$url" ] && command -v gh >/dev/null 2>&1; then \
		slug=$$(printf '%s' "$$rest" | cut -d/ -f1-2); \
		s3=$$(printf '%s' "$$rest" | cut -d/ -f3); s4=$$(printf '%s' "$$rest" | cut -d/ -f4); \
		tag=$$(printf '%s' "$$rest" | cut -d/ -f5); \
		[ "$$s3" = releases ] && [ "$$s4" = download ] && [ -n "$$tag" ] && [ -n "$$file" ] && gh_ok=1; \
	fi; \
	echo "Downloading $$url ..."; \
	if [ -n "$$gh_ok" ]; then \
		gh release download "$$tag" -R "$$slug" -p "$$file" -D "$$tmpd" || { echo "gh release download failed" >&2; exit 1; }; \
	else \
		curl -fL "$$url" -o "$$asset" || { echo "download failed: $$url" >&2; exit 1; }; \
	fi; \
	test -s "$$asset" || { echo "ERROR: downloaded asset is empty or missing: $$asset" >&2; exit 1; }; \
	echo "Computing signature over the downloaded asset..."; \
	openssl dgst -sha512 -sign "$(key_file)" "$$asset" | openssl base64 | tr -d '\n' > /tmp/.ncmake_sig; \
	python3 -c "import sys,json;sig=open('/tmp/.ncmake_sig').read();print(json.dumps({'download':sys.argv[1],'signature':sig}))" "$$url" > /tmp/.ncmake_body; \
	echo "Publishing v$(version) to the App Store..."; \
	http=$$(curl -s -o /tmp/.ncmake_resp -w "%{http_code}" \
		-X POST \
		-H "Authorization: Token $(api_token)" \
		-H "Content-Type: application/json" \
		--data-binary @/tmp/.ncmake_body \
		"$(appstore_api)/apps/releases"); \
	case "$$http" in \
		200) echo "Release v$(version) updated on the App Store.";; \
		201) echo "Release v$(version) published successfully!";; \
		400) echo "HTTP 400 — invalid data, signature or URL not reachable:"; cat /tmp/.ncmake_resp; echo; exit 1;; \
		401) echo "HTTP 401 — check $(cert_dir)/appstore_api-token"; exit 1;; \
		403) echo "HTTP 403 — not authorized."; exit 1;; \
		*)   echo "HTTP $$http:"; cat /tmp/.ncmake_resp; echo; exit 1;; \
	esac

# List published releases of this app (compact JSON)
list-releases: check-app fetch-apps
	@python3 -c "import sys,json;apps=json.load(open('$(apps_cache)'));app=next((a for a in apps if a['id']=='$(app_id)'),None);sys.exit(1) if not app else print(json.dumps({'id':app['id'],'releases':[{'version':r['version'],'created':r['created'],'download':r['download']} for r in app['releases']]},indent=2))" 2>/dev/null \
	|| echo "($(app_id) not found in App Store)"

# Full App Store entry as JSON
list-releases-full: check-app fetch-apps
	@python3 -c "import sys,json;apps=json.load(open('$(apps_cache)'));app=next((a for a in apps if a['id']=='$(app_id)'),None);sys.exit(1) if not app else print(json.dumps(app,indent=2))" 2>/dev/null \
	|| echo "($(app_id) not found in App Store)"

# Find all apps by author name (prompts for search string)
list-for-author: fetch-apps
	@read -p "Author search string: " term; \
	test -n "$$term" || { echo "Aborted."; exit 1; }; \
	python3 -c "import sys,json;apps=json.load(open('$(apps_cache)'));term=sys.argv[1].lower();matched=[{'id':a['id'],'name':next(iter(a.get('translations',{}).values()),{}).get('name',''),'authors':a.get('authors',[]),'releases':[r['version'] for r in a['releases']]} for a in apps if any(term in au['name'].lower() for au in a.get('authors',[]))];print(json.dumps(matched,indent=2))" "$$term" 2>/dev/null \
	|| echo "Failed to search app list."

# Delete a specific release from the App Store (interactive)
delete-release: check-app fetch-apps
	$(require_cert_dir)
	@set -e; \
	releases=$$(python3 -c "import sys,json;apps=json.load(open('$(apps_cache)'));app=next((a for a in apps if a['id']=='$(app_id)'),None);[print(r['version']) for r in (app or {}).get('releases',[])]" 2>/dev/null || true); \
	if [ -n "$$releases" ]; then \
		echo "Published releases:"; \
		echo "$$releases" | sed 's/^/  /'; \
	else \
		echo "(Could not read app data — current version in info.xml: $(version))"; \
	fi; \
	read -p "Version to delete (empty = abort): " ver; \
	test -n "$$ver" || { echo "Aborted."; exit 0; }; \
	read -p "Delete $(app_id) v$$ver from the App Store? [y/N] " confirm; \
	[ "$$confirm" = "y" ] || [ "$$confirm" = "Y" ] || { echo "Aborted."; exit 0; }; \
	http=$$(curl -s -o /dev/null -w "%{http_code}" \
		-X DELETE \
		-H "Authorization: Token $(api_token)" \
		"$(appstore_api)/apps/$(app_id)/releases/$$ver"); \
	case "$$http" in \
		204) echo "Release $$ver deleted successfully.";; \
		401) echo "HTTP 401 — check $(cert_dir)/appstore_api-token"; exit 1;; \
		403) echo "HTTP 403 — not authorized."; exit 1;; \
		404) echo "HTTP 404 — release $$ver not found."; exit 1;; \
		*)   echo "HTTP $$http — unexpected error."; exit 1;; \
	esac

# Show ratings for this app from the App Store
ratings: check-app
	@curl -sf "$(appstore_api)/ratings.json" 2>/dev/null \
	| python3 -c "import sys,json;d=json.load(sys.stdin);own=[r for r in d if r.get('app')=='$(app_id)'];avg=round(sum(r['rating'] for r in own)/len(own)*5,2) if own else None;print(json.dumps({'app':'$(app_id)','count':len(own),'avgRating':avg,'ratings':[{'rating':round(r['rating']*5,1),'ratedAt':r['ratedAt'],'comment':next(iter(r.get('translations',{}).values()),{}).get('comment','')} for r in sorted(own,key=lambda r:r['ratedAt'],reverse=True)]},indent=2))" 2>/dev/null \
	|| echo "Failed to fetch ratings."

# == Utility ==

# Remove all build artifacts (including stage and cache)
clean:
	rm -rf build

# Remove every git-ignored build output for a true from-scratch rebuild: runs 'clean' first
# (build/), then vendor/, node_modules/, js/, caches and the nested dependency repos composer
# leaves behind, via 'git clean -dffX' (-X = ignored files only, so untracked source stays;
# the second -f also clears those nested git repos). git clean lists each removed path.
dist-clean: clean
	git clean -dffX

# Fetch the newest ncmake Makefile over this one (the per-machine cache in stub
# mode, the committed copy otherwise).
self-update:
	@curl -fsSL "$(ncmake_url)" -o "$(this_ncmake)" && rm -f "$(this_ncmake).etag" && echo "ncmake updated: $(this_ncmake)"

# Install or update the ncmake-provided GitHub Actions workflow files into
# .github/workflows/. They carry no app-specific data and are committed verbatim,
# so this just fetches the current versions (NCMAKE_REF selects which); run it
# again any time to pick up changes. Only the bootstrap stub is installed by hand;
# everything else ncmake ships lands through here.
ncmake_workflows ?= release.yml
workflows:
	@mkdir -p .github/workflows
	@for wf in $(ncmake_workflows); do \
		tmp="$$(mktemp)"; \
		if ! curl -fsSL "$(ncmake_raw)/workflows/$$wf" -o "$$tmp"; then \
			echo "ERROR: could not fetch $$wf from ncmake (check your network / NCMAKE_REF)" >&2; \
			rm -f "$$tmp"; exit 1; \
		fi; \
		dst=".github/workflows/$$wf"; \
		if [ ! -f "$$dst" ]; then mv "$$tmp" "$$dst"; echo "installed: $$dst"; \
		elif cmp -s "$$tmp" "$$dst"; then rm -f "$$tmp"; echo "up to date: $$dst"; \
		else mv "$$tmp" "$$dst"; echo "updated:   $$dst"; fi; \
	done
	@echo "Review and commit: git add .github/workflows/"

# Show available targets and required files
help:
	@echo "$(cd)Usage: make <target>    (no target = this help)$(c0)"
	@echo ""
	@echo "$(ch)Release versioning (maintainer only):$(c0)"
	@echo "  $(ct)version$(c0)              Open a release branch with the version bump for a PR (prompts)  $(cm)[m]$(c0)"
	@echo "  $(ct)changelog$(c0)            Generate the '## [version]' CHANGELOG section from the commits  $(cm)[m]$(c0)"
	@echo "  $(ct)tag$(c0)                  Tag the release commit on main, signed, and push it  $(cm)[m]$(c0)"
	@echo ""
	@echo "  $(cd)Container runtime for 'version' (lockfile sync) and 'build': $(c0)$(cv)RUNTIME=...$(c0)$(cd) (now: $(RUNTIME))$(c0)"
	@echo "    $(cd)podman | docker | docker-rootless | bare   (auto-detected, podman preferred)$(c0)"
	@echo ""
	@echo "$(ch)Build:$(c0)"
	@echo "  $(ct)build$(c0)                Build PHP deps + frontend (auto-detected from composer.json/package.json)"
	@echo "  $(ct)composer$(c0) $(cv)ARGS=...$(c0)    Run any composer command in the throwaway PHP container"
	@echo "  $(ct)npm$(c0) $(cv)ARGS=...$(c0)         Run any npm command in the throwaway Node container"
	@echo "  $(ct)reuse$(c0)                Run the REUSE compliance check in the fsfe/reuse container"
	@echo "  $(ct)dist$(c0)                 Build the distribution tarball from the shipped file set"
	@echo "                       $(cd)→ $(tarball)$(c0)"
	@echo "  $(ct)sign$(c0)                 Sign the tarball (base64 signature for publish / App Store)  $(cm)[m]$(c0)"
	@echo "  $(ct)release$(c0)              dist + sign in one step  $(cm)[m]$(c0)"
	@echo ""
	@echo "$(ch)Local deploy:$(c0)"
	@echo "  $(ct)rsync$(c0)                Deploy the shipped file set into an apps/ dir via rsync (no tarball)."
	@echo "                       Needs $(cv)TARGET=<apps-dir|user@host:apps-dir>$(c0); run 'make build' first."
	@echo "                       $(cv)OCC=1$(c0) adds occ app:disable -> chown -> occ app:enable around it."
	@echo "  $(ct)cp$(c0)                   Deploy the shipped file set into a RUNNING container's apps/ dir"
	@echo "                       (e.g. Nextcloud All-in-One). Needs $(cv)TARGET=<container>:<apps-dir>$(c0);"
	@echo "                       $(cv)OCC=1$(c0) as above, inside the container; $(cv)ENGINE=docker|podman$(c0) (now: $(ENGINE))."
	@echo ""
	@echo "  $(cd)Shipped file set: allowlist of standard app paths, existence-filtered.$(c0)"
	@echo "  $(cd)Optional per-app tuning: .nextcloudignore (excludes), ncmake.mk (variable overrides).$(c0)"
	@echo ""
	@echo "$(ch)App Store$(c0)  $(cd)(cert dir: $(cert_dir)$(cert_dir_note))$(c0)"
	@printf "           %b token: %s\n" "$(call mark,$(token_file))" "$(token_file)"
	@printf "           %b cert:  %s\n" "$(call mark,$(cert_file))" "$(cert_display)"
	@printf "           %b key:   %s\n" "$(call mark,$(key_file))" "$(key_file)"
	@echo ""
	@echo "  $(ct)csr$(c0)                  Generate the signing key + certificate request (one-time).  $(cm)[m]$(c0)"
	@echo "  $(ct)register$(c0)             Register app on the App Store (one-time).  $(cm)[m]$(c0)"
	@echo "                       Needs the certificate (.crt or .cert) and .key."
	@echo "  $(ct)publish$(c0)              Publish a release: downloads the asset from the URL and signs it.  $(cm)[m]$(c0)"
	@echo "                       Prompts for the URL; $(cv)GH=1$(c0) pre-fills the standard GitHub URL to confirm."
	@echo "  $(ct)list-releases$(c0)        List published releases (compact JSON)."
	@echo "  $(ct)list-releases-full$(c0)   Full App Store entry as JSON."
	@echo "  $(ct)list-for-author$(c0)      Find all apps by author (prompts for name)."
	@echo "  $(ct)delete-release$(c0)       Delete a release (shows list, prompts for version).  $(cm)[m]$(c0)"
	@echo "  $(ct)ratings$(c0)              Show app ratings from the App Store."
	@echo ""
	@echo "  $(cd)apps.json cache: $(apps_cache)$(c0)"
	@echo "  $(cd)         (ETag: $(apps_etag))$(c0)"
	@echo ""
	@echo "$(ch)Utility:$(c0)"
	@echo "  $(ct)clean$(c0)                Remove build/ directory (incl. stage and cache)"
	@echo "  $(ct)dist-clean$(c0)           Remove ALL git-ignored build outputs (vendor, node_modules, js, …)"
	@echo "  $(ct)self-update$(c0)          Fetch the newest ncmake Makefile"
	@echo "  $(ct)workflows$(c0)            Install/update the ncmake CI workflow files in .github/workflows/"
	@echo "  $(ct)help$(c0)                 Show this help"
	@echo ""
	@echo "  $(cm)[m]$(c0) $(cd)= maintainer only (needs repo write access and/or the signing key/cert)$(c0)"
	@echo ""
	@echo "$(cd)Current:$(c0) $(if $(app_id),$(cv)$(app_id) v$(version)$(c0),$(cd)(not inside a Nextcloud app)$(c0))"
	@echo "$(cd)ncmake:  $(this_ncmake)$(c0)"
