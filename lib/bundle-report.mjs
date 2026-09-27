#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// bundle-report - what the browser actually loads when a page opens.
//
// Takes a directory of built assets and, for every entry (a file that no other
// file in the directory imports), resolves the transitive closure of its
// *static* imports. That closure is what a browser fetches when the page
// opens; dynamic imports are reported separately and never counted into it.
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
import zlib from 'node:zlib';

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

const JS_EXT = new Set(['.mjs', '.js', '.cjs']);

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

// == Sizes ==
// Each asset is its own HTTP response, so a closure's transfer size is the sum
// of the individually compressed files, never the compression of their
// concatenation. Compression is cached per file; most files are never asked for.
const sizeCache = new Map();

function sizes(file) {
	let e = sizeCache.get(file);
	if (!e) {
		const buf = fs.readFileSync(file);
		e = { raw: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length };
		sizeCache.set(file, e);
	}
	return e;
}

function sumSizes(files) {
	const t = { raw: 0, gzip: 0 };
	for (const f of files) {
		const s = sizes(f);
		t.raw += s.raw;
		t.gzip += s.gzip;
	}
	return t;
}

// == Module graph ==
// Minified ESM output is matched textually rather than parsed. A specifier only
// becomes an edge when it resolves to a file that is actually present, so a
// string literal that happens to look like an import cannot invent one.
const RE_STATIC = /(?:^|[^.\w$])(?:import|from)\s*(["'])([^"'\n]+)\1/g;
const RE_DYNAMIC = /(?:^|[^.\w$])import\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const RE_NON_ESM = /webpackChunk|__webpack_require__|\bdefine\(\s*\[|exports\.__esModule/;

function listFiles(dir) {
	const out = [];
	const walk = (rel) => {
		for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(r);
			else if (e.isFile()) out.push(r);
		}
	};
	walk('');
	return out.sort();
}

function buildGraph(dir) {
	const all = listFiles(dir);
	const js = all.filter((f) => JS_EXT.has(path.extname(f)));
	const present = new Set(js);
	const graph = new Map();
	let nonEsm = 0;

	for (const f of js) {
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		const stat = new Set();
		const dyn = new Set();
		const external = new Set();
		const base = path.posix.dirname(f);

		const collect = (re, into) => {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(text)) !== null) {
				const spec = m[2];
				if (!spec.startsWith('./') && !spec.startsWith('../')) {
					external.add(spec);
					continue;
				}
				const target = path.posix.normalize(path.posix.join(base, spec));
				if (present.has(target)) into.add(target);
			}
		};
		collect(RE_DYNAMIC, dyn);
		collect(RE_STATIC, stat);
		// A dynamic specifier also matches the static pattern through its
		// "import" keyword, so the dynamic set wins for an edge in both.
		for (const d of dyn) stat.delete(d);

		if (stat.size === 0 && dyn.size === 0 && RE_NON_ESM.test(text)) nonEsm++;
		graph.set(f, {
			static: [...stat].sort(),
			dynamic: [...dyn].sort(),
			external: [...external].sort(),
		});
	}

	const imported = new Set();
	for (const { static: s, dynamic: d } of graph.values()) {
		for (const t of s) imported.add(t);
		for (const t of d) imported.add(t);
	}
	const entries = js.filter((f) => !imported.has(f));
	const edges = [...graph.values()].reduce((n, g) => n + g.static.length + g.dynamic.length, 0);

	return { all, js, graph, entries, edges, nonEsm };
}

function closure(graph, start, kind) {
	const seen = new Set([start]);
	const queue = [start];
	while (queue.length) {
		const cur = queue.shift();
		for (const next of graph.get(cur)?.[kind] ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	return seen;
}

// == Source map attribution ==
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Map([...B64].map((c, i) => [c, i]));

// Decode one comma-separated segment into its signed VLQ fields.
function decodeSegment(seg) {
	const out = [];
	let shift = 0;
	let value = 0;
	for (const ch of seg) {
		const digit = B64I.get(ch);
		if (digit === undefined) return null;
		value += (digit & 31) << shift;
		if (digit & 32) {
			shift += 5;
			continue;
		}
		out.push(value & 1 ? -(value >> 1) : value >> 1);
		shift = 0;
		value = 0;
	}
	return out;
}

function findMap(dir, file) {
	const full = path.join(dir, file);
	const tail = fs.readFileSync(full, 'utf8').slice(-2048);
	const m = /\/\/#\s*sourceMappingURL=([^\s'"]+)/.exec(tail);
	const candidates = [];
	if (m && !m[1].startsWith('data:')) {
		candidates.push(path.join(path.dirname(full), decodeURIComponent(m[1])));
	}
	candidates.push(`${full}.map`);
	for (const c of candidates) if (fs.existsSync(c)) return c;
	return null;
}

// Charge every byte of a generated file to a source. Each mapped segment owns
// the span from its own column up to the next segment's column, the rest of the
// line after the last segment included. Everything the map does not cover -
// bytes before the first segment, unmapped lines, line breaks, the license
// banner and the sourceMappingURL comment - is kept as one explicit remainder
// instead of being spread over the sources. Attributed plus remainder is the
// file size exactly, which is what makes the result checkable.
function attribute(jsFile, mapFile) {
	const buf = fs.readFileSync(jsFile);
	const text = buf.toString('utf8');
	const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
	const lines = text.split('\n');
	const mapLines = String(map.mappings ?? '').split(';');
	const perSource = new Map();
	let remainder = lines.length - 1; // one byte per '\n'; a '\r' stays in its line
	let srcIdx = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const raw = mapLines[i] ?? '';
		if (raw === '') {
			remainder += Buffer.byteLength(line);
			continue;
		}

		const segs = [];
		let genCol = 0;
		for (const part of raw.split(',')) {
			if (part === '') continue;
			const f = decodeSegment(part);
			if (f === null || f.length === 0) continue;
			genCol += f[0];
			if (f.length >= 4) {
				srcIdx += f[1];
				segs.push([genCol, srcIdx]);
			} else {
				segs.push([genCol, -1]);
			}
		}
		if (segs.length === 0) {
			remainder += Buffer.byteLength(line);
			continue;
		}

		remainder += Buffer.byteLength(line.slice(0, Math.min(segs[0][0], line.length)));
		for (let k = 0; k < segs.length; k++) {
			const a = Math.min(segs[k][0], line.length);
			const b = k + 1 < segs.length ? Math.min(segs[k + 1][0], line.length) : line.length;
			if (b <= a) continue;
			const bytes = Buffer.byteLength(line.slice(a, b));
			const key = segs[k][1];
			if (key < 0) {
				remainder += bytes;
				continue;
			}
			perSource.set(key, (perSource.get(key) ?? 0) + bytes);
		}
	}

	const sources = map.sources ?? [];
	const out = new Map();
	for (const [idx, bytes] of perSource) {
		const name = sources[idx] ?? `<source ${idx}>`;
		out.set(name, (out.get(name) ?? 0) + bytes);
	}
	return { total: buf.length, remainder, sources: out };
}

// Split a source path into the package it belongs to and the path within it.
function originOf(src) {
	const clean = src.split('?')[0].replace(/^\0/, '');
	const at = clean.lastIndexOf('node_modules/');
	if (at !== -1) {
		const rest = clean.slice(at + 'node_modules/'.length);
		const parts = rest.split('/');
		const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
		return { pkg, rel: rest.slice(pkg.length + 1) || parts[parts.length - 1] };
	}
	if (/^(?:virtual:|plugin-vue:|vite\/|commonjs-)/.test(clean) || clean.includes('\u0000')) {
		return { pkg: 'generated by the bundler', rel: clean };
	}
	return { pkg: 'app source', rel: clean.replace(/^(?:\.\.\/)+/, '') };
}

// == Attribution cache ==
// The findings charge several different sets of files to their packages - one
// entry's closure, the files every entry loads, the whole build - so each
// delivered file is decoded exactly once and summed as often as needed. The key
// of a module is package and path joined by NUL: a package name can contain a
// space ("generated by the bundler") and so can a source path.
const SEP = '\u0000';
const attrCache = new Map();

function attrOfFile(dir, file) {
	let e = attrCache.get(file);
	if (!e) {
		const full = path.join(dir, file);
		const mapFile = findMap(dir, file);
		if (!mapFile) {
			e = { mapped: false, remainder: sizes(full).raw, modules: new Map() };
		} else {
			const a = attribute(full, mapFile);
			const modules = new Map();
			for (const [src, bytes] of a.sources) {
				const { pkg, rel } = originOf(src);
				const key = pkg + SEP + rel;
				modules.set(key, (modules.get(key) ?? 0) + bytes);
			}
			e = { mapped: true, remainder: a.remainder, modules };
		}
		attrCache.set(file, e);
	}
	return e;
}

// Sum the attribution of a set of files. perFile keeps which files a module
// appears in, which is what makes duplication inside one closure visible.
function attrOfFiles(dir, files) {
	const perPkg = new Map();
	const perModule = new Map();
	const perFile = new Map();
	let attributed = 0;
	let remainder = 0;
	let mapped = 0;
	for (const f of files) {
		const a = attrOfFile(dir, f);
		remainder += a.remainder;
		if (a.mapped) mapped++;
		for (const [key, bytes] of a.modules) {
			const pkg = key.slice(0, key.indexOf(SEP));
			attributed += bytes;
			perPkg.set(pkg, (perPkg.get(pkg) ?? 0) + bytes);
			perModule.set(key, (perModule.get(key) ?? 0) + bytes);
			if (!perFile.has(key)) perFile.set(key, []);
			perFile.get(key).push({ file: f, bytes });
		}
	}
	return { mapped, attributed, remainder, perPkg, perModule, perFile };
}

function packageList(at, total) {
	const count = new Map();
	for (const key of at.perModule.keys()) {
		const pkg = key.slice(0, key.indexOf(SEP));
		count.set(pkg, (count.get(pkg) ?? 0) + 1);
	}
	return [...at.perPkg.entries()]
		.map(([pkg, bytes]) => ({ pkg, bytes, share: total ? bytes / total : 0, modules: count.get(pkg) ?? 0 }))
		.sort((a, b) => b.bytes - a.bytes);
}

function moduleList(at) {
	return [...at.perModule.entries()]
		.map(([key, bytes]) => {
			const i = key.indexOf(SEP);
			return { pkg: key.slice(0, i), module: key.slice(i + 1), bytes };
		})
		.sort((a, b) => b.bytes - a.bytes);
}

// == Stylesheet graph ==
// CSS has an import mechanism of its own, and a bundler that splits stylesheets
// emits one file per page that holds nothing but @import lines pointing at the
// chunks. The browser follows them, so the closure of a stylesheet is what the
// page loads, exactly as for JavaScript.
const RE_CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"')]+)["']/g;

function buildCssGraph(dir) {
	const all = listFiles(dir).filter((f) => f.endsWith('.css'));
	const present = new Set(all);
	const graph = new Map();
	let edges = 0;

	for (const f of all) {
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		const base = path.posix.dirname(f);
		const deps = new Set();
		RE_CSS_IMPORT.lastIndex = 0;
		let m;
		while ((m = RE_CSS_IMPORT.exec(text)) !== null) {
			const target = path.posix.normalize(path.posix.join(base, m[1]));
			if (present.has(target)) deps.add(target);
		}
		edges += deps.size;
		graph.set(f, { static: [...deps].sort(), dynamic: [] });
	}

	const imported = new Set();
	for (const g of graph.values()) for (const t of g.static) imported.add(t);
	return { all, graph, entries: all.filter((f) => !imported.has(f)), edges };
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

// The stylesheet directory is resolved to an absolute path; in one sentence with
// a relative "js" that reads wrong, so name it the way it was given.
function shortPath(p) {
	const rel = path.relative(process.cwd(), p);
	return !rel || rel.startsWith('..') ? p : rel;
}

function findings(r, dir) {
	const out = [];
	const add = (level, id, lines) => out.push({ level, id, lines });
	const n = r.entries.length;
	const s = r.shared;
	const smallest = r.entries[r.entries.length - 1];
	const jsRaw = s.built.js.reduce((t, f) => t + sizes(path.join(dir, f)).raw, 0);
	const at = attrOfFiles(dir, s.built.js);
	const packages = packageList(at, jsRaw);
	const modules = moduleList(at);

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
		.map((x) => ({ ...x, barrel: modules.find((m) => m.pkg === x.pkg && RE_BARREL.test(m.module)) }))
		.filter((x) => x.barrel && x.barrel.bytes >= BARREL_MIN);
	if (!packages.length) {
		// Nothing is attributed, so nothing can be said about where the bytes come from.
	} else if (barrels.length) {
		add('warn', 'package-root-imported', [
			'A package root carries code, so the package is imported as a whole:',
			...barrels.map((x) => `  ${x.pkg}: ${num(x.bytes)} B in ${plural(x.modules, 'module', 'modules')}, `
				+ `of which its root ${x.barrel.module} is ${num(x.barrel.bytes)} B.`),
			'Importing the single module that is used instead of the package root lets the bundler'
			+ ' drop the rest of the barrel.',
		]);
	} else {
		add('ok', 'no-package-root-imported', [
			'No package is imported as a whole: every package contributes only the modules that are'
			+ ` used (${plural(packages.length, 'package', 'packages')}, `
			+ `${plural(modules.length, 'module', 'modules')}).`,
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
	for (const c of stale ? r.css : []) {
		if (loaded.has(c.file)) continue;
		let why;
		if (c.entry) {
			why = `no entry in ${r.dir} is named ${stemOf(c.file)}, so no page of this build loads it.`;
		} else if (c.importedBy.length === 1) {
			why = `imported only by ${c.importedBy[0]}, which no page of this build loads.`;
		} else if (c.importedBy.length) {
			why = `imported only by ${c.importedBy.join(' and ')}, which no page of this build loads.`;
		} else {
			why = 'no stylesheet of this build imports it.';
		}
		stale.push({ bytes: c.raw, line: `${c.file}, ${num(c.raw)} B: ${why}` });
	}
	const where = shortPath(r.cssDir) === r.dir ? r.dir : `${r.dir} and ${shortPath(r.cssDir)}`;
	if (stale && stale.length) {
		add('warn', 'stale-files', [
			`${plural(stale.length, 'file belongs', 'files belong')} to no page of this build, `
				+ `${num(stale.reduce((t, x) => t + x.bytes, 0))} B in total:`,
			...stale.map((x) => `  ${x.line}`),
			'A build does not necessarily clear its output directory first, so these are the'
			+ ' remains of an earlier one. make dist-clean removes them.',
		]);
	} else if (stale) {
		add('ok', 'no-stale-files', [`Every file in ${where} is loaded by a page of this build.`]);
	}

	// -- packages whose presence is worth a look --
	for (const x of packages) {
		const hint = HINTS.get(x.pkg);
		if (hint && x.bytes >= HINT_MIN) add('info', `hint:${x.pkg}`, [`${x.pkg}, ${num(x.bytes)} B: ${hint}`]);
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

	const rank = { warn: 0, info: 1, ok: 2 };
	return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// == Human-readable output ==
const num = (n) => (n === null || n === undefined ? '' : n.toLocaleString('en-US'));
const pct = (x) => `${(x * 100).toFixed(1)} %`;
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

// How to run this again with other options. The caller passes its own command
// line as a template, so the hints name the command that was actually typed
// instead of the path of this script.
const CMDLINE = process.env.BUNDLE_REPORT_CMDLINE || 'bundle-report.mjs %s';
const how = (flags) => (CMDLINE.includes('%s') ? CMDLINE.replace('%s', flags) : `${CMDLINE} ${flags}`);

function table(head, rows, align) {
	const all = [head, ...rows];
	const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
	const line = (r) => r
		.map((c, i) => {
			const s = String(c ?? '');
			return align[i] === 'r' ? s.padStart(w[i]) : s.padEnd(w[i]);
		})
		.join('  ')
		.replace(/\s+$/, '');
	return [line(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join('\n');
}

function cut(rows, top) {
	if (top === 0 || rows.length <= top) return { rows, hidden: 0 };
	return { rows: rows.slice(0, top), hidden: rows.length - top };
}

const MARK = { warn: '[!] ', info: '[i] ', ok: '[ok]' };
const WRAP = 73;   // plus the seven columns the finding marker occupies

// Break a finding into terminal lines. Leading spaces mark a list item and are
// kept, indented by two more on the continuation lines, so an item stays one
// visual block.
function wrap(text, width) {
	const indent = /^ */.exec(text)[0];
	const hang = indent ? `${indent}  ` : '';
	const lines = [];
	let cur = indent;
	for (const word of text.trim().split(/\s+/)) {
		// A unit never starts a line: it stays with the figure it belongs to, even
		// when that takes the line one column past the width.
		const glued = /^B[.,:;)\]]*$/.test(word);
		if (!cur.trim()) cur += word;
		else if (glued || cur.length + 1 + word.length <= width) cur += ` ${word}`;
		else { lines.push(cur); cur = hang + word; }
	}
	if (cur.trim()) lines.push(cur);
	return lines;
}

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
	for (const f of r.findings) {
		const [first, ...rest] = f.lines;
		for (const [i, l] of wrap(first, WRAP).entries()) p(i === 0 ? `  ${MARK[f.level]} ${l}` : `       ${l}`);
		for (const l of rest) for (const w of wrap(l, WRAP)) p(`       ${w}`);
	}
	p();
	p('[!] worth changing   [i] worth knowing   [ok] nothing found');
	p('Unit: bytes. Every file is compressed on its own, because every file is its own');
	p('HTTP response; gzip -9 is zlib, what a web server sends. Lower is better.');
	p('A page is one entry (a file that no other file imports) plus the stylesheet of');
	p('the same name and everything that stylesheet imports.');
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
		p("covers: the bundler's own glue, line breaks, license banners and the");
		p('sourceMappingURL comment. Stylesheets carry no source map and are not listed.');
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
		p(table(
			['Stylesheet', 'Raw B', 'gzip -9 B'],
			orphans.sort((a, b) => b.raw - a.raw).map((f) => [f.file, num(f.raw), num(f.gzip)]),
			['l', 'r', 'r'],
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
