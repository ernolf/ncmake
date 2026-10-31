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

# == Fetching the tools ==
# Every linter runs in the analyser's Node container, or on the host with
# RUNTIME=bare, from tools/ of the per-machine ncmake cache: fetched once per
# version, checked against its digest, and mounted read-only into the container.
# The host needs none of them. A version a newer one supersedes is removed once no
# ncmake container runs, since a running one may have it mounted.
lint_tools_dir  = $(ncmake_cache)/tools
lint_tools_idle = ! { for c in $(image_engines); do "$$c" ps -q --filter label=ncmake 2>/dev/null; done | grep -q .; }
lint_empty :=
lint_space := $(lint_empty) $(lint_empty)

# $(lint_bin_fetch) <name> <version> <release url> <asset x86_64> <sha256> <asset
# aarch64> <sha256> [<tar member>] prints the directory that holds the binary
# <name>, the Linux build of a GitHub release. Without a member the asset is the
# binary itself.
lint_bin_fetch = sh -c ' \
	name=$$1 ver=$$2 url=$$3 member=$$8; \
	case "$$(uname -m)" in x86_64|amd64) arch=x86_64 asset=$$4 sum=$$5 ;; aarch64|arm64) arch=aarch64 asset=$$6 sum=$$7 ;; \
		*) echo "ERROR: $$name has no Linux build for $$(uname -m)" >&2; exit 1 ;; esac; \
	dir=$(lint_tools_dir)/$$name-$$ver-$$arch; \
	if [ ! -x "$$dir/$$name" ]; then \
		mkdir -p "$(lint_tools_dir)" && t=$$(mktemp -d "$(lint_tools_dir)/.fetch.XXXXXX") || exit 1; \
		echo "==> Fetching $$name $$ver for linux-$$arch from GitHub" >&2; \
		if curl -fsSL $(curl_retry) "$$url/$$asset" -o "$$t/$$asset" && echo "$$sum  $$t/$$asset" | sha256sum -c - >/dev/null \
			&& mkdir "$$t/x" "$$t/bin" \
			&& if [ -n "$$member" ]; then tar -xf "$$t/$$asset" -C "$$t/x" --no-same-owner "$$member" && mv "$$t/x/$$member" "$$t/bin/$$name"; \
				else mv "$$t/$$asset" "$$t/bin/$$name"; fi \
			&& chmod 755 "$$t/bin/$$name"; then \
			[ -e "$$dir" ] || mv "$$t/bin" "$$dir"; \
		else echo "==> Fetching $$name $$ver failed, or the download does not match its digest" >&2; fi; \
		rm -rf "$$t"; \
		if [ -x "$$dir/$$name" ] && $(lint_tools_idle); then \
			for d in "$(lint_tools_dir)/$$name"-*-$$arch; do [ "$$d" = "$$dir" ] || [ ! -d "$$d" ] || rm -rf "$$d"; done; \
		fi; \
	fi; \
	[ -x "$$dir/$$name" ] || { echo "ERROR: no $$name $$ver for linux-$$arch on this host, and GitHub could not provide it" >&2; exit 1; }; \
	echo "$$dir"' lint-bin-fetch

# $(lint_py_fetch) <name> <version> {<path> <sha256> <member>}... prints a
# directory to put on PYTHONPATH: the members of source distributions from PyPI,
# each the import package of a pure-Python project, which so needs no pip. <path>
# is the one below packages/source/ of files.pythonhosted.org.
lint_py_fetch = sh -c ' \
	name=$$1 ver=$$2; shift 2; dir=$(lint_tools_dir)/$$name-$$ver; \
	if [ ! -f "$$dir/.complete" ]; then \
		mkdir -p "$(lint_tools_dir)" && t=$$(mktemp -d "$(lint_tools_dir)/.fetch.XXXXXX") || exit 1; \
		echo "==> Fetching $$name $$ver from PyPI" >&2; ok=1; mkdir "$$t/x" "$$t/py"; \
		while [ $$\# -ge 3 ]; do \
			f=$${1\#\#*/}; \
			curl -fsSL $(curl_retry) "https://files.pythonhosted.org/packages/source/$$1" -o "$$t/$$f" && echo "$$2  $$t/$$f" | sha256sum -c - >/dev/null \
				&& tar -xzf "$$t/$$f" -C "$$t/x" --no-same-owner "$$3" && mv "$$t/x/$$3" "$$t/py/" || { ok=; break; }; \
			shift 3; \
		done; \
		if [ -n "$$ok" ] && touch "$$t/py/.complete"; then [ -e "$$dir" ] || mv "$$t/py" "$$dir"; \
		else echo "==> Fetching $$name $$ver failed, or a download does not match its digest" >&2; fi; \
		rm -rf "$$t"; \
		if [ -f "$$dir/.complete" ] && $(lint_tools_idle); then \
			for d in "$(lint_tools_dir)/$$name"-*; do [ "$$d" = "$$dir" ] || [ ! -d "$$d" ] || rm -rf "$$d"; done; \
		fi; \
	fi; \
	[ -f "$$dir/.complete" ] || { echo "ERROR: no $$name $$ver on this host, and PyPI could not provide it" >&2; exit 1; }; \
	echo "$$dir"' lint-py-fetch

