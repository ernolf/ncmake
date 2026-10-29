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
// and an .npmrc with a token.
//
// The secret itself is never read into the report: gitleaks runs with --redact,
// and a file found by its name is named, not shown. --reveal shows the line of
// each finding on the terminal for the maintainer who has to find it; it never
// reaches the JSON, and a run where CI is set refuses it. The repository's own
// .gitleaks.toml and .gitleaksignore apply to both scopes, the ignore file to the
// files found by name as well. make hands in the binary it fetched and checked
// against its digest. Node 18 or newer, no npm dependency.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
	details: false,
	reveal: false,    // the line of each finding on the terminal, never in the JSON
	json: false,
	jsonFile: null,
};
const SCOPES = ['shipped', 'history', 'all'];
const FROM = {
	checkout: 'the files make stage takes from the checkout',
	stage: 'the staged tree of make dist',
	tarball: 'the tarball',
};
const SAMPLE = 3;    // commits named per file without --details
const CLIP = 160;    // characters of a revealed line

// The public certificate of the integrity signature is committed on purpose; the
// key that belongs to it is reported wherever it appears.
const CERTIFICATE = '.ncmake/certificate.crt';

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
  --commits=<range>     the commits of a git log range, e.g. main..HEAD, instead
                        of every commit
  --details             every commit a file found by its name was added in
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
				const m = /^--(scope|shipped|from|commits|json-file)=(.*)$/.exec(arg);
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
	if (opt.commits !== null && opt.commits.startsWith('-')) die(`--commits takes a range, not an option: ${opt.commits}`);
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

function shipped(root, opt, ignore) {
	const tree = path.resolve(root, opt.shipped);
	if (!fs.existsSync(tree)) die(`the shipped tree ${opt.shipped} does not exist`);
	const files = walk(tree);
	const found = runGitleaks(root, ['dir', '.'], tree).map((g) => ({
		rule: g.RuleID, what: g.Description, file: g.File.replace(/^\.\//, ''), line: g.StartLine ?? null, fingerprint: g.Fingerprint,
	}));
	const seen = new Set(found.map((f) => f.file));
	for (const file of files) {
		if (seen.has(file) || ignore.file(file) || file === CERTIFICATE) continue;
		const r = byName(file, () => { try { return fs.readFileSync(path.join(tree, file), 'utf8'); } catch { return null; } });
		const fingerprint = r && `${file}:${r.id}:1`;
		if (r && !ignore.has(fingerprint)) found.push({ rule: r.id, what: r.what, file, line: null, fingerprint });
	}
	return { tree: opt.shipped, from: opt.from, files: files.length, found: found.filter((f) => f.file !== CERTIFICATE) };
}

// == The history ==
// gitleaks reads every commit through git log -p; the files found by their name
// come from the paths each commit adds or changes, oldest first, so a file is
// reported with the commit that brought it in.
function history(root, opt, ignore) {
	if (git(root, ['rev-parse', '--git-dir']).status !== 0) return { error: `${root} is not a git checkout` };
	const range = opt.commits ? [opt.commits] : ['--all'];
	const count = git(root, ['rev-list', '--count', ...range]);
	if (count.status !== 0) return { error: `git cannot read the commits ${opt.commits ?? 'of the checkout'}: ${count.stderr.trim()}` };
	const found = runGitleaks(root, ['git', '--log-opts', range.join(' '), '.'], root).map((g) => ({
		rule: g.RuleID, what: g.Description, file: g.File, line: g.StartLine ?? null, commit: g.Commit, date: g.Date ?? null,
		fingerprint: g.Fingerprint,
	}));
	// A file gitleaks has reported is not reported again for its name.
	const seen = new Set(found.map((f) => f.file));
	const log = git(root, ['log', ...range, '--reverse', '--no-renames', '--diff-filter=AM', '--format=%x00%H %cI', '--name-only']);
	if (log.status !== 0) return { error: `git log failed: ${log.stderr.trim()}` };
	const byFile = new Map();
	for (const block of log.stdout.split('\0').filter(Boolean)) {
		const [head, ...paths] = block.split('\n').filter(Boolean);
		const [commit, date] = head.split(' ');
		for (const file of paths) {
			if (file === CERTIFICATE || seen.has(file) || ignore.file(file)) continue;
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
	return { range: opt.commits, commits: Number(count.stdout.trim()), found: found.filter((f) => f.file !== CERTIFICATE) };
}

// == The check ==
function check(opt) {
	const root = path.resolve(opt.dir);
	if (!fs.existsSync(root)) die(`no such directory: ${opt.dir}`);
	const ignore = readIgnore(root);
	const r = { root, gitleaks: version(), scope: opt.scope, shipped: null, history: null, findings: [] };
	if (opt.scope !== 'history') {
		if (!opt.shipped) die('--shipped names no tree; make secrets-audit hands it in');
		r.shipped = shipped(root, opt, ignore);
	}
	if (opt.scope !== 'shipped') r.history = history(root, opt, ignore);
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
