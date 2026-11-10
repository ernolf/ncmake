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
//             checkout, the staged tree of make dist, an unpacked tarball, or
//             the tracked files of a checkout that is no app
//   history   every commit of the checkout, or the range --commits names
// Next to the gitleaks rules, a file is reported by its name: a private key
// (*.key, id_rsa and its siblings, *.pem with a private key block), a key store
// (*.p12, *.pfx), an .env file, the auth.json of composer with a credential in it
// and an .npmrc with a token. The integrity signature, its certificate and the
// checksums of an older app are public by design and never reported. In
// generated files, a match of a rule that takes any string of high entropy is
// worth knowing, not a secret: hashes and minified names are such strings too.
// A placeholder of the list secrets-placeholders.json, admin:admin in a curl
// line of a README for one, is no credential and only counted, and so is a
// value that is no secret by its form, such as the name of a constant or a
// hash under a key that says so, and what test data, the report of a test run
// or example code carries. A private key block without a key in it is the
// template of a library that writes keys, and no match at all.
//
// The secret itself is never read into the report: gitleaks runs with --redact,
// and a file found by its name is named, not shown. --reveal shows the line of
// each finding on the terminal for the maintainer who has to find it; it never
// reaches the JSON, and a run where CI is set refuses it. The repository's own
// .gitleaks.toml and .gitleaksignore apply to both scopes, the ignore file to the
// files found by name as well. make hands in the binary it fetched and checked
// against its digest. --self-test checks that each gitleaks rule this file names
// is one of gitleaks, data/gitleaks-rules.json, and that each rule which sets a
// match aside judges its examples as it should, and nothing else. Node 18 or
// newer, no npm dependency.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readData } from './data.mjs';
import {
	LEGEND,
	howToRun,
	plural,
	renderFindings,
	sortFindings,
	toJson,
	writeJsonFile,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',         // the checkout
	scope: 'all',     // shipped, history or all
	shipped: null,    // the tree that ships, relative to the checkout
	from: 'checkout', // where that tree came from: checkout, stage, tarball or tracked
	commits: null,    // a git log range for the history, instead of every commit
	placeholders: fileURLToPath(new URL('./secrets-placeholders.json', import.meta.url)),
	details: false,
	reveal: false,    // the line of each finding on the terminal, never in the JSON
	json: false,
	selfTest: false,  // the rule ids and the examples of the tables, nothing else
	jsonFile: null,
};
const SCOPES = ['shipped', 'history', 'all'];
const RANGE_OPTIONS = ['--all', '--not'];
const FROM = {
	checkout: 'the files make stage takes from the checkout',
	stage: 'the staged tree of make dist',
	tarball: 'the tarball',
	tracked: 'the tracked files of the checkout',
};
const SAMPLE = 3;    // commits named per file without --details
const CLIP = 160;    // characters of a revealed line
const GENERATED_SHOWN = 10; // files of each group of matches set aside, named without --details

// The files that are public by design and committed on purpose: the integrity
// signature with its certificate, any other file of appinfo/ signed the same
// way, such as the signature of what an app installs after it, and the
// checksums of its files an older app carried. A path counts below the app and
// below any directory of the repository. Where an entry names a content, a file
// of that name holding anything else is checked like any other; the key that
// signs is reported wherever it appears. A signature.json that is no JSON at all
// cannot be told from a signature by its content: only the matches of the
// formless rules in it are set aside, and the file gets a finding of its own.
const HEX = /^[0-9a-f]+$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const CERT = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n?$/;
const isObject = (j) => j !== null && typeof j === 'object' && !Array.isArray(j);
const object = (t) => { try { const j = JSON.parse(t); return isObject(j) ? j : null; } catch { return null; } };
const isJson = (t) => { try { JSON.parse(t); return true; } catch { return false; } };
const hexMap = (j) => isObject(j) && Object.keys(j).length > 0 && Object.values(j).every((v) => typeof v === 'string' && HEX.test(v));
const signed = (t) => {
	const j = object(t);
	return j !== null && Object.keys(j).sort().join() === 'certificate,hashes,signature'
		&& hexMap(j.hashes) && typeof j.signature === 'string' && BASE64.test(j.signature)
		&& typeof j.certificate === 'string' && CERT.test(j.certificate.replace(/\r\n/g, '\n'));
};
const PUBLIC_FILES = [
	{ path: '.ncmake/certificate.crt', what: 'the certificate of the integrity signature' },
	{ path: 'appinfo/signature.json', what: 'the integrity signature', content: signed, unreadable: 'the integrity signature, which is no valid JSON' },
	{ path: /(?:^|\/)appinfo\/[^/]+\.json$/, what: 'a file signed as the integrity signature is', content: signed },
	{ path: 'appinfo/checksum.json', what: 'the checksums of the files of an older release', content: (t) => hexMap(object(t)) },
];
const publicPath = (x, file) => (typeof x.path === 'string' ? file === x.path || file.endsWith(`/${x.path}`) : x.path.test(file));

