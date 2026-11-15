#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// profile - what an app costs the requests of a server, and its own.
//
// make profile runs make php-audit first, whose inventory has the routes of the
// app, in build/reports/php-audit.json. With --plan this turns its GET routes,
// and the requests profile_requests in ncmake.mk names, into the requests of
// the app the server half sends, build/profile/plan: one line per request,
// tab-separated, "<verb> <user|admin> <path>". With --previous=<apps.json> it
// prints the release the App Store catalogue has before the version of the
// checkout, "<version> <download>", for the recipe to fetch.
//
// lib/profile.sh then runs on an installed Nextcloud server with
// nextcloud/profiler enabled and its caches on Redis, and leaves under
// build/profile/<tag>:
//   php, status.json        the PHP and the server the run had
//   base/<round>.json       the requests that are not the app's, without it
//   previous/<round>.json   the same and the requests of the app, with the
//                           previous release
//   app/<round>.json        the same with the staged app
//   <phase>.version         the version of the app each phase had
//   <phase>.stopped         a phase that could not install the app: copy or enable
//   stopped, failed         the step a run did not get past, the exit code of a
//                           container that did not finish
// Each round file is what lib/profile.php keeps of one export of the profiler:
// per request the queries with their parameters and the frame of the app in
// their backtrace, the cache operations, the number of events, the time and
// the memory peak.
//
// Without an option this reads those files and compares the phases. Counts,
// not times: the queries, cache operations and events of a request are the
// same each time once the server is warm, where the time of a request on a
// shared machine is not. Each figure is the lowest of the rounds, since what
// the server does now and then besides the request only ever adds to it, and
// a difference counts only where both sides reached their lowest figure in at
// least two rounds, or else where it is larger than the spread of the rounds.
// It runs nothing and reads no network, and has no npm dependency. Node 18 or
// newer.

import fs from 'node:fs';
import path from 'node:path';

import {
	LEGEND,
	howToRun,
	num,
	plural,
	renderFindings,
	sortFindings,
	table,
	toJson,
	writeJsonFile,
} from './report-text.mjs';
import { plan, readParams } from './route-plan.mjs';

// == Config ==
const defaults = {
	plan: false,       // write build/profile/plan instead of the report
	previous: null,    // print the previous release of this apps.json instead of the report
	details: false,    // every query behind a finding instead of the first few
	json: false,
	jsonFile: null,
};
const SAMPLE = 3;      // queries named per finding without --details
const SIMILAR = 5;     // the same SQL with this many parameter sets in one request is a repeat
const SQL_WIDTH = 110; // characters of an SQL statement the report shows
const PHASES = ['base', 'previous', 'app'];
const BASE = path.join('build', 'profile');
const REPORTS = path.join('build', 'reports');
const INVENTORY = path.join(REPORTS, 'php-audit.json');

// == Command line ==
function usage() {
	return `profile - what an app costs the requests of a server, and its own

Usage: profile.mjs [options]

  Runs in the app checkout. make profile must have run there, which leaves
  the inventory in ${INVENTORY} and its runs in ${BASE}.

Options:
  --plan                write the requests of the app to ${BASE}/plan
  --previous=<file>     print the release before this version in that apps.json
  --details             every query behind a finding, not the first ${SAMPLE}
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The report is written to ${REPORTS}/profile.txt and .json. The exit code is 0
with or without findings, and 2 when the run itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`profile: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') { process.stdout.write(`${usage()}\n`); process.exit(0); }
		else if (arg === '--plan') opt.plan = true;
		else if (arg === '--json') opt.json = true;
		else if (arg === '--details') opt.details = true;
		else if (arg.startsWith('--json-file=')) opt.jsonFile = arg.slice('--json-file='.length);
		else if (arg.startsWith('--previous=')) opt.previous = arg.slice('--previous='.length);
		else die(`unknown option: ${arg}`);
	}
	if (opt.jsonFile === '') die('--json-file needs a file');
	if (opt.previous === '') die('--previous needs a file');
	return opt;
}

// == Reading ==
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const readJson = (file) => {
	try { return JSON.parse(read(file)); } catch { return null; }
};
const lines = (text) => (text ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);

function readInventory() {
	const r = readJson(INVENTORY);
	if (!r?.inventory) die(`${INVENTORY} is missing or unreadable: make php-audit has to run first`);
	return r;
}