# $(call lint_npm_fetch,<group>,<packages>) sets npmdir to the directory whose
# node_modules holds the npm packages, each pinned to a version; npm checks every
# tarball against the integrity the registry records. npm runs in the analyser's
# Node container, so the host needs no Node. A recipe fragment, not a command:
# the container call carries quotes of its own. npm runs in the tools directory,
# so it reads no .npmrc of the checkout; its summary on stdout is dropped, its
# errors on stderr are not.
lint_npm_key   = $(1)-$(subst /,-,$(subst @,-,$(subst $(lint_space),+,$(patsubst @%,%,$(strip $(2))))))
lint_npm_flags = --no-audit --no-fund --no-package-lock --loglevel=error --update-notifier=false
ifeq ($(filter $(RUNTIME),bare none),)
  lint_npm_in     = $(call node_in,$(lib_node_image),lts,-v "$(lint_tools_dir)":/ncmake-tools) sh -lc
  lint_npm_prefix = /ncmake-tools
else ifeq ($(RUNTIME),bare)
  lint_npm_in     = sh -lc
  lint_npm_prefix = $(lint_tools_dir)
else
  lint_npm_in     = $(no_runtime)
  lint_npm_prefix = $(lint_tools_dir)
endif
lint_npm_fetch = npmdir="$(lint_tools_dir)/$(call lint_npm_key,$(1),$(2))"; \
	if [ ! -f "$$npmdir/.complete" ]; then \
		mkdir -p "$(lint_tools_dir)" && t=$$(mktemp -d "$(lint_tools_dir)/.fetch.XXXXXX") || exit 1; \
		echo "==> Installing $(strip $(2)) from npm" >&2; \
		if $(lint_npm_in) 'cd "$(lint_npm_prefix)" && npm install --prefix "$(lint_npm_prefix)/'"$${t\#\#*/}"'" $(lint_npm_flags) $(strip $(2))' >/dev/null && touch "$$t/.complete"; then \
			[ -e "$$npmdir" ] || mv "$$t" "$$npmdir"; \
		else echo "==> Installing $(strip $(2)) failed" >&2; fi; \
		rm -rf "$$t"; \
		if [ -f "$$npmdir/.complete" ] && $(lint_tools_idle); then \
			for d in "$(lint_tools_dir)/$(1)"-*; do [ "$$d" = "$$npmdir" ] || [ ! -d "$$d" ] || rm -rf "$$d"; done; \
		fi; \
	fi; \
	[ -f "$$npmdir/.complete" ] || { echo "ERROR: no $(strip $(2)) on this host, and npm could not provide it" >&2; exit 1; }

# == Running an analyser ==
# $(call lint_tool,<variable>,<shell variable>,<path>) hands the analyser a tool
# from the directory a fetcher printed into <shell variable>: the directory is
# mounted read-only and <variable> names <path> in it. npm packages are mounted as
# /node_modules, where Node looks last for a package that a configuration in the
# checkout imports, so a repository configuration finds them without anything
# written into the checkout. $(call lint_node,<target>,<tools>) runs the analyser
# of <target> with them.
ifeq ($(filter $(RUNTIME),bare none),)
  lint_tool    = -v "$$$(2)":/ncmake-$(2):ro -e $(1)=/ncmake-$(2)/$(3)
  lint_modules = -v "$$npmdir/node_modules":/node_modules:ro -e LINT_MODULES=/node_modules
  lint_run     = $(call ncmake_lib_in,$(lib_node_image),$(1))
