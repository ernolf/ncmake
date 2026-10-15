# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: four checks on a checkout.
#
# consistency-audit reads the metadata of a checkout and holds the statements it
# finds against each other: the version in appinfo/info.xml against the one in
# package.json, the PHP floor in info.xml against composer.json, the Node version
# in package.json against .nvmrc and against the installed workflows. To that it
# adds what a release needs and a checkout can be missing - the link from a
# published version back to its source, a server range that names a server that
# exists, a lockfile, a linter that a script calls but no configuration backs.
# Metadata only: it builds nothing and installs nothing. The one thing it reads from
# the network is the major nextcloud/server develops on master, through make.
#
# build-verify asks the other question about the same checkout: does the build
# output in it come from the source beside it. It copies the tracked files into a
# scratch tree outside the app, installs and builds them there - twice - and
# compares what came out against what the checkout carries. Twice, because a single
# build cannot tell a difference of the source from a build that is not
# reproducible. It installs and builds, so unlike the audit it needs the network
# and takes minutes, and it writes nothing into the app.
#
# changelog-lint reads the changelogs the way the App Store reads them when a
# release is published: CHANGELOG.md and CHANGELOG.<code>.md under exactly those
# names, decoded as UTF-8, and the section that names the version in info.xml. A
# misspelled name or a heading the store does not recognise publishes the release
# without a changelog, silently. Like the audit, it reads the checkout only.
# make tag runs it before the confirmation, through the core's tag_check.
#
# php-compat runs the checkout on the PHP versions a server of its declared range
# runs it on: the floor make build resolves against, and the ceiling, the newest
# PHP minor the highest declared server accepts. On each it asks composer whether
# the installed packages accept that PHP, and lints the PHP files that ship. A
# dependency resolved on the floor can require a PHP below the ceiling, and code
# that parses on one PHP can fail on the next; neither shows before a server runs
# it. The runs use the core's build image, one make per minor, and leave their
# output under build/php-compat, which the analyser then reads.
#
# This is its own module rather than a third target in mk/bundle.mk because a
# module file cannot be renamed: the core includes every *.mk-<ref> it finds in the
# per-machine cache and dev-init only ever adds files, so a renamed bundle.mk would
# stay behind in every existing cache and define its targets a second time. The
# separate file costs nothing beyond its own header: fetching the analysers is the
# core's, under "Analyser libraries" there.
#
# The same discovery rule is why build-verify, changelog-lint and php-compat are
# targets in this file and not modules of their own: a new module file reaches a machine only on the
# next dev-init, while a target added to a file the cache already holds arrives with
# the next refresh.
#
# Names here must stay distinct from mk/bundle.mk: that file is read after this one
# and would otherwise overwrite this module's variables without a word. ncmake_libs
# is the exception and is appended to rather than set - it is the core's list, and
# every analyser module adds to it.

# == Analyser configuration ==
# What each analyser needs next to it. report-text.mjs prints; the analyser itself
# decides what is worth saying.
consistency_libs = consistency-audit.mjs report-text.mjs
verify_libs      = build-verify.mjs report-text.mjs
changelog_libs   = changelog-lint.mjs report-text.mjs
compat_libs      = php-compat.mjs report-text.mjs

# What the goals on this command line need, handed to the core's analyser library
# section: appended, never set, because every analyser module adds its own.
ncmake_libs += $(if $(filter consistency-audit,$(MAKECMDGOALS)),$(consistency_libs)) $(if $(filter build-verify,$(MAKECMDGOALS)),$(verify_libs)) $(if $(filter changelog-lint,$(MAKECMDGOALS)),$(changelog_libs)) $(if $(filter php-compat,$(MAKECMDGOALS)),$(compat_libs))

# The app is mounted at /app inside the container, so the mount point cannot tell
# the analyser what the app directory is called - the one thing it needs the host
# name for, and the only judgement in the audit that is about the checkout rather
# than its contents. It is handed in per run, in the recipe below.
#
# The analyser tells the reader how to run it again with other options, and has to
# name the command that was typed rather than the path of the file inside the
# container, so the invocation is handed in as a template with %s for the options.
# The inner quotes are resolved by the shell that runs the analyser.
consistency_cmdline = make consistency-audit ARGS=\"%s\"

