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
ncmake_ref      = $(or $(NCMAKE_REF),main)
ncmake_raw      = https://raw.githubusercontent.com/ernolf/ncmake/$(ncmake_ref)
ncmake_url      = $(ncmake_raw)/core/Makefile
NCMAKE_TTL_MIN ?= 1440
ifneq ($(NCMAKE),)
  ifneq ($(shell find "$(NCMAKE)" -mmin +$(NCMAKE_TTL_MIN) 2>/dev/null),)
    $(shell curl -fsSL --etag-compare "$(NCMAKE).etag" --etag-save "$(NCMAKE).etag" "$(ncmake_url)" -o "$(NCMAKE).new" 2>/dev/null; \
      if [ -s "$(NCMAKE).new" ]; then mv "$(NCMAKE).new" "$(NCMAKE)"; else rm -f "$(NCMAKE).new"; fi; touch "$(NCMAKE)")
  endif
endif

# == Developer modules ==
# Optional target packs live in the ncmake repo under mk/ and are fetched into
# the per-machine cache via 'make dev-init' - a user who only builds and
# installs an app never sees their targets. Cached next to the core Makefile
# and refreshed with the same TTL mechanism; included at the END of this file
# so module help:: sections print after the core help.
ncmake_cache   := $(if $(NCMAKE),$(patsubst %/,%,$(dir $(NCMAKE))),$(if $(XDG_CACHE_HOME),$(XDG_CACHE_HOME),$(HOME)/.cache)/ncmake)
ncmake_modules := $(wildcard $(ncmake_cache)/*.mk-$(ncmake_ref))
ifneq ($(ncmake_modules),)
  ifneq ($(shell find $(ncmake_modules) -mmin +$(NCMAKE_TTL_MIN) 2>/dev/null),)
    $(shell for f in $(ncmake_modules); do \
        m=$$(basename "$$f"); m=$${m%-$(ncmake_ref)}; \
        curl -fsSL --etag-compare "$$f.etag" --etag-save "$$f.etag" "$(ncmake_raw)/mk/$$m" -o "$$f.new" 2>/dev/null; \
        if [ -s "$$f.new" ]; then mv "$$f.new" "$$f"; else rm -f "$$f.new"; fi; touch "$$f"; done)
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
tarball       = $(dist_dir)/$(app_id)-$(version).tar.gz
# owner/repo from the origin remote (ssh or https) - the changelog link reference
# and the appstore module derive their URLs from it.
gh_slug       = $(shell git remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$$##')
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
# besides php/ext-* and bamarni/composer-bin-plugin, a composer plugin that
# installs tools into vendor-bin/ and nothing the app loads); npm runs when
# package.json has a build script. Both are overridable in ncmake.mk (set to
# empty to skip).
need_composer = $(shell python3 -c 'import json;d=json.load(open("composer.json"));print(1 if [k for k in d.get("require",{}) if k not in ("php","bamarni/composer-bin-plugin") and not k.startswith("ext-")] else "")' 2>/dev/null)
need_npm      = $(shell python3 -c 'import json;d=json.load(open("package.json"));print(1 if "build" in d.get("scripts",{}) else "")' 2>/dev/null)
# .gitignore classifies the outputs: an ignored js/ or vendor/ is a build
# artifact that must be built before shipping; a committed one (apps that ship
# built js/ in git) makes a fresh checkout dist-ready. git check-ignore applies
# the full .gitignore semantics.
# The trailing slash matters: it makes directory-only patterns like "/js/" match
# even while the directory does not exist yet (fresh checkout before the build).
js_ignored     = $(shell git check-ignore -q js/ 2>/dev/null && echo 1)
vendor_ignored = $(shell git check-ignore -q vendor/ 2>/dev/null && echo 1)
# The app's own post-install-cmd runs with the install: it is where an app moves
# dependencies into a prefixed namespace under lib/Vendor.
php_build_cmd  ?= $(if $(need_composer),composer install --no-dev --prefer-dist --no-progress)
# Composer resolves against every extension the build runtime loads, so a locked
# package that conflicts with one the image carries but nothing requires (as
# symfony/cache does with ext-redis < 6.1) would fail the build. The extensions
# that neither composer.json nor a locked package requires are ignored instead.
php_unrequired_ext = php -r "\$$r = []; foreach ([\"composer.json\", \"composer.lock\"] as \$$f) { \$$j = json_decode((string) @file_get_contents(\$$f), true) ?: []; \$$r += \$$j[\"platform\"] ?? []; foreach (array_merge([\$$j], \$$j[\"packages\"] ?? [], \$$j[\"packages-dev\"] ?? []) as \$$p) { \$$r += \$$p[\"require\"] ?? []; } } \$$x = []; foreach (get_loaded_extensions() as \$$e) { \$$n = \"ext-\" . str_replace(\" \", \"-\", strtolower(\$$e)); if (!isset(\$$r[\$$n])) { \$$x[] = \$$n; } } echo implode(\",\", \$$x);"
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
no_runtime   = sh -c 'echo >&2; echo "ERROR: no container runtime found (podman/docker). Install podman: apt-get install podman, or use RUNTIME=bare to build on the host." >&2; echo >&2; exit 1'
# Two container images, picked per task, both maintained upstream (nothing to build here):
#   php_image      - the Nextcloud CI image for the declared min-version, fully tooled
#                    (composer, git, unzip). 'make build' uses it so dependencies resolve
#                    against the support floor, which is what package-correct output needs;
#                    its frozen patch level does not matter for shipping runtime deps.
#   analysis_image - the official composer image: always the newest PHP patch plus composer,
#                    git and unzip. Everything interactive (composer, psalm) runs here, where
#                    a current runtime matters - psalm needs a recent patch - while the
#                    analysed PHP level stays pinned through psalm.xml, so the image's fixed
#                    PHP version does not affect the result.
# The Node image comes from package.json's engines.node.
# An info.xml without <php> still has a PHP floor: the one its oldest declared server
# refuses to run below. Each server states it in its own lib/versioncheck.php, read
# here from its stable branch, or from master for a major that has none yet.
nc_server_raw = https://raw.githubusercontent.com/nextcloud/server
php_declared  = $(shell xmllint --xpath 'string(//dependencies/php/@min-version)' appinfo/info.xml 2>/dev/null || grep -oPm1 '(?<=<php min-version=")[^"]+' appinfo/info.xml 2>/dev/null)
nc_min        = $(firstword $(subst ., ,$(shell xmllint --xpath 'string(//dependencies/nextcloud/@min-version)' appinfo/info.xml 2>/dev/null || grep -oPm1 '(?<=<nextcloud min-version=")[^"]+' appinfo/info.xml 2>/dev/null)))
nc_php_floor  = $(shell { curl -fsSL "$(nc_server_raw)/stable$(1)/lib/versioncheck.php" 2>/dev/null || curl -fsSL "$(nc_server_raw)/master/lib/versioncheck.php" 2>/dev/null; } | sed -n 's/.*PHP_VERSION_ID < \([0-9]*\).*/\1/p' | head -1 | awk '{ printf "%d.%d", $$1 / 10000, $$1 % 10000 / 100 }')
# The CI images are tagged by major and minor, so a declared "8" means 8.0 and a
# patch level is dropped.
php_major_minor = $(if $(1),$(word 1,$(subst ., ,$(1))).$(or $(word 2,$(subst ., ,$(1))),0))
php_min       = $(or $(call php_major_minor,$(php_declared)),$(call nc_php_floor,$(nc_min)),$(error No PHP floor: appinfo/info.xml declares no php min-version and lib/versioncheck.php of Nextcloud $(nc_min) could not be read))
node_major  = $(shell python3 -c 'import json,re;print(re.search(r"[0-9]+", json.load(open("package.json"))["engines"]["node"]).group())' 2>/dev/null)
php_image      ?= ghcr.io/nextcloud/continuous-integration-php$(php_min):latest
analysis_image ?= docker.io/library/composer:2
node_image     ?= node:$(or $(node_major),lts)
reuse_image    ?= docker.io/fsfe/reuse:latest
# PHP picks the image per task: max (default) runs on analysis_image, the newest tooled
# runtime, right for dev tools and psalm; min runs on php_image, the support floor, for
# package-correct dependency resolution. 'make build' sets PHP=min itself; add PHP=min to
# any command to resolve against the floor instead.
PHP ?= max
active_php_image = $(if $(filter min,$(PHP)),$(php_image),$(analysis_image))

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
  php_run   = $(container) -e COMPOSER_HOME=/tmp/composer -e COMPOSER_ALLOW_SUPERUSER=1 $(active_php_image) sh -lc
  node_run  = $(container) -e npm_config_cache=/tmp/.npm $(node_image) sh -lc
  reuse_run = $(container) $(reuse_image)
endif

.PHONY: all version changelog tag stable-branch build check-app check-build stage dist rsync cp composer npm reuse psalm \
        clean dist-clean self-update dev-init dev-clean help

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
	@test -n "$(app_id)" || { echo >&2; echo "ERROR: no <id> found in appinfo/info.xml - run make from a Nextcloud app root." >&2; echo >&2; exit 1; }

# == Release versioning (maintainer only) ==

# Open the next release (maintainer only - needs repo write access). Runs from main or from a
# stable* maintenance branch, explains itself, and warns when a manifest description drifts
# from the info.xml summary (the single source of truth - absent description fields are fine
# and never warned about).
# Prompts + validates the version (empty = abort): greater than the newest tag reachable from
# HEAD, so each release line counts only its own tags; on stable* also the same major.minor;
# and no existing tag anywhere. Then branches off into ncmake/release/X.Y.Z (branches created
# by ncmake carry the ncmake/ prefix), records the branch it started from as ncmake-base in the
# git config of the release branch, and commits the bump there: info.xml/composer.json/
# package.json plus the re-synced lockfiles (via RUNTIME). The base branch is protected, so the
# bump lands through that branch and a PR, not a direct push. Fill the CHANGELOG on the branch;
# after the PR is merged, run 'make tag' on the base branch.
version: check-app
	@cur=$$(git rev-parse --abbrev-ref HEAD 2>/dev/null); \
	case "$$cur" in main|stable*) ;; *) echo "make version must run on 'main' or a 'stable*' branch (you are on '$$cur')." >&2; exit 1;; esac; \
	echo "Maintainer target: opens a release branch with the version bump for a PR"; \
	echo "($$cur is protected, no direct push); after the merge you tag it with 'make tag'."; \
	latest=$$(git tag --list 'v*' --merged HEAD --sort=-v:refname | head -1 | sed 's/^v//'); \
	latest=$${latest:-0.0.0}; \
	printf 'New version (latest tag on %s: %s, empty = abort): ' "$$cur" "$$latest"; read new; \
	[ -z "$$new" ] && { echo "Aborted."; exit 0; }; \
	echo "$$new" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "Not a X.Y.Z version: $$new" >&2; exit 1; }; \
	git rev-parse --verify --quiet "refs/tags/v$$new" >/dev/null && { echo "Tag v$$new already exists - pick another version." >&2; exit 1; }; \
	high=$$(printf '%s\n%s\n' "$$latest" "$$new" | sort -V | tail -1); \
	if [ "$$new" = "$$latest" ] || [ "$$high" != "$$new" ]; then echo "Version $$new must be greater than the latest tag $$latest on $$cur" >&2; exit 1; fi; \
	case "$$cur" in stable*) [ "$${new%.*}" = "$${latest%.*}" ] || { echo "On $$cur the version must stay at $${latest%.*}.x - a new minor or major belongs on main." >&2; exit 1; };; esac; \
	branch="ncmake/release/$$new"; \
	git rev-parse --verify --quiet "refs/heads/$$branch" >/dev/null && { echo "Branch $$branch already exists - delete it or pick another version." >&2; exit 1; }; \
	git checkout -b "$$branch" || exit 1; \
	git config "branch.$$branch.ncmake-base" "$$cur"; \
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
	echo "    Open a PR against $$cur and merge it; afterwards on $$cur: git pull && make tag"

