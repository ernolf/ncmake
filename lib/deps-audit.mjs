#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// deps-audit - does a dependency that ships have a published vulnerability, or a
// licence the app cannot ship it under.
//
// A release ships the runtime packages of composer.lock in vendor/ and the
// production packages of the npm lock file bundled into js/. This asks the
// package managers' own audits about exactly those, dev dependencies left out,
// and reports each vulnerable package with the release that fixes it and whether
// the declared constraints let an update reach that release.
//
// The same packages are held against the licence the app declares in
// appinfo/info.xml: a bundle is a combined work, so a copyleft package in it puts
// its conditions on the whole app, and a package without a licence cannot be
// distributed at all. composer.lock records the licence of every package, and the
// npm lock file from lockfile version 2 on; for pnpm-lock.yaml, yarn.lock and an
// npm lock without it, the licence comes from the package's manifest in the
// registry. Which licences go together is data, licences.json next to this file,
// and its examples are tested before an app is judged (--self-test runs only that).
//
// --no-advisories, or NO_ADVISORIES=1 through make, leaves the vulnerabilities
// out: no npm audit runs, the composer half keeps only the abandoned packages, and
// neither the report nor the JSON says whether a package has an advisory. That is
// for a run whose output is public, where a finding about a vulnerability would
// name it before a fix is out.
//
// The composer half has run before this, in the build image of the PHP floor:
// make deps-audit leaves the output of lib/deps-audit.php in
// build/deps-audit/composer.json. The npm half runs here, with the package
// manager whose lock file the app ships, on the Node the app declares
// (NCMAKE_APP_NODE where make sets it): npm audit, pnpm audit, yarn npm audit
// or, for Yarn 1, yarn audit. pnpm and yarn come through corepack, as in make
// build. Nothing is written into the checkout but build/deps-audit and the
// report in build/reports/deps-audit.{txt,json}.
//
// The exit code stays 0 with findings: the gate is a workflow of its own, with a
// threshold of its own. Node 18 or newer, no npm dependency.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	LEGEND,
	howToRun,
	num,
	plural,
	renderFindings,
	shortPath,
	sortFindings,
	writeJsonFile,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',        // the app checkout
	details: false,  // every advisory and package of a finding instead of the first few
	json: false,
	jsonFile: null,
	licences: fileURLToPath(new URL('./licences.json', import.meta.url)),
	selfTest: false,
	// make hands NO_ADVISORIES=1 in as DEPS_AUDIT_NO_ADVISORIES.
	advisories: process.env.DEPS_AUDIT_NO_ADVISORIES !== '1',
};
const SAMPLE = 3;    // advisories or packages named per finding without --details
const LOOKUPS = 16;  // registry lookups of a licence that run at the same time
const REPORTS = path.join('build', 'reports');
const RAW = path.join('build', 'deps-audit');

// Set by make where the analyser runs in a container: the Node the app declares,
// mounted beside the Node this runs on. Its bin goes first on PATH, so the audit
// runs with the npm, pnpm or yarn of the app's Node line, as the build does.
const APP_NODE = process.env.NCMAKE_APP_NODE;

