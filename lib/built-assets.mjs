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
// Nothing here judges, formats or prints. Reads only: no build, no network, no
// npm dependencies. node_modules is read where the checkout has it, to find the
// file a piece of code the maps do not name was taken from. Node 18 or newer.

import { spawnSync } from 'node:child_process';
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

// == Where the build writes ==
// A Nextcloud app ships its built scripts in js/, but an app can keep its
// hand-written sources there and let the bundler write to another directory.
// The checkout says which: what git ignores is not source, so an ignored
// directory that holds scripts is what a build wrote. Installed dependencies,
// tool caches in dot directories and ncmake's own stage and artifacts are ignored
// as well and are no output of the app's build.
const NOT_OUTPUT = new Set(['node_modules', 'vendor']);
const NCMAKE_OUTPUT = ['build/stage', 'build/artifacts'];
const notOutput = (rel) => NCMAKE_OUTPUT.some((d) => rel === d || rel.startsWith(`${d}/`))
	|| rel.split('/').some((seg) => NOT_OUTPUT.has(seg) || seg.startsWith('.'));

function holdsScripts(root, rel) {
	for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
		const r = `${rel}/${e.name}`;
		if (notOutput(r)) continue;
		if (e.isFile() && JS_EXT.has(path.extname(e.name))) return true;
		if (e.isDirectory() && holdsScripts(root, r)) return true;
	}
	return false;
}