# Generate the '## [X.Y.Z]' CHANGELOG section for the current info.xml version
# from the conventional commits since the newest tag reachable from HEAD
# (git-cliff via npx, in the node container). --use-branch-tags keeps the tags
# of other release lines out, since --unreleased alone starts at the newest tag
# of the whole repository. The section is inserted above the previous release, followed
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
	base=$$(git config "branch.$$(git rev-parse --abbrev-ref HEAD).ncmake-base" 2>/dev/null || echo main); \
	since=$$(git tag --list 'v*' --merged HEAD --sort=-v:refname | head -1); \
	echo "==> Generating changelog for $$ver from commits since $${since:-the first commit} ($(RUNTIME))..."; \
	$(node_run) "git config --global --add safe.directory /app 2>/dev/null; npx --yes git-cliff@2 --config $$cfg --unreleased --use-branch-tags --tag v$$ver --strip all" > "$(cache_dir)/changelog_new.md" || { echo "git-cliff failed" >&2; exit 1; }; \
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
		echo "    Open a PR against $$base and merge it; afterwards on $$base: git pull && make tag"; \
	else \
		echo "      git add CHANGELOG.md && git commit -s -m 'build(release): update changelog for $$ver'"; \
	fi

# Freeze the current HEAD as a signed release tag. Everything that belongs in the
# release must already be committed (CHANGELOG and all content). Refuses to re-tag.
# The tag message: the release subject, plus whatever tag_hook appends below it.
# It is written to the build cache because the hook runs between the confirmation
# and the tag, and has to be able to add to it.
tag_message = $(cache_dir)/tag-message

