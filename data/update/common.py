# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# What every extraction script of data/ shares: reading a source with the retries
# the core uses for a fetch whose failure costs something, and writing one file.
#
# A file is rewritten only when its values change. Its sources and its read date
# then name the reading that brought the change, so a source that moves on without
# changing a value, a branch head or a patch release, opens no pull request.

import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

DATA_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Four tries, 10 seconds apart, like curl_retry and net_retry of the core.
TRIES = 4
DELAY = 10


def _retry(what, call):
    for n in range(1, TRIES + 1):
        try:
            return call()
        except Exception as e:
            if n == TRIES:
                raise RuntimeError('%s failed %d times: %s' % (what, n, e)) from e
            print('WARNING: %s failed (%s); try %d of %d in %d seconds.' % (what, e, n + 1, TRIES, DELAY), file=sys.stderr)
            time.sleep(DELAY)


def fetch(url, missing_ok=False):
    """The body of url as text. With missing_ok, a 404 returns None: the path
    does not exist at that ref, which is an answer, not a failure."""
    def call():
        req = urllib.request.Request(url, headers={'User-Agent': 'ncmake-data-update'})
        token = os.environ.get('GITHUB_TOKEN')
        if token and url.startswith('https://api.github.com/'):
            req.add_header('Authorization', 'Bearer ' + token)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode('utf-8')
        except urllib.error.HTTPError as e:
            if missing_ok and e.code == 404:
                return None
            raise
    return _retry(url, call)


def ls_remote(repo, *patterns, kind='--heads'):
    """[(sha, ref)] of git ls-remote; kind is --heads, --tags or '' for any ref."""
    def call():
        args = ['git', 'ls-remote'] + ([kind] if kind else []) + (['--refs'] if kind == '--tags' else []) + [repo] + list(patterns)
        out = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', check=True, timeout=120).stdout
        return [tuple(line.split('\t', 1)) for line in out.splitlines() if '\t' in line]
    return _retry('git ls-remote ' + repo, call)


def write(name, about, sources, values):
    """Writes data/<name>.json when values differ from the file's; returns
    whether it did."""
    path = os.path.join(DATA_DIR, name + '.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            if json.load(f).get('values') == values:
                print('%s.json: unchanged' % name)
                return False
    except FileNotFoundError:
        pass
    doc = {
        'about': about,
        'generated_by': 'data/update/%s.py' % name,
        'read': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d'),
        'sources': sources,
        'values': values,
    }
    tmp = path + '.new'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)
    print('%s.json: updated' % name)
    return True