else
  lint_tool    = $(1)="$$$(2)/$(3)"
  lint_modules = LINT_MODULES="$$npmdir/node_modules"
  lint_run     = $(if $(strip $(1)),export $(1) && )$(ncmake_lib_read_run)
endif

# The analyser tells the reader how to run it again with other options, so the
# invocation is handed in as a template with %s for the options. The inner quotes
# are resolved by the shell that runs the analyser.
lint_cmdline = make $(1) ARGS=\"%s\"
lint_node    = $(call lint_run,$(2)) '$(call ncmake_lib_guard,$(1)) LINT_CMDLINE="$(call lint_cmdline,$(1))" node $(ncmake_lib_path)/$(1).mjs $(ARGS) $(ncmake_json_arg)'

# What an analyser needs next to it, handed to the core's analyser library
# section: appended, never set, because every analyser module adds its own.
lint_libs = lint-common.mjs report-text.mjs

# == lint-actions-security ==
# zizmor runs as the Linux binary of its GitHub release, and not from its image
# ghcr.io/zizmorcore/zizmor: on an older x86-64 CPU such as the Pentium E5700 the
# binary in that image stops with an illegal instruction, while the release binary
# runs. It needs glibc 2.34 or newer, which the analyser's Node image has.
zizmor_version        = 1.31.1
zizmor_sha256_x86_64  = d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99
zizmor_sha256_aarch64 = 37eebbd5762a44f262d94875431b14a6d2402991e90a685113ea97b8b41be833
zizmor_url            = https://github.com/zizmorcore/zizmor/releases/download/v$(zizmor_version)
lint_zizmor           = zizmor $(zizmor_version) $(zizmor_url) \
	zizmor-x86_64-unknown-linux-gnu.tar.gz $(zizmor_sha256_x86_64) zizmor-aarch64-unknown-linux-gnu.tar.gz $(zizmor_sha256_aarch64) zizmor

# Its analyser has a report of its own and needs no lint-common.mjs.
security_libs = lint-actions-security.mjs report-text.mjs
ncmake_libs += $(if $(filter lint-actions-security,$(MAKECMDGOALS)),$(security_libs))

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

# == lint-actions ==
# actionlint calls shellcheck on the run: scripts, so it gets the same shellcheck
# as lint-shell.
actionlint_version        = 1.7.12
actionlint_sha256_x86_64  = 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
actionlint_sha256_aarch64 = 325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
lint_actionlint           = actionlint $(actionlint_version) https://github.com/rhysd/actionlint/releases/download/v$(actionlint_version) \
	actionlint_$(actionlint_version)_linux_amd64.tar.gz $(actionlint_sha256_x86_64) actionlint_$(actionlint_version)_linux_arm64.tar.gz $(actionlint_sha256_aarch64) actionlint

# == lint-shell ==
shellcheck_version        = 0.11.0
shellcheck_sha256_x86_64  = b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6
shellcheck_sha256_aarch64 = 68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc
lint_shellcheck           = shellcheck $(shellcheck_version) https://github.com/koalaman/shellcheck/releases/download/v$(shellcheck_version) \
	shellcheck-v$(shellcheck_version).linux.x86_64.tar.gz $(shellcheck_sha256_x86_64) shellcheck-v$(shellcheck_version).linux.aarch64.tar.gz $(shellcheck_sha256_aarch64) \
	shellcheck-v$(shellcheck_version)/shellcheck

# == lint-containerfiles ==
# hadolint's release assets are the binaries themselves.
hadolint_version        = 2.15.1
hadolint_sha256_x86_64  = c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
hadolint_sha256_aarch64 = f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d
lint_hadolint           = hadolint $(hadolint_version) https://github.com/hadolint/hadolint/releases/download/v$(hadolint_version) \
	hadolint-linux-x86_64 $(hadolint_sha256_x86_64) hadolint-linux-arm64 $(hadolint_sha256_aarch64)