# Runs after the confirmation and before the tag is created, and may append lines
# to $(tag_message). Empty unless a module installs a step here; only one module
# can hold it.
tag_hook ?= :

tag: check-app
	@ver="$(version)"; \
	git rev-parse --verify --quiet "refs/tags/v$$ver" >/dev/null && { echo "Tag v$$ver already exists - run 'make version' first" >&2; exit 1; }; \
	latest=$$(git tag --list 'v*' --merged HEAD --sort=-v:refname | head -1 | sed 's/^v//'); \
	latest=$${latest:-0.0.0}; \
	high=$$(printf '%s\n%s\n' "$$latest" "$$ver" | sort -V | tail -1); \
	if [ "$$ver" = "$$latest" ] || [ "$$high" != "$$ver" ]; then echo "info.xml version $$ver is not greater than the latest tag $$latest on this branch - run 'make version' first" >&2; exit 1; fi; \
	if [ -n "$$(git status --porcelain)" ]; then \
		echo "ERROR: the working tree is not clean, untracked files included - the release is packed from the checkout, so anything only this machine has would reach the tarball and nothing else." >&2; \
		git status --short >&2; exit 1; \
	fi; \
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
		mkdir -p "$(cache_dir)"; printf 'Release %s\n' "$$ver" > "$(tag_message)"; \
		$(tag_hook) || exit 1; \
		git tag -s "v$$ver" -F "$(tag_message)" && git push origin "v$$ver" || exit 1; \
		case "$$(git rev-parse --abbrev-ref HEAD)" in stable*) \
			echo "==> v$$ver belongs to a maintenance line: when you publish its GitHub release,"; \
			echo "    untick 'Set as the latest release', or GitHub shows it above the newer line on main.";; \
		esac; \
	else \
		echo "Aborted. To do it manually:"; \
		echo "  git tag -s v$$ver -m \"Release $$ver\" && git push origin v$$ver"; \
	fi