// key=value lines, as the recipe writes them.
function readRange(file) {
	const range = {};
	for (const l of lines(read(file))) {
		const i = l.indexOf('=');
		if (i > 0) range[l.slice(0, i)] = l.slice(i + 1);
	}
	return range;
}

// "<VERB> <path> ...", as ncmake.mk sets profile_requests: requests sent as the
// admin, for what the routes alone cannot say.
function readRequests(text) {
	const words = (text ?? '').split(/\s+/).filter(Boolean);
	const list = [];
	for (let i = 0; i + 1 < words.length; i += 2) list.push({ verb: words[i].toUpperCase(), as: 'admin', path: words[i + 1] });
	return { list, odd: words.length % 2 === 1 };
}

// == The plan ==
// Only the GET routes are measured on their own: a request that changes
// something answers differently each round, and its counts with it. Any other
// request the maintainer names in profile_requests.
function planRequests(inv) {
	const p = plan(inv, readParams(process.env.PROFILE_PARAMS));
	const seen = new Set();
	const requests = [];
	const add = (q) => {
		const key = `${q.verb} ${q.path}`;
		if (seen.has(key)) return;
		seen.add(key);
		requests.push(q);
	};
	for (const r of p.routes) if (r.verb === 'GET') add({ verb: 'GET', as: r.as, path: r.path });
	const extra = readRequests(process.env.PROFILE_REQUESTS);
	for (const q of extra.list) add(q);
	return { requests, skipped: p.skipped, notGet: p.routes.filter((r) => r.verb !== 'GET').length, odd: extra.odd };
}

function writePlan(p) {
	fs.mkdirSync(BASE, { recursive: true });
	const out = p.requests.map((q) => [q.verb, q.as, q.path].join('\t'));
	fs.writeFileSync(path.join(BASE, 'plan'), out.length ? `${out.join('\n')}\n` : '');
	process.stderr.write(`==> ${plural(p.requests.length, 'request', 'requests')} of the app to measure\n`);
}

// == The previous release ==
// The order of PHP version_compare for the versions the App Store accepts:
// X.Y.Z with an optional -alpha.N, -beta.N or -rc.N, a pre-release before its
// release.
const PRE = { alpha: 1, a: 1, beta: 2, b: 2, rc: 3 };
function parseVersion(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc|a|b)\.?(\d+)?)?$/i.exec(String(v ?? '').trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? PRE[m[4].toLowerCase()] : 9, Number(m[5] ?? 0)];
}
function compareVersions(a, b) {
	for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

// The newest release below the version of the checkout. A pre-release counts
// only when the checkout is one too: a stable release is compared with the
// stable release before it, which is what its users update from.
function previousRelease(file, id, version) {
	let apps;
	try { apps = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`${file} is unreadable: ${e.message}`); }
	const current = parseVersion(version);
	if (!current) return null;
	const entry = (Array.isArray(apps) ? apps : []).find((a) => a.id === id);
	const older = (entry?.releases ?? [])
		.filter((r) => !r.isNightly && r.download)
		.map((r) => ({ r, v: parseVersion(r.version) }))
		.filter(({ v }) => v && compareVersions(v, current) < 0 && (v[3] === 9 || current[3] !== 9))
		.sort((a, b) => compareVersions(b.v, a.v));
	return older[0]?.r ?? null;
}

// == The runs ==
const keyOf = (p) => `${p.method} ${p.url}`;
const median = (values) => {
	const s = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
	return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

// One figure of a request over the rounds: the lowest, how many rounds reached
// it, and how far the rounds spread.
function figure(values) {
	const floor = Math.min(...values);
	return { floor, hits: values.filter((v) => v === floor).length, spread: Math.max(...values) - floor };
}

// Every request of a phase over its rounds.
function readPhase(dir) {
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)) : [];
	if (!files.length) return null;
	const byKey = new Map();
	for (const f of files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
		for (const p of readJson(path.join(dir, f)) ?? []) {
			const k = keyOf(p);
			if (!byKey.has(k)) byKey.set(k, []);
			byKey.get(k).push(p);
		}
	}
	const requests = new Map();
	for (const [k, profiles] of byKey) {
		const queries = figure(profiles.map((p) => p.queries.length));
		requests.set(k, {
			key: k,
			rounds: profiles.length,
			status: profiles[0].status,
			queries,
			cache: figure(profiles.map((p) => p.cache.length)),
			events: figure(profiles.map((p) => p.events)),
			ms: median(profiles.map((p) => p.ms)),
			memory: Math.min(...profiles.map((p) => p.memory ?? Infinity)),
			boot: median(profiles.map((p) => p.boot)),
			// The queries are compared on a profile that reached the lowest count.
			floor: profiles.find((p) => p.queries.length === queries.floor),
		});
	}
	return { rounds: files.length, requests };
}

