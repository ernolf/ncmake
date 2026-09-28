#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// consistency-audit - does the checkout agree with itself.
//
// An app states the same fact in several places: the version in appinfo/info.xml
// and in package.json, the PHP floor in info.xml and in composer.json, the Node
// version in package.json, in .nvmrc and in the CI workflows. Each file is valid
// on its own, and the defect is that they disagree - which no linter sees, because
// a linter checks one file against a rule, and this checks the files against each
// other.
//
// The second half is what a release needs and a checkout can be missing: the link
// from a published version back to its source, a version range that names a server
// that exists, a lockfile, a lint gate. Each absence is reported with the reason it
// matters, once, and never as a score.
//
// Metadata only: no build output, no install, no bytes, no network, and no npm
// dependency. It runs on any Nextcloud app, one that never heard of ncmake
// included. What the checkout does not state is reported as undetermined rather
// than guessed. Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';

import {
	LEGEND,
	cut,
	howToRun,
	num,
	plural,
	renderFindings,
	sortFindings,
	table,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',        // the app checkout; nothing outside it is read
	top: 12,         // rows per table, 0 = all
	details: false,  // every table; the default is the verdict alone
	json: false,
};

// The server releases this file knows about. An audit that reads no network cannot
// look them up, so the state is written down with the month it was taken in, and
// the report names that month wherever it judges by it. The analyser is refreshed
// from the ncmake cache like every module, which is what keeps this current.
const NC = { newest: 35, oldestMaintained: 32, asOf: '2026-09' };

// Directories that hold no statement of this app: installed third-party trees and
// the git database.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor']);

// A lockfile names every transitive package, so searching it would find every
// dependency referenced and the reference scan would always pass.
const LOCKFILES = [
	{ file: 'package-lock.json', manager: 'npm' },
	{ file: 'yarn.lock', manager: 'yarn' },
	{ file: 'pnpm-lock.yaml', manager: 'pnpm' },
	{ file: 'composer.lock', manager: 'composer' },
];

// Reading these as text finds nothing and costs the most.
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.woff',
	'.woff2', '.ttf', '.eot', '.zip', '.gz', '.tgz', '.pdf', '.mp3', '.mp4', '.webm', '.map']);

// Beyond this a file is a bundle or a fixture, not a statement about the app.
const READ_MAX = 4 * 1024 * 1024;

