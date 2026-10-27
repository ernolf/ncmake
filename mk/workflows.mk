# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: CI workflow manager.
#
# Installs GitHub Actions workflows into .github/workflows/ from their upstream
# sources and keeps them updatable. Discovery is dynamic (the sources are listed
# via the GitHub contents API), so new upstream workflows appear here without a
# module update. Provenance lives in .github/workflows/.ncmake-workflows.json
# (committed with the workflows): per file the source, the upstream blob sha and
# the hash of the installed content - that is what makes the three states
# distinguishable: up to date, update available, locally modified.

# Sources, in lookup order: on a name collision the first listed source wins,
# so a workflow of the app's own folder overrides a template of the same name,
# and a template of ernolf/ncmake-workflows one of nextcloud/.github. A source
# added in ncmake.mk (wf_sources += <source>) ranks between the app's folder and
# the two built-in sources. ncmake.mk is read before this module, so the list is
# assembled here instead of defaulted: a += there would otherwise replace it.
#
# A source is either the shorthand owner/repo[@ref][:dir] of a GitHub repository
# (dir defaults to workflows, ref to the default branch) or a name with a _list
# (GitHub contents API) and a _raw (download) URL, defined as wf_src_<name>_list
# and wf_src_<name>_raw - the form for anything that is not GitHub-shaped.
wf_sources := local $(filter-out local ncmake nextcloud,$(wf_sources)) ncmake nextcloud
export wf_sources

# The app's own workflows: the folder wf_local_dir of the checkout, the source
# local. Dependabot keeps it current with directory: "/.ncmake/workflows", which
# never reaches .github/workflows, and workflows-update installs the change.
wf_local_dir ?= .ncmake/workflows
export wf_local_dir

# The templates release on their own, so the source ncmake does not follow
# NCMAKE_REF: it reads main of ernolf/ncmake-workflows, and NCMAKE_WORKFLOWS_REF
# names another branch or a tag. The name ncmake stays, so the lock entries of
# the apps keep resolving.
wf_ref = $(or $(NCMAKE_WORKFLOWS_REF),main)
export wf_src_ncmake_list    = https://api.github.com/repos/ernolf/ncmake-workflows/contents/workflows?ref=$(wf_ref)
export wf_src_ncmake_raw     = https://raw.githubusercontent.com/ernolf/ncmake-workflows/$(wf_ref)/workflows
export wf_src_nextcloud_list = https://api.github.com/repos/nextcloud/.github/contents/workflow-templates
export wf_src_nextcloud_raw  = https://raw.githubusercontent.com/nextcloud/.github/master/workflow-templates

wf_dir  = .github/workflows

# The Nextcloud templates target the org's own runner pool: labels like
# ubuntu-latest-low are org-scoped and do not exist in a repo outside that org,
# so those jobs would queue forever. On install each old=new pair is applied to
# the fetched file, so the templates run anywhere.
#
# Whether to rewrite is decided from the origin owner (gh_slug): a repo INSIDE
# wf_runner_org keeps the labels (it really has those runners), every other repo
# gets the rewrite - so both cases need no configuration. Override either in
# ncmake.mk: set wf_runner_org to your org, or set wf_runner_rewrite directly
# (empty = never rewrite, or your own space-separated old=new pairs).
wf_runner_org     ?= nextcloud
wf_runner_rewrite ?= $(if $(filter $(wf_runner_org),$(firstword $(subst /, ,$(gh_slug)))),,ubuntu-latest-low=ubuntu-latest)
export wf_runner_rewrite

# REUSE for the generated lock file: JSON carries no comment, so a .license
# sidecar declares it (the REUSE sidecar convention). It is generated content, so
# CC0-1.0 is the natural default - the same license the Nextcloud apps put on
# their generated files. Override in ncmake.mk to match your app's convention.
wf_lock_license   ?= CC0-1.0
# Copyright holder for the sidecar. The year is read from date at generation
# time, so a file regenerated in a later year carries that year on its own -
# right for generated content. Override the whole line in ncmake.mk.
wf_lock_copyright ?= $(shell date +%Y) [ernolf] Raphael Gradenwitz
export wf_lock_license
export wf_lock_copyright

# The tool itself: plain python3 (a core requirement anyway), written to the
# build cache at run time - the same pattern the changelog target uses for its
# cliff config, so no quoting acrobatics in the recipes.
define wf_tool
import hashlib
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

