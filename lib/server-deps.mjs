#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// server-deps - the apps an app needs on the server beyond what info.xml can say.
//
// Some apps build on another app, and info.xml has no way to name it. The test
// server of install-test and runtime-audit has only the app under test, so such
// an app fails on every class of the other one. lib/server-setup.sh leaves, in
// the directory of a run:
//   missing      the namespaces OCA\<X> an error of the run names as a class
//                that does not exist, where no enabled app has that namespace
//   deps         one line per app installed before the app under test:
//                id and the exit code of occ app:enable
//   deps.<id>.txt  the output of that occ app:enable
// and make leaves build/<target>/deps/<tag>/picked, one line per namespace it
// looked up in the App Store: namespace, app id, version and what came of it.
//
// With --pick=<apps.json> <run directory> this prints, per missing namespace,
// the App Store app and the release that would bring it to the server of that
// run, as make install-test and make runtime-audit ask for it. Imported, it
// reads those files and tells which entries of a run the missing app causes.
// It reads no network and has no npm dependency. Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const lines = (text) => (text ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);

// == App ids for a namespace ==
// The server takes the namespace of an app from <namespace> in its info.xml,
// or else from its id with a capital first letter. Which app id stands behind a
// namespace is therefore only a guess until the info.xml of the release says
// so: the namespace in lower case, and with each inner capital as _ and the
// letter in lower case. make checks the <namespace> of the downloaded release.
export function candidateIds(ns) {
	const lower = ns.toLowerCase();
	const snake = ns.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
	return [...new Set([lower, snake])];
}