# The major nextcloud/server develops on master, from its version.php. No server
# has run a <nextcloud max-version> beyond it, so the audit holds the declared range
# against it. A table in the analyser would have to be kept current by hand; this
# follows the server. It is read only when the recipe runs, and where it cannot be
# read it stays empty and the analyser falls back on its own table of majors.
consistency_nc_master = $(shell curl -fsSL "$(nc_server_raw)/master/version.php" 2>/dev/null | sed -n 's/^\$$OC_Version[^0-9]*\([0-9]*\).*/\1/p' | head -1)

# The verifier prints how to run it again as well, and has nothing to say about the
# name of the checkout: it names the root it resolved, which inside the container
# is the mount point, so no second variable is handed in.
verify_cmdline = make build-verify ARGS=\"%s\"
changelog_cmdline = make changelog-lint ARGS=\"%s\"
compat_cmdline    = make php-compat ARGS=\"%s\"

# In a container the scratch tree is in the container's own /tmp and goes with it,
# so the verifier must neither offer to keep it nor name it as kept. The condition
# is the one under which the core runs the analysers in a container.
verify_transient = $(if $(filter $(RUNTIME),bare none),,BUILD_VERIFY_TRANSIENT=1)

# A module is refreshed on its own terms, and an app that carries a committed core
# Makefile refreshes that one by hand - so the core here can be older than the
# analyser section this module expects. Say which side is behind rather than run an
# empty command.
audit_core = $(if $(ncmake_lib_read_run),:,echo "ERROR: this module needs a newer ncmake core - run 'make self-update'" >&2; exit 1)

# make tag checks the changelog the way the App Store reads it rather than by the
# core's heading grep. A second make, so that the goal changelog-lint fetches the
# analyser it needs.
tag_check = $(MAKE) --no-print-directory changelog-lint || { echo "ERROR: make tag stops on the [!] findings above - fix the changelog, or tag regardless with NO_CHANGELOG_LINT=1." >&2; exit 1; }

# php-compat needs the PHP ceiling and a build image per PHP minor from the core.
compat_core = $(if $(value php_server_max),:,echo "ERROR: php-compat needs a newer ncmake core - run 'make self-update'" >&2; exit 1)

# Each minor runs in a make of its own, because the build image is chosen while a
# make reads its variables: php_version picks the minor, PHP=min the build image
# rather than analysis_image. A php_image of one's own names a single minor, so the
# published image stands in for it; a host that builds its images locally keeps
# doing so. The run records the PHP it actually ran on, so the analyser can tell a
# runtime that ignores the minor, RUNTIME=bare above all, from one that did not.
compat_dir   = build/php-compat
compat_image = $(if $(filter local,$(php_floor_mode)),localhost,ghcr.io/ernolf)/ncmake-php
# Every PHP file that ships, linted by as many PHP processes as the runtime has
# processors. busybox xargs stops at the first command that fails, and php -l fails
# on every file it cannot parse, so the loop exits 0 and the output tells.
compat_lint  = find appinfo lib templates vendor -type f -name "*.php" -print0 2>/dev/null | xargs -0 -n 64 -P "$$(nproc)" sh -c "for f; do php -d error_reporting=-1 -d display_errors=stderr -d log_errors=0 -l \"\$$f\" 2>&1 | grep -v \"^No syntax errors detected in \"; done; exit 0" php-lint
compat_run   = out=$(compat_dir)/$(php_version); php -r "echo PHP_VERSION;" >"$$out/version"; if [ -f vendor/composer/installed.json ] || [ -f composer.lock ]; then composer check-platform-reqs --no-dev --format=json >"$$out/platform.json" 2>"$$out/platform.err"; echo $$? >"$$out/platform.rc"; fi; $(compat_lint) >"$$out/lint.txt"

.PHONY: consistency-audit build-verify changelog-lint php-compat php-compat-run

consistency-audit:
	@$(audit_core)
	@$(call ncmake_lib_need,$(consistency_libs))
	@echo "==> consistency-audit$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@$(ncmake_lib_read_run) '$(call ncmake_lib_guard,consistency-audit) CONSISTENCY_AUDIT_CMDLINE="$(consistency_cmdline)" CONSISTENCY_AUDIT_APPDIR="$(notdir $(CURDIR))" CONSISTENCY_AUDIT_NC_MASTER="$(consistency_nc_master)" node $(ncmake_lib_path)/consistency-audit.mjs $(ARGS)'

