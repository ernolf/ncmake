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
# $(call info_xml,<path below info>,<attribute or empty>,<pattern>) reads one value.
# xmllint is preferred but not always present (e.g. minimal CI runners); python3's
# ElementTree, which ncmake needs anyway, stands in for it. Both parse the XML, so an
# <id> inside a comment is never taken for the real one, as it was by a plain grep.
# Only a value that matches the pattern as a whole comes back: nothing read from
# info.xml can carry shell syntax into a recipe.
info_xml      = $(shell { xmllint --xpath 'string(/info/$(1)$(if $(2),/@$(2)))' appinfo/info.xml 2>/dev/null || python3 -c 'import sys, xml.etree.ElementTree as E; e = E.parse("appinfo/info.xml").getroot().find(sys.argv[1]); v = None if e is None else (e.get(sys.argv[2]) if len(sys.argv) > 2 else e.text); print((v or "").strip())' $(1) $(2) 2>/dev/null; } | grep -xE '$(3)')
app_id        = $(call info_xml,id,,[a-z][a-z0-9_]*[a-z0-9])
version       = $(call info_xml,version,,[0-9A-Za-z.+-]+)
dist_dir      = $(CURDIR)/build/artifacts/dist
stage_dir     = $(CURDIR)/build/stage
cache_dir     = $(CURDIR)/build/cache
tarball       = $(dist_dir)/$(app_id)-$(version).tar.gz
# owner/repo from the origin remote (ssh or https) - the changelog link reference
# and the appstore module derive their URLs from it.
gh_slug       = $(shell git remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$$##')
# Where skill-install puts the skill file for an AI coding assistant. The default is
# the per-user location Claude Code reads; another assistant, or a skill scoped to
# one repository (.claude/skills/ncmake), sets it in ncmake.mk or on the command line.
skill_dir    ?= $(HOME)/.claude/skills/ncmake
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
# composer/ holds the autoloader the server loads in place of its PSR-4 fallback
# for lib/ (see need_composer).
keep_dirs     = appinfo lib l10n templates img css js vendor composer LICENSES
# CHANGELOG.<code>.md is a translated changelog, which the App Store reads next to
# CHANGELOG.md; make changelog-lint names a file whose code it does not know.
keep_files    = CHANGELOG.md CHANGELOG.*.md AUTHORS AUTHORS.md REUSE.toml COPYING COPYING.md LICENSE LICENSE.md
# A kept file takes its REUSE sidecar <file>.license along, so the tarball states
# the license of every file it carries.
keep_existing = $(wildcard $(keep_dirs) $(keep_files) $(keep_extra) $(addsuffix .license,$(keep_files) $(keep_extra)))
# Optional excludes WITHIN the shipped set come from .nextcloudignore (the
# ecosystem convention; rsync exclude syntax: anchored /path, dir/, wildcards).
stage_excludes = $(if $(wildcard .nextcloudignore),--exclude-from=.nextcloudignore)

# == Build heuristics ==
# composer runs when composer.json declares real runtime requirements (anything
# besides php/ext-* and bamarni/composer-bin-plugin, a composer plugin that
# installs tools into vendor-bin/ and nothing the app loads); npm runs when
# package.json has a build script. Both are overridable in ncmake.mk (set to
# empty to skip).
# composer runs as well when the app has composer/autoload.php: the server loads
# it instead of its PSR-4 fallback for lib/, and it requires vendor/autoload.php,
# which only the composer step writes, even for an app that requires nothing.
need_composer = $(if $(wildcard composer/autoload.php),1,$(shell python3 -c 'import json;d=json.load(open("composer.json"));print(1 if [k for k in d.get("require",{}) if k not in ("php","bamarni/composer-bin-plugin") and not k.startswith("ext-")] else "")' 2>/dev/null))
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
# The reverse case stops it as well: a required extension the image lacks (the CI
# images ship neither bcmath nor soap). Installing the dependencies does not load
# it, the server that runs the app does, so it is ignored too, and named.
php_ignored_ext = php -r "\$$r = []; foreach ([\"composer.json\", \"composer.lock\"] as \$$f) { \$$j = json_decode((string) @file_get_contents(\$$f), true) ?: []; \$$r += \$$j[\"platform\"] ?? []; foreach (array_merge([\$$j], \$$j[\"packages\"] ?? [], \$$j[\"packages-dev\"] ?? []) as \$$p) { \$$r += \$$p[\"require\"] ?? []; } } \$$r = array_change_key_case(\$$r); \$$l = []; foreach (get_loaded_extensions() as \$$e) { \$$l[\"ext-\" . str_replace(\" \", \"-\", strtolower(\$$e))] = true; } \$$m = array_values(array_filter(array_keys(array_diff_key(\$$r, \$$l)), fn(\$$n) => strncmp(\$$n, \"ext-\", 4) === 0)); if (\$$m) { fwrite(STDERR, \"composer: ignoring \" . implode(\", \", \$$m) . \" - required, but missing from the build image\" . PHP_EOL); } echo implode(\",\", array_merge(array_keys(array_diff_key(\$$l, \$$r)), \$$m));"
# The lock file names the package manager, and installing from it is what makes
# the frontend build reproducible; npm-shrinkwrap.json wins over package-lock.json,
# as in npm. Without a lock file the dependencies are resolved anew: the build
# still runs, with npm install, and says that it is not reproducible.
# yarn.lock tells the two yarn lines apart: Yarn 2 and later write a __metadata
# block and take --immutable, Yarn 1 writes "yarn lockfile v1" and takes
# --frozen-lockfile.
node_lock      = $(firstword $(wildcard npm-shrinkwrap.json package-lock.json pnpm-lock.yaml yarn.lock))
node_pm        = $(if $(filter pnpm-lock.yaml,$(node_lock)),pnpm,$(if $(filter yarn.lock,$(node_lock)),yarn,npm))
yarn_frozen    = $(if $(shell grep -q '^__metadata:' yarn.lock 2>/dev/null && echo 1),--immutable,--frozen-lockfile)
node_install   = $(if $(filter pnpm,$(node_pm)),pnpm install --frozen-lockfile,$(if $(filter yarn,$(node_pm)),yarn install $(yarn_frozen),$(if $(node_lock),npm ci,npm install)))
node_build_cmd ?= $(if $(need_npm),$(node_install) && $(node_pm) run build)
# pnpm and yarn come through corepack, in the version the packageManager field of
# package.json names. Node 25 and later no longer ship corepack, so there it is
# installed from npm first. The shims go to a directory on PATH, where a script
# that calls pnpm or yarn itself finds them too. AUTO_PIN=0 keeps corepack from
# writing a packageManager field into the app's package.json.
node_pm_prefix = /tmp/.node-pm
node_pm_setup  = $(if $(filter pnpm yarn,$(node_pm)),export PATH=$(node_pm_prefix)/bin:$$PATH COREPACK_ENABLE_AUTO_PIN=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0; { command -v corepack >/dev/null || npm install --global --prefix $(node_pm_prefix) corepack; } && corepack enable --install-directory $(node_pm_prefix)/bin $(node_pm) && )

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
#   php_image      - the Nextcloud CI image for the PHP floor (php_min), fully tooled
#                    (composer, git, unzip). 'make build' uses it so dependencies resolve
#                    against the support floor, which is what package-correct output needs;
#                    its frozen patch level does not matter for shipping runtime deps.
#   analysis_image - the official composer image: always the newest PHP patch plus composer,
#                    git and unzip. Everything interactive (composer, psalm) runs here, where
#                    a current runtime matters - psalm needs a recent patch - while the
#                    analysed PHP level stays pinned through psalm.xml, so the image's fixed
#                    PHP version does not affect the result.
# The Node image comes from package.json's engines.node, see node_major.
# An info.xml without <php> still has a PHP floor: the one its oldest declared server
# refuses to run below. Each server states it in its own lib/versioncheck.php, read
# here from its stable branch, or from master for a major that has none yet.
nc_server_raw = https://raw.githubusercontent.com/nextcloud/server
php_declared  = $(call info_xml,dependencies/php,min-version,[0-9.]+)
nc_min        = $(firstword $(subst ., ,$(call info_xml,dependencies/nextcloud,min-version,[0-9.]+)))
nc_php_floor  = $(shell { curl -fsSL "$(nc_server_raw)/stable$(1)/lib/versioncheck.php" 2>/dev/null || curl -fsSL "$(nc_server_raw)/master/lib/versioncheck.php" 2>/dev/null; } | sed -n 's/.*PHP_VERSION_ID < \([0-9]*\).*/\1/p' | head -1 | awk '{ printf "%d.%d", $$1 / 10000, $$1 % 10000 / 100 }')
# The CI images are tagged by major and minor, so a declared "8" means 8.0 and a
# patch level is dropped.
php_major_minor = $(if $(1),$(word 1,$(subst ., ,$(1))).$(or $(word 2,$(subst ., ,$(1))),0))
php_app       = $(or $(call php_major_minor,$(php_declared)),$(call nc_php_floor,$(nc_min)))
# The floor never drops below the one of the newest end-of-life Nextcloud major,
# whatever the app declares: an app in the App Store supports current servers, none
# of which runs on an older PHP, and the older CI images carry tools that no longer
# resolve current dependencies (php8.0 ships Composer 1). That major is the first
# row under "EOL Versions" in the server's Maintenance and Release Schedule;
# nc_eol_fallback stands in when the page cannot be read.
nc_schedule_url = https://raw.githubusercontent.com/wiki/nextcloud/server/Maintenance-and-Release-Schedule.md
nc_eol_fallback = 32
nc_eol        = $(or $(shell curl -fsSL "$(nc_schedule_url)" 2>/dev/null | sed -n '/^## EOL Versions/,$$ s/^| \*\*\([0-9]*\)\*\*.*/\1/p' | head -1),$(nc_eol_fallback))
php_eol_floor = $(call nc_php_floor,$(nc_eol))
php_min       = $(or $(lastword $(shell printf '%s\n' $(php_app) $(php_eol_floor) | sort -V)),$(error No PHP floor: neither appinfo/info.xml nor lib/versioncheck.php of Nextcloud $(nc_min) and $(nc_eol) gave one))
# The build Node is the newest LTS line that engines.node allows and that is not
# end of life by the Node.js release schedule: an open range such as >=18 is a
# floor, not the version to build on. When no LTS line fits, the newest current
# line that does; when only end-of-life lines fit, the newest of them, with a
# warning. Without engines.node the image is node:lts. When the schedule cannot be
# read, node_schedule_fallback stands in, a snapshot of it from 2026-10.
node_schedule_url      = https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
node_schedule_fallback = {"v20":{"lts":"2023-10-24","end":"2026-04-30"},"v22":{"lts":"2024-10-29","end":"2027-04-30"},"v24":{"lts":"2025-10-28","end":"2028-04-30"},"v26":{"lts":"2026-10-28","end":"2029-04-30"}}
node_pick   = $(if $(wildcard package.json),$(shell { curl -fsSL "$(node_schedule_url)" 2>/dev/null || echo '$(node_schedule_fallback)'; } | python3 -c 'import json,re,sys,datetime; r=re.sub(r"([<>=^~]+)\s+",r"\1",re.sub(r"(\S+)\s+-\s+(\S+)",r">=\1 <=\2",str(json.load(open("package.json")).get("engines",{}).get("node","")).strip())); s=json.load(sys.stdin); t=datetime.date.today().isoformat(); I=(1e9,0,0); P=lambda x:[int(n) for n in re.match(r"[v=]*([0-9.]*)",x).group(1).split(".") if n][:3]; pad=lambda p:tuple((p+[0,0,0])[:3]); up=lambda p:pad(p[:-1]+[p[-1]+1]) if p else I; C=lambda o,p:{"^":(pad(p),up(p[:1])),"~":(pad(p),up(p[:2])),">=":(pad(p),I),">":(up(p),I),"<":((0,0,0),pad(p)),"<=":((0,0,0),up(p))}.get(o,(pad(p),up(p))); ok=lambda M:any(all(max(lo,(M,0,0))<min(hi,(M+1,0,0)) for lo,hi in (C(m.group(1),P(m.group(2))) for m in (re.match(r"([<>]=?|[\^~]?)(.*)",c) for c in a.split()))) for a in r.split("||")); M=sorted((int(k[1:]) for k in s if re.fullmatch(r"v[0-9]+",k)),reverse=True); live=lambda m:s["v"+str(m)].get("end","")>t; lts=lambda m:s["v"+str(m)].get("lts","9")<=t; c=[m for m in M if ok(m) and live(m) and lts(m)] or [m for m in M if ok(m) and live(m)]; x=c[:1] or [m for m in M if ok(m)][:1]; print(" ".join([str(x[0])]+([] if c else ["eol"])) if r and x else "")' 2>/dev/null))
node_major  = $(call node_major_of,$(node_pick))
node_major_of = $(if $(filter eol,$(1)),$(warning engines.node in package.json allows only end-of-life Node lines - building on Node $(firstword $(1))))$(firstword $(1))
php_image      ?= ghcr.io/nextcloud/continuous-integration-php$(php_min):latest
analysis_image ?= docker.io/library/composer:2
node_image     ?= docker.io/library/node:$(or $(node_major),lts)
# The ncmake analysers that only read run here, whatever Node the app declares.
lib_node_image ?= docker.io/library/node:lts
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
  container_cli = podman
  container     = podman run --rm --label ncmake -v "$(CURDIR)":/app -w /app
else ifeq ($(RUNTIME),docker-rootless)
  container_cli = docker
  container     = docker run --rm --label ncmake -v "$(CURDIR)":/app -w /app
else ifeq ($(RUNTIME),docker)
  container_cli = docker
  container     = docker run --rm --label ncmake --user $(shell id -u):$(shell id -g) -v "$(CURDIR)":/app -w /app
else
  $(error Unknown RUNTIME '$(RUNTIME)'. Use: podman | docker | docker-rootless | bare)
endif

# == Container images ==
# podman and docker run an image as it lies once it is on the host, so a moving tag
# such as :latest or node:lts would stay at the day of its first pull. Before a
# container starts, image_prep pulls its image again when the last check is older
# than IMAGE_CHECK_MIN minutes, and removes the image that pull superseded at once:
# it has lost its tag and would otherwise stay on the host for good. rmi without -f
# leaves an image that a container still uses or another tag still names.
# The image record keeps one line per image: CLI, reference, image ID, whether ncmake
# pulled it (1) or found it on the host (0), and the last use and the last check in
# epoch seconds. Every message goes to stderr, so a target whose stdout is captured,
# such as an analyser with ARGS=--json, gets nothing but its own output. A failed
# pull is no error here: the container run that follows reports what is missing.
# The reference names the image, not the registry it comes from. image_sources lists
# the registries that serve each image, tried in order, so that a rate limit or an
# outage of one leaves the next; the image is then tagged with its reference and the
# source's name dropped, so the host, the image record and make image-clean see one name
# whatever served it. The list is data in the ncmake repo, fetched into the cache when
# a pull first needs it and refreshed on the same TTL and ETag terms as this file, so
# a new mirror needs no ncmake update. IMAGE_SOURCES names a list of one's own, which
# is used as it is.
# The record is state, not cache: deleting the cache must not turn the images ncmake
# pulled into foreign ones that no clean-up touches again. It lives beside the image
# store it describes, which depends on who runs the CLI, so image_rec_fn asks the CLI
# and recfile names the file per CLI. A rootless store (podman run by a user, rootless
# docker) has one record per user under XDG_STATE_HOME. A store for the whole host
# (podman run by root, rootful docker) has one under /var/lib, which root creates
# itself. A member of the docker group needs sudo once for it: recfile asks where a
# record is written, in image_prep, with a terminal and outside CI, and creates the
# directory group-writable and setgid on yes. On no, or without a terminal, the record
# stays in the user's file and the sudo command is shown; while that file holds a line
# for the CLI, nobody is asked again, until make image-setup asks on request. Once the
# directory is writable, the CLI's lines move there from the user's file. A record in
# the shared directory is written group-writable, so every member keeps it current.
IMAGE_CHECK_MIN ?= 1440
image_state_sys  = /var/lib/ncmake
image_state_user = $(or $(XDG_STATE_HOME),$(HOME)/.local/state)/ncmake
image_rec_fn = sys="$(image_state_sys)" usr="$(image_state_user)"; \
	share() { [ "$${1%/*}" != "$$sys" ] || chmod 664 "$$1"; }; \
	recfile() { \
		if [ "$$1" = podman ]; then r=$$(podman info --format "{{.Host.Security.Rootless}}" 2>/dev/null); \
			[ -n "$$r" ] || { [ "$$(id -u)" = 0 ] && r=false || r=true; }; \
		else case "$$(docker info --format "{{.SecurityOptions}}" 2>/dev/null)" in *rootless*) r=true ;; *) r=false ;; esac; fi; \
		[ "$$r" != true ] || { echo "$$usr/images.txt"; return 0; }; \
		[ -d "$$sys" ] || [ "$$(id -u)" != 0 ] || mkdir -p "$$sys"; \
		if [ ! -w "$$sys" ] && [ "$$1" = docker ] && [ -n "$$2" ] && \
		   { [ "$$2" = again ] || ! grep -q "^$$1 " "$$usr/images.txt" 2>/dev/null; }; then \
			if [ -t 0 ] && [ -z "$(CI)" ]; then \
				printf "==> Keep the record of the images ncmake pulls for docker in %s, shared by the docker group? It needs sudo once. [y/N] " "$$sys" >&2; \
				read -r a || a=; case "$$a" in [yY]*) sudo install -d -m 2775 -g docker "$$sys" >&2 ;; esac; \
			fi; \
			[ -w "$$sys" ] || echo "==> The record of the images ncmake pulls for docker stays in $$usr/images.txt. To share it: sudo install -d -m 2775 -g docker $$sys, or make image-setup" >&2; \
		fi; \
		[ -w "$$sys" ] || { echo "$$usr/images.txt"; return 0; }; \
		if grep -q "^$$1 " "$$usr/images.txt" 2>/dev/null && t=$$(mktemp "$$sys/images.txt.XXXXXX"); then share "$$t"; \
			if { cat "$$sys/images.txt" 2>/dev/null; grep "^$$1 " "$$usr/images.txt"; } >"$$t" && mv -f "$$t" "$$sys/images.txt"; then \
				grep -v "^$$1 " "$$usr/images.txt" >"$$usr/images.txt.new"; \
				if [ -s "$$usr/images.txt.new" ]; then mv -f "$$usr/images.txt.new" "$$usr/images.txt"; else rm -f "$$usr/images.txt.new" "$$usr/images.txt"; fi; \
			else rm -f "$$t"; fi; \
		fi; \
		echo "$$sys/images.txt"; \
	};