// The directory of built assets in the checkout at root: the conventional one
// when git ignores scripts in it, ignores none elsewhere, or root is not the top
// of a git work tree; otherwise the one ignored directory with scripts in it.
// Where git ignores several, dir is null and candidates names them, because which
// of them a build wrote is not decidable from the checkout.
export function builtDirOf(root, conventional = 'js') {
	const git = (...args) => spawnSync('git', ['-c', 'safe.directory=*', '-C', root, ...args],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	// An app without a repository of its own, unpacked inside a server checkout for
	// example, would otherwise be classified by the enclosing repository's ignores.
	const top = git('rev-parse', '--show-prefix');
	if (top.error || top.status !== 0 || top.stdout.trim() !== '') return { dir: conventional, candidates: [] };
	const r = git('ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z');
	if (r.error || r.status !== 0) return { dir: conventional, candidates: [] };
	const found = new Set();
	for (const entry of r.stdout.split('\0').filter(Boolean)) {
		const rel = entry.replace(/\/$/, '');
		if (notOutput(rel)) continue;
		if (entry.endsWith('/')) {
			if (holdsScripts(root, rel)) found.add(rel);
		} else if (JS_EXT.has(path.extname(rel)) && path.dirname(rel) !== '.') {
			found.add(path.dirname(rel));
		}
	}
	const candidates = [...found].sort();
	const own = candidates.some((d) => d === conventional || d.startsWith(`${conventional}/`));
	if (own || candidates.length === 0) return { dir: conventional, candidates };
	return { dir: candidates.length === 1 ? candidates[0] : null, candidates };
}

// == Module graph ==
// Minified ESM output is matched textually rather than parsed. A specifier only
// becomes an edge when it resolves to a file that is actually present, so a
// string literal that happens to look like an import cannot invent one. A call
// may also take a template literal, which rolldown writes; without a ${...}
// substitution it is as constant as a quoted string.
const RE_STATIC = /(?:^|[^.\w$])(?:import|from)\s*(["'])([^"'\n]+)\1/g;
const RE_DYNAMIC = /(?:^|[^.\w$])import\s*\(\s*(["'`])(?!(?<=`)[^`\n]*\$\{)([^"'`\n]+)\1\s*\)/g;
const RE_NON_ESM = /webpackChunk|__webpack_require__|\bdefine\(\s*\[|exports\.__esModule/;
// webpack and rspack load a chunk at runtime: __webpack_require__.e(id) fetches
// the file __webpack_require__.u(id) names below the public path, which a
// Nextcloud app sets to its js/ directory. .u is a sum of string literals, the
// id, a lookup {...}[id] or ({...})[id], and a named chunk ({...}[id]||id). A
// lookup holds a content hash, in the file name or in a query after it, and is
// keyed by every chunk id that runtime can load, including the ones only a
// variable names, such as a locale. Minified, the runtime object has any name, so an id only becomes an
// edge when the file it names is present. The stylesheet of a chunk is named by
// .miniCssF the same way.
const chunkHead = (prop) => new RegExp(`\\.${prop}\\s*=\\s*(?:function\\s*)?\\(?\\s*([\\w$]+)\\s*\\)?\\s*(?:=>|\\{\\s*return)`, 'g');
const RE_CHUNK_URL = chunkHead('u');
const RE_CSS_URL = chunkHead('miniCssF');
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

// A worker script is loaded by URL into a thread of its own when the code asks
// for it, so it is no page: no import names it, a string does. That string sits
// in the argument of new Worker (also as window.Worker), new SharedWorker or
// serviceWorker.register, or in what is assigned to workerSrc (pdf.js), either
// itself or through a variable it was assigned to first, as Vite's ?url import
// writes it:
// const Ok=""+window.OC.filePath("app","","js/pdf.worker-x.mjs") ... workerSrc=Ok.
// The string names the file by its path below the public directory, so it
// counts when it ends in the file's path, resolves relative to the naming file,
// or carries a file name only one script in the build has.
const RE_WORKER_SINK = /(?:\bnew\s+(?:[\w$]+\s*\.\s*)*(?:Shared)?Worker\s*\(|\bserviceWorker\s*\.\s*register\s*\(|\bworkerSrc\s*(?:\|\||\?\?)?=(?!=)|\bworkerSrc\s*:)/g;
const RE_SCRIPT_LITERAL = /(["'`])([^"'`\n]*\.[mc]?js)(?:[?#][^"'`\n]*)?\1/g;
const RE_IDENT = /^[A-Za-z_$][\w$]*$/;
const OPEN = { '(': ')', '[': ']', '{': '}' };

// Where the expression starting at from ends: the first , ; or closing bracket
// at depth 0, or a line break there, string literals skipped.
function expressionEnd(text, from) {
	const stack = [];
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'" || c === '`') {
			const close = text.indexOf(c, i + 1);
			if (close === -1) return text.length;
			i = close;
		} else if (OPEN[c]) {
			stack.push(OPEN[c]);
		} else if (c === ')' || c === ']' || c === '}') {
			if (!stack.length) return i;
			stack.pop();
		} else if (!stack.length && (c === ',' || c === ';' || c === '\n')) {
			return i;
		}
	}
	return text.length;
}

function workerScripts(text, file, present, byBase) {
	const literals = [];
	for (const m of text.matchAll(RE_SCRIPT_LITERAL)) {
		const s = m[2];
		const rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), s));
		const same = byBase.get(path.posix.basename(s)) ?? [];
		const target = present.has(rel) ? rel
			: same.find((f) => s === f || s.endsWith(`/${f}`)) ?? (same.length === 1 ? same[0] : null);
		if (target && target !== file) literals.push({ at: m.index, target });
	}
	if (!literals.length) return [];
	const within = (from, to) => literals.filter((l) => l.at >= from && l.at < to).map((l) => l.target);
	const out = new Set();
	for (const m of text.matchAll(RE_WORKER_SINK)) {
		const from = m.index + m[0].length;
		const to = expressionEnd(text, from);
		for (const t of within(from, to)) out.add(t);
		const id = text.slice(from, to).trim();
		if (!RE_IDENT.test(id)) continue;
		const assign = new RegExp(`(?:^|[^\\w$.])${id.replace(/\$/g, '\\$')}\\s*=(?![=>])`, 'g');
		for (const a of text.matchAll(assign)) {
			const start = a.index + a[0].length;
			for (const t of within(start, expressionEnd(text, start))) out.add(t);
		}
	}
	return [...out];
}

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
	const byBase = new Map();
	for (const f of js) byBase.set(path.posix.basename(f), [...(byBase.get(path.posix.basename(f)) ?? []), f]);
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
		// A worker is fetched when the code asks for it, as a dynamic import is.
		for (const w of workerScripts(text, f, present, byBase)) if (!stat.has(w)) dyn.add(w);

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
	// When the entry and a chunk lie in one import cycle, both reach the same
	// files. The entry is where the app starts and loads its views lazily, while
	// a chunk split off to be shared carries no loader, so the candidate with
	// more dynamic imports of its own goes first.
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
		.sort((a, b) => b.r.size - a.r.size || graph.get(b.f).dynamic.length - graph.get(a.f).dynamic.length);
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

// == Ownership of what the map does not cover ==
// A source map leaves bytes uncovered: the code the bundler writes around and
// between the modules, modules it never names (virtual helpers, inlined JSON,
// inlined assets), the lines of a template literal after its first, compiled
// Vue code and the CSS a plugin injects through JavaScript. Each of these has an
// owner that can be shown, so it is charged to it. What no rule below explains
// stays the remainder, and every piece of it is kept with its offset, so a new
// pattern shows up as a place in a file instead of disappearing in a percentage.
export const APP_SOURCE = 'app source';
const GENERATED = 'generated by ';
export const isGenerated = (pkg) => pkg.startsWith(GENERATED);

// What the bundler writes itself. A chunk carries code of its own under each
// kind, so a kind is no module that could be delivered twice.
const GLUE = {
	links: 'chunk imports and exports',
	wrap: 'module wrappers',
	deps: 'preload dependency list',
	comments: 'comments',
	helpers: 'runtime helpers',
};
const GLUE_KINDS = new Set(Object.values(GLUE));
export const isGlue = (key) => isGenerated(key.slice(0, key.indexOf(SEP))) && GLUE_KINDS.has(key.slice(key.indexOf(SEP) + 1));

// Constructs only a bundler writes. A name in them is whatever the module
// exports, so they cannot be told apart by the length of their identifiers.
const STRING = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\x60[^\x60]*\x60)`;
const NAMES = String.raw`\{[^{}]*\}`;
const GLUE_SYNTAX = [
	// ESM chunks: import{a as b}from"./x.mjs";  import"./x.mjs";  export{a as b};
	[new RegExp(String.raw`import\s*(?:[\w$]+\s*,?\s*)?(?:${NAMES}\s*|\*\s*as\s+[\w$]+\s*)?(?:from\s*)?${STRING}\s*;?`, 'y'), GLUE.links],
	[new RegExp(String.raw`export\s*(?:${NAMES}|\*(?:\s*as\s+[\w$]+)?)\s*(?:from\s*${STRING})?\s*;?`, 'y'), GLUE.links],
	// webpack: the chunk header, a module's header and the getters of its exports.
	[new RegExp(String.raw`\(self\.webpackChunk[\w$]*=self\.webpackChunk[\w$]*\|\|\[\]\)\.push\(\[\[[^\]]*\],\{`, 'y'), GLUE.wrap],
	[new RegExp(String.raw`(?:\d+|${STRING}):(?:function\s*\([\w$,]*\)|\([\w$,]*\)\s*=>|[\w$]+\s*=>)\s*\{`, 'y'), GLUE.wrap],
	[new RegExp(String.raw`[\w$]+\.d\([\w$]+,\{(?:(?:[\w$]+|${STRING}):(?:\(\)=>|function\(\)\{return\s*)[\w$.]+\}?,?)*\}\)[;,]?`, 'y'), GLUE.wrap],
	[/(["'])use strict\1;?/y, GLUE.wrap],
	// webpack: the URL of an asset module, the public path plus the emitted name.
	[new RegExp(String.raw`(?:[\w$]+\.exports\s*=\s*)?[\w$]+\.p\s*\+\s*${STRING}`, 'y'), GLUE.wrap],
	// rolldown and esbuild: the getter of an export in a namespace object.
	[new RegExp(String.raw`(?:[\w$]+|${STRING}):\(\)=>[\w$.]+(?=[,}])`, 'y'), GLUE.wrap],
];
const RE_MAP_DEPS = /const __vite__mapDeps\s*=/y;
// The call @vitejs/plugin-vue appends to a compiled .vue: export helper, the
// component, its render function and its scope id. It is code of that .vue.
const RE_VUE_EXPORT = new RegExp(String.raw`(?:[\w$]+\([\w$]+,\[\[)?(["'\x60])render\1,[\w$]+\](?:,\[(["'\x60])__scopeId\2,(["'\x60])data-v-[\w-]+\3\])?(?:,\[(["'\x60])__file\4,${STRING}\])?\]\)`, 'y');
// Words that occur in wrappers. Any other name of five characters or more was
// kept by the minifier, so it is code of a module.
const WRAP_WORDS = new Set(['var', 'let', 'const', 'void', 'null', 'true', 'false', 'this', 'function', 'return',
	'typeof', 'instanceof', 'delete', 'while', 'break', 'continue', 'switch', 'throw', 'catch', 'finally', 'class',
	'extends', 'super', 'async', 'await', 'yield', 'undefined', 'arguments', 'static', 'default', 'exports', 'module']);
const WRAP_NAME_MAX = 4;

// The end of the statement that starts at a: the first ; or line break outside
// brackets and literals.
function statementEnd(text, a) {
	let depth = 0;
	for (let i = a; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			i = literalEnd(text, i, text.length, ch) - 1;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		else if (depth <= 0 && (ch === ';' || ch === '\n')) return i + 1;
	}
	return text.length;
}

// The top-level statements of a piece of code, a function declaration ending
// at its closing brace. Only where a piece is cut for matching depends on it.
function statements(code) {
	const out = [];
	let start = 0;
	let depth = 0;
	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			i = literalEnd(code, i, code.length, ch) - 1;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
			continue;
		}
		// A piece that starts inside a construct ends where that construct closes.
		const closes = (ch === ')' || ch === ']' || ch === '}') && depth === 0;
		if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(depth - 1, 0);
		const declared = ch === '}' && depth === 0 && (/^[\s;]*(?:async\s+)?function\b/.test(code.slice(start, start + 24))
			|| /^\s*(?:(?:async\s+)?function|var|let|const|class)\b/.test(code.slice(i + 1, i + 24)));
		if (closes || declared || (ch === ';' && depth === 0)) {
			out.push([start, i + 1]);
			start = i + 1;
		}
	}
	if (start < code.length) out.push([start, code.length]);
	return out;
}

// Split uncovered text into tokens: glue of a known kind, or code that needs an
// owner. A run of code ends where a construct of the bundler begins.
function glueTokens(text, appLiterals = null) {
	const out = [];
	let p = 0;
	while (p < text.length) {
		const ch = text[p];
		if (/\s/.test(ch)) {
			let q = p + 1;
			while (q < text.length && /\s/.test(text[q])) q++;
			out.push({ a: p, b: q, kind: null });
			p = q;
			continue;
		}
		if (ch === '/' && (text[p + 1] === '/' || text[p + 1] === '*')) {
			const close = text[p + 1] === '/' ? text.indexOf('\n', p) : text.indexOf('*/', p + 2);
			const q = close === -1 ? text.length : text[p + 1] === '/' ? close : close + 2;
			out.push({ a: p, b: q, kind: GLUE.comments, strong: true });
			p = q;
			continue;
		}
		RE_MAP_DEPS.lastIndex = p;
		if (RE_MAP_DEPS.test(text)) {
			const q = statementEnd(text, p);
			out.push({ a: p, b: q, kind: GLUE.deps, strong: true });
			p = q;
			continue;
		}
		RE_VUE_EXPORT.lastIndex = p;
		const vue = RE_VUE_EXPORT.exec(text);
		if (vue) {
			out.push({ a: p, b: p + vue[0].length, kind: 'vue', strong: true });
			p += vue[0].length;
			continue;
		}
		let hit = null;
		for (const [re, kind] of GLUE_SYNTAX) {
			re.lastIndex = p;
			const m = re.exec(text);
			if (m && m[0].length) {
				hit = { a: p, b: p + m[0].length, kind, strong: true };
				break;
			}
		}
		if (hit) {
			out.push(hit);
			p = hit.b;
			continue;
		}
		const q = tokenEnd(text, p, text.length);
		const word = text.slice(p, q);
		if (appLiterals && (ch === '"' || ch === "'" || ch === '`') && appLiterals.has(literalValue(word))) {
			out.push({ a: p, b: q, kind: 'app', strong: true });
			p = q;
			continue;
		}
		const code = ch === '"' || ch === "'" || ch === '`'
			|| (/[\w$\u0080-￿]/.test(ch) && !/^\d/.test(word) && !WRAP_WORDS.has(word) && word.length > WRAP_NAME_MAX)
			|| (ch === '/' && q - p > 1);
		out.push({ a: p, b: q, kind: code ? 'code' : null });
		p = q;
	}
	return out;
}

// -- Template literals and comments that run across lines --
// A minifier keeps the line breaks inside a template literal and removes the
// others, and no mapping starts inside a literal: the lines after its first
// carry no segment. One pass over the file says for every line whether it starts
// inside a template or a block comment, where that was opened, and the column
// where it closes on this line.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'throw', 'new',
	'delete', 'instanceof', 'yield', 'await']);

function carriedLines(lines) {
	const out = new Array(lines.length).fill(null);
	const stack = [];
	let lastSig = '';
	let lastWord = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const open = stack.find((f) => f.tpl || f.comment) ?? null;
		const carried = open ? { kind: open.tpl ? 'tpl' : 'comment', line: open.line, col: open.col, end: line.length } : null;
		out[i] = carried;
		let j = 0;
		while (j < line.length) {
			const top = stack[stack.length - 1];
			const ch = line[j];
			if (top?.comment) {
				const k = line.indexOf('*/', j);
				if (k === -1) {
					j = line.length;
					continue;
				}
				stack.pop();
				if (top === open) carried.end = k + 2;
				j = k + 2;
				continue;
			}
			if (top?.tpl) {
				if (ch === '\\') {
					j += 2;
					continue;
				}
				if (ch === '`') {
					stack.pop();
					if (top === open) carried.end = j + 1;
					lastSig = ')';
					lastWord = '';
					j++;
					continue;
				}
				if (ch === '$' && line[j + 1] === '{') {
					stack.push({ depth: 0 });
					lastSig = '{';
					lastWord = '';
					j += 2;
					continue;
				}
				j++;
				continue;
			}
			if (/\s/.test(ch)) {
				j++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				j = literalEnd(line, j, line.length, ch);
				lastSig = ')';
				lastWord = '';
				continue;
			}
			if (ch === '`') {
				stack.push({ tpl: true, line: i, col: j });
				j++;
				continue;
			}
			if (ch === '/') {
				if (line[j + 1] === '/') break;
				if (line[j + 1] === '*') {
					stack.push({ comment: true, line: i, col: j });
					j += 2;
					continue;
				}
				if (lastWord ? REGEX_AFTER_WORD.has(lastWord) : RE_REGEX_BEFORE.test(lastSig)) {
					j = literalEnd(line, j, line.length, '/');
					lastSig = ')';
					lastWord = '';
					continue;
				}
			}
			if (ch === '{' && top) top.depth++;
			if (ch === '}' && top) {
				if (top.depth === 0) {
					stack.pop();
					j++;
					continue;
				}
				top.depth--;
			}
			RE_WORD.lastIndex = j;
			const m = RE_WORD.exec(line);
			if (m) {
				lastWord = m[0];
				lastSig = 'a';
				j += m[0].length;
				continue;
			}
			lastSig = ch;
			lastWord = '';
			j++;
		}
	}
	return out;
}

// -- What the map never names --
// A module the bundler did not name in the map is still a file somewhere: one of
// the package whose code surrounds it, or one of the bundler, its plugins and
// the compilers they run (TypeScript writes its helpers into each module). It
// is looked for only there, never among all installed files, and only through
// what the minifier leaves intact: the text of its string literals and the names
// it keeps. Those must all occur in one file.
const RE_TOOL_PKG = /^(?:vite|rolldown|rollup|webpack|esbuild|typescript|@rspack\/core|@babel\/(?:helpers|runtime(?:-corejs\d)?)|@vitejs\/.+|@rollup\/.+|@rolldown\/.+|(?:@[^/]+\/)?(?:vite|rollup|webpack)-plugin-.+|(?:@[^/]+\/)?[\w.-]+-loader|@nextcloud\/(?:vite|webpack)-[\w-]+)$/;
const BUNDLERS = ['vite', 'rolldown', 'rollup', 'webpack', '@rspack/core', 'esbuild'];
const FILE_TEXT = /\.(?:[cm]?js|json|vue|ts)$/;
const FILE_MAX = 8 * 1024 * 1024;
const PRINT_MIN = 16;
const PRINT_TOKENS = 48;
const JS_RESERVED = new Set(['function', 'return', 'typeof', 'const', 'while', 'break', 'class', 'throw', 'delete',
	'export', 'import', 'extends', 'default', 'instanceof', 'continue', 'finally', 'switch', 'yield', 'await', 'async',
	'catch', 'false', 'super', 'undefined', 'arguments', 'Object', 'Array', 'String', 'Symbol', 'length', 'prototype',
	'call', 'apply', 'value']);

const installCache = new Map();

// The checkout the built directory belongs to, as far as it has node_modules.
function installOf(dir) {
	const start = path.resolve(dir);
	let e = installCache.get(start);
	if (e) return e;
	let root = null;
	for (let d = start; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, 'node_modules'))) {
			root = d;
			break;
		}
		if (path.dirname(d) === d) break;
	}
	const has = (pkg) => root !== null && fs.existsSync(path.join(root, 'node_modules', pkg, 'package.json'));
	const tools = [];
	if (root) {
		const nm = path.join(root, 'node_modules');
		for (const name of fs.readdirSync(nm)) {
			const names = name.startsWith('@') ? fs.readdirSync(path.join(nm, name)).map((n) => `${name}/${n}`) : [name];
			for (const n of names) if (RE_TOOL_PKG.test(n) && has(n)) tools.push(n);
		}
	}
	e = { root, has, tools: tools.sort(), bundler: BUNDLERS.find(has) ?? null, files: new Map(), texts: new Map(), plains: new Map(), hits: new WeakMap() };
	installCache.set(start, e);
	return e;
}

// The bundler a file was written by: webpack and rspack name their sources
// webpack://, every other one is the bundler the checkout installs.
function bundlerOf(inst, map, text) {
	const webpack = (map.sources ?? []).some((s) => s.startsWith('webpack://'))
		|| (!map.sources && /\bwebpackChunk|__webpack_require__/.test(text));
	if (webpack) return inst.has('@rspack/core') ? 'rspack' : 'webpack';
	return inst.bundler === '@rspack/core' ? 'rspack' : (inst.bundler ?? 'the bundler');
}

function packageFiles(inst, pkgDir) {
	let e = inst.files.get(pkgDir);
	if (!e) {
		e = [];
		const walk = (d) => {
			let list;
			try {
				list = fs.readdirSync(d, { withFileTypes: true });
			} catch {
				return;
			}
			for (const x of list) {
				const full = path.join(d, x.name);
				if (x.isDirectory()) {
					if (x.name !== 'node_modules') walk(full);
				} else if (x.isFile()) {
					e.push({ full, rel: path.relative(pkgDir, full).split(path.sep).join('/'), size: fs.statSync(full).size });
				}
			}
		};
		walk(pkgDir);
		e.sort((a, b) => a.rel.localeCompare(b.rel));
		inst.files.set(pkgDir, e);
	}
	return e;
}

function fileText(inst, f) {
	let t = inst.texts.get(f.full);
	if (t === undefined) {
		t = FILE_TEXT.test(f.rel) && !f.rel.endsWith('.d.ts') && f.size <= FILE_MAX ? fs.readFileSync(f.full, 'utf8') : null;
		inst.texts.set(f.full, t);
	}
	return t;
}

// The directory of the package a mapped source belongs to.
function packageDirOf(inst, mapDir, src) {
	const clean = src.split('?')[0].replace(/^\0/, '');
	const webpack = clean.startsWith('webpack://');
	const rel = clean.replace(/^webpack:\/\/[^/]*\//, '');
	const at = rel.lastIndexOf('node_modules/');
	if (at === -1) return null;
	const parts = rel.slice(at + 'node_modules/'.length).split('/');
	const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
	const base = path.isAbsolute(rel) ? '' : webpack ? inst.root : mapDir;
	if (base === null) return null;
	const dir = path.resolve(base, rel.slice(0, at), 'node_modules', pkg);
	return fs.existsSync(dir) ? { pkg, dir } : null;
}

// The text of a JavaScript string literal.
function literalValue(lit) {
	const q = lit[0];
	const body = lit.slice(1, -1);
	if (q === '"') {
		try {
			return JSON.parse(lit);
		} catch {
			return null;
		}
	}
	let s = '"';
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === '\\') {
			const nx = body[i + 1];
			s += nx === q ? q : `\\${nx}`;
			i++;
		} else if (ch === '"') s += '\\"';
		else if (q === '`' && ch === '\n') s += '\\n';
		else s += ch;
	}
	try {
		return JSON.parse(`${s}"`);
	} catch {
		return null;
	}
}

// What a piece of minified code keeps from its source: the text of its literals
// and the names of five characters or more, sampled evenly where there are many.
function prints(text) {
	const out = new Set();
	for (const t of glueTokens(text)) {
		if (t.kind !== 'code') continue;
		const s = text.slice(t.a, t.b);
		if (s[0] === '"' || s[0] === "'" || s[0] === '`') {
			const inner = s.slice(1, -1).split('${')[0];
			if (inner.length >= 4) out.add(inner);
		} else if (/^[\w$]/.test(s) && s.length > WRAP_NAME_MAX && !JS_RESERVED.has(s)) out.add(s);
	}
	let list = [...out];
	if (list.length > PRINT_TOKENS) {
		const step = list.length / PRINT_TOKENS;
		list = Array.from({ length: PRINT_TOKENS }, (_, i) => list[Math.floor(i * step)]);
	}
	return list.sort((a, b) => b.length - a.length);
}

// Compiled Vue code keeps the text of the template, not its names: those the
// compiler writes itself (render, the props of a v-model, the handler an @event
// becomes) are not in the .vue.
const VUE_WORDS = /^(?:render|__scopeId|__file|data-v-[\w-]+|on[A-Z][\w:-]*|modelValue|modelModifiers|default)$/;

function vuePrints(text) {
	const out = new Set();
	for (const t of glueTokens(text)) {
		const s = text.slice(t.a, t.b);
		if (t.kind !== 'code' || !(s[0] === '"' || s[0] === "'" || s[0] === '`')) continue;
		const inner = s.slice(1, -1).split('${')[0];
		if (inner.length >= 4 && !VUE_WORDS.test(inner)) out.add(inner);
	}
	return [...out];
}

// A quote inside a literal can stand in the source as the other quote or
// escaped, as the minifier may have chosen other delimiters.
const occursIn = (content, token) => (token.length <= 2 * PROBE
	? content.includes(token) || content.includes(token.replace(/["']/g, (q) => SWAP_QUOTES[q]))
		|| (/["']/.test(token) && content.includes(token.replace(/["']/g, '\\$&')))
	: [token.length >> 2, token.length >> 1, (3 * token.length) >> 2].every((i) => occursIn(content, token.slice(i, i + PROBE))));

// Quotes and the escapes before them made alike, so that one search finds a
// token whatever delimiters the minifier chose.
const plain = (s) => s.replace(/\\(["'])/g, '$1').replace(/'/g, '"');

function filePlain(inst, f) {
	let t = inst.plains.get(f.full);
	if (t === undefined) {
		const raw = fileText(inst, f);
		t = raw === null ? null : plain(raw);
		inst.plains.set(f.full, t);
	}
	return t;
}

const occursPlain = (content, token) => (token.length <= 2 * PROBE
	? content.includes(token)
	: [token.length >> 2, token.length >> 1, (3 * token.length) >> 2].every((i) => content.includes(token.slice(i, i + PROBE))));

// The file of a package a piece of code was taken from. Where several files hold
// it, the one nearest the module it sits next to wins, then the shortest path.
function fileWith(inst, files, text, near, tokens = prints(text)) {
	const lits = [...text.matchAll(/(["'`])data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)\1/g)];
	if (lits.length === 1 && lits[0][0].length >= text.trim().length / 2) {
		const bytes = Buffer.from(lits[0][3], 'base64');
		for (const f of files) {
			if (f.size === bytes.length && fs.readFileSync(f.full).equals(bytes)) return f.rel;
		}
		return null;
	}
	const json = /JSON\.parse\(\s*((["'`])[\s\S]*\2)\s*\)/.exec(text);
	if (json && json[1].length >= text.trim().length / 2) {
		const value = literalValue(json[1]);
		let want = null;
		try {
			want = value === null ? null : JSON.stringify(JSON.parse(value));
		} catch {
			want = null;
		}
		if (want === null) return null;
		for (const f of files) {
			if (!f.rel.endsWith('.json') || f.size > FILE_MAX) continue;
			try {
				if (JSON.stringify(JSON.parse(fileText(inst, f))) === want) return f.rel;
			} catch {
				// not JSON after all
			}
		}
		return null;
	}
	if (tokens.reduce((n, t) => n + t.length, 0) < PRINT_MIN) return null;
	// The files that hold the longest token are kept per token: the statements
	// of a piece that has no owner are looked for again, and share its tokens.
	const want = tokens.map(plain);
	let memo = inst.hits.get(files);
	if (!memo) inst.hits.set(files, (memo = new Map()));
	let first = memo.get(want[0]);
	if (!first) {
		first = files.filter((f) => {
			const content = filePlain(inst, f);
			return content !== null && occursPlain(content, want[0]);
		});
		memo.set(want[0], first);
	}
	const hits = first.filter((f) => want.every((t) => occursPlain(filePlain(inst, f), t)));
	if (!hits.length) return null;
	const shared = (rel) => {
		const a = rel.split('/');
		const b = (near ?? '').split('/');
		let n = 0;
		while (n < a.length && n < b.length && a[n] === b[n]) n++;
		return n;
	};
	return hits.sort((a, b) => shared(b.rel) - shared(a.rel) || a.rel.length - b.rel.length)[0].rel;
}

// The owner of a piece of code the map does not name: a file of a neighbouring
// package, then a file of the bundler or one of its plugins. A piece found in
// more than one of those is the bundler's, whose plugin it is not said.
function ownerOfCode(inst, ctx, text, around) {
	const tokens = prints(text);
	for (const n of around) {
		if (!n) continue;
		const rel = fileWith(inst, n.files ?? packageFiles(inst, n.dir), text, n.rel, tokens);
		if (rel) return n.pkg + SEP + rel;
	}
	const hits = [];
	for (const pkg of inst.tools) {
		const rel = fileWith(inst, packageFiles(inst, path.join(inst.root, 'node_modules', pkg)), text, null, tokens);
		if (rel) hits.push({ pkg, rel });
	}
	if (hits.length === 1) return GENERATED + hits[0].pkg + SEP + hits[0].rel;
	if (hits.length > 1) return GENERATED + ctx.bundler + SEP + GLUE.helpers;
	return null;
}

// -- CSS a plugin injects through JavaScript --
// vite-plugin-css-injected-by-js and its kind put every stylesheet of the build
// into one string handed to document.createTextNode. A rule scoped with
// [data-v-<hash>] belongs to the .vue whose compiled code sets that __scopeId;
// everything else in the string, and the code around it, to the plugin.
const RE_INJECT = /\.createTextNode\(\s*(?=["'`])/g;
const RE_SCOPE_ID = /__scopeId["'`]\s*,\s*["'`]data-v-([\w-]+)["'`]/g;
const RE_SCOPED = /\[data-v-([\w-]+)\]/;
const RE_NESTING_AT = /^@(?:media|supports|container|layer|document)\b/;

// Split a stylesheet into the rules that can have an owner of their own, the
// rules inside @media and its kind included. Returns { a, b, hash } per rule.
function cssRules(css, from = 0, to = css.length) {
	const out = [];
	let p = from;
	while (p < to) {
		const open = css.indexOf('{', p);
		if (open === -1 || open >= to) break;
		let depth = 0;
		let q = open;
		for (; q < to; q++) {
			if (css[q] === '{') depth++;
			else if (css[q] === '}' && --depth === 0) break;
		}
		const end = Math.min(q + 1, to);
		const prelude = css.slice(p, open).trim();
		if (RE_NESTING_AT.test(prelude)) {
			out.push(...cssRules(css, open + 1, end - 1));
		} else {
			out.push({ a: p, b: end, hash: RE_SCOPED.exec(prelude)?.[1] ?? null });
		}
		p = end;
	}
	return out;
}

const isVue = (src) => /\.vue$/.test(src.split('?')[0]);

// -- Files the build copies --
// A file without a map can be one the build copies as it is, a service worker
// out of src/ for example. It is then that file of the checkout, byte for byte.
const checkoutCache = new Map();

function appRootOf(dir) {
	for (let d = path.resolve(dir); ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, 'appinfo', 'info.xml'))) return d;
		if (path.dirname(d) === d) return null;
	}
}

// The files of the checkout, without its history and without the build output.
function checkoutFiles(dir, inst) {
	const root = appRootOf(dir) ?? inst.root;
	if (!root) return [];
	let files = checkoutCache.get(root);
	if (!files) {
		const built = path.resolve(dir);
		files = packageFiles(inst, root).filter((f) => !f.rel.startsWith('.git/') && !f.full.startsWith(built + path.sep));
		checkoutCache.set(root, files);
	}
	return files;
}

function copiedFrom(dir, inst, buf) {
	const files = checkoutFiles(dir, inst);
	const hit = files.find((f) => f.size === buf.length && fs.readFileSync(f.full).equals(buf));
	return hit ? hit.rel : null;
}

// Charge every byte of a generated file. Each mapped segment owns the span from
// its own column up to the next segment's column, the rest of the line after
// the last segment and its line break included, as far as SPAN_CHECK lets it.
// What no segment covers is handed to the rules above. Attributed plus remainder
// is the file size exactly, which is what makes the result checkable.
function attribute(dir, jsFile, mapFile) {
	const buf = fs.readFileSync(jsFile);
	const text = buf.toString('utf8');
	const map = mapFile ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {};
	const inst = installOf(dir);
	const ctx = { bundler: bundlerOf(inst, map, text) };
	const mapDir = mapFile ? path.dirname(mapFile) : dir;
	const copy = mapFile ? null : copiedFrom(dir, inst, buf);
	// @nextcloud/vite-config defines appName and appVersion from info.xml and
	// writes both into every chunk as an intro.
	let appLiterals = null;
	const appRoot = appRootOf(dir);
	if (appRoot && inst.has('@nextcloud/vite-config')) {
		const xml = fs.readFileSync(path.join(appRoot, 'appinfo', 'info.xml'), 'utf8');
		appLiterals = new Set(['id', 'version'].map((tag) => new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(xml)?.[1]).filter(Boolean));
	}
	if (copy) {
		return { total: buf.length, remainder: 0, sources: new Map([[copy, buf.length]]), extra: new Map(), css: [], scopes: [],
			leftovers: [], bundler: ctx.bundler, copied: copy };
	}
	const sources = map.sources ?? [];
	const contents = map.sourcesContent ?? [];
	const lines = text.split('\n').map((l, i, all) => (i < all.length - 1 ? `${l}\n` : l));
	const lineStart = [];
	for (let i = 0, at = 0; i < lines.length; at += lines[i].length, i++) lineStart.push(at);
	const mapLines = String(map.mappings ?? '').split(';');

	// Every segment of the file in order: line, column, source (-1 for none).
	const segLine = [];
	const segCol = [];
	const segSrc = [];
	let srcIdx = 0;
	for (let i = 0; i < lines.length; i++) {
		let genCol = 0;
		for (const part of (mapLines[i] ?? '').split(',')) {
			if (part === '') continue;
			const f = decodeSegment(part);
			if (f === null || f.length === 0) continue;
			genCol += f[0];
			if (f.length >= 4) srcIdx += f[1];
			segLine.push(i);
			segCol.push(Math.min(genCol, lines[i].length));
			segSrc.push(f.length >= 4 ? srcIdx : -1);
		}
	}
	const n = segSrc.length;
	const nextSrc = new Array(n + 1).fill(-1);
	for (let k = n - 1; k >= 0; k--) nextSrc[k] = segSrc[k] >= 0 ? segSrc[k] : nextSrc[k + 1];
	// The source of the segment that covers a position.
	const ownerAt = (line, col) => {
		let lo = 0;
		let hi = n - 1;
		let hit = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (segLine[mid] < line || (segLine[mid] === line && segCol[mid] <= col)) {
				hit = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return hit === -1 ? -1 : segSrc[hit];
	};

	const perSource = new Map();
	const extra = new Map();
	const charge = (map_, key, bytes) => {
		if (bytes > 0) map_.set(key, (map_.get(key) ?? 0) + bytes);
	};
	const gaps = [];
	const gap = (a, b, prev, next) => {
		if (b <= a) return;
		const last = gaps[gaps.length - 1];
		if (last && last.b === a) {
			last.b = b;
			last.next = next;
		} else {
			gaps.push({ a, b, prev, next });
		}
	};

	const carried = carriedLines(lines);
	let prev = -1;
	let k = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const base = lineStart[i];
		const first = k;
		while (k < n && segLine[k] === i) k++;
		const stop = first < k ? segCol[first] : line.length;
		let from = 0;
		const c = carried[i];
		if (c) {
			const end = Math.min(c.end, stop);
			const owner = c.kind === 'tpl' ? ownerAt(c.line, c.col) : -1;
			if (owner >= 0) {
				charge(perSource, owner, Buffer.byteLength(line.slice(0, end)));
				from = end;
			}
		}
		gap(base + from, base + stop, prev, nextSrc[first]);
		for (let s = first; s < k; s++) {
			const a = segCol[s];
			const b = s + 1 < k ? segCol[s + 1] : line.length;
			if (b <= a) continue;
			const key = segSrc[s];
			if (key < 0) {
				gap(base + a, base + b, prev, nextSrc[s + 1]);
				continue;
			}
			prev = key;
			let end = b;
			if (b - a >= SPAN_CHECK) {
				const t = tokenEnd(line, a, b);
				if (t < b && !inSource(line.slice(t, b), contents[key])) end = t;
			}
			charge(perSource, key, Buffer.byteLength(line.slice(a, end)));
			if (end < b) gap(base + end, base + b, key, nextSrc[s + 1]);
		}
	}

	// The .vue each scope id is set by, for the CSS of this and every other file.
	const scopes = [];
	for (const m of text.matchAll(RE_SCOPE_ID)) {
		let line = 0;
		let lo = 0;
		let hi = lineStart.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (lineStart[mid] <= m.index) {
				line = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		const owner = ownerAt(line, m.index - lineStart[line]);
		if (owner >= 0) scopes.push([m[1], sources[owner]]);
	}

	const neighbour = (idx) => {
		if (idx < 0) return null;
		const clean = sources[idx].split('?')[0];
		const d = packageDirOf(inst, mapDir, sources[idx]);
		// Code next to a module of the app can come from a file the app keeps
		// itself, a vendored library for example.
		if (!d) {
			if (originOf(sources[idx], ctx.bundler).pkg !== APP_SOURCE) return null;
			return { pkg: APP_SOURCE, files: checkoutFiles(dir, inst), rel: clean.replace(/^webpack:\/\/[^/]*\//, '').replace(/^(?:\.\.\/)+/, '') };
		}
		return { ...d, rel: clean.slice(clean.lastIndexOf(`node_modules/${d.pkg}/`) + `node_modules/${d.pkg}/`.length) };
	};
	const css = [];
	const leftovers = [];
	const wrap = GENERATED + ctx.bundler;
	// Settle one uncovered piece: glue to the bundler, each run of code to the
	// first rule that owns it. A run no rule owns as a whole is cut into its
	// statements, and each of them is settled on its own.
	const settle = (g, from, to, vues, around) => {
		const piece = text.slice(from, to);
		const tokens = glueTokens(piece, appLiterals);
		// Runs of code: from a code token to the last code token before the next
		// construct of the bundler.
		const runs = [];
		for (const t of tokens) {
			if (t.kind === 'code') {
				const run = runs[runs.length - 1];
				if (run && !run.closed) run.b = t.b;
				else runs.push({ a: t.a, b: t.b, closed: false });
			} else if (t.strong && runs.length) {
				runs[runs.length - 1].closed = true;
			}
		}
		let r = 0;
		for (const t of tokens) {
			while (r < runs.length && runs[r].b <= t.a) r++;
			if (r < runs.length && t.a >= runs[r].a && t.b <= runs[r].b) continue;
			const bytes = Buffer.byteLength(piece.slice(t.a, t.b));
			if (t.kind === 'vue' && vues.length) charge(perSource, vues[0], bytes);
			else if (t.kind === 'app') charge(extra, `${GENERATED}@nextcloud/vite-config${SEP}appName and appVersion`, bytes);
			else charge(extra, wrap + SEP + (t.kind && t.kind !== 'code' && t.kind !== 'vue' ? t.kind : GLUE.wrap), bytes);
		}
		const pending = runs.map((run) => [run.a, run.b]);
		while (pending.length) {
			const [a, b] = pending.shift();
			const code = piece.slice(a, b);
			RE_INJECT.lastIndex = 0;
			const inj = RE_INJECT.exec(code);
			if (inj) {
				// The statement that injects is the plugin's; what follows it is
				// code of its own.
				const at = inj.index + inj[0].length;
				const end = literalEnd(code, at, code.length, code[at]);
				const stop = statementEnd(code, end);
				css.push({ text: code.slice(at + 1, end - 1) });
				const rest = code.slice(0, at + 1) + code.slice(end - 1, stop);
				const owner = ownerOfCode(inst, ctx, rest, []) ?? wrap + SEP + GLUE.wrap;
				css[css.length - 1].owner = owner.slice(0, owner.indexOf(SEP));
				charge(extra, owner, Buffer.byteLength(rest));
				if (stop < code.length) pending.unshift([a + stop, b]);
				continue;
			}
			const bytes = Buffer.byteLength(code);
			const tokensVue = vuePrints(code);
			let vue = tokensVue.reduce((n, t) => n + t.length, 0) >= PRINT_MIN
				? vues.find((i) => typeof contents[i] === 'string' && tokensVue.every((t) => occursIn(contents[i], t)))
				: undefined;
			// The compiler names a component after its file, and hoists the static
			// parts of its template, literals only, in front of its code.
			if (vue === undefined && vues.length) {
				const lits = glueTokens(code).filter((t) => t.kind === 'code').map((t) => code.slice(t.a, t.b));
				const named = vues.find((i) => lits.some((s) => /^["'`]/.test(s)
					&& literalValue(s) === path.basename(sources[i].split('?')[0], '.vue')));
				const hoisted = lits.length && lits.every((s) => /^["'`]/.test(s))
					? [...vues].reverse().find((i) => typeof contents[i] === 'string' && lits.every((s) => occursIn(contents[i], s.slice(1, -1))))
					: undefined;
				vue = named ?? hoisted;
			}
			if (vue !== undefined) {
				charge(perSource, vue, bytes);
				continue;
			}
			const owner = ownerOfCode(inst, ctx, code, around);
			if (owner) {
				charge(extra, owner, bytes);
				continue;
			}
			const parts = statements(code);
			if (parts.length > 1) {
				for (const [x, y] of parts) settle(g, from + a + x, from + a + y, vues, around);
				continue;
			}
			leftovers.push({ at: from + a, end: from + b, after: g.prev >= 0 ? sources[g.prev] : null });
		}
	};
	for (const g of gaps) {
		// Compiled Vue code between two segments of the same .vue.
		if (g.prev >= 0 && g.prev === g.next && isVue(sources[g.prev])) {
			charge(perSource, g.prev, Buffer.byteLength(text.slice(g.a, g.b)));
			continue;
		}
		const vues = [g.prev, g.next].filter((i) => i >= 0 && isVue(sources[i]));
		const start = leftovers.length;
		settle(g, g.a, g.b, vues, [neighbour(g.prev), neighbour(g.next)]);
		// Code no rule owns between two segments of the same module is that
		// module's own, written where its map has no mapping.
		if (g.prev >= 0 && g.prev === g.next) {
			for (const x of leftovers.splice(start)) charge(perSource, g.prev, Buffer.byteLength(text.slice(x.at, x.end)));
		}
	}

	// Byte offsets of what is left, in one pass over the file.
	leftovers.sort((x, y) => x.at - y.at);
	let charAt = 0;
	let byteAt = 0;
	let remainder = 0;
	const left = leftovers.map((x) => {
		byteAt += Buffer.byteLength(text.slice(charAt, x.at));
		charAt = x.at;
		const bytes = Buffer.byteLength(text.slice(x.at, x.end));
		remainder += bytes;
		// A cut between the two halves of a surrogate pair leaves a lone high
		// surrogate, whose escape in the JSON report jq refuses to read.
		let end = Math.min(x.end, x.at + 60);
		if (end < x.end && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
		return { offset: byteAt, bytes, after: x.after, text: text.slice(x.at, end) };
	});

	const out = new Map();
	for (const [idx, bytes] of perSource) {
		const name = sources[idx] ?? `<source ${idx}>`;
		out.set(name, (out.get(name) ?? 0) + bytes);
	}
	return { total: buf.length, remainder, sources: out, extra, css, scopes, leftovers: left, bundler: ctx.bundler };
}

// Split a source path into the package it belongs to and the path within it.
function originOf(src, bundler = 'the bundler') {
	const clean = src.split('?')[0].replace(/^\0/, '');
	const at = clean.lastIndexOf('node_modules/');
	if (at !== -1) {
		const rest = clean.slice(at + 'node_modules/'.length);
		const parts = rest.split('/');
		const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
		return { pkg, rel: rest.slice(pkg.length + 1) || parts[parts.length - 1] };
	}
	if (/^(?:virtual:|plugin-vue:|vite\/|commonjs-)/.test(clean) || clean.includes('\u0000')) {
		return { pkg: GENERATED + bundler, rel: clean };
	}
	return { pkg: APP_SOURCE, rel: clean.replace(/^(?:\.\.\/)+/, '') };
}

// == Attribution cache ==
// The findings charge several different sets of files to their packages - one
// entry's closure, the files every entry loads, the whole build - so each
// delivered file is decoded exactly once and summed as often as needed. The key
// of a module is package and path joined by NUL: a package name can contain a
// space ("generated by vite") and so can a source path. A file is cached by its
// full path, since a second build of the same app writes the same names.
export const SEP = '\u0000';
const rawCache = new Map();
const attrCache = new Map();
const scopeCache = new Map();

function rawAttr(dir, file) {
	const full = path.join(dir, file);
	let e = rawCache.get(full);
	if (!e) {
		const mapFile = findMap(dir, file);
		e = { mapped: mapFile !== null, ...attribute(dir, full, mapFile) };
		rawCache.set(full, e);
	}
	return e;
}

// Scope id -> the module key of its .vue, over every script of the directory:
// the plugin injects the CSS of all chunks from one of them.
function scopeIndex(dir) {
	let e = scopeCache.get(dir);
	if (!e) {
		e = new Map();
		for (const f of listFiles(dir).filter((x) => JS_EXT.has(path.extname(x)))) {
			const a = rawAttr(dir, f);
			for (const [hash, src] of a.scopes) {
				const { pkg, rel } = originOf(src, a.bundler);
				if (!e.has(hash)) e.set(hash, pkg + SEP + rel);
			}
		}
		scopeCache.set(dir, e);
	}
	return e;
}

export function attrOfFile(dir, file) {
	const full = path.join(dir, file);
	let e = attrCache.get(full);
	if (!e) {
		const a = rawAttr(dir, file);
		const modules = new Map();
		const add = (key, bytes) => modules.set(key, (modules.get(key) ?? 0) + bytes);
		for (const [src, bytes] of a.sources) {
			const { pkg, rel } = originOf(src, a.bundler);
			add(pkg + SEP + rel, bytes);
		}
		for (const [key, bytes] of a.extra) add(key, bytes);
		if (a.css.length) {
			const scopes = scopeIndex(dir);
			for (const c of a.css) {
				let rest = Buffer.byteLength(c.text);
				for (const rule of cssRules(c.text)) {
					const key = rule.hash && scopes.get(rule.hash);
					if (!key) continue;
					const bytes = Buffer.byteLength(c.text.slice(rule.a, rule.b));
					add(key, bytes);
					rest -= bytes;
				}
				add(c.owner + SEP + 'injected CSS', rest);
			}
		}
		e = {
			mapped: a.mapped,
			copied: a.copied ?? null,
			remainder: a.remainder,
			modules,
			leftovers: a.leftovers.map((x) => ({ file, ...x })),
		};
		attrCache.set(full, e);
	}
	return e;
}

// Sum the attribution of a set of files. perFile keeps which files a module
// appears in, which is what makes duplication inside one closure visible.
export function attrOfFiles(dir, files) {
	const perPkg = new Map();
	const perModule = new Map();
	const perFile = new Map();
	const leftovers = [];
	let attributed = 0;
	let remainder = 0;
	let mapped = 0;
	for (const f of files) {
		const a = attrOfFile(dir, f);
		remainder += a.remainder;
		leftovers.push(...a.leftovers);
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
	return { mapped, attributed, remainder, perPkg, perModule, perFile, leftovers };
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

// == Sources the maps carry ==
// A source map usually carries the sources it maps to, so the text of every
// delivered module can be read off it. A map built without them (webpack's
// nosources devtools) still names the module, and a module of a package then
// sits under node_modules in the checkout, given as root. Returns one entry per
// module, keyed like the attribution: pkg + SEP + rel -> { pkg, rel, content }.
function installedSource(root, src) {
	if (!root) return null;
	const clean = src.split('?')[0].replace(/^\0/, '');
	const at = clean.indexOf('node_modules/');
	if (at === -1) return null;
	const file = path.join(root, clean.slice(at));
	try {
		return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
	} catch {
		return null;
	}
}

export function mappedSources(dir, files, root = null) {
	const out = new Map();
	for (const f of files) {
		const mapFile = findMap(dir, f);
		if (!mapFile) continue;
		const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
		const contents = map.sourcesContent ?? [];
		const bundler = bundlerOf(installOf(dir), map, '');
		(map.sources ?? []).forEach((src, i) => {
			const { pkg, rel } = originOf(src, bundler);
			const key = pkg + SEP + rel;
			if (out.has(key)) return;
			const content = typeof contents[i] === 'string' ? contents[i] : installedSource(root, src);
			if (content !== null) out.set(key, { pkg, rel, content });
		});
	}
	return out;
}

// Where each delivered package was installed, as the maps name it: the path from
// the first node_modules of a source to the directory of its package, relative to
// the checkout. A package nested under those that need another version of it has
// one directory per copy the build delivers.
export function installDirs(dir, files) {
	const out = new Map();
	for (const f of files) {
		const mapFile = findMap(dir, f);
		if (!mapFile) continue;
		const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
		for (const src of map.sources ?? []) {
			const clean = src.split('?')[0].replace(/^\0/, '');
			const first = clean.indexOf('node_modules/');
			if (first === -1) continue;
			const { pkg } = originOf(src);
			const end = clean.lastIndexOf('node_modules/') + 'node_modules/'.length + pkg.length;
			if (!out.has(pkg)) out.set(pkg, new Set());
			out.get(pkg).add(clean.slice(first, end));
		}
	}
	return out;
}

// == Imports inside a package ==
// What a delivered module of a package imports from that same package: every
// relative specifier, resolved against the module's own path in the package.
// Returns module path -> the module paths it imports.
const RE_RELATIVE = /(?:^|[^.\w$])(?:import|from|require)\s*\(?\s*(["'`])(?!(?<=`)[^`\n]*\$\{)(\.\.?\/[^"'`\n]+)\1/g;

export function packageImports(sources, pkg) {
	const out = new Map();
	for (const { pkg: p, rel, content } of sources.values()) {
		if (p !== pkg) continue;
		const base = path.posix.dirname(rel);
		out.set(rel, new Set([...content.matchAll(RE_RELATIVE)]
			.map((m) => path.posix.normalize(path.posix.join(base, m[2])))));
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
// webpack and rspack build it as miniCssF(chunk id), a sum of the same form as
// .u, and keep the ids of the chunks that have a stylesheet in an object looked
// up by the id. Every chunk id the build loads, every key of such a lookup and
// every key of the name's own tables is tried, and a name only counts when the
// stylesheet it gives is present. The public path differs between the two
// runtimes, so a name is matched by its file name. A service worker's precache
// list names its files the same way. Returns stylesheet -> the scripts naming it.
const RE_CSS_LITERAL = /["'`]([^"'`\n]+\.css)["'`]/g;
const RE_ID_LOOKUP = /\{([^{}]*)\}\s*\)?\s*\[\s*[\w$]+\s*\]/g;
const RE_ID_KEY = /(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([\w$-]+))\s*:/g;

export function cssNamedBy(dir, jsFiles, cssFiles) {
	const byBase = new Map(cssFiles.map((f) => [path.posix.basename(f), f]));
	const texts = new Map(jsFiles.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
	const loaded = new Set();
	for (const text of texts.values()) {
		for (const m of text.matchAll(RE_CHUNK_LOAD)) loaded.add(m[1] ?? m[2] ?? m[3]);
	}
	const named = new Map();
	for (const [f, text] of texts) {
		const hit = new Set();
		RE_CSS_LITERAL.lastIndex = 0;
		let m;
		while ((m = RE_CSS_LITERAL.exec(text)) !== null) {
			const css = byBase.get(path.posix.basename(m[1]));
			if (css) hit.add(css);
		}
		for (const h of text.matchAll(RE_CSS_URL)) {
			const url = chunkUrl(text, h.index + h[0].length, h[1]);
			if (!url) continue;
			const ids = new Set([...loaded, ...url.ids]);
			for (const l of text.matchAll(RE_ID_LOOKUP)) {
				for (const k of l[1].matchAll(RE_ID_KEY)) ids.add(k[1] ?? k[2] ?? k[3]);
			}
			for (const id of ids) {
				const file = url.name(id);
				const css = file === null ? null : byBase.get(path.posix.basename(file));
				if (css) hit.add(css);
			}
		}
		for (const css of hit) named.set(css, [...(named.get(css) ?? []), f]);
	}
	return named;
}
