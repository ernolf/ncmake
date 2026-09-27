# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: bundle report.
#
# What does a browser actually download when a page of this app opens? The report
# follows the import graph of the built assets from every entry, adds the
# stylesheet named after that entry with everything it imports, sums the bytes of
# that closure and charges them back to the packages they came from through the
# shipped source maps. It reads the build output only - it never builds, installs
# or touches dependencies.
#
# The analyser is a single dependency-free ESM file. It lives in the per-machine
# ncmake cache next to the modules, fetched and refreshed exactly like them, and is
# mounted read-only into the throwaway Node container. Nothing is ever written into
# the app: no file to commit, no file to ignore, no file for 'make clean' to remove.

# == Bundle report configuration ==
report_lib  = bundle-report.mjs
report_host = $(ncmake_cache)/$(basename $(report_lib))-$(ncmake_ref)$(suffix $(report_lib))
report_url  = $(ncmake_raw)/lib/$(report_lib)

# The report tells the reader how to run it again with other options. It must name
# the command that was typed, not the path of the analyser inside the container,
# so the invocation is handed in as a template with %s for the options. The inner
# quotes are resolved by the shell that runs the analyser.
report_cmdline = make bundle-report ARGS=\"%s\"

# Fetched on first use, then refreshed on the same TTL and ETag terms as the core
# Makefile and the modules: unchanged or offline keeps the cached copy. Guarded by
# the goal, so no other target in any app ever pays for a network round trip.
ifneq ($(filter bundle-report,$(MAKECMDGOALS)),)
  ifeq ($(wildcard $(report_host)),)
    $(shell mkdir -p "$(ncmake_cache)"; curl -fsSL "$(report_url)" -o "$(report_host)" 2>/dev/null; test -s "$(report_host)" || rm -f "$(report_host)")
  else
    ifneq ($(shell find "$(report_host)" -mmin +$(NCMAKE_TTL_MIN) 2>/dev/null),)
      $(shell curl -fsSL --etag-compare "$(report_host).etag" --etag-save "$(report_host).etag" "$(report_url)" -o "$(report_host).new" 2>/dev/null; if [ -s "$(report_host).new" ]; then mv "$(report_host).new" "$(report_host)"; else rm -f "$(report_host).new"; fi; touch "$(report_host)")
    endif
  endif
endif

# The cache is mounted at /ncmake, read-only, alongside the app at /app. With
# RUNTIME=bare there is no container and the host path is used as it is; with no
# runtime at all $(node_run) carries the core's "install podman" abort.
ifeq ($(filter $(RUNTIME),bare none),)
  report_run  = $(container) -v "$(ncmake_cache)":/ncmake:ro $(node_image) sh -lc
  report_path = /ncmake/$(notdir $(report_host))
else
  report_run  = $(node_run)
  report_path = $(report_host)
endif

.PHONY: bundle-report

bundle-report:
	@test -s "$(report_host)" || { echo "ERROR: could not fetch $(report_url) - network?" >&2; exit 1; }
	@echo "==> bundle-report$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))"
	@$(report_run) 'BUNDLE_REPORT_CMDLINE="$(report_cmdline)" node $(report_path) $(ARGS)'

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

help::
	@echo ""
	@echo "$(ch)Bundle report (developer module):$(c0)"
	@echo "  $(ct)bundle-report$(c0)        What the browser loads per page, and which packages those bytes are"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-bundle-report$(c0)"