WF_DIR = '.github/workflows'
LOCK = os.path.join(WF_DIR, '.ncmake-workflows.json')
SOURCES = os.environ.get('wf_sources', '').split()
SHORTHAND = re.compile(r'^([\w.-]+)/([\w.-]+)(?:@([^:]+))?(?::(.+))?$$')

RETRY_HTTP = (408, 429, 500, 502, 503, 504)

def fetch(url):
    headers = {'User-Agent': 'ncmake'}
    # Anonymous, the contents API allows 60 requests per hour and source IP, which
    # a hosted runner shares with every other job on it; a token, where the
    # environment offers one, raises that to 5000, as for make dev-init.
    tok = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    if tok and url.startswith('https://api.github.com/'):
        headers['Authorization'] = 'Bearer ' + tok
    req = urllib.request.Request(url, headers=headers)
    # The same transient errors curl_retry retries, with the same pause.
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in RETRY_HTTP or attempt == 3:
                raise
        except (urllib.error.URLError, socket.timeout) as e:
            if not isinstance(getattr(e, 'reason', e), socket.timeout) or attempt == 3:
                raise
        time.sleep(10)

def urls(src):
    m = SHORTHAND.match(src)
    if not m:
        return os.environ['wf_src_%s_list' % src], os.environ['wf_src_%s_raw' % src]
    owner, repo, ref, path = m.groups()
    path = (path or 'workflows').strip('/')
    lst = 'https://api.github.com/repos/%s/%s/contents/%s' % (owner, repo, path)
    if ref:
        lst += '?ref=' + ref
    # raw resolves HEAD to the default branch, as the listing without a ref does.
    return lst, 'https://raw.githubusercontent.com/%s/%s/%s/%s' % (owner, repo, ref or 'HEAD', path)

def entries(src):
    if src != 'local':
        lst, raw = urls(src)
        return [(e['name'], e['sha'], raw + '/' + e['name']) for e in json.loads(fetch(lst))]
    # The app's own folder, listed as the API lists a remote one: the git blob sha
    # stands in for the upstream sha, so an edit there shows as an update.
    d = os.environ.get('wf_local_dir', '')
    out = []
    if d and os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            p = os.path.abspath(os.path.join(d, n))
            if os.path.isfile(p):
                with open(p, 'rb') as f:
                    data = f.read()
                sha = hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
                out.append((n, sha, pathlib.Path(p).as_uri()))
    return out

def listing(src):
    out = {}
    props = {}
    for n, sha, url in entries(src):
        if n.endswith('.properties.json'):
            props[n] = url
        elif n.endswith(('.yml', '.yaml')):
            out[n] = {'sha': sha, 'raw': url, 'src': src, 'props': None}
    for n, e in out.items():
        e['props'] = props.get(re.sub(r'\.ya?ml$$', '', n) + '.properties.json')
    return out

def catalog():
    merged = {}
    for src in SOURCES:
        try:
            for n, e in listing(src).items():
                merged.setdefault(n, e)
        except Exception as exc:
            print('WARNING: source %s unavailable (%s)' % (src, exc), file=sys.stderr)
    return merged

def description(entry):
    if not entry['props']:
        return ''
    try:
        desc = json.loads(fetch(entry['props'])).get('description', '')
        # Some upstream descriptions span lines; the table needs one.
        return ' '.join(desc.split())
    except Exception:
        return ''

