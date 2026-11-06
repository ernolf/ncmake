# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# make data-check: fails when a value of data/ is written out in lib/, mk/ or
# core/ instead of being read from data/, where the workflow ncmake-data-update
# keeps it current. A copy goes stale without any change to the code, and nobody
# is told.
#
# What counts as a copy:
#   - a sha256 digest, a URL or a version of three numbers of data/, wherever it
#     stands
#   - more than half of the values of one list of data/, at least two, in one
#     file. A list is a JSON array, the values of one object, or the keys of an
#     object that names things rather than fields: one whose keys no object
#     beside it shares. A single value of a list is a mention, not a copy.
# An integer is too common in code to tell a copy apart, and a JavaScript
# identifier counts there only where it is quoted or the key of an object, so a
# variable of the same name is no copy.
#
# A table that ncmake keeps by hand and keys by such values is no copy: it holds
# a judgement no source states. ALLOWED names each one with the reason, and an
# entry that no longer matches fails, so the list cannot outlive its tables.

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
SCOPE = ('lib', 'mk', 'core')

# (file, data file, list): why the file may hold these values
ALLOWED = {
    ('lib/licences.json', 'appstore', 'licences'):
        'the licence table of deps-audit judges each id; its self-test holds them against data/spdx-licenses.json',
    ('lib/licences.json', 'appstore', 'deprecated (keys)'):
        'the licence table of deps-audit names the SPDX id each value of the App Store stands for, which no source states',
    ('lib/consistency-audit.mjs', 'appstore', 'deprecated'):
        'APPSTORE_NAME_IDS names the SPDX id each name of the App Store stands for, which no source states',
}

TOKEN = re.compile(r'[\w.@/+-]+')
IDENT = re.compile(r'[A-Za-z_$][\w$]*')
QUOTED = re.compile(r'''(['"`])([^'"`\n]*)\1''')
KEY = re.compile(r'''(?<![\w$?])([A-Za-z_$][\w$]*)\s*:(?!:)''')
SHA256 = re.compile(r'[0-9a-f]{64}')
VERSION = re.compile(r'\d+\.\d+\.\d+')
CODE = ('.mjs', '.js', '.php')


def lists(values):
    """{list name: set of values} of one data file."""
    out = {}

    def add(name, value):
        if isinstance(value, bool) or isinstance(value, (int, float)):
            return
        out.setdefault(name, set()).add(str(value))

    def walk(v, path, siblings):
        name = '/'.join(path)
        if isinstance(v, list):
            for x in v:
                if not isinstance(x, (dict, list)):
                    add(name, x)
            return
        if not isinstance(v, dict):
            return
        # Keys no sibling object shares are names, not fields.
        if path and not any(set(v) & set(s) for s in siblings):
            for k, x in v.items():
                if not isinstance(x, (dict, list)) and not re.fullmatch(r'\d+', k):
                    add(name + ' (keys)', k)
        dicts = [x for x in v.values() if isinstance(x, dict)]
        for k, x in v.items():
            if isinstance(x, dict) or isinstance(x, list):
                walk(x, path + ['*' if re.fullmatch(r'\d+', k) else k], [d for d in dicts if d is not x])
            elif path:
                add(name, x)
    walk(values, [], [])
    return out


def tokens(path, text):
    words = {t.rstrip('.-') for t in TOKEN.findall(text)}
    if not path.endswith(CODE):
        return words
    named = {w for w in words if not IDENT.fullmatch(w)}
    for m in QUOTED.finditer(text):
        named |= {t.rstrip('.-') for t in TOKEN.findall(m.group(2))}
    named |= set(KEY.findall(text))
    return named


def unmistakable(value, text, words):
    if SHA256.fullmatch(value) or value.startswith(('https://', 'http://')):
        return value in text
    return bool(VERSION.fullmatch(value)) and value in words


def main():
    files = {}
    for top in SCOPE:
        for d, _, names in os.walk(os.path.join(ROOT, top)):
            for n in names:
                p = os.path.join(d, n)
                with open(p, 'r', encoding='utf-8') as f:
                    files[os.path.relpath(p, ROOT).replace(os.sep, '/')] = f.read()
    words = {p: tokens(p, t) for p, t in files.items()}

    failed, used = [], set()
    for df in sorted(n for n in os.listdir(DATA) if n.endswith('.json')):
        data = df[:-5]
        with open(os.path.join(DATA, df), 'r', encoding='utf-8') as f:
            groups = lists(json.load(f)['values'])
        for group, values in sorted(groups.items()):
            for p in sorted(files):
                single = sorted(v for v in values if unmistakable(v, files[p], words[p]))
                # A value of several words is no token; it is looked for as written.
                hit = sorted(v for v in values if (v in files[p] if ' ' in v else v in words[p]))
                copy = len(hit) >= 2 and len(hit) * 2 > len(values)
                if not single and not copy:
                    continue
                if (p, data, group) in ALLOWED:
                    used.add((p, data, group))
                    continue
                if copy:
                    what = '%d of the %d values of %s' % (len(hit), len(values), group)
                else:
                    what, hit = 'a value of %s' % group, single
                failed.append('%s holds %s in data/%s: %s%s' % (p, what, df, ', '.join(hit[:8]), ', ...' if len(hit) > 8 else ''))
    for key in sorted(set(ALLOWED) - used):
        failed.append('ALLOWED in data/check.py names %s and %s of data/%s.json, which no longer match: remove the entry' % (key[0], key[2], key[1]))
    for line in failed:
        print('ERROR: ' + line, file=sys.stderr)
    if failed:
        print('A value of data/ is read with readData() in lib/ and with ncmake_data in a Makefile, never written out.', file=sys.stderr)
        sys.exit(1)
    print('data-check: no value of data/ is written out in %s.' % ', '.join(t + '/' for t in SCOPE))


main()
