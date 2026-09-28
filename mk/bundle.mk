# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: bundle analysis.
#
# Two analysers on the same measurements. bundle-report reads what the app ships:
# it follows the import graph of the built assets from every entry, adds the
# stylesheet named after that entry with everything it imports, sums the bytes of
# that closure and charges them back to the packages they came from through the
# shipped source maps. build-audit reads the half that never ships - the bundler
# config, package.json, src/ - and prices every finding in the same delivered
# bytes, so a statement about how this app imports something comes with what that
# costs. Neither builds, installs or touches dependencies.
#
# The analysers are dependency-free ESM files that share their measuring core, so
# both count the same way. They live together in a per-reference directory of the
# per-machine ncmake cache, fetched and refreshed exactly like the modules, and
# that directory is mounted read-only into the throwaway Node container - one
# directory, because a shared module is imported by the file next to it. Nothing
# is ever written into the app: no file to commit, no file to ignore, no file for
# 'make clean' to remove.

# == Bundle analysis configuration ==
lib_dir = $(ncmake_cache)/lib-$(ncmake_ref)

# What each analyser needs next to it. built-assets.mjs measures, report-text.mjs
# prints; the analyser itself decides what is worth saying.
report_libs = bundle-report.mjs built-assets.mjs report-text.mjs
audit_libs  = build-audit.mjs built-assets.mjs report-text.mjs

# Only what the goals on this command line actually need, each file once.
analyse_libs = $(sort $(if $(filter bundle-report,$(MAKECMDGOALS)),$(report_libs)) $(if $(filter build-audit,$(MAKECMDGOALS)),$(audit_libs)))

# An analyser tells the reader how to run it again with other options. It must
# name the command that was typed, not the path of the file inside the container,
# so the invocation is handed in as a template with %s for the options. The inner
# quotes are resolved by the shell that runs the analyser.
report_cmdline = make bundle-report ARGS=\"%s\"
audit_cmdline  = make build-audit ARGS=\"%s\"

# Fetched on first use, then refreshed on the same TTL and ETag terms as the core
# Makefile and the modules: unchanged or offline keeps the cached copy. The list is
# empty unless an analyser is among the goals, so no other target in any app ever
# pays for a network round trip.
ifneq ($(strip $(analyse_libs)),)
  $(shell mkdir -p "$(lib_dir)"; for f in $(analyse_libs); do t="$(lib_dir)/$$f"; u="$(ncmake_raw)/lib/$$f"; if [ ! -s "$$t" ]; then curl -fsSL "$$u" -o "$$t" 2>/dev/null; test -s "$$t" || rm -f "$$t"; elif [ -n "$$(find "$$t" -mmin +$(NCMAKE_TTL_MIN) 2>/dev/null)" ]; then curl -fsSL --etag-compare "$$t.etag" --etag-save "$$t.etag" "$$u" -o "$$t.new" 2>/dev/null; if [ -s "$$t.new" ]; then mv "$$t.new" "$$t"; else rm -f "$$t.new"; fi; touch "$$t"; fi; done)
endif

# The analyser directory is mounted at /ncmake, read-only, alongside the app at
# /app. With RUNTIME=bare there is no container and the host path is used as it
# is; with no runtime at all $(node_run) carries the core's "install podman" abort.
ifeq ($(filter $(RUNTIME),bare none),)
  analyse_run  = $(container) -v "$(lib_dir)":/ncmake:ro $(node_image) sh -lc
  analyse_path = /ncmake
else
  analyse_run  = $(node_run)
  analyse_path = $(lib_dir)
endif

.PHONY: bundle-report build-audit

bundle-report:
	@for f in $(report_libs); do test -s "$(lib_dir)/$$f" || { echo "ERROR: could not fetch $(ncmake_raw)/lib/$$f - network?" >&2; exit 1; }; done
	@echo "==> bundle-report$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))"
	@$(analyse_run) 'BUNDLE_REPORT_CMDLINE="$(report_cmdline)" node $(analyse_path)/bundle-report.mjs $(ARGS)'

build-audit:
	@for f in $(audit_libs); do test -s "$(lib_dir)/$$f" || { echo "ERROR: could not fetch $(ncmake_raw)/lib/$$f - network?" >&2; exit 1; }; done
	@echo "==> build-audit$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))"
	@$(analyse_run) 'BUILD_AUDIT_CMDLINE="$(audit_cmdline)" node $(analyse_path)/build-audit.mjs $(ARGS)'

