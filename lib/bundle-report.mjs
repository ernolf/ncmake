#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// bundle-report - what the browser actually loads when a page opens.
//
// Takes a directory of built assets and, for every entry (a file that no other
// file in the directory imports, or only a chunk it loads itself), resolves the
// transitive closure of its *static* imports. That closure is what a browser
// fetches when the page opens; dynamic imports are reported separately and never
// counted into it.
// A split stylesheet has an import graph of its own, so the stylesheet named
// after an entry is resolved the same way and counted with it: the two together
// are the page. Where the build ships source maps, every delivered byte is
// charged back to the package and module it came from, so the report says not
// just how large the payload is but what it consists of.
//
// Reads only. No build, no node_modules, no network, no npm dependencies.
// Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';

import {
	SEP,
	attrOfFile,
	attrOfFiles,
	buildCssGraph,
	buildGraph,
	closure,
	cssNamedBy,
	heaviestPage,
	moduleList,
	packageList,
	sizes,
	sumSizes,
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
	dir: 'js',                 // built assets; the usual Nextcloud app layout
	css: null,                 // stylesheet directory, else derived from dir
	top: 12,                   // rows per origin and module table, 0 = all
	details: false,            // every table; the default is the verdict alone
	json: false,
	entries: [],               // restrict to these entries, empty = all
	modules: [],               // extra packages to break down, 'all' for every
};

// == Command line ==
function usage() {
	return `bundle-report - what the browser actually loads when a page opens

Usage: bundle-report.mjs [options] [dir]

  dir                   directory holding the built assets (default: ${defaults.dir})

Options:
  --css=DIR             stylesheet directory (default: <dir>/../css, else <dir>)
  --entry=NAME          report only this entry and its stylesheet, repeatable
  --modules=PKG         break this package down per module, repeatable;
                        --modules=all breaks down every package
  --top=N               rows per table, 0 for all (default: ${defaults.top})
  --details             print every table behind the findings
  --json                emit the full result as JSON and nothing else
  -h, --help            this text

The report reads the directory only. It never builds, installs or downloads.`;
}