def load_lock():
    try:
        with open(LOCK, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return {}

def save_lock(lock):
    os.makedirs(WF_DIR, exist_ok=True)
    with open(LOCK, 'w', encoding='utf-8') as f:
        json.dump(lock, f, indent=2, sort_keys=True)
        f.write('\n')
    # JSON carries no SPDX header, so declare the generated lock via a .license
    # sidecar - keeps make reuse green without touching the app's REUSE.toml.
    lic = os.environ.get('wf_lock_license', 'CC0-1.0')
    cop = os.environ.get('wf_lock_copyright', '').strip()
    # REUSE-IgnoreStart
    with open(LOCK + '.license', 'w', encoding='utf-8', newline='\n') as f:
        if cop:
            f.write('SPDX-FileCopyrightText: %s\n' % cop)
        f.write('SPDX-License-Identifier: %s\n' % lic)
    # REUSE-IgnoreEnd

# A file the manager writes can carry a license the repository has no text for,
# and make reuse then fails. The text comes from the SPDX license list, where
# reuse download gets it too. A repository that does not follow REUSE (neither
# LICENSES/ nor REUSE.toml) gets no LICENSES/ folder of its own.
SPDX_TEXT = 'https://raw.githubusercontent.com/spdx/license-list-data/main/text/%s.txt'

def add_licenses(paths):
    if not (os.path.isdir('LICENSES') or os.path.isfile('REUSE.toml')):
        return []
    # REUSE-IgnoreStart
    tag = re.compile(r'SPDX-License-Identifier:\s*(.+)')
    # REUSE-IgnoreEnd
    need = {}
    for path in paths:
        with open(path, encoding='utf-8') as f:
            for line in f:
                m = tag.search(line)
                if not m:
                    continue
                for lic in re.findall(r'[A-Za-z0-9][A-Za-z0-9.+-]*', m.group(1)):
                    if lic not in ('AND', 'OR', 'WITH'):
                        need.setdefault(lic, path)
    added = []
    for lic, path in sorted(need.items()):
        target = os.path.join('LICENSES', lic + '.txt')
        if os.path.exists(target):
            continue
        if lic.startswith('LicenseRef-'):
            sys.exit('ERROR: %s is under %s, which is not on the SPDX license list - add %s yourself.' % (path, lic, target))
        try:
            text = fetch(SPDX_TEXT % lic)
        except Exception as e:
            sys.exit('ERROR: could not fetch the license text of %s for %s: %s' % (lic, path, e))
        os.makedirs('LICENSES', exist_ok=True)
        with open(target, 'wb') as f:
            f.write(text)
        print('added: %s (license of %s)' % (target, path))
        added.append(target)
    return added

def file_hash(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()

def default_branch():
    try:
        ref = subprocess.run(
            ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
            capture_output=True, text=True, encoding='utf-8',
        ).stdout.strip()
        if ref:
            return ref.split('/', 1)[1]
    except Exception:
        pass
    return 'main'

# GitHub's template placeholders are lowercase-hyphenated ($default-branch,
# $protected-branches, ...); requiring the hyphen keeps plain shell variables
# in run: blocks out of the match.
PLACEHOLDER = re.compile(r'\$$[a-z]+(?:-[a-z]+)+')

def substitute(text, name):
    for token in sorted(set(PLACEHOLDER.findall(text))):
        if token == '$$default-branch':
            branch = default_branch()
            text = text.replace(token, branch)
            print('  %s: replaced %s with %s' % (name, token, branch))
        else:
            print('  WARNING %s: unknown placeholder %s left as-is - edit the file manually' % (name, token))
    return text

def rewrite_runners(text, name):
    # Longest-match first so a replacement value that is a prefix of a rewritten
    # label (ubuntu-latest vs ubuntu-latest-low) never gets rewritten in turn.
    for pair in sorted(os.environ.get('wf_runner_rewrite', '').split(), key=len, reverse=True):
        if '=' in pair:
            old, new = pair.split('=', 1)
            if old in text:
                text = text.replace(old, new)
                print('  %s: runner %s -> %s' % (name, old, new))
    return text

def state(name, entry, lock):
    path = os.path.join(WF_DIR, name)
    exists = os.path.exists(path)
    li = lock.get(name)
    if li and exists:
        if file_hash(path) != li['hash']:
            return 'modified'
        if entry and entry['sha'] != li['sha']:
            return 'update available'
        return 'installed'
    if li:
        return 'missing'
    if exists:
        return 'unmanaged'
    return ''

def cmd_list():
    lock = load_lock()
    cat = catalog()
    rows = []
    for n in sorted(cat):
        rows.append((n, cat[n]['src'], state(n, cat[n], lock), description(cat[n])))
    for n in sorted(lock):
        if n not in cat:
            rows.append((n, lock[n].get('source', '?'), 'gone upstream', ''))
    if not rows:
        print('(no workflows found - all sources unavailable?)')
        return
    w1 = max(max(len(r[0]) for r in rows), len('WORKFLOW')) + 2
    w2 = max(max(len(r[1]) for r in rows), len('SOURCE')) + 2
    w3 = max(max(len(r[2]) for r in rows), len('STATUS')) + 2
    print('%-*s%-*s%-*s%s' % (w1, 'WORKFLOW', w2, 'SOURCE', w3, 'STATUS', 'DESCRIPTION'))
    for r in rows:
        print('%-*s%-*s%-*s%s' % (w1, r[0], w2, r[1], w3, r[2], r[3]))

def install(names, lock, cat):
    failed = False
    written = []
    for name in names:
        if not re.search(r'\.ya?ml$$', name):
            name += '.yml'
        entry = cat.get(name)
        if entry is None:
            print('ERROR: no workflow named %s in any source (see make workflows-list)' % name, file=sys.stderr)
            failed = True
            continue
        text = fetch(entry['raw']).decode('utf-8')
        text = substitute(text, name)
        text = rewrite_runners(text, name)
        path = os.path.join(WF_DIR, name)
        os.makedirs(WF_DIR, exist_ok=True)
        verb = 'updated' if os.path.exists(path) else 'installed'
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
        lock[name] = {'source': entry['src'], 'sha': entry['sha'], 'hash': file_hash(path)}
        written.append(path)
        print('%s: %s' % (verb, path))
        # COMMIT=1 / PR=1 describe each workflow in the pull request body.
        desc_file = os.environ.get('wf_desc_file')
        if desc_file:
            with open(desc_file, 'a', encoding='utf-8', newline='\n') as f:
                f.write('%s\t%s\n' % (name, description(entry)))
    save_lock(lock)
    added = add_licenses(written + [LOCK + '.license'])
    # The make recipes stage and name the added license texts.
    lic_file = os.environ.get('wf_license_file')
    if lic_file:
        with open(lic_file, 'a', encoding='utf-8', newline='\n') as f:
            f.writelines(p + '\n' for p in added)
    if failed:
        sys.exit(1)

def cmd_update():
    lock = load_lock()
    if not lock:
        print('(no managed workflows - install some with make workflows-install W=...)')
        return
    cat = catalog()
    todo = []
    for name in sorted(lock):
        st = state(name, cat.get(name), lock)
        if st == 'modified':
            print('skipped (locally modified - reinstall via workflows-install to discard): %s' % name)
        elif name not in cat:
            print('skipped (gone upstream): %s' % name)
        elif st in ('update available', 'missing'):
            todo.append(name)
        else:
            print('up to date: %s' % name)
    if todo:
        install(todo, lock, cat)

cmd = sys.argv[1]
if cmd == 'list':
    cmd_list()
elif cmd == 'install':
    install(sys.argv[2:], load_lock(), catalog())
elif cmd == 'update':
    cmd_update()
else:
    sys.exit('unknown command: %s' % cmd)
endef
export wf_tool

wf_run = mkdir -p "$(cache_dir)" && printf '%s\n' "$$wf_tool" > "$(cache_dir)/ncmake_workflows.py" && python3 "$(cache_dir)/ncmake_workflows.py"

# COMMIT / PR: by default both targets only rewrite the files in place - that is
# what the workflow updater relies on, so it stays flag-free. COMMIT=1 puts the
# refresh on its own branch and commits it (like 'make version') without pushing;
# PR=1 additionally pushes and opens the pull request via gh, and implies COMMIT=1.
# Both run on main or on a stable* maintenance branch: a line keeps the workflows
# of the tag it started from, and the updater only ever runs on the default branch.
# COMMIT, PR, BODY and the branch flow they use are defined in the core.

# Pull-request body (the commit itself stays lean: title + bullets): the bullets, a
# rule, then BODY or, without it, one paragraph per workflow with its description
# followed by this sentence. Kept in make variables and exported so the backticks
# survive into the shell as literal text instead of being taken for command
# substitution.
define wf_install_body
`make workflows-install` added these ncmake-managed workflows from their sources (the app's .ncmake/workflows/, ernolf/ncmake-workflows, nextcloud/.github). Review the diff and merge.
endef
define wf_update_body
`make workflows-update` refreshed these ncmake-managed workflows from their sources (the app's .ncmake/workflows/, ernolf/ncmake-workflows, nextcloud/.github). Locally modified workflows are left untouched. Review the diff and merge.
endef
export wf_install_body
export wf_update_body

# Finishes the core branch flow for the workflow targets: stages the workflow
# directory and the license texts the run added, and derives one bullet per
# actually changed workflow and per added license text, so install and update
# share the same shape and a no-op discards cleanly. The pull request text is one paragraph per workflow with its
# description, followed by the target's sentence.
define wf_flow
wf_branch_finish() {
    branch="$$1"; title="$$2"; body="$$3"; pr="$$4"
    git add "$(wf_dir)"
    lics=$$(cat "$(cache_dir)/wf_licenses" 2>/dev/null)
    test -z "$$lics" || git add -- $$lics
    names=$$(git diff --cached --name-only -- "$(wf_dir)" | grep -E '\.ya?ml$$' | sed 's#.*/##')
    bullets=$$(printf '%s\n' $$names $$lics | sed 's#^#- #')
    text=$$(for n in $$names; do
        d=$$(awk -F '\t' -v n="$$n" '$$1 == n { print $$2; exit }' "$(cache_dir)/wf_descriptions" 2>/dev/null)
        printf '**%s**%s\n\n' "$$n" "$${d:+: $$d}"
    done; printf '%s\n' "$$body")
    flow_branch_finish "$$branch" "$$title" "$$bullets" "$$text" "$$pr"
}
endef
export wf_flow

.PHONY: workflows workflows-list workflows-install workflows-update

# 'make workflows' alone gives the overview; the old core target of the same
# name (fixed list, no state) is superseded by this module.
workflows: workflows-list

workflows-list:
	@$(wf_run) list

workflows-install:
	@test -n "$(W)" || { echo "Usage: make workflows-install W=\"<name>[,<name>...]\"   (names from 'make workflows-list')" >&2; exit 1; }
	@$(if $(BODY),test -r "$(BODY)" || { echo "BODY=$(BODY) is not a readable file" >&2; exit 1; };) names="$$(echo '$(W)' | tr ',' ' ')"; \
	commit="$(COMMIT)"; pr="$(PR)"; if [ "$$pr" = "1" ]; then commit=1; fi; \
	rm -f "$(cache_dir)/wf_licenses"; export wf_license_file="$(cache_dir)/wf_licenses"; \
	if [ "$$commit" != "1" ]; then \
		$(wf_run) install $$names || exit 1; \
		echo "Review and commit: git add $(wf_dir)/ $$(cat "$$wf_license_file" 2>/dev/null | tr '\n' ' ')"; \
	else \
		eval "$$branch_flow"; eval "$$wf_flow"; \
		flow_branch_start ncmake/ci/workflows-install || exit 1; \
		rm -f "$(cache_dir)/wf_descriptions"; export wf_desc_file="$(cache_dir)/wf_descriptions"; \
		$(wf_run) install $$names || { flow_branch_abort "$$branch"; echo "install failed - branch discarded." >&2; exit 1; }; \
		wf_branch_finish "$$branch" "ci: install managed CI workflows" "$$wf_install_body" "$$pr"; \
	fi

workflows-update:
	@$(if $(BODY),test -r "$(BODY)" || { echo "BODY=$(BODY) is not a readable file" >&2; exit 1; };) commit="$(COMMIT)"; pr="$(PR)"; if [ "$$pr" = "1" ]; then commit=1; fi; \
	rm -f "$(cache_dir)/wf_licenses"; export wf_license_file="$(cache_dir)/wf_licenses"; \
	if [ "$$commit" != "1" ]; then \
		$(wf_run) update; \
		echo "Review and commit: git add $(wf_dir)/ $$(cat "$$wf_license_file" 2>/dev/null | tr '\n' ' ')"; \
	else \
		eval "$$branch_flow"; eval "$$wf_flow"; \
		flow_branch_start ncmake/ci/workflow-update || exit 1; \
		rm -f "$(cache_dir)/wf_descriptions"; export wf_desc_file="$(cache_dir)/wf_descriptions"; \
		$(wf_run) update || { flow_branch_abort "$$branch"; echo "update failed - branch discarded." >&2; exit 1; }; \
		wf_branch_finish "$$branch" "ci: update managed CI workflows from upstream" "$$wf_update_body" "$$pr"; \
	fi

define help_workflows
make workflows    (alias for workflows-list)

The CI workflow manager: installs GitHub Actions workflows from their sources
(the app's own folder .ncmake/workflows/, the templates of ernolf/ncmake-workflows
and those of nextcloud/.github, first listed wins) and keeps them updatable. See make help-workflows-list, -install, -update and
https://github.com/ernolf/ncmake/wiki/Workflows for the full picture.
endef

define help_workflows-list
make workflows-list

Lists every workflow the configured sources offer, with source, status and
description. Status per file: installed, update available (upstream changed),
modified (local edits - never overwritten by workflows-update), missing (in the
lock but deleted locally), unmanaged (present but not installed through ncmake),
gone upstream (managed but no longer offered). Discovery is live via the GitHub
API, so new upstream workflows appear without any ncmake update.

Sources, first listed wins a name collision: local (the folder .ncmake/workflows/
of the app, wf_local_dir), the ones ncmake.mk adds with wf_sources += <source>,
ncmake (ernolf/ncmake-workflows at main, NCMAKE_WORKFLOWS_REF=<ref> for another
branch or a tag) and nextcloud (nextcloud/.github). A source is owner/repo,
optionally with @<ref> and :<dir> (default workflows), or a name with
wf_src_<name>_list and wf_src_<name>_raw URLs. Each remote source costs one
GitHub API call; GITHUB_TOKEN or GH_TOKEN raises the anonymous limit.
endef

define help_workflows-install
make workflows-install W="<name>[,<name>...]" [COMMIT=1|PR=1 [BODY=<path>]]

Fetches the named workflows (the .yml suffix is optional; separate several with
a comma or a space), replaces GitHub's template placeholders ($$default-branch
from the origin HEAD; unknown ones are warned about and left as-is), rewrites the
org-scoped runner labels so the templates run outside that org (unless your
origin owner is wf_runner_org, in which case the labels are kept), writes them
into .github/workflows/ and records source, upstream sha and content hash in
.ncmake-workflows.json, with a .license sidecar next to it. A license that a
written file or the sidecar names (wf_lock_license, default CC0-1.0) and that
LICENSES/ lacks is added from the SPDX license list, so make reuse stays green;
a LicenseRef-* cannot be fetched and stops the run. A repository without
LICENSES/ and REUSE.toml gets no license texts. Commit the lock, its .license
and the added texts together with the workflows. Reinstalling an existing file
overwrites it, which also adopts an unmanaged file or discards local
modifications.

Without flags it only writes the files and reminds you to commit. COMMIT=1 runs
from main or a stable* branch, commits the result on branch
ncmake/ci/workflows-install (on stableX.Y: ncmake/ci/workflows-install-stableX.Y,
one bullet per installed workflow) and prints the push command without pushing -
amend it first if you like. PR=1 implies COMMIT=1 and additionally pushes and
opens the pull request via gh, against the branch it started from. On a stable*
branch this brings a workflow that main gained later to the line. The pull
request body is the bullet list, a rule, and a paragraph per workflow with its
description from the source; BODY=<path> puts the text of that file there
instead. See https://github.com/ernolf/ncmake/wiki/Workflows.

  make workflows-install W=reuse
  make workflows-install W="lint-php,lint-info-xml,psalm-matrix"
  make workflows-install W=reuse COMMIT=1
  make workflows-install W="lint-php psalm-matrix" PR=1
  make workflows-install W="lint-php psalm-matrix" PR=1 BODY=pr-body.md
endef

define help_workflows-update
make workflows-update [COMMIT=1|PR=1 [BODY=<path>]]

Brings every managed workflow to the current upstream state: 'update available'
and 'missing' files are reinstalled, locally modified files are skipped with a
note, up-to-date files are left alone. A license text an updated file needs is
added as for workflows-install. Run it from time to time (or after a
workflows-list showed updates) and commit the result.

Without flags it only writes the files and reminds you to commit - that is what
the automatic updater relies on. COMMIT=1 runs from main or a stable* branch,
commits the result on branch ncmake/ci/workflow-update (on stableX.Y:
ncmake/ci/workflow-update-stableX.Y, one bullet per updated workflow) and prints
the push command without pushing. PR=1 implies COMMIT=1 and additionally pushes
and opens the pull request via gh, against the branch it started from - the same
thing the updater does for you on the default branch. A stable* branch is never
reached by the updater, so run it there by hand. The pull request body is built
as for workflows-install, BODY=<path> included. See
https://github.com/ernolf/ncmake/wiki/Workflows.

  make workflows-update COMMIT=1
  make workflows-update PR=1
endef

help::
	@echo ""
	@echo "$(ch)CI workflows (developer module):$(c0)"
	@echo "  $(ct)workflows-list$(c0)       List available workflows (app folder, ncmake, nextcloud) with status"
	@echo "  $(ct)workflows-install$(c0) $(cv)W=...$(c0)  Install workflows into .github/workflows/ (names from the list)"
	@echo "  $(ct)workflows-update$(c0)     Update all managed workflows (locally modified ones are skipped)"
	@echo "    $(cd)add $(cv)COMMIT=1$(cd) to commit on a branch, or $(cv)PR=1$(cd) to commit and open the PR$(c0)"
