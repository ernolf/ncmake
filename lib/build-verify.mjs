#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// build-verify - does the build output in the checkout come from the source in it.
//
// Every other analyser in this series reads what is there and is done in seconds.
// This one rebuilds: it copies the tracked files into a throwaway tree, installs
// from the lockfile, runs the app's own build script and holds what comes out
// against the build output in the checkout, file by file.
//
// What a comparison like this must not overstate is the difference itself. A
// toolchain is free to write a random hash, a timestamp or an absolute path into
// its output, and then two builds of one source differ without anything being
// wrong. So the build runs twice by default: a file that differs between two runs
// of the same source is named as not reproducible and nothing is concluded from
// it. A file both runs wrote byte-identically, and that still differs from the one
// in the checkout, is the finding - that output did not come from this source.
//
// Where a difference is confined to what the build writes about itself - the
// content hash in a file name, that same hash in an import pointing at it, the
// absolute path a source map records - the file is reported as equal in content
// and named as differing in build metadata, because that says nothing about the
// code either.
//
// It installs and builds, so unlike the rest of the series it needs the network
// and takes minutes. It writes inside its scratch directory only: the app is read
// and never written to, and nothing it leaves behind has to be cleaned up. Needs
// git and npm next to Node 18 or newer, and no npm dependency of its own.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	LEGEND,
	cut,
	howToRun,
	num,
	plural,
	renderFindings,
	shortPath,
	sortFindings,
	table,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',           // the app checkout to verify
	build: 'js,css',    // the directories the build writes, the usual Nextcloud app layout
	scratch: '',        // where the rebuild happens (default: the system temp directory)
	once: false,        // build once, leaving the reproducibility question open
	keep: false,        // keep the scratch tree for a look at the rebuilt files
	top: 12,            // list items per finding and rows per table, 0 = all
	details: false,     // every table; the default is the verdict alone
	json: false,
};

// How vite and rollup write a content hash into a file name (name-HASH.ext), and
// how webpack does it (name.HASH.ext). Eight characters or more, so a short word is
// not taken for a hash; a long word still can be, which is why a pairing by this
// pattern is accepted only where it is unambiguous on both sides.
const RE_HASH_DASH = /-[A-Za-z0-9_-]{8,}(?=\.)/;
const RE_HASH_DOT = /\.[0-9a-fA-F]{8,32}(?=\.)/;

// Lines of a failed command's output to print. The full log stays in the scratch
// directory, which is kept whenever a step fails.
const LOG_TAIL = 40;

// Caches the bundlers keep inside node_modules. The second build has to start as
// pristine as the first, or the probe measures the cache instead of the toolchain.
const BUILD_CACHES = ['node_modules/.vite', 'node_modules/.cache'];

// == Command line ==
function usage() {
	return `build-verify - does the build output in the checkout come from the source in it

Usage: build-verify.mjs [options] [dir]

  dir                   the app checkout to verify (default: ${defaults.dir})

Options:
  --build=DIR[,DIR]     the directories the build writes (default: ${defaults.build})
  --scratch=DIR         where the rebuild happens (default: the system temp directory)
  --once                build once instead of twice, which leaves open whether a
                        difference comes from the source or from the toolchain
  --keep                keep the scratch tree instead of removing it
  --top=N               list items per finding and rows per table, 0 for all (default: ${defaults.top})
  --details             print every table behind the findings
  --json                emit the full result as JSON and nothing else
  -h, --help            this text

The rebuild happens in a copy of the tracked files. The checkout is read, never
written to, and the build output in it is left where it is.`;
}

function die(msg) {
	process.stderr.write(`build-verify: ${msg}\n`);
	process.exit(1);
}

