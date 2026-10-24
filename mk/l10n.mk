# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: the repository side of the Nextcloud Transifex sync.
#
# Joining the sync is a checklist, the translation request issue template of
# nextcloud/docker-ci. Most of what it asks the app repository to carry follows
# from what ncmake reads anyway: the app id from appinfo/info.xml, the build
# outputs from .gitignore. l10n-init writes those files and prints the steps that
# happen outside the repository.
#
# l10n-check validates the setup the way translations/validateSyncSetup.sh of
# nextcloud/docker-ci does before the first sync: per branch the bot syncs, the
# three files the bot needs, then the source strings run through the translation
# tool and validateTranslationFiles.sh. Both come from the image the bot itself
# runs in, so the check is the Nextcloud one and not a copy that drifts. The
# script clones over ssh and cannot run here as it is; its steps run per branch
# on a copy of what origin has, because the translation tool writes its fake
# source files and translationfiles/ into the app it reads.
#
# On top of that it checks what the script does not, and what makes a sync fail
# or extract the wrong strings without any message: an .l10nignore that misses a
# build output or a third-party tree, a .tx/config whose resource or file names
# are not the app id the translation tool writes, and a .tx/backport that names a
# branch which is not a stable* branch on origin.
#
# l10n-lint holds the English source strings against the rules of the translation
# team, which reviews them before the first sync and locks the resource until the
# ones it rejects are fixed. The strings are the template the translation tool of
# the bot's image writes; lib/l10n-lint.mjs locates them in the sources and judges
# them by lib/l10n-rules.json, a data file of its own, so a rule is added without
# touching the analyser.
#
# Transifex itself is not touched: no API call and no token, the sync stays with
# the Nextcloud bot.

# == Sources ==
# The image the Nextcloud translation bot runs in: PHP, jq, a current gettext,
# /translationtool.phar and /validateTranslationFiles.sh.
l10n_image ?= ghcr.io/nextcloud/continuous-integration-translations:latest
# The branches the bot syncs when .tx/backport is absent are a list in the
# validation script, which moves with the server's stable branches. It is read
# from there at run time; the fallback stands in when it cannot be fetched.
l10n_sync_script       = https://raw.githubusercontent.com/nextcloud/docker-ci/master/translations/validateSyncSetup.sh
l10n_branches_fallback = main master stable35 stable34 stable33
l10n_request_url       = https://github.com/nextcloud/docker-ci/issues/new?template=---request-translations.md
l10n_docs_url          = https://docs.nextcloud.com/server/latest/developer_manual/basics/front-end/l10n.html\#setup-of-the-transifex-sync
l10n_check_dir         = $(cache_dir)/l10n-check
l10n_lint_dir          = $(cache_dir)/l10n-lint

# What l10n-lint needs next to it, handed to the core's analyser library section:
# appended, never set, because every analyser module adds its own.
l10n_lint_libs = l10n-lint.mjs l10n-rules.json report-text.mjs
ncmake_libs += $(if $(filter l10n-lint,$(MAKECMDGOALS)),$(l10n_lint_libs))

# The build outputs .gitignore classifies as such. Handed to the tool on its
# command line instead of exported: an exported variable is expanded for every
# recipe, and these two each run git.
l10n_ignored = $(if $(js_ignored),js/) $(if $(vendor_ignored),vendor/)

define l10n_tool
import os
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET

# The trees whose strings the extraction must not see: compiled bundles carry
# the t() calls of every library they include, and third-party code is not the
# app's to translate.
TREES = ('js/', 'vendor/', 'vendor-bin/')
RESOURCE = 'o:nextcloud:p:nextcloud:r:'
# The template of the translation request, with the app id put in three times.
TX_CONFIG = '''[main]
host     = https://www.transifex.com
lang_map = hu_HU: hu, nb_NO: nb, sk_SK: sk, th_TH: th, ja_JP: ja, bg_BG: bg, cs_CZ: cs, fi_FI: fi

[%(r)s%(id)s]
file_filter = translationfiles/<lang>/%(id)s.po
source_file = translationfiles/templates/%(id)s.pot
source_lang = en
type        = PO
'''
L10N_FILES = ('.l10nignore', '.tx/config', 'l10n/.gitkeep')

findings = 0


def bad(message):
    global findings
    findings += 1
    print('  [!] %s' % message)


def info(message):
    print('  [i] %s' % message)


def git(*arguments):
    return subprocess.run(['git'] + list(arguments), capture_output=True, text=True, encoding='utf-8')