// The difference of two figures, and whether it is more than noise: both
// reached their lowest in at least two rounds, or the difference is larger than
// both spreads.
function delta(a, b, rounds) {
	const d = b.floor - a.floor;
	const settled = (f) => f.hits >= Math.min(2, rounds);
	const real = d !== 0 && ((settled(a) && settled(b)) || Math.abs(d) > Math.max(a.spread, b.spread));
	return { d, real };
}

// What the second profile has more of than the first, by SQL or by cache
// operation, with the frames of the app the added ones carry.
function added(before, after, keyFn) {
	const count = new Map();
	for (const x of before) count.set(keyFn(x), (count.get(keyFn(x)) ?? 0) - 1);
	const frames = new Map();
	for (const x of after) {
		const k = keyFn(x);
		count.set(k, (count.get(k) ?? 0) + 1);
		if (x.frame) {
			if (!frames.has(k)) frames.set(k, new Set());
			frames.get(k).add(x.frame);
		}
	}
	return [...count].filter(([, n]) => n > 0)
		.map(([k, n]) => ({ what: k, n, frames: [...(frames.get(k) ?? [])] }))
		.sort((x, y) => y.n - x.n || x.what.localeCompare(y.what));
}

// Queries of one request that repeat, as far as the backtrace reaches the app:
// the same SQL with the same parameters, and the same SQL with many others.
function repeats(profile) {
	const bySql = new Map();
	for (const q of profile.queries) {
		if (!bySql.has(q.sql)) bySql.set(q.sql, []);
		bySql.get(q.sql).push(q);
	}
	const duplicate = [];
	const similar = [];
	for (const [sql, list] of bySql) {
		const frames = [...new Set(list.map((q) => q.frame).filter(Boolean))];
		if (!frames.length || list.length < 2) continue;
		const byParams = new Map();
		for (const q of list) byParams.set(q.params, (byParams.get(q.params) ?? 0) + 1);
		const dup = Math.max(...byParams.values());
		if (dup >= 2) duplicate.push({ sql, n: dup, frames });
		if (byParams.size >= SIMILAR) similar.push({ sql, n: list.length, distinct: byParams.size, frames });
	}
	return { duplicate, similar };
}

function readRun(dir, tag, own) {
	const failedRc = read(path.join(dir, 'failed'));
	const phases = {};
	const versions = {};
	const stopped = {};
	for (const ph of PHASES) {
		phases[ph] = readPhase(path.join(dir, ph));
		versions[ph] = read(path.join(dir, `${ph}.version`))?.trim() || null;
		const step = read(path.join(dir, `${ph}.stopped`));
		if (step !== null) {
			const out = ['upgrade.txt', 'enable.txt', 'copy.err'].map((f) => read(path.join(dir, `${ph}.${f}`))).find((t) => t?.trim());
			// With the profiler enabled, occ adds the address of its own profile.
			stopped[ph] = { step: step.trim(), output: lines(out).filter((l) => !l.startsWith('Profiler output available at ')) };
		}
	}
	return {
		tag,
		server: readJson(path.join(dir, 'status.json'))?.versionstring ?? null,
		php: read(path.join(dir, 'php'))?.trim() || null,
		failed: failedRc === null ? null : Number(failedRc.trim()),
		stopped: read(path.join(dir, 'stopped'))?.trim() || null,
		phases,
		versions,
		phaseStopped: stopped,
		own,
	};
}

