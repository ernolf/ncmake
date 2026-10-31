#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// build-audit - why the bundle is the size it is.
//
// Reads the half of an app that never ships: package.json, the bundler config,
// src/. Where a build output is present, every statement is priced in delivered
// bytes through the source maps it ships, so a finding carries the app's own
// numbers instead of a general claim about bundlers. Without a build output the
// source-side findings still hold and the report names what it could not price.
//
// A finding is printed where the app has a screw to turn: how src imports, what
// the bundler config sets. What the toolchain or a library decides on its own is
// measured and tabled, never dressed up as a verdict.
//
// Reads only. No build, no network, no npm dependencies. Where node_modules is
// installed, the package.json files in it name the versions the build used and
// what each delivered package is written against. Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';

import {
	attrOfFiles,
	buildGraph,
	builtDirOf,
	closure,
	heaviestPage,
	installDirs,
	mappedSources,
	moduleList,
	packageImports,
	packageList,
	SEP,
	sizes,
} from './built-assets.mjs';
import { bundlerConfigs } from './bundler-config.mjs';
import {
	LEGEND,
	cut,
	howToRun,
	num,
	pct,
	plural,
	renderFindings,
	shortPath,
	sortFindings,
	table,
	writeJsonFile,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',                  // the app checkout; src and build are inside it
	build: 'js',               // built assets, the usual Nextcloud app layout
	src: 'src',                // application source
	top: 12,                   // rows per table, 0 = all
	details: false,            // every table; the default is the verdict alone
	json: false,
	jsonFile: null,
};

// Files that can hold an import in a Nextcloud app's source.
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue']);
// A test never reaches the browser, so an import in one prices nothing.
const RE_TEST = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:spec|test)\.[^/]+$/;

// The component library this audit knows by name: its components carry a byte
// figure each, and ncmake's lint-vue-imports gates how they are imported.
const VUE_PKG = '@nextcloud/vue';

// Below this a figure says nothing next to a bundle of several hundred kB.
const PRICE_MIN = 4096;
// A page this small decides nothing by how it is split: 1.25 MiB, above the
// settings and sidebar pages a small app ships in one piece.
const PAYLOAD_MIN = 1310720;
// A package delivered in fewer modules than this is a small package, not a
// barrel that was pulled in whole: the bound bundle-report judges by.
const BARREL_MODULES_MIN = 8;
// One chunk holding this much of a page is that page, whatever else exists.
const MONOLITH_SHARE = 0.9;

// == Command line ==
function usage() {
	return `build-audit - why the bundle is the size it is

Usage: build-audit.mjs [options] [dir]

  dir                   the app checkout to audit (default: ${defaults.dir})

Options:
  --build=DIR           built assets, inside dir (default: the directory git
                        ignores and the build fills, else ${defaults.build})
  --src=DIR             application source, inside dir (default: ${defaults.src})
  --top=N               rows per table, 0 for all (default: ${defaults.top})
  --details             print every table behind the findings
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The audit reads the checkout only. It never builds, installs or downloads.`;
}