build-verify:
	@$(audit_core)
	@$(call ncmake_lib_need,$(verify_libs))
	@echo "==> build-verify$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@$(ncmake_lib_run) '$(call ncmake_lib_guard,build-verify) $(verify_transient) BUILD_VERIFY_CMDLINE="$(verify_cmdline)" node $(ncmake_lib_path)/build-verify.mjs $(ARGS)'

changelog-lint:
	@$(audit_core)
	@$(call ncmake_lib_need,$(changelog_libs))
	@echo "==> changelog-lint$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@$(ncmake_lib_read_run) '$(call ncmake_lib_guard,changelog-lint) CHANGELOG_LINT_CMDLINE="$(changelog_cmdline)" node $(ncmake_lib_path)/changelog-lint.mjs $(ARGS)'

php-compat: check-app
	@$(audit_core)
	@$(compat_core)
	@$(call ncmake_lib_need,$(compat_libs))
	@floor='$(php_min)'; server='$(php_server_max)'; declared='$(php_declared_max)'; \
	[ -n "$$server" ] || { echo "ERROR: no PHP ceiling - lib/versioncheck.php of Nextcloud $(or $(nc_max),master) could not be read" >&2; exit 1; }; \
	ceiling=$$(printf '%s\n' "$$server" $$declared | sort -V | tail -1); \
	if [ "$(PHP)" = all ]; then \
		minors=$$(for M in $$(seq "$${floor%%.*}" "$${ceiling%%.*}"); do for n in $$(seq 0 9); do v=$$M.$$n; \
			[ "$$(printf '%s\n' "$$floor" "$$v" | sort -V | head -1)" = "$$floor" ] && [ "$$(printf '%s\n' "$$v" "$$ceiling" | sort -V | tail -1)" = "$$ceiling" ] && echo "$$v"; \
		done; done); \
	else minors=$$(printf '%s\n' "$$floor" "$$ceiling" | sort -uV); fi; \
	echo "==> php-compat on PHP" $$minors "(RUNTIME=$(RUNTIME))" >&2; \
	rm -rf $(compat_dir) && mkdir -p $(compat_dir) || exit 1; \
	printf 'floor=%s\nceiling=%s\nserver=%s\ndeclared=%s\nnextcloud=%s\n' "$$floor" "$$ceiling" "$$server" "$$declared" '$(nc_max)' >$(compat_dir)/range; \
	for m in $$minors; do \
		echo "==> PHP $$m" >&2; mkdir -p $(compat_dir)/$$m; \
		$(MAKE) --no-print-directory php-compat-run php_version=$$m php_image=$(compat_image):$$m PHP=min || echo "$$?" >$(compat_dir)/$$m/failed; \
	done; \
	$(ncmake_lib_read_run) '$(call ncmake_lib_guard,php-compat) PHP_COMPAT_CMDLINE="$(compat_cmdline)" node $(ncmake_lib_path)/php-compat.mjs $(ARGS)'

php-compat-run:
	@$(php_run) '$(compat_run)'

define help_consistency-audit
make consistency-audit [ARGS="<audit arguments>"]

Checks whether the checkout agrees with itself. An app states the same fact in
several files, and each file is valid on its own: appinfo/info.xml and
package.json both carry a version, info.xml and composer.json both bound the PHP
version, package.json, .nvmrc and the installed workflows each name a Node
version. A linter checks one file against a rule and cannot see any of that; this
holds the files against each other and reports where they disagree.

The second half is what a release needs and a checkout can be missing: the
<repository> and <bugs> links, which are the only way from a published release
back to the project; a <nextcloud> range that names servers that exist, measured
against the majors released when the analyser was last refreshed; a lockfile, and
one rather than two; a licence stated the same way everywhere; a linter that a
script calls while no configuration for it is in the tree. Each of those is
reported once, with the reason it matters, and never as a score.

Findings are marked [!] worth changing, [i] worth knowing, [ok] nothing found,
and each says which files it was read from. What the checkout does not state is
named as not stated instead of being guessed at - with one exception, the list of
released Nextcloud majors, which is written into the analyser, and the report
names the month that list is from. The major nextcloud/server develops on master
is read from its version.php instead: a <nextcloud max-version> beyond it names
servers nobody has run the app on. Without the network the list stands in for it,
and the report says so.

