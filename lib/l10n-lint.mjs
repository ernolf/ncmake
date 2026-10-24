#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// l10n-lint - the English source strings, held against the rules of the
// Nextcloud translation team before they reach Transifex.
//
// Before the first sync the translation team reviews every source string and
// locks the resource until the ones it rejects are fixed. Much of what it rejects
// is mechanical: a typographic apostrophe, three dots, a contraction, a plural
// without its number. This finds those before the review does.
//
// The strings are the ones the sync sends: the template the Nextcloud translation
// tool writes, in the image the bot runs in, handed in by make l10n-lint. That
// template names a dummy file for every string of a .vue file and of info.xml, so
// each string is located in the sources here, as the literal argument of a t() or
// n() call, or as the text of an element of appinfo/info.xml.
//
// The rules are data, not code: l10n-rules.json next to this file, or the file
// --rules names. Every rule carries examples, and a rule whose examples do not hold
// stops the run, so a rule file is tested before it judges an app (--self-test runs
// only that). Node 18 or newer, no npm dependency.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	LEGEND,
	howToRun,
	plural,
	renderFindings,
	shortPath,
	sortFindings,
	writeJsonFile,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',        // the app checkout the strings are located and fixed in
	pot: null,       // the template of the translation tool
	files: null,     // the files of the checkout, one per line, as git lists them
	rules: path.join(path.dirname(fileURLToPath(import.meta.url)), 'l10n-rules.json'),
	fix: false,
	selfTest: false,
	json: false,
	jsonFile: null,
};

// The files the translation tool extracts strings from, by extension, and the one
// it skips; .vue files go through its own template and script matcher.
const SOURCE_EXT = ['.php', '.js', '.jsx', '.mjs', '.html', '.ts', '.tsx', '.py', '.vue'];
const SKIP_EXT = ['.min.js'];
const INFO_XML = 'appinfo/info.xml';

const WEIGHTS = { must: 'warn', should: 'info' };
const CALLS = ['t', 'n'];
const RULE_KEYS = new Set(['id', 'weight', 'source', 'note', 'calls', 'match', 'replace', 'patterns', 'require', 'examples', 'ok']);

