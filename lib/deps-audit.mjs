#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// deps-audit - does a dependency that ships have a published vulnerability.
//
// A release ships the runtime packages of composer.lock in vendor/ and the
// production packages of the npm lock file bundled into js/. This asks the
// package managers' own audits about exactly those, dev dependencies left out,
// and reports each vulnerable package with the release that fixes it and whether
// the declared constraints let an update reach that release.
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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	LEGEND,
	howToRun,
	num,
	plural,
	renderFindings,
	sortFindings,
	writeJsonFile,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',        // the app checkout
	details: false,  // every advisory of a package instead of the first few
	json: false,
	jsonFile: null,
};
const SAMPLE = 3;    // advisories named per package without --details
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
  --details             every advisory of a package, not the first ${SAMPLE}
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
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
			default:
				if (arg.startsWith('--json-file=')) { opt.jsonFile = arg.slice('--json-file='.length); break; }
				if (arg.startsWith('-')) die(`unknown option: ${arg}`);
				if (dir !== null) die(`only one directory can be checked: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (opt.jsonFile === '') die('--json-file needs a file');
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
	return { id: tag('id'), version: tag('version') };
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
// exit code of a run that did not finish.
function readComposer(root) {
	const lock = readJson(path.join(root, 'composer.lock'));
	if (!lock) return null;
	const raw = path.join(root, RAW);
	const failed = read(path.join(raw, 'composer.failed'))?.trim() || null;
	const out = readJson(path.join(raw, 'composer.json'));
	const r = {
		manager: 'composer',
		lock: 'composer.lock',
		shipped: (lock.packages ?? []).length,
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
	for (const [name, list] of Object.entries(out.audit.advisories ?? {})) {
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
// name@range, and the version they resolved to follows indented. Yarn 1 writes
// version "1.2.3", Yarn 2 and later version: 1.2.3 and the range as npm:<range>.
function yarnEntries(text) {
	const out = [];
	let cur = null;
	for (const line of text.split('\n')) {
		if (/^[^\s#].*:$/.test(line)) {
			cur = { descriptors: line.slice(0, -1).split(/,\s*/).map((d) => d.replace(/^"|"$/g, '')).map((d) => {
				const at = d.lastIndexOf('@');
				return at > 0 ? { name: d.slice(0, at), range: d.slice(at + 1).replace(/^npm:/, '') } : null;
			}).filter(Boolean), version: null };
			out.push(cur);
		} else if (cur && !cur.version) {
			const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
			if (m) cur.version = m[1];
		}
	}
	return out;
}

function readNode(root) {
	const manifest = readJson(path.join(root, 'package.json'));
	if (!manifest) return null;
	const { name: pm, lock } = nodeManager(root);
	const r = { manager: pm, lock, shipped: null, packages: [], unavailable: null, missing: false };
	if (!lock) {
		r.missing = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).length > 0;
		return r.missing ? r : null;
	}
	const lockJson = pm === 'npm' ? readJson(path.join(root, lock)) : null;
	if (lockJson?.packages) r.shipped = Object.entries(lockJson.packages).filter(([p, e]) => p && !e.dev && !e.link).length;

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
function check(opt) {
	const root = path.resolve(opt.dir);
	if (!fs.existsSync(root)) die(`no such directory: ${opt.dir}`);
	const sources = [readComposer(root), readNode(root)].filter(Boolean);
	const composerJson = readJson(path.join(root, 'composer.json'));
	const composerMissing = !fs.existsSync(path.join(root, 'composer.lock'))
		&& Object.keys(composerJson?.require ?? {}).some((k) => k !== 'php' && !/^(ext|lib|php)-/.test(k));
	return { root, app: readInfo(root), composerMissing, sources, findings: [] };
}

// == Findings ==
function sample(items, details, more) {
	const shown = details ? items : items.slice(0, SAMPLE);
	const lines = shown.map((s) => `  ${s}`);
	if (shown.length < items.length) lines.push(`  ... ${num(items.length - shown.length)} more, ${more}`);
	return lines;
}

function findings(r, opt) {
	const out = [];
	const how = howToRun('DEPS_AUDIT_CMDLINE', 'deps-audit.mjs %s');
	for (const s of r.sources) {
		const update = s.manager === 'composer' ? (n) => `make composer ARGS="update ${n} --with-dependencies"` : UPDATE[s.manager];
		for (const p of s.packages) {
			const sev = highest(p.advisories.map((a) => a.severity));
			const n = p.advisories.length;
			const head = `${p.name} ${p.version} (${s.lock}) has ${plural(n, 'published advisory', 'published advisories')}, the highest ${sev}: `
				+ (p.fixed ? `${p.fixed} fixes ${n === 1 ? 'it' : 'all of them'}.` : `no release fixes ${n === 1 ? 'it' : 'all of them'} yet.`);
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
					`The advisories for ${s.lock} could not be read: ${s.unavailable.why}. Nothing in it was checked.`,
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
	const audited = r.sources.filter((s) => !s.unavailable && !s.missing);
	if (audited.length && !out.some((f) => f.level === 'warn')) {
		out.push({
			level: 'ok',
			id: 'deps-audit',
			lines: [`No shipped package has a published advisory: ${audited.map((s) => `${s.lock}${s.shipped !== null ? `, ${plural(s.shipped, 'package', 'packages')}` : ''}`).join('; ')}.`],
		});
	}
	return sortFindings(out);
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
		+ `${what.length ? `audited ${what.join(' and ')}` : 'no lock file to audit'}.`);
	p();
	p('FINDINGS');
	if (!r.findings.length) p('  Nothing to audit: the app has neither composer.lock nor an npm lock file.');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('composer audit --locked --no-dev read composer.lock in the build image of the');
	p('PHP floor; the npm lock file was read by the audit of its package manager,');
	p('production dependencies only. A fixed release is the first released version');
	p('above the locked one that the advisory spares.');
	p(`The report is in ${REPORTS}/deps-audit.txt, the JSON in ${REPORTS}/deps-audit.json.`);
	p();
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = check(opt);
report.findings = findings(report, opt);
const json = `${JSON.stringify(report, null, 2)}\n`;
const text = `${render(report)}\n`;
process.stdout.write(opt.json ? json : text);
const reports = path.join(report.root, REPORTS);
try { fs.mkdirSync(reports, { recursive: true }); } catch (e) { die(`could not create ${REPORTS}: ${e.message}`); }
writeJsonFile(path.join(reports, 'deps-audit.json'), json, die);
writeJsonFile(path.join(reports, 'deps-audit.txt'), text, die);
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