# == lint-yaml ==
# yamllint and the two packages it imports are pure Python, so their source
# distributions run as they are on the Python of the analyser's Node image.
yamllint_version = 1.38.0
lint_yamllint    = yamllint $(yamllint_version) \
	y/yamllint/yamllint-$(yamllint_version).tar.gz 09e5f29531daab93366bb061e76019d5e91691ef0a40328f04c927387d1d364d yamllint-$(yamllint_version)/yamllint \
	p/pathspec/pathspec-1.1.1.tar.gz 17db5ecd524104a120e173814c90367a96a98d07c45b2e10c2f3919fff91bf5a pathspec-1.1.1/pathspec \
	p/pyyaml/pyyaml-6.0.3.tar.gz d76623373421df22fb4cf8817020cbb7ef15c725b9d5e45f17e189bfc384190f pyyaml-6.0.3/lib/yaml

# == lint-markdown and lint-web ==
lint_markdown_npm = markdownlint-cli2@0.24.0
lint_web_npm      = eslint@10.13.0 @eslint/js@10.0.1 globals@17.13.0 \
	stylelint@17.16.0 stylelint-config-standard@40.0.0 html-validate@11.17.0

# == lint-php-syntax ==
# The PHP versions come from PHP_VERSIONS, a .php-version file or the default, as
# in the workflow. Only a word of digits and dots is a version: the words are
# written into the recipe, and a .php-version is part of the checkout, which may be
# someone else's.
lint_php_default = 8.2 8.4
lint_comma      := ,
lint_php_given   = $(or $(strip $(subst ;, ,$(subst $(lint_comma), ,$(PHP_VERSIONS)))),$(strip $(subst ;, ,$(subst $(lint_comma), ,$(if $(wildcard .php-version),$(shell cat .php-version))))),$(lint_php_default))
lint_php_digits  = $(subst .,,$(subst 0,,$(subst 1,,$(subst 2,,$(subst 3,,$(subst 4,,$(subst 5,,$(subst 6,,$(subst 7,,$(subst 8,,$(subst 9,,$(1))))))))))))
lint_php_versions = $(foreach v,$(lint_php_given),$(if $(call lint_php_digits,$(v)),,$(if $(subst .,,$(v)),$(v))))
# php -l per version over the tracked files on stdin, the exact version first. The
# image is the plain PHP image: php -l needs no extension. With RUNTIME=bare the
# host's php<version> runs, or its php when that is the version; without either
# the run reports that the version did not run.
lint_php_lint = "$$p" -r "echo PHP_VERSION, PHP_EOL;" && xargs -0 -r -n 1 -P 4 "$$p" -d display_errors=1 -d log_errors=0 -d error_reporting=-1 -l
ifeq ($(filter $(RUNTIME),bare none),)
  lint_php_run = $(call container_run,docker.io/library/php:$(1)-cli-alpine,-i) sh -c 'p=php; $(lint_php_lint)'
else ifeq ($(RUNTIME),bare)
  lint_php_run = sh -c 'p=php$(1); command -v "$$p" >/dev/null || p=php; \
		case "$$("$$p" -r "echo PHP_VERSION;" 2>/dev/null)" in $(1)|$(1).*) ;; *) echo "no php$(1) on this host, and its php is no PHP $(1)"; exit 1 ;; esac; $(lint_php_lint)'
else
  lint_php_run = $(no_runtime)
endif

# == make lint ==
# Every target of this module, in the order make lint runs them.
lint_targets = lint-actions lint-actions-security lint-containerfiles lint-markdown lint-php-syntax lint-shell lint-vue-imports lint-web lint-yaml
lint_plain   = $(filter-out lint-actions-security,$(lint_targets))
ncmake_libs += $(foreach t,$(filter $(lint_plain),$(MAKECMDGOALS)),$(t).mjs $(lint_libs))

.PHONY: lint $(lint_targets)

# The banner every target prints first.
lint_banner = echo "==> $(1)$(if $(strip $(ARGS)), $(ARGS)) ($(2), RUNTIME=$(RUNTIME))" >&2

lint-actions:
	@$(lint_core)
	@$(call ncmake_lib_need,$@.mjs $(lint_libs))
	@$(call lint_banner,$@,actionlint $(actionlint_version) with shellcheck $(shellcheck_version))
	@adir=$$($(lint_bin_fetch) $(lint_actionlint)) && sdir=$$($(lint_bin_fetch) $(lint_shellcheck)) || exit 1; \
	$(call lint_node,$@,$(call lint_tool,LINT_ACTIONLINT,adir,actionlint) $(call lint_tool,LINT_SHELLCHECK,sdir,shellcheck))