image_sources    = $(or $(IMAGE_SOURCES),$(ncmake_cache)/image-sources-$(ncmake_ref))
image_sources_url = $(if $(IMAGE_SOURCES),,$(ncmake_raw)/core/image-sources)
image_prep = sh -c ' \
	cli=$$1 ref=$$2 list=$$3 url=$$4 now=$$(date +%s) own= checked=0; \
	$(image_rec_fn) rec=$$(recfile "$$cli" ask); \
	if [ -f "$$rec" ]; then while read -r c r i o u k; do \
		if [ "$$c" = "$$cli" ] && [ "$$r" = "$$ref" ]; then own=$$o checked=$$k; fi; done <"$$rec"; fi; \
	case "$$checked" in ""|*[!0-9]*) checked=0 ;; esac; \
	sources() { \
		if [ -n "$$url" ]; then mkdir -p "$${list%/*}"; \
			if [ ! -s "$$list" ]; then curl -fsSL "$$url" -o "$$list" 2>/dev/null; [ -s "$$list" ] || rm -f "$$list"; \
			elif [ -n "$$(find "$$list" -mmin +$(NCMAKE_TTL_MIN) 2>/dev/null)" ]; then \
				curl -fsSL --etag-compare "$$list.etag" --etag-save "$$list.etag" "$$url" -o "$$list.new" 2>/dev/null; \
				if [ -s "$$list.new" ]; then mv "$$list.new" "$$list"; else rm -f "$$list.new"; fi; touch "$$list"; \
			fi; \
		fi; \
		srcs= best=; \
		if [ -f "$$list" ]; then while read -r pre alt; do \
			case "$$ref" in "$$pre"*) ;; *) continue ;; esac; \
			case "$$pre" in "$$best"*) [ "$$pre" != "$$best" ] || continue ;; *) continue ;; esac; \
			best=$$pre srcs= rest=$$(printf "%s\n" "$$ref" | cut -c "$$(($$(printf %s "$$pre" | wc -c) + 1))-"); \
			for a in $$alt; do srcs="$$srcs $$a$$rest"; done; \
		done <"$$list"; fi; \
		case " $$srcs " in *" $$ref "*) ;; *) srcs="$$srcs $$ref" ;; esac; \
	}; \
	pull() { \
		sources; err=; t=$$(mktemp) || return 1; \
		for s in $$srcs; do \
			if [ "$$1" = quiet ]; then "$$cli" pull -q "$$s" >"$$t" 2>&1 </dev/null; rc=$$?; \
			else echo "==> Pulling $$s ($$cli)" >&2; \
				{ "$$cli" pull "$$s" 2>&1 </dev/null; echo $$? >"$$t.rc"; } | tee "$$t" >&2; rc=$$(cat "$$t.rc" 2>/dev/null); fi; \
			if [ "$$rc" = 0 ]; then \
				[ "$$s" = "$$ref" ] || { "$$cli" tag "$$s" "$$ref" && \
					if [ "$$cli" = podman ]; then podman untag "$$ref" "$$s"; else docker rmi "$$s"; fi; } >/dev/null 2>&1; \
				rm -f "$$t" "$$t.rc"; return 0; \
			fi; \
			err="$$err$$(printf "\n    %s: %s" "$$s" "$$(grep . "$$t" | tail -n 1)")"; \
		done; \
		rm -f "$$t" "$$t.rc"; return 1; \
	}; \
	old=$$("$$cli" image inspect --format "{{.Id}}" "$$ref" 2>/dev/null); new=$$old; \
	if [ -z "$$old" ]; then \
		own=1; \
		if pull; then checked=$$now; else echo "==> No source could pull $$ref ($$cli):$$err" >&2; fi; \
		new=$$("$$cli" image inspect --format "{{.Id}}" "$$ref" 2>/dev/null); \
	else \
		own=$${own:-0}; \
		if [ $$((now - checked)) -ge $$(($(IMAGE_CHECK_MIN) * 60)) ] && pull quiet; then \
			checked=$$now; new=$$("$$cli" image inspect --format "{{.Id}}" "$$ref" 2>/dev/null); \
			if [ -n "$$new" ] && [ "$$new" != "$$old" ]; then \
				if "$$cli" rmi "$$old" >/dev/null 2>&1; then echo "==> $$ref updated, the superseded image is removed" >&2; \
				else echo "==> $$ref updated, the superseded image stays: a container uses it or another tag names it" >&2; fi; \
			fi; \
		fi; \
	fi; \
	[ -n "$$new" ] || exit 0; \
	mkdir -p "$${rec%/*}" && tmp=$$(mktemp "$$rec.XXXXXX") || exit 0; share "$$tmp"; \
	{ if [ -f "$$rec" ]; then while read -r c r i o u k; do \
		[ "$$c" = "$$cli" ] && [ "$$r" = "$$ref" ] || echo "$$c $$r $$i $$o $$u $$k"; done <"$$rec"; fi; \
	  echo "$$cli $$ref $$new $$own $$now $$checked"; } >"$$tmp" && mv -f "$$tmp" "$$rec" || rm -f "$$tmp"; \
	exit 0' image-prep
