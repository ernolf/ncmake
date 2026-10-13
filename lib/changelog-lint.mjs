#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// changelog-lint - does the App Store find this release in the changelog.
//
// The App Store takes the changelog of a release from the tarball and nowhere
// else: it reads exactly <app_id>/CHANGELOG.md for English and
// <app_id>/CHANGELOG.<code>.md for every language it offers, decodes each as
// UTF-8, and shows the section whose heading names the version in
// appinfo/info.xml. A file under another spelling is not read, a section under
// another heading is not found, and nothing tells the developer: the release is
// published with an empty changelog.
//
// This repeats that reading on the checkout, with the rules of the App Store
// parser (nextcloud/appstore, nextcloudappstore/api/v1/release/parser.py:
// _parse_archive and parse_changelog), and names each place where the store would
// come up empty. It reads the checkout only: no build, no network, and no npm
// dependency. Node 18 or newer.
//
// A tagged pre-release is a release and has a section of its own, which is what
// this asks of it. The App Store reads a pre-release from the Unreleased section
// instead and shows its own section with the stable release of the same X.Y.Z,
// because its version pattern stops before the '-'; that is reported, not
// demanded. make tag runs this before it tags.

import fs from 'node:fs';
import path from 'node:path';

import {
	LEGEND,
	howToRun,
	num,
	plural,
	renderFindings,
	sortFindings,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',        // the app checkout; nothing outside it is read
	nightly: false,  // judge the version as make publish NIGHTLY=1 publishes it
	json: false,
};

// The languages the App Store reads a translated changelog for: Django's LANGUAGES
// without the two it excludes (settings/base.py, EXCLUDED_LANGS). Taken from
// django/conf/global_settings.py of Django 4.2.30, the version the App Store locks
// as of 2026-10. The analyser is refreshed from the ncmake cache like every module,
// which is what keeps this current.
const STORE_EXCLUDED = ['en-au', 'en-gb'];
const STORE_LANGS = new Set([
	'af', 'ar', 'ar-dz', 'ast', 'az', 'bg', 'be', 'bn', 'br', 'bs', 'ca', 'ckb', 'cs', 'cy', 'da',
	'de', 'dsb', 'el', 'en', 'eo', 'es', 'es-ar', 'es-co', 'es-mx', 'es-ni', 'es-ve', 'et', 'eu',
	'fa', 'fi', 'fr', 'fy', 'ga', 'gd', 'gl', 'he', 'hi', 'hr', 'hsb', 'hu', 'hy', 'ia', 'id', 'ig',
	'io', 'is', 'it', 'ja', 'ka', 'kab', 'kk', 'km', 'kn', 'ko', 'ky', 'lb', 'lt', 'lv', 'mk', 'ml',
	'mn', 'mr', 'ms', 'my', 'nb', 'ne', 'nl', 'nn', 'os', 'pa', 'pl', 'pt', 'pt-br', 'ro', 'ru',
	'sk', 'sl', 'sq', 'sr', 'sr-latn', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tr', 'tt', 'udm',
	'uk', 'ur', 'uz', 'vi', 'zh-hans', 'zh-hant',
]);
const STORE_AS_OF = 'Django 4.2.30, 2026-10';

// Changelogs under a name the App Store never reads. Matched without regard to
// case; the spellings of CHANGELOG.md itself are judged apart.
const OTHER_NAMES = /^(?:changelog|changes|history|news|release[-_]?notes)(?:\.(?:md|markdown|txt|rst|adoc|ya?ml|json))?$/i;