lint-containerfiles:
	@$(lint_core)
	@$(call ncmake_lib_need,$@.mjs $(lint_libs))
	@$(call lint_banner,$@,hadolint $(hadolint_version))
	@hdir=$$($(lint_bin_fetch) $(lint_hadolint)) || exit 1; \
	$(call lint_node,$@,$(call lint_tool,LINT_HADOLINT,hdir,hadolint))

lint-markdown:
	@$(lint_core)
	@$(call ncmake_lib_need,$@.mjs $(lint_libs))
	@$(call lint_banner,$@,$(lint_markdown_npm))
	@$(call lint_npm_fetch,markdown,$(lint_markdown_npm)); \
	$(call lint_node,$@,$(lint_modules))

# The files are listed and linted outside the analyser, which then reads one
# output per version from a directory of its own.
lint-php-syntax:
	@$(lint_core)
	@$(call ncmake_lib_need,$@.mjs $(lint_libs))
	@$(if $(filter-out $(lint_php_versions),$(lint_php_given)),echo "ERROR: PHP_VERSIONS or .php-version holds a word that is no PHP version (digits and dots, as in 8.2)" >&2; exit 1,:)
	@$(call lint_banner,$@,PHP $(lint_php_versions))
	@pdir=$$(mktemp -d) && trap 'rm -rf "$$pdir"' EXIT && mkdir "$$pdir/runs" \
		&& git -c safe.directory='*' ls-files -z -- '*.php' '*.phtml' > "$$pdir/files" || exit 1; \
	if [ -s "$$pdir/files" ]; then :; $(foreach v,$(lint_php_versions),$(call lint_php_run,$(v)) < "$$pdir/files" > "$$pdir/runs/$(v).out" 2>&1; echo $$? > "$$pdir/runs/$(v).rc";) fi; \
	$(call lint_node,$@,$(call lint_tool,LINT_PHP_OUTPUT,pdir,runs))

lint-shell:
	@$(lint_core)
	@$(call ncmake_lib_need,$@.mjs $(lint_libs))
	@$(call lint_banner,$@,shellcheck $(shellcheck_version))
	@sdir=$$($(lint_bin_fetch) $(lint_shellcheck)) || exit 1; \
	$(call lint_node,$@,$(call lint_tool,LINT_SHELLCHECK,sdir,shellcheck))

lint-vue-imports:
	@$(lint_core)
	@$(call ncmake_lib_need,$@.mjs $(lint_libs))
	@$(call lint_banner,$@,the root-import pattern)
	@$(call lint_node,$@,)

lint-web:
	@$(lint_core)
	@$(call ncmake_lib_need,$@.mjs $(lint_libs))
	@$(call lint_banner,$@,$(lint_web_npm))
	@$(call lint_npm_fetch,web,$(lint_web_npm)); \
	$(call lint_node,$@,$(lint_modules))

lint-yaml:
	@$(lint_core)
	@$(call ncmake_lib_need,$@.mjs $(lint_libs))
	@$(call lint_banner,$@,yamllint $(yamllint_version))
	@ydir=$$($(lint_py_fetch) $(lint_yamllint)) || exit 1; \
	$(call lint_node,$@,$(call lint_tool,LINT_YAMLLINT,ydir,.))

lint-actions-security:
	@$(lint_core)
	@$(call ncmake_lib_need,$(security_libs))
	@echo "==> lint-actions-security$(if $(strip $(ARGS)), $(ARGS)) (zizmor $(zizmor_version), RUNTIME=$(RUNTIME))" >&2
	@zdir=$$($(lint_bin_fetch) $(lint_zizmor)) || exit 1; \
	$(security_sarif_mkdir)$(security_run) '$(call ncmake_lib_guard,lint-actions-security) LINT_ACTIONS_SECURITY_CMDLINE="$(security_cmdline)" node $(ncmake_lib_path)/lint-actions-security.mjs $(ARGS) $(ncmake_json_arg) $(security_sarif_arg)'