# make image-clean covers every container CLI on the host. ENGINE narrows it to one
# when it comes from the command line or the environment; the ENGINE that ncmake.mk
# sets for make cp names the CLI of a Nextcloud instance, not the images to clean.
image_clis = $(if $(filter-out file default undefined,$(origin ENGINE)),$(ENGINE),$(if $(have_podman),podman) $(if $(have_docker),docker))
# Once no ncmake container has run for this many minutes, the images ncmake pulled
# are removed; OLD=1 of make image-clean uses the same span per image.
IMAGE_IDLE_MIN ?= 10
# Removing the images after every target would pull them again for each step of a
# sequence such as build, psalm, reuse. So every container run writes a token to
# image_stamp and starts a detached waiter, which ignores SIGHUP so that closing the
# terminal does not end it. On waking after IMAGE_IDLE_MIN minutes, a waiter that finds
# another token leaves the work to the waiter of that later run. While a container
# labelled ncmake still runs, it checks once a minute and begins a fresh idle span
# once none does; then it runs make image-clean OWN=1 on its own, without the
# MAKEFLAGS of the run that started it. KEEP=1 and CI still write the token, so the
# waiter of an earlier run stands down, but start none.
image_stamp   = $(ncmake_cache)/last-run
image_engines = $(if $(have_podman),podman) $(if $(have_docker),docker)
# Expanded once here, so that a recipe line which starts a waiter is never taken for a
# recursive make call, whose lines make -n runs instead of printing them.
image_make   := $(MAKE)
image_idle = sh -c ' \
	stamp=$$1 idle=$$(($(IMAGE_IDLE_MIN) * 60)) me=$$(date +%s).$$$$; \
	mkdir -p "$${stamp%/*}" && echo "$$me" >"$$stamp" || exit 0; \
	[ -z "$(KEEP)$(CI)" ] || exit 0; \
	( trap "" HUP; \
	  mine() { [ "$$(cat "$$stamp" 2>/dev/null)" = "$$me" ]; }; \
	  running() { for c in $(image_engines); do "$$c" ps -q --filter label=ncmake 2>/dev/null; done | grep -q .; }; \
	  while :; do \
		sleep $$idle; mine || exit 0; running || break; \
		while running; do sleep 60; mine || exit 0; done; \
	  done; \
	  MAKEFLAGS= MAKELEVEL= $(image_make) -s -f "$$2" -C "$${stamp%/*}" image-clean OWN=1 NCMAKE="$$3" \
	) </dev/null >/dev/null 2>&1 & \
	exit 0' image-idle
# $(call container_run,<image>,<run options>) prepares the image, then starts it. The
# preparation never stands in the way of the run, whatever it runs into.
container_run = { $(image_prep) $(container_cli) '$(1)' '$(image_sources)' '$(image_sources_url)' || :; $(image_idle) '$(image_stamp)' '$(this_ncmake)' '$(NCMAKE)' || :; } && $(container) $(2) $(1)

ifeq ($(filter $(RUNTIME),bare none),)
  php_run   = $(call container_run,$(active_php_image),-e COMPOSER_HOME=/tmp/composer -e COMPOSER_ALLOW_SUPERUSER=1) sh -lc
  node_run  = $(call container_run,$(node_image),-e npm_config_cache=/tmp/.npm -e COREPACK_HOME=/tmp/.corepack) sh -lc
  reuse_run = $(call container_run,$(reuse_image))
endif

.PHONY: all version changelog tag stable-branch build check-app check-build stage dist rsync cp composer npm reuse psalm \
        clean dist-clean image-clean image-setup self-update skill-install dev-init dev-clean help

