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

export function moduleList(at) {
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