# Each target runs in a make of its own, so one that fails does not keep the next
# from running, and each fetches what its own goal needs. The sub-make reads the
# makefile this one was given with -f, as the workflows' bootstrap is.
lint:
	@if [ -n "$(strip $(ARGS)$(JSON)$(SARIF))" ]; then echo "ERROR: make lint runs several targets; give ARGS, JSON= and SARIF= to one of them, e.g. make lint-actions-security JSON=<file>" >&2; exit 1; fi
	@failed=; for t in $(lint_targets); do $(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory $$t || failed="$$failed $$t"; done; \
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

# The part every help text of a target here ends with.
define lint_help_common
The files are the tracked ones; nothing is written into the checkout, and no
token is needed. The tool runs in the throwaway Node container of the
analysers, so the host needs neither the tool nor Node. Every finding names the
file and line, the rule and the page that explains it; [!] fails the check and
exits 1, [i] does not.

ARGS is passed to the analyser; a bare word in it is the checkout to check
(default: the current directory):
  this repository                 make $(1)
  and the files it checked        make $(1) ARGS=--details
  machine-readable, nothing else  make $(1) ARGS=--json > l.json
  the report, JSON in l.json      make $(1) JSON=l.json
  the analyser's own options      make $(1) ARGS=--help

JSON=<file> writes the JSON of ARGS=--json to <file> as well, from the same
run. The file can lie outside the checkout; it is replaced once it is
complete, and a run that stops on an error writes none.
endef

define help_lint-actions
make lint-actions [ARGS="<options>"] [JSON=<file>]

Runs actionlint $(actionlint_version), with shellcheck $(shellcheck_version) over the
scripts of run: steps, over every tracked GitHub Actions workflow, as the
lint-actions workflow of ncmake-workflows does, and fails where that workflow
fails. The workflows are everything under .github/workflows and
.ncmake/workflows, and every YAML file with a .properties.json beside it, the
form of a workflow template in ncmake-workflows. actionlint reads the
repository's .github/actionlint.yaml or .yml. A repository without workflows
passes.

Both binaries are the ones of their GitHub releases, checked against their
digests and kept in tools/ of the ncmake cache.

$(call lint_help_common,lint-actions)
endef

define help_lint-containerfiles
make lint-containerfiles [ARGS="<options>"] [JSON=<file>]

Runs hadolint $(hadolint_version), with shellcheck over the RUN instructions built
in, over every tracked Containerfile and Dockerfile outside node_modules/ and
vendor/, as the lint-containerfiles workflow of ncmake-workflows does, and
fails where that workflow fails. hadolint reads the repository's .hadolint.yaml
or .hadolint.yml; its failure-threshold decides what is [!], info unless it is
set. A repository without Containerfiles passes.

The binary is the one of hadolint's GitHub release, checked against its digest
and kept in tools/ of the ncmake cache.

$(call lint_help_common,lint-containerfiles)
endef

define help_lint-markdown
make lint-markdown [ARGS="<options>"] [JSON=<file>]

Runs $(lint_markdown_npm) over every tracked Markdown file outside
node_modules/ and vendor/, as the lint-markdown workflow of ncmake-workflows
does, and fails where that workflow fails. A markdownlint configuration of the
repository wins; without one the workflow's default applies: every rule except
line length, blank lines in a block quote, inline HTML, a first line that is no
heading, link fragments and table column style, and a heading may repeat under
another parent, as a changelog repeats its sections in every release. A
repository without Markdown passes.

The package comes from npm, checked against the integrity npm records, and is
kept in tools/ of the ncmake cache.

$(call lint_help_common,lint-markdown)
endef

define help_lint-php-syntax
make lint-php-syntax [PHP_VERSIONS="<versions>"] [ARGS="<options>"] [JSON=<file>]

Runs php -l over every tracked PHP file, once per PHP version, as the
lint-php-syntax workflow of ncmake-workflows does, and fails where that
workflow fails: on a parse or fatal error under any of the versions. A warning
or deprecation php -l prints is [i]. The versions are, in this order, those of
PHP_VERSIONS, those of a .php-version file in the checkout, or
$(lint_php_default); they are separated by spaces, commas or semicolons, and
only digits and dots make a version. A repository without PHP files passes.

Each version runs in a throwaway container of docker.io/library/php:<version>-cli-alpine;
with RUNTIME=bare the host's php<version> runs, or its php when that is the
version.
  make lint-php-syntax PHP_VERSIONS="8.1 8.5"   other versions

$(call lint_help_common,lint-php-syntax)
endef

define help_lint-shell
make lint-shell [ARGS="<options>"] [JSON=<file>]

Runs shellcheck $(shellcheck_version) with -x, which follows a sourced file, over
every tracked shell script, as the lint-shell workflow of ncmake-workflows does,
and fails where that workflow fails: on every finding shellcheck reports. A
shell script is a file named *.sh or *.bash, or one whose first line is a
shebang that names sh, bash, dash or ksh. shellcheck reads the repository's
.shellcheckrc. A repository without shell scripts passes.

The binary is the one of shellcheck's GitHub release, checked against its
digest and kept in tools/ of the ncmake cache.

$(call lint_help_common,lint-shell)
endef

define help_lint-vue-imports
make lint-vue-imports [ARGS="<options>"] [JSON=<file>]

Finds every import of the root of @nextcloud/vue in the tracked Vue,
JavaScript and TypeScript files outside node_modules/ and vendor/, as the
lint-vue-imports workflow of ncmake-workflows does, and fails where that
workflow fails. The root loads the whole component library into the bundle;
an entry point such as @nextcloud/vue/components/NcButton loads one component.
A static or dynamic import, a re-export, a require and a vi.mock or jest.mock
of the root all count. A repository without such files passes.

$(call lint_help_common,lint-vue-imports)
endef

define help_lint-web
make lint-web [ARGS="<options>"] [JSON=<file>]

Runs ESLint over the JavaScript, Stylelint over the CSS and html-validate over
the HTML of a repository without a package.json, as the lint-web workflow of
ncmake-workflows does, and fails where that workflow fails: on an error of any
of them. The files are the tracked ones outside node_modules/ and vendor/,
without minified copies. A configuration of the repository for a linter wins;
without one the workflow's default applies: ESLint's recommended rules with
the browser globals, stylelint-config-standard, html-validate's recommended
preset. A repository with a package.json lints through its own scripts and
passes here, as it passes the workflow.

The packages, $(lint_web_npm), come from npm, checked against the integrity
npm records, and are kept in tools/ of the ncmake cache. A configuration of the
repository can import them.

$(call lint_help_common,lint-web)
endef

define help_lint-yaml
make lint-yaml [ARGS="<options>"] [JSON=<file>]

Runs yamllint $(yamllint_version) over every tracked YAML file, as the lint-yaml
workflow of ncmake-workflows does, and fails where that workflow fails. A
.yamllint, .yamllint.yaml or .yamllint.yml of the repository wins; without one
the workflow's default applies: yamllint's default, with true and false as the
only truthy values, keys not checked for them, and neither line length nor
document start. A repository without YAML passes.

yamllint and the two packages it needs are the source distributions from PyPI,
checked against their digests and kept in tools/ of the ncmake cache; they run
on the Python of the analysers' container.

$(call lint_help_common,lint-yaml)
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
	@echo "  $(ct)lint-actions$(c0)         actionlint over the workflows: are they valid"
	@echo "  $(ct)lint-actions-security$(c0) zizmor over the workflows: how they can be attacked"
	@echo "    $(cd)optional $(cv)SARIF=<file>$(cd), see $(cv)make help-lint-actions-security$(c0)"
	@echo "  $(ct)lint-containerfiles$(c0)  hadolint over the Containerfiles"
	@echo "  $(ct)lint-markdown$(c0)        markdownlint over the Markdown files"
	@echo "  $(ct)lint-php-syntax$(c0)      php -l over the PHP files, per PHP version"
	@echo "    $(cd)optional $(cv)PHP_VERSIONS=\"8.2 8.4\"$(cd), see $(cv)make help-lint-php-syntax$(c0)"
	@echo "  $(ct)lint-shell$(c0)           shellcheck over the shell scripts"
	@echo "  $(ct)lint-vue-imports$(c0)     imports of the @nextcloud/vue root"
	@echo "  $(ct)lint-web$(c0)             ESLint, Stylelint, html-validate without a package.json"
	@echo "  $(ct)lint-yaml$(c0)            yamllint over the YAML files"
	@echo "    $(cd)each takes $(cv)ARGS=\"<options>\" JSON=<file>$(cd), see $(cv)make help-<target>$(c0)"