# == Changelog configuration (git-cliff) ==
# Keep a Changelog sections from Conventional Commits, user-visible changes only:
# feat -> Added, fix -> Fixed, perf -> Changed; build/ci/test/chore/docs/refactor/
# style and merge commits are left out. The daily Transifex bot commits
# (fix(l10n): Update translations...) are skipped too - they would produce piles
# of identical bullets; describe translation updates by hand where they matter.
# An app can ship its own cliff.toml to override all of this; make changelog takes
# the '### <group>' headings and the entries below them from its output and writes
# the version heading itself.
define cliff_config
[changelog]
header = ""
body = """
{% if version -%}
## [{{ version | trim_start_matches(pat="v") }}] - {{ timestamp | date(format="%Y-%m-%d") }}
{% else -%}
## [Unreleased]
{% endif -%}
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

# Writes what git-cliff generated into CHANGELOG.md, in the Keep a Changelog 1.1.0
# layout with two deviations: a link reference stays directly below its section,
# and a group without entries gets no heading. --mode unreleased adds the new
# entries to '## [Unreleased]' (created at the top when missing); --mode release
# moves what is under it, together with the new entries, into '## [<version>]'
# directly below it and leaves the heading. Existing lines are kept word for word,
# so hand-written entries survive and move with the rest. Exit 2 means nothing was
# written, because there was nothing new to write. --entries receives the new
# entries, which become the bullets of the commit.
define changelog_tool
import argparse
import datetime
import re
import sys

# A group Keep a Changelog does not name follows in the order it appears.
KAC_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']
SECTION = re.compile(r'^## ')
UNRELEASED = re.compile(r'^## \[Unreleased\]', re.IGNORECASE)
GROUP = re.compile(r'^### +(.*?) *$$')
LINK_REF = re.compile(r'^\[[^\]]+\]: ')


def strip_blank(lines):
    while lines and not lines[0].strip():
        lines = lines[1:]
    while lines and not lines[-1].strip():
        lines = lines[:-1]
    return lines


def parse(lines):
    intro, groups, refs, group = [], {}, [], None
    for line in lines:
        if LINK_REF.match(line):
            refs.append(line)
            continue
        m = GROUP.match(line)
        if m:
            group = m.group(1)
            groups.setdefault(group, [])
        elif group is None:
            intro.append(line)
        else:
            groups[group].append(line)
    return strip_blank(intro), {g: strip_blank(e) for g, e in groups.items()}, refs


def merge(groups, new):
    merged = {g: list(e) for g, e in groups.items()}
    for g, entries in new.items():
        merged[g] = merged.get(g, []) + entries
    return merged


def render(heading, intro, groups, refs):
    out = [heading, '']
    if intro:
        out += intro + ['']
    order = [g for g in KAC_ORDER if g in groups] + [g for g in groups if g not in KAC_ORDER]
    for g in order:
        if groups[g]:
            out += ['### ' + g, ''] + groups[g] + ['']
    if refs:
        out += refs + ['']
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--mode', choices=('unreleased', 'release'), required=True)
    p.add_argument('--changelog', required=True)
    p.add_argument('--new', required=True)
    p.add_argument('--entries', required=True)
    p.add_argument('--version', default='')
    p.add_argument('--link', default='')
    p.add_argument('--since', default='', help='the pre-release this release follows, if any')
    a = p.parse_args()

    with open(a.new, 'r', encoding='utf-8') as f:
        _, new, _ = parse([line for line in f.read().split('\n') if not SECTION.match(line)])
    new = {g: e for g, e in new.items() if e}
    with open(a.changelog, 'r', encoding='utf-8') as f:
        lines = f.read().split('\n')

    starts = [i for i, line in enumerate(lines) if SECTION.match(line)]
    top = next((i for i in starts if UNRELEASED.match(lines[i])), None)
    if top is None:
        at = starts[0] if starts else len(lines)
        head, body, tail = lines[:at], [], lines[at:]
        head = strip_blank(head) + [''] if strip_blank(head) else []
    else:
        end = next((i for i in starts if i > top), len(lines))
        head, body, tail = lines[:top], lines[top + 1:end], lines[end:]
    intro, groups, refs = parse(body)

    if a.mode == 'unreleased':
        if not new and top is not None:
            return 2
        out = head + render('## [Unreleased]', intro, merge(groups, new), refs) + tail
    else:
        moved = merge(groups, new)
        if not intro and not any(moved.values()):
            if not a.since:
                return 2
            intro = ['No notable changes since %s.' % a.since]
        section = render('## [%s] - %s' % (a.version, datetime.date.today().isoformat()), intro, moved,
                         ['[%s]: %s' % (a.version, a.link)] if a.link else [])
        out = head + render('## [Unreleased]', [], {}, refs) + section + tail

    with open(a.changelog, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
    with open(a.entries, 'w', encoding='utf-8') as f:
        f.write(''.join(e + '\n' for entries in new.values() for e in entries if e.startswith('- ')))
    return 0


sys.exit(main())
endef
export changelog_tool

changelog_run = mkdir -p "$(cache_dir)" && printf '%s\n' "$$changelog_tool" > "$(cache_dir)/ncmake_changelog.py" && python3 "$(cache_dir)/ncmake_changelog.py"

# Pull-request body of make changelog COMMIT=1 / PR=1 below the bullets, unless
# BODY replaces it. Exported for the same reason as the workflow bodies: the
# backticks have to reach the shell as text.
define changelog_pr_body
`make changelog` added these entries to CHANGELOG.md from the conventional commits since its last update. Review the diff and merge.
endef
export changelog_pr_body

# `make` with no target shows the help instead of building anything.
.DEFAULT_GOAL := help

all: dist

# Every functional target needs the app id; help stays runnable anywhere.
check-app:
	@test -n "$(app_id)" || { echo >&2; echo "ERROR: no valid <id> found in appinfo/info.xml - run make from a Nextcloud app root." >&2; echo >&2; exit 1; }

# == Branch, commit and pull request flow ==

# COMMIT / PR / AMEND: without them a target only writes its files and prints how
# to commit them. COMMIT=1 puts the change on a branch of its own and commits it
# without pushing; PR=1 additionally pushes and opens the pull request via gh, and
# implies COMMIT=1. AMEND=1 (make changelog) folds the change into the current,
# unpushed commit instead; with PR=1 it pushes that branch and opens its pull
# request.
COMMIT ?= 0
PR     ?= 0
AMEND  ?= 0
# BODY=<path>: the text under the bullet list of the pull request, read from a file
# because markdown with backticks does not survive a command line.
BODY   ?=

# Shared branch/commit/PR flow for COMMIT=1 / PR=1, as a shell function library
# the targets source (eval) so the git handling lives in one place. What a target
# writes happens between _start and _finish; the target stages it and passes the
# bullets, so a no-op discards cleanly.
# _start refuses to run when the target branch already exists locally or on
# origin, so a stale or in-flight branch fails fast with instructions instead of
# only surfacing as a rejected push after the work is already committed.
# _start sets $base (the branch it starts from) and $branch: on stableX.Y the
# line is appended, so it never collides with an in-flight branch for main.
# The blank line above the rule in the pull request body is load bearing: '---'
# right after a line of text makes that line a heading instead of drawing a rule.
define branch_flow
flow_require_no_remote_branch() {
    branch="$$1"
    if git ls-remote --exit-code --heads origin "$$branch" >/dev/null 2>&1; then
        echo "Remote branch '$$branch' already exists on origin - not committing or pushing." >&2
        echo "It may have an open pull request, or be an already merged branch that was never deleted." >&2
        echo "Inspect it, then merge or close its pull request, or delete the branch:" >&2
        echo "      git push origin --delete $$branch" >&2
        echo "and run this target again." >&2
        return 1
    fi
}
flow_branch_start() {
    base=$$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    case "$$base" in
        main) branch="$$1" ;;
        stable*) branch="$$1-$$base" ;;
        *) echo "COMMIT=1/PR=1 must run on 'main' or a 'stable*' branch (you are on '$$base')." >&2
           return 1 ;;
    esac
    if git rev-parse --verify --quiet "refs/heads/$$branch" >/dev/null; then
        echo "Branch $$branch already exists - delete it (git branch -D $$branch) or push and merge it first." >&2
        return 1
    fi
    flow_require_no_remote_branch "$$branch" || return 1
    git checkout -b "$$branch"
}
flow_branch_abort() {
    git checkout - >/dev/null 2>&1
    git branch -D "$$1" >/dev/null 2>&1
}
flow_pr() {
    branch="$$1"; base="$$2"; title="$$3"; bullets="$$4"; text="$$5"
    if ! command -v gh >/dev/null 2>&1; then
        echo "PR=1 needs the GitHub CLI (gh), which is not installed." >&2
        echo "Install it with 'make gh-install', or push and open the PR yourself:" >&2
        echo "      git push -u origin $$branch" >&2
        return 1
    fi
    if ! gh auth status >/dev/null 2>&1; then
        echo "PR=1 needs an authenticated gh (run 'gh auth login' first)." >&2
        echo "The commit is on '$$branch'; push and open the PR yourself:" >&2
        echo "      git push -u origin $$branch" >&2
        return 1
    fi
    if [ -n "$(BODY)" ]; then
        text=$$(cat "$(BODY)")
    fi
    if [ -z "$$text" ]; then
        body="$$bullets"
    elif [ -z "$$bullets" ]; then
        body="$$text"
    else
        body=$$(printf '%s\n\n---\n\n%s\n' "$$bullets" "$$text")
    fi
    git push -u origin "$$branch" || return 1
    gh pr create --base "$$base" --head "$$branch" --title "$$title" --body "$$body"
}
flow_branch_finish() {
    branch="$$1"; title="$$2"; bullets="$$3"; text="$$4"; pr="$$5"
    if git diff --cached --quiet; then
        echo "==> Nothing to commit - everything is already current. Branch discarded, $$base untouched."
        flow_branch_abort "$$branch"
        return 0
    fi
    if [ -n "$$bullets" ]; then
        printf '%s\n\n%s\n' "$$title" "$$bullets" > "$(cache_dir)/flow_commit_msg"
    else
        printf '%s\n' "$$title" > "$(cache_dir)/flow_commit_msg"
    fi
    git commit -s -F "$(cache_dir)/flow_commit_msg" || { flow_branch_abort "$$branch"; return 1; }
    if [ "$$pr" != "1" ]; then
        echo
        echo "==> Committed on branch $$branch."
        echo "    Amend it if you like (git commit --amend), then push:"
        echo "      git push -u origin $$branch"
        echo "    Then open a pull request and merge it."
        return 0
    fi
    flow_pr "$$branch" "$$base" "$$title" "$$bullets" "$$text"
}
endef
export branch_flow

# == Release versioning (maintainer only) ==

# A pre-release is X.Y.Z with one of the suffixes the Nextcloud release process
# names: X.Y.Z-alpha.N, -beta.N, -rc.N. It is tagged and published like any
# release; the server offers a version with a '-' only to the beta, daily and git
# channels or with --allow-unstable.
prerelease_re = (alpha|beta|rc)\.[0-9]+
# git and sort -V rank 1.2.0-rc.1 above 1.2.0, PHP version_compare (the server
# and the App Store) below it. versionsort.suffix gives git that order, and so
# does a tilde for sort -V, which sorts it before the end of the string.
git_tags     = git -c versionsort.suffix=-alpha -c versionsort.suffix=-beta -c versionsort.suffix=-rc tag
version_sort = sed 's/-/~/' | sort -V | sed 's/~/-/'

# Open the next release (maintainer only - needs repo write access). Runs from main or from a
# stable* maintenance branch, explains itself, and warns when a manifest description drifts
# from the info.xml summary (the single source of truth - absent description fields are fine
# and never warned about).
# Prompts + validates the version (empty = abort): X.Y.Z or a pre-release of it, greater than
# the newest tag reachable from HEAD, so each release line counts only its own tags; on
# stable* also the same major.minor; and no existing tag anywhere. Then branches off into
# ncmake/release/X.Y.Z (branches created by ncmake carry the ncmake/ prefix), records the
# branch it started from as ncmake-base in the git config of the release branch, and commits
# the bump there: info.xml/composer.json/package.json plus the re-synced lockfiles (via
# RUNTIME). The bump reaches the base branch through that branch and a PR. Fill the CHANGELOG
# on the branch; after the PR is merged, run 'make tag' on the base branch.
# What the base branch requires is stated only as far as GitHub confirms it: a branch that is
# not on origin yet, or a ruleset with a pull_request rule. The rules endpoint lists rulesets
# only; classic branch protection shows as "protected" without saying whether it requires a
# PR, and a private repository answers "Not Found" without a token. Both stay unmentioned.
version: check-app
	@cur=$$(git rev-parse --abbrev-ref HEAD 2>/dev/null); \
	case "$$cur" in main|stable*) ;; *) echo "make version must run on 'main' or a 'stable*' branch (you are on '$$cur')." >&2; exit 1;; esac; \
	echo "Maintainer target: opens a release branch with the version bump for a PR against"; \
	echo "$$cur; after the merge you tag it with 'make tag'."; \
	if echo "$(gh_slug)" | grep -qE '^[^/:]+/[^/]+$$'; then \
		tok="$${GITHUB_TOKEN:-$$GH_TOKEN}"; \
		set -- -sS --max-time 10 -H 'User-Agent: ncmake'; \
		test -z "$$tok" || set -- "$$@" -H "Authorization: Bearer $$tok"; \
		api="https://api.github.com/repos/$(gh_slug)"; \
		state=$$(curl "$$@" "$$api/branches/$$cur" 2>/dev/null | python3 -c 'import json,sys; d = json.load(sys.stdin); print("missing" if d.get("message") == "Branch not found" else "found" if "name" in d else "")' 2>/dev/null); \
		case "$$state" in \
		missing) echo "$$cur is not on origin yet: push it (git push -u origin $$cur) before a PR against it is possible.";; \
		found) rules=$$(curl "$$@" "$$api/rules/branches/$$cur" 2>/dev/null | python3 -c 'import json,sys; print(" ".join(r["type"] for r in json.load(sys.stdin)))' 2>/dev/null); \
			case " $$rules " in *" pull_request "*) echo "A ruleset on $$cur requires a pull request: no direct push.";; esac;; \
		esac; \
	fi; \
	latest=$$($(git_tags) --list 'v*' --merged HEAD --sort=-v:refname | head -1 | sed 's/^v//'); \
	latest=$${latest:-0.0.0}; \
	printf 'New version (latest tag on %s: %s, empty = abort): ' "$$cur" "$$latest"; read new; \
	[ -z "$$new" ] && { echo "Aborted."; exit 0; }; \
	echo "$$new" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-$(prerelease_re))?$$' || { echo "Not a X.Y.Z or X.Y.Z-alpha.N/-beta.N/-rc.N version: $$new" >&2; exit 1; }; \
	git rev-parse --verify --quiet "refs/tags/v$$new" >/dev/null && { echo "Tag v$$new already exists - pick another version." >&2; exit 1; }; \
	high=$$(printf '%s\n%s\n' "$$latest" "$$new" | $(version_sort) | tail -1); \
	if [ "$$new" = "$$latest" ] || [ "$$high" != "$$new" ]; then echo "Version $$new must be greater than the latest tag $$latest on $$cur" >&2; exit 1; fi; \
	case "$$cur" in stable*) line=$$(echo "$$latest" | cut -d. -f1,2); [ "$$(echo "$$new" | cut -d. -f1,2)" = "$$line" ] || { echo "On $$cur the version must stay at $$line.x - a new minor or major belongs on main." >&2; exit 1; };; esac; \
	branch="ncmake/release/$$new"; \
	git rev-parse --verify --quiet "refs/heads/$$branch" >/dev/null && { echo "Branch $$branch already exists - delete it or pick another version." >&2; exit 1; }; \
	git checkout -b "$$branch" || exit 1; \
	git config "branch.$$branch.ncmake-base" "$$cur"; \
	sed -i -E "s|<version>[0-9A-Za-z.+-]+</version>|<version>$$new</version>|" appinfo/info.xml; \
	[ -f composer.json ] && sed -i -E "s|(\"version\"[[:space:]]*:[[:space:]]*)\"[0-9A-Za-z.+-]+\"|\1\"$$new\"|" composer.json || true; \
	[ -f package.json ] && sed -i -E "s|(\"version\"[[:space:]]*:[[:space:]]*)\"[0-9A-Za-z.+-]+\"|\1\"$$new\"|" package.json || true; \
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

# Fill CHANGELOG.md from the conventional commits (git-cliff via npx, in the node
# container). Without a pending bump - the info.xml version is the newest tag
# reachable from HEAD - or with UNRELEASED=1, the new entries go under
# '## [Unreleased]'. After make version they go, together with everything under
# '## [Unreleased]', into the '## [X.Y.Z]' section of the info.xml version, followed
# by its '[X.Y.Z]:' link reference to the GitHub release tag; '## [Unreleased]'
# keeps only its heading. A pre-release gets a section of its own, and the release
# after it lists what came since that pre-release; when nothing came, the line
# 'No notable changes since X.Y.Z-rc.N.'.
# Each run takes the commits since the last commit that changed CHANGELOG.md, so
# what an earlier run wrote, and what was written or edited by hand, is kept word
# for word. A CHANGELOG.md with uncommitted changes means the previous run is not
# committed yet: the run stops instead of adding the same commits twice. A commit
# that a tag already holds is never listed (--unreleased), and --use-branch-tags
# keeps the tags of other release lines out. The rest of the file - header,
# preamble and older sections - is never touched. Refuses to duplicate an existing
# version section; reports when there is nothing to document. An app-provided
# cliff.toml overrides the built-in configuration.
changelog: check-app
	@$(if $(BODY),test -r "$(BODY)" || { echo "BODY=$(BODY) is not a readable file" >&2; exit 1; };) \
	ver="$(version)"; amend="$(AMEND)"; commit="$(COMMIT)"; pr="$(PR)"; \
	if [ "$$amend" = 1 ] && [ "$$commit" = 1 ]; then echo "AMEND=1 folds the changelog into the current commit, COMMIT=1 makes a new one - pick one." >&2; exit 1; fi; \
	if [ "$$pr" = 1 ] && [ "$$amend" != 1 ]; then commit=1; fi; \
	test -f CHANGELOG.md || { echo "ERROR: no CHANGELOG.md - create it once (Keep a Changelog header), then rerun." >&2; exit 1; }; \
	git diff --quiet HEAD -- CHANGELOG.md 2>/dev/null || { echo "ERROR: CHANGELOG.md has uncommitted changes - the previous run is not committed yet. Commit or amend it, or discard it (git checkout -- CHANGELOG.md), then rerun." >&2; exit 1; }; \
	latest=$$($(git_tags) --list 'v*' --merged HEAD --sort=-v:refname | head -1 | sed 's/^v//'); \
	if [ "$(UNRELEASED)" = 1 ] || [ "$$ver" = "$$latest" ]; then mode=unreleased; what=Unreleased; else mode=release; what="$$ver"; fi; \
	if [ "$$mode" = release ] && grep -q "^## \[$$ver\]" CHANGELOG.md; then \
		echo "CHANGELOG.md already has a '## [$$ver]' section - nothing to do."; exit 0; \
	fi; \
	if [ "$$amend" = 1 ] && [ -n "$$(git branch -r --contains HEAD 2>/dev/null)" ]; then \
		echo "AMEND=1: $$(git log -1 --format='%h %s') is already pushed - amending it would need a force push. Use COMMIT=1, or commit it yourself." >&2; exit 1; \
	fi; \
	mkdir -p "$(cache_dir)"; \
	eval "$$branch_flow"; \
	base=$$(git config "branch.$$(git rev-parse --abbrev-ref HEAD).ncmake-base" 2>/dev/null || echo main); \
	if [ "$$commit" = 1 ]; then flow_branch_start ncmake/docs/changelog || exit 1; fi; \
	if [ -f cliff.toml ]; then cfg="cliff.toml"; else cfg="build/cache/cliff.toml"; printf '%s\n' "$$cliff_config" > "$$cfg"; fi; \
	last=$$(git log -1 --format=%H -- CHANGELOG.md 2>/dev/null); \
	if [ "$$mode" = release ]; then tagopt="--tag v$$ver"; else tagopt=""; fi; \
	if [ -n "$$last" ]; then since="the last change to CHANGELOG.md ($$(git rev-parse --short $$last))"; else since="the first commit"; fi; \
	echo "==> Generating '## [$$what]' from the untagged commits since $$since ($(RUNTIME))..."; \
	$(node_run) "git config --global --add safe.directory /app 2>/dev/null; npx --yes git-cliff@2 --config $$cfg --unreleased --use-branch-tags $$tagopt --strip all $${last:+$$last..HEAD}" > "$(cache_dir)/changelog_new.md" \
		|| { echo "git-cliff failed" >&2; [ "$$commit" = 1 ] && flow_branch_abort "$$branch"; exit 1; }; \
	pre=""; link=""; \
	if [ "$$mode" = release ]; then \
		echo "$$latest" | grep -qE -- '-$(prerelease_re)$$' && pre="$$latest"; \
		[ -n "$(gh_slug)" ] && link="https://github.com/$(gh_slug)/releases/tag/v$$ver"; \
	fi; \
	$(changelog_run) --mode "$$mode" --changelog CHANGELOG.md --new "$(cache_dir)/changelog_new.md" --entries "$(cache_dir)/changelog_entries" \
		--version "$$ver" --link "$$link" --since "$$pre"; rc=$$?; \
	if [ "$$rc" = 2 ]; then \
		[ "$$commit" = 1 ] && flow_branch_abort "$$branch"; \
		if [ "$$mode" = unreleased ]; then \
			echo "No undocumented user-visible changes since the last change to CHANGELOG.md (only skipped commit types)."; \
		else \
			echo "Nothing under '## [Unreleased]' and no undocumented user-visible changes since the last tag (only skipped commit types)."; \
			echo "Add a hand-written '## [$$ver]' section if this release still warrants an entry (e.g. translation updates)."; \
		fi; \
		exit 0; \
	fi; \
	[ "$$rc" = 0 ] || { echo "Writing CHANGELOG.md failed" >&2; [ "$$commit" = 1 ] && flow_branch_abort "$$branch"; exit 1; }; \
	if [ "$$mode" = release ]; then \
		echo "==> Inserted '## [$$ver]', with what was under '## [Unreleased]', and its link reference into CHANGELOG.md."; \
		title="build(release): update changelog for $$ver"; \
	else \
		if [ -s "$(cache_dir)/changelog_entries" ]; then echo "==> Added the new entries to '## [Unreleased]' in CHANGELOG.md."; \
		else echo "==> Added the '## [Unreleased]' heading to CHANGELOG.md, which had none."; fi; \
		title="docs(changelog): update the unreleased section"; \
	fi; \
	bullets=$$(cat "$(cache_dir)/changelog_entries"); \
	if [ "$$commit" = 1 ]; then \
		git add CHANGELOG.md; \
		flow_branch_finish "$$branch" "$$title" "$$bullets" "$$changelog_pr_body" "$$pr"; exit $$?; \
	fi; \
	cur=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$amend" = 1 ]; then \
		git add CHANGELOG.md && git commit --amend --no-edit || exit 1; \
		echo "==> Folded into $$(git log -1 --format='%h %s')."; \
		if [ "$$pr" = 1 ]; then \
			flow_pr "$$cur" "$$base" "$$(git log -1 --format=%s)" "$$(git log -1 --format=%b | sed '/^Signed-off-by:/d')" ""; exit $$?; \
		fi; \
		echo "    Then:"; \
		echo "      git push -u origin $$cur"; \
		if [ "$$mode" = release ]; then \
			echo "    Open a PR against $$base and merge it; afterwards on $$base: git pull && make tag"; \
		else \
			echo "    Open a PR against $$base and merge it."; \
		fi; \
		exit 0; \
	fi; \
	echo "==> Review and extend it, then commit:"; \
	if [ "$$mode" = release ]; then \
		if [ "$$(git log -1 --pretty=%s 2>/dev/null)" = "build(release): bump version to $$ver" ] \
			&& [ "$$(git rev-parse HEAD 2>/dev/null)" != "$$(git rev-parse @{u} 2>/dev/null)" ]; then \
			echo "      git add CHANGELOG.md && git commit --amend --no-edit"; \
			echo "    which folds the changelog into the unpushed bump commit - one commit per release."; \
			echo "    Then:"; \
			echo "      git push -u origin $$cur"; \
			echo "    Open a PR against $$base and merge it; afterwards on $$base: git pull && make tag"; \
		else \
			echo "      git add CHANGELOG.md && git commit -s -m '$$title'"; \
		fi; \
	else \
		if [ -z "$$(git branch -r --contains HEAD 2>/dev/null)" ]; then \
			echo "      git add CHANGELOG.md && git commit --amend --no-edit"; \
			echo "    which folds it into the commit it describes ($$(git log -1 --format='%h %s')), or on its own:"; \
		fi; \
		echo "      git add CHANGELOG.md && git commit -s -m '$$title'"; \
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

# Checks the changelog before the confirmation and fails the tag when it is not
# ready. The audit module puts changelog-lint here; without it, make tag only
# looks for the heading of this version in CHANGELOG.md, spelled as the App Store
# accepts it. NO_CHANGELOG_LINT=1 skips either, for a release that is meant to go
# out regardless.
tag_check ?= re=$$(printf '%s' '$(version)' | sed 's/[.]/\\./g'); \
	[ ! -f CHANGELOG.md ] || grep -qE "^\#\# \[?v?$$re(\]|[[:space:]]|$$)" CHANGELOG.md || \
	{ echo "ERROR: no '\#\# [$(version)]' section in CHANGELOG.md - run 'make changelog' (and merge it) first." >&2; exit 1; }

tag: check-app
	@ver="$(version)"; \
	git rev-parse --verify --quiet "refs/tags/v$$ver" >/dev/null && { echo "Tag v$$ver already exists - run 'make version' first" >&2; exit 1; }; \
	latest=$$($(git_tags) --list 'v*' --merged HEAD --sort=-v:refname | head -1 | sed 's/^v//'); \
	latest=$${latest:-0.0.0}; \
	high=$$(printf '%s\n%s\n' "$$latest" "$$ver" | $(version_sort) | tail -1); \
	if [ "$$ver" = "$$latest" ] || [ "$$high" != "$$ver" ]; then echo "info.xml version $$ver is not greater than the latest tag $$latest on this branch - run 'make version' first" >&2; exit 1; fi; \
	if [ -n "$$(git status --porcelain)" ]; then \
		echo "ERROR: the working tree is not clean, untracked files included - the release is packed from the checkout, so anything only this machine has would reach the tarball and nothing else." >&2; \
		git status --short >&2; exit 1; \
	fi; \
	if [ "$(NO_CHANGELOG_LINT)" = 1 ]; then \
		echo "==> NO_CHANGELOG_LINT=1: the changelog is not checked."; \
	else \
		$(tag_check) || exit 1; \
	fi; \
	echo "############################################################################"; \
	echo "##  About to create the signed tag v$$ver at the CURRENT commit."; \
	echo "##  EVERYTHING that belongs in this release MUST be committed NOW:"; \
	echo "##  CHANGELOG.md (## [$$ver]) and all release content. A tag is frozen."; \
	echo "############################################################################"; \
	printf 'Create and push the signed tag v%s now? [y/N] ' "$$ver"; read yn; \
	if [ "$$yn" = y ] || [ "$$yn" = Y ]; then \
		mkdir -p "$(cache_dir)"; printf 'Release %s\n' "$$ver" > "$(tag_message)"; \
		$(tag_hook) || exit 1; \
		git tag -s "v$$ver" -F "$(tag_message)" && git push origin "v$$ver" || exit 1; \
		case "$$(git rev-parse --abbrev-ref HEAD)" in stable*) \
			echo "==> v$$ver belongs to a maintenance line: when you publish its GitHub release,"; \
			echo "    untick 'Set as the latest release', or GitHub shows it above the newer line on main.";; \
		esac; \
		case "$$ver" in *-*) \
			echo "==> v$$ver is a pre-release: tick 'Set as a pre-release' when you publish its GitHub"; \
			echo "    release. It goes to the App Store as a regular release, not as a nightly; servers"; \
			echo "    get it only on the beta, daily or git channel or with --allow-unstable.";; \
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
# comes next, for an app with .tx/config including the Transifex sync, which reaches app
# release lines only through .tx/backport on main. Stale remote branches are pruned in a fetch
# of their own: --prune together with --tags would also delete local tags that origin does not
# have.
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
	current=$$($(git_tags) --list 'v*' --merged HEAD --sort=-v:refname | head -1 | sed 's/^v//'); \
	[ -n "$$current" ] || { echo "No release tag on main yet - there is no older line to maintain." >&2; exit 1; }; \
	cline=$$(echo "$$current" | cut -d. -f1,2); \
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
	echo "        make workflows-install W=<name> PR=1"; \
	if git cat-file -e main:.tx/config 2>/dev/null; then \
		echo "    - Transifex: the Nextcloud sync bot only reaches $$branch when .tx/backport on"; \
		echo "      main lists it, and that list replaces the server's stable* names."; \
		if git show main:.tx/backport 2>/dev/null | tr -s ' \t' '\n' | grep -qxF "$$branch"; then \
			echo "      .tx/backport on main already lists $$branch."; \
		else \
			echo "      Add it through a PR against main, one branch per line:"; \
			echo "        git switch -c <branch> main && echo $$branch >> .tx/backport"; \
			if git cat-file -e main:REUSE.toml 2>/dev/null && ! git show main:REUSE.toml 2>/dev/null | grep -qF '.tx/backport'; then \
				echo "      and add .tx/backport next to .tx/config in REUSE.toml."; \
			fi; \
		fi; \
		echo "    - The bot pushes its commits directly: add nextcloud-bot to the bypass list of"; \
		echo "      the rule that protects $$branch, as on main. It needs write access as a"; \
		echo "      collaborator first: $(if $(gh_slug),https://github.com/$(gh_slug)/settings/access,the repository settings)"; \
	fi

# == Build ==

# Build the app's dependencies and frontend. What runs is auto-detected (see the
# build heuristics at the top) and routed to its container via RUNTIME. PHP=min so
# packaging resolves dependencies against the support floor (php_min).
build: PHP := min
build: check-app
	@echo "==> Building via RUNTIME=$(RUNTIME)"
	@if [ -n "$(php_build_cmd)" ]; then \
		app="$(php_app)"; min="$(php_min)"; \
		if [ "$$app" != "$$min" ]; then echo "composer: building on PHP $$min, the floor of Nextcloud $(nc_eol), the newest end-of-life major; the app's own floor is $${app:+PHP $$app}$${app:-unknown}"; fi; \
		echo "+ $(php_build_cmd)"; \
		$(php_run) 'export COMPOSER_IGNORE_PLATFORM_REQ="$$($(php_ignored_ext))"; $(php_build_cmd)' || exit 1; \
	else echo "(composer: nothing to build)"; fi
	@if [ -n "$(node_build_cmd)" ]; then \
		if [ -z "$(node_lock)" ]; then echo "npm: no lock file, so the dependencies are resolved anew and this build is not reproducible" >&2; fi; \
		echo "+ $(node_build_cmd)"; $(node_run) '$(node_pm_setup)$(node_build_cmd)' || exit 1; \
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
# The REUSE Specification requires LICENSES/ of every compliant project, and
# REUSE.toml or the deprecated .reuse/dep5 are the other ways to state licensing.
# An app with none of them never claimed compliance, so linting it would only list
# every file; FORCE=1 lints it anyway.
reuse: check-app
	@echo "==> reuse lint (RUNTIME=$(RUNTIME))"
	@if [ -z "$(FORCE)" ] && [ ! -d LICENSES ] && [ ! -e REUSE.toml ] && [ ! -e .reuse/dep5 ]; then \
		echo "Not set up for REUSE: no LICENSES/, REUSE.toml or .reuse/dep5. FORCE=1 lints it anyway."; \
		exit 1; \
	fi
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

# List the images of every container CLI on the host with their size, when ncmake last
# used them and where they come from, and remove the ones picked: by number at the
# prompt, or by OWN=1 and OLD=1 for scripts. The flags never pick a foreign image or
# one a container uses. rmi runs without -f, so an image that a container uses or
# another tag names stays, whoever picked it. An image is matched to the record of its
# CLI by reference, with docker.io/ and library/ dropped, because podman lists the
# full name where docker lists the short one. A removed image leaves the record, so
# the next run that needs it pulls it as ncmake's own again. The space freed is the
# difference in the CLI's own accounting, which counts a shared layer once.
image-clean:
	@clis="$(image_clis)"; now=$$(date +%s); idle=$$(($(IMAGE_IDLE_MIN) * 60)); $(image_rec_fn) \
	test -n "$$clis" || { echo "No container CLI found (podman/docker), no image to list."; exit 0; }; \
	for cli in $$clis; do command -v "$$cli" >/dev/null || { echo "ERROR: $$cli not found." >&2; exit 1; }; done; \
	norm() { n=$${1#docker.io/}; echo "$${n#library/}"; }; \
	bytes() { "$$1" system df --format "{{.Type}}|{{.Size}}" 2>/dev/null | awk -F"|" '$$1 == "Images" { v = $$2; gsub(/ /, "", v); u = v; sub(/^[0-9.]+/, "", u); m = 1; if (u == "kB" || u == "KB") m = 1e3; else if (u == "MB") m = 1e6; else if (u == "GB") m = 1e9; else if (u == "TB") m = 1e12; printf "%.0f\n", v * m }'; }; \
	age() { [ -n "$$1" ] || return 0; a=$$((now - $$1)); \
		if [ $$a -lt 3600 ]; then echo "$$((a / 60)) min ago"; elif [ $$a -lt 172800 ]; then echo "$$((a / 3600)) h ago"; else echo "$$((a / 86400)) d ago"; fi; }; \
	list=$$(mktemp) || exit 1; trap 'rm -f "$$list"' EXIT; \
	for cli in $$clis; do \
		ids=$$("$$cli" ps -aq 2>/dev/null); used=; rec=$$(recfile "$$cli"); \
		[ -z "$$ids" ] || used=$$("$$cli" container inspect --format "{{.Image}}" $$ids 2>/dev/null | sed "s/^sha256://"); \
		used=" $$(echo $$used) "; \
		"$$cli" images --no-trunc --format "{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}" 2>/dev/null \
		| while IFS="|" read -r id repo tag size; do \
			id=$${id#sha256:}; ref=; own=; last=; \
			[ "$$repo" = "<none>" ] || [ "$$tag" = "<none>" ] || ref=$$repo:$$tag; \
			if [ -n "$$ref" ] && [ -f "$$rec" ]; then key=$$(norm "$$ref"); \
				while read -r c r i o u k; do [ "$$c" = "$$cli" ] && [ "$$(norm "$$r")" = "$$key" ] && own=$$o last=$$u; done <"$$rec"; fi; \
			case "$$used" in *" $$id "*) st="in use" ;; \
			*) if [ "$$own" = 1 ]; then st=ncmake; elif [ -n "$$own" ]; then st=ncmake-used; \
			   elif [ -z "$$ref" ]; then st=dangling; else st=foreign; fi ;; esac; \
			echo "$$cli|$${ref:-$$id}|$${ref:-$$(printf %.12s "$$id")}|$$size|$$last|$$st|$$rec"; \
		done; \
	done >"$$list"; \
	n=$$(wc -l <"$$list"); [ "$$n" -gt 0 ] || { echo "No container images on this host."; exit 0; }; \
	pick=; i=0; \
	printf "%5s  %-6s  %9s  %-11s  %-11s  %s\n" "" CLI size "last used" status image; \
	while IFS="|" read -r cli target name size last st rec; do i=$$((i + 1)); mark=" "; \
		if { [ -n "$(OWN)" ] && [ "$$st" = ncmake ]; } || \
		   { [ -n "$(OLD)" ] && { [ "$$st" = dangling ] || { [ "$$st" = ncmake ] && [ $$((now - $${last:-0})) -ge $$idle ]; }; }; }; then \
			mark="*"; pick="$$pick $$i"; fi; \
		printf "%s%4d  %-6s  %9s  %-11s  %-11s  %s\n" "$$mark" "$$i" "$$cli" "$$size" "$$(age "$$last")" "$$st" "$$name"; \
	done <"$$list"; \
	if [ -z "$(OWN)$(OLD)" ]; then \
		[ -z "$(DRY)" ] && [ -t 0 ] || exit 0; \
		printf "Images to remove (numbers or ranges, e.g. 1 3-5; empty removes nothing): "; read -r ans || ans=; \
		for t in $$(echo "$$ans" | tr "," " "); do \
			case "$$t" in *[!0-9-]*|-*|*-|*-*-*) echo "ERROR: not a number or a range: $$t" >&2; exit 1 ;; esac; \
			a=$${t%-*}; b=$${t#*-}; \
			[ "$$a" -ge 1 ] && [ "$$a" -le "$$b" ] && [ "$$b" -le "$$n" ] || { echo "ERROR: outside 1-$$n: $$t" >&2; exit 1; }; \
			while [ "$$a" -le "$$b" ]; do pick="$$pick $$a"; a=$$((a + 1)); done; \
		done; \
	fi; \
	test -n "$$pick" || { echo "Nothing to remove."; exit 0; }; \
	if [ -n "$(DRY)" ]; then echo "DRY=1: the images marked * would be removed."; exit 0; fi; \
	before=0; for cli in $$clis; do x=$$(bytes "$$cli"); before=$$((before + $${x:-0})); done; \
	i=0; while IFS="|" read -r cli target name size last st rec; do i=$$((i + 1)); \
		case " $$pick " in *" $$i "*) ;; *) continue ;; esac; \
		if err=$$("$$cli" rmi "$$target" 2>&1 >/dev/null </dev/null); then \
			echo "removed  $$cli $$name"; \
			if [ -f "$$rec" ] && tmp=$$(mktemp "$$rec.XXXXXX"); then share "$$tmp"; key=$$(norm "$$target"); \
				while read -r c r i2 o u k; do [ "$$c" = "$$cli" ] && [ "$$(norm "$$r")" = "$$key" ] || echo "$$c $$r $$i2 $$o $$u $$k"; done <"$$rec" >"$$tmp" \
				&& mv -f "$$tmp" "$$rec" || rm -f "$$tmp"; fi; \
		else echo "stays    $$cli $$name: $$(echo "$$err" | head -n 1)"; fi; \
	done <"$$list"; \
	after=0; for cli in $$clis; do x=$$(bytes "$$cli"); after=$$((after + $${x:-0})); done; \
	[ "$$before" -gt 0 ] || exit 0; d=$$((before - after)); [ $$d -ge 0 ] || d=0; \
	echo "Freed: $$(awk -v b=$$d 'BEGIN { if (b >= 1e9) printf "%.2f GB", b / 1e9; else printf "%.0f MB", b / 1e6 }')"

# Show where the image record of each container CLI lives, and for rootful docker
# ask again whether to share it in /var/lib/ncmake, which an earlier no declined.
image-setup:
	@clis="$(image_clis)"; $(image_rec_fn) \
	test -n "$$clis" || { echo "No container CLI found (podman/docker), no image record to set up."; exit 0; }; \
	for cli in $$clis; do echo "$$cli: image record $$(recfile "$$cli" again)"; done

# Fetch the newest ncmake Makefile over this one (the per-machine cache in stub
# mode, the committed copy otherwise).
self-update:
	@curl -fsSL "$(ncmake_url)" -o "$(this_ncmake)" && rm -f "$(this_ncmake).etag" && echo "ncmake updated: $(this_ncmake)"

# Install the skill file that tells an AI coding assistant how ncmake works, or bring an
# existing copy up to date. It comes from the same NCMAKE_REF as this Makefile, so a
# pinned app gets the skill that describes its own ncmake. Unlike the cached Makefile
# the copy never refreshes itself, which is why this target says whether it changed.
skill-install:
	@mkdir -p "$(skill_dir)" || exit 1; \
	f="$(skill_dir)/SKILL.md"; \
	curl -fsSL "$(ncmake_raw)/skills/ncmake/SKILL.md" -o "$$f.new" \
		|| { rm -f "$$f.new"; echo "ERROR: could not fetch $(ncmake_raw)/skills/ncmake/SKILL.md (network? ref '$(ncmake_ref)'?)" >&2; exit 1; }; \
	if [ ! -f "$$f" ]; then mv "$$f.new" "$$f" && echo "Skill installed ($(ncmake_ref)): $$f"; \
	elif cmp -s "$$f.new" "$$f"; then rm -f "$$f.new"; echo "Skill is up to date ($(ncmake_ref)): $$f"; \
	else mv "$$f.new" "$$f" && echo "Skill updated ($(ncmake_ref)): $$f"; fi

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
                               or the app has composer/autoload.php
  npm ci && npm run build      when package.json has a build script; with
                               pnpm-lock.yaml or yarn.lock that package manager,
                               through corepack; without a lock file npm install,
                               and the build is not reproducible
Composer ignores the PHP extensions the build image loads but neither
composer.json nor a locked package requires, so the build fails only on what the
app requires. A side that does not apply is skipped; override in ncmake.mk (php_build_cmd,
node_build_cmd). RUNTIME= selects the container (podman, docker, docker-rootless,
bare). Each image is pulled again once its last check is older than
IMAGE_CHECK_MIN minutes (default 1440), and the image that pull superseded is
removed right away. A pull tries the registries that ncmake's image-sources list
names for the image in turn, so a rate limit on one falls through to the next;
IMAGE_SOURCES=<file> uses a list of one's own. The images ncmake pulled are
removed once no ncmake container has run for IMAGE_IDLE_MIN minutes (default 10);
KEEP=1 keeps them.

  make build
  make build KEEP=1                 keep the images for a series of runs
  make dist-clean && make build     reproducible from-scratch build
endef

define help_composer
make composer ARGS="<composer arguments>"

Runs any composer command in a throwaway container, so no composer or PHP is
needed on the host. It uses analysis_image by default (the official composer
image: newest PHP plus composer, git and unzip), which is what dev tools such as
psalm need. Add PHP=min to run on php_image instead, the PHP floor build image,
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
image is the newest Node LTS line that engines.node in package.json allows and
that is not end of life.

Examples:
  make npm ARGS=ci                   install from package-lock.json
  make npm ARGS="run build"          build the frontend into js/
  make npm ARGS="run dev"            watch and rebuild during development
  make npm ARGS="run test"           run the frontend tests
  make npm ARGS="install -D vitest"  add a dev dependency
endef

define help_reuse
make reuse [ARGS="<reuse lint arguments>"] [FORCE=1]

Runs the REUSE compliance check (reuse.software) in the fsfe/reuse container:
every file must carry a license, via an SPDX header or a REUSE.toml annotation.
RUNTIME=bare expects the reuse tool on the host. ARGS is forwarded to reuse lint.
An app without LICENSES/, REUSE.toml and .reuse/dep5 is reported as not set up
for REUSE in one line, without a lint; FORCE=1 lints it anyway.

  make reuse                 check
  make reuse ARGS=--json     the report as JSON
  make reuse FORCE=1         lint an app that is not set up for REUSE
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

Prompts for the new version and validates it: X.Y.Z or a pre-release
X.Y.Z-alpha.N, -beta.N or -rc.N, greater than the newest tag reachable from the
current branch (ordered as PHP version_compare orders them, so 1.2.0-rc.1 comes
before 1.2.0), on a stable* branch also the same major.minor, and no tag of that
name anywhere. Branches off into ncmake/release/X.Y.Z and commits the bump there (info.xml,
composer.json/package.json and the re-synced lockfiles). Then run make changelog,
push the branch and open a PR against the branch you started from. RUNTIME=
selects the container for the lockfile sync.
endef

define help_changelog
make changelog [UNRELEASED=1] [AMEND=1|COMMIT=1] [PR=1 [BODY=<path>]]

Fills CHANGELOG.md from the conventional commits since the last commit that
changed it (feat to Added, fix to Fixed, perf to Changed;
build/ci/test/chore/docs/refactor/style, merges and Transifex bot commits are
skipped). What was written before, by an earlier run or by hand, is kept word
for word.

Without a pending version bump (or with UNRELEASED=1) the new entries go under
"## [Unreleased]", on any branch, for example right after the commit they
describe. After make version, on the release branch, everything under
"## [Unreleased]" moves together with the new entries into the "## [X.Y.Z]"
section with its link reference, and "## [Unreleased]" keeps its heading. A
pre-release gets a section of its own, and the release after it lists what came
since that pre-release ("No notable changes since X.Y.Z-rc.N." when nothing
came). Groups follow Keep a Changelog (Added, Changed, Deprecated, Removed,
Fixed, Security); a group without entries gets no heading. A CHANGELOG.md with
uncommitted changes stops the run: commit the previous one first.

Without flags it prints the exact commit command: git commit --amend --no-edit
while the commit it belongs to is unpushed (after make version the bump commit,
so a release stays one commit). AMEND=1 runs that amend itself, and refuses on a
pushed commit; with PR=1 it also pushes the branch and opens the pull request
against the branch it started from. COMMIT=1 runs from main or a stable* branch:
it opens ncmake/docs/changelog (on stableX.Y: ncmake/docs/changelog-stableX.Y),
commits with one bullet per new entry and prints the push command; PR=1 implies
it, pushes and opens the pull request. BODY=<path> replaces the text below the
bullets of the pull request. An app-provided cliff.toml overrides the built-in
config.

Examples:
  make changelog
  make changelog AMEND=1
  make changelog AMEND=1 PR=1
  make changelog PR=1
endef

define help_tag
make tag    (maintainer, on main or the stable* branch after the merge)

Refuses to re-tag, refuses a working tree that is not clean (untracked files
included - the release is packed from the checkout), checks the changelog, then
creates and pushes the signed vX.Y.Z tag after confirmation. Publishing the release triggers the release workflow, which
attaches the tarball asset. A release from a stable* branch must not be marked
as the latest release on GitHub, and a pre-release (X.Y.Z-rc.N) must be marked as
a pre-release; make tag reminds of both.

The changelog check runs before the confirmation. With the audit module
(make dev-init) it is make changelog-lint, which refuses on a [!] finding, such
as a changelog the App Store would not show this release from, or a pre-release
without a section of its own. Without the module, make tag refuses when
CHANGELOG.md has no "## [X.Y.Z]" section.

  make tag NO_CHANGELOG_LINT=1    skip the check and tag regardless

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

For an app with .tx/config the next steps add the Transifex sync: the Nextcloud
bot syncs only the branches .tx/backport on main lists (one per line, replacing
the server's stable* names), and it needs write access plus a bypass on the
rule that protects the branch, because it pushes its commits directly.
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

define help_image-clean
make image-clean [OWN=1] [OLD=1] [DRY=1] [ENGINE=podman|docker]

Lists the images of every container CLI on the host, numbered, with their size,
when ncmake last used them and their status:
  ncmake       pulled by ncmake
  ncmake-used  on the host before, used by ncmake
  dangling     without a tag
  foreign      neither from ncmake nor dangling
  in use       a container uses it
Without a flag it asks which images to remove, by number or range (1 3-5), and
reports the space that freed. Without a terminal it only lists.

  OWN=1     remove every image ncmake pulled itself
  OLD=1     remove every image without a tag, and every image ncmake pulled and
            has not used for IMAGE_IDLE_MIN minutes (now: $(IMAGE_IDLE_MIN))
  DRY=1     list and mark what OWN=1 or OLD=1 would remove, remove nothing
  ENGINE=   on the command line, limit the target to podman or docker

The flags never pick a foreign image or one a container uses. Nothing is removed
with -f: an image that a container uses or another tag names stays and says why.
endef

define help_image-setup
make image-setup [ENGINE=podman|docker]

Shows for each container CLI on the host where ncmake keeps the record of the
images it uses, pulled or found:
  $(image_state_user)/images.txt
               a rootless store: podman run by a user, rootless docker
  $(image_state_sys)/images.txt
               a store for the whole host: podman run by root, rootful docker

For rootful docker run by a member of the docker group, $(image_state_sys) needs
sudo once. ncmake asks the first time it records an image; on no, or without a
terminal, the record stays in the user's file. make image-setup asks again and on
yes runs: sudo install -d -m 2775 -g docker $(image_state_sys)
The entries from the user's file move there the next time ncmake reads them.
endef

define help_self-update
make self-update

Fetches the newest ncmake Makefile over the current one (the per-machine cache in
stub mode, the committed copy otherwise) and drops the ETag so the next run
revalidates.
endef

define help_skill-install
make skill-install [skill_dir=<dir>]

Installs skills/ncmake/SKILL.md, the file that teaches an AI coding assistant how
ncmake works, into skill_dir, or replaces a copy there that differs, and says
which of the two happened or that the copy was already current. The file comes
from the same NCMAKE_REF as this Makefile. skill_dir defaults to
~/.claude/skills/ncmake, where Claude Code looks for it for every app of the
user; set it in ncmake.mk or on the command line for another assistant, or to
.claude/skills/ncmake to scope the skill to one repository. Writes nothing else.

The copy does not refresh itself: run the target again after a self-update.
make help shows whether a copy exists in skill_dir.
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
	@echo "  $(ct)changelog$(c0)            Fill '## [Unreleased]' or '## [version]' from the commits       $(cm)[m]$(c0)"
	@echo "  $(ct)tag$(c0)                  Tag the release commit on main or stable*, signed, and push it  $(cm)[m]$(c0)"
	@echo "  $(ct)stable-branch$(c0)        Open a stable* maintenance branch for an older release line     $(cm)[m]$(c0)"
	@echo ""
	@echo "  $(cd)Container runtime for 'version' (lockfile sync) and 'build': $(c0)$(cv)RUNTIME=...$(c0)$(cd) (now: $(RUNTIME))$(c0)"
	@echo "    $(cd)podman | docker | docker-rootless | bare   (auto-detected, podman preferred)$(c0)"
	@echo "    $(cd)Images are checked upstream once per $(cv)IMAGE_CHECK_MIN$(c0)$(cd) minutes (now: $(IMAGE_CHECK_MIN)); a superseded one is removed.$(c0)"
	@echo "    $(cd)A pull tries the registries in image-sources in turn; $(cv)IMAGE_SOURCES=<file>$(c0)$(cd) uses a list of your own.$(c0)"
	@echo "    $(cd)The images ncmake pulled go after $(cv)IMAGE_IDLE_MIN$(c0)$(cd) idle minutes (now: $(IMAGE_IDLE_MIN)); $(cv)KEEP=1$(c0)$(cd) keeps them.$(c0)"
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
	@echo "  $(cd)PHP image per task: build on the PHP floor, composer/psalm on the current composer image ($(cv)PHP=min|max$(c0)$(cd)).$(c0)"
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
	@echo "  $(ct)image-clean$(c0)          List the container images on the host and remove the picked ones"
	@echo "                       $(cv)OWN=1$(c0) ncmake's own, $(cv)OLD=1$(c0) dangling and unused, $(cv)DRY=1$(c0) only show"
	@echo "  $(ct)image-setup$(c0)          Show where the image record lives; share it for rootful docker"
	@echo "  $(ct)self-update$(c0)          Fetch the newest ncmake Makefile"
	@echo "  $(ct)skill-install$(c0)        Install or refresh the skill file for an AI coding assistant"
	@echo "                       $(cd)→ $(skill_dir)/SKILL.md ($(if $(wildcard $(skill_dir)/SKILL.md),present,not installed))$(c0)"
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
# An analyser that builds the app (ncmake_lib_run) needs the app's Node; one that
# only reads (ncmake_lib_read_run) runs on lib_node_image, so an old engines.node
# cannot keep it from loading.
# With RUNTIME=bare there is no container and the host path is used as it is; with
# no runtime at all $(node_run) carries the "install podman" abort.
ifeq ($(filter $(RUNTIME),bare none),)
  ncmake_lib_in       = $(call container_run,$(1),-v "$(ncmake_lib_dir)":/ncmake:ro -e npm_config_cache=/tmp/.npm) sh -lc
  ncmake_lib_run      = $(call ncmake_lib_in,$(node_image))
  ncmake_lib_read_run = $(call ncmake_lib_in,$(lib_node_image))
  ncmake_lib_path     = /ncmake
else
  ncmake_lib_run      = $(node_run)
  ncmake_lib_read_run = $(node_run)
  ncmake_lib_path     = $(ncmake_lib_dir)
endif

# The analysers are written for Node 18 or newer. $(call ncmake_lib_guard,<target>),
# the first command of an analyser script, stops below that with the reason instead
# of letting node fail on syntax it does not know.
ncmake_lib_node_min = 18
ncmake_lib_guard = v=$$(node -p process.versions.node); [ "$${v%%.*}" -ge $(ncmake_lib_node_min) ] || { echo "ERROR: $(1) needs Node $(ncmake_lib_node_min) or newer and found Node $$v$(if $(filter build-verify,$(1)), - it builds with the Node that engines.node in package.json declares)" >&2; exit 1; };

help::
	@echo ""
	@echo "  $(cd)Details on one target:$(c0) $(ct)make help-<target>$(c0)   $(cd)(e.g. make help-rsync)$(c0)"
	@echo ""
	@echo "$(cd)Current:$(c0) $(if $(app_id),$(cv)$(app_id) v$(version)$(c0),$(cd)(not inside a Nextcloud app)$(c0))"
	@echo "$(cd)ncmake:  $(this_ncmake)$(c0)"
	@echo "$(cd)modules: $(if $(ncmake_modules),$(notdir $(ncmake_modules)),(none - 'make dev-init' fetches the developer targets))$(c0)"
