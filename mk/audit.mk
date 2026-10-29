# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: six checks on a checkout.
#
# consistency-audit reads the metadata of a checkout and holds the statements it
# finds against each other: the version in appinfo/info.xml against the one in
# package.json, the PHP floor in info.xml against composer.json, the Node version
# in package.json against .nvmrc and against the installed workflows. To that it
# adds what a release needs and a checkout can be missing - the link from a
# published version back to its source, a server range that names a server that
# exists, a lockfile, a linter that a script calls but no configuration backs.
# Metadata only: it builds nothing and installs nothing. From the network make reads
# the server majors and the Node schedule, and the analyser asks whether the links
# of info.xml answer, which NO_NETWORK=1 leaves out.
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
# deps-audit asks the package managers' own audits whether a dependency that
# ships has a published vulnerability: composer audit over composer.lock in the
# build image of the PHP floor, and the audit of npm, pnpm or yarn over the npm
# lock file on the Node the app declares, dev dependencies left out on both
# sides. For each vulnerable package it names the release that fixes it and
# whether the declared constraints let an update reach that release. The same
# packages are held against the licence in appinfo/info.xml, by the licence
# table lib/licences.json. It reads the advisories from the network, writes its
# report to build/reports and exits 0 with findings: the gates are workflows of
# ernolf/ncmake-workflows.
#
# secrets-audit asks gitleaks whether a key or a token is in what the release
# ships, or anywhere in the history of the checkout, and names a key, a key store,
# an .env file, the auth.json of composer and an .npmrc with a credential by their
# names as well. make tag and make dist run it on what ships through the core's
# ship_check and stop on a finding. secrets-ignore lists its findings and adds
# the fingerprints of those the maintainer marks as false positives to
# .gitleaksignore, with a comment that says why. gitleaks is the binary of its GitHub release,
# checked against its digest and kept in tools/ of the ncmake cache, fetched with
# the fetcher of the lint module.
#
# This is its own module rather than a third target in mk/bundle.mk because a
# module file cannot be renamed: the core includes every *.mk-<ref> it finds in the
# per-machine cache and dev-init only ever adds files, so a renamed bundle.mk would
# stay behind in every existing cache and define its targets a second time. The
# separate file costs nothing beyond its own header: fetching the analysers is the
# core's, under "Analyser libraries" there.
#
# The same discovery rule is why build-verify, changelog-lint, php-compat, deps-audit and secrets-audit are
# targets in this file and not modules of their own: a new module file reaches a machine only on the
# next dev-init, while a target added to a file the cache already holds arrives with
# the next refresh.
#
# Names here must stay distinct from mk/bundle.mk: that file is read after this one
# and would otherwise overwrite this module's variables without a word. ncmake_libs
# is the exception and is appended to rather than set - it is the core's list, and
# every analyser module adds to it.

# == Analyser configuration ==
# What each analyser needs next to it. bundler-config.mjs reads the bundler and its
# config, report-text.mjs prints; the analyser itself decides what is worth saying.
consistency_libs = consistency-audit.mjs report-text.mjs
verify_libs      = build-verify.mjs bundler-config.mjs report-text.mjs
changelog_libs   = changelog-lint.mjs report-text.mjs
compat_libs      = php-compat.mjs report-text.mjs
deps_libs        = deps-audit.mjs deps-audit.php licences.json report-text.mjs
secrets_libs     = secrets-audit.mjs report-text.mjs

# What the goals on this command line need, handed to the core's analyser library
# section: appended, never set, because every analyser module adds its own.
ncmake_libs += $(if $(filter consistency-audit,$(MAKECMDGOALS)),$(consistency_libs)) $(if $(filter build-verify,$(MAKECMDGOALS)),$(verify_libs)) $(if $(filter changelog-lint,$(MAKECMDGOALS)),$(changelog_libs)) $(if $(filter php-compat,$(MAKECMDGOALS)),$(compat_libs)) $(if $(filter deps-audit,$(MAKECMDGOALS)),$(deps_libs)) $(if $(filter secrets-audit,$(MAKECMDGOALS)),$(secrets_libs))

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
consistency_nc_master = $(shell curl -fsSL $(curl_retry) "$(nc_server_raw)/master/version.php" 2>/dev/null | sed -n 's/^\$$OC_Version[^0-9]*\([0-9]*\).*/\1/p' | head -1)

