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
// Reads only. No build, no node_modules, no network, no npm dependencies.
// Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';

import {
	attrOfFiles,
	buildGraph,
	closure,
	moduleList,
	packageList,
	sizes,
} from './built-assets.mjs';
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
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',                  // the app checkout; src and build are inside it
	build: 'js',               // built assets, the usual Nextcloud app layout
	src: 'src',                // application source
	top: 12,                   // rows per table, 0 = all
	details: false,            // every table; the default is the verdict alone
	json: false,
};

// Files that can hold an import in a Nextcloud app's source.
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue']);

// The component library this audit knows by name: its components carry a byte
// figure each, and ncmake's lint-vue-imports gates how they are imported.
const VUE_PKG = '@nextcloud/vue';

// Below this a figure says nothing next to a bundle of several hundred kB.
const PRICE_MIN = 4096;
// A page this small decides nothing by how it is split.
const PAYLOAD_MIN = 102400;
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
  --build=DIR           built assets, inside dir (default: ${defaults.build})
  --src=DIR             application source, inside dir (default: ${defaults.src})
  --top=N               rows per table, 0 for all (default: ${defaults.top})
  --details             print every table behind the findings
  --json                emit the full result as JSON and nothing else
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
	for (const arg of argv) {
		const eq = arg.indexOf('=');
		const key = eq === -1 ? arg : arg.slice(0, eq);
		const val = eq === -1 ? '' : arg.slice(eq + 1);
		switch (key) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--json': opt.json = true; break;
			case '--details': opt.details = true; break;
			case '--build': opt.build = val; break;
			case '--src': opt.src = val; break;
			case '--top': opt.top = Number(val); break;
			default:
				if (key.startsWith('-')) die(`unknown option: ${key}`);
				if (dir !== null) die(`more than one directory given: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (!Number.isInteger(opt.top) || opt.top < 0) die('--top needs a non-negative integer');
	return opt;
}

// == The app as it is written ==
// Imports are matched textually, the way the delivered files are: a .vue file is
// not JavaScript, and a parser for every dialect an app may be written in is not
// what decides these findings. A specifier that is only mentioned still counts,
// because the findings are about what the source never mentions at all.
const RE_IMPORT_FROM = /(?:^|[^.\w$])import\s+([^;]*?)\s*from\s*(["'])([^"'\n]+)\2/g;
const RE_IMPORT_BARE = /(?:^|[^.\w$])import\s*(["'])([^"'\n]+)\1/g;
const RE_IMPORT_DYN = /(?:^|[^.\w$])import\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
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
			else if (e.isFile() && SRC_EXT.has(path.extname(e.name))) out.push(r);
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

// The bundler is not guessed from the output: the checkout says which toolchain
// is installed, and an app mid-migration says both.
const CONFIGS = {
	vite: ['vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.ts'],
	webpack: ['webpack.config.js', 'webpack.config.mjs', 'webpack.config.cjs', 'webpack.config.ts'],
};
const TOOL_PKGS = ['@nextcloud/vite-config', 'vite', '@nextcloud/webpack-vue-config', 'webpack'];

function detectToolchain(root, pkg) {
	const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
	const configs = [];
	for (const [kind, names] of Object.entries(CONFIGS)) {
		for (const name of names) if (fs.existsSync(path.join(root, name))) configs.push({ kind, file: name });
	}
	const declared = {};
	for (const name of TOOL_PKGS) if (deps[name]) declared[name] = deps[name];
	return { configs, kinds: [...new Set(configs.map((c) => c.kind))], declared, deps };
}

// == The app as it is delivered ==
// The static closure of every entry is what a page fetches when it opens, so
// that is the payload a finding is priced against. What only a dynamic import
// can reach is counted apart: a locale nobody loads costs nothing.
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
	out.packages = packageList(at, out.raw);
	out.modules = moduleList(at);
	out.dynamicModules = dynamicFiles.length ? moduleList(attrOfFiles(dir, dynamicFiles)) : [];

	out.pages = g.entries
		.map((entry) => {
			const files = [...closure(g.graph, entry, 'static')]
				.map((f) => ({ file: f, raw: sizes(abs(f)).raw }))
				.sort((a, b) => b.raw - a.raw);
			const raw = files.reduce((n, f) => n + f.raw, 0);
			return {
				entry,
				count: files.length,
				raw,
				largest: files[0] ?? null,
				share: raw ? (files[0]?.raw ?? 0) / raw : 0,
			};
		})
		.sort((a, b) => b.raw - a.raw);
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

function components(modules) {
	const out = new Map();
	for (const m of modules) {
		if (m.pkg !== VUE_PKG) continue;
		const hit = RE_COMPONENT_DIR.exec(m.module) ?? RE_COMPONENT_FILE.exec(m.module);
		if (!hit) continue;
		out.set(hit[1], (out.get(hit[1]) ?? 0) + m.bytes);
	}
	return [...out].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes);
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
		toolchain: { configs: toolchain.configs, kinds: toolchain.kinds, declared: toolchain.declared },
		src: {
			dir: src.dir,
			label: label(src.dir),
			present: src.present,
			files: src.files.length,
			packages: src.packages.size,
		},
		build: { ...build, label: label(build.dir), modules: undefined, dynamicModules: undefined },
	};

	// Every package the source imports by its root, priced with what the build
	// delivers of it. A root import the bundler drops entirely is not a finding.
	r.rootImports = [...src.packages]
		.filter(([, use]) => use.root.length)
		.map(([pkg, use]) => ({
			pkg,
			bytes: bytesOf.get(pkg)?.bytes ?? 0,
			modules: bytesOf.get(pkg)?.modules ?? 0,
			deep: [...use.deep].sort(),
			sites: use.root,
		}))
		.filter((x) => !r.build.present || x.bytes >= PRICE_MIN)
		.sort((a, b) => b.bytes - a.bytes || a.pkg.localeCompare(b.pkg));

	const delivered = r.build.present ? components(build.modules) : [];
	const unreferenced = delivered.filter((c) => !src.names.has(c.name));
	r.components = {
		pkg: VUE_PKG,
		delivered,
		unreferenced,
		unreferencedBytes: unreferenced.reduce((n, c) => n + c.bytes, 0),
		referenced: delivered.length - unreferenced.length,
		named: [...src.names].sort(),
	};

	r.catalogues = r.build.present ? catalogues(build.modules) : [];

	const moment = bytesOf.get('moment');
	r.moment = moment
		? {
			bytes: moment.bytes,
			share: moment.share,
			withLocales: build.modules.some((m) => m.pkg === 'moment' && /locale/i.test(m.module)),
			sites: (src.packages.get('moment')?.root.length ?? 0) + (src.packages.get('moment')?.deep.size ?? 0),
			wrapper: bytesOf.get('@nextcloud/moment') ?? null,
		}
		: null;

	r.dateFns = bytesOf.get('date-fns')
		? {
			bytes: bytesOf.get('date-fns').bytes,
			static: locales(build.modules),
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
	const priced = (bytes) => (b.raw ? `${num(bytes)} B, ${pct(bytes / b.raw)} of the page-load payload` : `${num(bytes)} B`);

	// -- which toolchain this app is built with --
	const cfg = t.configs.map((c) => c.file);
	const declared = Object.entries(t.declared).map(([p, v]) => `${p} ${v}`);
	const tool = [
		`Built with: ${cfg.length ? cfg.join(', ') : `no bundler config in ${shortPath(path.resolve(r.root))}`}`
		+ `${declared.length ? `, package.json declares ${declared.join(', ')}` : ', package.json declares no bundler'}.`,
	];
	if (t.kinds.length > 1) {
		tool.push('  Both toolchains are installed, so the build scripts in package.json decide which'
			+ ' one produced the output measured here.');
	}
	if (r.package?.vue) tool.push(`  ${VUE_PKG} ${r.package.vue} declared.`);
	add('info', 'toolchain', tool);

	// -- what the artefact allows to be measured at all --
	if (!b.present) {
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
	if (b.present && b.nonEsm) {
		add('info', 'non-esm', [
			`${plural(b.nonEsm, 'delivered file looks', 'delivered files look')} like a webpack or CommonJS`
			+ ' bundle. Their internal structure is not derivable from the artefact, so each counts as'
			+ ' one file and the chunk figures below say nothing about what is inside them.',
		]);
	}

	// -- how the payload of a page is split --
	const pages = b.present ? b.pages.filter((p) => p.raw >= PAYLOAD_MIN) : [];
	const monoliths = pages.filter((p) => p.share >= MONOLITH_SHARE);
	if (monoliths.length) {
		add('warn', 'monolithic-page', [
			'A page arrives as a single chunk, so the browser fetches all of it before the page shows'
			+ ' anything:',
			...monoliths.map((p) => `  ${p.entry}: ${plural(p.count, 'file', 'files')}, ${num(p.raw)} B, `
				+ `of which ${p.largest.file} is ${num(p.largest.raw)} B (${pct(p.share)}).`),
			'Code splitting puts what the first paint does not need behind a dynamic import, and then'
			+ ' the browser fetches it when the code asks. Which part of a page that is does not follow'
			+ ' from the build output; the source decides it.',
		]);
	} else if (pages.length) {
		add('ok', 'split-pages', [
			`Every page over ${num(PAYLOAD_MIN)} B is split: `
			+ `${pages.map((p) => `${p.entry} into ${plural(p.count, 'chunk', 'chunks')} `
				+ `(largest ${pct(p.share)})`).join(', ')}.`,
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
				+ `${pct(b.raw ? x.bytes / b.raw : 0)} of the page-load payload, ` : ''}`
			+ `imported by its root in ${where(x)}`
			+ `${x.deep.length ? `, per module in ${plural(x.deep.length, 'other specifier', 'other specifiers')}` : ''}.`;
		const barrels = b.present ? r.rootImports.filter((x) => x.modules >= BARREL_MODULES_MIN) : [];
		const flat = b.present ? r.rootImports.filter((x) => !barrels.includes(x)) : [];
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
		if (flat.length) {
			add('info', 'root-import-small', [
				`${plural(flat.length, 'package is', 'packages are')} imported by their root in `
				+ `${r.src.label} and delivered in fewer than ${num(BARREL_MODULES_MIN)} modules:`,
				...flat.map(row),
				'A package that arrives as one bundled module has nothing a per-module import could'
				+ ' leave out, so the specifier is not what decides these bytes.',
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
	const c = r.components;
	if (b.present && c.delivered.length && r.src.present) {
		const barrel = r.rootImports.some((x) => x.pkg === VUE_PKG);
		if (c.unreferencedBytes >= PRICE_MIN) {
			const shown = c.unreferenced.slice(0, 6);
			const n = c.unreferenced.length;
			add(barrel ? 'warn' : 'info', 'unreferenced-components', [
				`${plural(n, 'component of', 'components of')} ${c.pkg} ${n === 1 ? 'is' : 'are'} `
				+ `delivered although no file in ${r.src.label} names ${n === 1 ? 'it' : 'them'}: `
				+ `${priced(c.unreferencedBytes)}`
				+ `${c.referenced ? `, next to ${plural(c.referenced, 'component', 'components')} the source`
					+ ' does name' : ''}.`,
				`  ${shown.map((x) => `${x.name} ${num(x.bytes)} B`).join(', ')}`
				+ `${c.unreferenced.length > shown.length ? `, and ${num(c.unreferenced.length - shown.length)} more` : ''}.`,
				...(barrel
					? ['These arrive through the root import: under a barrel the whole component set is'
						+ ' reachable, so the bundler must keep it. Per-component imports leave it free to'
						+ ' drop what the app never names.']
					: c.referenced
						? ['The source imports per component, so these arrive as dependencies of'
							+ ' components it does name. That is the structure of the library, not'
							+ ' something the app decides: a figure to know, not a defect.']
						: [`No file in ${r.src.label} names a component of ${c.pkg} at all, so every`
							+ ' one of these arrives through a package that does. Nothing the app'
							+ ' writes decides them.']),
			]);
		} else {
			add('ok', 'components-referenced', [
				`Every component of ${c.pkg} that is delivered is named in ${r.src.label} `
				+ `(${plural(c.delivered.length, 'component', 'components')}).`,
			]);
		}
	}

	// -- a translation catalogue on the static path --
	for (const cat of r.catalogues) {
		if (cat.bytes < PRICE_MIN) continue;
		add('info', `l10n:${cat.pkg}`, [
			`${cat.pkg} delivers its translation catalogue on the static path: ${priced(cat.bytes)} in `
			+ `${plural(cat.chunks, 'chunk', 'chunks')}.`,
			'The catalogue holds every language, so a page loads all of them to display one. Whether'
			+ ' the library can deliver a single language is not decidable from the artefact.',
		]);
	}

	// -- moment --
	if (r.moment && r.moment.bytes >= PRICE_MIN) {
		const m = r.moment;
		add('warn', 'moment', [
			`moment is on the static path: ${priced(m.bytes)}`
			+ `${m.withLocales ? ', in the build that carries every locale' : ''}.`,
			m.sites
				? `  Imported in ${plural(m.sites, 'file', 'files')} of ${r.src.label}.`
			: r.src.present
				? `  No file in ${r.src.label} imports moment, so it arrives through a dependency`
					+ `${m.wrapper ? `; ${m.wrapper.pkg} is delivered with it, ${num(m.wrapper.bytes)} B` : ''}.`
				: `  Which import pulls it in is not derivable without the source`
					+ `${m.wrapper ? `; ${m.wrapper.pkg} is delivered with it, ${num(m.wrapper.bytes)} B` : ''}.`,
			'Whatever formats dates here, moment is the largest way to do it: it ships its locale data'
			+ ' as one piece and tree-shakes away nothing. date-fns with the functions that are used,'
			+ ' or luxon, is a fraction of it.',
		]);
	}

	// -- date-fns locales --
	if (r.dateFns) {
		const d = r.dateFns;
		const bytes = d.static.reduce((n, x) => n + x.bytes, 0);
		const dyn = d.dynamic.reduce((n, x) => n + x.bytes, 0);
		if (d.static.length >= 2 && bytes >= PRICE_MIN) {
			add('warn', 'date-fns-locales', [
				`${plural(d.static.length, 'date-fns locale is', 'date-fns locales are')} bound statically: `
				+ `${priced(bytes)}`
				+ `${d.dynamic.length ? `, a further ${plural(d.dynamic.length, 'locale', 'locales')} `
					+ `(${num(dyn)} B) sit behind dynamic imports` : ''}.`,
				`  Largest: ${d.static.slice(0, 5).map((x) => `${x.locale} ${num(x.bytes)} B`).join(', ')}.`,
				'A session uses one locale. An import per locale under a dynamic specifier delivers that'
				+ ' one and leaves the rest in chunks the browser never fetches.',
			]);
		} else if (d.dynamic.length) {
			add('ok', 'date-fns-locales-dynamic', [
				`date-fns locales are behind dynamic imports: ${plural(d.dynamic.length, 'locale', 'locales')}, `
				+ `${num(dyn)} B the browser fetches only for the language it needs`
				+ `${d.static.length ? `, ${plural(d.static.length, 'locale', 'locales')} statically bound `
					+ `(${num(bytes)} B)` : ''}.`,
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
	if (!r.package) {
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
	p('counted but charged to no package.');
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
			p(`-- ${x.pkg}, ${num(x.bytes)} B delivered in ${plural(x.modules, 'module', 'modules')} --`);
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
		p('Charged through the source maps. "named in the source" means the name occurs in');
		p(`${r.src.label} at all, in an import or in a template; that is the widest reading, so`);
		p('a component listed as not named is one the source really never mentions.');
		p();
		const rows = cut(r.components.delivered, opt.top);
		p(table(
			['Component', 'Bytes', 'Share', 'Named in the source'],
			rows.rows.map((c) => [c.name, num(c.bytes), pct(b.raw ? c.bytes / b.raw : 0),
				r.components.named.includes(c.name) ? 'yes' : 'no']),
			['l', 'r', 'r', 'l'],
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

	if (b.present && b.packages.length) {
		p('== Where the payload comes from ==');
		p('The packages the static path is made of, charged through the source maps. This is');
		p('the whole payload of the app, not one page; bundle-report breaks it down per page.');
		p();
		const rows = cut(b.packages, opt.top);
		p(table(
			['Origin', 'Bytes', 'Share', 'Modules'],
			rows.rows.map((x) => [x.pkg, num(x.bytes), pct(x.share), num(x.modules)]),
			['l', 'r', 'r', 'r'],
		));
		if (rows.hidden) p(`... ${num(rows.hidden)} further origins not shown, use ${how('--details --top=0')}`);
		p();
	}

	return out.join('\n').replace(/\n+$/, '');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = audit(opt);
if (opt.json) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	const text = renderSummary(report, opt) + (opt.details ? renderDetails(report, opt) : '');
	process.stdout.write(`${text}\n`);
}