// The comparison of two phases over the requests both have.
function compare(from, to, keys, rounds) {
	const rows = [];
	for (const k of keys) {
		const a = from.requests.get(k);
		const b = to.requests.get(k);
		if (!a || !b) continue;
		const q = delta(a.queries, b.queries, rounds);
		const c = delta(a.cache, b.cache, rounds);
		const e = delta(a.events, b.events, rounds);
		rows.push({
			request: k,
			status: [a.status, b.status],
			queries: { from: a.queries.floor, to: b.queries.floor, diff: q.d, real: q.real },
			cache: { from: a.cache.floor, to: b.cache.floor, diff: c.d, real: c.real },
			events: { from: a.events.floor, to: b.events.floor, diff: e.d, real: e.real },
			ms: [a.ms, b.ms],
			memory: [a.memory, b.memory],
			addedQueries: q.real && q.d > 0 ? added(a.floor.queries, b.floor.queries, (x) => x.sql) : [],
			addedCache: c.real && c.d > 0 ? added(a.floor.cache, b.floor.cache, (x) => x.op) : [],
		});
	}
	return rows;
}

function check() {
	const inv = readInventory();
	const range = readRange(path.join(BASE, 'range'));
	if (!Object.keys(range).length) die(`${path.join(BASE, 'range')} is missing: make profile has to run first`);
	const planned = planRequests(inv);
	const own = new Set(planned.requests.map((q) => `${q.verb} ${q.path}`));
	const tags = (range.tags ?? '').split(' ').filter(Boolean);
	const rounds = Number(range.rounds) || 1;
	const runs = tags.map((tag) => readRun(path.join(BASE, tag), tag, own));
	for (const run of runs) {
		const { base, previous, app } = run.phases;
		run.standard = base && app ? compare(base, app, [...base.requests.keys()], rounds) : [];
		run.ownRequests = app ? [...app.requests.values()].filter((r) => own.has(r.key)) : [];
		run.sincePrevious = previous && app ? compare(previous, app, [...app.requests.keys()], rounds) : [];
		run.repeats = [];
		for (const r of app ? app.requests.values() : []) {
			const rep = repeats(r.floor);
			if (rep.duplicate.length || rep.similar.length) run.repeats.push({ request: r.key, ...rep });
		}
		run.unsettled = [];
		for (const [ph, data] of Object.entries(run.phases)) {
			for (const r of data ? data.requests.values() : []) {
				if (r.queries.hits < Math.min(2, rounds)) run.unsettled.push({ phase: ph, request: r.key, floor: r.queries.floor, spread: r.queries.spread });
			}
		}
		run.boot = app ? median([...app.requests.values()].map((r) => r.boot)) : null;
	}
	return { app: inv.app, range, rounds, previous: readRange(path.join(BASE, 'previous.txt')), planned, runs };
}

// == Findings ==
const short = (sql) => {
	const s = sql.replace(/\s+/g, ' ').trim();
	return s.length > SQL_WIDTH ? `${s.slice(0, SQL_WIDTH - 3)}...` : s;
};
const framesOf = (list) => (list.length ? ` (${list.slice(0, 2).join(', ')}${list.length > 2 ? ', ...' : ''})` : ' (no frame in the app)');
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const nameOf = (run) => `Nextcloud ${run.server ?? run.tag}${run.php ? ` on PHP ${run.php}` : ''}`;
const are = (n) => (n === 1 ? 'is' : 'are');

function sample(list, details, hint, indent = '  ') {
	const shown = details || list.length <= SAMPLE ? list : list.slice(0, SAMPLE);
	const out = shown.map((l) => `${indent}${l}`);
	if (shown.length < list.length) out.push(`${indent}... and ${list.length - shown.length} more, ${hint}`);
	return out;
}

// Added queries none of which has a frame of the app: the server runs them in
// another request once the app is enabled, as with a lazy load of its config,
// and the request that lost them shows fewer.
const fromApp = (s) => s.addedQueries.some((x) => x.frames.length);

// A request with the figures of both sides and what was added.
function grown(rows, field, details, hint) {
	return rows.flatMap((s) => [
		`  ${s.request}  ${s[field].from} -> ${s[field].to} (${signed(s[field].diff)})`,
		...sample((field === 'queries' ? s.addedQueries : s.addedCache)
			.map((x) => `${x.n}x ${field === 'queries' ? short(x.what) + framesOf(x.frames) : x.what}`), details, hint, '    '),
	]);
}

