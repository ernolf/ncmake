# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: the lint workflows of ncmake-workflows as make targets.
#
# Each lint workflow of ernolf/ncmake-workflows gets a target here of the same name,
# which collects the same files, runs the same tool in the same version and fails
# where the workflow fails. A finding so shows on the maintainer's machine before it
# shows in a public CI log, and gh-nc-appsdiag runs the targets with JSON= next to
# the audits. The tool version is pinned here and nowhere else.
#
# The targets read the checkout and write nothing into it, and none needs a token.
# make lint runs all of them.
#
# Names here must stay distinct from the other modules, which are read before and
# after this one and would otherwise overwrite its variables without a word.
# ncmake_libs is the exception and is appended to: it is the core's list.

# == lint-actions-security ==
# zizmor runs as the Linux binary of its GitHub release, checked against the digest
# GitHub shows for the asset, and not from its image ghcr.io/zizmorcore/zizmor: on
# an older x86-64 CPU such as the Pentium E5700 the binary in that image stops with
# an illegal instruction, while the release binary runs. It is fetched once per
# version into tools/ of the per-machine ncmake cache and mounted read-only into the
# analyser's Node container, which runs it; it needs glibc 2.34 or newer, which that
# image has.
zizmor_version        = 1.31.1
zizmor_sha256_x86_64  = d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99
zizmor_sha256_aarch64 = 37eebbd5762a44f262d94875431b14a6d2402991e90a685113ea97b8b41be833
zizmor_url            = https://github.com/zizmorcore/zizmor/releases/download/v$(zizmor_version)
lint_tools_dir        = $(ncmake_cache)/tools

# zizmor_fetch prints the directory that holds the zizmor binary. A version it
# supersedes is removed once no ncmake container runs, since a running one may have
# it mounted.
zizmor_fetch = sh -c ' \
	case "$$(uname -m)" in x86_64|amd64) arch=x86_64 sum=$(zizmor_sha256_x86_64) ;; aarch64|arm64) arch=aarch64 sum=$(zizmor_sha256_aarch64) ;; \
		*) echo "ERROR: zizmor has no Linux build for $$(uname -m)" >&2; exit 1 ;; esac; \
	dir=$(lint_tools_dir)/zizmor-$(zizmor_version)-$$arch; \
	if [ ! -x "$$dir/zizmor" ]; then \
		mkdir -p "$(lint_tools_dir)" && t=$$(mktemp -d "$(lint_tools_dir)/.fetch.XXXXXX") || exit 1; \
		echo "==> Fetching zizmor $(zizmor_version) for linux-$$arch from GitHub" >&2; f=zizmor-$$arch-unknown-linux-gnu.tar.gz; \
		if curl -fsSL $(curl_retry) "$(zizmor_url)/$$f" -o "$$t/$$f" && echo "$$sum  $$t/$$f" | sha256sum -c - >/dev/null \
			&& mkdir "$$t/zizmor" && tar -xzf "$$t/$$f" -C "$$t/zizmor" --no-same-owner zizmor; then \
			[ -e "$$dir" ] || mv "$$t/zizmor" "$$dir"; \
		else echo "==> Fetching zizmor $(zizmor_version) failed, or the download does not match its digest" >&2; fi; \
		rm -rf "$$t"; \
		if [ -x "$$dir/zizmor" ] && ! { for c in $(image_engines); do "$$c" ps -q --filter label=ncmake 2>/dev/null; done | grep -q .; }; then \
			for d in "$(lint_tools_dir)"/zizmor-*-$$arch; do [ "$$d" = "$$dir" ] || [ ! -d "$$d" ] || rm -rf "$$d"; done; \
		fi; \
	fi; \
	[ -x "$$dir/zizmor" ] || { echo "ERROR: no zizmor $(zizmor_version) for linux-$$arch on this host, and GitHub could not provide it" >&2; exit 1; }; \
	echo "$$dir"' zizmor-fetch

# What the analyser needs next to it, handed to the core's analyser library
# section: appended, never set, because every analyser module adds its own.
security_libs = lint-actions-security.mjs report-text.mjs
ncmake_libs += $(if $(filter lint-actions-security,$(MAKECMDGOALS)),$(security_libs))

# The analyser tells the reader how to run it again with other options, so the
# invocation is handed in as a template with %s for the options. The inner quotes
# are resolved by the shell that runs the analyser.
security_cmdline = make lint-actions-security ARGS=\"%s\"

# SARIF=<file> is mounted like JSON=<file>: the container sees only its own mounts,
# so the directory of the file is mounted writable and the analyser gets the path
# in there. The binary goes in the same way, read-only.
security_sarif_file  = $(abspath $(SARIF))
security_sarif_mkdir = $(if $(SARIF),mkdir -p "$(dir $(security_sarif_file))" && )
ifeq ($(filter $(RUNTIME),bare none),)
  security_sarif_arg = $(if $(SARIF),--sarif-file="/ncmake-sarif/$(notdir $(security_sarif_file))")
  security_run       = $(call ncmake_lib_in,$(lib_node_image),-v "$$zdir":/ncmake-zizmor:ro -e LINT_ACTIONS_SECURITY_ZIZMOR=/ncmake-zizmor/zizmor $(if $(SARIF),-v "$(dir $(security_sarif_file))":/ncmake-sarif))
