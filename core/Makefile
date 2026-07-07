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
ncmake_url      = https://raw.githubusercontent.com/ernolf/ncmake/$(or $(NCMAKE_REF),main)/core/Makefile
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
app_id        = $(shell xmllint --xpath 'string(/info/id)' appinfo/info.xml 2>/dev/null)
version       = $(shell xmllint --xpath 'string(/info/version)' appinfo/info.xml 2>/dev/null)
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
# Green check / red cross for the help listing, depending on file existence.
mark          = $(if $(wildcard $(1)),\033[32m✓\033[0m,\033[31m✗\033[0m)

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
php_min     = $(shell xmllint --xpath 'string(//dependencies/php/@min-version)' appinfo/info.xml 2>/dev/null)
node_major  = $(shell python3 -c 'import json,re;print(re.search(r"[0-9]+", json.load(open("package.json"))["engines"]["node"]).group())' 2>/dev/null)
php_image   ?= ghcr.io/nextcloud/continuous-integration-php$(php_min):latest
node_image  ?= node:$(or $(node_major),lts)

ifeq ($(RUNTIME),bare)
  php_run  = sh -lc
  node_run = sh -lc
else ifeq ($(RUNTIME),none)
  php_run  = $(no_runtime)
  node_run = $(no_runtime)
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
  php_run  = $(container) -e COMPOSER_HOME=/tmp/composer -e COMPOSER_ALLOW_SUPERUSER=1 $(php_image) sh -lc
  node_run = $(container) $(node_image) sh -lc
endif

.PHONY: all version changelog tag build check-app check-build stage dist sign release rsync \
        fetch-apps \
        register publish list-releases list-releases-full list-for-author delete-release ratings \
        clean dist-clean self-update help

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
# itself, prompts + validates the version (> latest tag, empty = abort), then branches off into
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
	echo "==> Bumped to $$new on branch $$branch and committed."; \
	echo "==> Next: run 'make changelog', review and extend the generated '## [$$new]' section,"; \
	echo "    commit it on this branch, push, open a PR and merge. Then on main: git pull && make tag"

# Generate the '## [X.Y.Z]' CHANGELOG section for the current info.xml version
# from the conventional commits since the last tag (git-cliff via npx, in the
# node container). The section is inserted above the previous release; the rest
# of the file - header, preamble and hand-written or hand-extended sections - is
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
	awk -v new="$(cache_dir)/changelog_new.md" ' \
		/^## \[/ && !done { while ((getline line < new) > 0) print line; print ""; done=1 } \
		{ print } \
		END { if (!done) { while ((getline line < new) > 0) print line } }' CHANGELOG.md > "$(cache_dir)/changelog_merged.md"; \
	mv "$(cache_dir)/changelog_merged.md" CHANGELOG.md; \
	echo "==> Inserted '## [$$ver]' into CHANGELOG.md - review, extend if needed, then commit."

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

# Deploy the staged runtime file set straight into an apps/ directory via rsync -
# the same files as the dist tarball, without packing and unpacking. Works locally
# and over SSH. TARGET is the apps/ PARENT directory; the app subdir is appended
# automatically. Run 'make build' first so vendor/ (no dev) and js/ are
# production-ready. The occ disable/enable + chown around it is the caller's job
# (same-host only), e.g.:
#   occ app:disable APP && make build && make rsync TARGET=/var/www/nextcloud/apps/ && chown -R www-data:www-data /var/www/nextcloud/apps/APP && occ app:enable APP
rsync: stage
	@test -n "$(TARGET)" || { echo "Usage: make rsync TARGET=<apps-dir | user@host:apps-dir>" >&2; exit 1; }
	@t="$(TARGET)"; dest="$${t%/}/$(app_id)/"; \
	echo "rsync -> $$dest"; \
	rsync -a --delete "$(stage_dir)/$(app_id)/" "$$dest"

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

# Show available targets and required files
help:
	@echo "Usage: make <target>    (no target = this help)"
	@echo ""
	@echo "Release versioning (maintainer only):"
	@echo "  version              Open a release branch with the version bump for a PR (prompts)  [m]"
	@echo "  changelog            Generate the '## [version]' CHANGELOG section from the commits  [m]"
	@echo "  tag                  Tag the release commit on main, signed, and push it  [m]"
	@echo ""
	@echo "  Container runtime for 'version' (lockfile sync) and 'build': RUNTIME=... (now: $(RUNTIME))"
	@echo "    podman | docker | docker-rootless | bare   (auto-detected, podman preferred)"
	@echo ""
	@echo "Build:"
	@echo "  build                Build PHP deps + frontend (auto-detected from composer.json/package.json)"
	@echo "  dist                 Build the distribution tarball from the shipped file set"
	@echo "                       → $(tarball)"
	@echo "  sign                 Sign the tarball (base64 signature for publish / App Store)  [m]"
	@echo "  release              dist + sign in one step  [m]"
	@echo ""
	@echo "Local deploy:"
	@echo "  rsync                Deploy the shipped file set into an apps/ dir via rsync (no tarball)."
	@echo "                       Needs TARGET=<apps-dir|user@host:apps-dir>; run 'make build' first."
	@echo ""
	@echo "  Shipped file set: allowlist of standard app paths, existence-filtered."
	@echo "  Optional per-app tuning: .nextcloudignore (excludes), ncmake.mk (variable overrides)."
	@echo ""
	@echo "App Store  (cert dir: $(cert_dir)$(cert_dir_note))"
	@printf "           %b token: %s\n" "$(call mark,$(token_file))" "$(token_file)"
	@printf "           %b cert:  %s\n" "$(call mark,$(cert_file))" "$(cert_display)"
	@printf "           %b key:   %s\n" "$(call mark,$(key_file))" "$(key_file)"
	@echo ""
	@echo "  register             Register app on the App Store (one-time).  [m]"
	@echo "                       Needs the certificate (.crt or .cert) and .key."
	@echo "  publish              Publish a release: downloads the asset from the URL and signs it.  [m]"
	@echo "                       Prompts for the URL; GH=1 pre-fills the standard GitHub URL to confirm."
	@echo "  list-releases        List published releases (compact JSON)."
	@echo "  list-releases-full   Full App Store entry as JSON."
	@echo "  list-for-author      Find all apps by author (prompts for name)."
	@echo "  delete-release       Delete a release (shows list, prompts for version).  [m]"
	@echo "  ratings              Show app ratings from the App Store."
	@echo ""
	@echo "  apps.json cache: $(apps_cache)"
	@echo "           (ETag: $(apps_etag))"
	@echo ""
	@echo "Utility:"
	@echo "  clean                Remove build/ directory (incl. stage and cache)"
	@echo "  dist-clean           Remove ALL git-ignored build outputs (vendor, node_modules, js, …)"
	@echo "  self-update          Fetch the newest ncmake Makefile"
	@echo "  help                 Show this help"
	@echo ""
	@echo "  [m] = maintainer only (needs repo write access and/or the signing key/cert)"
	@echo ""
	@echo "Current: $(if $(app_id),$(app_id) v$(version),(not inside a Nextcloud app))"
	@echo "ncmake:  $(this_ncmake)"
