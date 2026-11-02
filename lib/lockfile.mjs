// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lockfile - versions, ranges and the lock files of npm, pnpm and yarn, read the
// way the package managers write them. deps-audit takes the shipped packages from
// here, build-audit every locked version of a package. Node 18 or newer, no npm
// dependency.

import fs from 'node:fs';
import path from 'node:path';

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

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
export const cmpVersions = (a, b) => cmp(parseVersion(a), parseVersion(b));

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

export function satisfies(version, range) {
	const v = parseVersion(version);
	const sets = parseRange(range);
	if (!v || v.minor === null || v.patch === null || !sets) return null;
	return sets.some((set) => set.every((c) => HOLDS[c.op](cmp(v, c.v)))
		&& (!v.pre.length || set.some((c) => c.v.pre.length && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch)));
}

// The lock file decides the package manager, as in make build: npm-shrinkwrap.json
// wins over package-lock.json, and Yarn 2 and later write a __metadata block.
export function nodeManager(root) {
	const lock = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
		.find((f) => fs.existsSync(path.join(root, f))) ?? null;
	if (lock === 'pnpm-lock.yaml') return { name: 'pnpm', lock };
	if (lock === 'yarn.lock') return { name: /^__metadata:/m.test(read(path.join(root, lock))) ? 'yarn-berry' : 'yarn', lock };
	return { name: 'npm', lock };
}

// The node a package at path p of package-lock.json resolves name to: the nearest
// node_modules/<name> from p upwards, as Node looks it up.
export function resolveNode(packages, p, name) {
	for (let at = p; ; at = parentNode(at)) {
		const candidate = `${at ? `${at}/` : ''}node_modules/${name}`;
		if (packages[candidate]) return candidate;
		if (!at) return null;
	}
}
const parentNode = (p) => p.replace(/\/?node_modules\/(?:@[^/]+\/)?[^/]+$/, '');
export const nodeName = (p) => /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(p)?.[1] ?? p;

// The entries of yarn.lock: each heading names one or more descriptors,
// name@range, and the version they resolved to follows indented, with the
// dependencies of the package below it. Yarn 1 writes version "1.2.3" and
// name "range", Yarn 2 and later version: 1.2.3 and name: "npm:range".
export function yarnEntries(text) {
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

// pnpm-lock.yaml, as far as this needs it: nested keys and scalar values.
export function pnpmLock(text) {
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

// The name and version a key of pnpm-lock.yaml stands for, with the peers in
// parentheses cut off: name@version from pnpm 6 on, name/version in pnpm 5.
export function pnpmIdentity(key, v5) {
	const k = key.replace(/^\//, '').replace(/\(.*$/, '');
	const at = v5 ? k.lastIndexOf('/') : k.lastIndexOf('@');
	return at > 0 ? { name: k.slice(0, at), version: k.slice(at + 1) } : null;
}

// Every version the lock file of the app holds of each package, dev dependencies
// included: a build runs on those too. null where there is no lock file or it
// cannot be read.
export function lockedVersions(root) {
	const { name: pm, lock } = nodeManager(root);
	const text = lock ? read(path.join(root, lock)) : null;
	if (text === null) return null;
	const versions = new Map();
	const add = (name, version) => {
		if (!name || !/^\d/.test(version ?? '')) return;
		if (!versions.has(name)) versions.set(name, new Set());
		versions.get(name).add(version);
	};
	if (pm === 'npm') {
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			return null;
		}
		if (json.packages) {
			for (const [p, e] of Object.entries(json.packages)) if (p && !e.link) add(e.name ?? nodeName(p), e.version);
		} else {
			const walk = (deps) => {
				for (const [name, e] of Object.entries(deps ?? {})) {
					add(name, e.version);
					walk(e.dependencies);
				}
			};
			walk(json.dependencies);
		}
	} else if (pm === 'pnpm') {
		const l = pnpmLock(text);
		const v5 = String(l.lockfileVersion ?? '').startsWith('5');
		for (const key of Object.keys({ ...l.packages, ...l.snapshots })) {
			const id = pnpmIdentity(key, v5);
			if (id) add(id.name, id.version);
		}
	} else {
		for (const e of yarnEntries(text)) for (const d of e.descriptors) add(d.name, e.version);
	}
	return { pm, lock, versions };
}