# Open a stable* maintenance branch for an older release line (maintainer only). Runs on main
# with no uncommitted changes. Lists the release lines that exist as tags, prompts for one
# (empty = abort) and validates it: it has a tag, it is older than the current line of main,
# and stableX.Y exists neither locally nor on origin. The branch starts at the newest tag of
# the line, never at main. Before it is created, the Nextcloud and PHP ranges at that tag are
# shown next to those of main, with a note when the line still reaches into the Nextcloud
# versions main covers. After confirmation it creates and pushes the branch and prints what
# comes next. Stale remote branches are pruned in a fetch of their own: --prune together with
# --tags would also delete local tags that origin does not have.
stable-branch: check-app
	@cur=$$(git rev-parse --abbrev-ref HEAD 2>/dev/null); \
	[ "$$cur" = main ] || { echo "make stable-branch must run on 'main' (you are on '$$cur')." >&2; exit 1; }; \
	if [ -n "$$(git status --porcelain --untracked-files=no)" ]; then \
		echo "ERROR: uncommitted changes would move to the new branch - commit or stash them first." >&2; \
		git status --short --untracked-files=no >&2; exit 1; \
	fi; \
	echo "Maintainer target: opens a stable* branch for an older release line, which then"; \
	echo "gets its own releases through make version, make changelog and make tag."; \
	{ git fetch --quiet --prune origin && git fetch --quiet --tags origin; } || { echo "ERROR: git fetch from origin failed (network?)" >&2; exit 1; }; \
	current=$$(git tag --list 'v*' --merged HEAD --sort=-v:refname | head -1 | sed 's/^v//'); \
	[ -n "$$current" ] || { echo "No release tag on main yet - there is no older line to maintain." >&2; exit 1; }; \
	cline=$${current%.*}; \
	newest=$$(git tag --list 'v[0-9]*' --sort=-v:refname | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$$' | awk -F. '!seen[$$1 "." $$2]++'); \
	echo "Release lines (newest tag):"; \
	for t in $$newest; do \
		l=$${t%.*}; note=""; \
		[ "$$l" = "$$cline" ] && note="current line on main"; \
		git rev-parse --verify --quiet "refs/remotes/origin/stable$$l" >/dev/null && note="stable$$l exists"; \
		printf '  %-8s v%-10s %s\n' "$$l" "$$t" "$$note"; \
	done; \
	suggest=$$(for t in $$newest; do echo "$${t%.*}"; done | grep -vxF "$$cline" | head -1); \
	printf 'Release line to maintain (X.Y%s, empty = abort): ' "$${suggest:+, e.g. $$suggest}"; read line; \
	[ -z "$$line" ] && { echo "Aborted."; exit 0; }; \
	echo "$$line" | grep -qE '^[0-9]+\.[0-9]+$$' || { echo "Not a X.Y release line: $$line" >&2; exit 1; }; \
	base=$$(git tag --list "v$$line.*" --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$$' | head -1); \
	[ -n "$$base" ] || { echo "There is no tag v$$line.x - no release line $$line to maintain." >&2; exit 1; }; \
	[ "$$line" = "$$cline" ] && { echo "$$line is the current line on main and is released from there." >&2; exit 1; }; \
	older=$$(printf '%s\n%s\n' "$$line" "$$cline" | sort -V | head -1); \
	[ "$$older" = "$$line" ] || { echo "$$line is newer than the current line $$cline on main." >&2; exit 1; }; \
	branch="stable$$line"; \
	git rev-parse --verify --quiet "refs/heads/$$branch" >/dev/null && { echo "Branch $$branch already exists locally: git switch $$branch" >&2; exit 1; }; \
	git ls-remote --exit-code --heads origin "$$branch" >/dev/null 2>&1; rc=$$?; \
	[ "$$rc" = 0 ] && { echo "Branch $$branch already exists on origin: git switch $$branch" >&2; exit 1; }; \
	[ "$$rc" = 2 ] || { echo "ERROR: could not query origin for $$branch (network?)" >&2; exit 1; }; \
	deps='import sys, xml.etree.ElementTree as E; d = E.parse(sys.stdin).getroot().find("dependencies"); g = lambda t, a: (d.find(t).get(a) if d is not None and d.find(t) is not None else None) or "-"; print(g("nextcloud", "min-version"), g("nextcloud", "max-version"), g("php", "min-version"), g("php", "max-version"))'; \
	set -- $$(git show "$$base:appinfo/info.xml" | python3 -c "$$deps" 2>/dev/null); lnmin=$${1:--}; lnmax=$${2:--}; lpmin=$${3:--}; lpmax=$${4:--}; \
	set -- $$(git show "HEAD:appinfo/info.xml" | python3 -c "$$deps" 2>/dev/null); mnmin=$${1:--}; mnmax=$${2:--}; mpmin=$${3:--}; mpmax=$${4:--}; \
	echo "==> $$branch starts at $$base, the newest tag of the line (not at main)."; \
	printf '    %-10s %-14s %s\n' "" "Nextcloud" "PHP" "$$base" "$$lnmin - $$lnmax" "$$lpmin - $$lpmax" "main" "$$mnmin - $$mnmax" "$$mpmin - $$mpmax"; \
	case "$$mnmin" in [0-9]*) \
		cap=$$(( $${mnmin%%.*} - 1 )); \
		case "$$lnmax" in [0-9]*) over=$$([ "$${lnmax%%.*}" -gt "$$cap" ] && echo 1);; *) over=1;; esac; \
		if [ -n "$$over" ]; then \
			echo "Note: main requires Nextcloud $${mnmin%%.*}, so $$line usually ends at $$cap. Set max-version=\"$$cap\""; \
			echo "      on <nextcloud> in appinfo/info.xml with the first PR against $$branch."; \
		fi;; \
	esac; \
	printf 'Create %s from %s and push it to origin? [y/N] ' "$$branch" "$$base"; read yn; \
	if [ "$$yn" != y ] && [ "$$yn" != Y ]; then \
		echo "Aborted. To do it manually:"; \
		echo "  git switch -c $$branch $$base && git push -u origin $$branch"; exit 0; \
	fi; \
	git switch -c "$$branch" "$$base" || exit 1; \
	git push -u origin "$$branch" || exit 1; \
	echo "==> $$branch is on origin and checked out. Next:"; \
	echo "    - Protect it like main: $(if $(gh_slug),https://github.com/$(gh_slug)/settings/rules,in the repository settings)"; \
	echo "    - Changes reach $$branch through PRs against it. A backport:"; \
	echo "        git switch -c <branch> $$branch && git cherry-pick -x <commit>"; \
	echo "      -x records the original commit in the message."; \
	echo "    - Release from it: on $$branch, make version, make changelog, make tag. When you"; \
	echo "      publish the GitHub release, untick 'Set as the latest release'."; \
	echo "    - The workflows on $$branch stay as they were at $$base; comment and scheduled"; \
	echo "      events run the workflows of the default branch. A workflow main gained later,"; \
	echo "      for example one whose check your rules require, comes over on $$branch with:"; \
	echo "        make workflows-install W=<name> PR=1"