// == Command line ==
function usage() {
	return `changelog-lint - does the App Store find this release in the changelog

Usage: changelog-lint.mjs [options] [dir]

  dir                   the app checkout to check (default: ${defaults.dir})

Options:
  --nightly             look for the section a nightly release is read from
  --json                emit the full result as JSON and nothing else
  -h, --help            this text

The check reads the checkout only: no build, no network. The exit code is 0 when
nothing is worth changing, 1 when at least one finding is, and 2 when the run
itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`changelog-lint: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	for (const arg of argv) {
		switch (arg) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--json': opt.json = true; break;
			case '--nightly': opt.nightly = true; break;
			default:
				if (arg.startsWith('-')) die(`unknown option: ${arg}`);
				if (dir !== null) die(`only one directory can be checked: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	return opt;
}

// == What the App Store reads ==
// info.xml is read textually, as consistency-audit does: the id and the version are
// all this needs, and an XML parser would be the first dependency.
function readInfo(root) {
	const file = path.join(root, 'appinfo', 'info.xml');
	if (!fs.existsSync(file)) return null;
	const xml = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
	const tag = (name) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? null;
	return { id: tag('id'), version: tag('version') };
}

// The App Store decodes with Python's 'utf-8' codec, which fails on a byte that is
// not UTF-8 and keeps a byte order mark as the first character.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Python's str.strip() and str.splitlines(), which the parser applies. JavaScript's
// trim() also removes a byte order mark, which Python keeps, so neither is used.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const pyStrip = (s) => s.replace(new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g'), '');
// The parser splits a stripped text, so no line terminator ends it.
const pySplitLines = (s) => (s === '' ? [] : s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/));

// parse_changelog: every line belongs to the section of the last version heading
// above it; a pre-release or a nightly is looked up as Unreleased. \d in a Python
// str pattern is any decimal digit, hence \p{Nd}.
const VERSION_HEADING = /^## (?:\[)?(?:v)?(\p{Nd}+\.\p{Nd}+(\.\p{Nd}+)?)/u;
const UNRELEASED_HEADING = /^## \[Unreleased\]/;

function storeKey(version, nightly) {
	return nightly || version.includes('-') ? 'Unreleased' : version;
}

function section(text, key) {
	const result = new Map();
	let curr = '';
	let headed = false;
	for (const line of pySplitLines(pyStrip(text))) {
		const v = line.match(VERSION_HEADING);
		if (v) curr = v[1];
		else if (UNRELEASED_HEADING.test(line)) curr = 'Unreleased';
		else { result.set(curr, [...(result.get(curr) ?? []), line]); continue; }
		headed ||= curr === key;
	}
	return { headed, body: pyStrip((result.get(key) ?? []).join('\n')) };
}

// The section headed by exactly this version, as make changelog writes it and make
// tag asks for it: ## [1.2.3], ## 1.2.3 or ## v1.2.3, up to the next ## heading.
// Unlike the store's pattern, ## [1.2.3-rc.1] is not a section of 1.2.3.
function ownSection(text, version) {
	const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const heading = new RegExp(`^## \\[?v?${esc}(?:\\]|\\s|$)`);
	const lines = [];
	let headed = false;
	let inside = false;
	for (const line of pySplitLines(pyStrip(text))) {
		if (line.startsWith('## ')) {
			inside = heading.test(line);
			headed ||= inside;
		} else if (inside) {
			lines.push(line);
		}
	}
	return { headed, body: pyStrip(lines.join('\n')) };
}

// One entry per file in the app root that is or looks like a changelog. read is
// the language the App Store reads it as, null where it reads it not at all.
function classify(names) {
	const files = [];
	for (const name of names) {
		if (name === 'CHANGELOG.md') { files.push({ name, read: 'en' }); continue; }
		const m = name.match(/^changelog\.(?:([^.]+)\.)?md$/i);
		if (m) {
			const code = m[1];
			if (code === undefined) { files.push({ name, read: null, kind: 'case', want: 'CHANGELOG.md' }); continue; }
			if (name === `CHANGELOG.${code}.md` && STORE_LANGS.has(code)) { files.push({ name, read: code, code }); continue; }
			const norm = code.toLowerCase().replace(/_/g, '-');
			if (STORE_LANGS.has(norm)) files.push({ name, read: null, kind: 'case', want: `CHANGELOG.${norm}.md`, code: norm });
			else files.push({ name, read: null, kind: 'language', code, excluded: STORE_EXCLUDED.includes(norm) });
			continue;
		}
		if (OTHER_NAMES.test(name)) files.push({ name, read: null, kind: 'other' });
	}
	return files.sort((a, b) => a.name.localeCompare(b.name));
}

function lint(opt) {
	const root = opt.dir;
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`not a directory: ${root}`);
	const app = readInfo(root);
	const version = app?.version || null;
	const key = version ? storeKey(version, opt.nightly) : null;
	// Matched against the directory listing rather than with existsSync: where the
	// filesystem ignores case, CHANGELOG.md would also find a changelog.md.
	const files = classify(fs.readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isFile() || d.isSymbolicLink()).map((d) => d.name));
	for (const f of files) {
		if (!f.read) continue;
		const bytes = fs.readFileSync(path.join(root, f.name));
		try {
			const text = utf8.decode(bytes);
			f.utf8 = true;
			f.bom = text.startsWith('\uFEFF');
			if (key) Object.assign(f, section(text, key));
			if (version && !opt.nightly) f.own = ownSection(text, version);
		} catch {
			f.utf8 = false;
		}
	}
	return {
		root,
		app,
		version,
		nightly: opt.nightly,
		prerelease: !opt.nightly && Boolean(version?.includes('-')),
		section: key,
		store: { languages: STORE_LANGS.size, asOf: STORE_AS_OF },
		files,
		findings: [],
	};
}

