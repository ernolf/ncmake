#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// secrets-audit - is a key or a token in what ships, or in the history.
//
// A private key, an API token or an .env file committed to an app repository is
// public as soon as it is pushed, and stays in the history after a later commit
// removes it. Inside the shipped file set it is also in every tarball on the App
// Store. gitleaks (https://github.com/gitleaks/gitleaks) looks for both, with its
// own rules for what a secret looks like, in two scopes:
//   shipped   the tree make hands in: the files make stage takes from the
//             checkout, the staged tree of make dist, or an unpacked tarball
//   history   every commit of the checkout, or the range --commits names
// Next to the gitleaks rules, a file is reported by its name: a private key
// (*.key, id_rsa and its siblings, *.pem with a private key block), a key store
// (*.p12, *.pfx), an .env file, the auth.json of composer with a credential in it
// and an .npmrc with a token. The integrity signature, its certificate and the
// checksums of an older app are public by design and never reported. In
// generated files, a match of a rule that takes any string of high entropy is
// worth knowing, not a secret: hashes and minified names are such strings too.
// A placeholder of the list secrets-placeholders.json, admin:admin in a curl
// line of a README for one, is no credential and only counted.
//
// The secret itself is never read into the report: gitleaks runs with --redact,
// and a file found by its name is named, not shown. --reveal shows the line of
// each finding on the terminal for the maintainer who has to find it; it never
// reaches the JSON, and a run where CI is set refuses it. The repository's own
// .gitleaks.toml and .gitleaksignore apply to both scopes, the ignore file to the
// files found by name as well. make hands in the binary it fetched and checked
// against its digest. Node 18 or newer, no npm dependency.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	LEGEND,
	howToRun,
	plural,
	renderFindings,
	sortFindings,
	writeJsonFile,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',         // the checkout
	scope: 'all',     // shipped, history or all
	shipped: null,    // the tree that ships, relative to the checkout
	from: 'checkout', // where that tree came from: checkout, stage or tarball
	commits: null,    // a git log range for the history, instead of every commit
	placeholders: fileURLToPath(new URL('./secrets-placeholders.json', import.meta.url)),
	details: false,
	reveal: false,    // the line of each finding on the terminal, never in the JSON
	json: false,
	jsonFile: null,
};
const SCOPES = ['shipped', 'history', 'all'];
const RANGE_OPTIONS = ['--all', '--not'];
const FROM = {
	checkout: 'the files make stage takes from the checkout',
	stage: 'the staged tree of make dist',
	tarball: 'the tarball',
};
const SAMPLE = 3;    // commits named per file without --details
const CLIP = 160;    // characters of a revealed line
const GENERATED_SHOWN = 10; // generated files, and files with placeholders, named without --details

// The files that are public by design and committed on purpose: the integrity
// signature with its certificate, and the checksums of its files an older app
// carried. A path counts below the app and below any directory of the
// repository. Where an entry names a content, a file of that name holding
// anything else is checked like any other; the key that signs is reported
// wherever it appears.
const HEX = /^[0-9a-f]+$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const CERT = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n?$/;
const isObject = (j) => j !== null && typeof j === 'object' && !Array.isArray(j);
const object = (t) => { try { const j = JSON.parse(t); return isObject(j) ? j : null; } catch { return null; } };
const hexMap = (j) => isObject(j) && Object.keys(j).length > 0 && Object.values(j).every((v) => typeof v === 'string' && HEX.test(v));
const PUBLIC_FILES = [
	{ path: '.ncmake/certificate.crt', what: 'the certificate of the integrity signature' },
	{ path: 'appinfo/signature.json', what: 'the integrity signature', content: (t) => {
		const j = object(t);
		return j !== null && Object.keys(j).sort().join() === 'certificate,hashes,signature'
			&& hexMap(j.hashes) && typeof j.signature === 'string' && BASE64.test(j.signature)
			&& typeof j.certificate === 'string' && CERT.test(j.certificate.replace(/\r\n/g, '\n'));
	} },
	{ path: 'appinfo/checksum.json', what: 'the checksums of the files of an older release', content: (t) => hexMap(object(t)) },
];

function publicFile(file, read) {
	const e = PUBLIC_FILES.find((x) => file === x.path || file.endsWith(`/${x.path}`));
	if (!e?.content) return e ?? null;
	const text = read();
	return text !== null && e.content(text) ? e : null;
}