// == Which entries the missing app causes ==
// An entry is caused by a missing app when its text names a class of that
// namespace, or a table whose name starts with an id that namespace stands for:
// an app that reads the tables of the other one fails on them as well.
const NO_TABLE = /does(?:n't| not) exist|no such table|undefined table|base table or view not found/i;

export function causedBy(missing) {
	if (!missing.length) return () => null;
	const classes = missing.map((ns) => ({ ns, re: new RegExp(`OCA\\\\+${ns}\\\\`, 'i') }));
	const tables = missing.map((ns) => ({ ns, re: new RegExp(`\\boc_(?:${candidateIds(ns).join('|')})(?:_\\w*)?\\b`, 'i') }));
	return (text) => {
		const s = String(text ?? '');
		const c = classes.find((x) => x.re.test(s));
		if (c) return c.ns;
		if (!NO_TABLE.test(s)) return null;
		return tables.find((x) => x.re.test(s))?.ns ?? null;
	};
}

// == The files of a run ==
// tag is the directory of the run; the apps make picked are those of its major,
// the tag without the -php<minor> of a run on the PHP of max-version.
export function readDeps(base, tag) {
	const dir = path.join(base, tag);
	const picked = new Map();
	for (const l of lines(read(path.join(base, 'deps', tag.replace(/-php[0-9.]+$/, ''), 'picked')))) {
		const [ns, id, version, state] = l.split('\t');
		picked.set(ns.toLowerCase(), { ns, id: id === '-' ? null : id, version: version === '-' ? null : version, state });
	}
	const installed = lines(read(path.join(dir, 'deps'))).map((l) => {
		const [id, rc] = l.split('\t');
		const p = [...picked.values()].find((x) => x.id === id);
		return {
			id,
			rc: Number(rc),
			ns: p?.ns ?? null,
			version: p?.version ?? null,
			output: lines(read(path.join(dir, `deps.${id}.txt`))),
		};
	});
	return { missing: lines(read(path.join(dir, 'missing'))), installed, picked };
}

// Why the App Store did not bring the app of a missing namespace.
export function pickedText(p) {
	if (!p) return 'the App Store was not asked';
	const app = p.id ? `the app ${p.id}${p.version ? ` ${p.version}` : ''}` : '';
	return {
		'not-found': 'no app of the App Store has an id that namespace stands for',
		'no-release': `${app} of the App Store has no release for this server`,
		'download-failed': `the download of ${app} from the App Store failed`,
		namespace: `${app} of the App Store has another namespace`,
		'no-appstore': 'the App Store module of ncmake is not loaded (make dev-init)',
		catalogue: 'the list of apps of the App Store could not be fetched',
		installed: `${app} of the App Store was installed, and the class is missing all the same`,
	}[p.state] ?? `the App Store lookup ended with ${p.state}`;
}

// The text of the finding about the apps a run needs: the first line, why the
// App Store did not bring a missing one, and what came of those it did bring.
// folded are the headlines of the findings the missing app causes, which the
// analyser leaves out of its report, and evidence the entries behind them as
// the analyser samples them.
export function needsAppText(name, deps, folded, evidence) {
	const ns = (x) => `OCA\\${x}`;
	const out = [];
	const brought = deps.installed.map((d) => `${d.id}${d.version ? ` ${d.version}` : ''}`).join(', ');
	if (deps.missing.length) {
		out.push(`${name}: the app needs the app of ${deps.missing.map(ns).join(', ')}, which the test server does not have,`
			+ ' and info.xml has no way to name it.');
		for (const x of deps.missing) out.push(`  ${ns(x)}: ${pickedText(deps.picked.get(x.toLowerCase()))}.`);
	} else {
		out.push(`${name}: the app needs ${brought}, which the test server does not have and info.xml has no way to name;`
			+ ' the run fetched it from the App Store and enabled it before the app.');
	}
	for (const d of deps.installed) {
		if (deps.missing.length) out.push(`  ${d.id}${d.version ? ` ${d.version}` : ''}${d.ns ? `, the app of ${ns(d.ns)},` : ''} came from the App Store and was enabled before the app.`);
		if (d.rc) out.push(`  occ app:enable ${d.id} fails with exit code ${d.rc}:`, ...d.output.slice(-3).map((l) => `    ${l}`));
	}
	if (folded.length) {
		out.push('  What it causes is not reported on its own:', ...folded.map((l) => `    ${l}`));
		if (evidence.length) out.push('  The entries behind it:', ...evidence);
	}
	return out;
}

// == The release for a server ==
// The order of PHP version_compare for X.Y.Z with an optional pre-release.
const PRE = { alpha: 1, a: 1, beta: 2, b: 2, rc: 3 };
function parseVersion(v) {
	const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(alpha|beta|rc|a|b)\.?(\d+)?)?/i.exec(String(v ?? '').trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ? PRE[m[4].toLowerCase()] : 9, Number(m[5] ?? 0)];
}
function compareVersions(a, b) {
	for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

// A version spec of the App Store: "*", or constraints such as ">=26.0.0 <27.0.0".
function satisfies(spec, version) {
	const v = parseVersion(version);
	if (!v) return true;
	for (const c of String(spec ?? '*').split(/\s+/).filter((x) => x && x !== '*')) {
		const m = /^(>=|<=|>|<|==|=)?(.+)$/.exec(c);
		const w = parseVersion(m[2]);
		if (!w) continue;
		const d = compareVersions(v.slice(0, 3).concat(9, 0), w);
		const ok = { '>=': d >= 0, '<=': d <= 0, '>': d > 0, '<': d < 0, '==': d === 0, '=': d === 0 }[m[1] ?? '=='];
		if (!ok) return false;
	}
	return true;
}

// The newest stable release for the server and its PHP, or else for the
// server alone: a release that refuses the PHP shows that in occ app:enable.
function pick(apps, ns, server, php) {
	const entry = candidateIds(ns).map((id) => apps.find((a) => a.id === id)).find(Boolean);
	if (!entry) return [ns, '-', '-', '-', 'not-found'];
	const fit = (entry.releases ?? [])
		.filter((r) => !r.isNightly && r.download && parseVersion(r.version) && satisfies(r.platformVersionSpec, server))
		.sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
	const stable = fit.filter((r) => parseVersion(r.version)[3] === 9);
	const pool = stable.length ? stable : fit;
	const r = pool.find((x) => satisfies(x.phpVersionSpec, php)) ?? pool[0];
	if (!r) return [ns, entry.id, '-', '-', 'no-release'];
	return [ns, entry.id, r.version, r.download, 'ok'];
}

// == Command line ==
function die(msg) {
	process.stderr.write(`server-deps: ${msg}\n`);
	process.exit(2);
}

function main(argv) {
	const file = argv.find((a) => a.startsWith('--pick='))?.slice('--pick='.length);
	const dir = argv.find((a) => !a.startsWith('-'));
	if (!file || !dir) die('usage: server-deps.mjs --pick=<apps.json> <run directory>');
	let apps;
	try { apps = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`${file} is unreadable: ${e.message}`); }
	if (!Array.isArray(apps)) die(`${file} is no list of apps`);
	let status = null;
	try { status = JSON.parse(read(path.join(dir, 'status.json'))); } catch { /* no server version: every release fits */ }
	const server = status?.versionstring ?? status?.version ?? null;
	const php = read(path.join(dir, 'php'))?.trim() || null;
	for (const ns of lines(read(path.join(dir, 'missing')))) process.stdout.write(`${pick(apps, ns, server, php).join('\t')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
