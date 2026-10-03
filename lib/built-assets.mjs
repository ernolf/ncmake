// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// built-assets - what a directory of built assets consists of.
//
// The measuring half of the ncmake analysers: the import graph of the built
// JavaScript and of the stylesheets, the transfer size of a set of files, and
// the attribution of every delivered byte to the package and the module it came
// from through the shipped source maps. Every analyser that prices a statement
// in bytes reads them from here, so all of them count the same way.
//
// Nothing here judges, formats or prints. Reads only: no build, no node_modules,
// no network, no npm dependencies. Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// == Sizes ==
// Each asset is its own HTTP response, so a closure's transfer size is the sum
// of the individually compressed files, never the compression of their
// concatenation. Compression is cached per file; most files are never asked for.
const sizeCache = new Map();

export function sizes(file) {
	let e = sizeCache.get(file);
	if (!e) {
		const buf = fs.readFileSync(file);
		e = { raw: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length };
		sizeCache.set(file, e);
	}
	return e;
}

export function sumSizes(files) {
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
// webpack and rspack load a chunk at runtime: __webpack_require__.e(id) fetches
// the file __webpack_require__.u(id) names below the public path, which a
// Nextcloud app sets to its js/ directory. .u is a sum of string literals, the
// id, a lookup {...}[id] or ({...})[id], and a named chunk ({...}[id]||id). A
// lookup holds a content hash, in the file name or in a query after it, and is
// keyed by every chunk id that runtime can load, including the ones only a
// variable names, such as a locale. Minified, the runtime object has any name, so an id only becomes an
// edge when the file it names is present.
const RE_CHUNK_URL = /\.u\s*=\s*(?:function\s*)?\(?\s*([\w$]+)\s*\)?\s*(?:=>|\{\s*return)/g;
const RE_URL_LITERAL = /\s*(?:"([^"\n]*)"|'([^'\n]*)')/y;
const RE_URL_ID = /\s*([\w$]+)(?![\w$.[(])/y;
const RE_URL_LOOKUP = /\s*\(?\s*\{([^{}]*)\}\s*\)?\s*\[\s*([\w$]+)\s*\]/y;
const RE_URL_NAMED = /\s*\(\s*\{([^{}]*)\}\s*\[\s*([\w$]+)\s*\]\s*\|\|\s*([\w$]+)\s*\)/y;
const RE_URL_PLUS = /\s*\+/y;
const RE_CHUNK_ENTRY = /(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([\w$-]+))\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)')/g;
const RE_CHUNK_LOAD = /[\w$]\.e\(\s*(?:"([^"\n]+)"|'([^'\n]+)'|(\d+))\s*\)/g;

// The parts of the sum after a .u head, read until no + follows. What comes after
// a ? or # is the query, which is no part of the file name; its lookup still names
// the ids. A sum without a literal or without the id in it names no chunk file.
function chunkUrl(text, from, param) {
	const parts = [];
	const ids = [];
	const at = (re, ok = () => true) => {
		re.lastIndex = from;
		const m = re.exec(text);
		if (!m || !ok(m)) return null;
		from = re.lastIndex;
		return m;
	};
	const table = (body) => {
		const map = new Map();
		for (const e of body.matchAll(RE_CHUNK_ENTRY)) map.set(e[1] ?? e[2] ?? e[3], e[4] ?? e[5]);
		ids.push(...map.keys());
		return map;
	};
	let query = false;
	do {
		let m;
		if ((m = at(RE_URL_LITERAL))) {
			const s = m[1] ?? m[2];
			const cut = s.search(/[?#]/);
			if (!query) parts.push({ lit: cut === -1 ? s : s.slice(0, cut) });
			if (cut !== -1) query = true;
		} else if ((m = at(RE_URL_NAMED, (x) => x[2] === param && x[3] === param))) {
			const map = table(m[1]);
			if (!query) parts.push({ named: map });
		} else if ((m = at(RE_URL_LOOKUP, (x) => x[2] === param))) {
			const map = table(m[1]);
			if (!query) parts.push({ lookup: map });
		} else if ((m = at(RE_URL_ID, (x) => x[1] === param))) {
			if (!query) parts.push({ id: true });
		} else {
			break;
		}
	} while (at(RE_URL_PLUS));
	if (!parts.some((p) => 'lit' in p) || !parts.some((p) => !('lit' in p))) return null;
	const name = (id) => {
		let s = '';
		for (const p of parts) {
			if ('lit' in p) s += p.lit;
			else if (p.id) s += id;
			else if (p.named) s += p.named.get(id) ?? id;
			else if (p.lookup.has(id)) s += p.lookup.get(id);
			else return null;
		}
		return s;
	};
	return { name, ids };
}
const JS_EXT = new Set(['.mjs', '.js', '.cjs']);

export function listFiles(dir) {
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

export function buildGraph(dir) {
	const all = listFiles(dir);
	const js = all.filter((f) => JS_EXT.has(path.extname(f)));
	const present = new Set(js);
	const graph = new Map();
	const urls = [];
	const loads = new Map();
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
		const ids = new Set();
		const id = (m) => m[1] ?? m[2] ?? m[3];
		let runtime = false;
		for (const m of text.matchAll(RE_CHUNK_URL)) {
			const url = chunkUrl(text, m.index + m[0].length, m[1]);
			if (!url) continue;
			runtime = true;
			urls.push(url.name);
			for (const k of url.ids) ids.add(k);
		}
		for (const m of text.matchAll(RE_CHUNK_LOAD)) ids.add(id(m));
		if (ids.size) loads.set(f, ids);
		graph.set(f, {
			static: [...stat].sort(),
			dynamic: [...dyn].sort(),
			external: [...external].sort(),
			runtime,
		});
	}

	// A lazily loaded chunk carries no runtime of its own and loads its chunks
	// through the one of the entry that loaded it, so every id is tried against
	// every runtime in the build.
	for (const [f, ids] of loads) {
		const node = graph.get(f);
		const dyn = new Set(node.dynamic);
		for (const id of ids) {
			for (const name of urls) {
				const file = name(id);
				const target = file === null ? null : path.posix.normalize(file);
				if (target !== f && present.has(target)) dyn.add(target);
			}
		}
		node.dynamic = [...dyn].sort();
	}

	// An entry is a file that nothing imports. A lazily loaded chunk may import
	// back into the entry that loaded it, though, and that back-edge must not turn
	// the entry into a chunk: a file that no entry reaches, that is no dynamic
	// import target and that reaches every file importing it is an entry as well.
	const importers = new Map();
	const lazy = new Set();
	for (const [f, { static: s, dynamic: d }] of graph) {
		for (const t of [...s, ...d]) importers.set(t, [...(importers.get(t) ?? []), f]);
		for (const t of d) lazy.add(t);
	}
	const reach = (f) => {
		const seen = new Set([f]);
		const queue = [f];
		while (queue.length) {
			const { static: s, dynamic: d } = graph.get(queue.shift());
			for (const t of [...s, ...d]) {
				if (!seen.has(t)) {
					seen.add(t);
					queue.push(t);
				}
			}
		}
		return seen;
	};
	const entries = js.filter((f) => !importers.has(f));
	const reached = new Set(entries.flatMap((f) => [...reach(f)]));
	const backEdged = js
		.filter((f) => !reached.has(f) && !lazy.has(f))
		.map((f) => ({ f, r: reach(f) }))
		.filter(({ f, r }) => importers.get(f).every((i) => r.has(i)))
		.sort((a, b) => b.r.size - a.r.size);
	for (const { f, r } of backEdged) {
		if (reached.has(f)) continue;
		entries.push(f);
		for (const t of r) reached.add(t);
	}
	entries.sort();
	const edges = [...graph.values()].reduce((n, g) => n + g.static.length + g.dynamic.length, 0);

	return { all, js, graph, entries, edges, nonEsm };
}

export function closure(graph, start, kind) {
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

// A bundler appends what has no source of its own - an inlined JSON module, the
// export list, the preload helper - behind the last segment of the module before
// it, so a long span is not taken on trust. The generated token at its start
// belongs to the segment's source; the rest only if its text occurs in that
// source, quotes swapped allowed for, since the minifier rewrites them.
const SPAN_CHECK = 256;
const PROBE = 32;
const RE_WORD = /[\w$\u0080-￿]+/y;
const RE_FLAGS = /[a-z]*/y;
// The characters after which a slash opens a regular expression, not a division.
const RE_REGEX_BEFORE = /^$|[(,=:[!&|?{};+\-*%<>~^]/;
const SWAP_QUOTES = { '"': "'", "'": '"' };

// The end of a string, template or regex literal opened at column a. One that
// does not close before b leaves the span whole: where it ends is not known.
function literalEnd(line, a, b, quote) {
	let depth = 0;
	let inClass = false;
	for (let i = a + 1; i < b; i++) {
		const ch = line[i];
		if (ch === '\\') {
			i++;
			continue;
		}
		if (depth) {
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
			continue;
		}
		if (quote === '`' && ch === '$' && line[i + 1] === '{') {
			depth = 1;
			i++;
			continue;
		}
		if (quote === '/') {
			if (inClass) {
				if (ch === ']') inClass = false;
				continue;
			}
			if (ch === '[') {
				inClass = true;
				continue;
			}
		}
		if (ch !== quote) continue;
		if (quote !== '/') return i + 1;
		RE_FLAGS.lastIndex = i + 1;
		return Math.min(i + 1 + RE_FLAGS.exec(line)[0].length, b);
	}
	return b;
}

// The end of the generated token at column a: a literal as a whole, otherwise
// one identifier, number or punctuator.
function tokenEnd(line, a, b) {
	const ch = line[a];
	if (ch === '"' || ch === "'" || ch === '`') return literalEnd(line, a, b, ch);
	if (ch === '/') {
		let i = a - 1;
		while (i >= 0 && /\s/.test(line[i])) i--;
		if (RE_REGEX_BEFORE.test(i < 0 ? '' : line[i])) return literalEnd(line, a, b, '/');
	}
	RE_WORD.lastIndex = a;
	const m = RE_WORD.exec(line);
	return m ? Math.min(a + m[0].length, b) : a + 1;
}

function inSource(text, content) {
	if (!content) return false;
	const n = text.length;
	const at = n > PROBE ? [n >> 2, n >> 1, (3 * n) >> 2] : [0];
	return at.some((i) => {
		const probe = text.slice(i, i + PROBE);
		return content.includes(probe) || content.includes(probe.replace(/["']/g, (q) => SWAP_QUOTES[q]));
	});
}

// Charge every byte of a generated file to a source. Each mapped segment owns
// the span from its own column up to the next segment's column, the rest of the
// line after the last segment included, as far as SPAN_CHECK lets it. Everything
// the map does not cover - bytes before the first segment, unmapped lines, what
// the bundler inserted without a mapping, line breaks, the license banner and
// the sourceMappingURL comment - is kept as one explicit remainder instead of
// being spread over the sources. Attributed plus remainder is the file size
// exactly, which is what makes the result checkable.
function attribute(jsFile, mapFile) {
	const buf = fs.readFileSync(jsFile);
	const text = buf.toString('utf8');
	const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
	const lines = text.split('\n');
	const mapLines = String(map.mappings ?? '').split(';');
	const contents = map.sourcesContent ?? [];
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
			let bytes = Buffer.byteLength(line.slice(a, b));
			const key = segs[k][1];
			if (key < 0) {
				remainder += bytes;
				continue;
			}
			if (bytes >= SPAN_CHECK) {
				const end = tokenEnd(line, a, b);
				if (end < b && !inSource(line.slice(end, b), contents[key])) {
					const rest = Buffer.byteLength(line.slice(end, b));
					remainder += rest;
					bytes -= rest;
				}
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
export const SEP = '\u0000';
const attrCache = new Map();

export function attrOfFile(dir, file) {
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
export function attrOfFiles(dir, files) {
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

export function packageList(at, total) {
	const count = new Map();
	for (const key of at.perModule.keys()) {
		const pkg = key.slice(0, key.indexOf(SEP));
		count.set(pkg, (count.get(pkg) ?? 0) + 1);
	}
	return [...at.perPkg.entries()]
		.map(([pkg, bytes]) => ({ pkg, bytes, share: total ? bytes / total : 0, modules: count.get(pkg) ?? 0 }))
		.sort((a, b) => b.bytes - a.bytes);
}

// Of items measured per page ({ bytes, page, ... }), the one with the most bytes
// for every key. Summed over the files of several pages an item counts once per
// copy, and in a webpack build every entry bundle carries its own copy, so the
// sum is an amount no page ever loads.
export function heaviestPage(items, key) {
	const out = new Map();
	for (const x of items) {
		const cur = out.get(x[key]);
		if (!cur || x.bytes > cur.bytes) out.set(x[key], x);
	}
	return [...out.values()].sort((a, b) => b.bytes - a.bytes);
}

export function moduleList(at) {
	return [...at.perModule.entries()]
		.map(([key, bytes]) => {
			const i = key.indexOf(SEP);
			return { pkg: key.slice(0, i), module: key.slice(i + 1), bytes };
		})
		.sort((a, b) => b.bytes - a.bytes);
}

// == Imports inside a package ==
// A source map carries the sources it maps to, so what a delivered module of a
// package imports from that same package can be read off it: every relative
// specifier, resolved against the module's own path in the package. Returns
// module path -> the module paths it imports.
const RE_RELATIVE = /(?:^|[^.\w$])(?:import|from|require)\s*\(?\s*(["'])(\.\.?\/[^"'\n]+)\1/g;

export function packageImports(dir, files, pkg) {
	const out = new Map();
	for (const f of files) {
		const mapFile = findMap(dir, f);
		if (!mapFile) continue;
		const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
		const contents = map.sourcesContent ?? [];
		(map.sources ?? []).forEach((src, i) => {
			const { pkg: p, rel } = originOf(src);
			if (p !== pkg || out.has(rel) || typeof contents[i] !== 'string') return;
			const base = path.posix.dirname(rel);
			out.set(rel, new Set([...contents[i].matchAll(RE_RELATIVE)]
				.map((m) => path.posix.normalize(path.posix.join(base, m[2])))));
		});
	}
	return out;
}

// == Stylesheet graph ==
// CSS has an import mechanism of its own, and a bundler that splits stylesheets
// emits one file per page that holds nothing but @import lines pointing at the
// chunks. The browser follows them, so the closure of a stylesheet is what the
// page loads, exactly as for JavaScript.
const RE_CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"')]+)["']/g;

export function buildCssGraph(dir) {
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

// A lazily loaded chunk brings its stylesheet along, and the bundler's runtime
// inserts the <link> itself, so the name is in the JavaScript, not in an
// @import. Vite lists the file among the dependencies of the dynamic import;
// webpack and rspack build it as miniCssF(chunk id) and keep the ids of the
// chunks that have a stylesheet in an object. A service worker's precache list
// names its files the same way. Returns stylesheet -> the scripts naming it.
const RE_CSS_LITERAL = /["'`]([^"'`\n]+\.css)["'`]/g;
const RE_CSS_COMPOSED = /miniCssF\s*=\s*\(?(\w+)\)?\s*=>\s*(?:"[^"]*"\s*\+\s*)?\1\s*\+\s*"([^"]*\.css)"/;

export function cssNamedBy(dir, jsFiles, cssFiles) {
	const byBase = new Map(cssFiles.map((f) => [path.posix.basename(f), f]));
	const named = new Map();
	for (const f of jsFiles) {
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		const hit = new Set();
		RE_CSS_LITERAL.lastIndex = 0;
		let m;
		while ((m = RE_CSS_LITERAL.exec(text)) !== null) {
			const css = byBase.get(path.posix.basename(m[1]));
			if (css) hit.add(css);
		}
		const composed = RE_CSS_COMPOSED.exec(text);
		for (const [base, css] of composed ? byBase : []) {
			if (!base.endsWith(composed[2])) continue;
			const id = base.slice(0, -composed[2].length);
			if ([`"${id}":`, `'${id}':`, `{${id}:`, `,${id}:`].some((k) => text.includes(k))) hit.add(css);
		}
		for (const css of hit) named.set(css, [...(named.get(css) ?? []), f]);
	}
	return named;
}