# The newest major nextcloud/server has released, the highest major among its
# release tags vX.Y.Z; a tag with a beta or rc suffix is no release. The App Store
# rules let a <nextcloud max-version> reach one major beyond it. Read and, where it
# cannot be read, left to the analyser like the master major.
consistency_nc_newest = $(shell $(net_retry); t=$$(net_retry git ls-remote --tags --refs https://github.com/nextcloud/server.git 'v*') && printf '%s\n' "$$t" | sed -n 's|.*refs/tags/v\([0-9]*\)\.[0-9]*\.[0-9]*$$|\1|p' | sort -n | tail -1)

# The Node.js release schedule the core picks the build Node from, so the audit
# can tell when engines.node admits only end-of-life lines. It is handed in as one
# word per line, v<major>=<start>,<lts>,<end>, which needs no quoting in the
# recipe. Read only for an app with a package.json; where it cannot be read it
# stays empty and the analyser falls back on its own snapshot.
consistency_node_schedule = $(if $(wildcard package.json),$(shell curl -fsSL "$(node_schedule_url)" 2>/dev/null | python3 -c 'import json,sys; s=json.load(sys.stdin); print(" ".join(k+"="+",".join(s[k].get(f,"") for f in ("start","lts","end")) for k in sorted(s) if k[:1]=="v" and k[1:].isdigit()))' 2>/dev/null))

# The paths a release ships, so the audit can name a directory the app reads at run
# time that the tarball lacks. The patterns as the core packs them, keep_extra
# included, not what exists of them: the audit decides what a path covers.
consistency_keep = $(keep_dirs) $(keep_files) $(keep_extra)

# The verifier prints how to run it again as well, and has nothing to say about the
# name of the checkout: it names the root it resolved, which inside the container
# is the mount point, so no second variable is handed in.
verify_cmdline = make build-verify ARGS=\"%s\"
changelog_cmdline = make changelog-lint ARGS=\"%s\"
compat_cmdline    = make php-compat ARGS=\"%s\"
deps_cmdline      = make deps-audit ARGS=\"%s\"
secrets_cmdline   = make secrets-audit ARGS=\"%s\"

# In a container the scratch tree is in the container's own /tmp and goes with it,
# so the verifier must neither offer to keep it nor name it as kept. The condition
# is the one under which the core runs the analysers in a container.
verify_transient = $(if $(filter $(RUNTIME),bare none),,BUILD_VERIFY_TRANSIENT=1)

# A module is refreshed on its own terms, and an app that carries a committed core
# Makefile refreshes that one by hand - so the core here can be older than the
# analyser section this module expects. Say which side is behind rather than run an
# empty command.
audit_core = $(if $(ncmake_lib_read_run),$(if $(and $(JSON),$(if $(value ncmake_json_arg),,1)),echo "ERROR: JSON= needs a newer ncmake core - run 'make self-update'" >&2; exit 1,:),echo "ERROR: this module needs a newer ncmake core - run 'make self-update'" >&2; exit 1)

# make tag checks the changelog the way the App Store reads it rather than by the
# core's heading grep. A second make, so that the goal changelog-lint fetches the
# analyser it needs.
tag_check = $(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory changelog-lint || { echo "ERROR: make tag stops on the [!] findings above - fix the changelog, or tag regardless with NO_CHANGELOG_LINT=1." >&2; exit 1; }

# php-compat needs the PHP ceiling and a build image per PHP minor from the core.
compat_core = $(if $(value php_server_max),:,echo "ERROR: php-compat needs a newer ncmake core - run 'make self-update'" >&2; exit 1)

# The newest PHP minor any Nextcloud server runs on, the ceiling of master. Called
# without a major, the core's nc_php_ceiling reads master, as it does for an app
# without a <nextcloud max-version>. A <php max-version> raises the ceiling no further than
# this: no server has run the app on a newer PHP, and the analyser reports the
# declaration instead of a run that could not be checked.
compat_master = $(if $(nc_max),$(call nc_php_ceiling,),$(php_server_max))

# Each minor runs in a make of its own, because the build image is chosen while a
# make reads its variables: php_version picks the minor, PHP=min the build image
# rather than analysis_image. A php_image of one's own names a single minor, so the
# published image stands in for it; a host that builds its images locally keeps
# doing so. The run records the PHP it actually ran on, so the analyser can tell a
# runtime that ignores the minor, RUNTIME=bare above all, from one that did not.
compat_dir   = build/php-compat
compat_image = $(if $(filter local,$(php_floor_mode)),localhost,ghcr.io/ernolf)/ncmake-php
# The PHP ahead of master runs once more, in the image the ncmake-images repository
# publishes for it: <minor>-next for a <php max-version> above master, next, the
# newest minor it publishes, for NEXT=1. Only the published image carries that
# PHP, as php_base_image names no alpha, beta or RC, so php_floor_mode is emptied and
# the run uses it as an image of one's own, with nothing built in its place.
compat_next  = ghcr.io/ernolf/ncmake-php
# Every PHP file that ships, linted by as many PHP processes as the runtime has
# processors. busybox xargs stops at the first command that fails, and php -l fails
# on every file it cannot parse, so each batch exits 0 and the output tells.
# The lint runs without the ini files: a parse calls no extension, and loading the
# ones of the build image costs about 150 ms per process, smbclient most of it. -n
# also drops the memory_limit of ncmake.ini, which -d puts back. From PHP 8.3 on
# php -l takes several files and lints each of them; below, it lints only the first,
# so there every file gets a process of its own.
compat_php   = php -n -d error_reporting=-1 -d display_errors=stderr -d log_errors=0 -d memory_limit=768M
compat_lint  = many=$$(php -n -r "echo PHP_VERSION_ID >= 80300 ? 1 : 0;"); find appinfo lib templates vendor -type f -name "*.php" -print0 2>/dev/null | LINT_MANY=$$many xargs -0 -n 64 -P "$$(nproc)" sh -c "if [ \"\$$LINT_MANY\" = 1 ]; then $(compat_php) -l \"\$$@\"; else for f; do $(compat_php) -l \"\$$f\"; done; fi 2>&1; exit 0" php-lint | { grep -v "^No syntax errors detected in " || :; }
# The version is read without the ini files too: the CLI prints the startup warning
# of an extension that does not load to stdout, which would end up in the file.
compat_run   = out=$(compat_dir)/$(php_version); php -n -r "echo PHP_VERSION;" >"$$out/version"; if [ -f vendor/composer/installed.json ] || [ -f composer.lock ]; then composer check-platform-reqs --no-dev --format=json >"$$out/platform.json" 2>"$$out/platform.err"; echo $$? >"$$out/platform.rc"; fi; $(compat_lint) >"$$out/lint.txt"

# deps-audit runs composer audit where make build resolves the dependencies, in
# the build image of the PHP floor, in a make of its own as php-compat does. The
# container sees only the app, so the composer half, lib/deps-audit.php, is
# copied into build/deps-audit beside the output it leaves there. The npm half
# runs in the analyser, which carries the app's Node line as build-verify does.
deps_dir = build/deps-audit

# == secrets-audit ==
# gitleaks runs as the Linux binary of its GitHub release, checked against the
# digest of its checksums file, in the analyser's Node container, which carries
# the git it calls. It is fetched by lint_bin_fetch of the lint module, which
# make dev-init brings along with this one.
gitleaks_version        = 8.30.1
gitleaks_sha256_x86_64  = 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
gitleaks_sha256_aarch64 = e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
secrets_gitleaks        = gitleaks $(gitleaks_version) https://github.com/gitleaks/gitleaks/releases/download/v$(gitleaks_version) \
	gitleaks_$(gitleaks_version)_linux_x64.tar.gz $(gitleaks_sha256_x86_64) gitleaks_$(gitleaks_version)_linux_arm64.tar.gz $(gitleaks_sha256_aarch64) gitleaks
secrets_core = $(if $(value lint_bin_fetch),:,echo "ERROR: secrets-audit fetches gitleaks through the lint module - run 'make dev-init'" >&2; exit 1)

# What ships, as a tree inside the app, since the container sees only the app:
# secrets_tree when ship_check names one (make dist, the staged tree), else the
# unpacked TARBALL=<file>, else the files make stage takes from the checkout,
# copied as make stage copies them. The copy goes when the run ends.
secrets_dir   = build/secrets-audit
SCOPE        ?= all
secrets_scope = $(if $(filter shipped history all,$(SCOPE)),$(SCOPE),$(error SCOPE is shipped, history or all))
secrets_ship  = $(if $(filter history,$(secrets_scope)),, \
	$(if $(secrets_tree),tree='$(secrets_tree)' from=stage, \
	$(if $(TARBALL),mkdir -p $(secrets_dir)/tarball && tar -xzf "$(TARBALL)" -C $(secrets_dir)/tarball --no-same-owner || exit 1; tree=$(secrets_dir)/tarball from=tarball, \
	mkdir -p "$(secrets_dir)/stage/$(app_id)" && rsync -a --relative $(stage_excludes) $(addprefix ./,$(keep_existing)) "$(secrets_dir)/stage/$(app_id)/" || exit 1; tree=$(secrets_dir)/stage/$(app_id) from=checkout));)
# The tree is named by the shell of the recipe, so the analyser's command, which
# runs in another shell, gets it from outside its quotes.
secrets_args  = --scope=$(secrets_scope) $(if $(filter history,$(secrets_scope)),,--shipped="'"$$tree"'" --from='"$$from"') $(if $(COMMITS),--commits="$(COMMITS)")
ifeq ($(filter $(RUNTIME),bare none),)
  secrets_run = $(call ncmake_lib_in,$(lib_node_image),-v "$$gdir":/ncmake-gitleaks:ro -e SECRETS_AUDIT_GITLEAKS=/ncmake-gitleaks/gitleaks)
else
  secrets_run = export SECRETS_AUDIT_GITLEAKS="$$gdir/gitleaks" && $(ncmake_lib_read_run)
endif

# make tag and make dist check what ships through the core's ship_check: $(1) is
# the staged tree of make dist, empty for make tag. NO_SECRETS_AUDIT=1 skips it.
ship_check = $(if $(filter 1,$(NO_SECRETS_AUDIT)),echo "==> NO_SECRETS_AUDIT=1: what ships is not checked for secrets.", \
	$(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory secrets-audit SCOPE=shipped $(if $(1),secrets_tree=$(1)) \
	|| { echo "ERROR: stopped on the secret above - take it out of what ships and revoke it, or go on regardless with NO_SECRETS_AUDIT=1." >&2; exit 1; })

# == secrets-ignore ==
# The findings come from a run of secrets-audit with JSON= into the build cache,
# with the SCOPE=, TARBALL=, COMMITS= and ARGS= of the command line. The tool
# that lists them and asks which are false positives runs on the host, since it
# needs the terminal: plain python3, written to the build cache at run time, as
# the core writes the integrity tool. It writes nothing into the checkout; the
# lines it returns are appended to .gitleaksignore by the recipe, on the branch of
# COMMIT=1 or PR=1 where one is asked for. REASON reaches it from the
# environment, where make puts every variable of its command line.
secrets_ignore_json = $(cache_dir)/secrets-ignore.json
secrets_ignore_add  = $(cache_dir)/secrets-ignore.add
secrets_ignore_list = $(cache_dir)/secrets-ignore.bullets

define secrets_ignore_tool
import json
import os
import re
import sys


# An app set up for REUSE, as make reuse tells one: LICENSES/, REUSE.toml or
# .reuse/dep5. A new .gitleaksignore there carries a header of its own, as the
# other ignore files of an app do, with the copyright and the licence REUSE.toml
# states for itself, as make l10n-init takes them for its files.
def reuse_app():
    return os.path.isdir('LICENSES') or os.path.isfile('REUSE.toml') or os.path.isfile('.reuse/dep5')


def reuse_header():
    try:
        with open('REUSE.toml', encoding='utf-8') as f:
            text = f.read()
    except OSError:
        return []
    # REUSE-IgnoreStart
    copyright = re.search(r'^#\s*SPDX-FileCopyrightText:\s*(.+?)\s*$$', text, re.M)
    licence = re.search(r'^#\s*SPDX-License-Identifier:\s*(.+?)\s*$$', text, re.M)
    if not (copyright and licence):
        return []
    return ['# SPDX-FileCopyrightText: ' + copyright.group(1), '# SPDX-License-Identifier: ' + licence.group(1)]
    # REUSE-IgnoreEnd


def picked(answer, count):
    if answer == 'all':
        return list(range(count))
    out = []
    for word in answer.replace(',', ' ').split():
        first, _, last = word.partition('-')
        if not first.isdigit() or (last and not last.isdigit()):
            sys.exit(f'secrets-ignore: {word} is no number or range; nothing is changed.')
        a, b = int(first), int(last or first)
        if not 1 <= a <= b <= count:
            sys.exit(f'secrets-ignore: {word} is outside 1-{count}; nothing is changed.')
        out.extend(i - 1 for i in range(a, b + 1) if i - 1 not in out)
    return out


def main():
    report, ignore_file, add_file, list_file = sys.argv[1:5]
    reason = os.environ.get('REASON', '').strip()
    try:
        with open(report, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f'secrets-ignore: the report of secrets-audit could not be read: {e}')
    known = set()
    if os.path.exists(ignore_file):
        with open(ignore_file, encoding='utf-8') as f:
            known = {line.strip() for line in f if line.strip() and not line.lstrip().startswith('#')}
    found = [f for f in data.get('findings', [])
             if f.get('id', '').startswith('secret-') and f.get('fingerprint') and f['fingerprint'] not in known]
    for path in (add_file, list_file):
        open(path, 'w').close()
    if not found:
        print('==> secrets-audit reports no finding that is not in .gitleaksignore already.')
        return
    print()
    print('Findings of secrets-audit:')
    rows = []
    for f in found:
        where = f['file'] + (f":{f['line']}" if f.get('line') else '')
        when = f"{f['commit'][:12]} ({(f.get('date') or '')[:10]})" if f.get('commit') else 'in what ships'
        rows.append((f, where, when))
    width = max(len(f['rule']) for f in found)
    for i, (f, where, when) in enumerate(rows, 1):
        print(f'  {i:>3}  {f["rule"]:<{width}}  {where}  {when}')
    if not sys.stdin.isatty():
        print('No terminal to ask on: nothing is changed.')
        return
    answer = input('Which are false positives? Numbers or ranges (1 3-5), all, Enter for none: ').strip().lower()
    chosen = picked(answer, len(rows))
    if not chosen:
        print('==> None picked; .gitleaksignore is left as it is.')
        return
    if not reason:
        reason = input('Why are they false positives? (Enter to leave the reason out): ').strip()
    block, bullets = [], []
    if reuse_app() and not os.path.exists(ignore_file):
        block = reuse_header()
        if block:
            bullets.append('- Give .gitleaksignore the copyright and licence REUSE.toml states')
        else:
            print('REUSE.toml states no copyright and licence of its own: give .gitleaksignore a header, or make reuse fails.')
    elif reuse_app():
        with open(ignore_file, encoding='utf-8') as f:
            if 'SPDX-License-Identifier' not in f.read():
                print('.gitleaksignore has no licence header: add one, or make reuse fails.')
    for i in chosen:
        f, where, when = rows[i]
        comment = f"# {f['rule']} in {where}, {when}" + (f': {reason}' if reason else '')
        block += [comment, f['fingerprint']]
        bullets.append(f"- {f['rule']} in {where}" + (f': {reason}' if reason else ''))
    with open(add_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(block) + '\n')
    with open(list_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(bullets) + '\n')


main()
endef
export secrets_ignore_tool

define secrets_ignore_body
`make secrets-ignore` added the fingerprints of findings of `make secrets-audit` that were marked as false positives to `.gitleaksignore`, each under a comment that names the rule, the file and the commit, and the reason where one was given. `.gitleaksignore` is outside the keep model, so it does not ship.
endef
export secrets_ignore_body

# Appends what the tool returned, after a newline where the file lacks one at its end.
secrets_ignore_append = f=.gitleaksignore; if [ -s "$$f" ] && [ -n "$$(tail -c1 "$$f")" ]; then echo >> "$$f"; fi; cat "$(secrets_ignore_add)" >> "$$f"

.PHONY: consistency-audit build-verify changelog-lint php-compat php-compat-run deps-audit deps-audit-composer secrets-audit secrets-ignore

consistency-audit:
	@$(audit_core)
	@$(call ncmake_lib_need,$(consistency_libs))
	@echo "==> consistency-audit$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@$(ncmake_lib_read_run) '$(call ncmake_lib_guard,consistency-audit) CONSISTENCY_AUDIT_CMDLINE="$(consistency_cmdline)" CONSISTENCY_AUDIT_APPDIR="$(notdir $(CURDIR))" CONSISTENCY_AUDIT_NC_MASTER="$(consistency_nc_master)" CONSISTENCY_AUDIT_NC_NEWEST="$(consistency_nc_newest)" CONSISTENCY_AUDIT_NODE_SCHEDULE="$(consistency_node_schedule)" CONSISTENCY_AUDIT_KEEP="$(consistency_keep)" CONSISTENCY_AUDIT_NO_NETWORK="$(NO_NETWORK)" node $(ncmake_lib_path)/consistency-audit.mjs $(ARGS) $(ncmake_json_arg)'

build-verify:
	@$(audit_core)
	@$(call ncmake_lib_need,$(verify_libs))
	@echo "==> build-verify$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@$(ncmake_lib_run) '$(call ncmake_lib_guard,build-verify) $(verify_transient) BUILD_VERIFY_CMDLINE="$(verify_cmdline)" node $(ncmake_lib_path)/build-verify.mjs $(ARGS) $(ncmake_json_arg)'

changelog-lint:
	@$(audit_core)
	@$(call ncmake_lib_need,$(changelog_libs))
	@echo "==> changelog-lint$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@$(ncmake_lib_read_run) '$(call ncmake_lib_guard,changelog-lint) CHANGELOG_LINT_CMDLINE="$(changelog_cmdline)" node $(ncmake_lib_path)/changelog-lint.mjs $(ARGS) $(ncmake_json_arg)'

php-compat: check-app
	@$(audit_core)
	@$(compat_core)
	@$(call ncmake_lib_need,$(compat_libs))
	@floor='$(php_min)'; server='$(php_server_max)'; declared='$(php_declared_max)'; master='$(compat_master)'; \
	[ -n "$$server" ] || { echo "ERROR: no PHP ceiling - lib/versioncheck.php of Nextcloud $(or $(nc_max),master) could not be read" >&2; exit 1; }; \
	raise=$$declared; [ -z "$$declared" ] || [ -z "$$master" ] || raise=$$(printf '%s\n' "$$declared" "$$master" | sort -V | head -1); \
	ceiling=$$(printf '%s\n' "$$server" $$raise | sort -V | tail -1); \
	if [ "$(PHP)" = all ]; then \
		minors=$$(for M in $$(seq "$${floor%%.*}" "$${ceiling%%.*}"); do for n in $$(seq 0 9); do v=$$M.$$n; \
			[ "$$(printf '%s\n' "$$floor" "$$v" | sort -V | head -1)" = "$$floor" ] && [ "$$(printf '%s\n' "$$v" "$$ceiling" | sort -V | tail -1)" = "$$ceiling" ] && echo "$$v"; \
		done; done); \
	else minors=$$(printf '%s\n' "$$floor" "$$ceiling" | sort -uV); fi; \
	echo "==> php-compat on PHP" $$minors "(RUNTIME=$(RUNTIME))" >&2; \
	rm -rf $(compat_dir) && mkdir -p $(compat_dir) || exit 1; \
	printf 'floor=%s\nceiling=%s\nserver=%s\ndeclared=%s\nmaster=%s\nnextcloud=%s\n' "$$floor" "$$ceiling" "$$server" "$$declared" "$$master" '$(nc_max)' >$(compat_dir)/range; \
	for m in $$minors; do \
		echo "==> PHP $$m" >&2; mkdir -p $(compat_dir)/$$m; \
		$(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory php-compat-run php_version=$$m php_image=$(compat_image):$$m PHP=min || echo "$$?" >$(compat_dir)/$$m/failed; \
	done; \
	next=; \
	if [ -n "$$declared" ] && [ -n "$$master" ] && [ "$$(printf '%s\n' "$$declared" "$$master" | sort -V | tail -1)" != "$$master" ]; then next=$$declared-next; \
	elif [ "$(NEXT)" = 1 ]; then next=next; fi; \
	if [ -n "$$next" ]; then \
		$(if $(filter bare none,$(RUNTIME)),echo "==> PHP ahead of master: RUNTIME=$(RUNTIME) runs no image; $(compat_next):$$next is left out" >&2;, \
		echo "==> PHP ahead of master ($(compat_next):$$next)" >&2; mkdir -p $(compat_dir)/next; echo "next=$$next" >>$(compat_dir)/range; \
		$(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory php-compat-run php_version=next php_image=$(compat_next):$$next php_floor_mode= PHP=min || echo "$$?" >$(compat_dir)/next/failed;) \
	fi; \
	$(ncmake_lib_read_run) '$(call ncmake_lib_guard,php-compat) PHP_COMPAT_CMDLINE="$(compat_cmdline)" node $(ncmake_lib_path)/php-compat.mjs $(ARGS) $(ncmake_json_arg)'

php-compat-run:
	@$(php_run) '$(compat_run)'

deps-audit: check-app
	@$(audit_core)
	@$(call ncmake_lib_need,$(deps_libs))
	@echo "==> deps-audit$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2
	@rm -rf $(deps_dir) && mkdir -p $(deps_dir) || exit 1; \
	if [ -f composer.lock ]; then \
		echo "==> composer audit on PHP $(php_min)" >&2; \
		cp "$(ncmake_lib_dir)/deps-audit.php" $(deps_dir)/ && \
		$(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory deps-audit-composer PHP=min || echo "$$?" >$(deps_dir)/composer.failed; \
	fi; \
	$(ncmake_lib_run) '$(call ncmake_lib_guard,deps-audit) DEPS_AUDIT_CMDLINE="$(deps_cmdline)" node $(ncmake_lib_path)/deps-audit.mjs $(ARGS) $(ncmake_json_arg)'

deps-audit-composer:
	@$(php_run) 'php $(deps_dir)/deps-audit.php >$(deps_dir)/composer.json 2>$(deps_dir)/composer.err'

secrets-audit: check-app
	@$(audit_core)
	@$(secrets_core)
	@$(if $(and $(CI)$(GITHUB_ACTIONS),$(filter --reveal,$(ARGS))),echo "ERROR: ARGS=--reveal shows the secrets and is refused where CI is set" >&2; exit 1,:)
	@$(call ncmake_lib_need,$(secrets_libs))
	@echo "==> secrets-audit$(if $(strip $(ARGS)), $(ARGS)) (gitleaks $(gitleaks_version), SCOPE=$(secrets_scope), RUNTIME=$(RUNTIME))" >&2
	@gdir=$$($(lint_bin_fetch) $(secrets_gitleaks)) || exit 1; \
	trap 'rm -rf $(secrets_dir)' EXIT; rm -rf $(secrets_dir) && mkdir -p $(secrets_dir) || exit 1; \
	$(secrets_ship) \
	$(secrets_run) '$(call ncmake_lib_guard,secrets-audit) SECRETS_AUDIT_CMDLINE="$(secrets_cmdline)" node $(ncmake_lib_path)/secrets-audit.mjs $(secrets_args) $(ARGS) $(ncmake_json_arg)'

# secrets-audit exits 1 with findings, which is what this target is for, so its
# status is not taken: a run that completed is one that wrote its JSON.
secrets-ignore: check-app
	@$(if $(BODY),test -r "$(BODY)" || { echo "BODY=$(BODY) is not a readable file" >&2; exit 1; };) commit="$(COMMIT)"; pr="$(PR)"; if [ "$$pr" = "1" ]; then commit=1; fi; \
	mkdir -p "$(cache_dir)" && rm -f "$(secrets_ignore_json)" "$(secrets_ignore_add)" "$(secrets_ignore_list)" || exit 1; \
	$(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory secrets-audit JSON="$(secrets_ignore_json)"; \
	[ -s "$(secrets_ignore_json)" ] || { echo "ERROR: secrets-audit did not complete, so there is nothing to pick from." >&2; exit 1; }; \
	printf '%s\n' "$$secrets_ignore_tool" > "$(cache_dir)/secrets-ignore.py" \
		&& python3 "$(cache_dir)/secrets-ignore.py" "$(secrets_ignore_json)" .gitleaksignore "$(secrets_ignore_add)" "$(secrets_ignore_list)" || exit 1; \
	[ -s "$(secrets_ignore_add)" ] || exit 0; \
	if [ "$$commit" != "1" ]; then \
		$(secrets_ignore_append) || exit 1; \
		echo "==> Added to .gitleaksignore:"; sed 's/^/    /' "$(secrets_ignore_add)"; \
		echo "Review and commit: git add .gitleaksignore"; \
	else \
		eval "$$branch_flow"; \
		flow_branch_start ncmake/secrets/ignore || exit 1; \
		{ $(secrets_ignore_append); } || { flow_branch_abort "$$branch"; exit 1; }; \
		git add -- .gitleaksignore; \
		flow_branch_finish "$$branch" "chore: mark false positives of secrets-audit" "$$(cat "$(secrets_ignore_list)")" "$$secrets_ignore_body" "$$pr" || exit 1; \
	fi

define help_consistency-audit
make consistency-audit [ARGS="<audit arguments>"] [JSON=<file>] [NO_NETWORK=1]

Checks whether the checkout agrees with itself. An app states the same fact in
several files, and each file is valid on its own: appinfo/info.xml and
package.json both carry a version, info.xml and composer.json both bound the PHP
version, package.json, .nvmrc and the installed workflows each name a Node
version. A linter checks one file against a rule and cannot see any of that; this
holds the files against each other and reports where they disagree.

The second half is what a release needs and a checkout can be missing: the
<repository> and <bugs> links, which are the only way from a published release
back to the project; a <nextcloud> range that names servers that exist and
reaches no further than the App Store rules allow, the newest released major plus
one; an app name without Nextcloud in it, which those rules also demand; a
lockfile, and one rather than two; a licence stated the same way everywhere; a
linter that a script calls while no configuration for it is in the tree; a
directory the code reads at run time, through __DIR__ in PHP or linkTo in the
frontend, that the shipped file set leaves out. Each of those is reported once,
with the reason it matters, and never as a score.

The links of the App Store listing in info.xml, <website>, <bugs>,
<repository>, the <documentation> links, <screenshot> and <donation>, are asked
whether they answer: one HEAD each, a GET where a server refuses HEAD, each URL
once per run, 10 seconds at most. A link that answers 404 or 410 or whose host
does not resolve is dead [!], and so is a screenshot that is not served as an
image, such as the page of a github.com blob URL; an error, a timeout or a
refusal may be temporary and is named [i], as are a permanent redirect, with the
address to write instead, and an http link that answers over https as well. A
screenshot pinned to a release tag of the app's own repository (make version
moves those along) whose tag is not in the checkout yet is named [i] while its
file is in the working tree. NO_NETWORK=1 leaves the links unchecked, and the
report says so.

Findings are marked [!] worth changing, [i] worth knowing, [ok] nothing found,
and each says which files it was read from. What the checkout does not state is
named as not stated instead of being guessed at - with one exception, the oldest
Nextcloud major still maintained, which is written into the analyser, and the
report names the month that is from. The newest released major is read from the
release tags of nextcloud/server, and the major it develops on master from its
version.php: a <nextcloud max-version> beyond that names servers nobody has run
the app on. Without the network a list of majors in the analyser stands in for
both, and the report says so. The Node.js release schedule is read the same way,
so an engines.node that admits only end-of-life Node lines is reported with the
line the release is built on and the oldest line still maintained; without the
network a snapshot in the analyser stands in for the schedule.

It reads metadata only: no build, no install, no installed dependency tree, no
bytes, and from the network only the links. That makes it useful on a fresh clone, and on an app that never heard of
ncmake. The analyser runs in the throwaway Node container, so the host needs no
Node, and it is mounted in from the ncmake cache, so nothing is written into the
app.

ARGS is passed to the analyser; a bare word in it is the checkout to audit
(default: the current directory):
  make consistency-audit                      this app
  make consistency-audit ARGS=--details       every table behind the findings
  make consistency-audit ARGS="--details --top=0"  and no row limit in them
  make consistency-audit ARGS=--json > audit.json  machine-readable, nothing else
  make consistency-audit JSON=audit.json      the report, and the JSON in audit.json
  make consistency-audit ARGS=--help          the analyser's own option list

JSON=<file> writes the JSON of ARGS=--json to <file> as well, from the same run,
and the report is printed as without it. The file can lie outside the app; it is
replaced once the run is complete, and a run that stops on an error writes none.

Only the app itself is mounted into the container, so auditing a checkout outside
it needs RUNTIME=bare and Node on the host.
endef

define help_php-compat
make php-compat [PHP=all] [NEXT=1] [ARGS="<analyser arguments>"] [JSON=<file>]

Checks whether the app runs on the PHP versions its servers run it on. A server
states the PHP it accepts in lib/versioncheck.php, and the app states the servers
in appinfo/info.xml. Two of those PHP versions are checked:
  the floor     the PHP make build resolves the dependencies against
  the ceiling   the newest PHP minor that Nextcloud <max-version> accepts, read
                from its stable branch, or from master for a max-version that
                has none; <php max-version> in info.xml can only raise it,
                and no further than the ceiling of master
PHP=all checks every minor in between as well.

Each runs in the build image of that minor, ghcr.io/ernolf/ncmake-php:<minor>,
with the extensions a Nextcloud server offers, and does two things there:
  composer check-platform-reqs --no-dev
      whether every installed package accepts this PHP. A package that requires
      a PHP below the ceiling installs on the floor and breaks on a newer server.
  php -l over appinfo/, lib/, templates/ and vendor/
      whether every PHP file that ships parses on this PHP, and what it reports
      as deprecated there. The lint loads no extension, since a parse calls
      none, and from PHP 8.3 on lints 64 files per process.
Findings are marked [!] worth changing, [i] worth knowing, [ok] nothing found:
[!] for a package that refuses one of the PHP versions, a file that does not
parse, a <php max-version> below the server's ceiling, which keeps the app
off servers that run a newer PHP, and a <php max-version> above the ceiling of
master, a PHP no server runs yet: once one allows it, the server enables the
app on it although nobody has checked the app there; [i] for a deprecation,
an extension the build image lacks, and a file of a dev package, which make
build does not ship.

The check reads what is installed: run make build first, so vendor/ holds what
ships. Without vendor/, composer reads composer.lock and only the app's own files
are linted; without either, composer has nothing to check. The output of each
run stays in build/php-compat/<minor>.

A <php max-version> above the ceiling of master names a PHP no server runs yet.
That minor runs once more, in ghcr.io/ernolf/ncmake-php:<minor>-next, which the
ncmake-images repository builds for every PHP minor above master: from its
release, or before it from the newest alpha, beta or RC.
NEXT=1 runs the newest of them, ghcr.io/ernolf/ncmake-php:next, for an app that
does not declare it. The findings of that run are marked [i] and named after the
exact PHP, for example 8.6.0RC3: they are for preparing the app, not proof that
a server runs it, and they leave the exit code alone. The report says whether
that PHP has a release yet. Its output stays in build/php-compat/next.

The exit code is 1 when a finding is marked [!], so a CI job that runs it after
make build fails on it. ARGS is passed to the analyser:
  make php-compat                       the floor and the ceiling
  make php-compat PHP=all               every minor in between too
  make php-compat NEXT=1                and the newest PHP ahead of master
  make php-compat ARGS=--details        every file behind the findings
  make php-compat ARGS=--json > compat.json  machine-readable, nothing else
  make php-compat JSON=compat.json      the report, and the JSON in compat.json
  make php-compat ARGS=--help           the analyser's own option list

JSON=<file> writes the JSON of ARGS=--json to <file> as well, from the same run,
and the report is printed as without it. The file can lie outside the app; it is
replaced once the run is complete, and a run that stops on an error writes none.

It needs the network for versioncheck.php and the images. With RUNTIME=bare it
runs on the PHP of the host, once per minor, and says so; the PHP ahead of
master, which only its image carries, is left out there.
endef

define help_deps-audit
make deps-audit [ARGS="<audit arguments>"] [JSON=<file>]

Checks whether a dependency that ships has a published vulnerability, or a
licence the app cannot ship it under. A release
ships the runtime packages of composer.lock in vendor/ and the production
packages of the npm lock file bundled into js/; this asks the package managers'
own audits about exactly those, dev dependencies, build tools and test
frameworks left out:
  composer audit --locked --no-dev
      in the build image of the PHP floor, ghcr.io/ernolf/ncmake-php:<floor>;
      it reports abandoned packages as well
  npm audit --omit=dev, pnpm audit --prod, yarn npm audit --environment
  production --recursive, or for Yarn 1 yarn audit --groups dependencies
      as the lock file decides, on the Node line the app declares; pnpm and
      yarn come through corepack, as in make build

Each vulnerable package is reported once, with its advisories, the highest
severity among them and the first released version above the locked one that
fixes them all. Whether the declared constraints let an update reach that
version decides between the two findings:
  [!] vulnerable-dependency         they allow it, and the update command named
                                    in the finding is enough
  [!] vulnerable-dependency-pinned  a constraint excludes it, and the finding
                                    names the constraint to widen and who
                                    declares it
composer decides that itself, with composer why-not. For npm the ranges come
from package-lock.json or yarn.lock; pnpm-lock.yaml records only those of
package.json, so for a package further down the finding says so. [i] marks an
abandoned package with its suggested replacement, an advisory source that did
not answer, in which case nothing of that lock file was checked, and a
dependency without a lock file to audit. Both vulnerability findings carry
"security": true in the JSON.

The same packages are held against the licence appinfo/info.xml declares, by
the licence table lib/licences.json of ncmake, a data file: a bundle is one
work, so a copyleft package in it puts its terms on the whole app. composer.lock
records the licence of every package, package-lock.json from lockfile version
2 on; for pnpm-lock.yaml, yarn.lock and an older package-lock.json the licence
is read from the package's manifest in the registry. The findings:
  [!] licence-incompatible  a licence that cannot be combined with the app's,
                            GPL-2.0-only in an AGPL-3.0-or-later app, or GPL
                            and AGPL in an app under MIT or Apache-2.0
  [!] licence-non-free      a licence that forbids redistribution or
                            commercial use, CC-BY-NC-* or UNLICENSED
  [!] licence-missing       a package that states no licence
  [i] licence-unknown       a licence that is no SPDX expression, or one the
                            table gives no verdict on; shown as written
  [i] licence-summary       the shipped packages grouped by licence, for the
                            release notes and the App Store listing
An expression with OR passes when one of its licences does, one with AND when
all of them do.

The report is written to build/reports/deps-audit.txt and
build/reports/deps-audit.json, and the exit code is 0 with or without findings:
the gates are the lint-deps and lint-licences workflows of
ernolf/ncmake-workflows, lint-deps with a severity threshold of its own. The
raw output of the audits stays in build/deps-audit.
ARGS is passed to the analyser:
  make deps-audit                       composer.lock and the npm lock file
  make deps-audit ARGS=--details        every advisory and package of a finding
  make deps-audit ARGS=--json > deps.json  machine-readable, nothing else
  make deps-audit JSON=deps.json        the report, and the JSON in deps.json
  make deps-audit ARGS=--self-test      the licence table against its examples
  make deps-audit ARGS=--help           the analyser's own option list

JSON=<file> writes the JSON of ARGS=--json to <file> as well, from the same run,
and the report is printed as without it. The file can lie outside the app; it is
replaced once the run is complete, and a run that stops on an error writes none.

It needs the network for the advisories, the released versions and the
licences the lock file does not record. With
RUNTIME=bare composer, npm and corepack run on the host.
endef

define help_secrets-audit
make secrets-audit [SCOPE=shipped|history|all] [TARBALL=<file>]
                   [COMMITS=<range>] [ARGS="<audit arguments>"] [JSON=<file>]

Checks whether a key or a token is in what the release ships, or in the history
of the checkout. A secret committed to an app repository is public as soon as it
is pushed, stays in the history after a later commit removes it, and inside the
shipped file set it is in every tarball on the App Store.

gitleaks looks for secrets by its own rules, in two scopes:
  shipped   the files make stage takes from the checkout, copied aside as make
            stage copies them, or the tarball TARBALL=<file> names
  history   every commit of the checkout, or the commits of COMMITS=<range>,
            a git log range such as main..HEAD
SCOPE=all, the default, checks both. Next to the gitleaks rules a file is
reported by its name: a private key (*.key, id_rsa, id_ed25519 and their
siblings, a *.pem with a private key block), a key store (*.p12, *.pfx), an
.env file (not .env.example, .env.dist and the like), the auth.json of composer
with a credential and an .npmrc with a token. The public certificate of the
integrity signature, .ncmake/certificate.crt, is committed on purpose and never
reported.

Findings are marked [!] worth changing, [i] worth knowing, [ok] nothing found:
  [!] secret-shipped     a secret in what ships: take it out and revoke it
  [!] secret-in-history  a secret in a commit, with the commit that added it: it
                         has to be revoked, removing it does not make it secret
                         again
Each finding gives the rule, the file, the line and the commit, and never the
secret: gitleaks runs with --redact. ARGS=--reveal shows the line of each
finding on the terminal, for the maintainer who has to find it; it never
reaches the JSON, and a run where CI is set refuses it. Both findings carry
"security": true in the JSON, and a fingerprint, which .gitleaksignore of the
repository takes to silence a finding that is revoked and meant to stay, or no
secret at all; make secrets-ignore writes it for the findings picked.
.gitleaks.toml of the repository configures gitleaks for both scopes.

make tag checks what ships before its confirmation, and make dist checks the
staged tree before it packs it; both stop on secret-shipped, and
NO_SECRETS_AUDIT=1 goes on regardless. The history has its own gate, the
lint-secrets workflow of ernolf/ncmake-workflows.

The exit code is 1 when a finding is marked [!]. ARGS is passed to the analyser:
  make secrets-audit                    what ships and every commit
  make secrets-audit SCOPE=shipped      what ships, as make tag checks it
  make secrets-audit TARBALL=<file>     a tarball, e.g. the one make dist packs
  make secrets-audit SCOPE=history COMMITS=main..HEAD  the commits of a branch
  make secrets-audit ARGS=--details     every commit that changed a file found
                                        by its name
  make secrets-audit ARGS=--reveal      the line of each finding, on the
                                        terminal only
  make secrets-audit ARGS=--json > secrets.json  machine-readable, nothing else
  make secrets-audit JSON=secrets.json  the report, and the JSON in secrets.json
  make secrets-audit ARGS=--help        the analyser's own option list

JSON=<file> writes the JSON of ARGS=--json to <file> as well, from the same run,
and the report is printed as without it. The file can lie outside the app; it is
replaced once the run is complete, and a run that stops on an error writes none.

gitleaks is the Linux binary of its GitHub release, checked against its
digest, kept in tools/ of the ncmake cache and run in the throwaway Node
container, which carries git; the lint module, which make dev-init brings
along, fetches it. It reads no network. With RUNTIME=bare it runs on the host,
with the host's git.
endef

define help_secrets-ignore
make secrets-ignore [SCOPE=...] [TARBALL=<file>] [COMMITS=<range>]
                    [REASON=<text>] [ARGS="--reveal"]
                    [COMMIT=1|PR=1 [BODY=<path>]]    (maintainer)

Adds the findings of make secrets-audit that are no secrets to .gitleaksignore.
gitleaks takes some values for secrets that are none, the test vectors of an
RFC in a unit test for instance. A finding of an old commit cannot be silenced
in the file, only by its fingerprint in .gitleaksignore, and this writes it.

It runs make secrets-audit with the SCOPE=, TARBALL=, COMMITS= and ARGS= given,
and lists its findings numbered: rule, file, line, commit and date, never the
secret; ARGS=--reveal shows the lines in the report above the list. It asks
which are false positives, by number or range (1 3-5) or all, and then for the
reason, which Enter leaves out; REASON=<text> gives it up front. Each finding
picked is appended to .gitleaksignore in the root of the checkout:
  # generic-api-key in tests/OtpTest.php:34, 072899102f2e (2026-06-26): <reason>
  072899102f2e...:tests/OtpTest.php:generic-api-key:34
A finding already in the file is not listed. Without a terminal it only lists,
and changes nothing. .gitleaksignore is outside the keep model and never ships.
In an app set up for REUSE (LICENSES/, REUSE.toml or .reuse/dep5), a new
.gitleaksignore starts with the copyright and licence REUSE.toml states for
itself, as the other ignore files of an app carry them; an existing one without
a licence header is named, since make reuse fails on it.

Without flags it only writes the file and names it for git add. COMMIT=1 runs
from main or a stable* branch, commits it on the branch ncmake/secrets/ignore
and prints the push command; PR=1 implies COMMIT=1 and also pushes and opens
the pull request, with BODY=<path> as for the workflow targets.

  make secrets-ignore SCOPE=history
  make secrets-ignore SCOPE=history REASON="RFC 6238 test secret" PR=1
endef

define help_build-verify
make build-verify [ARGS="<verify arguments>"] [JSON=<file>]

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
on something a fresh clone does not have, or on the directory it ran in. That
output is a build of this source in another directory as well: where it matches
the first build on every file name and every byte but build metadata, it stands
in for the second build, which then does not run.

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
  make build-verify                         this app, where its bundler config
                                            writes, else js/ and css/
  make build-verify ARGS=--build=dist       another output directory
  make build-verify ARGS=--details          every table behind the findings
  make build-verify ARGS=--once             one build instead of two
  make build-verify ARGS=--step-timeout=120  two hours for each install and build
  make build && make build-verify ARGS=--fresh  output built right before
  make build-verify ARGS=--json > verify.json  machine-readable, nothing else
  make build-verify JSON=verify.json        the report, and the JSON in verify.json
  make build-verify ARGS=--help             the analyser's own option list

JSON=<file> writes the JSON of ARGS=--json to <file> as well, from the same run,
and the report is printed as without it. The file can lie outside the app; it is
replaced once the run is complete, and a run that stops on an error writes none.

It installs and builds, so unlike consistency-audit it needs the network and
takes minutes rather than a second. Where it runs it needs git and npm. In a
container it runs on the newest Node LTS line in ncmake's Node image, which carries
git, and the build steps run on the Node line the app declares, mounted beside it
together with its npm, so an app on an end-of-life Node line is rebuilt like any
other. In a container the scratch
tree lives in the container's own /tmp and goes with it, so ARGS=--keep and the
log each build step writes only survive with RUNTIME=bare and Node on the host.
Where a step fails, the last lines of its output and of its error output are
printed apart, which in a container is the only record of why.

Each install and build step may take 60 minutes. A step still running then is
stopped together with every process it started, its last lines are printed as for
a failed step, and the report says the rebuild could not be completed, without a
verdict on the output. ARGS=--step-timeout=<minutes> sets another limit, 0 none.
endef

define help_changelog-lint
make changelog-lint [ARGS="<lint arguments>"] [JSON=<file>]

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
  make changelog-lint JSON=changelog.json  the report, and the JSON in changelog.json
  make changelog-lint ARGS=--help          the analyser's own option list

JSON=<file> writes the JSON of ARGS=--json to <file> as well, from the same run,
and the report is printed as without it. The file can lie outside the app; it is
replaced once the run is complete, and a run that stops on an error writes none.

It reads the checkout only: no build, no network. The analyser runs in the
throwaway Node container and is mounted in from the ncmake cache, so nothing is
written into the app.
endef

help::
	@echo ""
	@echo "$(ch)Checkout audit (developer module):$(c0)"
	@echo "  $(ct)consistency-audit$(c0)    Whether the checkout agrees with itself, and what a release still needs"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), $(cv)NO_NETWORK=1$(cd), see $(cv)make help-consistency-audit$(c0)"
	@echo "  $(ct)build-verify$(c0)         Whether the committed build output comes from the source beside it"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-build-verify$(c0)"
	@echo "  $(ct)changelog-lint$(c0)       Whether the App Store finds this release in the changelog"
	@echo "    $(cd)optional $(cv)ARGS=\"--nightly\"$(cd), see $(cv)make help-changelog-lint$(c0)"
	@echo "  $(ct)php-compat$(c0)           Whether the app runs on the PHP floor and ceiling of its servers"
	@echo "    $(cd)optional $(cv)PHP=all$(cd), see $(cv)make help-php-compat$(c0)"
	@echo "  $(ct)deps-audit$(c0)           Whether a dependency that ships has a published vulnerability or a licence the app cannot ship"
	@echo "    $(cd)optional $(cv)ARGS=\"--details\"$(cd), see $(cv)make help-deps-audit$(c0)"
	@echo "  $(ct)secrets-audit$(c0)        Whether a key or a token is in what ships, or in the history"
	@echo "    $(cd)optional $(cv)SCOPE=shipped|history$(cd), $(cv)ARGS=\"--reveal\"$(cd), see $(cv)make help-secrets-audit$(c0)"
	@echo "  $(ct)secrets-ignore$(c0)       Add the findings of secrets-audit that are false positives to .gitleaksignore  $(cm)[m]$(c0)"
	@echo "    $(cd)add $(cv)COMMIT=1$(cd) to commit on a branch, or $(cv)PR=1$(cd) to commit and open the PR$(c0)"