// == Command line ==
function usage() {
	return `consistency-audit - does the checkout agree with itself

Usage: consistency-audit.mjs [options] [dir]

  dir                   the app checkout to audit (default: ${defaults.dir})

Options:
  --top=N               rows per table, 0 for all (default: ${defaults.top})
  --details             print every table behind the findings
  --json                emit the full result as JSON and nothing else
  -h, --help            this text

The audit reads the checkout only: no build, no install, no network. It reports
without failing - the exit code is 0 whatever is found, and 1 only when the run
itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`consistency-audit: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	for (const arg of argv) {
		const eq = arg.indexOf('=');
		const key = eq === -1 ? arg : arg.slice(0, eq);
		const val = eq === -1 ? '' : arg.slice(eq + 1);
		switch (key) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--json': opt.json = true; break;
			case '--details': opt.details = true; break;
			case '--top': opt.top = Number(val); break;
			default:
				if (key.startsWith('-')) die(`unknown option: ${key}`);
				if (dir !== null) die(`only one directory can be audited: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (!Number.isInteger(opt.top) || opt.top < 0) die('--top needs a whole number, 0 or more');
	return opt;
}

// == What the files state ==
// info.xml is read textually, not parsed. An app with a namespace prefix or a
// stray entity still states a version, and an XML parser would be the first
// dependency this analyser family does not have.
const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

function tagText(xml, name) {
	const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
	return m ? m[1].trim() : null;
}

function tagAttrs(xml, name) {
	const m = xml.match(new RegExp(`<${name}(\\s[^>]*?)?\\s*/?>`));
	if (!m) return null;
	const out = {};
	for (const a of (m[1] ?? '').matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[a[1]] = a[2];
	return out;
}

function readInfo(root) {
	const file = path.join(root, 'appinfo', 'info.xml');
	if (!fs.existsSync(file)) return null;
	const xml = stripComments(fs.readFileSync(file, 'utf8'));
	const dep = xml.match(/<dependencies>[\s\S]*?<\/dependencies>/)?.[0] ?? '';
	return {
		id: tagText(xml, 'id'),
		version: tagText(xml, 'version'),
		licence: tagText(xml, 'licence') ?? tagText(xml, 'license'),
		repository: tagText(xml, 'repository'),
		bugs: tagText(xml, 'bugs'),
		website: tagText(xml, 'website'),
		nextcloud: tagAttrs(dep, 'nextcloud'),
		php: tagAttrs(dep, 'php'),
	};
}

// A file that exists but does not parse is a finding of its own, so a broken JSON
// is carried as broken instead of counting as absent.
function readJson(root, name) {
	const file = path.join(root, name);
	if (!fs.existsSync(file)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { _broken: true };
		return { ...parsed, _broken: false };
	} catch {
		return { _broken: true };
	}
}

const readText = (root, name) => {
	const file = path.join(root, name);
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

// The tooling the audit looks for, each by the file that runs it rather than by a
// package in package.json: a declared linter without its configuration does
// nothing. 'legacy' is a form that is still read but no longer the current one.
const TOOLS = [
	{
		id: 'eslint',
		label: 'ESLint',
		bin: 'eslint',
		files: ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'],
		legacy: ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc'],
		why: 'nothing checks the frontend sources, so a wrong import is found by the build or not at all',
		legacyWhy: 'ESLint 9 reads the flat config only; the .eslintrc form is ignored unless the run is pinned to ESLint 8',
	},
	{
		id: 'stylelint',
		label: 'Stylelint',
		bin: 'stylelint',
		files: ['stylelint.config.js', 'stylelint.config.mjs', 'stylelint.config.cjs',
			'.stylelintrc.js', '.stylelintrc.json', '.stylelintrc.yml', '.stylelintrc'],
		why: 'stylesheets are unchecked, and a mistake in CSS fails silently instead of loudly',
	},
	{
		id: 'psalm',
		label: 'Psalm',
		bin: 'psalm',
		files: ['psalm.xml', 'psalm.xml.dist'],
		why: 'the PHP side has no static analysis, which is what catches a wrong type before the server does',
	},
	{
		id: 'phpunit',
		label: 'PHPUnit',
		bin: 'phpunit',
		files: ['phpunit.xml', 'phpunit.xml.dist', 'tests/phpunit.xml', 'tests/phpunit.xml.dist'],
		why: 'there is no test harness in the checkout, so nothing can be run against a change',
	},
	{
		id: 'php-cs-fixer',
		label: 'PHP-CS-Fixer',
		bin: 'php-cs-fixer',
		files: ['.php-cs-fixer.dist.php', '.php-cs-fixer.php'],
		why: 'no coding standard is applied to the PHP sources, so formatting is settled in review instead of by a command',
	},
	{
		id: 'reuse',
		label: 'REUSE',
		files: ['REUSE.toml', '.reuse/dep5'],
		why: 'licensing is not machine-checkable, which the App Store and every distribution ask for',
	},
	{
		id: 'editorconfig',
		label: 'EditorConfig',
		files: ['.editorconfig'],
		why: 'indentation is whatever each contributor\'s editor does',
	},
];

function detectTools(root) {
	return TOOLS.map((t) => {
		const file = t.files.find((f) => fs.existsSync(path.join(root, f))) ?? null;
		const legacy = file ? null : ((t.legacy ?? []).find((f) => fs.existsSync(path.join(root, f))) ?? null);
		return { id: t.id, label: t.label, bin: t.bin ?? null, file, legacy, why: t.why, legacyWhy: t.legacyWhy ?? null };
	});
}

// The build system in the checkout. The ncmake bootstrap stub fetches the core at
// run time and is a few dozen lines; a committed copy carries the whole core and
// no longer follows the reference, which is what the length tells apart. A
// Makefile that never mentions ncmake is some other build system.
function detectMakefile(root) {
	const text = readText(root, 'Makefile');
	if (text === null) return { present: false, kind: null, lines: 0 };
	const lines = text.split('\n').length;
	const ncmake = /ncmake/i.test(text);
	const kind = !ncmake ? 'foreign' : (lines > 200 ? 'copy' : 'stub');
	return { present: true, kind, lines };
}

function detectLocks(root, ignored) {
	const out = [];
	for (const l of LOCKFILES) {
		const file = path.join(root, l.file);
		if (!fs.existsSync(file)) continue;
		let version = null;
		if (l.file === 'package-lock.json') {
			const j = readJson(root, l.file);
			version = j && !j._broken ? (j.lockfileVersion ?? null) : null;
		}
		out.push({ file: l.file, manager: l.manager, version, ignored: ignored.includes(l.file) });
	}
	return out;
}

// Names a .gitignore keeps out of the repository. Only the plain forms matter
// here: a lockfile is ignored as its own name, never through a pattern.
function gitignored(root) {
	const text = readText(root, '.gitignore');
	if (text === null) return [];
	return text.split('\n')
		.map((l) => l.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
		.filter((l) => l && !l.startsWith('#'));
}

// What the installed workflows run on. Read textually for the same reason info.xml
// is: a YAML parser is a dependency, and the two keys wanted here are unambiguous
// in every generated workflow.
function readWorkflows(root) {
	const dir = path.join(root, '.github', 'workflows');
	if (!fs.existsSync(dir)) return { dir, present: false, files: [], node: [], php: [] };
	const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
	const node = new Set();
	const php = new Set();
	for (const f of files) {
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		for (const m of text.matchAll(/node-version:\s*(.+)/g)) for (const v of versionList(m[1])) node.add(v);
		for (const m of text.matchAll(/php-versions?:\s*(.+)/g)) for (const v of versionList(m[1])) php.add(v);
	}
	return { dir, present: true, files, node: [...node].sort(), php: [...php].sort() };
}

// One value, an inline list, or a reference to something this analyser cannot
// resolve. A ${{ ... }} expression is reported as such rather than guessed at.
function versionList(raw) {
	const s = raw.split('#')[0].trim();
	if (!s) return [];
	if (s.includes('${{')) return ['(from a variable)'];
	const inner = s.startsWith('[') ? s.slice(1, s.indexOf(']') === -1 ? s.length : s.indexOf(']')) : s;
	return inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

// == Versions ==
// The first number of a range, whatever form the range takes. Enough to compare
// statements about a platform, which is what this audit does; it is not a semver
// implementation and does not pretend to resolve a range.
function majorOf(raw) {
	if (!raw) return null;
	const m = String(raw).match(/(\d+)/);
	return m ? Number(m[1]) : null;
}

const parts = (v) => String(v ?? '').split(/[^0-9]+/).filter(Boolean).map(Number);

// Compares two dotted versions, shorter one padded with zeros.
function cmpVersion(a, b) {
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	return 0;
}

// The licence family, so 'agpl' in info.xml and 'AGPL-3.0-or-later' in package.json
// are recognised as the same statement while agpl against mit is not.
const licenceFamily = (s) => (s ? (String(s).toLowerCase().match(/[a-z]+/)?.[0] ?? null) : null);

// What .nvmrc states. An alias names a release train this analyser cannot resolve
// without the network, so it is carried as unresolved instead of being mapped.
function readNvmrc(root) {
	const text = readText(root, '.nvmrc');
	if (text === null) return null;
	const value = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0] ?? '';
	return { value, major: /^v?\d/.test(value) ? majorOf(value) : null };
}

// == Dependencies ==
// Only the npm side is checked for references. A composer package is reached
// through a namespace, not through its vendor/name, so a literal scan would
// accuse every one of them.
function collectDeps(pkg) {
	const out = [];
	if (!pkg || pkg._broken) return out;
	for (const section of ['dependencies', 'devDependencies']) {
		for (const [name, range] of Object.entries(pkg[section] ?? {})) out.push({ name, range, section });
	}
	return out;
}

// Everything package.json states apart from the dependency sections. A package
// named only in its own declaration is not referenced; named in a script, in
// browserslist or in any other field it is.
function pkgHaystack(pkg) {
	if (!pkg || pkg._broken) return '';
	const rest = { ...pkg };
	for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) delete rest[k];
	return JSON.stringify(rest);
}

function listFiles(root) {
	const out = [];
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r);
			} else if (e.isFile()) {
				out.push(r);
			}
		}
	};
	walk(root, '');
	return out;
}

// Where each package is named outside its own declaration. A plain substring
// search over the checkout: it can call a package used that is only mentioned in
// prose, and that is the direction to err in - a wrong "unused" would send someone
// to remove a package the build needs.
function scanReferences(root, deps, pkg) {
	const lockNames = LOCKFILES.map((l) => l.file);
	const files = listFiles(root).filter((f) => {
		const base = path.basename(f);
		return base !== 'package.json' && !lockNames.includes(base) && !SKIP_EXT.has(path.extname(f).toLowerCase());
	});
	const open = new Map(deps.map((d) => [d.name, null]));
	const hay = pkgHaystack(pkg);
	for (const name of [...open.keys()]) if (hay.includes(name)) open.set(name, 'package.json');
	let read = 0;
	for (const rel of files) {
		if ([...open.values()].every(Boolean)) break;
		const abs = path.join(root, rel);
		let text;
		try {
			if (fs.statSync(abs).size > READ_MAX) continue;
			text = fs.readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		read += 1;
		for (const [name, seen] of open) if (!seen && text.includes(name)) open.set(name, rel);
	}
	return { files: files.length, read, at: open };
}

// == The report model ==
const BUNDLER_PKGS = ['vite', 'webpack', '@nextcloud/vite-config', '@nextcloud/webpack-vue-config'];

function audit(opt) {
	const root = opt.dir;
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`not a directory: ${root}`);

	const info = readInfo(root);
	const pkg = readJson(root, 'package.json');
	const composer = readJson(root, 'composer.json');
	const ignored = gitignored(root);
	const deps = collectDeps(pkg);
	const scan = pkg && !pkg._broken ? scanReferences(root, deps, pkg) : { files: 0, read: 0, at: new Map() };

	return {
		tool: 'consistency-audit',
		root,
		server: NC,
		app: info && {
			id: info.id,
			version: info.version,
			licence: info.licence,
			repository: info.repository,
			bugs: info.bugs,
			website: info.website,
			nextcloud: info.nextcloud ? { min: info.nextcloud['min-version'] ?? null, max: info.nextcloud['max-version'] ?? null } : null,
			php: info.php ? { min: info.php['min-version'] ?? null, max: info.php['max-version'] ?? null } : null,
		},
		package: pkg && {
			broken: pkg._broken,
			name: pkg.name ?? null,
			version: pkg.version ?? null,
			license: pkg.license ?? null,
			node: pkg.engines?.node ?? null,
			packageManager: pkg.packageManager ?? null,
			scripts: typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {},
			bundlers: BUNDLER_PKGS.filter((p) => (pkg.dependencies ?? {})[p] || (pkg.devDependencies ?? {})[p]),
		},
		composer: composer && {
			broken: composer._broken,
			name: composer.name ?? null,
			license: composer.license ?? null,
			php: composer.require?.php ?? null,
			platformPhp: composer.config?.platform?.php ?? null,
			scripts: typeof composer.scripts === 'object' && composer.scripts ? composer.scripts : {},
		},
		nvmrc: readNvmrc(root),
		tools: detectTools(root),
		licenses: fs.existsSync(path.join(root, 'LICENSES'))
			? fs.readdirSync(path.join(root, 'LICENSES')).filter((f) => f.endsWith('.txt')).sort()
			: null,
		makefile: detectMakefile(root),
		locks: detectLocks(root, ignored),
		ci: readWorkflows(root),
		deps: deps.map((d) => ({ ...d, at: scan.at.get(d.name) ?? null })),
		scan: { files: scan.files, read: scan.read },
		findings: [],
	};
}

// == Findings ==
// A finding names the files it read and what they say. Where the checkout is
// silent, the finding says what is missing and why it would be worth stating,
// which is not the same as claiming a defect.
function findings(r) {
	const out = [];
	const add = (level, id, lines) => out.push({ level, id, lines });
	const app = r.app;
	const pkg = r.package;
	const asOf = `as of ${r.server.asOf}`;

	// -- is this a Nextcloud app at all --
	if (!app) {
		add('info', 'not-an-app', [
			'No appinfo/info.xml here, so this is not a Nextcloud app checkout, or not its root.',
			'  Everything the server and the App Store read comes from that file; without it'
			+ ' the version, the licence, the supported servers and the source link cannot be'
			+ ' checked against anything.',
		]);
	}
	for (const [name, f] of [['package.json', pkg], ['composer.json', r.composer]]) {
		if (f?.broken) {
			add('warn', 'unreadable-json', [
				`${name} is present but does not parse as JSON.`,
				'  Every tool that reads it fails the same way, so nothing this file states'
				+ ' could be taken into account here.',
			]);
		}
	}

	// -- the version, stated twice --
	if (app?.version && pkg && !pkg.broken && pkg.version) {
		if (cmpVersion(app.version, pkg.version) === 0) {
			add('ok', 'versions-agree', [`Version ${app.version} in appinfo/info.xml and package.json.`]);
		} else {
			add('warn', 'version-drift', [
				`Version drift: appinfo/info.xml says ${app.version}, package.json says ${pkg.version}.`,
				'  The App Store and the server read info.xml; everything on the node side reads'
				+ ' package.json. Whichever is behind, a release ends up carrying two version'
				+ ' numbers, and only one of them reaches the user.',
			]);
		}
	} else if (app?.version && pkg && !pkg.broken && !pkg.version) {
		add('info', 'version-drift', [
			`Version ${app.version} in appinfo/info.xml; package.json states no version.`,
			'  Nothing is inconsistent then, and nothing has to be kept in step either. Stating'
			+ ' it in both places is what makes a release bump reviewable in the diff.',
		]);
	} else if (!app?.version && app) {
		add('warn', 'version-drift', ['appinfo/info.xml states no version, which the App Store requires.']);
	}

	// -- the app id against the directory it sits in --
	if (app?.id) {
		const dir = path.basename(path.resolve(r.root));
		if (dir !== app.id) {
			add('info', 'app-id', [
				`The app id is ${app.id}, the checkout directory is ${dir}.`,
				'  The server finds an app by its directory name, so the installed directory has'
				+ ' to be named after the id. A checkout can be named anything, which is why this'
				+ ' is a note and not a defect - but a tarball built from this directory name'
				+ ' would not load.',
			]);
		}
	}

	// -- where a release points back to --
	if (app) {
		const shape = (u) => (u && /^https?:\/\/\S+$/.test(u.trim()));
		const missing = [];
		if (!app.repository) missing.push('<repository>');
		if (!app.bugs) missing.push('<bugs>');
		if (missing.length) {
			add('warn', 'repository-link', [
				`appinfo/info.xml states no ${missing.join(' and no ')}.`,
				'  <repository> is the only machine-readable link from a published release back to'
				+ ' the source it was built from, and <bugs> is where the App Store page sends a'
				+ ' report. Without them a user of the release has no way back to the project.',
			]);
		} else if (!shape(app.repository) || !shape(app.bugs)) {
			add('warn', 'repository-link', [
				'A link in appinfo/info.xml is not an http(s) URL:'
				+ `${shape(app.repository) ? '' : ` <repository> ${app.repository}`}`
				+ `${shape(app.bugs) ? '' : ` <bugs> ${app.bugs}`}.`,
				'  The audit reads no network, so it checks the form only; whether the target'
				+ ' answers is not determined here.',
			]);
		} else {
			add('ok', 'repository-link', ['appinfo/info.xml links its repository and its bug tracker.']);
		}
	}

	// -- which servers the release is for --
	if (app) {
		const nc = app.nextcloud;
		const min = majorOf(nc?.min);
		const max = majorOf(nc?.max);
		if (!nc || (!min && !max)) {
			add('warn', 'nextcloud-support', [
				'appinfo/info.xml declares no <nextcloud> dependency.',
				'  That range is what the App Store matches against a server asking for updates,'
				+ ' and what the server checks before it enables the app. Without it the release'
				+ ' states nothing about where it runs.',
			]);
		} else {
			const lines = [`Declares Nextcloud ${min ?? '?'} to ${max ?? 'no upper bound'}`
				+ `; released majors are ${r.server.oldestMaintained} to ${r.server.newest}, ${asOf}.`];
			let level = 'ok';
			if (!max) {
				level = 'warn';
				lines.push('  Without max-version the range has no end, so the App Store keeps offering'
					+ ' this release to servers that did not exist when it was built.');
			}
			if (min && max && min > max) {
				level = 'warn';
				lines.push(`  min-version ${min} is above max-version ${max}, so the range covers no`
					+ ' server at all.');
			}
			if (min && min > r.server.newest) {
				level = 'warn';
				lines.push(`  min-version ${min} is above the newest released major (${r.server.newest}`
					+ `, ${asOf}), so no server installs this release.`);
			}
			if (max && max < r.server.oldestMaintained) {
				level = 'warn';
				lines.push(`  max-version ${max} is below the oldest maintained major`
					+ ` (${r.server.oldestMaintained}, ${asOf}), so the release covers only servers`
					+ ' that no longer receive fixes.');
			}
			if (min && min < r.server.oldestMaintained) {
				if (level === 'ok') level = 'info';
				lines.push(`  min-version ${min} reaches below the oldest maintained major`
					+ ` (${r.server.oldestMaintained}), which means the code has to keep working with`
					+ ' APIs that are no longer tested upstream.');
			}
			add(level, 'nextcloud-support', lines);
		}
	}

	// -- the PHP floor, stated in two files --
	if (app || r.composer) {
		const infoMin = app?.php?.min ?? null;
		const req = r.composer?.broken ? null : (r.composer?.php ?? null);
		const reqMin = req ? req.match(/\d+(?:\.\d+)*/)?.[0] ?? null : null;
		const platform = r.composer?.platformPhp ?? null;
		const composerSays = !r.composer ? 'no composer.json in the checkout'
			: (r.composer.broken ? 'composer.json could not be read' : 'composer.json states no php requirement');
		if (infoMin && reqMin && cmpVersion(infoMin, reqMin) !== 0) {
			add('warn', 'php-support', [
				`PHP floor drift: appinfo/info.xml says min-version ${infoMin}, composer.json`
				+ ` requires php ${req}.`,
				'  The server enforces the info.xml bound, composer enforces its own, and the'
				+ ' lower of the two is the version the code is actually run on somewhere.',
			]);
		} else if (infoMin && reqMin) {
			add('ok', 'php-support', [`PHP ${infoMin} is the floor in appinfo/info.xml and in composer.json`
				+ `${platform ? `, platform ${platform}` : ''}.`]);
		} else if (infoMin || reqMin) {
			add('info', 'php-support', [
				`PHP floor stated once: ${infoMin ? `appinfo/info.xml min-version ${infoMin}` : `composer.json requires php ${req}`}`
				+ `; ${infoMin ? composerSays : 'appinfo/info.xml declares no php dependency'}.`,
				'  Nothing contradicts anything here. Stating it in both places is what keeps a'
				+ ' composer install from resolving packages for a PHP the server will not run.',
			]);
		}
		if (app?.php?.max) {
			const phpMax = app.php.max;
			add('info', 'php-support-max', [
				`appinfo/info.xml caps PHP at max-version ${phpMax}.`,
				'  A server on a newer PHP refuses to enable the app, so this cap has to be'
				+ ' raised deliberately with every PHP release, not left where it was.',
			]);
		}
	}

	// -- which Node the app is built with --
	{
		const stated = [];
		if (pkg?.node) stated.push({ where: 'package.json engines.node', value: pkg.node, major: majorOf(pkg.node) });
		if (r.nvmrc) stated.push({ where: '.nvmrc', value: r.nvmrc.value, major: r.nvmrc.major });
		for (const v of r.ci.node) stated.push({ where: 'CI workflows', value: v, major: majorOf(v) });
		const majors = [...new Set(stated.map((s) => s.major).filter(Boolean))];
		if (!stated.length) {
			add('info', 'node-version', [
				'No Node version is stated: no engines.node, no .nvmrc, and no node-version in'
				+ ' the installed workflows.',
				'  Whoever builds the app uses whatever Node they have, and a build that works on'
				+ ' one machine is then not evidence for the next.',
			]);
		} else if (majors.length > 1) {
			add('warn', 'node-version', [
				`Node versions disagree: ${stated.map((s) => `${s.value} (${s.where})`).join(', ')}.`,
				'  The version CI builds with is the one the committed assets came from; a'
				+ ' contributor on another major gets a different lockfile and, with a native'
				+ ' dependency, a different build.',
			]);
		} else {
			const missing = [];
			if (!pkg?.node) missing.push('engines.node in package.json');
			if (!r.nvmrc) missing.push('.nvmrc');
			if (r.ci.present && !r.ci.node.length) missing.push('node-version in the workflows');
			const lines = [`Node ${majors[0] ?? stated[0].value} stated in`
				+ ` ${[...new Set(stated.map((s) => s.where))].join(', ')}.`];
			if (missing.length) {
				lines.push(`  Not stated in ${missing.join(', ')}, so nothing keeps the other places`
					+ ' from drifting away from it.');
			}
			add(missing.length ? 'info' : 'ok', 'node-version', lines);
		}
	}

	// -- whether an install can be repeated --
	{
		const node = r.locks.filter((l) => l.manager !== 'composer');
		const php = r.locks.find((l) => l.manager === 'composer');
		const ignoredLocks = r.locks.filter((l) => l.ignored);
		if (pkg && !node.length) {
			add('warn', 'lockfiles', [
				'package.json without a lockfile.',
				'  Every install resolves the ranges afresh, so two builds of the same commit can'
				+ ' contain different code, and npm ci - what CI uses - does not run at all.',
			]);
		} else if (node.length > 1) {
			add('warn', 'two-package-managers', [
				`Two lockfiles: ${node.map((l) => l.file).join(', ')}.`,
				'  They resolve the same ranges independently, so the tree depends on which'
				+ ' command a contributor happens to run, and one of the two files is stale from'
				+ ' the moment the other is updated.',
			]);
		} else if (node.length) {
			const l = node[0];
			add('ok', 'lockfiles', [`${l.file}${l.version ? ` (lockfileVersion ${l.version})` : ''}`
				+ `${php ? ' and composer.lock' : ''} in the checkout`
				+ `${pkg?.packageManager ? `, packageManager ${pkg.packageManager}` : ''}.`]);
		}
		if (ignoredLocks.length) {
			add('warn', 'lockfiles-ignored', [
				`.gitignore keeps ${ignoredLocks.map((l) => l.file).join(', ')} out of the repository.`,
				'  A lockfile that is not committed pins nothing: it exists on the machine that'
				+ ' wrote it and nowhere else.',
			]);
		}
		if (r.composer && !php) {
			add('info', 'lockfiles', [
				'composer.json without composer.lock.',
				'  An app ships its vendor tree, so the versions in it are part of the release;'
				+ ' committing the lockfile is what makes that tree reproducible.',
			]);
		}
	}

	// -- two bundlers in one tree --
	if (pkg?.bundlers?.length) {
		const vite = pkg.bundlers.filter((b) => b.includes('vite'));
		const webpack = pkg.bundlers.filter((b) => b.includes('webpack'));
		if (vite.length && webpack.length) {
			add('warn', 'two-bundlers', [
				`Both bundlers are installed: ${vite.join(', ')} and ${webpack.join(', ')}.`,
				'  The build scripts decide which one produces the committed assets; the other'
				+ ' keeps its config, its plugins and its share of every install, and drifts out'
				+ ' of use without anyone noticing.',
			]);
		}
	}

	// -- what runs over the sources, and what does not --
	{
		const legacy = r.tools.filter((t) => t.legacy);
		const missing = r.tools.filter((t) => !t.file && !t.legacy);
		const have = r.tools.filter((t) => t.file || t.legacy)
			.map((t) => (t.file ? `${t.label} (${t.file})` : `${t.label} (${t.legacy}, superseded form)`));
		const lines = [`Tooling in the checkout: ${have.length ? have.join(', ') : 'none of the configurations this audit looks for'}.`];
		for (const t of legacy) lines.push(` ${t.label} is configured in ${t.legacy}: ${t.legacyWhy}.`);
		for (const t of missing) lines.push(` No ${t.label} configuration: ${t.why}.`);
		add(legacy.length || missing.length ? 'info' : 'ok', 'tooling', lines);
	}

	// -- a command that cannot run --
	// A script calls a tool that has no configuration in the checkout. Unlike a
	// missing linter, which is a choice, this is a command that fails for whoever
	// runs it, and it is found by comparing two files - which is this audit's job.
	{
		const scripts = [
			...Object.entries(pkg?.scripts ?? {}).map(([n, cmd]) => ({ where: 'package.json', n, cmd: String(cmd) })),
			...Object.entries(r.composer?.scripts ?? {}).map(([n, cmd]) => ({ where: 'composer.json', n, cmd: JSON.stringify(cmd) })),
		];
		const orphaned = [];
		for (const t of r.tools) {
			if (!t.bin || t.file || t.legacy) continue;
			const callers = scripts.filter((x) => x.cmd.includes(t.bin));
			if (callers.length) orphaned.push({ tool: t, callers });
		}
		for (const o of orphaned) {
			const wheres = [...new Set(o.callers.map((c) => c.where))].map((w) => {
				const names = o.callers.filter((c) => c.where === w).map((c) => c.n);
				return `${w} ${names.length === 1 ? 'script' : 'scripts'} ${names.join(', ')}`;
			});
			add('warn', 'script-without-config', [
				`${wheres.join(' and ')} ${o.callers.length === 1 ? 'calls' : 'call'} ${o.tool.bin},`
				+ ` and no ${o.tool.label} configuration is in the checkout.`,
				`  ${o.callers[0].cmd}`,
				'  The command is there to be run, so whoever runs it gets a tool that has'
				+ ' nothing to go by - and CI, if it runs the script, reports the failure as the'
				+ ' change under test.',
			]);
		}
	}

	// -- how this checkout is built --
	{
		const m = r.makefile;
		if (!m.present) {
			add('info', 'ncmake-bootstrap', [
				'No Makefile in the checkout.',
				'  Nothing in the repository says how the app is built, released or packaged, so'
				+ ' every step lives in whoever does it.',
			]);
		} else if (m.kind === 'copy') {
			add('info', 'ncmake-bootstrap', [
				`The Makefile is a full ncmake copy (${num(m.lines)} lines), not the bootstrap stub.`,
				'  A copy stops following the reference, so a fix upstream never arrives; the stub'
				+ ' fetches the current core on every run.',
			]);
		} else if (m.kind === 'foreign') {
			add('info', 'ncmake-bootstrap', [
				`The Makefile (${num(m.lines)} lines) does not mention ncmake.`,
				'  Nothing to reconcile - this audit only notes which build system the checkout'
				+ ' carries.',
			]);
		} else {
			add('ok', 'ncmake-bootstrap', [`The ncmake bootstrap stub is in place (${num(m.lines)} lines).`]);
		}
	}

	// -- packages nothing in the checkout names --
	if (pkg && !pkg.broken && r.deps.length) {
		const unref = r.deps.filter((d) => !d.at);
		if (unref.length) {
			add('info', 'unreferenced-dependencies', [
				`${plural(unref.length, 'declared package is', 'declared packages are')} named nowhere`
				+ ` in the checkout: ${unref.slice(0, 8).map((d) => d.name).join(', ')}`
				+ `${unref.length > 8 ? `, and ${num(unref.length - 8)} more` : ''}.`,
				`  Searched as literal names over ${plural(r.scan.read, 'file', 'files')}, package.json`
				+ ' excluded apart from its non-dependency fields, lockfiles excluded. A package'
				+ ' a tool loads by convention from its own name - a preset, a plugin resolved by'
				+ ' a framework - is not named anywhere either, so this is a list to check, not a'
				+ ' list to remove.',
			]);
		} else {
			add('ok', 'unreferenced-dependencies', [`All ${num(r.deps.length)} declared packages are named`
				+ ` somewhere in the checkout.`]);
		}
	}

	// -- the licence, stated in up to four places --
	{
		const stated = [];
		if (app?.licence) stated.push({ where: 'appinfo/info.xml', value: app.licence });
		if (pkg?.license) stated.push({ where: 'package.json', value: pkg.license });
		if (r.composer?.license) stated.push({ where: 'composer.json', value: r.composer.license });
		const families = [...new Set(stated.map((s) => licenceFamily(s.value)).filter(Boolean))];
		if (families.length > 1) {
			add('warn', 'license-drift', [
				`The licence is stated differently: ${stated.map((s) => `${s.value} (${s.where})`).join(', ')}.`,
				'  Whoever redistributes the app has to pick one of them, and the App Store shows'
				+ ' the one from info.xml.',
			]);
		} else if (stated.length) {
			const files = r.licenses?.length ? `, LICENSES/ holds ${r.licenses.join(', ')}` : '';
			// One family, but the spelling can still differ: 'agpl' in info.xml is the App
			// Store's vocabulary, 'AGPL-3.0-or-later' the SPDX identifier. Each value is
			// named with the files that use it, so the reader sees which form is where.
			const byValue = [...new Set(stated.map((x) => x.value))]
				.map((v) => `${v} (${stated.filter((x) => x.value === v).map((x) => x.where).join(', ')})`);
			add(r.licenses ? 'ok' : 'info', 'license-drift', [
				`Licence ${byValue.join(', ')}${files}.`,
				...(r.licenses ? [] : ['  No LICENSES/ directory, so the licence text itself is not in the'
					+ ' checkout, which is what REUSE and the distributions check for.']),
			]);
		}
	}

	return sortFindings(out);
}

// == Human-readable output ==
// How to run this again with other options.
const how = howToRun('CONSISTENCY_AUDIT_CMDLINE', 'consistency-audit.mjs %s');

function renderSummary(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const app = r.app;
	const pkg = r.package;

	p(`consistency-audit  ${path.resolve(r.root)}`);
	p(`  ${app ? `${app.id ?? 'no app id'}${app.version ? ` ${app.version}` : ''}` : 'no appinfo/info.xml'}, `
		+ `${pkg ? (pkg.broken ? 'package.json unreadable' : `${plural(r.deps.length, 'declared package', 'declared packages')}`)
			: 'no package.json'}, `
		+ `${r.composer ? 'composer.json' : 'no composer.json'}, `
		+ `${r.ci.present ? plural(r.ci.files.length, 'installed workflow', 'installed workflows') : 'no installed workflows'}.`);
	p();

	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('The audit compares what the checkout states about itself in more than one place,');
	p('and names what a release needs that the checkout does not state. It reads');
	p('metadata only: no build, no install, no network. Server majors are the ones');
	p(`released as of ${r.server.asOf}, written into the analyser and refreshed with it.`);
	p();
	p(`All tables: ${how('--details')}`);
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

function renderDetails(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);
	const app = r.app;
	const pkg = r.package;

	p();
	p('== What the checkout states ==');
	p('One row per statement, with the file it comes from. An empty value means the file');
	p('is there and says nothing about it.');
	p();
	const rows = [];
	const say = (what, where, value) => rows.push([what, where, value ?? '']);
	if (app) {
		say('App id', 'appinfo/info.xml', app.id);
		say('Version', 'appinfo/info.xml', app.version);
		say('Licence', 'appinfo/info.xml', app.licence);
		say('Repository', 'appinfo/info.xml', app.repository);
		say('Bug tracker', 'appinfo/info.xml', app.bugs);
		say('Website', 'appinfo/info.xml', app.website);
	}
	if (pkg && !pkg.broken) {
		say('Name', 'package.json', pkg.name);
		say('Version', 'package.json', pkg.version);
		say('Licence', 'package.json', pkg.license);
		say('Node', 'package.json engines', pkg.node);
		say('Package manager', 'package.json', pkg.packageManager);
	}
	if (r.nvmrc) say('Node', '.nvmrc', r.nvmrc.value);
	if (r.composer && !r.composer.broken) {
		say('Name', 'composer.json', r.composer.name);
		say('Licence', 'composer.json', r.composer.license);
		say('PHP', 'composer.json require', r.composer.php);
		say('PHP', 'composer.json config.platform', r.composer.platformPhp);
	}
	p(table(['Statement', 'Where', 'Value'], rows, ['l', 'l', 'l']));
	p();

	p('== Declared platform support ==');
	p('The range the App Store matches a server against, and the PHP bound the server');
	p('checks before it enables the app.');
	p();
	p(table(
		['Platform', 'Minimum', 'Maximum', 'Source'],
		[
			['Nextcloud', app?.nextcloud?.min ?? '', app?.nextcloud?.max ?? '', 'appinfo/info.xml'],
			['PHP', app?.php?.min ?? '', app?.php?.max ?? '', 'appinfo/info.xml'],
			['PHP', r.composer?.php ?? '', '', 'composer.json require'],
			['Nextcloud (released)', r.server.oldestMaintained, r.server.newest, `this analyser, ${r.server.asOf}`],
		],
		['l', 'l', 'l', 'l'],
	));
	p();

	if (r.ci.present) {
		p('== Installed workflows ==');
		p('The versions the workflows in .github/workflows name. A value read from a');
		p('variable is not resolved here.');
		p();
		p(table(
			['Workflow', 'Node', 'PHP'],
			[[r.ci.files.join(', '), r.ci.node.join(', '), r.ci.php.join(', ')]],
			['l', 'l', 'l'],
		));
		p();
	}

	p('== Tooling ==');
	p('Each tool by the configuration file that runs it, because a declared package');
	p('without its configuration does nothing.');
	p();
	p(table(
		['Tool', 'Configuration', 'State'],
		r.tools.map((t) => [t.label, t.file ?? t.legacy ?? '', t.file ? 'current form' : (t.legacy ? 'superseded form' : 'not configured')]),
		['l', 'l', 'l'],
	));
	p();

	if (r.locks.length) {
		p('== Lockfiles ==');
		p('The format version is the schema of the lockfile itself, not the version of the');
		p('tool that wrote it. Committed is read from .gitignore, which is all the checkout');
		p('can say.');
		p();
		p(table(
			['File', 'Manager', 'Format version', 'Committed'],
			r.locks.map((l) => [l.file, l.manager, l.version ?? '', l.ignored ? 'no, in .gitignore' : 'yes']),
			['l', 'l', 'r', 'l'],
		));
		p();
	}

	if (r.deps.length) {
		p('== Declared packages ==');
		p('Where each package is first named outside its own declaration. A literal name');
		p('search, so a package resolved by convention shows as named nowhere.');
		p();
		const list = [...r.deps].sort((a, b) => Number(Boolean(a.at)) - Number(Boolean(b.at)) || a.name.localeCompare(b.name));
		const shown = cut(list, opt.top);
		p(table(
			['Package', 'Range', 'Section', 'First named in'],
			shown.rows.map((d) => [d.name, d.range, d.section, d.at ?? 'nowhere']),
			['l', 'l', 'l', 'l'],
		));
		if (shown.hidden) p(`... ${num(shown.hidden)} further packages not shown, use ${how('--details --top=0')}`);
		p();
	}

	return out.join('\n').replace(/\n+$/, '');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = audit(opt);
report.findings = findings(report);
if (opt.json) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	const text = renderSummary(report) + (opt.details ? renderDetails(report, opt) : '');
	process.stdout.write(`${text}\n`);
}