// == Findings ==
function findings(r) {
	const out = [];
	const add = (level, id, lines) => out.push({ level, id, lines });
	const read = r.files.filter((f) => f.read);
	// CHANGELOG.en.md is read as English too, after CHANGELOG.md and in its place.
	const en = read.some((f) => f.read === 'en');
	// The stable release whose page shows the section of a pre-release.
	const base = r.version?.split('-')[0];

	// -- the English changelog --
	const variant = en ? null : r.files.find((f) => f.kind === 'case' && f.want === 'CHANGELOG.md');
	if (!en) {
		add('warn', 'changelog-missing', variant ? [
			`${variant.name} is not CHANGELOG.md, and the App Store reads that name exactly.`,
			'  Every release is published without a changelog, and ncmake does not ship the file.'
			+ ` git mv ${variant.name} CHANGELOG.md fixes both.`,
		] : [
			'No CHANGELOG.md in the checkout.',
			'  The App Store takes the changelog of a release from CHANGELOG.md in the tarball, so'
			+ ' every release is published without one; make changelog writes its sections into'
			+ ' that file once it exists.',
		]);
	}

	// -- names the App Store does not read --
	for (const f of r.files.filter((x) => x.kind === 'case' && x !== variant)) {
		add('warn', 'changelog-name', [
			`${f.name} is not read: the App Store reads the ${f.code ?? 'English'} changelog as ${f.want},`
			+ ' spelled exactly so.',
			f.want === 'CHANGELOG.md' ? `  CHANGELOG.md is there as well, so ${f.name} is a second copy that is never shown.`
				: `  git mv ${f.name} ${f.want}`,
		]);
	}
	for (const f of r.files.filter((x) => x.kind === 'language')) {
		add('warn', 'changelog-language', [
			`${f.name} is not read: ${f.excluded ? `the App Store leaves out ${f.code}` : `${f.code} is not a language code the App Store knows`}.`,
			`  It reads CHANGELOG.<code>.md for the ${num(r.store.languages)} codes of its language list`
			+ ` (${r.store.asOf}), in lower case and with a hyphen, such as pt-br or zh-hans.`,
		]);
	}
	const others = r.files.filter((x) => x.kind === 'other');
	if (others.length) {
		add('info', 'changelog-other', [
			`${others.map((f) => f.name).join(', ')} ${others.length > 1 ? 'are' : 'is'} not read by the App Store,`
			+ ' which takes the changelog from CHANGELOG.md alone.',
			'  Nothing to change where CHANGELOG.md carries the releases; otherwise the App Store'
			+ ' shows none of them.',
		]);
	}

	// -- what each read file holds for this release --
	for (const f of read.filter((x) => !x.utf8)) {
		add('warn', 'changelog-encoding', [
			`${f.name} is not valid UTF-8.`,
			'  The App Store decodes the file as UTF-8 and cannot read it, so the release carries no'
			+ ' changelog in this language.',
		]);
	}
	if (!r.version) {
		add('info', 'changelog-section', [
			r.app ? 'appinfo/info.xml states no <version>.' : 'No appinfo/info.xml in the checkout.',
			'  Without a version there is no section to look for, so only the file names are checked.',
		]);
	} else {
		const ok = [];
		for (const f of read.filter((x) => x.utf8)) {
			// A nightly is judged by what the store reads, a release by its own section.
			const s = r.nightly ? f : f.own;
			if (s.body) { ok.push(f); continue; }
			const lines = [];
			if (r.nightly) {
				lines.push(f.headed ? `${f.name} has the heading for Unreleased, but nothing under it.`
					: `${f.name} has no section the App Store finds for a nightly.`);
				lines.push('  A nightly release is read from the Unreleased section. The App Store looks for a line'
					+ ' that begins with ## [Unreleased], and shows what follows up to the next version heading;'
					+ ' this release would show nothing.');
			} else {
				lines.push(s.headed ? `${f.name} has the heading for ${r.version}, but nothing under it.`
					: `${f.name} has no section for ${r.version}.`);
				if (r.prerelease) {
					lines.push('  A tagged pre-release is a release of its own: make changelog writes its section and'
						+ ` make tag asks for it. The App Store shows it with the stable ${base}.`);
				} else if (f.body) {
					lines.push('  The App Store would show only the sections of its pre-releases. Where nothing changed'
						+ ' since the last of them, the section says so: No notable changes since <pre-release>.');
				} else {
					lines.push(`  The App Store looks for a line that begins with ## ${r.version} or ## [${r.version}]`
						+ ' (a v before the version is allowed), and shows what follows up to the next such'
						+ ' heading; this release would show nothing.');
				}
			}
			if (f.bom && !s.headed) {
				lines.push('  The file starts with a byte order mark, which the App Store keeps: a heading on the'
					+ ' first line is not recognised.');
			}
			add('warn', 'changelog-section', lines);
		}
		if (ok.length) {
			const head = r.nightly ? 'The App Store finds the Unreleased section'
				: r.prerelease ? `The section for ${r.version} is there`
					: `The App Store finds the section for ${r.version}`;
			add('ok', 'changelog-section', [
				`${head} in ${plural(ok.length, 'changelog', 'changelogs')}.`,
				...ok.map((f) => {
					const body = r.prerelease ? f.own.body : f.body;
					const more = !r.nightly && !r.prerelease && f.body !== f.own.body ? ', its pre-releases included' : '';
					return `  ${f.name} (${f.read}): ${plural(body.split('\n').length, 'line', 'lines')}${more}`;
				}),
			]);
		}
		if (r.prerelease) {
			const english = read.find((f) => f.read === 'en' && f.utf8);
			const held = english?.body
				? `, which holds ${plural(english.body.split('\n').length, 'line', 'lines')} in ${english.name}`
				: ', which is empty';
			add('info', 'changelog-prerelease', [
				`The App Store shows no changelog on the page of ${r.version}.`,
				`  For a version with a '-' it reads the Unreleased section${held}.`
				+ ` The section of ${r.version} appears with the stable ${base}, below that release's own section.`,
			]);
		}
	}
	if (read.some((f) => f.name === 'CHANGELOG.en.md') && read.some((f) => f.name === 'CHANGELOG.md')) {
		add('info', 'changelog-en', [
			'CHANGELOG.en.md replaces CHANGELOG.md in the App Store.',
			'  Both are read as English and the App Store keeps the second, so CHANGELOG.md is not shown.',
		]);
	}

	return sortFindings(out);
}

// == Human-readable output ==
const how = howToRun('CHANGELOG_LINT_CMDLINE', 'changelog-lint.mjs %s');

function render(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const app = r.app;
	p(`changelog-lint  ${path.resolve(r.root)}`);
	p(`  ${app ? `${app.id ?? 'no app id'}${r.version ? ` ${r.version}` : ''}` : 'no appinfo/info.xml'}, `
		+ `${plural(r.files.filter((f) => f.read).length, 'changelog', 'changelogs')} the App Store reads`
		+ `${r.nightly ? ', as a nightly' : ''}.`);
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('The check reads the changelogs as the App Store does when a release is');
	p('published: the file names it looks for, the encoding it expects, and the');
	p('section it shows. A tagged release, a pre-release included, is held to the');
	p('section that names its own version. The language list is the one of');
	p(`${r.store.asOf}, written into the analyser and refreshed with it.`);
	p();
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = lint(opt);
report.findings = findings(report);
if (opt.json) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	process.stdout.write(`${render(report)}\n`);
}
process.exitCode = report.findings.some((f) => f.level === 'warn') ? 1 : 0;