// Generated code is full of strings gitleaks takes for a key: hashes, minified
// names, content digests and embedded data. A generated file is one of these
// kinds by its name, or lies below a directory .gitignore takes for build
// output, as make classifies js/ and vendor/. It is scanned all the same, since
// a key a build inlines from the environment ends up there.
const GENERATED = [
	{ what: 'a source map', name: /\.map$/ },
	{ what: 'a minified file', name: /\.min\.(?:js|css)$/ },
	{ what: 'a chunk of a bundle', name: /\.chunk\.m?js$/ },
	{ what: 'the cache of a tool', name: /^(?:\.php-cs-fixer\.cache|\.phpunit\.result\.cache|\.eslintcache)$/ },
];
const BUILD_OUTPUT = 'build output, as .gitignore says';
// The rules without a format of their own, which take any string of high
// entropy next to a word such as key or token. In a generated file their
// matches are [i]; every other rule, a private key or the token of a provider,
// stays a secret wherever it matches. sourcegraph-access-token takes any 40
// hex digits as well, so a SHA-1 matches it; its own sgp_ token has a format,
// and a line with one stays a secret.
const FORMLESS = [
	{ rule: 'generic-api-key' },
	{ rule: 'sourcegraph-access-token', line: (l) => !/sgp_/i.test(l) },
];

function generatedFile(file, ignored) {
	const e = GENERATED.find((x) => x.name.test(path.posix.basename(file)));
	if (e) return e;
	for (let d = path.posix.dirname(file); d !== '.'; d = path.posix.dirname(d)) {
		if (ignored.has(d)) return { what: BUILD_OUTPUT };
	}
	return null;
}

function formless(f, readLine) {
	const r = FORMLESS.find((x) => x.rule === f.rule);
	return Boolean(r) && (!r.line || r.line(readLine() ?? ''));
}

// The gitleaks matches in a public or a generated file are left out of the
// secrets and only counted, per file, so the report shows that the file was read.
function setAside(found, pick) {
	const aside = new Map();
	const kept = found.filter((f) => {
		const e = pick(f);
		if (!e) return true;
		const x = aside.get(f.file) ?? { file: f.file, what: e.what, matches: 0, commits: new Set(), rules: {} };
		x.matches++;
		x.rules[f.rule] = (x.rules[f.rule] ?? 0) + 1;
		if (f.commit) x.commits.add(f.commit);
		aside.set(f.file, x);
		return false;
	});
	return { kept, aside: [...aside.values()].map((x) => ({ ...x, commits: x.commits.size })) };
}

// The placeholders are data, secrets-placeholders.json beside this file, so one
// found later is added there and not here. An entry whose examples it does not
// match stops the run, so a wrong addition does not pass unnoticed.
function loadPlaceholders(file) {
	let json;
	try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return die(`cannot read the placeholders in ${file}: ${e.message}`); }
	if (!Array.isArray(json?.placeholders)) die(`${file} holds no placeholders list`);
	return json.placeholders.map((p, i) => {
		let re;
		try { re = new RegExp(p.match, 'iu'); } catch (e) { return die(`placeholder ${i + 1} in ${file}: ${e.message}`); }
		const miss = (p.examples ?? []).find((x) => !re.test(x));
		if (miss !== undefined) die(`placeholder ${i + 1} in ${file} does not match its example ${miss}`);
		return re;
	});
}

