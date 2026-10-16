// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// bundler-config - which bundler an app builds with, which config it reads and
// where that config makes it write.
//
// A config is a program, and running it would need the app's node_modules. So it
// is read as text, and a value counts only where it is written out: a string, or a
// path.resolve/path.join of the config's own directory and strings. Anything the
// config computes is left unanswered, and the caller falls back on what it assumes
// without a config.
//
// Reads only. No node_modules, no network, no npm dependencies. Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';

// The bundler is not guessed from the output: the checkout says which toolchain
// is installed, and an app mid-migration says both. A config the build script
// passes with --config counts whatever its file is called, since many apps keep
// theirs under a name the bundler would not pick up by itself.
const CONFIGS = {
	vite: ['vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.ts'],
	webpack: ['webpack.config.js', 'webpack.config.mjs', 'webpack.config.cjs', 'webpack.config.ts'],
	rspack: ['rspack.config.js', 'rspack.config.mjs', 'rspack.config.cjs', 'rspack.config.ts'],
};
// The bundler as a command of its own, so vitest or webpack-cli is not taken for it.
const RE_BUNDLER_CMD = /(?:^|[\s/])(vite|webpack|rspack)(?=\s|$)/;
const RE_CONFIG_ARG = /(?:^|\s)(?:--config|-c)(?:=|\s+)(\S+)/;
const RE_RUN_SCRIPT = /\b(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g;

// The commands the build script runs, following the scripts it calls in turn.
function buildCommands(scripts) {
	const cmds = [];
	const seen = new Set();
	const visit = (name) => {
		if (seen.has(name) || typeof scripts[name] !== 'string') return;
		seen.add(name);
		for (const cmd of scripts[name].split(/&&|\|\||[;|&]/)) {
			cmds.push(cmd.trim());
			for (const m of cmd.matchAll(RE_RUN_SCRIPT)) visit(m[1]);
		}
	};
	visit('build');
	return cmds;
}

// The configs in the checkout, each with the bundler it belongs to, and the
// bundlers the build script runs.
export function bundlerConfigs(root, scripts) {
	const configs = [];
	const addConfig = (kind, file) => {
		if (!configs.some((c) => c.file === file)) configs.push({ kind, file });
	};
	const built = new Set();
	for (const cmd of buildCommands(scripts ?? {})) {
		const kind = cmd.match(RE_BUNDLER_CMD)?.[1];
		if (!kind) continue;
		built.add(kind);
		const arg = cmd.match(RE_CONFIG_ARG)?.[1].replace(/^["']|["']$/g, '');
		if (arg && fs.existsSync(path.join(root, arg))) addConfig(kind, path.posix.normalize(arg));
	}
	for (const [kind, names] of Object.entries(CONFIGS)) {
		for (const name of names) if (fs.existsSync(path.join(root, name))) addConfig(kind, name);
	}
	return { configs, built: [...built] };
}

// == Reading a config ==
// The text without its comments. Quotes are followed so that a // in a string, a
// URL most of all, is not taken for one.
function withoutComments(text) {
	let out = '';
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			out += ch;
			if (ch === '\\') out += text[++i] ?? '';
			else if (ch === quote) quote = null;
		} else if (ch === '\'' || ch === '"' || ch === '`') {
			quote = ch;
			out += ch;
		} else if (text.startsWith('/*', i)) {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 1;
			out += ' ';
		} else if (text.startsWith('//', i)) {
			while (i < text.length && text[i] !== '\n') i++;
			out += '\n';
		} else {
			out += ch;
		}
	}
	return out;
}

// Where the expression starting at i ends: at the first comma, closing bracket or
// semicolon outside the brackets and strings it opens itself.
function exprEnd(text, i) {
	let depth = 0;
	let quote = null;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === '\\') i++;
			else if (ch === quote) quote = null;
		} else if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
		else if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') {
			if (depth-- === 0) return i;
		} else if ((ch === ',' || ch === ';') && depth === 0) return i;
	}
	return i;
}