It reads metadata only: no build, no install, no installed dependency tree, no
bytes. That makes it useful on a fresh clone, and on an app that never heard of
ncmake. The analyser runs in the throwaway Node container, so the host needs no
Node, and it is mounted in from the ncmake cache, so nothing is written into the
app.

ARGS is passed to the analyser; a bare word in it is the checkout to audit
(default: the current directory):
  make consistency-audit                      this app
  make consistency-audit ARGS=--details       every table behind the findings
  make consistency-audit ARGS="--details --top=0"  and no row limit in them
  make consistency-audit ARGS=--json > audit.json  machine-readable, nothing else
  make consistency-audit ARGS=--help          the analyser's own option list

Only the app itself is mounted into the container, so auditing a checkout outside
it needs RUNTIME=bare and Node on the host.
endef

define help_php-compat
make php-compat [PHP=all] [ARGS="<analyser arguments>"]

Checks whether the app runs on the PHP versions its servers run it on. A server
states the PHP it accepts in lib/versioncheck.php, and the app states the servers
in appinfo/info.xml. Two of those PHP versions are checked:
  the floor     the PHP make build resolves the dependencies against
  the ceiling   the newest PHP minor that Nextcloud <max-version> accepts, read
                from its stable branch, or from master for a max-version that
                has none; <php max-version> in info.xml can only raise it
PHP=all checks every minor in between as well.

Each runs in the build image of that minor, ghcr.io/ernolf/ncmake-php:<minor>,
with the extensions a Nextcloud server offers, and does two things there:
  composer check-platform-reqs --no-dev
      whether every installed package accepts this PHP. A package that requires
      a PHP below the ceiling installs on the floor and breaks on a newer server.
  php -l over appinfo/, lib/, templates/ and vendor/
      whether every PHP file that ships parses on this PHP, and what it reports
      as deprecated there.
Findings are marked [!] worth changing, [i] worth knowing, [ok] nothing found:
[!] for a package that refuses one of the PHP versions, a file that does not
parse, and a <php max-version> below the server's ceiling, which keeps the app
off servers that run a newer PHP; [i] for a deprecation, an extension the build
image lacks, and a file of a dev package, which make build does not ship.

The check reads what is installed: run make build first, so vendor/ holds what
ships. Without vendor/, composer reads composer.lock and only the app's own files
are linted; without either, composer has nothing to check. The output of each
run stays in build/php-compat/<minor>.

The exit code is 1 when a finding is marked [!], so a CI job that runs it after
make build fails on it. ARGS is passed to the analyser:
  make php-compat                       the floor and the ceiling
  make php-compat PHP=all               every minor in between too
  make php-compat ARGS=--details        every file behind the findings
  make php-compat ARGS=--json > compat.json  machine-readable, nothing else
  make php-compat ARGS=--help           the analyser's own option list

It needs the network for versioncheck.php and the images. With RUNTIME=bare it
runs on the PHP of the host, once per minor, and says so.
endef

define help_build-verify
make build-verify [ARGS="<verify arguments>"]

Answers one question: does the build output in this checkout come from the source
beside it. It copies the tracked files into a scratch tree outside the app,
installs the locked dependencies there, runs the build - twice - and compares
what came out against what the checkout carries.

Twice, because a single build cannot tell the two answers apart. A file that
differs after one build was either built from another source or is written
differently every time, and only a second build separates them: what both builds
wrote byte for byte the same way is what this source produces, so a difference
against the checkout is the checkout's. A file the two builds disagree on is
named and gets no verdict, because no build reproduces it. The second build runs
in another directory, so output that depends on where the build ran counts as
not reproducible too. ARGS=--once builds once and states the open question
instead of answering it.

A difference both builds reproduce means the output in the checkout was built
from another source, and make build is the remedy. Where git ignores the output
and make build has just run on this working tree, that cannot be the reason:
ARGS=--fresh says so, and the same difference then reads as a build that depends
on something a fresh clone does not have, or on the directory it ran in.

Hashed file names are paired by content, so app-3f9c1a2b.js and app-8b20de41.js
are read as one file under two names, and a reference that carries the hash
counts as build metadata rather than a difference. A source map is compared as
the map it is: what it was compiled from decides, the directory it records its
sources under does not.

Findings are marked [!] worth changing, [i] worth knowing, [ok] nothing found.
The checkout is read and never written to - the build output in it stays where it
is, nothing is installed into it, and the scratch tree is removed again.