define help_bundle-report
make bundle-report [ARGS="<report arguments>"]

Reports what a browser downloads when a page of this app opens. Every file in the
built directory that no other file there imports counts as an entry; from each
entry the static import graph is followed to its closure - that is what the
browser fetches on page open - while dynamically imported files are listed
separately because they only arrive when the code asks for them. A split
stylesheet holds nothing but @import lines, so the stylesheet named after an
entry is resolved the same way and counted with it: entry plus stylesheet is one
page, the pairing the app makes in PHP with addScript and addStyle. Each file is
compressed on its own, never concatenated, because each is its own HTTP response.

Where the build ships source maps, the delivered bytes are charged back to the
modules they came from, so the report names the packages your bundle is actually
made of and how much each one costs. Without maps the file sizes still hold; the
per-package breakdown does not.

The output is a verdict, not a dump: the bytes per page, how the build splits
between what every page loads and what one page loads, then the findings - a
package root that was pulled in whole, a module delivered twice, a file that
belongs to no page of this build and is therefore the remains of an earlier one -
marked [!] worth changing, [i] worth knowing, [ok] nothing found. Each finding
says what it is derived from. Behind it, --details adds the per-file, per-package
and per-module tables, and --json emits the whole result, findings included, for
a script to read.

It reads the directory only. Build first (make build), then report. The analyser
runs in the throwaway Node container, so the host needs no Node, and it is mounted
in from the ncmake cache, so nothing is written into the app.

ARGS is passed to the analyser; a bare word in it is the directory to read
(default: js):
  make bundle-report                          all entries of js/
  make bundle-report ARGS=--details           every table behind the findings
  make bundle-report ARGS="--details --top=0"  and no row limit in them
  make bundle-report ARGS="--entry=main.mjs"  one entry only
  make bundle-report ARGS="--details --modules=@nextcloud/vue"  that package
                                              broken down per module
  make bundle-report ARGS=dist                report on dist/ instead of js/
  make bundle-report ARGS=--css=build/css     stylesheets outside ../css
  make bundle-report ARGS=--json > report.json   machine-readable, nothing else
  make bundle-report ARGS=--help              the analyser's own option list
endef

define help_build-audit
make build-audit [ARGS="<audit arguments>"]

Audits why the bundle is the size it is. bundle-report measures what ships; this
reads the half that never does - the bundler config, package.json and the source
under src/ - and prices what it finds there in the bytes the build delivers, by
the same measurement and through the same source maps. A finding therefore comes
with your own numbers instead of a general claim about bundlers.

What it names is kept to what the app itself can change: which toolchain the
checkout is built with, read from the config files and the declared packages
rather than from anyone's opinion of them; whether the build emits source maps,
without which nobody can say what the bundle consists of; a page that arrives as
one chunk, which only a dynamic import in the source splits; every package the
source imports by its root, with the names that import takes and what the build
delivers of that package, because only a package that arrives in several modules
has anything a per-module import could leave out; and, where the source is what
pulls them in, moment or a set of statically bound date-fns locales. What the
bundler or a library decides on its own - how vite cuts its chunks, that a
component library ships its translation catalogue whole - is measured and tabled
under --details instead, because a verdict the app cannot act on is noise.
Findings are marked [!] worth changing, [i] worth knowing, [ok] nothing found,
and each says what it is derived from.

Without a build output the source-side findings still hold and the report names
the figures it is missing, so the audit is useful on a fresh checkout. It reads
the checkout only: no build, no install, no network. The analyser runs in the
throwaway Node container, so the host needs no Node.

ARGS is passed to the analyser; a bare word in it is the checkout to audit
(default: the current directory):
  make build-audit                            this app
  make build-audit ARGS=--details             every table behind the findings
  make build-audit ARGS="--details --top=0"    and no row limit in them
  make build-audit ARGS=--build=dist          built assets in dist/, not js/
  make build-audit ARGS=--src=srcjs           source outside src/
  make build-audit ARGS=--json > audit.json   machine-readable, nothing else
  make build-audit ARGS=--help                the analyser's own option list
endef

help::
	@echo ""
	@echo "$(ch)Bundle analysis (developer module):$(c0)"
	@echo "  $(ct)bundle-report$(c0)        What the browser loads per page, and which packages those bytes are"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-bundle-report$(c0)"
	@echo "  $(ct)build-audit$(c0)          Why the bundle is that size: config, imports and src, priced in bytes"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-build-audit$(c0)"