// A condition the run cannot go on from, raised once the scratch directory exists:
// unwinding leaves the logs in place, which process.exit would skip.
function fail(msg) {
	const e = new Error(msg);
	e.expected = true;
	throw e;
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
			case '--once': opt.once = true; break;
			case '--keep': opt.keep = true; break;
			case '--build': opt.build = val; break;
			case '--scratch': opt.scratch = val; break;
			case '--top': opt.top = Number(val); break;
			default:
				if (key.startsWith('-')) die(`unknown option: ${key}`);
				if (dir !== null) die(`more than one directory given: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (!Number.isInteger(opt.top) || opt.top < 0) die('--top needs a non-negative integer');
	const dirs = opt.build.split(',').map((s) => s.trim().replace(/[\\/]+$/, '')).filter(Boolean);
	if (!dirs.length) die('--build needs at least one directory');
	if (dirs.some((d) => path.isAbsolute(d) || d.split(/[\\/]/).includes('..'))) {
		die('--build takes directories inside the checkout');
	}
	opt.dirs = [...new Set(dirs.map((d) => d.split('\\').join('/')))];
	return opt;
}

// == The rebuild ==
// Install and build take minutes, so every step says what it is doing while it
// runs. All of that goes to stderr: with --json, stdout carries nothing but JSON.
const note = (s) => process.stderr.write(`${s}\n`);

// git is where the checkout says what belongs to it. The tracked files are the
// source a build has to work from; everything else in the working tree - installed
// dependencies, an earlier build, editor leftovers - is not copied, and that is
// what makes the rebuilt tree pristine. safe.directory keeps git from refusing a
// checkout whose owner differs from the user inside the container.
function git(root, args) {
	const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', root, ...args],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return r.error || r.status !== 0 ? null : r.stdout;
}

function trackedFiles(root) {
	const out = git(root, ['ls-files', '-z']);
	return out === null ? null : out.split('\0').filter(Boolean);
}

// Uncommitted changes to tracked files. The rebuild uses the working tree, so this
// decides whether the report is about the checkout or about the last commit.
function modifiedTracked(root) {
	const out = git(root, ['status', '--porcelain', '--untracked-files=no']);
	return out === null ? null : out.split('\n').filter((l) => l.trim()).length;
}

// Whether .gitignore covers the directory. The trailing slash makes a
// directory-only pattern match even where the directory does not exist.
function isIgnored(root, dir) {
	const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', root, 'check-ignore', '-q', `${dir}/`],
		{ encoding: 'utf8' });
	return r.status === 0;
}

// A tracked symlink is copied as the content it points at, which is what a build
// reads through it anyway.
function copyTracked(root, files, dest, skip) {
	let n = 0;
	for (const rel of files) {
		if (skip.some((d) => rel === d || rel.startsWith(`${d}/`))) continue;
		const from = path.join(root, rel);
		if (!fs.existsSync(from)) continue;   // tracked, and deleted in the working tree
		const to = path.join(dest, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(from, to);
		n++;
	}
	return n;
}

// One step of the rebuild. Its output is captured rather than streamed: a passing
// step prints nothing, a failing one prints its tail, and the full log is written
// beside the tree either way. The command is a fixed literal, so running it through
// a shell raises no quoting question and finds npm where it is a wrapper script
// rather than an executable.
function step(name, cmd, cwd, logDir) {
	const started = Date.now();
	process.stderr.write(`  ${name} ...`);
	const r = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024 });
	const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
	const output = r.error ? `${r.error.message}\n` : `${r.stdout ?? ''}${r.stderr ?? ''}`;
	const log = `${name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.log`;
	fs.writeFileSync(path.join(logDir, log), output);
	const code = r.error ? -1 : (r.status ?? -1);
	process.stderr.write(` ${seconds} s${code === 0 ? '' : ` (exit ${code})`}\n`);
	return { name, cmd, log, seconds, code, output };
}

function printTail(s) {
	const lines = s.output.replace(/\n+$/, '').split('\n');
	for (const l of lines.slice(Math.max(0, lines.length - LOG_TAIL))) process.stderr.write(`    ${l}\n`);
}

// The tool versions that produced the rebuild, for the record: a rebuild is only
// comparable to one made with the same toolchain.
function version(cmd) {
	const r = spawnSync(cmd, { encoding: 'utf8', shell: true });
	return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

// Move the output aside, so the next build starts on an empty directory and both
// runs stay comparable afterwards.
function snapshot(tree, dirs, dest) {
	for (const d of dirs) {
		const from = path.join(tree, d);
		if (!fs.existsSync(from)) continue;
		const to = path.join(dest, d);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.renameSync(from, to);
	}
	return dest;
}

function listFiles(dir) {
	const out = [];
	if (!fs.existsSync(dir)) return out;
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

const isInside = (root, p) => {
	const rel = path.relative(root, p);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// == Pairing ==
// A content hash in the file name means a changed file arrives under a new name,
// and a comparison by name alone would report one file missing and another extra
// where one file differs. So names are paired exactly first, and what is left over
// is paired by the name with its hash segment replaced - accepted only where that
// leaves exactly one candidate on either side, because an ordinary word of eight
// characters looks the same to the pattern.
function keyOf(rel) {
	const dir = path.posix.dirname(rel);
	const base = path.posix.basename(rel).replace(RE_HASH_DASH, '-#').replace(RE_HASH_DOT, '.#');
	return dir === '.' ? base : `${dir}/${base}`;
}

function hashToken(rel) {
	const base = path.posix.basename(rel);
	const m = RE_HASH_DASH.exec(base) ?? RE_HASH_DOT.exec(base);
	return m ? m[0].slice(1) : null;
}

function groupByKey(list) {
	const m = new Map();
	for (const f of list) {
		const k = keyOf(f);
		if (!m.has(k)) m.set(k, []);
		m.get(k).push(f);
	}
	return m;
}

function pairNames(left, right) {
	const pairs = [];
	const rightSet = new Set(right);
	const leftSet = new Set(left);
	for (const f of left) if (rightSet.has(f)) pairs.push({ left: f, right: f, renamed: false });
	const restLeft = groupByKey(left.filter((f) => !rightSet.has(f)));
	const restRight = groupByKey(right.filter((f) => !leftSet.has(f)));
	const leftOnly = [];
	const rightOnly = [];
	for (const [k, ls] of restLeft) {
		const rs = restRight.get(k);
		if (ls.length === 1 && rs && rs.length === 1) {
			pairs.push({ left: ls[0], right: rs[0], renamed: true });
			restRight.delete(k);
		} else {
			leftOnly.push(...ls);
		}
	}
	for (const rs of restRight.values()) rightOnly.push(...rs);
	return { pairs, leftOnly: leftOnly.sort(), rightOnly: rightOnly.sort() };
}

// == Comparing one file ==
const isText = (buf) => !buf.subarray(0, 8000).includes(0);

const replaceAll = (text, from, to) => (from ? text.split(from).join(to) : text);

const maskHashes = (text, tokens) => tokens.reduce((t, token) => replaceAll(t, token, '#hash#'), text);

const maskRoots = (text, roots) => roots.reduce((t, root) => replaceAll(t, root, '#root#'), text);

// Every spelling a directory takes inside build output: as the platform writes it,
// with forward slashes, and escaped as a string literal. The longest first, so a
// path is masked before a prefix of it is.
function rootForms(dirs) {
	const forms = [];
	for (const d of dirs) {
		for (const f of [d, d.split('\\').join('/'), JSON.stringify(d).slice(1, -1)]) {
			if (f && !forms.includes(f)) forms.push(f);
		}
	}
	return forms.sort((a, b) => b.length - a.length);
}

// A source map is compared as the map it is, not as the bytes it is written in:
// what the code was compiled from (mappings, names, sourcesContent) decides, while
// the paths it records its sources under are build metadata - they hold the
// directory the build ran in.
//
// Those paths are the one place where masking the directories of this run is not
// enough: a committed map was written on another machine, under a path nothing here
// knows. It is a difference in the paths all the same, as long as the map carries
// the sources themselves - then sourcesContent decides which source a path meant,
// and the path adds nothing. A map without sourcesContent has only the path to say
// what it was compiled from, and a difference in it is not read as metadata.
//
// Returns null where the map is no readable JSON or the code itself differs, so the
// caller falls back to the plain text comparison.
function compareMap(a, b, ctx) {
	let ma;
	let mb;
	try {
		ma = JSON.parse(a.toString('utf8'));
		mb = JSON.parse(b.toString('utf8'));
	} catch {
		return null;
	}
	const code = (m) => JSON.stringify({
		mappings: m.mappings ?? '',
		names: m.names ?? [],
		sourcesContent: m.sourcesContent ?? [],
		file: maskHashes(String(m.file ?? ''), ctx.tokens),
	});
	if (code(ma) !== code(mb)) return null;

	const reasons = [];
	const sources = (m) => (m.sources ?? [])
		.map((s) => maskRoots(maskHashes(String(s), ctx.tokens), ctx.roots).replace(/^(?:\.\.\/)+/, ''));
	if (JSON.stringify(sources(ma)) !== JSON.stringify(sources(mb))) {
		const carried = ma.sourcesContent;
		if (!Array.isArray(carried) || !carried.length || carried.length !== (ma.sources ?? []).length) {
			return null;
		}
		reasons.push('the paths a source map records its sources under');
	}
	if (String(ma.file ?? '') !== String(mb.file ?? '')) {
		reasons.push('the hashed file name a source map belongs to');
	}
	if (!reasons.length) reasons.push('the way a source map is written out');
	return { state: 'metadata', reasons };
}

// Equal, equal but for what the build writes about itself, or different. Nothing
// here judges reproducibility; that is the second build's answer.
function compareFile(aPath, bPath, rel, ctx) {
	const a = fs.readFileSync(aPath);
	const b = fs.readFileSync(bPath);
	if (a.equals(b)) return { state: 'identical', reasons: [] };
	if (rel.endsWith('.map')) {
		const m = compareMap(a, b, ctx);
		if (m) return m;
	}
	if (!isText(a) || !isText(b)) return { state: 'differs', reasons: [] };
	const ta = a.toString('utf8');
	const tb = b.toString('utf8');
	if (maskHashes(ta, ctx.tokens) === maskHashes(tb, ctx.tokens)) {
		return { state: 'metadata', reasons: ['the content hashes in the file names it refers to'] };
	}
	if (maskRoots(maskHashes(ta, ctx.tokens), ctx.roots) === maskRoots(maskHashes(tb, ctx.tokens), ctx.roots)) {
		return { state: 'metadata', reasons: ['the absolute path of the directory the build ran in'] };
	}
	return { state: 'differs', reasons: [] };
}

// == The comparison, per output directory ==
const STATE = {
	identical: 'identical',
	metadata: 'build metadata',
	differs: 'differing',
	unstable: 'not reproducible',
	missing: 'checkout only',
	extra: 'rebuild only',
};

// Where the output lives decides how a difference reads: a committed one ships out
// of git, one the checkout ignores ships out of the working tree through make dist,
// and where the directory is absent there is nothing to compare at all.
const KIND = {
	committed: 'committed',
	ignored: 'in .gitignore',
	untracked: 'untracked',
	absent: 'absent',
};

function compareDir(dir, c) {
	const have = path.join(c.root, dir);
	const built = path.join(c.out1, dir);
	const inCheckout = listFiles(have);
	const rebuilt = listFiles(built);
	const second = c.out2 ? listFiles(path.join(c.out2, dir)) : null;
	const kind = () => {
		if (!fs.existsSync(have)) return 'absent';
		if (c.tracked.some((f) => f.startsWith(`${dir}/`))) return 'committed';
		return isIgnored(c.root, dir) ? 'ignored' : 'untracked';
	};
	const d = {
		dir,
		kind: kind(),
		inCheckout: inCheckout.length,
		rebuilt: rebuilt.length,
		namesStable: second === null ? null : rebuilt.join('\n') === second.join('\n'),
		files: [],
	};

	// The hash of every renamed pair, from both sides: the hash in a file name is
	// also in every import that points at that file, so masking the name alone
	// would leave the references differing.
	const { pairs, leftOnly, rightOnly } = pairNames(inCheckout, rebuilt);
	const tokens = [...c.tokens];
	for (const p of pairs.filter((x) => x.renamed)) {
		for (const t of [hashToken(p.left), hashToken(p.right)]) if (t && !tokens.includes(t)) tokens.push(t);
	}
	const ctx = { tokens, roots: c.roots };

	for (const p of pairs) {
		const cmp = compareFile(path.join(have, p.left), path.join(built, p.right), p.left, ctx);
		// A file the two builds wrote differently carries no comparison with the
		// checkout: that it matches one of the two says nothing.
		const stable = second === null ? null
			: second.includes(p.right) && fs.readFileSync(path.join(built, p.right))
				.equals(fs.readFileSync(path.join(c.out2, dir, p.right)));
		d.files.push({
			dir,
			path: p.left,
			rebuiltPath: p.renamed ? p.right : null,
			state: stable === false ? 'unstable' : cmp.state,
			reasons: stable === false ? [] : cmp.reasons,
			stable,
			bytes: fs.statSync(path.join(have, p.left)).size,
			rebuiltBytes: fs.statSync(path.join(built, p.right)).size,
		});
	}
	for (const f of leftOnly) {
		d.files.push({
			dir, path: f, rebuiltPath: null, state: 'missing', reasons: [], stable: null,
			bytes: fs.statSync(path.join(have, f)).size, rebuiltBytes: null,
		});
	}
	for (const f of rightOnly) {
		d.files.push({
			dir, path: f, rebuiltPath: null, state: 'extra', reasons: [], stable: null,
			bytes: null, rebuiltBytes: fs.statSync(path.join(built, f)).size,
		});
	}
	d.counts = Object.fromEntries(Object.keys(STATE).map((k) => [k, d.files.filter((f) => f.state === k).length]));
	return d;
}

// == The run ==
function run(opt) {
	const root = path.resolve(opt.dir);
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`not a directory: ${opt.dir}`);
	const pkgPath = path.join(root, 'package.json');
	if (!fs.existsSync(pkgPath)) die(`no package.json in ${shortPath(root)}, so there is no build to verify`);
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	} catch (e) {
		die(`the package.json in ${shortPath(root)} is not readable JSON: ${e.message}`);
	}
	if (!pkg.scripts?.build) die('package.json declares no build script, so there is nothing to rebuild');

	const tracked = trackedFiles(root);
	if (tracked === null) {
		die(`git cannot read ${shortPath(root)}, and the rebuild needs the tracked files (a git checkout?)`);
	}
	if (!tracked.length) die(`git reports no tracked file in ${shortPath(root)}, so there is nothing to build`);
	if (!tracked.includes('package.json')) {
		die('package.json is not tracked, so a fresh clone would not have it and the rebuild cannot use it');
	}

	const base = opt.scratch ? path.resolve(opt.scratch) : os.tmpdir();
	if (isInside(root, base)) die('--scratch has to be outside the checkout, so the rebuild cannot reach the app');
	if (!fs.existsSync(base)) die(`no such directory: ${shortPath(base)}`);
	const scratch = fs.mkdtempSync(path.join(base, 'ncmake-build-verify-'));
	const tree = path.join(scratch, 'tree');
	let done = false;

	const r = {
		tool: 'build-verify',
		root,
		package: { name: pkg.name ?? null, version: pkg.version ?? null },
		buildScript: pkg.scripts.build,
		scratch,
		probe: !opt.once,
		runtime: { node: process.version, npm: version('npm --version'), git: version('git --version') },
		worktree: { tracked: tracked.length, copied: 0, modified: modifiedTracked(root) },
		steps: [],
		dirs: [],
		files: [],
		findings: [],
	};

	try {
		note(`build-verify  rebuilding ${shortPath(root)} in ${scratch}`);
		r.worktree.copied = copyTracked(root, tracked, tree, opt.dirs);
		const left = r.worktree.tracked - r.worktree.copied;
		note(`  ${plural(r.worktree.copied, 'tracked file copied', 'tracked files copied')}`
			+ `${left ? `, ${num(left)} left out as build output` : ''}`);

		const lock = fs.existsSync(path.join(tree, 'package-lock.json'));
		const install = step(lock ? 'npm ci' : 'npm install', lock ? 'npm ci' : 'npm install', tree, scratch);
		r.steps.push(install);
		if (install.code !== 0) {
			printTail(install);
			fail(`${install.name} failed (exit ${install.code}) on the tracked files alone`);
		}

		// The build has to create its output directories itself, or a file no build
		// writes any more would look as if one had.
		for (const d of opt.dirs) fs.rmSync(path.join(tree, d), { recursive: true, force: true });
		const first = step('npm run build', 'npm run build', tree, scratch);
		r.steps.push(first);
		if (first.code !== 0) {
			printTail(first);
			fail(`npm run build failed (exit ${first.code}) on the tracked files alone`);
		}
		const out1 = snapshot(tree, opt.dirs, path.join(scratch, 'out1'));

		let out2 = null;
		if (!opt.once) {
			for (const c of BUILD_CACHES) fs.rmSync(path.join(tree, c), { recursive: true, force: true });
			for (const d of opt.dirs) fs.rmSync(path.join(tree, d), { recursive: true, force: true });
			const again = step('npm run build (again)', 'npm run build', tree, scratch);
			r.steps.push(again);
			if (again.code !== 0) {
				printTail(again);
				fail(`the second npm run build failed (exit ${again.code}) where the first one succeeded`);
			}
			out2 = snapshot(tree, opt.dirs, path.join(scratch, 'out2'));
		}

		// Both directories occur in the absolute paths a build writes into its
		// output, and the report has to read the same either way round.
		const ctx = { root, out1, out2, tracked, tokens: [], roots: rootForms([tree, root]) };
		r.dirs = opt.dirs.map((d) => compareDir(d, ctx)).filter((d) => d.inCheckout || d.rebuilt);
		r.files = r.dirs.flatMap((d) => d.files);
		r.counts = Object.fromEntries(Object.keys(STATE)
			.map((k) => [k, r.dirs.reduce((n, d) => n + d.counts[k], 0)]));
		r.seconds = Number(r.steps.reduce((n, s) => n + s.seconds, 0).toFixed(1));
		r.findings = findings(r, opt);
		done = true;
		return r;
	} finally {
		r.kept = opt.keep || !done;
		if (r.kept) note(`  scratch tree kept, logs beside it: ${scratch}`);
		else fs.rmSync(scratch, { recursive: true, force: true });
	}
}

// == Findings ==
// The verdict rests on one distinction: a difference between two builds of the same
// source belongs to the toolchain, a difference the toolchain reproduces belongs to
// the output. Where the second build was not run, the question is named as open
// instead of answered.
function findings(r, opt) {
	const out = [];
	const add = (level, id, lines) => out.push({ level, id, lines });
	const items = (files) => {
		const shown = cut(files, opt.top);
		const lines = shown.rows.map((f) => `  ${f.dir}/${f.path}`);
		if (shown.hidden) lines.push(`  ... ${plural(shown.hidden, 'further file', 'further files')} not listed`);
		return lines;
	};
	const label = (list) => list.map((d) => `${d.dir}/`).join(' and ');
	// A directory the checkout does not have holds nothing, so every file of the
	// rebuild would read as one file too many. Only what could be compared is.
	const compared = r.dirs.filter((d) => d.kind !== 'absent');
	const comparable = (f) => compared.some((d) => d.dir === f.dir);
	const committed = compared.some((d) => d.kind === 'committed');
	const remedy = committed
		? 'A build, and a commit of what it writes, brings the two back together.'
		: 'make build brings the output in the working tree up to date.';

	// -- the one statement every run makes --
	add('ok', 'pristine-build', [
		`${r.steps[0].name} and npm run build succeed on the tracked files alone`
		+ `${r.probe ? ', twice' : ''}, in ${num(r.seconds)} s.`,
		'  Nothing else was in the tree, which is the state a fresh clone and CI build in, so a'
		+ ' build that needs a leftover from an earlier one would have failed here.',
	]);

	const differing = r.files.filter((f) => f.state === 'differs' && comparable(f));
	const reproduced = differing.filter((f) => f.stable === true);
	const open = differing.filter((f) => f.stable === null);

	// -- the finding this target exists for --
	if (reproduced.length) {
		add('warn', 'not-from-this-source', [
			`${plural(reproduced.length, 'file does', 'files do')} not match what this source builds:`,
			...items(reproduced),
			'  Both builds of the source in this checkout wrote those bytes identically, so the'
			+ ' difference is not a toolchain that fails to reproduce itself: what is in the'
			+ ' checkout was built from something else.',
			`  ${remedy}`,
		]);
	}
	if (open.length) {
		add('warn', 'differs-probe-skipped', [
			`${plural(open.length, 'file differs', 'files differ')} from what this source builds, and with`
			+ ' --once it cannot be said whether the source or the toolchain is the reason:',
			...items(open),
			'  Without a second build there is nothing to tell a stale output from a build that never'
			+ ' writes the same bytes twice. Run it without --once for that answer.',
		]);
	}

	const missing = r.files.filter((f) => f.state === 'missing' && comparable(f));
	if (missing.length) {
		add('warn', 'not-produced', [
			`${plural(missing.length, 'file is', 'files are')} in ${label(r.dirs.filter((d) => d.counts.missing))}`
			+ ' that the build does not produce:',
			...items(missing),
			'  A file no build writes any more is the remains of an earlier one. It still ships, it is'
			+ ' loaded by nothing this source refers to, and it holds whatever it held when it was'
			+ ' last written.',
			`  ${committed
				? 'Only removing it from git removes it from a release.'
				: 'make dist-clean, then make build, leaves the directory with what this source produces.'}`,
		]);
	}

	const extra = r.files.filter((f) => f.state === 'extra' && comparable(f));
	if (extra.length) {
		add('warn', 'not-in-the-checkout', [
			`The build produces ${plural(extra.length, 'file', 'files')} that`
			+ ` ${label(r.dirs.filter((d) => d.counts.extra))} does not hold:`,
			...items(extra),
			committed
				? '  They belong to the output and are not committed, so a release built out of git alone'
				+ ' is missing them, and whatever loads them is broken in it.'
				: '  The output in the working tree is older than this source, so what the app delivers is'
				+ ' not what this source builds.',
			`  ${remedy}`,
		]);
	}

	const unstable = r.files.filter((f) => f.state === 'unstable' && comparable(f));
	const renaming = r.dirs.filter((d) => d.namesStable === false);
	if (unstable.length || renaming.length) {
		const lines = [];
		if (unstable.length) {
			lines.push(`${plural(unstable.length, 'file is', 'files are')} not reproducible: two builds of the`
				+ ' same source wrote different bytes.');
			lines.push(...items(unstable));
		}
		if (renaming.length) {
			lines.push(`The two builds do not even agree on the file names in ${label(renaming)}.`);
		}
		lines.push('  Nothing about this checkout follows from a difference in them, so they carry no'
			+ ' verdict above. What a build writes that it does not derive from the source - a'
			+ ' timestamp, a random name - is where this comes from.');
		add('info', 'not-reproducible', lines);
	}

	const meta = r.files.filter((f) => f.state === 'metadata' && comparable(f));
	if (meta.length) {
		add('info', 'build-metadata', [
			`${plural(meta.length, 'file differs', 'files differ')} in what the build writes about itself`
			+ ` only: ${[...new Set(meta.flatMap((f) => f.reasons))].join('; ')}.`,
			'  Their content is what this source builds, so nothing follows for the code. A hashed name'
			+ ' changes with every build that changes the file it names, which is what the hash is'
			+ ' there for.',
		]);
	}

	// -- what could be compared at all --
	const absent = r.dirs.filter((d) => d.kind === 'absent');
	if (absent.length) {
		add('info', 'nothing-to-compare', [
			`No ${label(absent)} in ${shortPath(r.root)}, and the build writes`
			+ ` ${plural(absent.reduce((n, d) => n + d.rebuilt, 0), 'file', 'files')} there.`,
			'  There is nothing to compare against, so this run says no more than that the build works.'
			+ ' make build writes the directory.',
		]);
	}
	// A file both builds wrote the same way is the only one a verdict can rest on.
	const confirmed = r.files.filter((f) => comparable(f) && ['identical', 'metadata'].includes(f.state));
	if (!r.dirs.length) {
		add('info', 'no-output-anywhere', [
			`Neither the checkout nor the build has ${opt.dirs.map((d) => `${d}/`).join(' or ')}, so not a`
			+ ' file could be compared.',
			'  --build=DIR names the directories this build writes, where they are not the ones above.',
		]);
	} else if (confirmed.length && !reproduced.length && !open.length && !missing.length && !extra.length) {
		add('ok', 'reproduced', [
			`Every file in ${label(compared)} is what this source builds`
			+ `${meta.length ? ', apart from the build metadata named below' : ''}`
			+ `${unstable.length ? `, leaving aside the ${plural(unstable.length, 'file', 'files')} above that no build reproduces` : ''}.`,
			`  ${compared.map((d) => `${d.dir}/: ${plural(d.inCheckout, 'file', 'files')}, ${KIND[d.kind]}`).join('; ')}.`,
		]);
	}

	if (r.worktree.modified) {
		add('info', 'uncommitted-changes', [
			`${plural(r.worktree.modified, 'tracked file has', 'tracked files have')} uncommitted changes, and`
			+ ' the rebuild used the working tree as it is, not the last commit.',
			'  So this says whether the output matches the source you are looking at, which is what a'
			+ ' build would do. Against HEAD the answer can be another one.',
		]);
	}

	return sortFindings(out);
}

// == Human-readable output ==
const how = howToRun('BUILD_VERIFY_CMDLINE', 'build-verify.mjs %s');

function renderSummary(r) {
	const out = [];
	const p = (s = '') => out.push(s);

	p(`build-verify  ${r.root}`);
	p(`  ${r.package.name ?? 'unnamed'}${r.package.version ? ` ${r.package.version}` : ''}, `
		+ `${plural(r.worktree.copied, 'tracked file', 'tracked files')} rebuilt with `
		+ `${r.steps.map((s) => s.name).join(' + ')} in ${num(r.seconds)} s, `
		+ `node ${r.runtime.node}${r.runtime.npm ? `, npm ${r.runtime.npm}` : ''}.`);
	p();

	p(table(
		['Output', 'Files', 'Rebuilt', 'Identical', 'Metadata', 'Differing', 'Missing', 'Extra', 'In git'],
		r.dirs.map((d) => [`${d.dir}/`, num(d.inCheckout), num(d.rebuilt), num(d.counts.identical),
			num(d.counts.metadata), num(d.counts.differs + d.counts.unstable), num(d.counts.missing),
			num(d.counts.extra), KIND[d.kind]]),
		['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
	));
	p();

	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('Files: what the checkout holds, Rebuilt: what the build wrote. Missing is in the');
	p('checkout and not produced, Extra is produced and not in the checkout. The rebuild');
	p('installs from the lockfile and builds in a throwaway copy of the tracked files, so');
	p('the app is read and never written to. A difference counts against the checkout only');
	if (r.probe) {
		p('where both builds of this source wrote the same bytes; anything else is named as');
		p('not reproducible and carries no verdict.');
	} else {
		p('where the build is known to reproduce itself, which without a second build it is');
		p('not; so a difference is named and no verdict is drawn from it.');
	}
	p();
	p(`All tables: ${how('--details')}`);
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

function renderDetails(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);

	p();
	p('== The rebuild ==');
	p('What ran, in the order it ran, in a copy of the tracked files. The second build is');
	p('what tells a difference of the toolchain from a difference of the source.');
	p(r.kept ? `The output of each step is beside the tree in ${r.scratch}.`
		: `The output of each step is kept with the tree by ${how('--keep')}.`);
	p();
	p(table(
		['Step', 'Command', 'Seconds', 'Exit', ...(r.kept ? ['Log'] : [])],
		r.steps.map((s) => [s.name, s.cmd, s.seconds.toFixed(1), num(s.code), ...(r.kept ? [s.log] : [])]),
		['l', 'l', 'r', 'r', 'l'],
	));
	p();

	for (const d of r.dirs) {
		const renamed = d.files.some((f) => f.rebuiltPath);
		p(`== ${d.dir}/ ==`);
		p(`${plural(d.inCheckout, 'file', 'files')} in the checkout, `
			+ `${plural(d.rebuilt, 'file', 'files')} out of the rebuild, ${KIND[d.kind]}.`);
		if (renamed) {
			p('A file paired under another name was matched by its name pattern, which is how a');
			p('content hash in the name is followed.');
		}
		p();
		const sorted = [...d.files].sort((a, b) => a.state.localeCompare(b.state) || a.path.localeCompare(b.path));
		const rows = cut(sorted, opt.top);
		p(table(
			['File', 'State', 'Bytes', 'Rebuilt B', ...(renamed ? ['Rebuilt as'] : [])],
			rows.rows.map((f) => [f.path, STATE[f.state], num(f.bytes), num(f.rebuiltBytes),
				...(renamed ? [f.rebuiltPath ?? ''] : [])]),
			['l', 'l', 'r', 'r', 'l'],
		));
		if (rows.hidden) p(`... ${num(rows.hidden)} further files not shown, use ${how('--details --top=0')}`);
		p();
	}

	return out.join('\n').replace(/\n+$/, '');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
let report;
try {
	report = run(opt);
} catch (e) {
	if (!e.expected) throw e;
	die(e.message);
}
if (opt.json) {
	// The captured command output is megabytes of npm chatter and lives in the log
	// files; the JSON names those instead of carrying them.
	process.stdout.write(`${JSON.stringify(report, function omit(k, v) {
		if (k === 'output') return undefined;              // megabytes of npm chatter
		if (k === 'files' && this.dir) return undefined;   // the same entries as report.files
		return v;
	}, 2)}\n`);
} else {
	process.stdout.write(`${renderSummary(report) + (opt.details ? renderDetails(report, opt) : '')}\n`);
}
