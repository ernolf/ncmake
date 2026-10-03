# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: two checks on a checkout.
#
# consistency-audit reads the metadata of a checkout and holds the statements it
# finds against each other: the version in appinfo/info.xml against the one in
# package.json, the PHP floor in info.xml against composer.json, the Node version
# in package.json against .nvmrc and against the installed workflows. To that it
# adds what a release needs and a checkout can be missing - the link from a
# published version back to its source, a server range that names a server that
# exists, a lockfile, a linter that a script calls but no configuration backs.
# Metadata only: it builds nothing, installs nothing and reads no network.
#
# build-verify asks the other question about the same checkout: does the build
# output in it come from the source beside it. It copies the tracked files into a
# scratch tree outside the app, installs and builds them there - twice - and
# compares what came out against what the checkout carries. Twice, because a single
# build cannot tell a difference of the source from a build that is not
# reproducible. It installs and builds, so unlike the audit it needs the network
# and takes minutes, and it writes nothing into the app.
#
# This is its own module rather than a third target in mk/bundle.mk because a
# module file cannot be renamed: the core includes every *.mk-<ref> it finds in the
# per-machine cache and dev-init only ever adds files, so a renamed bundle.mk would
# stay behind in every existing cache and define its targets a second time. The
# separate file costs nothing beyond its own header: fetching the analysers is the
# core's, under "Analyser libraries" there.
#
# The same discovery rule is why build-verify is a second target in this file and
# not a module of its own: a new module file reaches a machine only on the next
# dev-init, while a target added to a file the cache already holds arrives with the
# next refresh.
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

# What the goals on this command line need, handed to the core's analyser library
# section: appended, never set, because every analyser module adds its own.
ncmake_libs += $(if $(filter consistency-audit,$(MAKECMDGOALS)),$(consistency_libs)) $(if $(filter build-verify,$(MAKECMDGOALS)),$(verify_libs))

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

# The verifier prints how to run it again as well, and has nothing to say about the
# name of the checkout: it names the root it resolved, which inside the container
# is the mount point, so no second variable is handed in.
verify_cmdline = make build-verify ARGS=\"%s\"

# In a container the scratch tree is in the container's own /tmp and goes with it,
# so the verifier must neither offer to keep it nor name it as kept. The condition
# is the one under which the core runs the analysers in a container.
verify_transient = $(if $(filter $(RUNTIME),bare none),,BUILD_VERIFY_TRANSIENT=1)

# A module is refreshed on its own terms, and an app that carries a committed core
# Makefile refreshes that one by hand - so the core here can be older than the
# analyser section this module expects. Say which side is behind rather than run an
# empty command.
audit_core = $(if $(ncmake_lib_run),:,echo "ERROR: this module needs a newer ncmake core - run 'make self-update'" >&2; exit 1)

.PHONY: consistency-audit build-verify

consistency-audit:
	@$(audit_core)
	@$(call ncmake_lib_need,$(consistency_libs))
	@echo "==> consistency-audit$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@$(ncmake_lib_run) 'CONSISTENCY_AUDIT_CMDLINE="$(consistency_cmdline)" CONSISTENCY_AUDIT_APPDIR="$(notdir $(CURDIR))" node $(ncmake_lib_path)/consistency-audit.mjs $(ARGS)'

build-verify:
	@$(audit_core)
	@$(call ncmake_lib_need,$(verify_libs))
	@echo "==> build-verify$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@$(ncmake_lib_run) '$(verify_transient) BUILD_VERIFY_CMDLINE="$(verify_cmdline)" node $(ncmake_lib_path)/build-verify.mjs $(ARGS)'

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
released Nextcloud majors, which is written into the analyser because the audit
reads no network, and the report names the month that list is from.

It reads metadata only: no build, no install, no dependency tree, no bytes. That
makes it useful on a fresh clone, and on an app that never heard of ncmake. The
analyser runs in the throwaway Node container, so the host needs no Node, and it
is mounted in from the ncmake cache, so nothing is written into the app.

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
named and gets no verdict, because no build reproduces it. ARGS=--once builds
once and states the open question instead of answering it.

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

help::
	@echo ""
	@echo "$(ch)Checkout audit (developer module):$(c0)"
	@echo "  $(ct)consistency-audit$(c0)    Whether the checkout agrees with itself, and what a release still needs"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-consistency-audit$(c0)"
	@echo "  $(ct)build-verify$(c0)         Whether the committed build output comes from the source beside it"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-build-verify$(c0)"