else
  security_sarif_arg = $(if $(SARIF),--sarif-file="$(security_sarif_file)")
  security_run       = export LINT_ACTIONS_SECURITY_ZIZMOR="$$zdir/zizmor" && $(ncmake_lib_read_run)
endif

# A module is refreshed on its own terms, and an app that carries a committed core
# Makefile refreshes that one by hand - so the core here can be older than the
# analyser section this module expects. Say which side is behind rather than run an
# empty command.
lint_core = $(if $(and $(ncmake_lib_read_run),$(or $(filter bare none,$(RUNTIME)),$(value ncmake_lib_in))),$(if $(and $(JSON),$(if $(value ncmake_json_arg),,1)),echo "ERROR: JSON= needs a newer ncmake core - run 'make self-update'" >&2; exit 1,:),echo "ERROR: this module needs a newer ncmake core - run 'make self-update'" >&2; exit 1)

# == make lint ==
# Every target of this module, in the order make lint runs them.
lint_targets = lint-actions-security

.PHONY: lint $(lint_targets)

lint-actions-security:
	@$(lint_core)
	@$(call ncmake_lib_need,$(security_libs))
	@echo "==> lint-actions-security$(if $(strip $(ARGS)), $(ARGS)) (zizmor $(zizmor_version), RUNTIME=$(RUNTIME))" >&2
	@zdir=$$($(zizmor_fetch)) || exit 1; \
	$(security_sarif_mkdir)$(security_run) '$(call ncmake_lib_guard,lint-actions-security) LINT_ACTIONS_SECURITY_CMDLINE="$(security_cmdline)" node $(ncmake_lib_path)/lint-actions-security.mjs $(ARGS) $(ncmake_json_arg) $(security_sarif_arg)'

# Each target runs in a make of its own, so one that fails does not keep the next
# from running, and each fetches what its own goal needs.
lint:
	@if [ -n "$(strip $(ARGS)$(JSON)$(SARIF))" ]; then echo "ERROR: make lint runs several targets; give ARGS, JSON= and SARIF= to one of them, e.g. make lint-actions-security JSON=<file>" >&2; exit 1; fi
	@failed=; for t in $(lint_targets); do $(MAKE) --no-print-directory $$t || failed="$$failed $$t"; done; \
	if [ -n "$$failed" ]; then echo "==> make lint: failed:$$failed" >&2; exit 1; fi

define help_lint-actions-security
make lint-actions-security [ARGS="<options>"] [JSON=<file>] [SARIF=<file>]

Runs zizmor $(zizmor_version) over every tracked GitHub Actions workflow and action
definition, as the lint-actions-security workflow of ncmake-workflows does, and
fails where that workflow fails. zizmor finds what makes a workflow attackable:
pull_request_target or workflow_run running the code of a pull request,
$${{ github.event.* }} expanded into run:, an action not pinned to a commit,
permissions broader than the job needs, credentials that actions/checkout leaves
behind, cache poisoning in a release workflow.

The files are the tracked ones: everything under .github/workflows and
.ncmake/workflows, every action.yml or action.yaml outside node_modules/ and
vendor/, and every YAML file with a .properties.json beside it, the form of a
workflow template in ncmake-workflows. zizmor runs offline, needs no token, and
reads the repository's own .github/zizmor.yml or zizmor.yml when there is one.
A repository without workflows passes.

Findings of medium and high severity are [!] and exit 1; low and informational
ones are [i]. Each names the file and line, the zizmor audit and its page, which
says how to fix the finding or ignore it.

The zizmor binary is the one of its GitHub release, checked against its digest
and kept in tools/ of the ncmake cache. It runs in the throwaway Node container
of the analysers, so the host needs neither zizmor nor Node, and nothing is
written into the checkout.

ARGS is passed to the analyser; a bare word in it is the checkout to check
(default: the current directory):
  make lint-actions-security                       this repository
  make lint-actions-security ARGS=--details        and the files it checked
  make lint-actions-security ARGS=--persona=pedantic   zizmor's code smells too
  make lint-actions-security ARGS=--json > z.json  machine-readable, nothing else
  make lint-actions-security JSON=z.json           the report, and the JSON in z.json
  make lint-actions-security SARIF=z.sarif         the report, and SARIF for code scanning
  make lint-actions-security ARGS=--help           the analyser's own option list

JSON=<file> writes the JSON of ARGS=--json to <file> as well, from the same run.
Every finding in it is marked "security": true, because it says how a workflow
can be attacked. SARIF=<file> writes the findings in the form GitHub code
scanning reads. Both files can lie outside the checkout; each is replaced once it
is complete, and a run that stops on an error writes none.
endef

define help_lint
make lint

Runs every lint target of this module, one after the other, each the way it
runs alone: $(lint_targets). A target that finds nothing to check passes. A
failed target does not stop the next one, and make lint fails when one failed.

ARGS, JSON= and SARIF= belong to a single target; make lint refuses them.
endef

help::
	@echo ""
	@echo "$(ch)Lint (developer module):$(c0)"
	@echo "  $(ct)lint$(c0)                 Every lint target below, as the lint workflows run them"
	@echo "  $(ct)lint-actions-security$(c0) zizmor over the workflows: how they can be attacked"
	@echo "    $(cd)optional $(cv)JSON=<file> SARIF=<file>$(cd), see $(cv)make help-lint-actions-security$(c0)"