# == Build ==

# Build the app's dependencies and frontend. What runs is auto-detected (see the
# build heuristics at the top) and routed to its container via RUNTIME. PHP=min so
# packaging resolves dependencies against the declared support floor.
build: PHP := min
build: check-app
	@echo "==> Building via RUNTIME=$(RUNTIME)"
	@if [ -n "$(php_build_cmd)" ]; then \
		echo "+ $(php_build_cmd)"; \
		$(php_run) 'export COMPOSER_IGNORE_PLATFORM_REQ="$$($(php_unrequired_ext))"; $(php_build_cmd)' || exit 1; \
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
	@test -n "$(ARGS)" || { echo >&2; echo "Usage: make composer ARGS=\"<composer arguments>\"" >&2; echo >&2; exit 1; }
	@echo "==> composer $(ARGS) (RUNTIME=$(RUNTIME))"
	@$(php_run) 'composer $(ARGS)'

# Static analysis. Runs 'composer psalm' on analysis_image (the current composer image)
# because psalm needs a recent runtime, while the analysed PHP level stays pinned through
# psalm.xml. PHP=max is the default, but pin it here so the target is independent of it.
# ARGS is forwarded to psalm past composer's own options (composer psalm -- ...), so
# flags like --show-info=true reach psalm instead of being eaten by composer.
# Install the dev tools first: make composer ARGS=install - the recipe guards this
# and aborts with that hint when psalm is not present yet.
psalm: PHP := max
psalm: check-app
	@test -e vendor/bin/psalm || { echo >&2; echo "ERROR: dev tools not installed - run 'make composer ARGS=install' first." >&2; echo >&2; exit 1; }
	@echo "==> psalm ($(active_php_image), RUNTIME=$(RUNTIME))"
	@$(php_run) 'composer psalm $(if $(strip $(ARGS)),-- $(ARGS))'

npm: check-app
	@test -n "$(ARGS)" || { echo >&2; echo "Usage: make npm ARGS=\"<npm arguments>\"" >&2; echo >&2; exit 1; }
	@echo "==> npm $(ARGS) (RUNTIME=$(RUNTIME))"
	@$(node_run) 'npm $(ARGS)'

# REUSE compliance check (https://reuse.software) with the official fsfe/reuse
# container image; RUNTIME=bare expects the reuse tool on the host. ARGS is
# forwarded to reuse lint, e.g. --json for a machine-readable report.
reuse: check-app
	@echo "==> reuse lint (RUNTIME=$(RUNTIME))"
	@$(reuse_run) lint $(ARGS)

# Abort (do not ship a broken file set) when a build output is missing. Only
# gitignored outputs are demanded: a committed js/ or vendor/ ships as-is.
check-build:
	@if [ -n "$(need_npm)" ] && [ -n "$(js_ignored)" ] && { [ ! -d js ] || [ -z "$$(ls -A js 2>/dev/null)" ]; }; then \
		echo >&2; echo "ERROR: js/ is missing or empty - run 'make build' first." >&2; echo >&2; exit 1; \
	fi
	@if [ -n "$(need_composer)" ] && [ -n "$(vendor_ignored)" ] && [ ! -f vendor/autoload.php ]; then \
		echo >&2; echo "ERROR: vendor/autoload.php is missing - run 'make build' first." >&2; echo >&2; exit 1; \
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
	@test -n "$(TARGET)" || { echo >&2; echo "Usage: make rsync TARGET=<apps-dir | user@host:apps-dir> [OCC=1]" >&2; echo >&2; exit 1; }
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
	@test -n "$(ENGINE)" || { echo >&2; echo "ERROR: no container CLI found (docker/podman)." >&2; echo >&2; exit 1; }
	@t="$(TARGET)"; c="$${t%%:*}"; d="$${t#*:}"; \
	if [ -z "$$t" ] || [ "$$c" = "$$t" ] || [ -z "$$c" ] || [ -z "$$d" ]; then \
		echo >&2; echo "Usage: make cp TARGET=<container>:<apps-dir> [OCC=1]" >&2; echo >&2; exit 1; \
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