// == Command line ==
function usage() {
	return `l10n-lint - the English source strings, held against the translation rules

Usage: l10n-lint.mjs [options] [dir]

  dir                   the app checkout (default: ${defaults.dir})

Options:
  --pot=<file>          the template the translation tool wrote for the app
  --files=<file>        the files of the checkout, one per line
  --rules=<file>        the rule file (default: l10n-rules.json next to this file)
  --fix                 rewrite every finding that has one replacement, in the sources
  --self-test           test the rule file against its own examples, and nothing else
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The exit code is 0 when no string breaks a must rule, 1 when one does or a rule
fails its examples, and 2 when the run itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`l10n-lint: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	for (const arg of argv) {
		const value = (name) => (arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : null);
		switch (arg) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--fix': opt.fix = true; break;
			case '--self-test': opt.selfTest = true; break;
			case '--json': opt.json = true; break;
			default:
				if (value('pot') !== null) { opt.pot = value('pot'); break; }
				if (value('files') !== null) { opt.files = value('files'); break; }
				if (value('rules') !== null) { opt.rules = value('rules'); break; }
				if (value('json-file') !== null) { opt.jsonFile = value('json-file'); break; }
				if (arg.startsWith('-')) die(`unknown option: ${arg}`);
				if (dir !== null) die(`only one directory can be checked: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (opt.jsonFile === '') die('--json-file needs a file');
	if (!opt.selfTest && !(opt.pot && opt.files)) die('--pot and --files are needed, or --self-test');
	return opt;
}

// == The rule file ==
// Every pattern is compiled with the u flag, so \p{L} and the like work as in the
// examples of the file.
function compile(source, where) {
	try {
		return new RegExp(source, 'u');
	} catch (e) {
		die(`${where}: ${e.message}`);
	}
	return null;
}

// A rule file is checked whole before any of it is applied: an unknown key is a
// typo, and a rule that would be skipped without a word is worse than none.
function loadRules(file) {
	let data;
	try {
		data = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		die(`cannot read the rule file ${file}: ${e.message}`);
	}
	const sources = data.sources ?? {};
	const seen = new Set();
	const rules = (data.rules ?? []).map((r, i) => {
		const where = `${file}, rule ${r.id ?? `#${i + 1}`}`;
		for (const key of Object.keys(r)) if (!RULE_KEYS.has(key)) die(`${where}: unknown key ${key}`);
		if (typeof r.id !== 'string' || !r.id) die(`${where}: no id`);
		if (seen.has(r.id)) die(`${where}: the id is used twice`);
		seen.add(r.id);
		if (!(r.weight in WEIGHTS)) die(`${where}: weight is ${r.weight}, not one of ${Object.keys(WEIGHTS).join(', ')}`);
		if (!(r.source in sources)) die(`${where}: source ${r.source} is not one of the sources of the file`);
		if (typeof r.note !== 'string' || !r.note) die(`${where}: no note`);
		if (r.calls !== undefined && !(Array.isArray(r.calls) && r.calls.length && r.calls.every((c) => CALLS.includes(c)))) {
			die(`${where}: calls is a list of ${CALLS.join(', ')}`);
		}
		const kinds = ['match', 'patterns', 'require'].filter((k) => r[k] !== undefined);
		if (kinds.length !== 1) die(`${where}: exactly one of match, patterns and require`);
		if (r.replace !== undefined && r.match === undefined) die(`${where}: replace belongs to match`);
		let patterns = [];
		if (r.match !== undefined) patterns = [{ match: r.match, replace: r.replace }];
		if (r.patterns !== undefined) {
			if (!Array.isArray(r.patterns) || !r.patterns.length) die(`${where}: patterns is a list`);
			patterns = r.patterns;
		}
		patterns = patterns.map((p, n) => {
			if (typeof p.match !== 'string') die(`${where}, pattern ${n + 1}: no match`);
			return { re: compile(p.match, `${where}, pattern ${n + 1}`), source: p.match, replace: p.replace };
		});
		const fixed = patterns.filter((p) => typeof p.replace === 'string').length;
		if (fixed && fixed !== patterns.length) die(`${where}: either every pattern has a replace or none`);
		if (!Array.isArray(r.examples) || !r.examples.length) die(`${where}: no examples`);
		return {
			id: r.id,
			weight: r.weight,
			source: r.source,
			url: sources[r.source],
			note: r.note,
			calls: r.calls ?? CALLS,
			patterns,
			require: r.require === undefined ? null : compile(r.require, `${where}, require`),
			fixable: fixed > 0,
			examples: r.examples,
			ok: r.ok ?? [],
		};
	});
	if (!rules.length) die(`${file} holds no rule`);
	return { file, about: data.about ?? '', rules };
}

// A string is t() or n(); a rule limited to one kind ignores the other. A pattern
// is held to each form of a plural on its own, a requirement to the string as a
// whole: n('One file', '%n files') carries its number.
function hits(rule, forms, kind) {
	if (!rule.calls.includes(kind)) return false;
	if (rule.require) return !forms.some((s) => rule.require.test(s));
	return forms.some((s) => rule.patterns.some((p) => p.re.test(s)));
}

function apply(rule, s) {
	let out = s;
	for (const p of rule.patterns) out = out.replace(new RegExp(p.re.source, 'gu'), p.replace);
	return out;
}

// What the examples of a rule promise: every bad one is hit, the fix of a rule
// that has one turns it into exactly the good one, and neither a good nor an ok
// string is hit.
function selfTest(set) {
	const failures = [];
	for (const rule of set.rules) {
		const kind = rule.calls[0];
		const fail = (msg) => failures.push(`${rule.id}: ${msg}`);
		for (const ex of rule.examples) {
			if (typeof ex.bad !== 'string') { fail('an example has no bad string'); continue; }
			if (!hits(rule, [ex.bad], kind)) fail(`does not find ${show(ex.bad)}`);
			if (rule.fixable) {
				if (typeof ex.good !== 'string') fail(`the example ${show(ex.bad)} has no good string, which a rule with replace needs`);
				else if (apply(rule, ex.bad) !== ex.good) fail(`turns ${show(ex.bad)} into ${show(apply(rule, ex.bad))}, not ${show(ex.good)}`);
			}
			if (typeof ex.good === 'string' && hits(rule, [ex.good], kind)) fail(`still finds ${show(ex.good)}`);
		}
		for (const s of rule.ok) if (hits(rule, [s], kind)) fail(`finds ${show(s)}, which it must leave alone`);
	}
	return failures;
}

// Quoted for the report, with the spaces that look alike told apart.
function show(s) {
	const named = { ' ': '\\u00a0', ' ': '\\u202f', '\t': '\\t', '\n': '\\n' };
	return `"${s.replace(/[  \t\n]/g, (c) => named[c])}"`;
}

// == The template ==
// A PO file as xgettext writes it: msgid and msgid_plural, each one string that
// may run over continuation lines. The header entry has the empty msgid.
function unquote(line) {
	const m = line.match(/^"(.*)"$/);
	if (!m) return '';
	return m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
}

function parsePot(text) {
	const entries = [];
	let cur = null;
	let field = null;
	const flush = () => {
		if (cur && cur.msgid) entries.push(cur);
		cur = null;
		field = null;
	};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) { flush(); continue; }
		if (line.startsWith('#')) {
			if (cur && cur.msgid !== undefined) flush();
			continue;
		}
		const m = line.match(/^(msgctxt|msgid|msgid_plural|msgstr(?:\[\d+\])?)\s+(".*")$/);
		if (m) {
			if (m[1] === 'msgid' && cur && cur.msgid !== undefined) flush();
			cur ??= {};
			field = m[1].startsWith('msgstr') ? null : m[1];
			if (field) cur[field] = unquote(m[2]);
			continue;
		}
		if (field && line.startsWith('"')) cur[field] += unquote(line);
	}
	flush();
	return entries.map((e) => ({
		kind: e.msgid_plural === undefined ? 't' : 'n',
		forms: e.msgid_plural === undefined ? [e.msgid] : [e.msgid, e.msgid_plural],
	}));
}

// == The sources ==
// The files the translation tool reads, by its own rules: no entry whose name
// starts with a dot, nothing below l10n/ or node_modules/, nothing a line of
// .l10nignore is a prefix of.
function sourceFiles(root, listFile) {
	const ignoreFile = path.join(root, '.l10nignore');
	const ignored = fs.existsSync(ignoreFile)
		? fs.readFileSync(ignoreFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
		: [];
	return fs.readFileSync(listFile, 'utf8').split('\n').filter((f) => {
		if (!f) return false;
		if (f === INFO_XML) return true;
		const parts = f.split('/');
		if (parts.some((p) => p.startsWith('.'))) return false;
		if (parts.slice(0, -1).some((p) => p === 'l10n' || p === 'node_modules')) return false;
		if (ignored.some((l) => f.startsWith(l))) return false;
		return SOURCE_EXT.some((e) => f.endsWith(e)) && !SKIP_EXT.some((e) => f.endsWith(e));
	});
}

// The template holds a string as the translation tool read it: escapes resolved,
// and in a .vue template every run of white space made one space. The pattern
// takes each character back to the spellings it can have in a source file.
const ESC = /[.*+?^${}()|[\]\\]/g;
function literalPattern(s) {
	let out = '';
	for (const c of s) {
		if (/\s/.test(c)) out += '(?:\\s|\\\\[ntr])+';
		else if (c === "'") out += "(?:'|\\\\'|&apos;)";
		else if (c === '"') out += '(?:"|\\\\"|&quot;)';
		else if (c === '&') out += '(?:&|&amp;)';
		else if (c === '<') out += '(?:<|&lt;)';
		else if (c === '>') out += '(?:>|&gt;)';
		else out += c.replace(ESC, '\\$&');
	}
	return new RegExp(out.replace(/(\(\?:\\s\|\\\\\[ntr\]\)\+)+/g, '$1'), 'gu');
}

// A match counts only as the whole literal argument of a translation call: the
// first one after t( or n( and the app id, or for a plural the one after the first
// form. In info.xml it is the whole text of an element.
const CALL_BEFORE = /(?:\b(?:t|n|_|_n)\s*\(\s*(?:(?:'[^']*'|"[^"]*"|`[^`]*`|[\w.$]+)\s*,\s*)?|(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)\s*,\s*)$/;
const QUOTES = ["'", '"', '`'];

function locate(forms, texts) {
	const found = [];
	for (const [file, text] of texts) {
		for (const [form, s] of forms.entries()) {
			const re = literalPattern(s);
			for (const m of text.matchAll(re)) {
				const start = m.index;
				const end = start + m[0].length;
				let quote = null;
				if (file === INFO_XML) {
					if (!/>\s*$/.test(text.slice(Math.max(0, start - 200), start)) || !/^\s*</.test(text.slice(end, end + 200))) continue;
				} else {
					quote = text[start - 1];
					if (!QUOTES.includes(quote) || text[end] !== quote) continue;
					if (!CALL_BEFORE.test(text.slice(Math.max(0, start - 1 - 300), start - 1))) continue;
				}
				const line = text.slice(0, start).split('\n').length;
				found.push({ file, line, start, end, quote, form });
			}
		}
	}
	return found;
}

// The fix is applied to the literal as it stands in the file, so its line breaks
// and its own escapes stay; only a quote the fix brings in is escaped for the
// literal it lands in.
function rewrite(literal, quote, fixRules) {
	const unescaped = quote ? literal.replace(/\\(['"`])/g, '$1') : literal;
	let out = unescaped;
	for (const rule of fixRules) out = apply(rule, out);
	if (out === unescaped) return literal;
	return quote ? out.replace(new RegExp(`(?<!\\\\)${quote}`, 'g'), `\\${quote}`) : out;
}

// == The lint ==
function lint(opt, set) {
	const root = path.resolve(opt.dir);
	const entries = parsePot(fs.readFileSync(opt.pot, 'utf8'));
	const files = sourceFiles(root, opt.files);
	const texts = new Map(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
	const strings = [];
	for (const e of entries) {
		// The rules apply in the order of the file, each to what the fixes before it
		// left, so a fix that makes a string fit the next rule is held to it.
		let forms = e.forms;
		const hit = [];
		for (const rule of set.rules) {
			if (!hits(rule, forms, e.kind)) continue;
			hit.push(rule);
			if (rule.fixable) forms = forms.map((s) => apply(rule, s));
		}
		if (!hit.length) continue;
		strings.push({ kind: e.kind, forms: e.forms, fixed: forms, rules: hit, at: locate(e.forms, texts) });
	}
	const report = { root, rules: { file: set.file, count: set.rules.length }, strings: entries.length, files: files.length, findings: [], fixed: [] };
	if (opt.fix) fix(root, texts, strings, report);
	report.findings = findings(strings, set);
	return report;
}

function fix(root, texts, strings, report) {
	const edits = new Map();
	for (const s of strings) {
		const fixRules = s.rules.filter((r) => r.fixable);
		if (!fixRules.length || !s.at.length) continue;
		for (const at of s.at) {
			const text = texts.get(at.file);
			const literal = text.slice(at.start, at.end);
			const next = rewrite(literal, at.quote, fixRules);
			if (next === literal) continue;
			if (!edits.has(at.file)) edits.set(at.file, []);
			edits.get(at.file).push({ ...at, next });
		}
		s.done = s.rules.every((r) => r.fixable);
	}
	for (const [file, list] of edits) {
		let text = texts.get(file);
		// From the end of the file, so an edit does not move the ones before it.
		for (const e of list.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.next + text.slice(e.end);
		fs.writeFileSync(path.join(root, file), text);
		report.fixed.push({ file, strings: list.length });
	}
}

function findings(strings, set) {
	const out = [];
	const add = (level, rule, lines) => out.push({ level, rule, lines });
	for (const s of strings) {
		const label = s.forms.map(show).join(' / ');
		const lines = [`${s.kind}(${label})`];
		for (const r of s.rules) lines.push(`  ${r.id}: ${r.note}${r.fixable ? '' : ' (no automatic fix)'}`);
		if (s.rules.some((r) => r.fixable)) lines.push(`  ${s.done ? 'fixed to' : 'fix'}: ${s.fixed.map(show).join(' / ')}`);
		if (s.at.length) lines.push(`  in ${[...new Set(s.at.map((a) => `${a.file}:${a.line}`))].join(', ')}`);
		else lines.push('  not located in the sources: the template has it, but no t() or n() call or info.xml element was matched');
		const level = s.done ? 'ok' : s.rules.some((r) => r.weight === 'must') ? 'warn' : 'info';
		add(level, s.rules.map((r) => r.id).join(','), lines);
	}
	if (!out.length) add('ok', null, ['No string breaks a rule.']);
	const used = [...new Set(strings.flatMap((s) => s.rules.map((r) => r.source)))];
	for (const src of used) add('info', null, [`Source ${src}: ${set.rules.find((r) => r.source === src).url}`]);
	return sortFindings(out);
}

// == Human-readable output ==
const how = howToRun('L10N_LINT_CMDLINE', 'l10n-lint.mjs %s');

function render(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	p(`l10n-lint  ${r.root}`);
	p(`  ${plural(r.strings, 'string', 'strings')} in the template, located in ${plural(r.files, 'source file', 'source files')},`
		+ ` held against ${plural(r.rules.count, 'rule', 'rules')} of ${shortPath(r.rules.file)}.`);
	if (r.fixed.length) {
		p();
		p('FIXED');
		for (const f of r.fixed) p(`  ${f.file}: ${plural(f.strings, 'string', 'strings')}`);
	}
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('A must rule is what the translation team rejects in its review, a should');
	p('rule a style call. Each finding names the rules it breaks, the fix where');
	p('there is one, and where the string stands in the sources.');
	if (!r.fixed.length && r.findings.some((f) => f.lines.some((l) => l.startsWith('  fix:')))) {
		p();
		p(`Rewrite what has one fix: ${how('--fix')}`);
	}
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const set = loadRules(opt.rules);
const failures = selfTest(set);
if (opt.selfTest || failures.length) {
	for (const f of failures) process.stdout.write(`  [!] ${f}\n`);
	process.stdout.write(failures.length
		? `${shortPath(set.file)}: ${plural(failures.length, 'rule example fails', 'rule examples fail')}.\n`
		: `${shortPath(set.file)}: ${plural(set.rules.length, 'rule holds', 'rules hold')} against its examples.\n`);
	process.exit(failures.length ? 1 : 0);
}
const report = lint(opt, set);
const json = opt.json || opt.jsonFile ? `${JSON.stringify(report, (k, v) => (v instanceof RegExp ? v.source : v), 2)}\n` : null;
if (opt.json) {
	process.stdout.write(json);
} else {
	process.stdout.write(`${render(report)}\n`);
}
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
process.exitCode = report.findings.some((f) => f.level === 'warn') ? 1 : 0;