ARGS is passed to the analyser; a bare word in it is the checkout to verify
(default: the current directory):
  make build-verify                         this app, js/ and css/
  make build-verify ARGS=--build=dist       another output directory
  make build-verify ARGS=--details          every table behind the findings
  make build-verify ARGS=--once             one build instead of two
  make build && make build-verify ARGS=--fresh  output built right before
  make build-verify ARGS=--json > verify.json  machine-readable, nothing else
  make build-verify ARGS=--help             the analyser's own option list

It installs and builds, so unlike consistency-audit it needs the network and
takes minutes rather than a second. Where it runs it needs git and npm: the
default node image carries both, a slim one does not. In a container the scratch
tree lives in the container's own /tmp and goes with it, so ARGS=--keep and the
log each build step writes only survive with RUNTIME=bare and Node on the host.
Where a step fails, the last lines of its output and of its error output are
printed apart, which in a container is the only record of why.
endef

define help_changelog-lint
make changelog-lint [ARGS="<lint arguments>"]

Checks whether the App Store finds this release in the changelog. The store takes
the changelog from the tarball and reads exactly two kinds of file there:
  CHANGELOG.md          English
  CHANGELOG.<code>.md   one per language of its language list, such as
                        CHANGELOG.de.md or CHANGELOG.pt-br.md
Each is decoded as UTF-8, and what it shows is the section under the heading that
names the version in appinfo/info.xml: a line that begins with ## 1.2.3, ## [1.2.3]
or ## v1.2.3. A version with a '-' is a pre-release and is read from the
## [Unreleased] section, as a nightly is. Whatever the store does not find, the
release is published without, and nothing reports it.

A tagged pre-release (1.2.3-rc.1) is a release of its own, and the check asks for
the section that names it, ## [1.2.3-rc.1], as make changelog writes it. The
store shows that section with the stable 1.2.3, below its own. On the page of
the pre-release itself it shows ## [Unreleased]; that is reported with [i], not
demanded.

That is what this reports: [!] for no CHANGELOG.md, for a name that differs only
in its spelling (changelog.md, CHANGELOG.MD, CHANGELOG.De.md) together with the
git mv that fixes it, for a language code the store does not know, for a file that
is not UTF-8, and for a changelog without a section for this version or with an
empty one; [i] for a changelog under a name the store never reads (CHANGES.md,
HISTORY.md, CHANGELOG);
[ok] with the lines of the section in each language. The rules are those of the
App Store's release parser, and its language list is written into the analyser.

ncmake ships CHANGELOG.md and every CHANGELOG.*.md, each with its .license
sidecar. make changelog writes the English section; a translation is written by
hand.

The exit code is 1 when a finding is marked [!]. make tag runs this check before
its confirmation and refuses on that exit code; make tag NO_CHANGELOG_LINT=1 tags
regardless. Elsewhere the exit code stops a chain of commands, or fails a CI job.
ARGS is passed to the analyser; a bare word in it is the checkout to check
(default: the current directory):
  make changelog-lint                      this app, this version
  make changelog-lint ARGS=--nightly       the section a nightly is read from
  make changelog-lint ARGS=--json > changelog.json  machine-readable, nothing else
  make changelog-lint ARGS=--help          the analyser's own option list

It reads the checkout only: no build, no network. The analyser runs in the
throwaway Node container and is mounted in from the ncmake cache, so nothing is
written into the app.
endef

help::
	@echo ""
	@echo "$(ch)Checkout audit (developer module):$(c0)"
	@echo "  $(ct)consistency-audit$(c0)    Whether the checkout agrees with itself, and what a release still needs"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-consistency-audit$(c0)"
	@echo "  $(ct)build-verify$(c0)         Whether the committed build output comes from the source beside it"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-build-verify$(c0)"
	@echo "  $(ct)changelog-lint$(c0)       Whether the App Store finds this release in the changelog"
	@echo "    $(cd)optional $(cv)ARGS=\"--nightly\"$(cd), see $(cv)make help-changelog-lint$(c0)"
	@echo "  $(ct)php-compat$(c0)           Whether the app runs on the PHP floor and ceiling of its servers"
	@echo "    $(cd)optional $(cv)PHP=all$(cd), see $(cv)make help-php-compat$(c0)"