// gitleaks redacts the value it matched, in the match as well. The text the
// match covers is read back from the file, and what stands where REDACTED
// stands is the value. A match that does not line up with the text, or holds
// REDACTED more than once, gives no value and stays a secret.
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unquote = (s) => s.replace(/^(['"])(.*)\1$/s, '$2');
function valueOf(f, text) {
	const parts = (f.match ?? '').split('REDACTED');
	if (parts.length !== 2 || text === null) return null;
	// The value ends where the match ends; with nothing after it in the match,
	// that is the end of the text.
	const value = parts[1] ? `([\\s\\S]+?)${literal(parts[1])}` : '([\\s\\S]+)$';
	const m = new RegExp(`${literal(parts[0])}${value}`).exec(text);
	return m ? m[1] : null;
}

function placeholder(f, text, list) {
	const v = unquote(valueOf(f, text) ?? '');
	if (!v) return false;
	const pair = /^[^:]+:(.+)$/s.exec(v)?.[1];
	return list.some((re) => re.test(v) || (pair !== undefined && re.test(unquote(pair))));
}

// The matches that are placeholders are counted per file, as those in a
// generated file are. The match, redacted as it is, only serves to find the
// value and does not reach the JSON.
function asidePlaceholders(found, linesOf, list) {
	const span = (f) => (f.line ? linesOf(f).slice(f.line - 1, f.endLine ?? f.line).join('\n') : null);
	const { kept, aside } = setAside(found, (f) => placeholder(f, span(f), list) && { what: 'placeholders' });
	for (const f of kept) { delete f.endLine; delete f.match; }
	return { kept, aside };
}

// == Command line ==
function usage() {
	return `secrets-audit - is a key or a token in what ships, or in the history

Usage: secrets-audit.mjs [options] [dir]

  dir                   the git checkout (default: ${defaults.dir})

Options:
  --scope=<scope>       ${SCOPES.join(', ')} (default: ${defaults.scope})
  --shipped=<dir>       the tree that ships, relative to the checkout; make
                        secrets-audit hands it in
  --from=<kind>         where that tree came from: ${Object.keys(FROM).join(', ')}
  --commits=<range>     the commits of a git log range, e.g. main..HEAD or
                        "--all --not <commit>", instead of every commit
  --placeholders=<file> the placeholders (default: secrets-placeholders.json
                        beside this file)
  --details             every commit a file found by its name was added in,
                        and every generated file and every file with
                        placeholders
  --reveal              show the line of each finding on the terminal; never
                        in the JSON, and refused where CI is set
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The secret itself is shown only with --reveal. The exit code is 0 when nothing was found, 1
when a secret was, and 2 when the run itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`secrets-audit: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	for (const arg of argv) {
		switch (arg) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--details': opt.details = true; break;
			case '--reveal': opt.reveal = true; break;
			case '--json': opt.json = true; break;
			default: {
				const m = /^--(scope|shipped|from|commits|placeholders|json-file)=(.*)$/.exec(arg);
				if (m) {
					opt[{ 'json-file': 'jsonFile' }[m[1]] ?? m[1]] = m[2];
					break;
				}
				if (arg.startsWith('-')) die(`unknown option: ${arg}`);
				if (dir !== null) die(`only one directory can be checked: ${dir}, ${arg}`);
				dir = arg;
			}
		}
	}
	if (dir !== null) opt.dir = dir;
	if (!SCOPES.includes(opt.scope)) die(`unknown scope: ${opt.scope} (${SCOPES.join(', ')})`);
	if (!FROM[opt.from]) die(`unknown origin of the shipped tree: ${opt.from} (${Object.keys(FROM).join(', ')})`);
	if (opt.jsonFile === '') die('--json-file needs a file');
	if (opt.commits === '') die('--commits needs a range');
	if (opt.placeholders === '') die('--placeholders needs a file');
	// Each word reaches git log, where an option such as --output would write a
	// file; only the two that select commits pass.
	const option = opt.commits?.split(/\s+/).find((w) => w.startsWith('-') && !RANGE_OPTIONS.includes(w));
	if (option) die(`--commits takes a range, not an option: ${option}`);
	// A CI log is read by others, often by anyone: a secret revealed there is published.
	if (opt.reveal && (process.env.CI || process.env.GITHUB_ACTIONS)) die('--reveal shows the secrets and is refused where CI is set');
	if (opt.reveal && opt.json) die('--reveal shows the secrets on the terminal only and does not go with --json');
	return opt;
}

// == Files found by their name ==
// Each rule names a file a secret lives in. Where the name alone does not say it,
// the content decides: a .pem holds a certificate as often as a key. A template
// of an .env file (.env.example and the like) holds no secret.
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const COMPOSER_AUTH = ['http-basic', 'github-oauth', 'gitlab-oauth', 'gitlab-token', 'bitbucket-oauth', 'bearer', 'forgejo-token'];
const NAME_RULES = [
	{ id: 'private-key-file', what: 'a private key file', name: /\.key$/i },
	{ id: 'ssh-private-key', what: 'an SSH private key', name: /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_[^.]*)?$/ },
	{ id: 'pem-private-key', what: 'a PEM file with a private key', name: /\.pem$/i, content: (t) => PRIVATE_KEY.test(t) },
	{ id: 'key-store', what: 'a PKCS #12 key store', name: /\.(?:p12|pfx)$/i },
	{ id: 'env-file', what: 'an .env file', name: /^\.env(?:\..+)?$/, not: /\.(?:example|sample|dist|template|defaults)$/i,
		reveal: (t) => t.split('\n').filter((l) => /^\s*[^#\s][^=]*=\s*\S/.test(l)) },
	{ id: 'composer-auth', what: 'the auth.json of composer with a credential', name: /^auth\.json$/,
		content: (t) => { try { const j = JSON.parse(t); return COMPOSER_AUTH.some((k) => j?.[k] && Object.keys(j[k]).length); } catch { return false; } },
		reveal: (t) => { try { const j = JSON.parse(t); return COMPOSER_AUTH.filter((k) => j?.[k]).map((k) => `"${k}": ${JSON.stringify(j[k])}`); } catch { return []; } } },
	{ id: 'npmrc-token', what: 'an .npmrc with a token', name: /^\.npmrc$/, content: (t) => /(?:^|:)_(?:authToken|auth|password)\s*=/m.test(t),
		reveal: (t) => t.split('\n').filter((l) => /(?:^|:)_(?:authToken|auth|password)\s*=/.test(l)) },
];

function byName(file, read) {
	const base = path.posix.basename(file);
	for (const r of NAME_RULES) {
		if (!r.name.test(base) || r.not?.test(base)) continue;
		if (r.content) {
			const text = read();
			if (text === null || !r.content(text)) continue;
		}
		return r;
	}
	return null;
}

// .gitleaksignore: one fingerprint per line, commit:file:rule:line for the
// history and file:rule:line for a tree, as gitleaks writes them. A file found
// by its name has line 1. A file whose finding is ignored is not reported again
// for its name, whichever rule found it first.
function readIgnore(root) {
	const file = path.join(root, '.gitleaksignore');
	const lines = fs.existsSync(file)
		? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean) : [];
	const files = new Set(lines.map((l) => /^(?:[0-9a-f]{7,40}:)?(.+):[^:]+:\d+$/.exec(l)?.[1]).filter(Boolean));
	return { has: (fingerprint) => lines.includes(fingerprint), file: (f) => files.has(f) };
}

// == gitleaks ==
const gitleaks = process.env.SECRETS_AUDIT_GITLEAKS || 'gitleaks';
// git refuses a checkout whose owner differs from the user inside the container,
// and gitleaks calls git itself, so the exception goes into its environment.
const GIT_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };

function git(root, args) {
	const r = spawnSync('git', args, { cwd: root, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
	if (r.error) die(`could not run git: ${r.error.message}`);
	return r;
}

// The directories of the files that .gitignore of the checkout takes for build
// output, asked of git in one call. The trailing slash makes a pattern for a
// directory match, as make asks it of js/ and vendor/; git exits 1 when it
// ignores none of them.
function ignoredDirs(cwd, files) {
	const dirs = new Set();
	for (const f of files) {
		for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
	}
	if (!dirs.size) return dirs;
	const r = spawnSync('git', ['check-ignore', '--stdin'], {
		cwd, input: [...dirs].map((d) => `${d}/\n`).join(''), env: { ...process.env, ...GIT_ENV }, encoding: 'utf8',
	});
	return new Set(r.status === 0 ? r.stdout.split('\n').filter(Boolean).map((d) => d.replace(/\/$/, '')) : []);
}

// The findings of one gitleaks run, redacted. The repository's own .gitleaks.toml
// and .gitleaksignore are passed by path, because a tree that ships lies outside
// the root where gitleaks would look for them.
function runGitleaks(root, args, cwd) {
	const config = path.join(root, '.gitleaks.toml');
	const r = spawnSync(gitleaks, [
		...args,
		...(fs.existsSync(config) ? ['--config', config] : []),
		'--gitleaks-ignore-path', root,
		'--redact', '--no-banner', '--no-color', '--exit-code', '0', '--log-level', 'error',
		'--report-format', 'json', '--report-path', '-',
	], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	if (r.error) die(`could not run ${gitleaks}: ${r.error.message}`);
	if (r.status !== 0) die(`gitleaks stopped with exit code ${r.status ?? r.signal}:\n${r.stderr.trim()}`);
	try {
		const list = JSON.parse(r.stdout || '[]');
		if (!Array.isArray(list)) throw new Error('not a list');
		return list;
	} catch (e) { return die(`the gitleaks report could not be read: ${e.message}`); }
}

const version = () => {
	const r = spawnSync(gitleaks, ['version'], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.trim() : null;
};

// == What ships ==
function walk(dir, rel = '') {
	const out = [];
	let entries;
	try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const p = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...walk(dir, p));
		else if (e.isFile()) out.push(p);
	}
	return out;
}

function shipped(root, opt, ignore, placeholders) {
	const tree = path.resolve(root, opt.shipped);
	if (!fs.existsSync(tree)) die(`the shipped tree ${opt.shipped} does not exist`);
	const files = walk(tree);
	const read = (file) => { try { return fs.readFileSync(path.join(tree, file), 'utf8'); } catch { return null; } };
	const memo = new Map();
	const isPublic = (file) => {
		if (!memo.has(file)) memo.set(file, publicFile(file, () => read(file)));
		return memo.get(file);
	};
	const { kept, aside: exempt } = setAside(runGitleaks(root, ['dir', '.'], tree).map((g) => ({
		rule: g.RuleID, what: g.Description, file: g.File.replace(/^\.\//, ''), line: g.StartLine ?? null, fingerprint: g.Fingerprint,
		endLine: g.EndLine ?? null, match: g.Match,
	})), (f) => isPublic(f.file));
	// The tree that ships keeps the paths of the checkout, so its .gitignore applies.
	const ignored = ignoredDirs(root, kept.map((f) => f.file));
	const lines = new Map();
	const linesOf = (f) => {
		if (!lines.has(f.file)) lines.set(f.file, read(f.file)?.split('\n') ?? []);
		return lines.get(f.file);
	};
	const { kept: rest, aside: generated } = setAside(kept, (f) => formless(f, () => linesOf(f)[f.line - 1]) && generatedFile(f.file, ignored));
	const { kept: found, aside: placeholder } = asidePlaceholders(rest, linesOf, placeholders);
	const seen = new Set([...found, ...exempt, ...generated, ...placeholder].map((f) => f.file));
	for (const file of files) {
		if (seen.has(file) || ignore.file(file) || isPublic(file)) continue;
		const r = byName(file, () => read(file));
		const fingerprint = r && `${file}:${r.id}:1`;
		if (r && !ignore.has(fingerprint)) found.push({ rule: r.id, what: r.what, file, line: null, fingerprint });
	}
	return { tree: opt.shipped, from: opt.from, files: files.length, found, exempt, generated, placeholders: placeholder };
}

// == The history ==
// gitleaks reads every commit through git log -p; the files found by their name
// come from the paths each commit adds or changes, oldest first, so a file is
// reported with the commit that brought it in.
function history(root, opt, ignore, placeholders) {
	if (git(root, ['rev-parse', '--git-dir']).status !== 0) return { error: `${root} is not a git checkout` };
	// gitleaks splits --log-opts into words, so git reads the range the same way,
	// and --all --not <tip>... covers every ref but the commits already scanned.
	const range = opt.commits ? opt.commits.split(/\s+/).filter(Boolean) : ['--all'];
	const count = git(root, ['rev-list', '--count', ...range]);
	if (count.status !== 0) return { error: `git cannot read the commits ${opt.commits ?? 'of the checkout'}: ${count.stderr.trim()}` };
	// Whether a file is public is decided by its content at the commit.
	const memo = new Map();
	const isPublic = (commit, file) => {
		const key = `${commit}:${file}`;
		if (!memo.has(key)) {
			memo.set(key, publicFile(file, () => {
				const b = git(root, ['cat-file', '-p', key]);
				return b.status === 0 ? b.stdout : null;
			}));
		}
		return memo.get(key);
	};
	const { kept, aside: exempt } = setAside(runGitleaks(root, ['git', '--log-opts', range.join(' '), '.'], root).map((g) => ({
		rule: g.RuleID, what: g.Description, file: g.File, line: g.StartLine ?? null, commit: g.Commit, date: g.Date ?? null,
		fingerprint: g.Fingerprint, endLine: g.EndLine ?? null, match: g.Match,
	})), (f) => isPublic(f.commit, f.file));
	// The paths of the history start at the top of the repository, and the
	// .gitignore of the checkout decides for every commit, as it does for make.
	const top = git(root, ['rev-parse', '--show-toplevel']).stdout.trim() || root;
	const ignored = ignoredDirs(top, kept.map((f) => f.file));
	const lines = new Map();
	const linesOf = (f) => {
		const key = `${f.commit}:${f.file}`;
		if (!lines.has(key)) {
			const b = git(root, ['cat-file', '-p', key]);
			lines.set(key, b.status === 0 ? b.stdout.split('\n') : []);
		}
		return lines.get(key);
	};
	const { kept: rest, aside: generated } = setAside(kept, (f) => formless(f, () => linesOf(f)[f.line - 1]) && generatedFile(f.file, ignored));
	const { kept: found, aside: placeholder } = asidePlaceholders(rest, linesOf, placeholders);
	// A file gitleaks has reported is not reported again for its name.
	const seen = new Set([...found, ...exempt, ...generated, ...placeholder].map((f) => f.file));
	const log = git(root, ['log', ...range, '--reverse', '--no-renames', '--diff-filter=AM', '--format=%x00%H %cI', '--name-only']);
	if (log.status !== 0) return { error: `git log failed: ${log.stderr.trim()}` };
	const byFile = new Map();
	for (const block of log.stdout.split('\0').filter(Boolean)) {
		const [head, ...paths] = block.split('\n').filter(Boolean);
		const [commit, date] = head.split(' ');
		for (const file of paths) {
			if (seen.has(file) || ignore.file(file) || isPublic(commit, file)) continue;
			const r = byName(file, () => {
				const b = git(root, ['cat-file', '-p', `${commit}:${file}`]);
				return b.status === 0 ? b.stdout : null;
			});
			if (!r || ignore.has(`${commit}:${file}:${r.id}:1`)) continue;
			const key = `${file}\0${r.id}`;
			if (!byFile.has(key)) byFile.set(key, { rule: r.id, what: r.what, file, line: null, commit, date, fingerprint: `${commit}:${file}:${r.id}:1`, commits: [] });
			byFile.get(key).commits.push(commit);
		}
	}
	found.push(...byFile.values());
	return { range: opt.commits, commits: Number(count.stdout.trim()), found, exempt, generated, placeholders: placeholder };
}

// == The check ==
// Everything besides the commits that decides what a scan finds: the gitleaks
// version, this file with its rules for files found by name, the placeholders,
// and the repository's .gitleaks.toml and .gitleaksignore. A consumer that keeps
// the result of a history scan and later scans only the newer commits starts
// over once this value changes.
function rules(root, gitleaksVersion, placeholders) {
	const read = (f) => { try { return fs.readFileSync(f); } catch { return Buffer.alloc(0); } };
	const h = createHash('sha256');
	for (const part of [Buffer.from(gitleaksVersion ?? ''), read(new URL(import.meta.url)), read(placeholders),
		read(path.join(root, '.gitleaks.toml')), read(path.join(root, '.gitleaksignore'))]) {
		h.update(`${part.length}\n`).update(part);
	}
	return h.digest('hex');
}

function check(opt) {
	const root = path.resolve(opt.dir);
	if (!fs.existsSync(root)) die(`no such directory: ${opt.dir}`);
	const ignore = readIgnore(root);
	const placeholders = loadPlaceholders(opt.placeholders);
	const gl = version();
	const r = { root, gitleaks: gl, rules: rules(root, gl, opt.placeholders), scope: opt.scope, shipped: null, history: null, findings: [] };
	if (opt.scope !== 'history') {
		if (!opt.shipped) die('--shipped names no tree; make secrets-audit hands it in');
		r.shipped = shipped(root, opt, ignore, placeholders);
	}
	if (opt.scope !== 'shipped') r.history = history(root, opt, ignore, placeholders);
	return r;
}

// == Findings ==
const short = (c) => (c ? c.slice(0, 12) : '');
// gitleaks reports in no fixed order, so a list that is numbered for a choice, as
// make secrets-ignore numbers it, is sorted: by date in the history, then by file
// and line.
const byPlace = (a, b) => String(a.date ?? '').localeCompare(String(b.date ?? ''))
	|| a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0);
const where = (f) => `${f.file}${f.line ? `:${f.line}` : ''}`;

function findings(r, opt) {
	const out = [];
	const how = howToRun('SECRETS_AUDIT_CMDLINE', 'secrets-audit.mjs %s');
	const entry = (level, id, f, lines) => out.push({
		level, id, security: true, rule: f.rule, file: f.file, line: f.line,
		...(f.commit ? { commit: f.commit, date: f.date } : {}), fingerprint: f.fingerprint, lines,
	});
	if (r.shipped) {
		for (const f of [...r.shipped.found].sort(byPlace)) {
			entry('warn', 'secret-shipped', f, [
				`${where(f)}  ${f.rule}: ${f.what.replace(/\.$/, '')}.`,
				`  It is in ${FROM[r.shipped.from]}, so a release carries it to every server that installs the app.`
				+ ' Take it out of what ships and revoke it: once published, it is no longer secret.',
			]);
		}
		if (!r.shipped.found.length) {
			out.push({ level: 'ok', id: 'secrets-shipped', lines: [`No secret in ${FROM[r.shipped.from]}, ${plural(r.shipped.files, 'file', 'files')}.`] });
		}
	}
	if (r.history?.error) {
		out.push({ level: 'info', id: 'history-unavailable', lines: [`The history was not checked: ${r.history.error}.`] });
	} else if (r.history) {
		for (const f of [...r.history.found].sort(byPlace)) {
			const more = f.commits?.length > 1 ? f.commits.slice(1) : [];
			entry('warn', 'secret-in-history', f, [
				`${where(f)}  ${f.rule}, added in ${short(f.commit)}${f.date ? ` (${f.date.slice(0, 10)})` : ''}: ${f.what.replace(/\.$/, '')}.`,
				...(more.length ? [`  Changed again in ${plural(more.length, 'later commit', 'later commits')}`
					+ `${opt.details ? `: ${more.map(short).join(', ')}` : `, see ${how('--details')}`}.`] : []),
				'  Revoke it: removing it from the repository does not make it secret again, every clone has the commit.'
				+ ' Where it is revoked and meant to stay, its fingerprint in .gitleaksignore silences it.',
			]);
		}
		if (!r.history.found.length) {
			out.push({ level: 'ok', id: 'secrets-history', lines: [`No secret in ${plural(r.history.commits, 'commit', 'commits')}${r.history.range ? ` of ${r.history.range}` : ''}.`] });
		}
	}
	const exempt = new Map();
	const count = (x, where) => {
		if (!exempt.has(x.file)) exempt.set(x.file, { what: x.what, where: [] });
		exempt.get(x.file).where.push(`${plural(x.matches, 'match', 'matches')} ${where}`);
	};
	for (const x of r.shipped?.exempt ?? []) count(x, 'in what ships');
	for (const x of r.history?.exempt ?? []) count(x, `in ${plural(x.commits, 'commit', 'commits')}`);
	if (exempt.size) {
		out.push({ level: 'info', id: 'public-files', lines: [
			'These files are public by design, so what gitleaks matches in them is not reported:',
			...[...exempt].map(([file, x]) => `  ${file}, ${x.what}: ${x.where.join(', ')}.`),
		] });
	}
	// The matches set aside per file under key, both scopes in one line, the files
	// with the most matches first; without --details only the first of them.
	const tally = (key, label) => {
		const byFile = new Map();
		const add = (x, where) => {
			if (!byFile.has(x.file)) byFile.set(x.file, { what: x.what, matches: 0, rules: new Set(), where: [] });
			const g = byFile.get(x.file);
			g.matches += x.matches;
			for (const rule of Object.keys(x.rules)) g.rules.add(rule);
			g.where.push(`${plural(x.matches, 'match', 'matches')} ${where}`);
		};
		for (const x of r.shipped?.[key] ?? []) add(x, 'in what ships');
		for (const x of r.history?.[key] ?? []) add(x, `in ${plural(x.commits, 'commit', 'commits')}`);
		const files = [...byFile].sort((a, b) => b[1].matches - a[1].matches || a[0].localeCompare(b[0]));
		const shown = opt.details ? files : files.slice(0, GENERATED_SHOWN);
		return files.length ? [
			...shown.map(([file, x]) => `  ${label(file, x)}: ${x.where.join(', ')} (${[...x.rules].sort().join(', ')}).`),
			...(files.length > shown.length ? [`  ${plural(files.length - shown.length, 'more file', 'more files')}, see ${how('--details')}.`] : []),
		] : [];
	};
	const generated = tally('generated', (file, x) => `${file}, ${x.what}`);
	if (generated.length) {
		out.push({ level: 'info', id: 'generated-files', lines: [
			'In these generated files gitleaks matches only rules that take any string of high entropy, which hashes'
			+ ' and minified names are as well, so the matches are not reported as secrets:',
			...generated,
			'  A key a build takes from the environment ends up in such a file too: where one of them has no reason to'
			+ ' carry a key, look at it.',
		] });
	}
	const placeholders = tally('placeholders', (file) => file);
	if (placeholders.length) {
		out.push({ level: 'info', id: 'placeholders', lines: [
			'In these files gitleaks matches values that stand for a credential, such as admin:admin or <password>,'
			+ ' so the matches are not reported as secrets:',
			...placeholders,
			'  The values are the list secrets-placeholders.json of ncmake.',
		] });
	}
	return sortFindings(out);
}

// == Revealing a finding ==
// What --reveal adds to a finding on the terminal: the line gitleaks found, or
// for a file found by its name the lines that carry the credential. A key file is
// the secret as a whole, and is not printed. Read from the tree that ships or
// from the commit, never kept.
const clip = (l) => (l.length > CLIP ? `${l.slice(0, CLIP)} ...` : l);

function reveal(r, f) {
	let text = null;
	if (f.id === 'secret-shipped') {
		try { text = fs.readFileSync(path.join(r.root, r.shipped.tree, f.file), 'utf8'); } catch { text = null; }
	} else {
		const b = git(r.root, ['cat-file', '-p', `${f.commit}:${f.file}`]);
		if (b.status === 0) text = b.stdout;
	}
	if (text === null) return ['  revealed: the file could not be read'];
	if (f.line) return [`  revealed, line ${f.line}: ${clip((text.split('\n')[f.line - 1] ?? '').trim())}`];
	const rule = NAME_RULES.find((x) => x.id === f.rule);
	if (!rule?.reveal) return ['  revealed: the whole file is the secret'];
	const lines = rule.reveal(text);
	return lines.length ? lines.slice(0, 5).map((l) => `  revealed: ${clip(l.trim())}`)
		.concat(lines.length > 5 ? [`  ... ${lines.length - 5} more`] : []) : ['  revealed: nothing to show'];
}

// == Human-readable output ==
function render(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);
	const how = howToRun('SECRETS_AUDIT_CMDLINE', 'secrets-audit.mjs %s');
	const scopes = [];
	if (r.shipped) scopes.push(`${FROM[r.shipped.from]} (${plural(r.shipped.files, 'file', 'files')})`);
	if (r.history && !r.history.error) scopes.push(`${plural(r.history.commits, 'commit', 'commits')}${r.history.range ? ` of ${r.history.range}` : ''}`);
	p(`secrets-audit  ${r.root}`);
	p(`  gitleaks ${r.gitleaks ?? '(version unknown)'}, ${scopes.join(' and ') || 'nothing'} checked.`);
	p();
	p('FINDINGS');
	const shown = opt.reveal ? r.findings.map((f) => (/^secret-/.test(f.id) ? { ...f, lines: [...f.lines, ...reveal(r, f)] } : f)) : r.findings;
	for (const l of renderFindings(shown)) p(l);
	p();
	p(LEGEND);
	p('A secret in what ships and a secret in the history are [!]; the secret itself');
	p(opt.reveal ? 'is shown above because of --reveal, and nowhere else. Each finding names the'
		: `is not shown, ${how('--reveal')} shows it. Each finding names the`);
	p('gitleaks rule or the kind of file, and its fingerprint in the JSON is the line');
	p('.gitleaksignore takes to silence it.');
	p();
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = check(opt);
report.findings = findings(report, opt);
const json = opt.json || opt.jsonFile ? `${JSON.stringify(report, null, 2)}\n` : null;
process.stdout.write(opt.json ? json : `${render(report, opt)}\n`);
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
process.exitCode = report.findings.some((f) => f.level === 'warn') ? 1 : 0;