// == Command line ==
function usage() {
	return `deps-audit - does a dependency that ships have a published vulnerability

Usage: deps-audit.mjs [options] [dir]

  dir                   the app checkout (default: ${defaults.dir}); for an app with
                        a composer.lock, make deps-audit must have run in it, which
                        leaves the composer audit in ${RAW}

Options:
  --details             every advisory and package of a finding, not the first ${SAMPLE}
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  --licences=<file>     the licence table (default: licences.json beside this file)
  --no-advisories       leave the vulnerabilities out: abandoned packages and
                        licences only, for a run whose output is public
  --self-test          test the licence table against its own examples, and
                        nothing else
  -h, --help            this text

The report is written to ${REPORTS}/deps-audit.txt and ${REPORTS}/deps-audit.json
as well. The exit code is 0 with or without findings, and 2 when the run itself
could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`deps-audit: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	for (const arg of argv) {
		switch (arg) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--json': opt.json = true; break;
			case '--details': opt.details = true; break;
			case '--self-test': opt.selfTest = true; break;
			case '--no-advisories': opt.advisories = false; break;
			default:
				if (arg.startsWith('--json-file=')) { opt.jsonFile = arg.slice('--json-file='.length); break; }
				if (arg.startsWith('--licences=')) { opt.licences = arg.slice('--licences='.length); break; }
				if (arg.startsWith('-')) die(`unknown option: ${arg}`);
				if (dir !== null) die(`only one directory can be checked: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (opt.jsonFile === '') die('--json-file needs a file');
	if (opt.licences === '') die('--licences needs a file');
	return opt;
}

// == Reading ==
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const readJson = (file) => {
	try { return JSON.parse(read(file)); } catch { return null; }
};

// info.xml is read textually, as the other analysers do.
function readInfo(root) {
	const xml = read(path.join(root, 'appinfo', 'info.xml'))?.replace(/<!--[\s\S]*?-->/g, '');
	if (!xml) return null;
	const tag = (name) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? null;
	// The App Store takes any number of <licence> elements, and <license> as well.
	const licences = [...xml.matchAll(/<licen[cs]e(?:\s[^>]*)?>([\s\S]*?)<\/licen[cs]e>/g)].map((m) => m[1].trim()).filter(Boolean);
	return { id: tag('id'), version: tag('version'), licences };
}

// == The licence table ==
// licences.json: the group of every licence it names, which groups of dependency
// licences go with the group of the app's licence, the licences that are not
// free, and the aliases of ids that are deprecated or not SPDX. Ids are matched
// regardless of case, as SPDX does.
function loadTable(file) {
	let t;
	try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`the licence table ${file} could not be read: ${e.message}`); }
	const groups = new Map();
	for (const [group, ids] of Object.entries(t.groups ?? {})) for (const id of ids) groups.set(id.toLowerCase(), { id, group });
	return {
		file,
		groups,
		compatible: new Map(Object.entries(t.compatible ?? {}).map(([g, list]) => [g, new Set(list)])),
		notes: t.notes ?? {},
		nonFree: new Map((t['non-free'] ?? []).map((id) => [id.toLowerCase(), id])),
		aliases: new Map(Object.entries(t.aliases ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
		examples: t.examples ?? [],
	};
}

// An SPDX expression as a tree: OR binds weaker than AND, parentheses group, and
// WITH names an exception, which only adds permissions and so leaves the licence
// as it is. Anything else, SEE LICENSE IN <file> among it, is no expression: null.
function parseExpression(text) {
	const tokens = String(text).replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
	let i = 0;
	const or = () => {
		const list = [and()];
		while (/^or$/i.test(tokens[i] ?? '')) { i++; list.push(and()); }
		return list.includes(null) ? null : list.length === 1 ? list[0] : { op: 'OR', list };
	};
	const and = () => {
		const list = [atom()];
		while (/^and$/i.test(tokens[i] ?? '')) { i++; list.push(atom()); }
		return list.includes(null) ? null : list.length === 1 ? list[0] : { op: 'AND', list };
	};
	const atom = () => {
		const t = tokens[i++];
		if (t === '(') {
			const inner = or();
			return tokens[i++] === ')' ? inner : null;
		}
		if (!t || /^(?:and|or|with|\)|\()$/i.test(t)) return null;
		if (/^with$/i.test(tokens[i] ?? '')) i += 2;
		return { id: t };
	};
	if (!tokens.length) return null;
	const tree = or();
	return i === tokens.length ? tree : null;
}

// The licence ids an expression names.
const leaves = (node) => (!node ? [] : node.list ? node.list.flatMap(leaves) : [node.id]);

// One licence id as the table knows it: free in a group, not free, or unknown.
function classify(table, id) {
	const key = id.toLowerCase();
	const alias = table.aliases.has(key) ? table.aliases.get(key) : undefined;
	if (alias === null) return { id, kind: 'unknown' };
	const canonical = alias ?? id;
	const g = table.groups.get(canonical.toLowerCase());
	if (g) return { id: g.id, kind: 'free', group: g.group };
	const nf = table.nonFree.get(canonical.toLowerCase());
	if (nf) return { id: nf, kind: 'non-free' };
	return { id, kind: 'unknown' };
}

// The verdict on a licence for an app under the licence groups given: OR takes
// the best alternative, AND the worst part. Without a group of the app, a free
// licence passes, as no compatibility can be judged.
const VERDICT_RANK = { compatible: 0, unknown: 1, incompatible: 2, 'non-free': 3 };
function judge(table, licence, appGroups) {
	const tree = licence === null ? null : parseExpression(licence);
	if (!tree) return 'unknown';
	const walk = (node) => {
		if (node.list) {
			const parts = node.list.map(walk);
			return parts.reduce((a, b) => ((node.op === 'OR' ? VERDICT_RANK[b] < VERDICT_RANK[a] : VERDICT_RANK[b] > VERDICT_RANK[a]) ? b : a));
		}
		const c = classify(table, node.id);
		if (c.kind !== 'free') return c.kind;
		return appGroups.every((g) => table.compatible.get(g)?.has(c.group)) ? 'compatible' : 'incompatible';
	};
	return walk(tree);
}

// The app's licences as groups of the table. info.xml may name several, and a
// dependency then has to go with every one of them.
function appLicences(table, info) {
	return (info?.licences ?? []).map((value) => {
		const tree = parseExpression(value);
		const c = tree && !tree.list ? classify(table, tree.id) : { kind: 'unknown' };
		return { value, id: c.kind === 'free' ? c.id : null, group: c.kind === 'free' ? c.group : null };
	});
}

// What the examples of the table promise: each licence gets its verdict for an
// app under the licence named.
function selfTest(table) {
	const failures = [];
	for (const ex of table.examples) {
		const app = appLicences(table, { licences: [ex.app] })[0];
		if (!app.group) { failures.push(`the app licence ${ex.app} of an example is in no group`); continue; }
		const got = judge(table, ex.licence, [app.group]);
		if (got !== ex.verdict) failures.push(`${ex.licence} for an app under ${ex.app} is ${got}, not ${ex.verdict}`);
	}
	return failures;
}

// == Versions and ranges ==
// The range grammar of npm, as far as an advisory or a package.json uses it:
// comparators, hyphen ranges, x-ranges, ~ and ^, alternatives with ||. A version
// is compared as semver; a pre-release satisfies a range only through a
// comparator on the same major.minor.patch, as in npm. What this cannot read, a
// git URL or a tag such as latest, is no range: satisfies returns null.
const VERSION = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(v) {
	const m = VERSION.exec(String(v).trim());
	if (!m) return null;
	const n = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
	return { major: Number(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function cmpPre(a, b) {
	if (!a.length || !b.length) return (b.length ? 1 : 0) - (a.length ? 1 : 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] === undefined) return -1;
		if (b[i] === undefined) return 1;
		const na = /^\d+$/.test(a[i]);
		const nb = /^\d+$/.test(b[i]);
		if (na && nb && Number(a[i]) !== Number(b[i])) return Number(a[i]) - Number(b[i]);
		if (na !== nb) return na ? -1 : 1;
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

function cmp(a, b) {
	return (a.major - b.major) || ((a.minor ?? 0) - (b.minor ?? 0)) || ((a.patch ?? 0) - (b.patch ?? 0)) || cmpPre(a.pre, b.pre);
}
const cmpVersions = (a, b) => cmp(parseVersion(a), parseVersion(b));

const V = (major, minor = 0, patch = 0, pre = []) => ({ major, minor, patch, pre });
const lower = (p) => V(p.major, p.minor ?? 0, p.patch ?? 0, p.pre);

// One comparator token as a list of { op, v }.
function comparators(token) {
	const m = /^(<=|>=|<|>|=|~>|~|\^)?(.*)$/.exec(token);
	const op = m[1] ?? '';
	if (/^[xX*]?$/.test(m[2])) return op === '<' || op === '>' ? [{ op: '<', v: V(0, 0, 0, ['0']) }] : [];
	const p = parseVersion(m[2]);
	if (!p) return null;
	const { major, minor, patch } = p;
	switch (op) {
		case '': case '=':
			if (minor === null) return [{ op: '>=', v: V(major) }, { op: '<', v: V(major + 1) }];
			if (patch === null) return [{ op: '>=', v: V(major, minor) }, { op: '<', v: V(major, minor + 1) }];
			return [{ op: '=', v: lower(p) }];
		case '~': case '~>':
			if (minor === null) return [{ op: '>=', v: V(major) }, { op: '<', v: V(major + 1) }];
			return [{ op: '>=', v: lower(p) }, { op: '<', v: V(major, minor + 1) }];
		case '^':
			if (major > 0 || minor === null) return [{ op: '>=', v: lower(p) }, { op: '<', v: V(major + 1) }];
			if (minor > 0 || patch === null) return [{ op: '>=', v: lower(p) }, { op: '<', v: V(0, minor + 1) }];
			return [{ op: '>=', v: lower(p) }, { op: '<', v: V(0, 0, patch + 1) }];
		case '>':
			if (minor === null) return [{ op: '>=', v: V(major + 1) }];
			if (patch === null) return [{ op: '>=', v: V(major, minor + 1) }];
			return [{ op: '>', v: lower(p) }];
		case '>=': return [{ op: '>=', v: lower(p) }];
		case '<': return [{ op: '<', v: lower(p) }];
		case '<=':
			if (minor === null) return [{ op: '<', v: V(major + 1) }];
			if (patch === null) return [{ op: '<', v: V(major, minor + 1) }];
			return [{ op: '<=', v: lower(p) }];
		default: return null;
	}
}

function parseRange(range) {
	const sets = [];
	for (const alt of String(range).split('||')) {
		const s = alt.trim().replace(/(<=|>=|<|>|=|~>|~|\^)\s+/g, '$1');
		const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
		const tokens = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : s.split(/\s+/).filter(Boolean);
		const set = [];
		for (const t of tokens) {
			const c = comparators(t);
			if (!c) return null;
			set.push(...c);
		}
		sets.push(set);
	}
	return sets;
}

const HOLDS = { '=': (d) => d === 0, '<': (d) => d < 0, '<=': (d) => d <= 0, '>': (d) => d > 0, '>=': (d) => d >= 0 };

function satisfies(version, range) {
	const v = parseVersion(version);
	const sets = parseRange(range);
	if (!v || v.minor === null || v.patch === null || !sets) return null;
	return sets.some((set) => set.every((c) => HOLDS[c.op](cmp(v, c.v)))
		&& (!v.pre.length || set.some((c) => c.v.pre.length && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch)));
}

const released = (v) => /^\d+\.\d+\.\d+$/.test(v);

// The first released version above the locked one that the advisory range spares.
function firstFixed(versions, locked, range) {
	if (!versions) return null;
	return versions.filter(released).sort(cmpVersions)
		.find((v) => cmpVersions(v, locked) > 0 && satisfies(v, range) === false) ?? null;
}

// == The composer half ==
// What lib/deps-audit.php printed in the floor image. A missing file means the
// composer half did not run, which make reports itself; composer.failed holds the
// exit code of a run that did not finish. Without advisories the composer half has
// dropped them already; they are skipped here as well, for a run of the analyser
// on a build/deps-audit an earlier run left.
function readComposer(root, opt) {
	const lock = readJson(path.join(root, 'composer.lock'));
	if (!lock) return null;
	const raw = path.join(root, RAW);
	const failed = read(path.join(raw, 'composer.failed'))?.trim() || null;
	const out = readJson(path.join(raw, 'composer.json'));
	const r = {
		manager: 'composer',
		lock: 'composer.lock',
		shipped: (lock.packages ?? []).length,
		licensed: shippedComposer(lock),
		locked: Object.fromEntries((lock.packages ?? []).map((p) => [p.name, p.version])),
		name: readJson(path.join(root, 'composer.json'))?.name ?? null,
		packages: [],
		abandoned: [],
		unavailable: null,
	};
	// composer audit sets bit 1 for an advisory and bit 2 for an abandoned package;
	// every other code, or no JSON at all, is an audit that did not answer.
	if (failed || !out?.audit || (out.rc & ~3) !== 0) {
		const why = failed ? `the run ended with exit code ${failed}` : `composer audit ended with exit code ${out?.rc ?? 'unknown'}`;
		r.unavailable = { why, lines: composerError(out?.error ?? read(path.join(raw, 'composer.err')) ?? '') };
		return r;
	}
	for (const [name, list] of Object.entries(opt.advisories ? out.audit.advisories ?? {} : {})) {
		const fix = out.fixes?.[name] ?? {};
		r.packages.push({
			name,
			version: (r.locked[name] ?? '').replace(/^v/, ''),
			advisories: list.map((a) => ({
				id: a.cve || a.advisoryId,
				advisory: a.advisoryId,
				cve: a.cve || null,
				title: a.title,
				url: a.link || null,
				severity: severity(a.severity),
				range: a.affectedVersions,
				fixed: fix.first?.[a.advisoryId]?.replace(/^v/, '') ?? null,
			})),
			fixed: fix.all?.replace(/^v/, '') ?? null,
			verdict: composerVerdict(fix, r.name),
		});
	}
	for (const [name, replacement] of Object.entries(out.audit.abandoned ?? {})) {
		r.abandoned.push({ name, version: r.locked[name]?.replace(/^v/, '') ?? null, replacement: replacement || null });
	}
	return r;
}

// composer prints an error as a framed message below a line that names where it
// came from, In <file> line <n>:, and its usage after it; the message explains it.
function composerError(text) {
	const lines = String(text).split('\n').map((l) => l.trim());
	const at = lines.findIndex((l) => /^In \S+ line \d+:$/.test(l));
	if (at < 0) return tail(text);
	const end = lines.findIndex((l, i) => i > at + 1 && !l);
	return lines.slice(at + 1, end < 0 ? undefined : end).filter(Boolean);
}

// composer why-not for the first version that fixes every advisory: exit code 0
// when nothing keeps the update from it, 1 with the constraints that do. The app
// is named by the name in its composer.json, and __root__ without one.
function composerVerdict(fix, rootName) {
	if (!fix.whyNot) return { allowed: null, by: [] };
	const by = fix.whyNot.lines.map((l) => l.trim())
		.filter((l) => l && !/^(?:Not finding|Package ".*" could not be found|There is no installed package)/.test(l))
		.map((l) => l.replace(/^(\S+)( -)? /, (m, who, dash) => (who === rootName || who === '__root__' ? 'composer.json ' : `${who}${dash ?? ''} `)));
	return { allowed: fix.whyNot.rc === 0, by };
}

// == The npm half ==
// The lock file decides the package manager, as in make build: npm-shrinkwrap.json
// wins over package-lock.json, and Yarn 2 and later write a __metadata block.
function nodeManager(root) {
	const lock = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
		.find((f) => fs.existsSync(path.join(root, f))) ?? null;
	if (lock === 'pnpm-lock.yaml') return { name: 'pnpm', lock };
	if (lock === 'yarn.lock') return { name: /^__metadata:/m.test(read(path.join(root, lock))) ? 'yarn-berry' : 'yarn', lock };
	return { name: 'npm', lock };
}

const AUDIT = {
	npm: ['npm', 'audit', '--omit=dev', '--json'],
	pnpm: ['pnpm', 'audit', '--prod', '--json'],
	yarn: ['yarn', 'audit', '--groups', 'dependencies', '--json'],
	// Without --recursive, yarn npm audit reports the direct dependencies only.
	'yarn-berry': ['yarn', 'npm', 'audit', '--environment', 'production', '--recursive', '--json'],
};
const UPDATE = {
	npm: (n) => `make npm ARGS="update ${n}"`,
	pnpm: (n) => `pnpm update ${n}`,
	yarn: (n) => `yarn upgrade ${n}`,
	'yarn-berry': (n) => `yarn up -R ${n}`,
};

function exec(cmd, args, cwd, env) {
	return spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// pnpm and yarn come through corepack, as in make build (node_pm_setup), in the
// version the packageManager field of package.json names. Node 25 and later no
// longer ship corepack, so there it is installed from npm first. The shims go into
// a temporary directory, never into the checkout; AUTO_PIN=0 keeps corepack from
// writing a packageManager field into package.json. Yarn 2 and later would write
// their install state into .yarn/ of the checkout, so it goes there too.
function managerEnv(pm, root, scratch) {
	const env = {};
	if (APP_NODE) env.PATH = `${path.join(APP_NODE, 'bin')}${path.delimiter}${process.env.PATH}`;
	if (pm === 'npm') return { env };
	const prefix = path.join(scratch, 'node-pm');
	const bin = path.join(prefix, 'bin');
	fs.mkdirSync(bin, { recursive: true });
	Object.assign(env, {
		PATH: `${bin}${path.delimiter}${env.PATH ?? process.env.PATH}`,
		COREPACK_ENABLE_AUTO_PIN: '0',
		COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
		YARN_INSTALL_STATE_PATH: path.join(scratch, 'install-state.gz'),
		YARN_ENABLE_TELEMETRY: '0',
	});
	const setup = exec('sh', ['-c', `{ command -v corepack >/dev/null || npm install --global --prefix '${prefix}' corepack; }`
		+ ` && corepack enable --install-directory '${bin}' ${pm === 'pnpm' ? 'pnpm' : 'yarn'}`], root, env);
	if (setup.status !== 0) return { env, error: `corepack could not provide ${pm === 'pnpm' ? 'pnpm' : 'yarn'}`, lines: tail(setup.stderr) };
	return { env };
}

const ndjson = (text) => text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// What a tool printed when it did not answer: the line that names the error where
// there is one, rather than the end of a stack trace, else its last lines.
function tail(text) {
	const lines = String(text).trim().split('\n').map((l) => l.trim()).filter(Boolean);
	const error = lines.find((l) => /^(?:\w*Error\b|error\b|npm error\b|ERR)/i.test(l));
	return error ? [error] : lines.slice(-3);
}

// npm writes the severity of an advisory as moderate where composer writes medium.
function severity(s) {
	const x = String(s ?? '').toLowerCase();
	if (x === 'moderate') return 'medium';
	return ['critical', 'high', 'medium', 'low', 'info'].includes(x) ? x : 'unknown';
}
const RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1, unknown: 0 };
const highest = (list) => list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'unknown');

// The advisories of each audit as { name, version, id, title, url, severity, range },
// one per vulnerable version, or null when the output says the audit did not answer.
const READERS = {
	npm(out, lock) {
		const json = (() => { try { return JSON.parse(out); } catch { return null; } })();
		if (!json?.vulnerabilities) return null;
		const list = [];
		for (const v of Object.values(json.vulnerabilities)) {
			const versions = [...new Set((v.nodes ?? []).map((n) => lock?.packages?.[n]?.version).filter(Boolean))];
			for (const a of v.via ?? []) {
				if (typeof a !== 'object' || a.name !== v.name) continue;
				for (const version of versions) {
					list.push({ name: v.name, version, id: ghsa(a.url) ?? String(a.source), title: a.title, url: a.url,
						severity: severity(a.severity), range: a.range,
						nodes: (v.nodes ?? []).filter((n) => lock?.packages?.[n]?.version === version) });
				}
			}
		}
		return list;
	},
	pnpm(out) {
		const json = (() => { try { return JSON.parse(out); } catch { return null; } })();
		if (!json?.advisories) return null;
		const transitive = new Set();
		for (const a of json.actions ?? []) {
			for (const r of a.resolves ?? []) if (r.path.split('>').length > 2) transitive.add(r.id);
		}
		return Object.values(json.advisories).flatMap((a) => [...new Set((a.findings ?? []).map((f) => f.version))]
			.map((version) => ({ name: a.module_name, version, id: a.github_advisory_id ?? String(a.id), title: a.title, url: a.url,
				severity: severity(a.severity), range: a.vulnerable_versions, transitive: transitive.has(a.id) })));
	},
	yarn(out) {
		const lines = ndjson(out);
		if (!lines.some((l) => l.type === 'auditSummary')) return null;
		const seen = new Set();
		return lines.filter((l) => l.type === 'auditAdvisory').flatMap((l) => {
			const a = l.data.advisory;
			return [...new Set((a.findings ?? []).map((f) => f.version))].filter((version) => !seen.has(`${a.id}\0${version}`))
				.map((version) => {
					seen.add(`${a.id}\0${version}`);
					return { name: a.module_name, version, id: a.github_advisory_id ?? String(a.id), title: a.title, url: a.url,
						severity: severity(a.severity), range: a.vulnerable_versions };
				});
		});
	},
	'yarn-berry'(out, lock, rc) {
		const lines = ndjson(out).filter((l) => l.value && l.children);
		if (!lines.length && rc !== 0) return null;
		return lines.flatMap((l) => (l.children['Tree Versions'] ?? []).map((version) => ({
			name: l.value, version, id: ghsa(l.children.URL) ?? String(l.children.ID), title: l.children.Issue, url: l.children.URL,
			severity: severity(l.children.Severity), range: l.children['Vulnerable Versions'] })));
	},
};
const ghsa = (url) => /\b(GHSA(?:-[0-9a-z]{4}){3})\b/i.exec(url ?? '')?.[1] ?? null;

// The released versions of a package, from the registry the app's .npmrc names.
function registryVersions(name, root, env) {
	const r = exec('npm', ['view', name, 'versions', '--json'], root, env);
	if (r.status !== 0) return null;
	try {
		const v = JSON.parse(r.stdout);
		return Array.isArray(v) ? v : [v];
	} catch { return null; }
}

// The constraints an update of a package has to stay within: the range package.json
// declares for it, and the one each shipped package that depends on it declares.
// package-lock.json records both, with the node each one resolves to; yarn.lock
// records the ranges, not who declares them; pnpm-lock.yaml only the ones of
// package.json. A list that may be incomplete is marked so.
function constraints(pm, root, lock, pkg) {
	const manifest = readJson(path.join(root, 'package.json')) ?? {};
	const direct = manifest.dependencies?.[pkg.name] ?? manifest.optionalDependencies?.[pkg.name];
	if (pm === 'npm' && lock?.packages) {
		const out = [];
		const nodes = new Set(pkg.nodes);
		for (const [p, e] of Object.entries(lock.packages)) {
			if (e.dev || e.link) continue;
			const range = e.dependencies?.[pkg.name] ?? e.optionalDependencies?.[pkg.name] ?? e.peerDependencies?.[pkg.name];
			if (range === undefined || !nodes.has(resolveNode(lock.packages, p, pkg.name))) continue;
			out.push({ from: p === '' ? 'package.json' : `${e.name ?? nodeName(p)} ${e.version}`, range });
		}
		return { list: out, complete: true };
	}
	if (pm === 'yarn' || pm === 'yarn-berry') {
		const out = yarnEntries(read(path.join(root, 'yarn.lock')) ?? '')
			.filter((e) => e.version === pkg.version)
			.flatMap((e) => e.descriptors.filter((d) => d.name === pkg.name))
			.map((d) => ({ from: d.range === direct ? 'package.json' : 'yarn.lock', range: d.range }));
		return { list: out, complete: true };
	}
	return { list: direct === undefined ? [] : [{ from: 'package.json', range: direct }], complete: pm === 'npm' ? direct !== undefined : !pkg.transitive };
}

// The node a package at path p of package-lock.json resolves name to: the nearest
// node_modules/<name> from p upwards, as Node looks it up.
function resolveNode(packages, p, name) {
	for (let at = p; ; at = parentNode(at)) {
		const candidate = `${at ? `${at}/` : ''}node_modules/${name}`;
		if (packages[candidate]) return candidate;
		if (!at) return null;
	}
}
const parentNode = (p) => p.replace(/\/?node_modules\/(?:@[^/]+\/)?[^/]+$/, '');
const nodeName = (p) => /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(p)?.[1] ?? p;

// The entries of yarn.lock: each heading names one or more descriptors,
// name@range, and the version they resolved to follows indented, with the
// dependencies of the package below it. Yarn 1 writes version "1.2.3" and
// name "range", Yarn 2 and later version: 1.2.3 and name: "npm:range".
function yarnEntries(text) {
	const out = [];
	let cur = null;
	let section = null;
	for (const line of text.split('\n')) {
		if (/^[^\s#].*:$/.test(line)) {
			cur = { descriptors: line.slice(0, -1).split(/,\s*/).map((d) => d.replace(/^"|"$/g, '')).map((d) => {
				const at = d.lastIndexOf('@');
				return at > 0 ? { name: d.slice(0, at), range: d.slice(at + 1).replace(/^npm:/, '') } : null;
			}).filter(Boolean), version: null, dependencies: [] };
			out.push(cur);
			section = null;
		} else if (cur && /^ {2}\S/.test(line)) {
			section = /^ {2}(?:dependencies|optionalDependencies):\s*$/.test(line) ? 'deps' : null;
			const m = !cur.version && /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
			if (m) cur.version = m[1];
		} else if (cur && section && /^ {4}\S/.test(line)) {
			const m = /^ {4}"?((?:@[^/"\s]+\/)?[^"\s:]+)"?:?\s+"?([^"]+?)"?\s*$/.exec(line);
			if (m) cur.dependencies.push({ name: m[1], range: m[2].replace(/^npm:/, '') });
		}
	}
	return out;
}

// == The shipped packages ==
// Every package a production install of the lock file brings, as name and
// version, with the licence where the lock file records it. undefined for a
// licence means the lock file does not say; null that the package states none.
function shippedComposer(lock) {
	return (lock.packages ?? []).map((p) => ({
		name: p.name,
		version: String(p.version).replace(/^v/, ''),
		// composer lists the licences a package is offered under, any one of them.
		licence: Array.isArray(p.license) && p.license.length ? p.license.join(' OR ') : null,
	}));
}

// package-lock.json from version 2 on lists every node with its flags; version 1
// nests the dependencies under each other and names no licence.
function shippedNpm(lock) {
	if (lock?.packages) {
		return Object.entries(lock.packages).filter(([p, e]) => p && !e.dev && !e.link)
			.map(([p, e]) => ({ name: e.name ?? nodeName(p), version: e.version, licence: licenceOf(e) }));
	}
	const out = [];
	const walk = (deps) => {
		for (const [name, e] of Object.entries(deps ?? {})) {
			if (e.dev) continue;
			out.push({ name, version: e.version, licence: undefined });
			walk(e.dependencies);
		}
	};
	walk(lock?.dependencies);
	return out;
}
// A manifest states its licence as an SPDX expression, or, in old packages, as
// an object with a type or a list of them.
function licenceOf(e) {
	if (typeof e.license === 'string') return e.license;
	if (e.license?.type) return e.license.type;
	if (Array.isArray(e.licenses) && e.licenses.length) return e.licenses.map((l) => l.type ?? l).join(' OR ');
	return undefined;
}

// yarn.lock: from the dependencies of package.json through the descriptors of
// each entry. A descriptor of another protocol than npm, a patch for instance,
// is looked up as written and skipped where yarn.lock has no entry for it.
function shippedYarn(text, manifest) {
	const entries = yarnEntries(text);
	const byDescriptor = new Map();
	for (const e of entries) for (const d of e.descriptors) byDescriptor.set(`${d.name}@${d.range}`, e);
	const out = new Map();
	const queue = Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })
		.map(([name, range]) => ({ name, range: String(range).replace(/^npm:/, '') }));
	const seen = new Set();
	while (queue.length) {
		const d = queue.shift();
		const e = byDescriptor.get(`${d.name}@${d.range}`);
		if (!e || seen.has(e)) continue;
		seen.add(e);
		if (e.version && !/^0\.0\.0-use\.local$/.test(e.version)) out.set(`${d.name}@${e.version}`, { name: d.name, version: e.version, licence: undefined });
		queue.push(...e.dependencies);
	}
	return [...out.values()];
}

// pnpm-lock.yaml, as far as this needs it: nested keys and scalar values.
function pnpmLock(text) {
	const root = {};
	const stack = [{ indent: -1, obj: root }];
	for (const raw of text.split('\n')) {
		const line = raw.trimEnd();
		const body = line.trimStart();
		if (!body || body.startsWith('#') || body.startsWith('- ')) continue;
		const indent = line.length - body.length;
		const m = /^('[^']*'|"[^"]*"|[^:]+?):(?:\s+(.*))?$/.exec(body);
		if (!m) continue;
		while (stack[stack.length - 1].indent >= indent) stack.pop();
		const key = m[1].replace(/^(['"])(.*)\1$/, '$2');
		const parent = stack[stack.length - 1].obj;
		if (m[2] === undefined || m[2] === '') {
			parent[key] = {};
			stack.push({ indent, obj: parent[key] });
		} else {
			parent[key] = m[2].replace(/^(['"])(.*)\1$/, '$2');
		}
	}
	return root;
}

// pnpm 9 lists what the app depends on under importers and the dependencies of
// each package under snapshots, keyed name@version with the peers in
// parentheses; pnpm 6 to 8 keep both under packages, keyed /name@version and
// flagged dev: true or false; pnpm 5 keys /name/version.
function shippedPnpm(text) {
	const lock = pnpmLock(text);
	const v5 = String(lock.lockfileVersion ?? '').startsWith('5');
	const identity = (key) => {
		const k = key.replace(/^\//, '').replace(/\(.*$/, '');
		const at = v5 ? k.lastIndexOf('/') : k.lastIndexOf('@');
		return at > 0 ? { name: k.slice(0, at), version: k.slice(at + 1) } : null;
	};
	const out = new Map();
	const add = (id) => { if (id && /^\d/.test(id.version)) out.set(`${id.name}@${id.version}`, { ...id, licence: undefined }); };
	if (lock.snapshots || lock.importers?.['.']) {
		const graph = lock.snapshots ?? lock.packages ?? {};
		const importer = lock.importers?.['.'] ?? {};
		const queue = Object.entries({ ...importer.dependencies, ...importer.optionalDependencies })
			.map(([name, d]) => [name, typeof d === 'object' ? d.version : d]);
		const seen = new Set();
		while (queue.length) {
			const [name, version] = queue.shift();
			if (!version || version.startsWith('link:')) continue;
			// An alias resolves to another package: version is then name@version.
			const key = /^(?:@[^@/]+\/)?[^@]+@/.test(version) ? version : `${name}@${version}`;
			if (seen.has(key)) continue;
			seen.add(key);
			add(identity(key));
			const node = graph[key] ?? graph[`/${key}`] ?? {};
			queue.push(...Object.entries({ ...node.dependencies, ...node.optionalDependencies }));
		}
	} else {
		for (const [key, e] of Object.entries(lock.packages ?? {})) if (e.dev !== 'true') add(identity(key));
	}
	return [...out.values()];
}

// The licence of name@version from its manifest in the registry the app's .npmrc
// names: undefined where the registry did not answer, null where it states none.
function registryLicence(name, version, root, env) {
	return new Promise((resolve) => {
		const child = spawn('npm', ['view', `${name}@${version}`, 'license', 'licenses', '--json'],
			{ cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
		let out = '';
		child.stdout.on('data', (d) => { out += d; });
		child.on('error', () => resolve(undefined));
		child.on('close', (code) => {
			if (code !== 0) return resolve(undefined);
			if (!out.trim()) return resolve(null);
			try {
				const v = JSON.parse(out);
				resolve(typeof v === 'string' ? v : (licenceOf(Array.isArray(v) ? { licenses: v } : v) ?? null));
			} catch { resolve(undefined); }
		});
	});
}

// The packages whose licence the lock file leaves open, looked up a few at a time.
async function lookUpLicences(packages, root, env) {
	const open = packages.filter((p) => p.licence === undefined);
	let next = 0;
	const worker = async () => {
		while (next < open.length) {
			const p = open[next++];
			p.licence = await registryLicence(p.name, p.version, root, env);
			p.unread = p.licence === undefined;
		}
	};
	await Promise.all(Array.from({ length: Math.min(LOOKUPS, open.length) }, worker));
	return open.length;
}

// npm audit reports no abandoned packages, so without advisories it does not run.
function readNode(root, opt) {
	const manifest = readJson(path.join(root, 'package.json'));
	if (!manifest) return null;
	const { name: pm, lock } = nodeManager(root);
	const r = { manager: pm, lock, shipped: null, licensed: [], packages: [], unavailable: null, missing: false };
	if (!lock) {
		r.missing = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).length > 0;
		return r.missing ? r : null;
	}
	const lockJson = pm === 'npm' ? readJson(path.join(root, lock)) : null;
	const lockText = pm === 'npm' ? null : read(path.join(root, lock)) ?? '';
	r.licensed = pm === 'npm' ? shippedNpm(lockJson) : pm === 'pnpm' ? shippedPnpm(lockText) : shippedYarn(lockText, manifest);
	r.shipped = r.licensed.length;
	if (!opt.advisories) return r;

	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-audit-'));
	try {
		const { env, error, lines } = managerEnv(pm, root, scratch);
		if (error) {
			r.unavailable = { why: error, lines };
			return r;
		}
		const [cmd, ...args] = AUDIT[pm];
		const run = exec(cmd, args, root, env);
		if (run.error) {
			r.unavailable = { why: `could not run ${cmd}: ${run.error.message}`, lines: [] };
			return r;
		}
		fs.mkdirSync(path.join(root, RAW), { recursive: true });
		fs.writeFileSync(path.join(root, RAW, 'node.json'), run.stdout);
		fs.writeFileSync(path.join(root, RAW, 'node.err'), run.stderr);
		const list = READERS[pm](run.stdout, lockJson, run.status);
		if (!list) {
			const json = (() => { try { return JSON.parse(run.stdout); } catch { return null; } })();
			r.unavailable = { why: `${AUDIT[pm].slice(0, -1).join(' ')} ended with exit code ${run.status}`,
				lines: json?.message ? [json.message] : json?.error?.message ? [json.error.message] : tail(run.stderr || run.stdout) };
			return r;
		}
		const byPackage = new Map();
		for (const a of list) {
			const key = `${a.name}\0${a.version}`;
			if (!byPackage.has(key)) byPackage.set(key, { name: a.name, version: a.version, advisories: [], nodes: a.nodes ?? [], transitive: false });
			const pkg = byPackage.get(key);
			if (pkg.advisories.some((x) => x.id === a.id)) continue;
			pkg.advisories.push({ id: a.id, title: a.title, url: a.url ?? null, severity: a.severity, range: a.range, fixed: null });
			pkg.transitive ||= Boolean(a.transitive);
		}
		const versions = new Map();
		for (const pkg of byPackage.values()) {
			if (!versions.has(pkg.name)) versions.set(pkg.name, registryVersions(pkg.name, root, env));
			const known = versions.get(pkg.name);
			for (const a of pkg.advisories) a.fixed = firstFixed(known, pkg.version, a.range);
			pkg.fixed = known?.filter(released).sort(cmpVersions)
				.find((v) => cmpVersions(v, pkg.version) > 0 && pkg.advisories.every((a) => satisfies(v, a.range) === false)) ?? null;
			pkg.versionsKnown = Boolean(known);
			const c = constraints(pm, root, lockJson, pkg);
			const excluding = c.list.filter((x) => pkg.fixed && satisfies(pkg.fixed, x.range) === false);
			const unreadable = c.list.filter((x) => pkg.fixed && satisfies(pkg.fixed, x.range) === null);
			pkg.verdict = !pkg.fixed ? { allowed: null, by: [] }
				: excluding.length ? { allowed: false, by: excluding.map((x) => `${x.from} requires ${pkg.name} (${x.range})`) }
					: !c.complete || unreadable.length ? { allowed: null, by: unreadable.map((x) => `${x.from} requires ${pkg.name} (${x.range})`) }
						: { allowed: true, by: [] };
			delete pkg.nodes;
			r.packages.push(pkg);
		}
		return r;
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

// == The check ==
async function check(opt, table) {
	const root = path.resolve(opt.dir);
	if (!fs.existsSync(root)) die(`no such directory: ${opt.dir}`);
	const sources = [readComposer(root, opt), readNode(root, opt)].filter(Boolean);
	const composerJson = readJson(path.join(root, 'composer.json'));
	const composerMissing = !fs.existsSync(path.join(root, 'composer.lock'))
		&& Object.keys(composerJson?.require ?? {}).some((k) => k !== 'php' && !/^(ext|lib|php)-/.test(k));
	const env = APP_NODE ? { PATH: `${path.join(APP_NODE, 'bin')}${path.delimiter}${process.env.PATH}` } : {};
	for (const s of sources) s.lookedUp = await lookUpLicences(s.licensed ?? [], root, env);
	const app = readInfo(root);
	const licences = appLicences(table, app);
	const groups = licences.map((l) => l.group).filter(Boolean);
	for (const s of sources) {
		for (const p of s.licensed ?? []) {
			p.verdict = p.unread ? 'unread' : p.licence === null ? 'missing' : judge(table, p.licence, groups);
		}
	}
	return { root, app, advisories: opt.advisories, licences: { app: licences, table: table.file }, composerMissing, sources, findings: [] };
}

// == Findings ==
function sample(items, details, more) {
	const shown = details ? items : items.slice(0, SAMPLE);
	const lines = shown.map((s) => `  ${s}`);
	if (shown.length < items.length) lines.push(`  ... ${num(items.length - shown.length)} more, ${more}`);
	return lines;
}

function findings(r, opt, table) {
	const out = [];
	const how = howToRun('DEPS_AUDIT_CMDLINE', 'deps-audit.mjs %s');
	for (const s of r.sources) {
		const update = s.manager === 'composer' ? (n) => `make composer ARGS="update ${n} --with-dependencies"` : UPDATE[s.manager];
		for (const p of s.packages) {
			const sev = highest(p.advisories.map((a) => a.severity));
			const n = p.advisories.length;
			const head = `${p.name} ${p.version} (${s.lock}) has ${plural(n, 'published advisory', 'published advisories')}, the highest ${sev}: `
				+ (p.fixed ? `${p.fixed} fixes ${n === 1 ? 'it' : 'all of them'}.`
					: s.manager !== 'composer' && !p.versionsKnown ? 'which release fixes them is not known.'
						: `no release fixes ${n === 1 ? 'it' : 'all of them'} yet.`);
			const advisories = sample(p.advisories.map((a) => `${a.id}, ${a.severity}: ${a.title}; `
				+ `${a.fixed ? `fixed in ${a.fixed}` : 'no fixed release'}${a.url ? ` ${a.url}` : ''}`), opt.details, `see ${how('--details')}`);
			const pinned = p.verdict.allowed === false;
			let verdict;
			if (!p.fixed) {
				verdict = s.manager !== 'composer' && !p.versionsKnown
					? '  The released versions could not be read from the registry, so no fixed release could be named.'
					: '  Until a release fixes it, the app can only drop the package or replace it.';
			} else if (pinned) {
				verdict = `  ${p.fixed} is excluded by ${p.verdict.by.join('; ')}: widen that constraint, then ${update(p.name)}.`;
			} else if (p.verdict.allowed) {
				verdict = `  The declared constraints allow ${p.fixed}: ${update(p.name)} updates the lock file.`;
			} else {
				verdict = `  Whether the packages that depend on it allow ${p.fixed} is not recorded in ${s.lock}`
					+ `${p.verdict.by.length ? ` (${p.verdict.by.join('; ')})` : ''}; ${update(p.name)} tells.`;
			}
			out.push({
				level: 'warn',
				id: pinned ? 'vulnerable-dependency-pinned' : 'vulnerable-dependency',
				security: true,
				manager: s.manager === 'yarn-berry' ? 'yarn' : s.manager,
				lock: s.lock,
				package: p.name,
				version: p.version,
				severity: sev,
				fixed: p.fixed,
				allowed: p.verdict.allowed,
				constraints: p.verdict.by,
				advisories: p.advisories,
				lines: [head, ...advisories, verdict],
			});
		}
		for (const a of s.abandoned ?? []) {
			out.push({
				level: 'info',
				id: 'abandoned-dependency',
				manager: s.manager,
				lock: s.lock,
				package: a.name,
				version: a.version,
				replacement: a.replacement,
				lines: [
					`${a.name}${a.version ? ` ${a.version}` : ''} (${s.lock}) is abandoned: ${a.replacement ? `its maintainers suggest ${a.replacement} instead.` : 'its maintainers suggest no replacement.'}`,
					'  An abandoned package gets no fix for an advisory published later.',
				],
			});
		}
		if (s.unavailable) {
			out.push({
				level: 'info',
				id: 'audit-unavailable',
				manager: s.manager === 'yarn-berry' ? 'yarn' : s.manager,
				lock: s.lock,
				lines: [
					r.advisories
						? `The advisories for ${s.lock} could not be read: ${s.unavailable.why}. Nothing in it was checked.`
						: `The audit of ${s.lock} could not be read: ${s.unavailable.why}. Its abandoned packages were not checked.`,
					...s.unavailable.lines.map((l) => `  ${l}`),
				],
			});
		}
		if (s.missing) {
			out.push({
				level: 'info',
				id: 'lock-missing',
				manager: 'npm',
				lines: [
					'package.json has dependencies but the app ships no lock file, so there is nothing to audit.',
					'  The audits read what a lock file pins; a build without one resolves anew each time.',
				],
			});
		}
	}
	if (r.composerMissing) {
		out.push({
			level: 'info',
			id: 'lock-missing',
			manager: 'composer',
			lines: [
				'composer.json requires packages but the app has no composer.lock, so there is nothing to audit.',
				'  composer audit reads what composer.lock pins; make build writes it.',
			],
		});
	}
	out.push(...licenceFindings(r, table, opt, how));
	const audited = r.sources.filter((s) => !s.unavailable && !s.missing);
	if (!r.advisories) {
		// The same finding for every app: without it, a public report would tell the
		// vulnerable apps by the ok finding they lack.
		out.push({
			level: 'info',
			id: 'advisories-unchecked',
			lines: [
				'The advisories were not checked (NO_ADVISORIES=1 or --no-advisories): this report says nothing about vulnerable packages.',
			],
		});
	} else if (audited.length && !out.some((f) => f.id.startsWith('vulnerable-'))) {
		out.push({
			level: 'ok',
			id: 'deps-audit',
			lines: [`No shipped package has a published advisory: ${audited.map((s) => `${s.lock}${s.shipped !== null ? `, ${plural(s.shipped, 'package', 'packages')}` : ''}`).join('; ')}.`],
		});
	}
	return sortFindings(out);
}

// The licences of the shipped packages, grouped by the licence as each states it:
// one finding per licence that cannot ship with the app, and one summary.
function licenceFindings(r, table, opt, how) {
	const out = [];
	const all = r.sources.flatMap((s) => (s.licensed ?? []).map((p) => ({ ...p, lock: s.lock })));
	if (!all.length) return out;
	const app = r.licences.app.filter((l) => l.id);
	const appNames = app.map((l) => l.id).join(' and ');
	const byLicence = (verdict) => {
		const m = new Map();
		for (const p of all.filter((x) => x.verdict === verdict)) {
			const k = p.licence ?? '';
			if (!m.has(k)) m.set(k, []);
			m.get(k).push(p);
		}
		return [...m].sort((a, b) => b[1].length - a[1].length);
	};
	const named = (list) => sample(list.map((p) => `${p.name} ${p.version} (${p.lock})`), opt.details, `see ${how('--details')}`);
	const entry = (level, id, licence, list, lines) => out.push({
		level, id, licence: licence || null, app: app.map((l) => l.id),
		packages: list.map((p) => ({ name: p.name, version: p.version, lock: p.lock })), lines,
	});
	for (const [licence, list] of byLicence('incompatible')) {
		const notes = [...new Set(leaves(parseExpression(licence)).map((id) => classify(table, id))
			.filter((c) => c.kind === 'free' && !app.every((l) => table.compatible.get(l.group)?.has(c.group)))
			.map((c) => table.notes[c.group]).filter(Boolean))];
		entry('warn', 'licence-incompatible', licence, list, [
			`${plural(list.length, 'shipped package is', 'shipped packages are')} under ${licence}, which cannot be combined with ${appNames}, the licence of the app:`,
			...named(list),
			...notes.map((n) => `  ${n}`),
			'  A bundle is one work under one licence: replace the package, or take it under another licence it is offered under.',
		]);
	}
	for (const [licence, list] of byLicence('non-free')) {
		entry('warn', 'licence-non-free', licence, list, [
			`${plural(list.length, 'shipped package is', 'shipped packages are')} under ${licence}, which forbids redistribution or commercial use:`,
			...named(list),
			'  A release that ships it cannot be published as free software; replace the package.',
		]);
	}
	const missing = all.filter((p) => p.verdict === 'missing');
	if (missing.length) {
		entry('warn', 'licence-missing', null, missing, [
			`${plural(missing.length, 'shipped package states', 'shipped packages state')} no licence:`,
			...named(missing),
			'  Without a licence a package may not be distributed at all; ask its maintainers for one, or replace it.',
		]);
	}
	for (const [licence, list] of byLicence('unknown')) {
		entry('info', 'licence-unknown', licence, list, [
			`${plural(list.length, 'shipped package is', 'shipped packages are')} under "${licence}", a licence ${parseExpression(licence) ? `${path.basename(table.file)} gives no verdict on` : 'that is no SPDX expression'}:`,
			...named(list),
			'  Read the licence itself to decide whether it can ship with the app.',
		]);
	}
	const unread = all.filter((p) => p.verdict === 'unread');
	if (unread.length) {
		entry('info', 'licence-unknown', null, unread, [
			`The registry did not return the licence of ${plural(unread.length, 'shipped package', 'shipped packages')}, so it was not checked:`,
			...named(unread),
		]);
	}
	const counts = new Map();
	for (const p of all) {
		const k = p.verdict === 'unread' ? 'not read' : p.licence ?? 'none';
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const shown = opt.details ? sorted : sorted.slice(0, 8);
	out.push({
		level: 'info',
		id: 'licence-summary',
		app: app.map((l) => l.id),
		licences: Object.fromEntries(sorted),
		lines: [
			`The ${plural(all.length, 'shipped package', 'shipped packages')} by licence: ${shown.map(([k, n]) => `${k} ${num(n)}`).join(', ')}`
			+ `${shown.length < sorted.length ? `, and ${plural(sorted.length - shown.length, 'licence', 'licences')} more` : ''}.`,
			app.length
				? `  The app is under ${appNames}, as appinfo/info.xml declares; ${path.basename(table.file)} held each licence against it.`
				: `  appinfo/info.xml declares ${r.licences.app.length ? `${r.licences.app.map((l) => l.value).join(', ')}, which ${path.basename(table.file)} does not know,` : 'no licence'}, so no compatibility was judged.`,
		],
	});
	return out;
}

// == Human-readable output ==
function render(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const how = howToRun('DEPS_AUDIT_CMDLINE', 'deps-audit.mjs %s');
	const app = r.app;
	const what = r.sources.filter((s) => s.lock).map((s) => `${s.lock}${s.shipped !== null ? ` (${plural(s.shipped, 'shipped package', 'shipped packages')})` : ''}`);
	p(`deps-audit  ${r.root}`);
	p(`  ${app ? `${app.id ?? 'no app id'}${app.version ? ` ${app.version}` : ''}` : 'no appinfo/info.xml'}, `
		+ `${what.length ? `audited ${what.join(' and ')}` : 'no lock file to audit'}${r.advisories ? '' : ', advisories not checked'}.`);
	p();
	p('FINDINGS');
	if (!r.findings.length) p('  Nothing to audit: the app has neither composer.lock nor an npm lock file.');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	if (r.advisories) {
		p('composer audit --locked --no-dev read composer.lock in the build image of the');
		p('PHP floor; the npm lock file was read by the audit of its package manager,');
		p('production dependencies only. A fixed release is the first released version');
		p('above the locked one that the advisory spares. The licences come from the lock');
	} else {
		p('composer audit --locked --no-dev read composer.lock in the build image of the');
		p('PHP floor for the abandoned packages alone; no advisory was kept, and the npm');
		p('lock file was not audited. The licences come from the lock');
	}
	p('files, or from the registry where a lock file has none, and are held against');
	p('the licence in appinfo/info.xml by the licence table.');
	p(`The report is in ${REPORTS}/deps-audit.txt, the JSON in ${REPORTS}/deps-audit.json.`);
	p();
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const table = loadTable(opt.licences);
const failures = selfTest(table);
if (opt.selfTest || failures.length) {
	for (const f of failures) process.stdout.write(`  [!] ${f}\n`);
	process.stdout.write(failures.length
		? `${shortPath(table.file)}: ${plural(failures.length, 'example fails', 'examples fail')}.\n`
		: `${shortPath(table.file)}: ${plural(table.examples.length, 'example holds', 'examples hold')}.\n`);
	process.exit(failures.length ? 1 : 0);
}
const report = await check(opt, table);
report.findings = findings(report, opt, table);
const json = `${JSON.stringify(report, null, 2)}\n`;
const text = `${render(report)}\n`;
process.stdout.write(opt.json ? json : text);
const reports = path.join(report.root, REPORTS);
try { fs.mkdirSync(reports, { recursive: true }); } catch (e) { die(`could not create ${REPORTS}: ${e.message}`); }
writeJsonFile(path.join(reports, 'deps-audit.json'), json, die);
writeJsonFile(path.join(reports, 'deps-audit.txt'), text, die);
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