function publicFile(file, read) {
	let text;
	for (const e of PUBLIC_FILES.filter((x) => publicPath(x, file))) {
		if (!e.content) return e;
		text ??= read();
		if (text === null) return null;
		if (e.content(text)) return e;
		if (e.unreadable && !isJson(text)) return { what: e.unreadable, invalid: true };
	}
	return null;
}

// Generated code is full of strings gitleaks takes for a key: hashes, minified
// names, content digests and embedded data. A generated file is one of these
// kinds by its name or its path, or lies below a directory .gitignore takes for
// build output, as make classifies js/ and vendor/. It is scanned all the same,
// since a key a build inlines from the environment ends up there. A page of
// built documentation, as a static site generator writes it to assets/js/,
// carries the curl lines of the source it is built from, which is scanned
// itself; also lists those rules.
const GENERATED = [
	{ what: 'a source map', name: /\.map$/ },
	{ what: 'a minified file', name: /\.min\.(?:js|css)$/ },
	{ what: 'a chunk of a bundle', name: /\.chunk\.m?js$/ },
	{ what: 'the cache of a tool', name: /^(?:\.php-cs-fixer\.cache|\.phpunit\.result\.cache|\.eslintcache)$/ },
	{ what: 'a page of built documentation', path: /(?:^|\/)assets\/js\/[\w~.-]+\.[0-9a-f]{8}\.js$/,
		also: ['curl-auth-user', 'curl-auth-header'],
		examples: ['assets/js/575981d1.805d5d36.js', 'docs/build/assets/js/runtime~main.0a1b2c3d.js'], not: ['assets/js/app.js', 'src/assets/js/main.js'] },
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
// The rules of the tokens GitHub issues. A real one ends up in a test or an
// example as easily as anywhere else, so these rules stay a secret wherever they
// match, as a private key does.
const GITHUB_TOKENS = ['github-pat', 'github-oauth', 'github-app-token', 'github-refresh-token'];
const ALWAYS = [...GITHUB_TOKENS, 'private-key'];

function generatedFile(file, ignored) {
	const e = GENERATED.find((x) => x.name?.test(path.posix.basename(file)) || x.path?.test(file));
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

// A generated file sets aside the matches of the formless rules, and those of
// the rules its entry lists as well.
const generatedMatch = (f, readLine, ignored) => {
	const e = generatedFile(f.file, ignored);
	return e && (e.also?.includes(f.rule) || formless(f, readLine)) ? e : null;
};

// Test data, the report of a test run and example code carry keys and tokens
// that were made up for them, or that served one run against a test server.
// Their matches are [i], but those of ALWAYS: a real token or key can end up in
// a test as well. A Postman collection is one by its name or by the schema it
// names. Its tokens and those of a newman report may still be valid, and are
// named for that.
const POSTMAN = /"schema"\s*:\s*"https:\/\/schema\.getpostman\.com\/json\/collection\//;
const SAMPLES = [
	{ what: 'test data', path: /(?:^|\/)(?:tests?|fixtures|__fixtures__|testdata|src\/[a-z]+Test)\/|\.(?:test|spec|golden|mock)\.[^/]+$|Test\.php$|_test\.go$/,
		examples: ['tests/Unit/FooTest.php', 'src/utils.spec.ts', 'browser/a.test.js', 'lib/fixtures/token.json', 'go/testdata/a.json', 'FooTest.php', 'src/vault/units.golden.json',
			'src/entities/user.mock.ts', 'internal/controller/user_test.go', 'shared/src/jvmTest/kotlin/VaultTest.kt'],
		not: ['lib/Testing.php', 'lib/latest/a.php', 'docs/spec.md', 'lib/Contest.php', 'lib/mock.php', 'cmd/latest.go', 'src/main/kotlin/Vault.kt'] },
	{ what: 'the report of a test run', path: /(?:^|\/)newman\/|\.postman_collection\.json$/,
		examples: ['newman/newman-run-report-2026-03-10.json', 'api/app.postman_collection.json'], not: ['lib/Newman.php'] },
	{ what: 'a Postman collection', path: /\.json$/, content: (t) => POSTMAN.test(t),
		examples: [['Resources/admin_collection.json', '{"info": {"schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"}}']],
		not: [['Resources/admin_collection.json', '{"info": {}}']] },
	{ what: 'example code', path: /(?:^|\/)examples?(?:[-_][^/]*)?\/|(?:^|\/)vendor\/(?:[^/]+\/)*demo\//,
		examples: ['vendor/tecnickcom/tcpdf/examples/cert.p12', 'examples/crypto/key.asc', 'vendor/a/b/demo/map.php', 'lib/Settings/example-sets/a.json'],
		not: ['lib/demo/map.php', 'lib/Example.php', 'lib/counterexamples/a.php'] },
];

function sampleFile(file, read) {
	for (const e of SAMPLES.filter((x) => x.path.test(file))) {
		if (!e.content) return e;
		const text = read();
		if (text !== null && e.content(text)) return e;
	}
	return null;
}

// A private-key match spans from the line of a BEGIN ... PRIVATE KEY line to an
// END line. The shortest key in such a block, Ed25519 in PKCS #8, is 64
// characters of base64; a library that writes or parses keys has the two lines
// as strings in its code with no key between them. Escaped line breaks join the
// lines of a key written into a string.
const KEY_BODY = /[A-Za-z0-9+/=]{64,}/;
function keyTemplate(span) {
	const block = /PRIVATE KEY(?: BLOCK)?-----([\s\S]*?)-----END/.exec(span ?? '');
	return Boolean(block) && !KEY_BODY.test(block[1].replace(/\\[nr]/g, ''));
}
// Built at run time, so that gitleaks does not take the keys of the self-test
// for keys in this file.
const pem = (body, sep = '\n') => [`-----BEGIN ${'PRIVATE'} KEY-----`, body, `-----END ${'PRIVATE'} KEY-----`].join(sep);
// Built at run time as well: the push protection of GitHub refuses a commit
// that holds a key of this form.
const stripe = (mode) => ['sk', mode, '4eC39HqLyjWDarjtT1zdp7dc'].join('_');
const KEY_TEMPLATES = {
	examples: [pem("' + body + '"), pem('${chunks.join("\\n")}', '\\n'), pem('%s')],
	not: [pem('MC4CAQAwBQYDK2VwBCIEI'.padEnd(64, 'A')), pem(`${'MC4CAQAwBQYDK2VwBCIE'.padEnd(64, 'B')}\\n${'C'.repeat(20)}`, '\\n')],
};

// gitleaks redacts the value it matched, in the match as well, wherever the
// value appears in it: admin:admin holds REDACTED twice. The text the match
// covers is read back from the file, and what stands where each REDACTED
// stands, the same each time, is the value. A match that does not line up with
// the text gives no value and stays a secret. The key is the name the match
// puts before the value, and the value is quoted when a quote stands right
// before it.
const unquote = (s) => s.replace(/^(['"])(.*)\1$/s, '$2');
function valueOf(f, text) {
	const parts = (f.match ?? '').split('REDACTED');
	if (parts.length < 2 || text === null) return null;
	for (let i = text.indexOf(parts[0]); i !== -1; i = text.indexOf(parts[0], i + 1)) {
		const start = i + parts[0].length;
		// With nothing after it in the match, the value ends where the text ends.
		if (parts.length === 2 && !parts[1]) return text.slice(start) || null;
		for (let end = text.indexOf(parts[1], start + 1); end !== -1; end = text.indexOf(parts[1], end + 1)) {
			const value = text.slice(start, end);
			let at = end + parts[1].length;
			if (parts.slice(2).every((p) => {
				if (!text.startsWith(value + p, at)) return false;
				at += value.length + p.length;
				return true;
			})) return value;
		}
	}
	return null;
}
const keyOf = (f) => {
	const before = (f.match ?? '').split('REDACTED')[0];
	return { key: /[\w$./-]*$/.exec(before.replace(/[^\w$./-]+$/, ''))[0], quoted: /['"`]$/.test(before), element: /['"]>$/.test(before) };
};

// The matches that are no secret by their value, their key or the file they
// are in. Each entry names the rules it judges; its examples must be judged as
// no secret and its counter-examples not, or --self-test fails.
const HASH_WORDS = ['hash', 'sha', 'sha1', 'sha256', 'sha384', 'sha512', 'digest', 'integrity', 'checksum', 'preferred', 'fingerprint', 'keygrip'];
const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const DIGEST = /^(?:sha(?:1|256|384|512)-)?(?:[0-9a-f]{32,}|[A-Za-z0-9+/_-]{20,}={0,2})$/i;
const hexDigest = (v) => HEX.test(v) && [32, 40, 56, 64, 96, 128].includes(v.length);
// Ten characters in a row of the alphabet or the digits, as a table of the
// characters a code takes is written, not a value drawn at random.
const alphabetRun = (v) => {
	let run = 1;
	for (let i = 1; i < v.length; i++) {
		run = v.charCodeAt(i) === v.charCodeAt(i - 1) + 1 && /[a-z0-9]/i.test(v[i]) ? run + 1 : 1;
		if (run >= 10) return true;
	}
	return false;
};
const FORMLESS_RULES = FORMLESS.map((x) => x.rule);
const NOT_SECRETS = [
	{ what: 'the name of a constant', rules: ['generic-api-key'], test: ({ value }) => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value),
		examples: [{ value: 'KEY_CHARS' }, { value: 'CACHE_KEY_V2' }], not: [{ value: 'JBSWY3DPEHPK3PXP' }] },
	{ what: 'a run of the alphabet', rules: ['generic-api-key'], test: ({ value }) => alphabetRun(value),
		examples: [{ value: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' }, { value: '0123456789abcdef' }], not: [{ value: 'f3a9c2e17b4d5e6a' }] },
	{ what: 'a property access in code', rules: ['generic-api-key'],
		test: ({ value, quoted }) => !quoted && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value),
		examples: [{ value: 'options.privateKeys', quoted: false }], not: [{ value: 'options.privateKeys', quoted: true }, { value: 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', quoted: true }] },
	{ what: 'a hash, as its key says', rules: FORMLESS_RULES, test: ({ key, value }) => words(key).some((w) => HASH_WORDS.includes(w)) && DIGEST.test(value),
		examples: [{ key: 'tokenHash', value: '9b74c9897bac770ffc029102a200c5de' }, { key: 'integrity', value: 'sha512-q9w8e7r6t5y4u3i2o1p0asdfghjklzxc' }, { key: 'source_sha256', value: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' },
			{ key: 'keygrip', value: '9b74c9897bac770ffc029102a200c5de12345678' }],
		not: [{ key: 'shared_secret', value: '9b74c9897bac770ffc029102a200c5de' }, { key: 'apiKey', value: '9b74c9897bac770ffc029102a200c5de' }] },
	{ what: 'the checksum of a file', rules: FORMLESS_RULES, test: ({ key, value }) => /(?:^|\/)[\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(key) && hexDigest(value),
		examples: [{ key: 'lib/Controller/NoteApiController.php', value: '9b74c9897bac770ffc029102a200c5de' }],
		not: [{ key: 'apiKey', value: '9b74c9897bac770ffc029102a200c5de' }, { key: 'scores.key', value: 'q9w8e7r6t5y4u3i2o1p0asdfghjklzxc' }] },
	{ what: 'the nonce of a WebSocket handshake', rules: ['generic-api-key'], test: ({ key }) => /^Sec-WebSocket-Key$/i.test(key),
		examples: [{ key: 'Sec-WebSocket-Key', value: 'dGhlIHNhbXBsZSBub25jZQ==' }], not: [{ key: 'X-Api-Key', value: 'dGhlIHNhbXBsZSBub25jZQ==' }] },
	{ what: 'the text of an element, after an attribute that holds the word', rules: ['generic-api-key'], test: ({ element }) => element,
		examples: [{ key: 'plain', value: 'secret-reference', element: true }], not: [{ key: 'token', value: 'secret-reference', element: false }] },
	{ what: 'a test key of the provider', rules: ['stripe-access-token'], test: ({ value }) => /^(?:sk|rk)_test_/.test(value),
		examples: [{ value: stripe('test') }], not: [{ value: stripe('live') }] },
	{ what: 'a translation', rules: null, test: ({ file }) => /(?:^|\/)l10n\/[^/]+\.(?:js|json)$/.test(file),
		examples: [{ file: 'l10n/da.json', rule: 'dropbox-api-token' }, { file: 'l10n/es.js', rule: 'dropbox-api-token' }],
		not: [{ file: 'lib/l10n.php', rule: 'dropbox-api-token' }, { file: 'l10n/de.json', rule: 'github-pat' }] },
];

function notSecret(ctx) {
	if (ALWAYS.includes(ctx.rule)) return null;
	return NOT_SECRETS.find((e) => (!e.rules || e.rules.includes(ctx.rule)) && e.test(ctx)) ?? null;
}

// The matches set aside are left out of the secrets and only counted, per
// file, so the report shows that the file was read.
// The files come in the order the report tallies them, the most matches first.
function setAside(found, pick) {
	const aside = new Map();
	const kept = found.filter((f) => {
		const e = pick(f);
		if (!e) return true;
		const x = aside.get(f.file) ?? { file: f.file, what: e.what, ...(e.invalid ? { invalid: true } : {}), matches: 0, commits: new Set(), rules: {} };
		x.matches++;
		x.rules[f.rule] = (x.rules[f.rule] ?? 0) + 1;
		for (const c of f.commits ?? (f.commit ? [f.commit] : [])) x.commits.add(c);
		aside.set(f.file, x);
		return false;
	});
	return { kept, aside: [...aside.values()]
		.map((x) => ({ ...x, commits: x.commits.size, rules: Object.fromEntries(Object.entries(x.rules).sort(([a], [b]) => a.localeCompare(b))) }))
		.sort((a, b) => b.matches - a.matches || a.file.localeCompare(b.file)) };
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

function placeholder(f, text, list) {
	const v = unquote(valueOf(f, text) ?? '');
	if (!v) return false;
	const pair = /^[^:]+:(.+)$/s.exec(v)?.[1];
	return list.some((re) => re.test(v) || (pair !== undefined && re.test(unquote(pair))));
}

const spanOf = (f, linesOf) => (f.line ? linesOf(f).slice(f.line - 1, f.endLine ?? f.line).join('\n') : null);

// The matches that are placeholders are counted per file, as those in a
// generated file are. The match, redacted as it is, only serves to find the
// value and does not reach the JSON.
function asidePlaceholders(found, linesOf, list) {
	const { kept, aside } = setAside(found, (f) => placeholder(f, spanOf(f, linesOf), list) && { what: 'placeholders' });
	for (const f of kept) { delete f.endLine; delete f.match; }
	return { kept, aside };
}

// The gitleaks matches outside a public file, judged in this order: a key
// template is dropped, as it holds no key; a match in a generated file, one
// that is no secret by its value and a placeholder are set aside.
function judge(kept, linesOf, ignored, placeholders) {
	const line = (f) => () => linesOf(f)[f.line - 1];
	const keys = kept.filter((f) => f.rule !== 'private-key' || !keyTemplate(spanOf(f, linesOf)));
	const { kept: rest, aside: generated } = setAside(keys, (f) => generatedMatch(f, line(f), ignored));
	const { kept: values, aside: notSecrets } = setAside(rest, (f) => {
		const text = spanOf(f, linesOf);
		return notSecret({ rule: f.rule, file: f.file, ...keyOf(f), value: unquote(valueOf(f, text) ?? '') });
	});
	const { kept: found, aside: placeholder } = asidePlaceholders(values, linesOf, placeholders);
	return { found, generated, notSecrets, placeholder };
}

// A public file whose signature is no valid JSON sets aside only the matches
// of the formless rules.
const exemptMatch = (f, e, readLine) => (e && (!e.invalid || formless(f, readLine)) ? e : null);

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
                        and every file whose matches are set aside
  --reveal              show the line of each finding on the terminal; never
                        in the JSON, and refused where CI is set
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  --self-test           check that each gitleaks rule this file names is one of
                        gitleaks and that each table judges its examples, and
                        nothing else
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
			case '--self-test': opt.selfTest = true; break;
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
// The keys of auth.json that hold a credential are composer's, data/composer-auth.json;
// without that file the rule is left out, and the report says so.
const COMPOSER_AUTH = readData('composer-auth')?.values?.keys ?? null;
const NAME_RULES = [
	{ id: 'private-key-file', what: 'a private key file', name: /\.key$/i },
	{ id: 'ssh-private-key', what: 'an SSH private key', name: /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_[^.]*)?$/ },
	{ id: 'pem-private-key', what: 'a PEM file with a private key', name: /\.pem$/i, content: (t) => PRIVATE_KEY.test(t) },
	{ id: 'key-store', what: 'a PKCS #12 key store', name: /\.(?:p12|pfx)$/i },
	{ id: 'env-file', what: 'an .env file', name: /^\.env(?:\..+)?$/, not: /\.(?:example|sample|dist|template|defaults)$/i,
		reveal: (t) => t.split('\n').filter((l) => /^\s*[^#\s][^=]*=\s*\S/.test(l)) },
	...(COMPOSER_AUTH ? [{ id: 'composer-auth', what: 'the auth.json of composer with a credential', name: /^auth\.json$/,
		content: (t) => { try { const j = JSON.parse(t); return COMPOSER_AUTH.some((k) => j?.[k] && Object.keys(j[k]).length); } catch { return false; } },
		reveal: (t) => { try { const j = JSON.parse(t); return COMPOSER_AUTH.filter((k) => j?.[k]).map((k) => `"${k}": ${JSON.stringify(j[k])}`); } catch { return []; } } }] : []),
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
	const lines = new Map();
	const linesOf = (f) => {
		if (!lines.has(f.file)) lines.set(f.file, read(f.file)?.split('\n') ?? []);
		return lines.get(f.file);
	};
	const { kept, aside: exempt } = setAside(runGitleaks(root, ['dir', '.'], tree).map((g) => ({
		rule: g.RuleID, what: g.Description, file: g.File.replace(/^\.\//, ''), line: g.StartLine ?? null, fingerprint: g.Fingerprint,
		endLine: g.EndLine ?? null, match: g.Match,
	})), (f) => exemptMatch(f, isPublic(f.file), () => linesOf(f)[f.line - 1]));
	// The tree that ships keeps the paths of the checkout, so its .gitignore applies.
	const ignored = ignoredDirs(root, kept.map((f) => f.file));
	const { found: judged, generated, notSecrets, placeholder } = judge(kept, linesOf, ignored, placeholders);
	const seen = new Set([...judged, ...exempt, ...generated, ...notSecrets, ...placeholder].map((f) => f.file));
	for (const file of files) {
		if (seen.has(file) || ignore.file(file) || isPublic(file)) continue;
		const r = byName(file, () => read(file));
		const fingerprint = r && `${file}:${r.id}:1`;
		if (r && !ignore.has(fingerprint)) judged.push({ rule: r.id, what: r.what, file, line: null, fingerprint });
	}
	const texts = new Map();
	const { kept: found, aside: samples } = setAside(judged, (f) => !ALWAYS.includes(f.rule) && sampleFile(f.file, () => {
		if (!texts.has(f.file)) texts.set(f.file, read(f.file));
		return texts.get(f.file);
	}));
	return { tree: opt.shipped, from: opt.from, files: files.length, found: found.sort(byPlace), exempt, generated, notSecrets, placeholders: placeholder, samples };
}

// == The history ==
// gitleaks reads every commit through git log -p; the files found by their name
// come from the paths each commit adds or changes, oldest first, so a file is
// reported with the commit that brought it in.
function history(root, opt, ignore, placeholders) {
	if (git(root, ['rev-parse', '--git-dir']).status !== 0) return { error: `${root} is not a git checkout` };
	// gitleaks splits --log-opts into words, so git reads the range the same way,
	// and --all --not <tip>... covers every ref but the commits already scanned.
	// An app below the top of its repository is scanned in the history of its own
	// directory; the rest of a monorepo is not the app's.
	const below = git(root, ['rev-parse', '--show-prefix']).stdout.trim() !== '';
	const range = [...(opt.commits ? opt.commits.split(/\s+/).filter(Boolean) : ['--all']), ...(below ? ['--', '.'] : [])];
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
	const lines = new Map();
	const linesOf = (f) => {
		const key = `${f.commit}:${f.file}`;
		if (!lines.has(key)) {
			const b = git(root, ['cat-file', '-p', key]);
			lines.set(key, b.status === 0 ? b.stdout.split('\n') : []);
		}
		return lines.get(key);
	};
	const { kept, aside: exempt } = setAside(runGitleaks(root, ['git', '--log-opts', range.join(' '), '.'], root).map((g) => ({
		rule: g.RuleID, what: g.Description, file: g.File, line: g.StartLine ?? null, commit: g.Commit, date: g.Date ?? null,
		fingerprint: g.Fingerprint, endLine: g.EndLine ?? null, match: g.Match,
	})), (f) => exemptMatch(f, isPublic(f.commit, f.file), () => linesOf(f)[f.line - 1]));
	// The paths of the history start at the top of the repository, and the
	// .gitignore of the checkout decides for every commit, as it does for make.
	const top = git(root, ['rev-parse', '--show-toplevel']).stdout.trim() || root;
	const ignored = ignoredDirs(top, kept.map((f) => f.file));
	const { found: judged, generated, notSecrets, placeholder } = judge(kept, linesOf, ignored, placeholders);
	// A file gitleaks has reported is not reported again for its name.
	const seen = new Set([...judged, ...exempt, ...generated, ...notSecrets, ...placeholder].map((f) => f.file));
	const log = git(root, ['log', '--reverse', '--no-renames', '--diff-filter=AM', '--format=%x00%H %cI', '--name-only', ...range]);
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
	judged.push(...byFile.values());
	const texts = new Map();
	const { kept: found, aside: samples } = setAside(judged, (f) => !ALWAYS.includes(f.rule) && sampleFile(f.file, () => {
		const key = `${f.commit}:${f.file}`;
		if (!texts.has(key)) {
			const b = git(root, ['cat-file', '-p', key]);
			texts.set(key, b.status === 0 ? b.stdout : null);
		}
		return texts.get(key);
	}));
	return { range: opt.commits, commits: Number(count.stdout.trim()), found: found.sort(byPlace), exempt, generated, notSecrets, placeholders: placeholder, samples };
}

// == The check ==
// Everything besides the commits that decides what a scan finds: the gitleaks
// version, this file with its rules for files found by name, the keys of
// auth.json those rules take from data/ (the keys, not the file, whose read date
// changes with every refresh), the placeholders, and the repository's
// .gitleaks.toml and .gitleaksignore. A consumer that keeps
// the result of a history scan and later scans only the newer commits starts
// over once this value changes.
function rules(root, gitleaksVersion, placeholders) {
	const read = (f) => { try { return fs.readFileSync(f); } catch { return Buffer.alloc(0); } };
	const h = createHash('sha256');
	for (const part of [Buffer.from(gitleaksVersion ?? ''), read(new URL(import.meta.url)),
		Buffer.from(JSON.stringify(COMPOSER_AUTH)), read(placeholders),
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
// gitleaks reports in no fixed order, so the findings are sorted, in the report,
// whose list make secrets-ignore numbers for a choice, and in the JSON, which two
// runs of the same tree then give alike: by date in the history, then by file,
// line, rule and commit.
const byPlace = (a, b) => String(a.date ?? '').localeCompare(String(b.date ?? ''))
	|| a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0)
	|| a.rule.localeCompare(b.rule) || String(a.commit ?? '').localeCompare(String(b.commit ?? ''));
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
				r.shipped.from === 'tracked'
					? `  It is in ${FROM[r.shipped.from]}, so every clone of the repository carries it.`
					+ ' Take it out and revoke it: once pushed, it is no longer secret.'
					: `  It is in ${FROM[r.shipped.from]}, so a release carries it to every server that installs the app.`
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
	const invalid = new Map();
	const countInvalid = (x, where) => {
		if (!invalid.has(x.file)) invalid.set(x.file, []);
		invalid.get(x.file).push(`${plural(x.matches, 'match', 'matches')} ${where}`);
	};
	for (const x of r.shipped?.exempt ?? []) (x.invalid ? countInvalid : count)(x, 'in what ships');
	for (const x of r.history?.exempt ?? []) (x.invalid ? countInvalid : count)(x, `in ${plural(x.commits, 'commit', 'commits')}`);
	if (exempt.size) {
		out.push({ level: 'info', id: 'public-files', lines: [
			'These files are public by design, so what gitleaks matches in them is not reported:',
			...[...exempt].map(([file, x]) => `  ${file}, ${x.what}: ${x.where.join(', ')}.`),
		] });
	}
	if (invalid.size) {
		out.push({ level: 'info', id: 'signature-invalid', lines: [
			'These integrity signatures are no valid JSON, so their content cannot be told from that of a signature.'
			+ ' Only the matches of the rules that take any string of high entropy are not reported in them:',
			...[...invalid].map(([file, where]) => `  ${file}: ${where.join(', ')}.`),
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
			+ ' and minified names are as well, or the curl lines a page of built documentation copies from its source,'
			+ ' so the matches are not reported as secrets:',
			...generated,
			'  A key a build takes from the environment ends up in such a file too: where one of them has no reason to'
			+ ' carry a key, look at it.',
		] });
	}
	const notSecrets = tally('notSecrets', (file, x) => `${file}, ${x.what}`);
	if (notSecrets.length) {
		out.push({ level: 'info', id: 'not-secrets', lines: [
			'In these files gitleaks matches values that are no secret by their form, their key or the file,'
			+ ' which each line names. The matches are not reported as secrets:',
			...notSecrets,
		] });
	}
	if (!COMPOSER_AUTH) {
		out.push({ level: 'info', id: 'composer-auth-unchecked', lines: [
			'An auth.json of composer is not checked for a credential: data/composer-auth.json, the keys that hold one, is not there.',
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
	const samples = tally('samples', (file, x) => `${file}, ${x.what}`);
	if (samples.length) {
		out.push({ level: 'info', id: 'samples', lines: [
			'These files are test data, the report of a test run or example code, whose keys and tokens are made up'
			+ ' or serve a test, so the matches are not reported as secrets. Those of a private key or a GitHub token are:',
			...samples,
			'  A token a test run used against a real server stays valid until it is revoked: where one of these files'
			+ ' holds one, revoke it.',
		] });
	}
	return sortFindings(out);
}

// == Revealing a finding ==
// What --reveal adds to a finding on the terminal: the line gitleaks found, or
// for a file found by its name the lines that carry the credential. A key file is
// the secret as a whole, and is not printed. Read from the tree that ships or
// from the commit, never kept.
// A cut between the two halves of a surrogate pair would print a broken character.
const clip = (l) => {
	if (l.length <= CLIP) return l;
	const end = /[\uD800-\uDBFF]/.test(l[CLIP - 1]) ? CLIP - 1 : CLIP;
	return `${l.slice(0, end)} ...`;
};

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

// == Self-test ==
// The tables name gitleaks rules by their id. A rule gitleaks renames or drops
// would turn the matches set aside into secrets, or the other way round, and
// nothing would say why. Each table that sets a match aside judges its examples
// as no secret and its counter-examples as one.
const SIGNATURES = {
	valid: JSON.stringify({ hashes: { 'appinfo/info.xml': 'ab12' }, signature: 'c2lnbmF0dXJl',
		certificate: `-----BEGIN CERTIFICATE-----\n${'Q'.repeat(64)}\n-----END CERTIFICATE-----` }),
	invalid: '{"hashes": {"appinfo/info.xml": "ab12"}, "certificate": "-----BEGIN CERTIFICATE-----\nQQ\n-----END CERTIFICATE-----"}',
};
const ruleIds = () => [...new Set([...FORMLESS_RULES, ...ALWAYS, 'curl-auth-user', 'curl-auth-header',
	...GENERATED.flatMap((e) => e.also ?? []), ...NOT_SECRETS.flatMap((e) => e.rules ?? [])])];
function selfTest() {
	const failures = [];
	const known = readData('gitleaks-rules')?.values?.rules;
	if (!known) failures.push('data/gitleaks-rules.json, the rules of gitleaks, is not there');
	else failures.push(...ruleIds().filter((id) => !known.includes(id)).map((id) => `${id} is no rule of gitleaks`));
	const judged = (what, x, ok) => {
		if (!ok) failures.push(`${what}: ${JSON.stringify(x)} is judged wrong`);
	};
	for (const e of GENERATED.filter((x) => x.examples)) {
		for (const x of e.examples) judged(e.what, x, generatedFile(x, new Set()) === e);
		for (const x of e.not) judged(e.what, x, generatedFile(x, new Set()) === null);
	}
	for (const e of SAMPLES) {
		const run = (x) => (Array.isArray(x) ? sampleFile(x[0], () => x[1]) : sampleFile(x, () => null));
		for (const x of e.examples) judged(e.what, x, run(x) === e);
		for (const x of e.not) judged(e.what, x, run(x) === null);
	}
	for (const e of NOT_SECRETS) {
		const ctx = (x) => ({ rule: e.rules?.[0] ?? 'generic-api-key', file: '', key: '', value: '', quoted: false, element: false, ...x });
		for (const x of e.examples) judged(e.what, x, notSecret(ctx(x)) === e);
		for (const x of e.not) judged(e.what, x, notSecret(ctx(x)) === null);
	}
	for (const x of KEY_TEMPLATES.examples) judged('a key template', x, keyTemplate(x));
	for (const x of KEY_TEMPLATES.not) judged('a key template', x, !keyTemplate(x));
	judged('the integrity signature', 'valid', publicFile('appinfo/signature.json', () => SIGNATURES.valid)?.invalid === undefined);
	judged('the integrity signature', 'no JSON', publicFile('appinfo/signature.json', () => SIGNATURES.invalid)?.invalid === true);
	return failures;
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
if (opt.selfTest) {
	const failures = selfTest();
	for (const f of failures) process.stdout.write(`  [!] ${f}\n`);
	process.stdout.write(failures.length
		? `secrets-audit: ${plural(failures.length, 'check fails', 'checks fail')}.\n`
		: `secrets-audit: ${plural(ruleIds().length, 'rule id is', 'rule ids are')} one of gitleaks, and every table judges its examples.\n`);
	process.exit(failures.length ? 1 : 0);
}
const report = check(opt);
report.findings = findings(report, opt);
const json = opt.json || opt.jsonFile ? toJson(report, die) : null;
process.stdout.write(opt.json ? json : `${render(report, opt)}\n`);
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
process.exitCode = report.findings.some((f) => f.level === 'warn') ? 1 : 0;
