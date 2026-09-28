# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: consistency audit.
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
# This is its own module rather than a third target in mk/bundle.mk because a
# module file cannot be renamed: the core includes every *.mk-<ref> it finds in the
# per-machine cache and dev-init only ever adds files, so a renamed bundle.mk would
# stay behind in every existing cache and define its targets a second time. The
# price of the separate file is the parse-time fetch line below, which is the same
# line bundle.mk carries; the tidy route is a generic lib fetch in core/Makefile,
# offered there.
#
# Names here must stay distinct from mk/bundle.mk: that file is read after this one
# and would otherwise overwrite lib_dir, report_libs, audit_libs, analyse_libs,
# report_cmdline, audit_cmdline, analyse_run and analyse_path without a word.

# == Consistency audit configuration ==
# The per-reference directory the bundle analysers use as well, deliberately: the
# analysers share report-text.mjs, and a shared module is imported by the file next
# to it, so all of them live in one directory.
audit_lib_dir = $(ncmake_cache)/lib-$(ncmake_ref)

# What the analyser needs next to it. report-text.mjs prints; the analyser itself
# decides what is worth saying.
consistency_libs = consistency-audit.mjs report-text.mjs

# Only what the goals on this command line actually need.
audit_fetch_libs = $(sort $(if $(filter consistency-audit,$(MAKECMDGOALS)),$(consistency_libs)))

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

# Fetched on first use, then refreshed on the same TTL and ETag terms as the core
# Makefile and the modules: unchanged or offline keeps the cached copy. The list is
# empty unless the audit is among the goals, so no other target in any app ever
# pays for a network round trip.
ifneq ($(strip $(audit_fetch_libs)),)
  $(shell mkdir -p "$(audit_lib_dir)"; for f in $(audit_fetch_libs); do t="$(audit_lib_dir)/$$f"; u="$(ncmake_raw)/lib/$$f"; if [ ! -s "$$t" ]; then curl -fsSL "$$u" -o "$$t" 2>/dev/null; test -s "$$t" || rm -f "$$t"; elif [ -n "$$(find "$$t" -mmin +$(NCMAKE_TTL_MIN) 2>/dev/null)" ]; then curl -fsSL --etag-compare "$$t.etag" --etag-save "$$t.etag" "$$u" -o "$$t.new" 2>/dev/null; if [ -s "$$t.new" ]; then mv "$$t.new" "$$t"; else rm -f "$$t.new"; fi; touch "$$t"; fi; done)
endif

# The analyser directory is mounted at /ncmake, read-only, alongside the app at
# /app. With RUNTIME=bare there is no container and the host path is used as it
# is; with no runtime at all $(node_run) carries the core's "install podman" abort.
ifeq ($(filter $(RUNTIME),bare none),)
  audit_run  = $(container) -v "$(audit_lib_dir)":/ncmake:ro $(node_image) sh -lc
  audit_path = /ncmake
else
  audit_run  = $(node_run)
  audit_path = $(audit_lib_dir)
endif

.PHONY: consistency-audit

consistency-audit:
	@for f in $(consistency_libs); do test -s "$(audit_lib_dir)/$$f" || { echo "ERROR: could not fetch $(ncmake_raw)/lib/$$f - network?" >&2; exit 1; }; done
	@echo "==> consistency-audit$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))"
	@$(audit_run) 'CONSISTENCY_AUDIT_CMDLINE="$(consistency_cmdline)" CONSISTENCY_AUDIT_APPDIR="$(notdir $(CURDIR))" node $(audit_path)/consistency-audit.mjs $(ARGS)'

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

help::
	@echo ""
	@echo "$(ch)Consistency audit (developer module):$(c0)"
	@echo "  $(ct)consistency-audit$(c0)    Whether the checkout agrees with itself, and what a release still needs"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-consistency-audit$(c0)"