function findings(r, opt) {
	const list = [];
	const add = (level, id, text, extra = {}) => list.push({ level, id, lines: text, ...extra });
	const how = howToRun('PROFILE_CMDLINE', 'profile.mjs %s');
	const more = `see ${how('--details')}`;

	if (!r.runs.length) {
		add('info', 'server-none', [
			`No server image for a Nextcloud major the app declares (${r.range.min || 'no min-version'} to ${r.range.max || 'no max-version'}):`
			+ ` images exist for ${r.range.first} to ${r.range.master}, the maintained majors and master. Nothing ran.`,
		]);
		return list;
	}
	if (r.planned.skipped.length) {
		add('info', 'routes-skipped', [
			`${plural(r.planned.skipped.length, 'route was', 'routes were')} not measured: a parameter of the path has no default,`
			+ ' and runtime_params in ncmake.mk names no value for it.',
			...sample(r.planned.skipped.map((s) => `${s.verb} ${s.path}  (${s.missing.join(', ')})`), opt.details, more),
		]);
	}
	if (r.planned.notGet) {
		add('info', 'routes-not-get', [
			`${plural(r.planned.notGet, 'route that is no GET was not measured on its own', 'routes that are no GET were not measured on their own')}:`
			+ ' a request that changes something does not repeat with the same counts. profile_requests in ncmake.mk names requests to measure regardless.',
		]);
	}
	if (r.planned.odd) {
		add('warn', 'requests-odd', ['profile_requests in ncmake.mk is no list of "<VERB> <path>" pairs: its last word was left out.']);
	}
	const prev = r.previous;
	const why = {
		none: 'PREVIOUS=none',
		'no-appstore': 'the App Store module of ncmake is not installed (make dev-init adds it); PREVIOUS=<tarball or URL> names a release instead',
		'not-found': `the App Store catalogue has no release of the app before ${r.app.version}; PREVIOUS=<tarball or URL> names one`,
		'download-failed': `the download of ${prev.source || 'the previous release'} failed`,
		unpack: `${prev.source || 'the previous release'} is no tarball of the app ${r.app.id}`,
	};
	if (prev.state && prev.state !== 'ok') {
		add('info', 'previous-none', [`No comparison with a previous release: ${why[prev.state] ?? prev.state}.`]);
	}

	for (const run of r.runs) {
		const name = nameOf(run);
		const at = { tag: run.tag };
		const warned = () => list.some((f) => f.tag === run.tag && f.level === 'warn');
		if (run.stopped) {
			const step = {
				redis: 'the server did not reach Redis',
				config: 'the caches could not be set to Redis',
				apache: 'the web server did not answer',
				fixtures: 'the files the WebDAV requests read could not be created',
				profiler: 'nextcloud/profiler could not be enabled',
			};
			add('warn', 'server-stopped', [`${name}: ${step[run.stopped] ?? run.stopped}, so nothing was measured.`,
				run.stopped === 'redis'
					? `  The error of the last check is in build/profile/${run.tag}/redis.err, the status and the log of the Redis container in redis.log.`
					: `  What it wrote is in build/profile/${run.tag}.`], at);
			continue;
		}
		if (!run.phases.base) {
			add('warn', 'server-not-run', [
				`Nextcloud ${run.tag}: the server did not run${run.failed !== null ? ` (exit code ${run.failed})` : ''}.`,
				'  The image could not be pulled or a container did not start; the lines above the report say which.',
			], at);
			continue;
		}
		if (run.phaseStopped.app || !run.phases.app) {
			const s = run.phaseStopped.app;
			add('warn', 'enable-failed', [
				`${name}: the staged app could not be ${s?.step === 'copy' ? 'copied into custom_apps' : 'enabled'}, so it was not measured.`,
				...sample(s?.output ?? [], opt.details, more),
			], at);
			continue;
		}
		if (run.phaseStopped.previous) {
			add('info', 'previous-not-enabled', [
				`${name}: the previous release${(run.versions.previous || prev.version) ? ` ${run.versions.previous || prev.version}` : ''} does not enable on this server, so there is no comparison with it.`,
				...sample(run.phaseStopped.previous.output, opt.details, more),
			], at);
		}

		// The requests that are not the app's.
		const status = run.standard.filter((s) => s.status[0] !== s.status[1]);
		if (status.length) {
			add('warn', 'status-changed', [
				`${name}: ${plural(status.length, 'request', 'requests')} that ${are(status.length)} not the app's answer${status.length === 1 ? 's' : ''} otherwise once the app is enabled.`,
				...sample(status.map((s) => `${s.request}  ${s.status[0]} -> ${s.status[1]}`), opt.details, more),
			], at);
		}
		const grownQueries = run.standard.filter((s) => s.queries.real && s.queries.diff > 0);
		const moreQueries = grownQueries.filter(fromApp);
		if (moreQueries.length) {
			add('warn', 'queries-added', [
				`${name}: the app adds queries to ${plural(moreQueries.length, 'request', 'requests')} that ${are(moreQueries.length)} not its own.`,
				...grown(moreQueries, 'queries', opt.details, more),
			], at);
		}
		const shifted = grownQueries.filter((s) => !fromApp(s));
		if (shifted.length) {
			add('info', 'queries-shifted', [
				`${name}: ${plural(shifted.length, 'request', 'requests')} that ${are(shifted.length)} not the app's ${shifted.length === 1 ? 'runs' : 'run'} more queries with it,`
				+ ' none with a frame of the app: the server runs them in another request once the app is enabled.',
				...grown(shifted, 'queries', opt.details, more),
			], at);
		}
		const moreCache = run.standard.filter((s) => s.cache.real && s.cache.diff > 0);
		if (moreCache.length) {
			add('info', 'cache-added', [
				`${name}: the app adds cache operations to ${plural(moreCache.length, 'request', 'requests')} that ${are(moreCache.length)} not its own.`,
				...grown(moreCache, 'cache', opt.details, more),
			], at);
		}

		// Repeated queries, with the app in their backtrace.
		const dup = run.repeats.filter((x) => x.duplicate.length);
		if (dup.length) {
			add('warn', 'query-duplicate', [
				`${name}: in ${plural(dup.length, 'request', 'requests')} the app runs the same query with the same parameters more than once.`,
				...dup.flatMap((x) => [`  ${x.request}`, ...sample(x.duplicate.map((q) => `${q.n}x ${short(q.sql)}${framesOf(q.frames)}`), opt.details, more, '    ')]),
			], at);
		}
		const sim = run.repeats.filter((x) => x.similar.length);
		if (sim.length) {
			add('warn', 'query-repeated', [
				`${name}: in ${plural(sim.length, 'request', 'requests')} the app runs the same query with ${SIMILAR} or more different parameters,`
				+ ' one query per item where one query for all of them would do.',
				...sim.flatMap((x) => [`  ${x.request}`, ...sample(x.similar.map((q) => `${q.n}x, ${q.distinct} parameter sets: ${short(q.sql)}${framesOf(q.frames)}`), opt.details, more, '    ')]),
			], at);
		}

		// The previous release.
		const grownSince = run.sincePrevious.filter((s) => s.queries.real && s.queries.diff > 0);
		const since = grownSince.filter(fromApp);
		if (since.length) {
			add('warn', 'queries-added-since', [
				`${name}: ${plural(since.length, 'request has', 'requests have')} more queries than with ${run.versions.previous ?? 'the previous release'}.`,
				...grown(since, 'queries', opt.details, more),
			], at);
		}
		const shiftedSince = grownSince.filter((s) => !fromApp(s));
		if (shiftedSince.length) {
			add('info', 'queries-shifted-since', [
				`${name}: ${plural(shiftedSince.length, 'request has', 'requests have')} more queries than with ${run.versions.previous ?? 'the previous release'},`
				+ ' none with a frame of the app: the server runs them in another request.',
				...grown(shiftedSince, 'queries', opt.details, more),
			], at);
		}

		if (run.unsettled.length) {
			add('info', 'profile-unstable', [
				`${name}: for ${plural(run.unsettled.length, 'request', 'requests')} the lowest query count was reached in one round only;`
				+ ' a difference there counts only where it is larger than the spread of the rounds.',
				...sample(run.unsettled.map((u) => `${u.phase}: ${u.request}  ${u.floor} (+${u.spread})`), opt.details, more),
			], at);
		}

		if (!warned()) {
			add('ok', 'profile', [
				`${name}: the app adds no query to a request that is not its own and repeats none`
				+ `${run.phases.previous ? `, and its requests have none more than with ${run.versions.previous}` : ''}.`,
			], at);
		}
	}
	return sortFindings(list);
}