function die(msg) {
	process.stderr.write(`build-audit: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	let build = null;
	for (const arg of argv) {
		const eq = arg.indexOf('=');
		const key = eq === -1 ? arg : arg.slice(0, eq);
		const val = eq === -1 ? '' : arg.slice(eq + 1);
		switch (key) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--json': opt.json = true; break;
			case '--json-file': opt.jsonFile = val; break;
			case '--details': opt.details = true; break;
			case '--build': build = val; break;
			case '--src': opt.src = val; break;
			case '--top': opt.top = Number(val); break;
			default:
				if (key.startsWith('-')) die(`unknown option: ${key}`);
				if (dir !== null) die(`more than one directory given: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (build !== null) opt.build = build;
	else {
		const out = builtDirOf(opt.dir, defaults.build);
		if (out.dir === null) {
			die(`git ignores several directories that hold scripts: ${out.candidates.map((d) => `${d}/`).join(', ')}`
				+ ` - name the one the build writes: ${how('--build=<dir>')}`);
		}
		opt.build = out.dir;
	}
	if (!Number.isInteger(opt.top) || opt.top < 0) die('--top needs a non-negative integer');
	if (opt.jsonFile === '') die('--json-file needs a file');
	return opt;
}

// == The app as it is written ==
// Imports are matched textually, the way the delivered files are: a .vue file is
// not JavaScript, and a parser for every dialect an app may be written in is not
// what decides these findings. A specifier that is only mentioned still counts,
// because the findings are about what the source never mentions at all.
const RE_IMPORT_FROM = /(?:^|[^.\w$])import\s+([^;]*?)\s*from\s*(["'])([^"'\n]+)\2/g;
const RE_IMPORT_BARE = /(?:^|[^.\w$])import\s*(["'])([^"'\n]+)\1/g;
const RE_IMPORT_DYN = /(?:^|[^.\w$])import\s*\(\s*(["'`])(?!(?<=`)[^`\n]*\$\{)([^"'`\n]+)\1\s*\)/g;
const RE_NAME = /\bNc[A-Z][A-Za-z0-9]*/g;
const RE_KEBAB = /<nc(?:-[a-z0-9]+)+/g;

function pkgOf(spec) {
	if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null;
	const parts = spec.split('/');
	return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function clauseNames(clause) {
	if (!clause) return [];
	const out = [];
	const braces = /\{([^}]*)\}/.exec(clause);
	if (braces) {
		for (const part of braces[1].split(',')) {
			const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
			if (name && name !== 'type') out.push(name);
		}
	}
	const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
	if (ns) out.push(ns[1]);
	for (const part of clause.replace(/\{[^}]*\}/g, '').replace(/\*\s*as\s+[A-Za-z_$][\w$]*/g, '').split(',')) {
		const w = part.trim();
		if (/^[A-Za-z_$][\w$]*$/.test(w) && w !== 'type') out.push(w);
	}
	return [...new Set(out)].sort();
}

const pascal = (kebab) => kebab.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

function listSources(dir) {
	const out = [];
	const walk = (rel) => {
		for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(r);
			else if (e.isFile() && SRC_EXT.has(path.extname(e.name)) && !RE_TEST.test(r)) out.push(r);
		}
	};
	walk('');
	return out.sort();
}

function scanSource(root, rel) {
	const dir = path.join(root, rel);
	const out = { dir: rel, present: false, files: [], packages: new Map(), names: new Set() };
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
	out.present = true;
	out.files = listSources(dir);

	for (const f of out.files) {
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		const note = (spec, clause) => {
			const pkg = pkgOf(spec);
			if (!pkg) return;
			let e = out.packages.get(pkg);
			if (!e) {
				e = { root: [], deep: new Set() };
				out.packages.set(pkg, e);
			}
			if (spec === pkg) e.root.push({ file: f, names: clauseNames(clause) });
			else e.deep.add(spec);
		};
		for (const m of text.matchAll(RE_IMPORT_FROM)) note(m[3], m[1]);
		for (const m of text.matchAll(RE_IMPORT_BARE)) note(m[2], null);
		for (const m of text.matchAll(RE_IMPORT_DYN)) note(m[2], null);
		for (const n of text.match(RE_NAME) ?? []) out.names.add(n);
		for (const n of text.match(RE_KEBAB) ?? []) out.names.add(pascal(n.slice(1)));
	}
	return out;
}

function readPackageJson(root) {
	const file = path.join(root, 'package.json');
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

// The bundler and its configs come from bundler-config.mjs; which of the
// toolchain's packages the app declares is read here.
const TOOL_PKGS = [
	'@nextcloud/vite-config', 'vite',
	'@nextcloud/webpack-vue-config', 'webpack',
	'@rspack/cli', '@rspack/core',
];

function detectToolchain(root, pkg) {
	const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
	const { configs, built } = bundlerConfigs(root, pkg?.scripts ?? {});
	const declared = {};
	for (const name of TOOL_PKGS) if (deps[name]) declared[name] = deps[name];
	return { configs, kinds: [...new Set(configs.map((c) => c.kind))], built, declared, deps };
}

// == The app as it is delivered ==
// The static closure of an entry is what its page fetches when it opens, so a
// finding is priced against the page that loads the most of what it is about.
// What only a dynamic import can reach is counted apart: a locale nobody loads
// costs nothing.
function lazyFiles(graph, reach) {
	const seen = new Set(reach);
	const queue = [...reach];
	const out = [];
	while (queue.length) {
		const { static: s, dynamic: d } = graph.get(queue.shift());
		for (const t of [...s, ...d]) {
			if (seen.has(t)) continue;
			seen.add(t);
			queue.push(t);
			out.push(t);
		}
	}
	return out;
}

function measureBuild(root, rel) {
	const dir = path.join(root, rel);
	const out = { dir: rel, present: false, js: 0, nonEsm: 0 };
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;

	const g = buildGraph(dir);
	out.js = g.js.length;
	out.nonEsm = g.nonEsm;
	if (!g.js.length) return out;
	out.present = true;

	const abs = (f) => path.join(dir, f);
	const staticSet = new Set();
	for (const entry of g.entries) for (const f of closure(g.graph, entry, 'static')) staticSet.add(f);
	const staticFiles = [...staticSet].sort();
	const dynamicFiles = g.js.filter((f) => !staticSet.has(f));

	out.staticFiles = staticFiles.length;
	out.dynamicFiles = dynamicFiles.length;
	out.raw = staticFiles.reduce((n, f) => n + sizes(abs(f)).raw, 0);
	out.dynamicRaw = dynamicFiles.reduce((n, f) => n + sizes(abs(f)).raw, 0);

	const at = attrOfFiles(dir, staticFiles);
	out.mapped = at.mapped;
	out.unmapped = staticFiles.length - at.mapped;
	out.attributed = at.attributed;
	out.dynamicModules = dynamicFiles.length ? moduleList(attrOfFiles(dir, dynamicFiles)) : [];
	const sources = mappedSources(dir, g.js, root);
	out.imports = packageImports(sources, VUE_PKG);
	out.uses = dependencyUses(sources, VUE_PKG);
	out.installDirs = installDirs(dir, g.js);

	out.pages = g.entries
		.map((entry) => {
			const reach = closure(g.graph, entry, 'static');
			const files = [...reach]
				.map((f) => ({ file: f, raw: sizes(abs(f)).raw }))
				.sort((a, b) => b.raw - a.raw);
			const raw = files.reduce((n, f) => n + f.raw, 0);
			const pat = attrOfFiles(dir, files.map((f) => f.file));
			const lazy = lazyFiles(g.graph, reach);
			return {
				entry,
				count: files.length,
				raw,
				largest: files[0] ?? null,
				share: raw ? (files[0]?.raw ?? 0) / raw : 0,
				runtime: g.graph.get(entry).runtime,
				lazy: { count: lazy.length, raw: lazy.reduce((n, f) => n + sizes(abs(f)).raw, 0) },
				packages: packageList(pat, raw),
				modules: moduleList(pat),
			};
		})
		.sort((a, b) => b.raw - a.raw);
	out.packages = heaviestPage(out.pages.flatMap((p) => p.packages.map((x) => ({ ...x, page: p.entry }))), 'pkg');
	return out;
}

// == What the delivered bytes are made of ==
// A component chunk of the library, with or without the content hash the bundler
// appends: dist/chunks/NcButton-C9D47Igd.mjs, dist/components/NcButton/index.mjs.
const RE_COMPONENT_FILE = /(?:^|\/)(Nc[A-Z][A-Za-z0-9]*?)(?:-[A-Za-z0-9_-]{6,})?\.(?:m?js|vue)$/;
const RE_COMPONENT_DIR = /(?:^|\/)components\/(Nc[A-Z][A-Za-z0-9]*)\//;
// The translation catalogue of a library, one chunk holding every language.
const RE_L10N = /(?:^|\/)_?l10n(?:-[A-Za-z0-9_-]+)?\.m?js$/;
// A locale of date-fns: locale/de/... or locale/de.js, never locale/_lib/...
const RE_LOCALE = /^locale\/([A-Za-z][A-Za-z0-9-]*)(?:\/|\.)/;

function byName(modules, pkg, re) {
	const out = new Map();
	for (const m of modules) {
		if (m.pkg !== pkg) continue;
		const hit = re.exec(m.module);
		if (!hit) continue;
		out.set(hit[1], (out.get(hit[1]) ?? 0) + m.bytes);
	}
	return out;
}

const componentOf = (module) => (RE_COMPONENT_DIR.exec(module) ?? RE_COMPONENT_FILE.exec(module))?.[1] ?? null;

function components(modules) {
	const out = new Map();
	for (const m of modules) {
		if (m.pkg !== VUE_PKG) continue;
		const name = componentOf(m.module);
		if (!name) continue;
		out.set(name, (out.get(name) ?? 0) + m.bytes);
	}
	return [...out].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes);
}

// A component the source never names is still there for a reason when one it
// does name imports it, directly or through other modules of the library:
// NcAvatar brings NcUserStatusIcon. Returns each such component with the named
// one it was reached from.
function pulledIn(modules, names, imports) {
	const queue = [];
	for (const m of modules) {
		const name = m.pkg === VUE_PKG ? componentOf(m.module) : null;
		if (name && names.has(name)) queue.push({ module: m.module, from: name });
	}
	const seen = new Set(queue.map((x) => x.module));
	const out = new Map();
	while (queue.length) {
		const { module, from } = queue.shift();
		for (const t of imports.get(module) ?? []) {
			if (seen.has(t)) continue;
			seen.add(t);
			const name = componentOf(t);
			if (name && !names.has(name) && !out.has(name)) out.set(name, from);
			queue.push({ module: t, from });
		}
	}
	return out;
}

// What the delivered modules of other packages take from the library: a module
// of @nextcloud/dialogs imports @nextcloud/vue/components/NcBreadcrumbs, one of
// @conduction/nextcloud-vue imports the root. Such a component is there because
// that package names it, and a root import there keeps the whole barrel
// reachable whatever the app imports. A library ships built, so the import may
// be minified (import{...}from"...") or a re-export. Returns module key ->
// { names, root }.
const RE_DEP_FROM = /(?:^|[^.\w$])(?:import|export)(?:\s+|(?=[{*]))([^;]*?)\s*from\s*(["'])([^"'\n]+)\2/g;
const RE_REQUIRE = /(?:^|[^.\w$])require\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const RE_NC_SEGMENT = /^(Nc[A-Z][A-Za-z0-9]*)/;
const NOT_DEPENDENCY = new Set(['app source', 'generated by the bundler']);

function dependencyUses(sources, lib) {
	const out = new Map();
	for (const [key, { pkg, content }] of sources) {
		if (pkg === lib || NOT_DEPENDENCY.has(pkg)) continue;
		const use = { names: new Set(), root: false };
		const note = (spec, clause) => {
			if (pkgOf(spec) !== lib) return;
			if (spec === lib) {
				use.root = true;
				for (const n of clauseNames(clause)) if (RE_NC_SEGMENT.test(n)) use.names.add(n);
				return;
			}
			const name = spec.slice(lib.length + 1).split('/').reverse()
				.map((seg) => RE_NC_SEGMENT.exec(seg)?.[1]).find(Boolean);
			if (name) use.names.add(name);
		};
		for (const m of content.matchAll(RE_DEP_FROM)) note(m[3], m[1]);
		for (const m of content.matchAll(RE_IMPORT_BARE)) note(m[2], null);
		for (const m of content.matchAll(RE_IMPORT_DYN)) note(m[2], null);
		for (const m of content.matchAll(RE_REQUIRE)) note(m[2], null);
		if (use.root || use.names.size) out.set(key, use);
	}
	return out;
}

// The components the other packages on a page name, each with the first package
// found naming it, and the packages on that page that import the root.
function dependencyNames(modules, uses) {
	const names = new Map();
	const rootBy = new Set();
	for (const m of modules) {
		const use = uses.get(m.pkg + SEP + m.module);
		if (!use) continue;
		if (use.root) rootBy.add(m.pkg);
		for (const n of use.names) if (!names.has(n)) names.set(n, m.pkg);
	}
	return { names, rootBy: [...rootBy].sort() };
}

function catalogues(modules) {
	const out = new Map();
	for (const m of modules) {
		if (!RE_L10N.test(m.module)) continue;
		const e = out.get(m.pkg) ?? { pkg: m.pkg, bytes: 0, chunks: 0 };
		e.bytes += m.bytes;
		e.chunks++;
		out.set(m.pkg, e);
	}
	return [...out.values()].sort((a, b) => b.bytes - a.bytes);
}

const locales = (modules) => [...byName(modules, 'date-fns', RE_LOCALE)]
	.map(([locale, bytes]) => ({ locale, bytes }))
	.sort((a, b) => b.bytes - a.bytes);

// == The report model ==
// == What a package lets the app import ==
// An exports map is the complete list of specifiers a package resolves; Node and
// every bundler refuse a deep path it does not list. Where it lists no module
// below the root, the root is the only specifier there is, and which modules
// arrive is the package's and the tree shaker's business. A subpath counts as a
// module of its own when it resolves to a script; one that declares the root's
// own types is the same library in another shape (markdown-it/browser), not a
// part of it. Returns true when only the root is offered, false when more is or
// nothing is known: without an installed package.json or an exports map a deep
// path resolves as a file. A target with a data extension (.json, .css) is no
// script; one without an extension, a directory or a pattern may be one.
const RE_DATA = /\.(?!(?:m|c)?[jt]sx?$)[A-Za-z0-9]+$/;
const RE_TYPES = /\.d\.(?:m|c)?ts$/;

function exportTargets(value, condition = null, out = { scripts: new Set(), types: new Set() }) {
	if (typeof value === 'string') {
		if (condition === 'types' || RE_TYPES.test(value)) out.types.add(value);
		else if (!RE_DATA.test(value)) out.scripts.add(value);
	} else if (Array.isArray(value)) {
		for (const v of value) exportTargets(v, condition, out);
	} else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) exportTargets(v, k, out);
	}
	return out;
}

// The package.json of an installed package, or null where node_modules does not
// hold it. rel is the directory of a copy below the checkout; without it, the
// copy at the top of node_modules.
const installedCache = new Map();
function installedPackage(root, pkg, rel = path.join('node_modules', pkg)) {
	const file = path.join(root, rel, 'package.json');
	if (!installedCache.has(file)) {
		let json = null;
		try {
			json = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			// not installed, or no readable package.json
		}
		installedCache.set(file, json);
	}
	return installedCache.get(file);
}

function onlyRootExported(root, pkg) {
	const json = installedPackage(root, pkg);
	if (!json) return false;
	const { exports } = json;
	if (exports === undefined || exports === null) return false;
	const subpaths = typeof exports === 'object' && !Array.isArray(exports)
		&& Object.keys(exports).some((k) => k.startsWith('.'))
		? Object.entries(exports)
		: [['.', exports]];
	const rootTypes = exportTargets(subpaths.find(([k]) => k === '.')?.[1]).types;
	return subpaths.every(([key, value]) => {
		if (key === '.') return true;
		const t = exportTargets(value);
		if (!t.scripts.size) return true;
		return t.types.size > 0 && [...t.types].every((x) => rootTypes.has(x));
	});
}

// == Frameworks and libraries ==
// A framework is what the delivered libraries are written against: a package that
// a delivered package requires as a peer, optional peers left out. It needs no
// peer itself, so a plugin of a bundler or of another library is none, and it is
// delivered, itself or through its own dependencies: Vue 3 arrives as
// @vue/runtime-core and its siblings, the vue package adds no module of its own.
// Its family is every delivered package it is made of, depends on, or that names
// it as a peer or a dependency. What belongs to no family is a library of its
// own, jQuery for one. Every version is the installed one, the one the build
// used; without node_modules no framework can be told and no version read.
const peersOf = (json) => Object.keys(json?.peerDependencies ?? {})
	.filter((p) => !json.peerDependenciesMeta?.[p]?.optional);
const depsOf = (json) => Object.keys(json?.dependencies ?? {});

function dependencyClosure(root, pkg) {
	const seen = new Set();
	const queue = [pkg];
	while (queue.length) {
		for (const d of depsOf(installedPackage(root, queue.shift()))) {
			if (seen.has(d)) continue;
			seen.add(d);
			queue.push(d);
		}
	}
	return seen;
}

function frameworksOf(root, packages, dirs, deps) {
	const delivered = packages.filter((x) => !NOT_DEPENDENCY.has(x.pkg));
	const names = new Set(delivered.map((x) => x.pkg));
	// The copies the maps name, where node_modules holds them. A package bundled
	// inside the build of another one has none, so no version either; several
	// copies give each version once.
	const copies = (pkg) => [...(dirs.get(pkg) ?? [])].map((d) => installedPackage(root, pkg, d)).filter(Boolean);
	const jsonOf = (pkg) => copies(pkg)[0] ?? null;
	const version = (pkg) => [...new Set(copies(pkg).map((j) => j.version).filter(Boolean))]
		.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join(', ') || null;
	const entry = (x) => ({
		pkg: x.pkg,
		version: version(x.pkg),
		declared: deps[x.pkg] ?? null,
		bytes: x.bytes,
		share: x.share,
		page: x.page,
	});
	const candidates = new Set(delivered.flatMap((x) => peersOf(jsonOf(x.pkg))));
	const frameworks = [];
	for (const pkg of candidates) {
		const json = installedPackage(root, pkg);
		if (!json || peersOf(json).length) continue;
		const own = dependencyClosure(root, pkg);
		if (!names.has(pkg) && ![...own].some((p) => names.has(p))) continue;
		const family = delivered.filter((x) => {
			const j = jsonOf(x.pkg);
			return x.pkg === pkg || own.has(x.pkg) || peersOf(j).includes(pkg) || depsOf(j).includes(pkg);
		});
		frameworks.push({
			pkg,
			version: json.version ?? null,
			declared: deps[pkg] ?? null,
			family: family.map(entry),
		});
	}
	// The framework most of the delivered bytes are written against comes first.
	// The sum only orders: its packages may peak on different pages.
	const weight = (f) => f.family.reduce((n, x) => n + x.bytes, 0);
	frameworks.sort((a, b) => weight(b) - weight(a) || a.pkg.localeCompare(b.pkg));
	const inFamily = new Set(frameworks.flatMap((f) => f.family.map((x) => x.pkg)));
	return {
		installed: fs.existsSync(path.join(root, 'node_modules')),
		frameworks,
		libraries: delivered.filter((x) => !inFamily.has(x.pkg)).map(entry),
	};
}

function audit(opt) {
	const root = opt.dir;
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`not a directory: ${root}`);

	const json = readPackageJson(root);
	const toolchain = detectToolchain(root, json);
	const src = scanSource(root, opt.src);
	const build = measureBuild(root, opt.build);
	const label = (rel) => rel || '.';
	const bytesOf = new Map((build.packages ?? []).map((x) => [x.pkg, x]));

	const r = {
		tool: 'build-audit',
		root,
		package: json && {
			name: json.name ?? null,
			version: json.version ?? null,
			vue: toolchain.deps[VUE_PKG] ?? null,
			dependencies: Object.keys(json.dependencies ?? {}).length,
			devDependencies: Object.keys(json.devDependencies ?? {}).length,
		},
		toolchain: {
			configs: toolchain.configs,
			kinds: toolchain.kinds,
			built: toolchain.built,
			declared: toolchain.declared,
		},
		src: {
			dir: src.dir,
			label: label(src.dir),
			present: src.present,
			files: src.files.length,
			packages: src.packages.size,
		},
		build: {
			...build,
			label: label(build.dir),
			pages: build.pages?.map(({ modules, ...p }) => p),
			dynamicModules: undefined,
			imports: undefined,
			installDirs: undefined,
		},
	};
	const pages = build.present ? build.pages : [];
	const pageOf = new Map(pages.map((p) => [p.entry, p]));

	const fw = frameworksOf(root, build.packages ?? [], build.installDirs ?? new Map(), toolchain.deps);
	r.installed = fw.installed;
	r.frameworks = fw.frameworks;
	r.libraries = fw.libraries;

	// Every package the source imports by its root, priced with what the build
	// delivers of it. A root import the bundler drops entirely is not a finding.
	r.rootImports = [...src.packages]
		.filter(([, use]) => use.root.length)
		.map(([pkg, use]) => ({
			pkg,
			bytes: bytesOf.get(pkg)?.bytes ?? 0,
			modules: bytesOf.get(pkg)?.modules ?? 0,
			share: bytesOf.get(pkg)?.share ?? 0,
			page: bytesOf.get(pkg)?.page ?? null,
			deep: [...use.deep].sort(),
			sites: use.root,
			onlyRoot: onlyRootExported(root, pkg),
		}))
		.filter((x) => !r.build.present || x.bytes >= PRICE_MIN)
		.sort((a, b) => b.bytes - a.bytes || a.pkg.localeCompare(b.pkg));

	// A component is listed with the page that loads the most of it; the ones the
	// source never names are counted on the page that loads the most of them.
	// What another package on the page names counts like a name in the source.
	const perPage = pages.map((p) => {
		const dep = dependencyNames(p.modules, build.uses);
		const named = (name) => (src.names.has(name) ? null : dep.names.get(name) ?? null);
		const via = pulledIn(p.modules, new Set([...src.names, ...dep.names.keys()]), build.imports);
		const delivered = components(p.modules)
			.map((c) => ({ ...c, share: c.bytes / p.raw, page: p.entry,
				namedBy: named(c.name), via: via.get(c.name) ?? null }));
		const unreferenced = delivered.filter((c) => !src.names.has(c.name) && !c.namedBy && !c.via);
		const bytes = unreferenced.reduce((n, c) => n + c.bytes, 0);
		return { page: p.entry, delivered, unreferenced, bytes, share: bytes / p.raw, rootBy: dep.rootBy };
	});
	const worst = perPage.reduce((w, x) => (!w || x.bytes > w.bytes ? x : w), null);
	r.components = {
		pkg: VUE_PKG,
		delivered: heaviestPage(perPage.flatMap((x) => x.delivered), 'name'),
		page: worst?.page ?? null,
		unreferenced: worst?.unreferenced ?? [],
		unreferencedBytes: worst?.bytes ?? 0,
		unreferencedShare: worst?.share ?? 0,
		referenced: worst?.delivered.filter((c) => src.names.has(c.name)).length ?? 0,
		namedByDeps: worst?.delivered.filter((c) => c.namedBy).length ?? 0,
		pulledIn: worst?.delivered.filter((c) => c.via).length ?? 0,
		rootBy: worst?.rootBy ?? [],
		named: [...src.names].sort(),
	};

	r.catalogues = heaviestPage(pages.flatMap((p) => catalogues(p.modules).map((c) => ({ ...c, page: p.entry }))), 'pkg');

	const moment = bytesOf.get('moment');
	r.moment = moment
		? {
			bytes: moment.bytes,
			share: moment.share,
			page: moment.page,
			withLocales: pageOf.get(moment.page).modules.some((m) => m.pkg === 'moment' && /locale/i.test(m.module)),
			sites: (src.packages.get('moment')?.root.length ?? 0) + (src.packages.get('moment')?.deep.size ?? 0),
			wrapper: bytesOf.get('@nextcloud/moment') ?? null,
		}
		: null;

	// The locales bound statically, on the page that binds the most of them.
	const localeBytes = (xs) => xs.reduce((n, x) => n + x.bytes, 0);
	const bound = pages
		.map((p) => ({ page: p.entry, raw: p.raw, locales: locales(p.modules) }))
		.reduce((w, x) => (!w || localeBytes(x.locales) > localeBytes(w.locales) ? x : w), null);
	r.dateFns = bytesOf.get('date-fns')
		? {
			bytes: bytesOf.get('date-fns').bytes,
			page: bytesOf.get('date-fns').page,
			sites: (src.packages.get('date-fns')?.root.length ?? 0) + (src.packages.get('date-fns')?.deep.size ?? 0),
			static: bound.locales,
			staticPage: bound.page,
			staticShare: localeBytes(bound.locales) / bound.raw,
			dynamic: locales(build.dynamicModules),
		}
		: null;

	r.findings = findings(r);
	return r;
}

// == Findings ==
// A finding states what the checkout and the build output show, and what it
// costs. Where a figure cannot be measured it is named as missing, never
// estimated, and a recommendation the numbers do not carry is not made.
function findings(r) {
	const out = [];
	const add = (level, id, lines) => out.push({ level, id, lines });
	const b = r.build;
	const t = r.toolchain;
	const priced = (bytes, share, page) => `${num(bytes)} B, ${pct(share)} of the static path of ${page}`;

	// -- which toolchain this app is built with --
	const cfg = t.configs.map((c) => c.file);
	const declared = Object.entries(t.declared).map(([p, v]) => `${p} ${v}`);
	// Without a package.json the no-package-json finding already says so.
	const pkgSays = !r.package ? ''
		: declared.length ? `, package.json declares ${declared.join(', ')}` : ', package.json declares no bundler';
	const tool = [
		`Built with: ${cfg.length ? cfg.join(', ') : `no bundler config in ${shortPath(path.resolve(r.root))}`}`
		+ `${pkgSays}.`,
	];
	if (t.kinds.length > 1) {
		tool.push(t.built.length === 1
			? `  More than one toolchain is installed; the build script runs ${t.built[0]}, so that one`
				+ ' produced the output measured here.'
			: '  More than one toolchain is installed, so the build scripts in package.json decide which'
				+ ' one produced the output measured here.');
	}
	if (r.package?.vue) tool.push(`  ${VUE_PKG} ${r.package.vue} declared.`);
	add('info', 'toolchain', tool);

	// -- what the delivered libraries are written against --
	if (b.present && (r.frameworks.length || r.libraries.length)) {
		const v = (x) => `${x.pkg}${x.version ? ` ${x.version}` : ''}`;
		add('info', 'frameworks', !r.installed
			? [`No node_modules in ${shortPath(path.resolve(r.root))}, so neither the framework the delivered`
				+ ' packages are written against nor their installed versions are known.'
				+ ` ${plural(r.libraries.length, 'package is', 'packages are')} delivered.`]
			: [
				r.frameworks.length
					? `Written against: ${r.frameworks.map((f) => `${v(f)}, ${plural(f.family.length, 'delivered package', 'delivered packages')}`).join('; ')}.`
					: 'No delivered package names a framework as its peer.',
				...(r.libraries.length ? [`  ${r.frameworks.length ? 'Other delivered' : 'Delivered'} libraries: `
					+ `${num(r.libraries.length)}, ${r.libraries.slice(0, 6).map(v).join(', ')}`
					+ `${r.libraries.length > 6 ? `, and ${num(r.libraries.length - 6)} more` : ''}.`] : []),
			]);
	}

	// -- what the artefact allows to be measured at all --
	// Without a bundler nothing builds js/: the files there are the source, so
	// maps and chunking are not theirs to have. A package.json alone does not
	// change that, many apps keep one only for linters and end-to-end tests. A
	// delivered source map shows that something built the files after all.
	const handWritten = b.present && !b.mapped && !t.kinds.length && !t.built.length && !declared.length;
	if (handWritten) {
		add('info', 'hand-written-js', [
			`${r.package ? 'No bundler config, package.json declares no bundler' : 'No package.json and no bundler config'},`
			+ ` so the ${plural(b.js, 'file', 'files')} in ${b.label}`
			+ ` (${num(b.raw)} B) ${b.js === 1 ? 'is' : 'are'} taken as written by hand and delivered as`
			+ ` ${b.js === 1 ? 'it is' : 'they are'}.`,
			'  Source maps, module format and how a page is split are properties of a build, so no'
			+ ' finding about them is made.',
		]);
	} else if (!b.present) {
		add('info', 'no-build-output', [
			`Nothing built in ${b.label}, so no finding in this report carries a byte figure.`,
			'  make build produces the output; --build=DIR points the audit at another directory.',
		]);
	} else if (!b.mapped) {
		add('warn', 'no-source-maps', [
			`No delivered file in ${b.label} carries a source map, so none of these ${num(b.raw)} B can be`
			+ ' charged to the package it came from.',
			'Without maps nobody can say what the bundle consists of, the app\'s own maintainer'
			+ ' included, and no finding below can be priced. @nextcloud/vite-config sets'
			+ ' build.sourcemap, which is what makes the per-package figures in this report possible.',
		]);
	} else if (b.unmapped) {
		add('info', 'partly-unmapped', [
			`${plural(b.unmapped, 'delivered file carries', 'delivered files carry')} no source map, `
			+ `${plural(b.mapped, 'file does', 'files do')}. The bytes of the unmapped ones are counted `
			+ 'but charged to no package.',
		]);
	} else {
		add('ok', 'source-maps', [
			`Every delivered file in ${b.label} carries a source map, so every byte can be charged to`
			+ ' the package and the module it came from.',
		]);
	}
	if (b.present && b.nonEsm && !handWritten) {
		add('info', 'non-esm', [
			`${plural(b.nonEsm, 'delivered file looks', 'delivered files look')} like a webpack or CommonJS`
			+ ' bundle. Their internal structure is not derivable from the artefact, so each counts as'
			+ ' one file and the chunk figures below say nothing about what is inside them.',
		]);
	}

	// -- how the payload of a page is split --
	// webpack and rspack put the whole static path of a page into its entry file,
	// so there one file holding it is the construction, not a finding; what the
	// page splits off is what its runtime loads later, and it counts as part of
	// the page.
	const whole = (p) => p.raw + (p.runtime ? p.lazy.raw : 0);
	const pages = b.present && !handWritten ? b.pages.filter((p) => p.raw >= PAYLOAD_MIN) : [];
	const monoliths = pages.filter((p) => p.largest.raw / whole(p) >= MONOLITH_SHARE);
	if (monoliths.length) {
		add('warn', 'monolithic-page', [
			`One chunk holds at least ${pct(MONOLITH_SHARE)} of a page, so the browser fetches`
			+ ' practically the whole page before it shows anything:',
			...monoliths.map((p) => `  ${p.entry}: ${plural(p.count, 'file', 'files')}, ${num(p.raw)} B`
				+ `${p.runtime && p.lazy.count ? `, and ${plural(p.lazy.count, 'chunk', 'chunks')} of `
					+ `${num(p.lazy.raw)} B its runtime loads later` : ''}, `
				+ `of which ${p.largest.file} is ${num(p.largest.raw)} B (${pct(p.largest.raw / whole(p))}).`),
			'Code splitting puts what the first paint does not need behind a dynamic import, and then'
			+ ' the browser fetches it when the code asks. Which part of a page that is does not follow'
			+ ' from the build output; the source decides it.',
		]);
	}

	// -- packages the source imports by their root --
	if (r.rootImports.length) {
		const site = (x) => `${x.file}${x.names.length ? ` (${x.names.slice(0, 3).join(', ')}${x.names.length > 3 ? ', ...' : ''})` : ''}`;
		const where = (x) => (x.sites.length > 2
			? `${plural(x.sites.length, 'file', 'files')}: ${x.sites.slice(0, 2).map(site).join(', ')}, `
				+ `and ${num(x.sites.length - 2)} more`
			: x.sites.map(site).join(' and '));
		const row = (x) => `  ${x.pkg}: `
			+ `${b.present ? `${num(x.bytes)} B in ${plural(x.modules, 'module', 'modules')}, `
				+ `${pct(x.share)} of the static path of ${x.page}, ` : ''}`
			+ `imported by its root in ${where(x)}`
			+ '.'
			+ `${x.deep.length ? ` It is imported per module as well, through ${plural(x.deep.length, 'other specifier', 'other specifiers')}.` : ''}`;
		// A package whose exports map offers nothing below the root leaves the app no
		// other specifier, so its modules are listed in the table, not warned about.
		const sealed = b.present ? r.rootImports.filter((x) => x.onlyRoot && x.modules >= BARREL_MODULES_MIN) : [];
		const barrels = b.present
			? r.rootImports.filter((x) => x.modules >= BARREL_MODULES_MIN && !sealed.includes(x)) : [];
		const flat = b.present ? r.rootImports.filter((x) => !barrels.includes(x) && !sealed.includes(x)) : [];
		if (barrels.length) {
			add('warn', 'package-root-import', [
				`${plural(barrels.length, 'package is', 'packages are')} imported by their root in `
				+ `${r.src.label}, so the whole barrel is reachable and the bundler keeps whatever it`
				+ ' cannot prove unused:',
				...barrels.map(row),
				'Importing the module that is used instead of the package root lets the bundler drop'
				+ ' the rest of the barrel.',
				...(barrels.some((x) => x.pkg === VUE_PKG)
					? [`ncmake's lint-vue-imports workflow gates exactly this specifier for ${VUE_PKG},`
						+ ' so this finding is that red check with a byte figure attached.']
					: []),
			]);
		}
		if (sealed.length) {
			add('ok', 'root-only-export', [
				`${plural(sealed.length, 'package is', 'packages are')} imported by ${sealed.length === 1 ? 'its' : 'their'} root in`
				+ ` ${r.src.label} and ${sealed.length === 1 ? 'offers' : 'offer'} no module below it in`
				+ ` ${sealed.length === 1 ? 'its' : 'their'} exports map, so the root is the only specifier`
				+ ` there is: ${sealed.map((x) => `${x.pkg} (${num(x.bytes)} B in ${plural(x.modules, 'module', 'modules')})`).join(', ')}.`
				+ ` Which of ${sealed.length === 1 ? 'its' : 'their'} modules arrive is decided by the package and by tree shaking, not by`
				+ ' the import.',
			]);
		}
		if (flat.length && !barrels.length) {
			add('ok', 'root-imports-cheap', [
				`${plural(flat.length, 'package is', 'packages are')} imported by their root in `
				+ `${r.src.label}, each delivered in fewer than ${num(BARREL_MODULES_MIN)} modules, so a`
				+ ' per-module import has nothing to leave out and the specifier decides no bytes here.',
			]);
		}
		if (!b.present) {
			add('info', 'root-import-unpriced', [
				`${plural(r.rootImports.length, 'package is', 'packages are')} imported by their root in `
				+ `${r.src.label}:`,
				...r.rootImports.map(row),
				`Whether that costs anything depends on how many modules the build delivers of them:`
				+ ` fewer than ${num(BARREL_MODULES_MIN)} and a per-module import has nothing to leave`
				+ ' out. Without a build output that cannot be decided here.',
			]);
		}
	} else if (r.src.present && r.src.packages) {
		add('ok', 'no-package-root-import', [
			`No package${b.present ? ' the build delivers' : ''} is imported by its root in ${r.src.label}:`
			+ ` every one of the ${plural(r.src.packages, 'package', 'packages')} it imports is named by`
			+ ' the module that is used.',
		]);
	}

	// -- components delivered although the source never names them --
	// A verdict only under a root import: there the specifier is the screw. Where
	// the source imports per component, what else arrives is the structure of the
	// library, so that figure belongs in the table and not in a finding.
	const c = r.components;
	if (b.present && r.src.present && r.rootImports.some((x) => x.pkg === VUE_PKG)
		&& c.unreferencedBytes >= PRICE_MIN) {
		const shown = c.unreferenced.slice(0, 6);
		const n = c.unreferenced.length;
		add('warn', 'unreferenced-components', [
			`${plural(n, 'component of', 'components of')} ${c.pkg} ${n === 1 ? 'is' : 'are'} `
			+ `delivered although no file in ${r.src.label} names ${n === 1 ? 'it' : 'them'}, no other`
			+ ` dependency names ${n === 1 ? 'it' : 'them'} and no component named by either imports`
			+ ` ${n === 1 ? 'it' : 'them'}: ${priced(c.unreferencedBytes, c.unreferencedShare, c.page)}`
			+ `${c.referenced ? `, next to ${plural(c.referenced, 'component', 'components')} the source`
				+ ` names` : ''}`
			+ `${c.namedByDeps ? `${c.referenced ? ',' : ', next to'} ${num(c.namedByDeps)} that other dependencies name` : ''}`
			+ `${c.pulledIn && (c.referenced || c.namedByDeps) ? ` and ${num(c.pulledIn)} those pull in` : ''}.`,
			`  ${shown.map((x) => `${x.name} ${num(x.bytes)} B`).join(', ')}`
			+ `${c.unreferenced.length > shown.length ? `, and ${num(c.unreferenced.length - shown.length)} more` : ''}.`,
			...(c.rootBy.length
				? [`These arrive through the root import, and ${c.rootBy.join(', ')} on the same page`
					+ ` ${c.rootBy.length === 1 ? 'imports' : 'import'} the root as well: as long as one module`
					+ ' imports the barrel, the whole component set is reachable, so the bundler must keep it.'
					+ ` Per-component imports in the app drop nothing while ${c.rootBy.length === 1 ? 'that package does' : 'those packages do'};`
					+ ` the specifier to change is in ${c.rootBy.join(', ')}.`]
				: ['These arrive through the root import: under a barrel the whole component set is'
					+ ' reachable, so the bundler must keep it. Per-component imports leave it free to'
					+ ' drop what the app never names.']),
		]);
	}

	// -- moment, where the source is what pulls it in --
	// Delivered through a dependency it is the dependency's decision, and no
	// specifier in src changes it. The bytes stay in the payload table.
	if (r.moment && r.moment.bytes >= PRICE_MIN && r.moment.sites) {
		const m = r.moment;
		add('warn', 'moment', [
			`moment is on the static path: ${priced(m.bytes, m.share, m.page)}`
			+ `${m.withLocales ? ', in the build that carries every locale' : ''}.`,
			`  Imported in ${plural(m.sites, 'file', 'files')} of ${r.src.label}.`,
			'Whatever formats dates here, moment is the largest way to do it: it ships its locale data'
			+ ' as one piece and tree-shakes away nothing. date-fns with the functions that are used,'
			+ ' or luxon, is a fraction of it.',
		]);
	}

	// -- date-fns locales the source binds statically --
	if (r.dateFns && r.dateFns.sites) {
		const d = r.dateFns;
		const bytes = d.static.reduce((n, x) => n + x.bytes, 0);
		const dyn = d.dynamic.reduce((n, x) => n + x.bytes, 0);
		if (d.static.length >= 2 && bytes >= PRICE_MIN) {
			add('warn', 'date-fns-locales', [
				`${plural(d.static.length, 'date-fns locale is', 'date-fns locales are')} bound statically: `
				+ `${priced(bytes, d.staticShare, d.staticPage)}`
				+ `${d.dynamic.length ? `, a further ${plural(d.dynamic.length, 'locale', 'locales')} `
					+ `(${num(dyn)} B) sit behind dynamic imports` : ''}.`,
				`  Largest: ${d.static.slice(0, 5).map((x) => `${x.locale} ${num(x.bytes)} B`).join(', ')}.`,
				'A session uses one locale. An import per locale under a dynamic specifier delivers that'
				+ ' one and leaves the rest in chunks the browser never fetches.',
			]);
		}
	}

	// -- what the audit could not read --
	if (!r.src.present) {
		add('info', 'no-source', [
			`No ${r.src.dir} directory in ${shortPath(path.resolve(r.root))}, so no finding about how this`
			+ ' app imports anything could be made. --src=DIR names the source directory.',
		]);
	}
	if (!r.package && !handWritten) {
		add('info', 'no-package-json', [
			'No readable package.json, so the declared toolchain and dependency ranges are unknown.',
		]);
	}

	return sortFindings(out);
}

// == Human-readable output ==
// How to run this again with other options.
const how = howToRun('BUILD_AUDIT_CMDLINE', 'build-audit.mjs %s');

function renderSummary(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);
	const b = r.build;

	p(`build-audit  ${path.resolve(r.root)}`);
	p(`  ${r.package ? `${r.package.name ?? 'unnamed'}${r.package.version ? ` ${r.package.version}` : ''}`
		: 'no package.json'}, `
		+ `${r.src.present ? `${plural(r.src.files, 'source file', 'source files')} in ${r.src.label}` : `no ${r.src.dir} directory`}, `
		+ `${b.present ? `${plural(b.staticFiles, 'file', 'files')} and ${num(b.raw)} B on the static path of `
			+ `${plural(b.pages.length, 'page', 'pages')} in ${b.label}` : `nothing built in ${b.label}`}.`);
	p();

	if (b.present) {
		p(table(
			['Page', 'Chunks', 'Raw B', 'Largest chunk', 'Share'],
			b.pages.map((x) => [x.entry, num(x.count), num(x.raw), x.largest ? x.largest.file : '', pct(x.share)]),
			['l', 'r', 'r', 'l', 'r'],
		));
		p();
	}

	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('Unit: bytes, raw and uncompressed. The static path is what a browser fetches when a');
	p('page opens: every entry plus everything it imports statically. Lower is better.');
	p('Byte figures come from the source maps the build ships; what carries no map is');
	p('counted but charged to no package. A figure is that of the page whose static path');
	p('carries the most of it.');
	p();
	p(`All tables: ${how('--details')}`);
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

function renderDetails(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);
	const b = r.build;

	if (r.rootImports.length) {
		p();
		p('== Root imports ==');
		p('Every file that imports a package by its root, with the names it takes from the');
		p('barrel. One per line, so the list can be worked through.');
		p();
		for (const x of r.rootImports) {
			const rows = cut(x.sites, opt.top);
			p(`-- ${x.pkg}, ${num(x.bytes)} B delivered in ${plural(x.modules, 'module', 'modules')}`
				+ `${x.page ? ` on ${x.page}` : ''} --`);
			if (x.onlyRoot) p('Its exports map offers no module below the root, so the root is the only specifier.');
			p(table(
				['File', 'Names taken from the root'],
				rows.rows.map((s) => [s.file, s.names.join(', ')]),
				['l', 'l'],
			));
			if (rows.hidden) p(`... ${num(rows.hidden)} further files not shown, use ${how('--details --top=0')}`);
			if (x.deep.length) p(`Per-module specifiers in the same source: ${x.deep.slice(0, 6).join(', ')}`
				+ `${x.deep.length > 6 ? `, and ${num(x.deep.length - 6)} more` : ''}.`);
			p();
		}
	}

	if (b.present && r.components.delivered.length) {
		p('== Components of @nextcloud/vue in the payload ==');
		p('Charged through the source maps, each on the page that loads the most of it, with');
		p('its share of that page. "named in the source" means the name occurs in');
		p(`${r.src.label} at all, in an import or in a template; that is the widest reading, so`);
		p('a component listed as not named is one the source really never mentions. "no,');
		p('named by P" means another package on that page imports it, "no, through X" that');
		p('a component named by either imports it.');
		p();
		const rows = cut(r.components.delivered, opt.top);
		p(table(
			['Component', 'Bytes', 'Share', 'Page', 'Named in the source'],
			rows.rows.map((c) => [c.name, num(c.bytes), pct(c.share), c.page,
				r.components.named.includes(c.name) ? 'yes'
					: c.namedBy ? `no, named by ${c.namedBy}` : c.via ? `no, through ${c.via}` : 'no']),
			['l', 'r', 'r', 'l', 'l'],
		));
		if (rows.hidden) p(`... ${num(rows.hidden)} further components not shown, use ${how('--details --top=0')}`);
		p();
	}

	if (r.dateFns && (r.dateFns.static.length || r.dateFns.dynamic.length)) {
		p('== date-fns locales ==');
		p('Static means the browser fetches it when the page opens, dynamic only when the');
		p('code asks for that locale.');
		p();
		const rows = cut([
			...r.dateFns.static.map((x) => ({ ...x, kind: 'static' })),
			...r.dateFns.dynamic.map((x) => ({ ...x, kind: 'dynamic' })),
		], opt.top);
		p(table(
			['Locale', 'Bytes', 'Fetched'],
			rows.rows.map((x) => [x.locale, num(x.bytes), x.kind]),
			['l', 'r', 'l'],
		));
		if (rows.hidden) p(`... ${num(rows.hidden)} further locales not shown, use ${how('--details --top=0')}`);
		p();
	}

	if (b.present && (r.frameworks.length || r.libraries.length)) {
		p('== Frameworks and libraries ==');
		p('Each framework with the delivered packages it is made of, depends on or that are');
		p('written against it, then every other delivered package. Version is the one');
		p('node_modules holds, the one the build used; declared is the range of package.json.');
		p();
		const rows = (xs) => xs.map((x) => [x.pkg, x.version ?? '', x.declared ?? '', num(x.bytes), x.page]);
		for (const f of [...r.frameworks.map((f) => ({ title: `${f.pkg}${f.version ? ` ${f.version}` : ''}`, xs: f.family })),
			...(r.libraries.length ? [{ title: 'other libraries', xs: r.libraries }] : [])]) {
			const cutRows = cut(f.xs, opt.top);
			p(`-- ${f.title} --`);
			p(table(['Package', 'Version', 'Declared', 'Bytes', 'Page'], rows(cutRows.rows), ['l', 'l', 'l', 'r', 'l']));
			if (cutRows.hidden) p(`... ${num(cutRows.hidden)} further packages not shown, use ${how('--details --top=0')}`);
			p();
		}
	}

	if (b.present && b.packages.length) {
		p('== Where the payload comes from ==');
		p('The packages the static path is made of, charged through the source maps. Each');
		p('is shown on the page that loads the most of it, with its share of that page, so the');
		p('shares do not add up; bundle-report breaks every page down.');
		p();
		const rows = cut(b.packages, opt.top);
		p(table(
			['Origin', 'Bytes', 'Share', 'Modules', 'Page'],
			rows.rows.map((x) => [x.pkg, num(x.bytes), pct(x.share), num(x.modules), x.page]),
			['l', 'r', 'r', 'r', 'l'],
		));
		if (rows.hidden) p(`... ${num(rows.hidden)} further origins not shown, use ${how('--details --top=0')}`);
		for (const cat of r.catalogues) {
			p(`Inside it: the ${cat.pkg} translation catalogue, ${num(cat.bytes)} B in `
			+ `${plural(cat.chunks, 'chunk', 'chunks')} on ${cat.page},`);
			p('holding every language a page could display.');
		}
		p();
	}

	return out.join('\n').replace(/\n+$/, '');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = audit(opt);
const json = opt.json || opt.jsonFile ? `${JSON.stringify(report, null, 2)}\n` : null;
if (opt.json) {
	process.stdout.write(json);
} else {
	const text = renderSummary(report, opt) + (opt.details ? renderDetails(report, opt) : '');
	process.stdout.write(`${text}\n`);
}
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