# Fetch the optional developer modules (mk/*.mk in the ncmake repo) into the
# per-machine cache. Discovery is dynamic: whatever modules the repo ships for
# the selected NCMAKE_REF is what lands here, so new modules appear without
# touching this file. The modules load on every subsequent make run, in every
# app on this machine; 'make dev-clean' removes them again (the plain user view).
# Listing them is the one call that goes to the API rather than to raw: anonymous
# it allows 60 requests per hour and counts them per source IP, which on a hosted
# CI runner is shared with every other job on that machine and answers 403 every
# so often. GITHUB_TOKEN or GH_TOKEN, where the environment offers one, raises
# that to 5000; a workstation usually has neither and does not need one.
dev-init:
	@mkdir -p "$(ncmake_cache)"
	@echo "==> Fetching ncmake developer modules ($(ncmake_ref))..."
	@tok="$${GITHUB_TOKEN:-$$GH_TOKEN}"; \
	set -- -fsSL -H 'User-Agent: ncmake'; \
	test -z "$$tok" || set -- "$$@" -H "Authorization: Bearer $$tok"; \
	names=$$(curl "$$@" "https://api.github.com/repos/ernolf/ncmake/contents/mk?ref=$(ncmake_ref)" \
		| python3 -c 'import json,sys; [print(e["name"]) for e in json.load(sys.stdin) if e["name"].endswith(".mk")]' 2>/dev/null) \
		|| { echo "ERROR: could not list the ncmake modules (network? ref '$(ncmake_ref)'?)" >&2; exit 1; }; \
	test -n "$$names" || { echo "(no modules published for $(ncmake_ref))"; exit 0; }; \
	for m in $$names; do \
		curl -fsSL "$(ncmake_raw)/mk/$$m" -o "$(ncmake_cache)/$$m-$(ncmake_ref)" \
			|| { echo "ERROR: could not fetch module $$m" >&2; exit 1; }; \
		echo "  module: $$m"; \
	done; \
	echo "==> Done. 'make help' now includes the module targets (all apps on this machine)."