def on_origin(branch):
    return git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch).returncode == 0


def read(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def write(path, text):
    if os.path.dirname(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def needed_trees(root):
    ignored = os.environ.get('l10n_ignored', '').split()
    return [t for t in TREES if t in ignored or os.path.isdir(os.path.join(root, t))]


def ignore_lines(path):
    # As the translation tool reads the file: split at LF, nothing trimmed, empty
    # lines and lines starting with # skipped.
    if not os.path.isfile(path):
        return []
    return [(n, line) for n, line in enumerate(read(path).split('\n'), 1) if line and not line.startswith('#')]


def uncovered(lines, tree):
    # The tool skips a path that starts with one of the lines, so a line covers a
    # tree when the tree's path starts with it.
    if any(tree.startswith(line) for _, line in lines):
        return None
    for n, line in lines:
        bare = re.sub(r'^(\.?/)+', '', line.strip())
        if bare and tree.startswith(bare):
            return 'line %d, %r, never matches: the translation tool compares it unchanged with paths relative to the app root' % (n, line)
    return ''


def app_id_of(root):
    try:
        element = ET.parse(os.path.join(root, 'appinfo', 'info.xml')).getroot().find('id')
    except (OSError, ET.ParseError):
        return ''
    return (element.text or '').strip() if element is not None else ''


def tx_sections(text):
    sections = {}
    current = None
    for line in text.splitlines():
        header = re.match(r'^\s*\[(.+)\]\s*$$', line)
        if header:
            current = sections.setdefault(header.group(1), {})
            continue
        pair = re.match(r'^\s*([\w-]+)\s*=\s*(.*?)\s*$$', line)
        if pair and current is not None:
            current[pair.group(1)] = pair.group(2)
    return sections


def check_tx(root, app_id):
    path = os.path.join(root, '.tx', 'config')
    if not os.path.isfile(path):
        bad('.tx/config is missing')
        return
    if not app_id:
        bad('appinfo/info.xml names no app id, so .tx/config cannot be held against it')
        return
    resources = {k[len(RESOURCE):]: v for k, v in tx_sections(read(path)).items() if k.startswith(RESOURCE)}
    if not resources:
        bad('.tx/config names no resource [%s%s]' % (RESOURCE, app_id))
        return
    if app_id not in resources:
        bad('.tx/config names the resource %s, appinfo/info.xml the app id %s' % (', '.join(sorted(resources)), app_id))
        return
    # The translation tool names its files after the app id in info.xml; the
    # Transifex client looks for them under these two names.
    expected = {
        'file_filter': 'translationfiles/<lang>/%s.po' % app_id,
        'source_file': 'translationfiles/templates/%s.pot' % app_id,
    }
    for key, want in expected.items():
        have = resources[app_id].get(key)
        if have != want:
            bad('.tx/config: %s is %s, the translation tool writes %s' % (key, have or 'missing', want))


def check(root):
    check_tx(root, app_id_of(root))
    if not os.path.isfile(os.path.join(root, 'l10n', '.gitkeep')):
        bad('l10n/.gitkeep is missing')
    path = os.path.join(root, '.l10nignore')
    if not os.path.isfile(path):
        info('Consider adding .l10nignore and exclude 3rd-party directories like vendor/ and vendor-bin/ as well as directories with compiled javascript assets like js/')
    lines = ignore_lines(path)
    for tree in needed_trees(root):
        reason = uncovered(lines, tree)
        if reason is not None:
            bad('.l10nignore does not exclude %s, so the extraction reads its strings%s' % (tree, ': ' + reason if reason else ''))


def default_branches():
    fallback = os.environ.get('l10n_branches_fallback', '').split()
    url = os.environ.get('l10n_sync_script', '')
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            script = response.read().decode('utf-8')
        found = re.search(r"^versions='([^']*)'", script, re.M)
        if found:
            return found.group(1).split()
    except Exception:
        pass
    info('could not read the branch list from %s, using %s' % (url, ' '.join(fallback)))
    return fallback


def branches(out):
    base = next((b for b in ('main', 'master') if on_origin(b)), None)
    if base is None:
        bad('origin has neither main nor master')
        names = []
    else:
        listed = git('show', 'refs/remotes/origin/%s:.tx/backport' % base)
        if listed.returncode == 0:
            # Split on whitespace, as the shell does with $(cat .tx/backport).
            entries = listed.stdout.split()
            print('==> .tx/backport on origin/%s' % base)
            for entry in entries:
                if not entry.startswith('stable'):
                    bad('lists %s, which is not a stable* branch' % entry)
                elif not on_origin(entry):
                    bad('lists %s, which origin does not have' % entry)
            if not entries:
                info('lists no branch, so only main or master is synced')
            names = ['main', 'master'] + entries
        else:
            names = default_branches()
    seen = []
    for name in names:
        if name not in seen and on_origin(name):
            seen.append(name)
    write(out, ''.join(name + '\n' for name in seen))


def reuse_cover(paths):
    text = read('REUSE.toml')
    missing = [p for p in paths if '"%s"' % p not in text]
    if not missing:
        return False
    # Join the annotation that already covers one of the sync files, as
    # make stable-branch does for .tx/backport.
    for m in re.finditer(r'^(path\s*=\s*)(\[[^\]]*\]|"[^"]*")', text, re.M):
        listed = re.findall(r'"([^"]*)"', m.group(2))
        if any(p in listed for p in L10N_FILES + ('.tx/backport',)):
            merged = sorted(set(listed + missing))
            text = text[:m.start()] + m.group(1) + '[' + ', '.join('"%s"' % p for p in merged) + ']' + text[m.end():]
            write('REUSE.toml', text)
            return True
    # Otherwise a new annotation under the copyright and license REUSE.toml
    # states for itself: these are configuration files of the same repository.
    # REUSE-IgnoreStart
    copyright = re.search(r'^#\s*SPDX-FileCopyrightText:\s*(.+?)\s*$$', text, re.M)
    license = re.search(r'^#\s*SPDX-License-Identifier:\s*(.+?)\s*$$', text, re.M)
    if not (copyright and license):
        print('REUSE.toml states no copyright and license of its own - annotate %s yourself.' % ', '.join(missing))
        return False
    block = ('\n[[annotations]]\npath = [%s]\nprecedence = "aggregate"\nSPDX-FileCopyrightText = "%s"\nSPDX-License-Identifier = "%s"\n'
             % (', '.join('"%s"' % p for p in sorted(missing)), copyright.group(1), license.group(1)))
    # REUSE-IgnoreEnd
    write('REUSE.toml', text.rstrip('\n') + '\n' + block)
    return True


def init(app_id, out):
    written = []
    bullets = []
    if os.path.exists('l10n/.gitkeep'):
        print('l10n/.gitkeep exists, left as it is.')
    else:
        write('l10n/.gitkeep', '')
        written.append('l10n/.gitkeep')
        bullets.append('- Add l10n/.gitkeep, by which the translation tool finds the app')
    if os.path.exists('.l10nignore'):
        print('.l10nignore exists, left as it is - make l10n-check holds it against the build outputs.')
    else:
        trees = needed_trees('.')
        if trees:
            write('.l10nignore', ''.join(t + '\n' for t in trees))
            written.append('.l10nignore')
            bullets.append('- Add .l10nignore, which keeps %s out of the string extraction' % ', '.join(trees))
        else:
            print('No build output or third-party tree to exclude, so no .l10nignore.')
    if os.path.exists('.tx/config'):
        print('.tx/config exists, left as it is - make l10n-check holds it against the app id.')
    else:
        write('.tx/config', TX_CONFIG % {'r': RESOURCE, 'id': app_id})
        written.append('.tx/config')
        bullets.append('- Add .tx/config for the Transifex resource %s' % app_id)
    for path in written:
        print('wrote: %s' % path)
    staged = list(written)
    if written and os.path.isfile('REUSE.toml'):
        if reuse_cover(written):
            staged.append('REUSE.toml')
            bullets.append('- Cover them in REUSE.toml')
            print('wrote: REUSE.toml')
    elif written and os.path.isdir('LICENSES'):
        print('No REUSE.toml - give %s a license, or make reuse fails.' % ', '.join(written))
    write(os.path.join(out, 'l10n_paths'), ''.join(p + '\n' for p in staged))
    write(os.path.join(out, 'l10n_bullets'), '\n'.join(bullets))


if len(sys.argv) == 4 and sys.argv[1] == 'init':
    init(sys.argv[2], sys.argv[3])
elif len(sys.argv) == 3 and sys.argv[1] == 'check':
    check(sys.argv[2])
elif len(sys.argv) == 3 and sys.argv[1] == 'branches':
    branches(sys.argv[2])
else:
    sys.exit('usage: ncmake_l10n.py init <app id> <dir> | check <dir> | branches <file>')
sys.exit(1 if findings else 0)
endef
export l10n_tool

l10n_run = mkdir -p "$(cache_dir)" && printf '%s\n' "$$l10n_tool" > "$(cache_dir)/ncmake_l10n.py" && l10n_ignored='$(l10n_ignored)' l10n_sync_script='$(l10n_sync_script)' l10n_branches_fallback='$(l10n_branches_fallback)' python3 "$(cache_dir)/ncmake_l10n.py"

# The source validation, as validateSyncSetup.sh runs it, from inside the app
# copy: the translation tool finds the app by the l10n/ directory below the
# working directory. The image's entrypoint is the sync itself, hence sh.
l10n_no_runtime = echo "ERROR: $(1) runs the Nextcloud translation image, which needs podman or docker - RUNTIME=$(RUNTIME) runs none." >&2; exit 1;
ifeq ($(filter $(RUNTIME),bare none),)
  l10n_validate = $(call container_run,$(l10n_image),--entrypoint sh) -c 'cd "$$1" && php /translationtool.phar prepare-source-validation && /validateTranslationFiles.sh .' l10n-check
  l10n_template = $(call container_run,$(l10n_image),--entrypoint sh) -c 'cd "$$1" && php /translationtool.phar create-pot-files' l10n-lint
endif

# l10n-lint runs the analyser through the core's library section, which a core
# older than this module may lack; say which side is behind rather than run an
# empty command.
l10n_lint_core    = $(if $(value ncmake_lib_in),,echo "ERROR: l10n-lint needs a newer ncmake core - run 'make self-update'" >&2; exit 1;)
# The container sees the app at /app, so the copy and its template are named
# relative to it. A rule file of one's own is mounted next to the shipped one.
l10n_lint_rel     = $(l10n_lint_dir:$(CURDIR)/%=%)
l10n_lint_pot     = $(l10n_lint_rel)/$(app_id)/translationfiles/templates/$(app_id).pot
l10n_lint_mount   = $(if $(L10N_RULES),-v "$(abspath $(L10N_RULES))":/ncmake-rules/$(notdir $(L10N_RULES)):ro)
l10n_lint_args    = --pot="$(l10n_lint_pot)" --files="$(l10n_lint_rel)/files" $(if $(filter 1,$(FIX)),--fix) $(if $(L10N_RULES),--rules="/ncmake-rules/$(notdir $(L10N_RULES))")
l10n_lint_cmdline = make l10n-lint ARGS=\"%s\"

# Inside the nextcloud organisation the sysadmins give the bot its access; any
# other app invites it itself. The commas of the text would split the arguments
# of $(if), so it lives in a variable of its own.
l10n_bot_echo = echo "    - Invite nextcloud-bot as a collaborator with write access:"; \
	echo "        gh api -X PUT repos/$(or $(gh_slug),<owner>/<repo>)/collaborators/nextcloud-bot -f permission=push"; \
	echo "    - Once it has accepted, add it to the bypass list of the ruleset that protects main, mode Exempt."; \
	echo "      The bot pushes its commits directly, so a branch under classic branch protection has to lose it,"; \
	echo "      see $(l10n_docs_url)";
l10n_bot_steps = $(if $(filter nextcloud,$(firstword $(subst /, ,$(gh_slug)))),,$(l10n_bot_echo))

# Pull-request text for l10n-init. Kept in a make variable and exported so the
# backticks survive into the shell as literal text.
define l10n_init_body
`make l10n-init` wrote the files the Nextcloud Transifex sync needs in the repository (the app side of the translation request checklist of nextcloud/docker-ci). Files that already existed are left as they were.
endef
export l10n_init_body

.PHONY: l10n-init l10n-check l10n-lint

# COMMIT / PR as for the workflow targets: without them the files are only
# written. COMMIT, PR, BODY and the branch flow are defined in the core.
l10n-init: check-app
	@$(if $(BODY),test -r "$(BODY)" || { echo "BODY=$(BODY) is not a readable file" >&2; exit 1; };) commit="$(COMMIT)"; pr="$(PR)"; if [ "$$pr" = "1" ]; then commit=1; fi; \
	rm -f "$(cache_dir)/l10n_paths" "$(cache_dir)/l10n_bullets"; \
	if [ "$$commit" != "1" ]; then \
		$(l10n_run) init "$(app_id)" "$(cache_dir)" || exit 1; \
		paths=$$(paste -sd ' ' "$(cache_dir)/l10n_paths"); \
		test -z "$$paths" || echo "Review and commit: git add $$paths"; \
	else \
		eval "$$branch_flow"; \
		flow_branch_start ncmake/l10n/init || exit 1; \
		$(l10n_run) init "$(app_id)" "$(cache_dir)" || { flow_branch_abort "$$branch"; echo "l10n-init failed - branch discarded." >&2; exit 1; }; \
		paths=$$(cat "$(cache_dir)/l10n_paths"); test -z "$$paths" || git add -- $$paths; \
		flow_branch_finish "$$branch" "chore(l10n): prepare the Transifex sync" "$$(cat "$(cache_dir)/l10n_bullets")" "$$l10n_init_body" "$$pr" || exit 1; \
	fi; \
	echo; \
	echo "==> Next, outside the repository:"; \
	$(l10n_bot_steps) \
	echo "    - With the files on origin, 'make l10n-check' validates the setup as the request does."; \
	echo "    - 'make l10n-lint' finds the source strings the translation team rejects in its review."; \
	echo "    - Then open the translation request and work through it:"; \
	echo "        $(l10n_request_url)"

# Per branch the bot syncs: a copy of origin's tree, the file checks, then the
# source validation in the bot's image. The copy is checked out through an index
# of its own, not packed with git archive, which would drop every export-ignore
# path - .tx/ and .l10nignore among the usual ones. Every branch is checked
# before the exit status reports any of them.
l10n-check: check-app
	@$(if $(filter bare none,$(RUNTIME)),$(call l10n_no_runtime,l10n-check)) \
	git fetch --quiet --prune origin || { echo "ERROR: git fetch origin failed." >&2; exit 1; }; \
	rc=0; rm -rf "$(l10n_check_dir)"; \
	$(l10n_run) branches "$(cache_dir)/l10n_branches" || rc=1; \
	for b in $$(cat "$(cache_dir)/l10n_branches"); do \
		echo; echo "==> origin/$$b"; \
		dir="$(l10n_check_dir)/$$b/$(app_id)"; mkdir -p "$$dir"; \
		GIT_INDEX_FILE="$(l10n_check_dir)/index" git read-tree "refs/remotes/origin/$$b" \
			&& GIT_INDEX_FILE="$(l10n_check_dir)/index" git --work-tree="$$dir" checkout-index -a -f \
			|| { echo "  [!] could not copy origin/$$b"; rc=1; continue; }; \
		$(l10n_run) check "$$dir" || rc=1; \
		$(l10n_validate) "/app$${dir#$(CURDIR)}" || rc=1; \
	done; \
	exit $$rc

# The template comes from a copy of the working tree, tracked and untracked files
# as git lists them, because the translation tool writes its fake source files and
# translationfiles/ into the app it reads. The analyser locates the strings, and
# with FIX=1 rewrites them, in the checkout itself.
l10n-lint: check-app
	@$(if $(filter bare none,$(RUNTIME)),$(call l10n_no_runtime,l10n-lint)) \
	$(l10n_lint_core) \
	$(if $(L10N_RULES),test -r "$(L10N_RULES)" || { echo "L10N_RULES=$(L10N_RULES) is not a readable file" >&2; exit 1; };) \
	$(call ncmake_lib_need,$(l10n_lint_libs)); \
	dir="$(l10n_lint_dir)/$(app_id)"; rm -rf "$(l10n_lint_dir)"; mkdir -p "$$dir/l10n"; \
	git ls-files -co --exclude-standard > "$(l10n_lint_dir)/files" || exit 1; \
	tar -cf - --ignore-failed-read -T "$(l10n_lint_dir)/files" | tar -xf - -C "$$dir" || exit 1; \
	echo "==> l10n-lint$(if $(strip $(ARGS)), $(ARGS)) (RUNTIME=$(RUNTIME))" >&2; \
	$(l10n_template) "/app/$(l10n_lint_rel)/$(app_id)" || exit 1; \
	test -s "$(l10n_lint_pot)" || { echo "ERROR: the translation tool wrote no $(l10n_lint_pot)" >&2; exit 1; }; \
	$(call ncmake_lib_in,$(lib_node_image),$(l10n_lint_mount)) '$(call ncmake_lib_guard,l10n-lint) L10N_LINT_CMDLINE="$(l10n_lint_cmdline)" node $(ncmake_lib_path)/l10n-lint.mjs $(l10n_lint_args) $(ARGS) $(ncmake_json_arg)'

define help_l10n-init
make l10n-init [COMMIT=1|PR=1 [BODY=<path>]]    (maintainer)

Writes what the app repository needs for the Nextcloud Transifex sync - the app
side of the translation request checklist of nextcloud/docker-ci - and leaves
every file that already exists as it is:

  l10n/.gitkeep    empty; the translation tool finds the app by its l10n/
  .l10nignore      the trees the string extraction must skip: js/ and vendor/
                   where .gitignore marks them as build output or they exist,
                   vendor-bin/ where it exists
  .tx/config       the template of the request, with the app id $(app_id) as
                   the resource and in the names of the .po and .pot files

Where the app has a REUSE.toml, the new files join the annotation that already
covers one of them, or get one of their own under the copyright and license
REUSE.toml states for itself.

Without flags it only writes the files and names them for git add. COMMIT=1
commits them on ncmake/l10n/init, from main or a stable* branch, without
pushing. PR=1 implies COMMIT=1 and additionally pushes and opens the pull
request via gh.

Afterwards it prints the steps outside the repository: for an app outside the
nextcloud organisation, inviting nextcloud-bot with write access and exempting it
from the ruleset that protects main, since the bot pushes directly; then the
translation request at nextcloud/docker-ci.

  make l10n-init PR=1
endef

define help_l10n-check
make l10n-check

Validates the sync setup the way translations/validateSyncSetup.sh of
nextcloud/docker-ci does, on what origin has, after a git fetch. The branches
are main, master and those in .tx/backport on main, or without that file the
default list of the script, each as far as origin has it. Per branch:

  - .tx/config and l10n/.gitkeep exist, and a missing .l10nignore is a hint
  - the translation tool's prepare-source-validation and
    validateTranslationFiles.sh run over a copy of the branch, in the image the
    Nextcloud bot runs in ($(l10n_image))

and what the script does not check:

  - .l10nignore excludes js/ and vendor/ where .gitignore marks them as build
    output or the branch has them, and vendor-bin/ where it has it; a line with
    a carriage return, trailing blanks or a leading slash is named, because the
    tool compares it unchanged and it never matches
  - the resource in .tx/config, its file_filter and source_file name the app id
    of appinfo/info.xml, which is the name the translation tool writes
  - every branch in .tx/backport is a stable* branch origin has

Findings marked [!] and a failed validation exit non-zero once every branch is
checked. It writes nothing into the checkout; the copies stay under
build/cache/l10n-check. It needs podman or docker.
endef

define help_l10n-lint
make l10n-lint [FIX=1] [L10N_RULES=<file>] [JSON=<file>] [ARGS="..."]

Holds the English source strings against the rules of the Nextcloud translation
team, which reviews them before the first sync and locks the resource until the
ones it rejects are fixed. The strings are the template the translation tool of
the bot's image ($(l10n_image)) writes for a copy of the working tree, tracked
and untracked files alike; each is located in the sources, as the literal of a
t() or n() call or as an element of appinfo/info.xml.

Per string it names the rules it breaks, the fix where a rule has one, and the
file and line. A must rule is what the review rejects, a should rule a style
call. The rules are lib/l10n-rules.json of ncmake, a data file: every rule
carries its source, its check, its fix and examples, and a rule whose examples
do not hold stops the run.

  FIX=1                rewrite every string with a fix in the sources; the
                       l10n/*.json files are left alone, they come from Transifex
  L10N_RULES=<file>    a rule file of one's own instead of the shipped one
  JSON=<file>          write the result as JSON to <file> as well
  ARGS="--self-test"   only test the rule file against its examples

The exit code is 1 while a string breaks a must rule. It writes nothing into the
checkout without FIX=1; the copy stays under build/cache/l10n-lint. It needs
podman or docker.

  make l10n-lint FIX=1
endef

help::
	@echo ""
	@echo "$(ch)Translations (developer module):$(c0)"
	@echo "  $(ct)l10n-init$(c0)            Write l10n/.gitkeep, .l10nignore and .tx/config for the Transifex sync  $(cm)[m]$(c0)"
	@echo "    $(cd)add $(cv)COMMIT=1$(cd) to commit on a branch, or $(cv)PR=1$(cd) to commit and open the PR$(c0)"
	@echo "  $(ct)l10n-check$(c0)           Validate the sync setup on every branch the bot syncs, as Nextcloud does"
	@echo "  $(ct)l10n-lint$(c0)            Check the source strings against the rules of the translation team"
	@echo "    $(cd)add $(cv)FIX=1$(cd) to rewrite what has a fix in the sources$(c0)"