// == Human-readable output ==
const mib = (b) => (Number.isFinite(b) ? (b / 1048576).toFixed(1) : '');
const change = (x) => (x.diff === 0 ? String(x.to) : `${x.from} -> ${x.to} (${signed(x.diff)}${x.real ? '' : ', noise'})`);
const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');
const COLS = ['request', 'status', 'queries', 'cache ops', 'events', 'ms', 'MiB'];
const ALIGN = ['l', 'r', 'r', 'r', 'r', 'r', 'r'];

function render(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const how = howToRun('PROFILE_CMDLINE', 'profile.mjs %s');
	p(`profile  ${r.app.id ?? 'no app id'}${r.app.version ? ` ${r.app.version}` : ''}`);
	p(`  ${plural(r.rounds, 'round', 'rounds')} per request after two to warm up, the server in debug mode,`);
	p('  which the profiler requires, and its caches on Redis.');
	for (const run of r.runs) {
		if (!run.standard.length && !run.ownRequests.length) continue;
		p();
		p(nameOf(run).toUpperCase());
		if (run.standard.length) {
			p('  Requests that are not the app’s, without it -> with it:');
			p(indent(table(COLS, run.standard.map((s) => [
				s.request,
				s.status[0] === s.status[1] ? s.status[1] : `${s.status[0]} -> ${s.status[1]}`,
				change(s.queries), change(s.cache), change(s.events),
				`${num(s.ms[0])} / ${num(s.ms[1])}`, `${mib(s.memory[0])} / ${mib(s.memory[1])}`,
			]), ALIGN)));
		}
		if (run.ownRequests.length) {
			p();
			p(`  Requests of the app${run.versions.app ? ` ${run.versions.app}` : ''}:`);
			p(indent(table(COLS, run.ownRequests.map((q) => [q.key, q.status, q.queries.floor, q.cache.floor, q.events.floor, num(q.ms), mib(q.memory)]), ALIGN)));
		}
		if (run.sincePrevious.length) {
			p();
			p(`  ${run.versions.previous} -> ${run.versions.app}:`);
			p(indent(table(['request', 'queries', 'cache ops', 'events'],
				run.sincePrevious.map((s) => [s.request, change(s.queries), change(s.cache), change(s.events)]), ['l', 'r', 'r', 'r'])));
		}
		if (run.boot !== null) p(`  Registering, loading and booting the app takes ${num(run.boot)} ms of a request.`);
	}
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('Each server is the image ncmake-server of that major, with nextcloud/profiler');
	p('enabled and its caches on Redis, the image of Nextcloud All-in-One. The same');
	p('requests ran without the app, with the previous release where there is one,');
	p('and with the staged app, in one container. Each figure is the lowest of the');
	p('rounds, "noise" a difference the rounds do not confirm. Times are the median');
	p('and memory the lowest peak; no finding rests on them. A query counts for the');
	p('app where a frame of its backtrace is a file of the app. What each run left');
	p('is in build/profile.');
	p(`The report is in ${REPORTS}/profile.txt, the JSON in ${REPORTS}/profile.json.`);
	p();
	p(`Every query behind a finding: ${how('--details')}`);
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
if (opt.plan) {
	writePlan(planRequests(readInventory()));
} else if (opt.previous) {
	const inv = readInventory();
	const rel = previousRelease(opt.previous, inv.app.id, inv.app.version);
	if (rel) process.stdout.write(`${rel.version}\t${rel.download}\n`);
} else {
	const r = check();
	r.findings = findings(r, opt);
	// The JSON has the figures of each request; the queries of each profile stay
	// in build/profile.
	const report = {
		app: r.app,
		range: r.range,
		rounds: r.rounds,
		previous: r.previous,
		runs: r.runs.map((run) => ({
			tag: run.tag,
			server: run.server,
			php: run.php,
			versions: run.versions,
			standard: run.standard,
			own: run.ownRequests.map(({ floor, ...q }) => q),
			sincePrevious: run.sincePrevious,
			repeats: run.repeats,
			bootMs: run.boot,
		})),
		findings: r.findings,
	};
	const json = toJson(report, die);
	const text = `${render(r)}\n`;
	process.stdout.write(opt.json ? json : text);
	try { fs.mkdirSync(REPORTS, { recursive: true }); } catch (e) { die(`could not create ${REPORTS}: ${e.message}`); }
	writeJsonFile(path.join(REPORTS, 'profile.json'), json, die);
	writeJsonFile(path.join(REPORTS, 'profile.txt'), text, die);
	if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
}