# Remove the developer modules from the cache - back to the plain user target set.
# The analyser libraries the modules fetched beside themselves go too, in lib-<ref>
# and loose in the cache root: nothing mounts them once the targets are gone.
dev-clean:
	@rm -f $(ncmake_cache)/*.mk-$(ncmake_ref) $(ncmake_cache)/*.mk-$(ncmake_ref).etag
	@rm -rf "$(ncmake_lib_dir)"
	@rm -f $(ncmake_cache)/*-$(ncmake_ref).mjs $(ncmake_cache)/*-$(ncmake_ref).mjs.etag
	@echo "Developer modules removed ($(ncmake_cache), ref $(ncmake_ref))."

# == Per-target help ==
# `make help-<target>` prints the extended help below (examples, options); a
# target without one falls back to a pointer to `make help`. Printed via $(info)
# so multi-line text needs no shell quoting.
define help_build
make build

Builds the PHP dependencies and the frontend, each in a throwaway container, so
the host needs neither PHP nor Node. What runs is detected from your files:
  composer install --no-dev    when composer.json declares runtime requirements
  npm ci && npm run build      when package.json has a build script
Composer ignores the PHP extensions the build image loads but neither
composer.json nor a locked package requires, so the build fails only on what the
app requires. A side that does not apply is skipped; override in ncmake.mk (php_build_cmd,
node_build_cmd). RUNTIME= selects the container (podman, docker, docker-rootless,
bare).

  make build
  make dist-clean && make build     reproducible from-scratch build
endef

define help_composer
make composer ARGS="<composer arguments>"

Runs any composer command in a throwaway container, so no composer or PHP is
needed on the host. It uses analysis_image by default (the official composer
image: newest PHP plus composer, git and unzip), which is what dev tools such as
psalm need. Add PHP=min to run on php_image instead, the min-version build image,
to resolve dependencies against the support floor.

Examples:
  make composer ARGS=install               all deps including dev tools
  make composer ARGS="install --no-dev"    runtime deps only
  make composer ARGS="cs:check"            run a composer script
  make composer ARGS="require --dev vimeo/psalm"
  make composer ARGS=update                refresh composer.lock
  make composer ARGS="install --no-dev" PHP=min   resolve against the floor
endef

define help_psalm
make psalm [ARGS="<psalm arguments>"]

Runs static analysis (composer psalm) in a throwaway container on analysis_image
(the official composer image: newest PHP plus composer, git and unzip), so no PHP
is needed on the host. The runtime is modern enough for current psalm, while the
analysed PHP level stays pinned via psalm.xml. Install the dev tools first with
make composer ARGS=install.

ARGS is forwarded to psalm past composer's own options (composer psalm -- <args>),
so flags like --show-info=true reach psalm instead of being eaten by composer.

  make composer ARGS=install             install the dev tools (incl. psalm), then:
  make psalm                             analyse
  make psalm ARGS="--show-info=true"     also list info-level findings
  make psalm ARGS=--stats                print analysis statistics
endef

define help_npm
make npm ARGS="<npm arguments>"

Runs any npm command in the throwaway Node container; no Node on the host. The
image comes from engines.node in package.json.

Examples:
  make npm ARGS=ci                   install from package-lock.json
  make npm ARGS="run build"          build the frontend into js/
  make npm ARGS="run dev"            watch and rebuild during development
  make npm ARGS="run test"           run the frontend tests
  make npm ARGS="install -D vitest"  add a dev dependency
endef

define help_reuse
make reuse [ARGS="<reuse lint arguments>"]

Runs the REUSE compliance check (reuse.software) in the fsfe/reuse container:
every file must carry a license, via an SPDX header or a REUSE.toml annotation.
RUNTIME=bare expects the reuse tool on the host. ARGS is forwarded to reuse lint.

  make reuse                 check
  make reuse ARGS=--json     the report as JSON
endef

define help_dist
make dist

Materializes the shipped file set (keep model + .nextcloudignore) into
build/stage/<app_id>/ and packs build/artifacts/dist/<app_id>-<version>.tar.gz.
The same staged tree is what make rsync and make cp deploy, so a test deploy is
byte-for-byte what a release ships. Run make build first if the app has build
outputs (vendor/, js/).
endef

define help_rsync
make rsync TARGET=<apps-dir> [OCC=1]

Deploys the shipped file set into a Nextcloud apps/ directory with rsync
(--delete, so removed files disappear too). Run make build first. TARGET is the
apps/ PARENT directory; the app subdir is appended automatically. It may be local
or remote:
  make rsync TARGET=/var/www/nextcloud/apps
  make rsync TARGET=deploy@host:/var/www/nextcloud/apps

OCC=1 wraps the sync into occ app:disable, chown to web_user, occ app:enable, so
info.xml is re-read and migrations run:
  make build && make rsync TARGET=/var/www/nextcloud/apps OCC=1

web_user defaults to www-data. Without OCC=1 only the rsync happens and the
finishing commands are printed for copy and paste.
endef

define help_cp
make cp TARGET=<container>:<apps-dir> [OCC=1]

Deploys the shipped file set into a RUNNING container whose filesystem rsync
cannot reach from outside, e.g. Nextcloud All-in-One (docker cp syntax; the app
subdir is appended and replaced as a whole).

  make build && make cp TARGET=nextcloud-aio-nextcloud:/var/www/html/custom_apps OCC=1

ENGINE=docker|podman picks the container CLI, independent of RUNTIME (the build
may use podman while the instance runs under docker). OCC=1 runs the full
disable/chown/enable cycle inside the container.
endef

define help_version
make version    (maintainer, on main or a stable* branch)

Prompts for the new version and validates it: greater than the newest tag
reachable from the current branch, on a stable* branch also the same
major.minor, and no tag of that name anywhere. Branches off into
ncmake/release/X.Y.Z and commits the bump there (info.xml,
composer.json/package.json and the re-synced lockfiles). Then run make changelog,
push the branch and open a PR against the branch you started from. RUNTIME=
selects the container for the lockfile sync.
endef

define help_changelog
make changelog    (maintainer, on the release branch)

Generates the "## [X.Y.Z]" CHANGELOG section from the conventional commits since
the newest tag reachable from HEAD (feat to Added, fix to Fixed, perf to Changed; build/ci/test/chore/
docs/refactor/style, merges and Transifex bot commits are skipped) and inserts it
with its link reference. Prints the exact commit command: while the version bump
is still unpushed it folds in via git commit --amend --no-edit (one commit per
release). Rerunning is safe; an app-provided cliff.toml overrides the built-in
config.
endef

define help_tag
make tag    (maintainer, on main or the stable* branch after the merge)

Refuses to re-tag, refuses a working tree that is not clean (untracked files
included - the release is packed from the checkout), refuses when CHANGELOG.md
has no "## [X.Y.Z]" section, then creates and pushes the signed vX.Y.Z tag after
confirmation. Publishing the release triggers the release workflow, which
attaches the tarball asset. A release from a stable* branch must not be marked
as the latest release on GitHub; make tag reminds of it.

Between the confirmation and the tag, $$(tag_hook) may add lines to the tag
message; the integrity module installs its signature step there.
endef

define help_stable-branch
make stable-branch    (maintainer, on main)

Opens a stable* maintenance branch for an older release line, e.g. stable0.7
while main is at 0.8. Lists the release lines from the tags and prompts for one
(X.Y). Refuses a line without a tag, the current line of main, a newer one, and
a stableX.Y that exists locally or on origin. The branch starts at the newest
tag of the line, not at main. Before it is created, the Nextcloud and PHP ranges
at that tag are shown next to those of main, with a note when the line still
reaches into the Nextcloud versions main covers. After confirmation it creates
and pushes the branch and prints the next steps: protection, backports through
PRs against the branch, releases with make version, make changelog, make tag,
and workflows main gained later (make workflows-install on the branch).
endef

define help_dev-init
make dev-init    (maintainer, once per machine)

Fetches the optional ncmake developer modules (mk/*.mk in the ncmake repo: the
App Store management, the CI workflow manager, ...) into the per-machine cache.
Their targets appear in every ncmake app on this machine from the next make run
on; the module list is discovered from the repo, so new modules arrive without
a core update. The cache refreshes with the same TTL mechanism as the core
Makefile. make dev-clean removes the modules again.
endef

define help_dev-clean
make dev-clean

Removes the fetched developer modules from the per-machine cache, and with them
the analyser libraries those modules fetched - make help shows the plain user
target set again. make dev-init brings them back.
endef

define help_self-update
make self-update

Fetches the newest ncmake Makefile over the current one (the per-machine cache in
stub mode, the committed copy otherwise) and drops the ETag so the next run
revalidates.
endef

help-%:
	@:$(info $(or $(help_$*),No extended help for "$*". Run "make help" for the target list and "make help-<target>" for another target.))

# Show available targets and required files. Double-colon so the developer
# modules can append their own sections; the footer is a second help:: rule
# after the module include, keeping it last.
help::
	@echo "$(cd)Usage: make <target>    (no target = this help)$(c0)"
	@echo ""
	@echo "$(ch)Release versioning (maintainer only):$(c0)"
	@echo "  $(ct)version$(c0)              Open a release branch with the version bump for a PR (prompts)  $(cm)[m]$(c0)"
	@echo "  $(ct)changelog$(c0)            Generate the '## [version]' CHANGELOG section from the commits  $(cm)[m]$(c0)"
	@echo "  $(ct)tag$(c0)                  Tag the release commit on main or stable*, signed, and push it  $(cm)[m]$(c0)"
	@echo "  $(ct)stable-branch$(c0)        Open a stable* maintenance branch for an older release line     $(cm)[m]$(c0)"
	@echo ""
	@echo "  $(cd)Container runtime for 'version' (lockfile sync) and 'build': $(c0)$(cv)RUNTIME=...$(c0)$(cd) (now: $(RUNTIME))$(c0)"
	@echo "    $(cd)podman | docker | docker-rootless | bare   (auto-detected, podman preferred)$(c0)"
	@echo ""
	@echo "$(ch)Build:$(c0)"
	@echo "  $(ct)build$(c0)                Build PHP deps + frontend (auto-detected from composer.json/package.json)"
	@echo "  $(ct)composer$(c0) $(cv)ARGS=...$(c0)    Run any composer command in the throwaway PHP container"
	@echo "  $(ct)npm$(c0) $(cv)ARGS=...$(c0)         Run any npm command in the throwaway Node container"
	@echo "  $(ct)psalm$(c0) $(cv)[ARGS=...]$(c0)     Run static analysis (composer psalm) on the current composer image"
	@echo "  $(ct)reuse$(c0)                Run the REUSE compliance check in the fsfe/reuse container"
	@echo "  $(ct)dist$(c0)                 Build the distribution tarball from the shipped file set"
	@echo "                       $(cd)→ $(tarball)$(c0)"
	@echo ""
	@echo "  $(cd)PHP image per task: build on the min-version, composer/psalm on the current composer image ($(cv)PHP=min|max$(c0)$(cd)).$(c0)"
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
	@echo "$(ch)Utility:$(c0)"
	@echo "  $(ct)clean$(c0)                Remove build/ directory (incl. stage and cache)"
	@echo "  $(ct)dist-clean$(c0)           Remove ALL git-ignored build outputs (vendor, node_modules, js, …)"
	@echo "  $(ct)self-update$(c0)          Fetch the newest ncmake Makefile"
	@echo "  $(ct)dev-init$(c0)             Fetch the ncmake developer modules (App Store, CI workflows, ...)  $(cm)[m]$(c0)"
	@echo "  $(ct)dev-clean$(c0)            Remove the developer modules again"
	@echo "  $(ct)help$(c0)                 Show this help"
	@echo ""
	@echo "  $(cm)[m]$(c0) $(cd)= maintainer only (needs repo write access and/or the signing key/cert)$(c0)"

# == Module include ==
# Fetched by 'make dev-init', absent for plain users. Included here, after all
# core rules, so module help:: sections print between the core help and the
# footer below, and modules may extend core variables.
-include $(ncmake_modules)

# == Analyser libraries ==
# A module whose target runs a Node analyser fetches it from lib/ in the ncmake
# repo, and everything around that is the same for all of them: one per-reference
# directory in the per-machine cache - one, because a shared module is imported by
# the file next to it - fetched and refreshed exactly like the modules themselves,
# and mounted read-only into the throwaway Node container. So it lives here and a
# module only states which files the goals on this command line need, by appending
# them to ncmake_libs. That declaration is what this section works on, which is why
# it stands after the module include.
ncmake_lib_dir = $(ncmake_cache)/lib-$(ncmake_ref)

# Fetched on first use, then refreshed on the same TTL and ETag terms as this file
# and the modules: unchanged or offline keeps the cached copy. The list is empty
# unless an analyser is among the goals, so no other target in any app ever pays
# for a network round trip.
ifneq ($(strip $(ncmake_libs)),)
  $(shell mkdir -p "$(ncmake_lib_dir)"; for f in $(sort $(ncmake_libs)); do t="$(ncmake_lib_dir)/$$f"; u="$(ncmake_raw)/lib/$$f"; if [ ! -s "$$t" ]; then curl -fsSL "$$u" -o "$$t" 2>/dev/null; test -s "$$t" || rm -f "$$t"; elif [ -n "$$(find "$$t" -mmin +$(NCMAKE_TTL_MIN) 2>/dev/null)" ]; then curl -fsSL --etag-compare "$$t.etag" --etag-save "$$t.etag" "$$u" -o "$$t.new" 2>/dev/null; if [ -s "$$t.new" ]; then mv "$$t.new" "$$t"; else rm -f "$$t.new"; fi; touch "$$t"; fi; done)
endif

# The first fetch fails silently on a machine that is offline, so a target states
# what is missing instead of letting node report a path: $(call ncmake_lib_need,
# <files>) as its first recipe line.
ncmake_lib_need = for f in $(1); do test -s "$(ncmake_lib_dir)/$$f" || { echo "ERROR: could not fetch $(ncmake_raw)/lib/$$f - network?" >&2; exit 1; }; done

# The library directory is mounted at /ncmake, read-only, alongside the app at
# /app, and gets the writable npm cache every other npm call here gets: an
# analyser that builds runs npm, and the container user has no home of its own.
# With RUNTIME=bare there is no container and the host path is used as it is; with
# no runtime at all $(node_run) carries the "install podman" abort.
ifeq ($(filter $(RUNTIME),bare none),)
  ncmake_lib_run  = $(container) -v "$(ncmake_lib_dir)":/ncmake:ro -e npm_config_cache=/tmp/.npm $(node_image) sh -lc
  ncmake_lib_path = /ncmake
else
  ncmake_lib_run  = $(node_run)
  ncmake_lib_path = $(ncmake_lib_dir)
endif

help::
	@echo ""
	@echo "  $(cd)Details on one target:$(c0) $(ct)make help-<target>$(c0)   $(cd)(e.g. make help-rsync)$(c0)"
	@echo ""
	@echo "$(cd)Current:$(c0) $(if $(app_id),$(cv)$(app_id) v$(version)$(c0),$(cd)(not inside a Nextcloud app)$(c0))"
	@echo "$(cd)ncmake:  $(this_ncmake)$(c0)"
	@echo "$(cd)modules: $(if $(ncmake_modules),$(notdir $(ncmake_modules)),(none - 'make dev-init' fetches the developer targets))$(c0)"