function die(msg) {
	process.stderr.write(`bundle-report: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const opt = { ...defaults, entries: [], modules: [] };
	let dir = null;
	for (const arg of argv) {
		const eq = arg.indexOf('=');
		const key = eq === -1 ? arg : arg.slice(0, eq);
		const val = eq === -1 ? '' : arg.slice(eq + 1);
		switch (key) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--json': opt.json = true; break;
			case '--details': opt.details = true; break;
			case '--css': opt.css = val; break;
			case '--entry': opt.entries.push(val); break;
			case '--modules': opt.modules.push(val); break;
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

// == Report model ==
// A page is one JavaScript entry plus the stylesheet of the same name. That is
// the pairing a Nextcloud app makes in PHP with addScript and addStyle; the PHP
// is not part of the artefact, so the name is the evidence for it.
const stemOf = (f) => path.basename(f).replace(/\.[^.]+$/, '');

function resolveCssDir(dir, explicit) {
	if (explicit) {
		if (!fs.existsSync(explicit)) die(`not a directory: ${explicit}`);
		return explicit;
	}
	const sibling = path.join(path.dirname(path.resolve(dir)), 'css');
	if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) return sibling;
	return dir;
}

function analyse(opt) {
	const dir = opt.dir;
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`not a directory: ${dir}`);

	const g = buildGraph(dir);
	if (g.js.length === 0) die(`no JavaScript files in ${dir}`);

	const cssDir = resolveCssDir(dir, opt.css);
	const cg = buildCssGraph(cssDir);
	const maps = g.all.filter((f) => f.endsWith('.map'));

	let entries = g.entries;
	if (opt.entries.length) {
		const want = new Set(opt.entries.map((e) => e.replace(/^\.\//, '')));
		entries = g.js.filter((f) => want.has(f) || want.has(path.basename(f)));
		for (const w of want) {
			if (!entries.some((f) => f === w || path.basename(f) === w)) die(`no such file in ${dir}: ${w}`);
		}
	}

	const report = {
		tool: 'bundle-report',
		dir,
		cssDir,
		files: {
			js: g.js.length,
			jsBytes: g.js.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0),
			css: cg.all.length,
			cssBytes: cg.all.reduce((n, f) => n + fs.statSync(path.join(cssDir, f)).size, 0),
			maps: maps.length,
			mapBytes: maps.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0),
		},
		edges: g.edges,
		cssEdges: cg.edges,
		partial: opt.entries.length > 0,
		nonEsmFiles: g.nonEsm,
		entries: [],
		css: cg.all.map((f) => ({
			file: f,
			...sizes(path.join(cssDir, f)),
			entry: cg.entries.includes(f),
		})),
		unmapped: [],
	};

	// Which stylesheet imports which, so a stylesheet outside every page can say
	// why it is outside: nothing imports it, or only something no page loads.
	const cssImportedBy = new Map();
	for (const [from, g] of cg.graph) {
		for (const to of g.static) cssImportedBy.set(to, [...(cssImportedBy.get(to) ?? []), from]);
	}
	for (const c of report.css) c.importedBy = (cssImportedBy.get(c.file) ?? []).sort();

	const cssEntryByStem = new Map(cg.entries.map((f) => [stemOf(f), f]));

	for (const entry of entries) {
		const staticSet = closure(g.graph, entry, 'static');
		const staticFiles = [...staticSet].sort();
		const dynamicSet = new Set();
		for (const f of staticSet) {
			for (const d of g.graph.get(f).dynamic) {
				for (const t of closure(g.graph, d, 'static')) if (!staticSet.has(t)) dynamicSet.add(t);
			}
		}
		const dynamicFiles = [...dynamicSet].sort();
		const abs = (f) => path.join(dir, f);

		// The stylesheet of the same name, with everything it imports.
		const cssEntry = cssEntryByStem.get(stemOf(entry)) ?? null;
		const cssFiles = cssEntry ? [...closure(cg.graph, cssEntry, 'static')].sort() : [];
		const cabs = (f) => path.join(cssDir, f);

		const e = {
			entry,
			static: {
				count: staticFiles.length,
				...sumSizes(staticFiles.map(abs)),
				files: staticFiles.map((f) => ({ file: f, ...sizes(abs(f)) })).sort((a, b) => b.raw - a.raw),
			},
			styles: {
				entry: cssEntry,
				count: cssFiles.length,
				...sumSizes(cssFiles.map(cabs)),
				files: cssFiles.map((f) => ({ file: f, ...sizes(cabs(f)) })).sort((a, b) => b.raw - a.raw),
			},
			dynamic: {
				count: dynamicFiles.length,
				...sumSizes(dynamicFiles.map(abs)),
				files: dynamicFiles.map((f) => ({ file: f, ...sizes(abs(f)) })).sort((a, b) => b.raw - a.raw),
			},
			origins: null,
		};
		e.page = {
			count: e.static.count + e.styles.count,
			raw: e.static.raw + e.styles.raw,
			gzip: e.static.gzip + e.styles.gzip,
		};

		// Attribution over the whole static closure of this entry. Stylesheets
		// carry no source map, so only the JavaScript can be charged back.
		const at = attrOfFiles(dir, staticFiles);
		for (const f of staticFiles) {
			if (!attrOfFile(dir, f).mapped && !report.unmapped.includes(f)) report.unmapped.push(f);
		}
		e.origins = {
			mappedFiles: at.mapped,
			unmappedFiles: staticFiles.length - at.mapped,
			attributed: at.attributed,
			remainder: at.remainder,
			packages: packageList(at, e.static.raw),
			modules: moduleList(at),
		};

		// A module that lives in more than one file of this closure is delivered
		// more than once; everything beyond its largest copy is paid twice.
		const dup = new Map();
		for (const [key, where] of at.perFile) {
			if (where.length < 2) continue;
			const total = where.reduce((n, w) => n + w.bytes, 0);
			const waste = total - Math.max(...where.map((w) => w.bytes));
			if (waste <= 0) continue;
			const pkg = key.slice(0, key.indexOf(SEP));
			dup.set(pkg, (dup.get(pkg) ?? 0) + waste);
		}
		e.duplicated = {
			bytes: [...dup.values()].reduce((n, b) => n + b, 0),
			packages: [...dup.entries()]
				.map(([pkg, bytes]) => ({ pkg, bytes }))
				.sort((a, b) => b.bytes - a.bytes),
		};
		report.entries.push(e);
	}

	// A stylesheet outside every page may still be loaded: a stylesheet that is an
	// entry of its own - a CSS-only entry of the build, or one the app adds from PHP
	// with addStyle - by whatever names it, and a chunk's stylesheet by the runtime
	// of a script some page loads. Only a bundler chunk that nothing loads is left
	// of an earlier build.
	const inPage = new Set(report.entries.flatMap((e) => e.styles.files.map((x) => x.file)));
	const scripts = new Set(report.entries.flatMap((e) => [...e.static.files, ...e.dynamic.files].map((x) => x.file)));
	const named = cssNamedBy(dir, [...scripts], cg.all);
	const via = new Map();
	const reachedFrom = (files, by) => {
		for (const c of files) {
			if (inPage.has(c)) continue;
			for (const f of closure(cg.graph, c, 'static')) if (!inPage.has(f) && !via.has(f)) via.set(f, by);
		}
	};
	reachedFrom(report.css.filter((c) => c.entry && !RE_CHUNK.test(c.file)).map((c) => c.file), 'entry');
	reachedFrom([...named.keys()], 'script');
	for (const c of report.css) c.loadedBy = via.get(c.file) ?? null;

	report.entries.sort((a, b) => b.page.raw - a.page.raw);
	report.shared = sharedModel(report, dir, cssDir);
	report.findings = findings(report, dir);
	return report;
}

// How often each file is loaded, over both directories. A file is counted once,
// however many pages load it.
function loadCounts(r) {
	const count = new Map();
	for (const e of r.entries) {
		for (const f of [...e.static.files, ...e.styles.files]) {
			count.set(f.file, (count.get(f.file) ?? 0) + 1);
		}
	}
	return count;
}

// Split the build into the part every page loads, the part more than one page
// loads and the part a single page loads.
function sharedModel(r, dir, cssDir) {
	const n = r.entries.length;
	const kind = new Map();
	for (const e of r.entries) {
		for (const f of e.static.files) kind.set(f.file, 'js');
		for (const f of e.styles.files) kind.set(f.file, 'css');
	}
	const count = loadCounts(r);
	const group = (test) => {
		const files = [...count].filter(([, c]) => test(c)).map(([f]) => f).sort();
		const at = (f) => path.join(kind.get(f) === 'css' ? cssDir : dir, f);
		return {
			count: files.length,
			files,
			js: files.filter((f) => kind.get(f) === 'js'),
			...sumSizes(files.map(at)),
		};
	};
	return {
		entries: n,
		built: group(() => true),
		common: group((c) => n > 1 && c === n),
		someEntries: group((c) => c > 1 && c < n),
		shared: group((c) => c > 1),
		pageSpecific: group((c) => c === 1),
	};
}

// == Findings ==
// A finding may only state what follows from the artefact. Where the artefact
// cannot decide a question, the finding says so instead of guessing.
const HINTS = new Map([
	['vite-plugin-node-polyfills', 'Node APIs polyfilled into a browser bundle.'],
	['core-js', 'polyfills for browsers older than the build targets.'],
	['moment', 'carries its locale data; luxon and date-fns are a fraction of it.'],
	['lodash', 'the full build; lodash-es with named imports ships only what is used.'],
	['@babel/runtime', 'transpiler helpers, one copy per build target.'],
]);
const RE_BARREL = /^(?:dist\/|src\/|es\/|lib\/)?index\.(?:m?js|vue)$/;
const RE_CHUNK = /\.chunk\.(?:m?js|css)$/;
const HINT_MIN = 4096;     // below this a hint is noise next to a 500 kB bundle
// A package's root module is its entry stub in most packages, a few hundred
// bytes that say nothing. Only a root that carries real code means the package
// arrived as a whole, and only a package that has further modules has anything
// the bundler could have dropped.
const BARREL_MIN = 4096;
// ... and a package of a handful of modules whose root holds most of the code is
// simply a small package, not a barrel that was pulled in whole.
const BARREL_MODULES_MIN = 8;
function findings(r, dir) {
	const out = [];
	const add = (level, id, lines) => out.push({ level, id, lines });
	const n = r.entries.length;
	const s = r.shared;
	const smallest = r.entries[r.entries.length - 1];
	// A package is priced on the page that loads the most of it, its dynamic
	// imports included: that is an amount a browser really fetches.
	const loads = r.entries.map((e) => {
		const files = [...e.static.files, ...e.dynamic.files];
		const at = attrOfFiles(dir, files.map((f) => f.file));
		return {
			entry: e.entry,
			packages: packageList(at, files.reduce((t, f) => t + f.raw, 0)),
			modules: moduleList(at),
		};
	});
	const packages = heaviestPage(loads.flatMap((l) => l.packages.map((x) => ({ ...x, page: l.entry }))), 'pkg');
	const modulesOf = (x) => loads.find((l) => l.entry === x.page).modules.filter((m) => m.pkg === x.pkg);
	const moduleCount = new Set(loads.flatMap((l) => l.modules.map((m) => m.pkg + SEP + m.module))).size;

	// -- what every page loads, needed or not --
	if (n > 1 && s.common.count) {
		const share = s.common.raw / smallest.page.raw;
		const heavy = packageList(attrOfFiles(dir, s.common.js), s.common.raw).slice(0, 5);
		const sizeOf = (f) => (s.common.js.includes(f) ? sizes(path.join(dir, f)) : sizes(path.join(r.cssDir, f)));
		const shown = [...s.common.files].sort((a, b) => sizeOf(b).raw - sizeOf(a).raw).slice(0, 4);
		const more = s.common.count > shown.length ? `, and ${num(s.common.count - shown.length)} more` : '';
		const body = [
			`  Files: ${shown.map((f) => `${f} ${num(sizeOf(f).raw)} B`).join(', ')}${more}.`,
			...(heavy.length ? [`  Inside: ${heavy.map((x) => `${x.pkg} ${num(x.bytes)} B`).join(', ')}.`] : []),
		];
		const headline = `All ${n} pages load the same ${plural(s.common.count, 'file', 'files')}: `
			+ `${num(s.common.raw)} B raw, ${num(s.common.gzip)} B gzip, ${pct(share)} of the smallest page `
			+ `(${stemOf(smallest.entry)}, ${num(smallest.page.raw)} B).`;
		if (share >= 0.5) {
			add('warn', 'split-not-effective', [
				headline,
				...body,
				'A page has loaded all of this before it delivers anything of its own. What makes it'
				+ ' smaller is moving a package behind a dynamic import, or into the single page that'
				+ ' uses it. Which of these bytes a given page really needs does not follow from the'
				+ ' build output.',
			]);
		} else {
			add('ok', 'split-effective', [headline, ...body]);
		}
	}

	// -- package roots in the bundle --
	const barrels = packages
		.filter((x) => x.modules >= BARREL_MODULES_MIN)
		.map((x) => ({ ...x, barrel: modulesOf(x).find((m) => RE_BARREL.test(m.module)) }))
		.filter((x) => x.barrel && x.barrel.bytes >= BARREL_MIN);
	if (!packages.length) {
		// Nothing is attributed, so nothing can be said about where the bytes come from.
	} else if (barrels.length) {
		add('warn', 'package-root-imported', [
			'A package root carries code, so the package is imported as a whole:',
			...barrels.map((x) => `  ${x.pkg}: ${num(x.bytes)} B in ${plural(x.modules, 'module', 'modules')} `
				+ `on the ${stemOf(x.page)} page, of which its root ${x.barrel.module} is ${num(x.barrel.bytes)} B.`),
			'Importing the single module that is used instead of the package root lets the bundler'
			+ ' drop the rest of the barrel.',
		]);
	} else {
		add('ok', 'no-package-root-imported', [
			'No package is imported as a whole: every package contributes only the modules that are'
			+ ` used (${plural(packages.length, 'package', 'packages')}, `
			+ `${plural(moduleCount, 'module', 'modules')}).`,
			'On this measure the form of importing is exhausted. A root import whose barrel the'
			+ ' bundler removes completely leaves no trace, so this is evidence, not proof.',
		]);
	}

	// -- the same module delivered twice inside one page --
	const dupEntries = r.entries.filter((e) => e.duplicated.bytes > 0);
	if (dupEntries.length) {
		add('warn', 'duplicated-modules', [
			'A module is delivered more than once inside a single page:',
			...dupEntries.map((e) => `  ${stemOf(e.entry)}: ${num(e.duplicated.bytes)} B beyond the first copy, `
				+ `${e.duplicated.packages.slice(0, 3).map((x) => `${x.pkg} ${num(x.bytes)} B`).join(', ')}.`),
		]);
	} else {
		add('ok', 'no-duplicated-modules', ['No module is delivered twice inside one page.']);
	}

	// -- leftovers of an earlier build --
	// Only with every entry in hand: with a restricted entry set a file that no
	// reported page loads may well be loaded by one that was left out.
	const stale = r.partial ? null : [];
	const loaded = new Set(s.built.files);
	for (const e of stale ? r.entries : []) {
		if (RE_CHUNK.test(e.entry)) {
			stale.push({
				bytes: e.static.raw,
				line: `${e.entry}, ${num(e.static.raw)} B: a bundler chunk that no file in ${r.dir} imports, `
					+ 'so nothing in this build loads it.',
			});
		}
	}
	// A stylesheet directory no page of this build loads from is not the directory
	// this build writes: a Nextcloud app keeps hand-written stylesheets in css/ and
	// loads them from PHP with addStyle, where no entry is named after them. Only a
	// directory this build writes into can hold the remains of an earlier one.
	const ownCss = path.resolve(r.cssDir) !== path.resolve(r.dir)
		&& r.css.length > 0 && !r.css.some((c) => loaded.has(c.file) || c.loadedBy === 'script');
	for (const c of stale && !ownCss ? r.css : []) {
		if (loaded.has(c.file) || c.loadedBy) continue;
		let why;
		if (c.entry) {
			why = 'a bundler chunk that no stylesheet imports and no script of this build names, '
				+ 'so nothing loads it.';
		} else if (c.importedBy.length === 1) {
			why = `imported only by ${c.importedBy[0]}, which no page of this build loads.`;
		} else if (c.importedBy.length) {
			why = `imported only by ${c.importedBy.join(' and ')}, which no page of this build loads.`;
		} else {
			why = 'no stylesheet of this build imports it.';
		}
		stale.push({ bytes: c.raw, line: `${c.file}, ${num(c.raw)} B: ${why}` });
	}
	const where = ownCss || shortPath(r.cssDir) === r.dir
		? r.dir : `${r.dir} and ${shortPath(r.cssDir)}`;
	if (stale && stale.length) {
		add('warn', 'stale-files', [
			`${plural(stale.length, 'file belongs', 'files belong')} to no page of this build, `
				+ `${num(stale.reduce((t, x) => t + x.bytes, 0))} B in total:`,
			...stale.map((x) => `  ${x.line}`),
			'A build does not necessarily clear its output directory first, so these are the'
			+ ' remains of an earlier one. make dist-clean removes them.',
		]);
	} else if (stale) {
		add('ok', 'no-stale-files', [`No bundler chunk in ${where} is left without something that loads it.`]);
	}
	if (ownCss) {
		add('info', 'stylesheets-outside-the-build', [
			`${shortPath(r.cssDir)} holds ${plural(r.css.length, 'stylesheet', 'stylesheets')}, `
				+ `${num(r.files.cssBytes)} B, and no page of this build loads any of them: no entry in `
				+ `${r.dir} is named after one, and none is reached from an entry that is.`,
			'  Nothing this build produces refers to them, so they belong to the app rather than to this'
			+ ' build - loaded from PHP with addStyle - and they count against no page here. Where the'
			+ ' build writes its stylesheets somewhere else, --css=DIR names that directory.',
		]);
	}

	// -- packages whose presence is worth a look --
	for (const x of packages) {
		const hint = HINTS.get(x.pkg);
		if (hint && x.bytes >= HINT_MIN) {
			add('info', `hint:${x.pkg}`, [`${x.pkg}, ${num(x.bytes)} B on the ${stemOf(x.page)} page: ${hint}`]);
		}
	}

	// -- what the artefact cannot answer --
	if (r.unmapped.length) {
		add('info', 'unmapped', [
			`${plural(r.unmapped.length, 'delivered file carries', 'delivered files carry')} no source map, `
				+ 'so those bytes are counted but charged to no package.',
		]);
	}
	if (r.nonEsmFiles) {
		add('info', 'non-esm', [
			`${plural(r.nonEsmFiles, 'file looks', 'files look')} like a webpack or CommonJS bundle. Their`
			+ ' internal structure is not derivable from the artefact, so each counts as one file.',
		]);
	}

	return sortFindings(out);
}

// == Human-readable output ==
// How to run this again with other options.
const how = howToRun('BUNDLE_REPORT_CMDLINE', 'bundle-report.mjs %s');

// How often a file is loaded, as a phrase for a table cell. Inside a page's own
// table a single page is this one; in a list that is not about one page it is not.
function loadedByLabel(count, n, here) {
	if (n < 2) return '';
	if (count >= n) return `all ${num(n)} pages`;
	if (count === 1) return here ? 'this page only' : 'one page only';
	return `${num(count)} of ${num(n)} pages`;
}

// The default output: the figures that decide something, then the findings.
function renderSummary(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);
	const s = r.shared;
	const shareOf = (x) => pct(s.built.raw ? x / s.built.raw : 0);

	p(`bundle-report  ${path.resolve(r.dir)}`
		+ (path.resolve(r.cssDir) === path.resolve(r.dir) ? '' : ` and ${path.resolve(r.cssDir)}`));
	p(`  ${plural(s.entries, 'page', 'pages')}, ${num(s.built.raw)} B raw and ${num(s.built.gzip)} B gzip `
		+ `in ${plural(s.built.count, 'file', 'files')}.`);
	p();

	p(table(
		['Page', 'Files', 'Raw B', 'gzip -9 B'],
		r.entries.map((e) => [stemOf(e.entry), num(e.page.count), num(e.page.raw), num(e.page.gzip)]),
		['l', 'r', 'r', 'r'],
	));
	p();

	if (s.entries > 1) {
		const row = (label, g) => [label, num(g.count), num(g.raw), num(g.gzip), shareOf(g.raw)];
		p(table(
			['Loaded by', 'Files', 'Raw B', 'gzip -9 B', 'Share'],
			[
				row(`all ${s.entries} pages`, s.common),
				...(s.someEntries.count ? [row('some pages', s.someEntries)] : []),
				row('one page only', s.pageSpecific),
			],
			['l', 'r', 'r', 'r', 'r'],
		));
		p();
	}

	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('Unit: bytes. Every file is compressed on its own, because every file is its own');
	p('HTTP response; gzip -9 is zlib, what a web server sends. Lower is better.');
	p('A page is one entry (a file that no other file imports, or only a chunk it loads');
	p('itself) plus the stylesheet of the same name and everything that stylesheet');
	p('imports. A package figure in a finding is that of the page that loads the most');
	p('of it, dynamic imports included.');
	p();
	p(`All tables: ${how('--details')}`);
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

function renderDetails(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);
	const n = r.entries.length;
	const count = loadCounts(r);
	const onPage = (f) => loadedByLabel(count.get(f) ?? 0, n, true);
	const label = (f) => loadedByLabel(count.get(f) ?? 0, n, false);

	p();
	p('== The build ==');
	p(`${num(r.files.js)} JS files, ${num(r.files.jsBytes)} B`
		+ `   ${num(r.files.css)} CSS files, ${num(r.files.cssBytes)} B`
		+ `   ${num(r.files.maps)} source maps, ${num(r.files.mapBytes)} B (never requested by a browser)`);
	p(`${num(r.edges)} import edges between the JavaScript files, ${num(r.cssEdges)} between the stylesheets.`);
	p();

	for (const e of r.entries) {
		p(`== ${stemOf(e.entry)} ==`);
		p(`${plural(e.page.count, 'file', 'files')}, ${num(e.page.raw)} B raw, ${num(e.page.gzip)} B gzip -9, `
			+ 'fetched when the page opens.');
		p();
		const files = [...e.static.files, ...e.styles.files];
		const fc = cut(files, opt.top);
		p(table(
			['File', 'Raw B', 'gzip -9 B', 'Loaded by'],
			fc.rows.map((f) => [f.file, num(f.raw), num(f.gzip), onPage(f.file)]),
			['l', 'r', 'r', 'l'],
		));
		if (fc.hidden) p(`... ${num(fc.hidden)} further files not shown, use ${how('--details --top=0')}`);
		p();
		if (!e.styles.entry) {
			p(`No stylesheet named ${stemOf(e.entry)} in ${shortPath(r.cssDir)}, so this page has no CSS`);
			p('of its own in this build.');
			p();
		}
		if (e.dynamic.count) {
			p(`Dynamic imports reachable from this page: ${plural(e.dynamic.count, 'file', 'files')}, `
				+ `${num(e.dynamic.raw)} B raw, ${num(e.dynamic.gzip)} B gzip -9. Not part of the figures`);
			p('above: the browser fetches these only when the code that needs them runs.');
			p();
			const dc = cut(e.dynamic.files, opt.top);
			p(table(
				['Dynamic chunk', 'Raw B', 'gzip -9 B'],
				dc.rows.map((f) => [f.file, num(f.raw), num(f.gzip)]),
				['l', 'r', 'r'],
			));
			if (dc.hidden) p(`... ${num(dc.hidden)} further chunks not shown, use ${how('--details --top=0')}`);
			p();
		} else {
			p('No dynamic imports: everything this page can reach it also loads.');
			p();
		}
	}

	// Attribution is per file, not per page: a file carries the same bytes
	// whichever page loads it, so listing it once says it once.
	const jsFiles = [...new Set(r.entries.flatMap((e) => e.static.files.map((f) => f.file)))]
		.sort((a, b) => sizes(path.join(r.dir, b)).raw - sizes(path.join(r.dir, a)).raw);
	if (jsFiles.length) {
		p('== Where the bytes come from ==');
		p('Per file, because a file carries the same bytes whichever page loads it. Charged');
		p('to their source through the source map. "not attributable" is what no mapping');
		p("covers: the bundler's own glue, data and code it inlined without a mapping, line");
		p('breaks, license banners and the sourceMappingURL comment. Stylesheets carry no');
		p('source map and are not listed.');
		p();
	}
	for (const f of jsFiles) {
		const raw = sizes(path.join(r.dir, f)).raw;
		const lab = label(f);
		p(`-- ${f}, ${num(raw)} B${lab ? `, ${lab}` : ''} --`);
		const a = attrOfFiles(r.dir, [f]);
		if (!a.mapped) {
			p('No source map next to this file, so its bytes cannot be charged to a package.');
			p();
			continue;
		}
		const packages = packageList(a, raw);
		const pc = cut(packages, opt.top);
		p(table(
			['Origin', 'Bytes', 'Share', 'Modules'],
			[
				...pc.rows.map((x) => [x.pkg, num(x.bytes), pct(x.share), num(x.modules)]),
				['not attributable', num(a.remainder), pct(a.remainder / raw), ''],
			],
			['l', 'r', 'r', 'r'],
		));
		if (pc.hidden) p(`... ${num(pc.hidden)} further origins not shown, use ${how('--details --top=0')}`);
		p(`${num(a.attributed)} + ${num(a.remainder)} = ${num(raw)} B, the size of the file.`);
		p();

		const modules = moduleList(a);
		const want = new Set(opt.modules);
		const breakdown = want.has('all')
			? packages.map((x) => x.pkg)
			: [...new Set([packages[0]?.pkg, 'app source', ...opt.modules].filter(Boolean))]
				.filter((pkg) => packages.some((x) => x.pkg === pkg));
		for (const pkg of breakdown) {
			const rows = modules.filter((m) => m.pkg === pkg);
			if (!rows.length) continue;
			const mc = cut(rows, opt.top);
			p(`Modules of ${pkg}: ${plural(rows.length, 'module', 'modules')}, `
				+ `${num(rows.reduce((t, m) => t + m.bytes, 0))} B`);
			p();
			p(table(
				['Module', 'Bytes', 'Share of file'],
				mc.rows.map((m) => [m.module, num(m.bytes), pct(m.bytes / raw)]),
				['l', 'r', 'r'],
			));
			if (mc.hidden) p(`... ${num(mc.hidden)} further modules not shown, use ${how('--details --top=0')}`);
			p();
		}
	}

	const orphans = r.css.filter((c) => !r.shared.built.files.includes(c.file));
	if (orphans.length) {
		p('== Stylesheets no page loads ==');
		p();
		const loadedBy = { entry: 'a stylesheet entry of its own', script: 'a script naming it' };
		p(table(
			['Stylesheet', 'Raw B', 'gzip -9 B', 'Loaded through'],
			orphans.sort((a, b) => b.raw - a.raw).map((f) => [f.file, num(f.raw), num(f.gzip),
				loadedBy[f.loadedBy] ?? 'nothing']),
			['l', 'r', 'r', 'l'],
		));
		p();
	}

	if (r.unmapped.length) {
		p(`${plural(r.unmapped.length, 'delivered file carries', 'delivered files carry')} no source map:`);
		for (const f of r.unmapped.slice(0, 10)) p(`  ${f}`);
		if (r.unmapped.length > 10) p(`  ... ${num(r.unmapped.length - 10)} more`);
		p();
	}

	return out.join('\n').replace(/\n+$/, '');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = analyse(opt);
if (opt.json) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	const text = renderSummary(report, opt) + (opt.details ? renderDetails(report, opt) : '');
	process.stdout.write(`${text}\n`);
}
