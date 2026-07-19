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
# so ncmake's own workflows override upstream templates of the same name.
# Each source needs a _list (GitHub contents API) and a _raw (download) URL;
# extend in ncmake.mk by appending to wf_sources and defining both URLs.
wf_sources ?= ncmake nextcloud
export wf_sources
export wf_src_ncmake_list    = https://api.github.com/repos/ernolf/ncmake/contents/workflows?ref=$(ncmake_ref)
export wf_src_ncmake_raw     = $(ncmake_raw)/workflows
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
import re
import subprocess
import sys
import urllib.request

WF_DIR = '.github/workflows'
LOCK = os.path.join(WF_DIR, '.ncmake-workflows.json')
SOURCES = os.environ.get('wf_sources', '').split()

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'ncmake'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

def listing(src):
    entries = json.loads(fetch(os.environ['wf_src_%s_list' % src]))
    raw = os.environ['wf_src_%s_raw' % src]
    out = {}
    props = set()
    for e in entries:
        n = e['name']
        if n.endswith('.properties.json'):
            props.add(n)
        elif n.endswith(('.yml', '.yaml')):
            out[n] = {'sha': e['sha'], 'raw': raw + '/' + n, 'src': src, 'props': None}
    for n, e in out.items():
        p = re.sub(r'\.ya?ml$$', '', n) + '.properties.json'
        if p in props:
            e['props'] = raw + '/' + p
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
    with open(LOCK + '.license', 'w', encoding='utf-8', newline='\n') as f:
        if cop:
            f.write('SPDX-FileCopyrightText: %s\n' % cop)
        f.write('SPDX-License-Identifier: %s\n' % lic)

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
        print('%s: %s' % (verb, path))
    save_lock(lock)
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

.PHONY: workflows workflows-list workflows-install workflows-update

# 'make workflows' alone gives the overview; the old core target of the same
# name (fixed list, no state) is superseded by this module.
workflows: workflows-list

workflows-list:
	@$(wf_run) list

workflows-install:
	@test -n "$(W)" || { echo "Usage: make workflows-install W=\"<name> [<name>...]\"   (names from 'make workflows-list')" >&2; exit 1; }
	@$(wf_run) install $(W)
	@echo "Review and commit: git add $(wf_dir)/"

workflows-update:
	@$(wf_run) update
	@echo "Review and commit: git add $(wf_dir)/"

define help_workflows
make workflows    (alias for workflows-list)

The CI workflow manager: installs GitHub Actions workflows from their upstream
sources (nextcloud/.github workflow templates plus ncmake's own) and keeps them
updatable. See make help-workflows-list, -install, -update and
doc/WORKFLOWS.md in the ncmake repo for the full picture.
endef

define help_workflows-list
make workflows-list

Lists every workflow the configured sources offer, with source, status and
description. Status per file: installed, update available (upstream changed),
modified (local edits - never overwritten by workflows-update), missing (in the
lock but deleted locally), unmanaged (present but not installed through ncmake),
gone upstream (managed but no longer offered). Discovery is live via the GitHub
API, so new upstream workflows appear without any ncmake update.
endef

define help_workflows-install
make workflows-install W="<name> [<name>...]"

Fetches the named workflows (the .yml suffix is optional), replaces GitHub's
template placeholders ($$default-branch from the origin HEAD; unknown ones are
warned about and left as-is), rewrites the org-scoped runner labels so the
templates run outside that org (unless your origin owner is wf_runner_org, in
which case the labels are kept), writes them into .github/workflows/ and records
source, upstream sha and content hash in .ncmake-workflows.json. A .license
sidecar next to the lock keeps make reuse green without a REUSE.toml edit. Commit
the lock and its .license together with the workflows. Reinstalling an existing
file overwrites it, which also adopts an unmanaged file or discards local
modifications.

  make workflows-install W=reuse
  make workflows-install W="lint-php lint-info-xml psalm-matrix"
endef

define help_workflows-update
make workflows-update

Brings every managed workflow to the current upstream state: 'update available'
and 'missing' files are reinstalled, locally modified files are skipped with a
note, up-to-date files are left alone. Run it from time to time (or after a
workflows-list showed updates) and commit the result.
endef

help::
	@echo ""
	@echo "$(ch)CI workflows (developer module):$(c0)"
	@echo "  $(ct)workflows-list$(c0)       List available workflows (nextcloud templates + ncmake) with status"
	@echo "  $(ct)workflows-install$(c0) $(cv)W=...$(c0)  Install workflows into .github/workflows/ (names from the list)"
	@echo "  $(ct)workflows-update$(c0)     Update all managed workflows (locally modified ones are skipped)"