// The properties of the object literal whose opening brace is at open, as written
// at its own level: { key: expr }. A shorthand or a spread has no value to read and
// is skipped.
function properties(text, open) {
	const props = [];
	let i = open + 1;
	while (i < text.length) {
		const m = /^\s*(?:(['"])([^'"\n]+)\1|([A-Za-z_$][\w$]*))\s*:/.exec(text.slice(i, i + 256));
		if (m) {
			const start = i + m[0].length;
			const end = exprEnd(text, start);
			props.push({ key: m[2] ?? m[3], expr: text.slice(start, end).trim() });
			i = end;
		} else {
			i = exprEnd(text, i);
		}
		if (text[i] !== ',') break;
		i++;
	}
	return props;
}

// The arguments of a call whose opening parenthesis is at open, and where its
// closing one is.
function callArgs(text, open) {
	const args = [];
	let i = open + 1;
	for (;;) {
		const end = exprEnd(text, i);
		const arg = text.slice(i, end).trim();
		if (arg) args.push(arg);
		if (text[end] !== ',') return { args, close: end };
		i = end + 1;
	}
}

const RE_STRING = /^(['"`])([^'"`\\$\n]*)\1$/;
const RE_CONFIG_DIR = /^(?:__dirname|import\.meta\.dirname)$/;
const RE_URL_OF_CONFIG = /^fileURLToPath\(\s*new\s+URL\(\s*(['"`])([^'"`\\$\n]*)\1\s*,\s*import\.meta\.url\s*\)\s*\)$/;

// A path the expression writes out, relative to the app root, or null where the
// config computes it. A relative path is taken from the app root, which is where
// the bundler runs; __dirname and import.meta.dirname are the config's directory.
// A path outside the app, or the app root itself, is no directory of its own.
function literalPath(expr, root, configDir) {
	let base = root;
	let parts;
	const str = RE_STRING.exec(expr);
	const url = RE_URL_OF_CONFIG.exec(expr);
	const call = /^(?:path\.)?(?:resolve|join)\s*\(/.exec(expr);
	if (str) {
		parts = [str[2]];
	} else if (url) {
		base = configDir;
		parts = [url[2]];
	} else if (call) {
		const { args, close } = callArgs(expr, call[0].length - 1);
		if (close !== expr.length - 1 || expr[close] !== ')') return null;
		if (args.length && RE_CONFIG_DIR.test(args[0])) {
			base = configDir;
			args.shift();
		} else if (args.length && /^process\.cwd\(\s*\)$/.test(args[0])) {
			args.shift();
		}
		parts = args.map((a) => RE_STRING.exec(a)?.[2] ?? null);
		if (parts.includes(null)) return null;
	} else {
		return null;
	}
	if (parts.some((p) => path.isAbsolute(p))) return null;
	const rel = path.relative(root, path.resolve(base, ...parts)).split(path.sep).join('/');
	if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
	return rel;
}

const readConfig = (root, file) => {
	try {
		return withoutComments(fs.readFileSync(path.join(root, file), 'utf8'));
	} catch {
		return null;
	}
};

// == Output directories ==
// webpack and rspack write to output.path, vite to build.outDir. Each place the key
// is written counts, a config that exports several builds has one for each. Where
// one of them is computed, the directories are not known, and neither are they for
// a config that leaves the key to a shared base config. vite takes outDir from its
// own root, so a config that moves the root leaves them open as well.
const OUTPUT_KEYS = {
	webpack: 'output.path',
	rspack: 'output.path',
	vite: 'build.outDir',
};

function outputExprs(text, kind) {
	const exprs = [];
	if (kind === 'vite') {
		if (/\broot\s*:/.test(text)) return [null];
		for (const m of text.matchAll(/\boutDir\s*:/g)) {
			const start = m.index + m[0].length;
			exprs.push(text.slice(start, exprEnd(text, start)).trim());
		}
		return exprs;
	}
	for (const m of text.matchAll(/\boutput\s*:\s*\{/g)) {
		for (const p of properties(text, m.index + m[0].length - 1)) if (p.key === 'path') exprs.push(p.expr);
	}
	for (const m of text.matchAll(/\boutput\.path\s*=(?!=)/g)) {
		const start = m.index + m[0].length;
		exprs.push(text.slice(start, exprEnd(text, start)).trim());
	}
	return exprs;
}

export function outputDirs(root, configs) {
	const dirs = [];
	const from = [];
	for (const c of configs) {
		const text = readConfig(root, c.file);
		if (text === null) continue;
		const exprs = outputExprs(text, c.kind);
		if (!exprs.length) continue;
		const configDir = path.join(root, path.posix.dirname(c.file));
		for (const expr of exprs) {
			const dir = expr === null ? null : literalPath(expr, root, configDir);
			if (dir === null) return null;
			if (!dirs.includes(dir)) dirs.push(dir);
		}
		from.push({ file: c.file, key: OUTPUT_KEYS[c.kind] });
	}
	return dirs.length ? { dirs, from } : null;
}

// == Aliases ==
// resolve.alias in all three, as an object of names and the directories they stand
// for. A webpack name that ends in $ matches only the name itself, not a path below it.
export function configAliases(root, configs) {
	const out = [];
	for (const c of configs) {
		const text = readConfig(root, c.file);
		if (text === null) continue;
		const configDir = path.join(root, path.posix.dirname(c.file));
		for (const m of text.matchAll(/\balias\s*:\s*\{/g)) {
			for (const p of properties(text, m.index + m[0].length - 1)) {
				const target = literalPath(p.expr, root, configDir);
				if (target === null) continue;
				const exact = p.key.endsWith('$');
				const key = exact ? p.key.slice(0, -1) : p.key;
				if (key && !out.some((a) => a.key === key)) out.push({ key, target, exact, file: c.file });
			}
		}
	}
	return out;
}
