#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// runtime-audit - does what the app registers work on a real server.
//
// make runtime-audit runs make php-audit first, whose inventory has every route,
// command, background job, setup check, settings form and capability of the app,
// in build/reports/php-audit.json. With --plan this turns the routes into the
// requests the server half sends, build/runtime-audit/plan: one line per route
// and identity, tab-separated, "<route> <verb> <anon|user|admin> <path>". A
// route parameter is filled from the defaults of the route or from
// RUNTIME_AUDIT_PARAMS ("<name>=<value> ..."), and a route with one left unfilled
// is not requested: nothing is guessed.
//
// lib/runtime-audit.sh then runs on an installed Nextcloud server per major, the
// image ghcr.io/ernolf/ncmake-server:<tag>, and leaves under
// build/runtime-audit/<tag>:
//   php, status.json     the PHP and the server the run had
//   steps                one line per step: kind, name, result, and the lines of
//                        nextcloud.log before and after it
//   routes.json          occ router:list of the app, routes.rc its exit code
//   commands.*           the commands before and after the app came
//   jobs.after           the background jobs once the app came
//   settings.*           the settings forms before and after the app came
//   setupchecks.json     occ setupchecks
//   capabilities.*.json  the capabilities before and after the app came
//   nextcloud.log        the log, at level 0 from enabling the app on
//   upgrade.txt          occ upgrade, where the server asked for it
//   stopped, failed      the step a run did not get past, the exit code of a
//                        container that did not finish
//   db, pgsql.*          the database the server ran on, sqlite or pgsql, and
//                        the install on pgsql with its exit code
//   php-cap, php-raised  the <php max-version> of the app where the server
//                        refused it, and the minor it was raised to in the copy
//   retry                the minor of max-version, where the app did not enable
//                        with it raised either; the run on that PHP is
//                        <tag>-php<minor>
//   missing, deps        the apps the run lacked and those it got from the App
//                        Store, which lib/server-deps.mjs reads, with
//                        deps/<tag>/picked
// build/runtime-audit/range names the tags and the database they ran on, none
// when the app names only databases the server image does not offer.
// Without --plan this reads those files with the inventory and turns them into
// findings. It runs nothing and reads no network, and has no npm dependency.
// Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';

import {
	LEGEND,
	howToRun,
	plural,
	renderFindings,
	sample,
	SAMPLE,
	sortFindings,
	table,
	toJson,
	writeJsonFile,
} from './report-text.mjs';
import { has, plan, readParams } from './route-plan.mjs';
import { causedBy, needsAppText, readDeps } from './server-deps.mjs';

// == Config ==
const defaults = {
	plan: false,     // write build/runtime-audit/plan instead of the report
	details: false,  // every log entry and request behind a finding instead of the first few
	json: false,
	jsonFile: null,
};
const LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'];
const BASE = path.join('build', 'runtime-audit');
const REPORTS = path.join('build', 'reports');
const INVENTORY = path.join(REPORTS, 'php-audit.json');
// What the server logs when the container cannot build a class the request needs.
const NOT_BUILT = /QueryException|Could not resolve|ContainerExceptionInterface|NotFoundExceptionInterface/;
// What a setup check that throws reads like in occ setupchecks.
const CHECK_THREW = 'An exception occurred while running the setup check';

// == Command line ==
function usage() {
	return `runtime-audit - does what the app registers work on a real server

Usage: runtime-audit.mjs [options]

  Runs in the app checkout. make runtime-audit must have run there, which
  leaves the inventory in ${INVENTORY} and its runs in ${BASE}.

Options:
  --plan                write the requests of the run to ${BASE}/plan
  --details             every log entry and request behind a finding, not the first ${SAMPLE}
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The report is written to ${REPORTS}/runtime-audit.txt and .json. The exit
code is 0 with or without findings, and 2 when the run itself could not be
carried out.`;
}

function die(msg) {
	process.stderr.write(`runtime-audit: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	for (const arg of argv) {
		switch (arg) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--plan': opt.plan = true; break;
			case '--json': opt.json = true; break;
			case '--details': opt.details = true; break;
			default:
				if (arg.startsWith('--json-file=')) { opt.jsonFile = arg.slice('--json-file='.length); break; }
				die(`unknown option: ${arg}`);
		}
	}
	if (opt.jsonFile === '') die('--json-file needs a file');
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

// == The plan ==
function writePlan(p) {
	fs.mkdirSync(BASE, { recursive: true });
	const out = [];
	for (const r of p.routes) for (const as of ['anon', r.as]) out.push([`r${r.route}`, r.verb, as, r.path].join('\t'));
	fs.writeFileSync(path.join(BASE, 'plan'), out.length ? `${out.join('\n')}\n` : '');
	fs.writeFileSync(path.join(BASE, 'skipped.json'), `${JSON.stringify(p.skipped)}\n`);
	process.stderr.write(`==> ${plural(p.routes.length, 'route', 'routes')} to request, ${p.skipped.length} without a value for a parameter\n`);
}

// == The log ==
// key=value lines, as the recipe writes them.
function readRange(file) {
	const range = {};
	for (const l of lines(read(file))) {
		const i = l.indexOf('=');
		if (i > 0) range[l.slice(0, i)] = l.slice(i + 1);
	}
	return range;
}

// The exception of an entry with the ones it wraps.
function chain(ex) {
	const list = [];
	for (let e = ex; e && typeof e === 'object' && list.length < 10; e = e.Previous) list.push(e);
	return list;
}

// Where an entry reaches the app: the first place in the directory of the app
// that its exceptions, their traces or a PHP message name, as "<file>:<line>"
// relative to the app; or the first class of the app in a trace. null when
// nothing does, and then the app field alone ties it to the app.
function frameOf(entry, id, ns) {
	const dir = `custom_apps/${id}/`;
	const rel = (file, line) => {
		const i = String(file ?? '').indexOf(dir);
		return i < 0 ? null : `${file.slice(i + dir.length)}${line ? `:${line}` : ''}`;
	};
	for (const ex of chain(entry.exception)) {
		const own = rel(ex.File, ex.Line);
		if (own) return own;
		for (const t of Array.isArray(ex.Trace) ? ex.Trace : []) {
			const f = rel(t.file, t.line);
			if (f) return f;
		}
	}
	const php = /at (\S+)#(\d+)\s*$/.exec(String(entry.message ?? ''));
	if (php && rel(php[1], php[2])) return rel(php[1], php[2]);
	if (ns) {
		for (const ex of chain(entry.exception)) {
			for (const t of Array.isArray(ex.Trace) ? ex.Trace : []) {
				if (String(t.class ?? '').startsWith(`OCA\\${ns}\\`)) return `${t.class}${t.function ? `::${t.function}` : ''}`;
			}
		}
	}
	return null;
}

function messageOf(entry) {
	const ex = chain(entry.exception)[0];
	const text = ex
		? `${ex.Exception ?? 'Exception'}: ${ex.Message ?? ''}`
		: String(entry.message ?? '');
	return text.replace(/\s+/g, ' ').trim();
}

// The database layer of the server, and the query builder and mapper it gives
// the apps: a frame in there runs a query, it does not build one.
const DB_LAYER = ['/lib/private/DB/', '/lib/public/AppFramework/Db/', '/lib/public/DB/', '/3rdparty/'];

// Whether the app built the query of a "dirty table reads" entry: the first frame
// of its trace outside the database layer lies in the directory of the app. A
// query the server builds, in its files cache for one, while the app only calls
// the API around it, is the server's, and the app cannot avoid it.
function appBuiltQuery(entry, id) {
	const dir = `custom_apps/${id}/`;
	const ex = chain(entry.exception)[0];
	if (!ex) return true;
	for (const t of Array.isArray(ex.Trace) ? ex.Trace : []) {
		const file = String(t.file ?? '');
		if (!file || DB_LAYER.some((d) => file.includes(d))) continue;
		return file.includes(dir);
	}
	return true;
}

// What an entry is, for the findings of the log.
function kindOf(entry, text, id) {
	if (/^dirty table reads/.test(text) || /dirty table reads/.test(String(entry.message ?? ''))) {
		return appBuiltQuery(entry, id) ? 'dirty' : 'dirty-server';
	}
	if (/took longer than 1s/.test(text) || /took longer than 1s/.test(String(entry.message ?? ''))) return 'transaction';
	if (/deadlock|database is locked/i.test(text)) return 'deadlock';
	if (entry.app === 'PHP' && entry.level === 0) return 'deprecation';
	if (entry.level >= 3) return 'error';
	return null;
}

// Every entry of the log with the step that logged it, by its line.
function readLog(file, steps, id, ns) {
	const text = read(file);
	if (text === null) return null;
	const entries = [];
	text.split('\n').forEach((raw, i) => {
		if (!raw.trim()) return;
		let entry;
		try { entry = JSON.parse(raw); } catch { return; }
		if (typeof entry?.level !== 'number') return;
		const n = i + 1;
		const step = steps.find((s) => n > s.from && n <= s.to) ?? null;
		const frame = frameOf(entry, id, ns);
		const message = messageOf(entry);
		entries.push({
			line: n,
			level: entry.level,
			app: entry.app ?? null,
			url: entry.url ?? null,
			message,
			frame,
			step: step ? `${step.kind} ${step.name}` : null,
			stepIndex: step ? steps.indexOf(step) : null,
			ownsApp: entry.app === id || frame !== null,
			kind: kindOf(entry, message, id),
		});
	});
	return entries;
}

// == The runs ==
const norm = (p) => p.replace(/^\/index\.php(?=\/)/, '').replace(/\{[^}]+\}/g, '{}');

function readRun(dir, tag, inv, planned) {
	const id = inv.app.id;
	const ns = inv.app.namespace;
	const status = readJson(path.join(dir, 'status.json'));
	const steps = lines(read(path.join(dir, 'steps'))).map((l) => {
		const [kind, name, result, from, to] = l.split('\t');
		return { kind, name, result, from: Number(from), to: Number(to) };
	});
	const log = readLog(path.join(dir, 'nextcloud.log'), steps, id, ns) ?? [];
	const ofStep = (i) => log.filter((e) => e.stepIndex === i);
	const failedRc = read(path.join(dir, 'failed'));
	const routesRc = read(path.join(dir, 'routes.rc'));
	const routes = routesRc !== null && Number(routesRc) === 0 ? readJson(path.join(dir, 'routes.json')) : null;
	const listed = routes ? new Set(routes.map((r) => `${r.request} ${norm(r.path)}`)) : null;

	// One row per route that was requested, with the answer to each identity.
	const answers = {};
	steps.forEach((s, i) => {
		if (s.kind !== 'request') return;
		const [route, as] = s.name.split(':');
		const a = (answers[route] ??= {});
		a[as] = { status: Number(s.result), log: ofStep(i) };
	});
	const requests = planned.routes.map((p) => {
		const e = inv.inventory.endpoints[p.route];
		const a = answers[`r${p.route}`] ?? {};
		return {
			verb: p.verb,
			path: p.path,
			target: e.target,
			as: p.as,
			public: has(e, 'PublicPage'),
			anon: a.anon?.status ?? null,
			auth: a[p.as]?.status ?? null,
			log: [...(a.anon?.log ?? []), ...(a[p.as]?.log ?? [])],
			registered: listed ? listed.has(`${p.verb} ${norm(e.path)}`) : null,
		};
	});
	const notRegistered = listed
		? inv.inventory.endpoints.filter((e) => e.kind !== 'DAV' && e.kind !== 'capability' && !listed.has(`${e.verb} ${norm(e.path)}`))
		: [];
	const byKind = (kind) => steps.map((s, i) => ({ ...s, log: ofStep(i) })).filter((s) => s.kind === kind);
	const fresh = (name) => {
		const before = new Set(lines(read(path.join(dir, `${name}.before`))));
		return lines(read(path.join(dir, `${name}.after`))).filter((l) => !before.has(l));
	};
	const capsOf = (name) => Object.keys(readJson(path.join(dir, `capabilities.${name}.json`))?.ocs?.data?.capabilities ?? {});
	const capsBefore = new Set(capsOf('before'));
	return {
		tag,
		server: status?.versionstring ?? null,
		php: read(path.join(dir, 'php'))?.trim() || null,
		failed: failedRc === null ? null : Number(failedRc.trim()),
		stopped: read(path.join(dir, 'stopped'))?.trim() || null,
		db: read(path.join(dir, 'db'))?.trim() || null,
		pgsql: { rc: read(path.join(dir, 'pgsql.rc'))?.trim() || null, output: lines(read(path.join(dir, 'pgsql.txt'))) },
		phpCap: read(path.join(dir, 'php-cap'))?.trim() || null,
		phpRaised: read(path.join(dir, 'php-raised'))?.trim() || null,
		retry: read(path.join(dir, 'retry'))?.trim() || null,
		enable: { step: byKind('enable')[0] ?? null, output: lines(read(path.join(dir, 'enable.txt'))) },
		upgrade: { step: byKind('upgrade')[0] ?? null, output: lines(read(path.join(dir, 'upgrade.txt'))) },
		routesListed: routes !== null,
		notRegistered,
		requests,
		commands: byKind('command'),
		newCommands: fresh('commands'),
		jobs: byKind('job'),
		listedJobs: lines(read(path.join(dir, 'jobs.after'))).map((l) => l.slice(l.indexOf(' ') + 1)),
		setupChecks: { step: byKind('setupchecks')[0] ?? null, result: readJson(path.join(dir, 'setupchecks.json')) },
		settings: byKind('settings'),
		// The server has forms of its own; none at all means they were not read.
		settingsRead: lines(read(path.join(dir, 'settings.before'))).length > 0,
		newSettings: fresh('settings').map((l) => l.split(' ')[2]),
		capabilities: { step: byKind('capabilities')[0] ?? null, added: capsOf('after').filter((k) => !capsBefore.has(k)) },
		dav: byKind('dav')[0] ?? null,
		repair: [...byKind('disable'), ...byKind('reenable')],
		log,
		deps: readDeps(path.dirname(dir), tag),
	};
}

function check() {
	const inv = readInventory();
	const range = readRange(path.join(BASE, 'range'));
	if (!Object.keys(range).length) die(`${path.join(BASE, 'range')} is missing: make runtime-audit has to run first`);
	const planned = plan(inv, readParams(process.env.RUNTIME_AUDIT_PARAMS));
	const tags = (range.tags ?? '').split(' ').filter(Boolean);
	return {
		app: inv.app,
		range,
		params: readParams(process.env.RUNTIME_AUDIT_PARAMS),
		skipped: planned.skipped.map((s) => {
			const e = inv.inventory.endpoints[s.route];
			return { verb: s.verb, path: s.path, target: e.target, public: has(e, 'PublicPage'), missing: s.missing };
		}),
		// A run on the PHP of max-version follows the run it stands in for.
		runs: range.db === 'none' ? [] : tags.flatMap((tag) => {
			const run = readRun(path.join(BASE, tag), tag, inv, planned);
			if (!run.retry) return [run];
			const t = `${tag}-php${run.retry}`;
			run.fallback = t;
			return [run, { ...readRun(path.join(BASE, t), t, inv, planned), fallbackOf: tag }];
		}),
		inventory: inv.inventory,
	};
}

// == Findings ==
const nameOf = (run) => `Nextcloud ${run.server ?? run.tag}${run.php ? ` on PHP ${run.php}` : ''}`;
const entryLine = (e) => `${LEVELS[e.level] ?? `level ${e.level}`}${e.app ? ` (${e.app})` : ''}: ${e.message}`
	+ `${e.frame ? ` [${e.frame}]` : ''}${e.step ? ` <- ${e.step}` : ''}`;
const status = (s) => (s === null ? '-' : s === 0 ? 'no answer' : String(s));
const failedStep = (s) => s && Number(s.result) !== 0;

function findings(r, opt) {
	const list = [];
	const add = (level, id, text, extra = {}) => list.push({ level, id, lines: text, ...extra });
	const how = howToRun('RUNTIME_AUDIT_CMDLINE', 'runtime-audit.mjs %s');
	const more = `see ${how('--details')}`;
	const named = r.inventory.infoXml ?? {};
	const regs = r.inventory.registrations ?? [];

	if (r.range.db === 'none') {
		add('info', 'server-db-untestable', [
			`The app names ${r.range.databases || 'no database'} in <database> of info.xml, and neither SQLite nor PostgreSQL,`
			+ ' the databases the server images run on: Nextcloud refuses to enable it there. Nothing ran.',
		]);
		return list;
	}
	if (!r.runs.length) {
		add('info', 'server-none', [
			`No server image for a Nextcloud major the app declares (${r.range.min || 'no min-version'} to ${r.range.max || 'no max-version'}):`
			+ ` images exist for ${r.range.first} to ${r.range.master}, the maintained majors and master. Nothing ran.`,
		]);
		return list;
	}
	if (r.skipped.length) {
		add('info', 'routes-skipped', [
			`${plural(r.skipped.length, 'route was', 'routes were')} not requested: a parameter of the path has no default,`
			+ ' and runtime_params in ncmake.mk names no value for it.',
			...sample(r.skipped.map((s) => `${s.verb} ${s.path}  (${s.missing.join(', ')})`), opt.details, more),
		]);
	}

	for (const run of r.runs) {
		const name = nameOf(run);
		const at = { tag: run.tag };
		// What the lack of an app causes goes into the finding about that app,
		// needs-app, and is not reported on its own: a step or a request whose
		// errors all name a class or a table of the missing app, and what the
		// app does not register where every error of the run is of that kind.
		const cause = causedBy(run.deps.missing);
		const errors = run.log.filter((e) => e.level >= 3);
		const depErrors = errors.filter((e) => cause(e.message));
		const onlyDep = depErrors.length > 0 && depErrors.length === errors.length;
		const byDep = (log) => {
			const e = (log ?? []).filter((x) => x.level >= 3);
			return e.length > 0 && e.every((x) => cause(x.message));
		};
		const folded = [];
		const report = (dep, level, id, text, extra) => {
			if (dep) folded.push(`${id}: ${text[0].slice(name.length + 2)}`);
			else add(level, id, text, extra);
		};
		// make(items) is [level, id, text, extra] for the items it is given.
		const parted = (items, isDep, make) => {
			const dep = items.filter(isDep);
			const rest = items.filter((x) => !isDep(x));
			if (dep.length) report(true, ...make(dep));
			if (rest.length) add(...make(rest));
		};
		const needsApp = (evidence = []) => {
			if (!run.deps.missing.length && !run.deps.installed.length) return;
			const seen = [...new Set([...evidence, ...depErrors.map(entryLine)])];
			add('info', 'needs-app', needsAppText(name, run.deps, folded, sample(seen, opt.details, more, { indent: '    ' })), at);
		};
		if (run.phpCap) capFinding(run, r.runs.find((x) => x.tag === run.fallback) ?? null, name, at, opt, add, more);
		// The cap finding says that a run on the PHP of max-version did not run.
		if (run.fallbackOf && !run.enable.step && !run.stopped) continue;
		if (run.failed !== null && !run.enable.step && !run.stopped) {
			add('warn', 'server-not-run', [
				`Nextcloud ${run.tag}: the server did not run (exit code ${run.failed}).`,
				'  The image could not be pulled or the container did not start; the lines above the report say which.',
			], at);
			continue;
		}
		if (run.stopped === 'database') {
			add('warn', 'server-stopped', [
				`${name}: the server could not be installed on PostgreSQL${run.pgsql.rc && run.pgsql.rc !== '0' ? ` (exit code ${run.pgsql.rc})` : ''},`
				+ ' the database the app names; nothing ran.',
				...sample(run.pgsql.output, opt.details, more),
				`  The whole output is build/runtime-audit/${run.tag}/pgsql.txt.`,
			], at);
			continue;
		}
		if (run.stopped && run.stopped !== 'enable' && run.stopped !== 'upgrade') {
			add('warn', 'server-stopped', [
				run.stopped === 'copy'
					? `${name}: the staged app could not be copied into custom_apps.`
					: `${name}: the web server did not answer, so nothing was requested.`,
				`  What it wrote is in build/runtime-audit/${run.tag}.`,
			], at);
			continue;
		}
		// The cap finding carries the output of occ app:enable.
		if (run.stopped === 'enable' && run.phpCap) continue;
		if (run.stopped === 'enable') {
			const dep = run.enable.output.filter((l) => cause(l));
			report(dep.length > 0, 'warn', 'enable-failed', [
				`${name}: occ app:enable fails with exit code ${run.enable.step?.result ?? '?'}, so nothing was requested.`,
				...sample(run.enable.output, opt.details, more),
			], at);
			needsApp(dep);
			continue;
		}

		if (run.stopped === 'upgrade') {
			add('warn', 'upgrade-failed', [
				`${name}: the server ships an older release of the app and asks for occ upgrade once it is enabled;`
				+ ` occ upgrade fails with exit code ${run.upgrade.step?.result ?? '?'}, so nothing was requested.`,
				...sample(run.upgrade.output, opt.details, more),
			], at);
			needsApp();
			continue;
		}

		// The routes.
		if (!run.routesListed) {
			add('info', 'routes-not-listed', [`${name}: occ router:list did not answer, so whether each route registered is not known.`], at);
		} else if (run.notRegistered.length) {
			report(onlyDep, 'warn', 'route-not-registered', [
				`${name}: ${plural(run.notRegistered.length, 'route of the inventory is', 'routes of the inventory are')}`
				+ ' not among the routes the server has for the app (occ router:list).',
				...sample(run.notRegistered.map((e) => `${e.verb} ${e.path}  ${e.target}`), opt.details, more),
			], at);
		}
		const broken = run.requests.filter((q) => [q.anon, q.auth].some((s) => s === 0 || s >= 500));
		parted(broken, (q) => byDep(q.log), (qs) => ['warn', 'route-server-error', [
			`${name}: ${plural(qs.length, 'route answers', 'routes answer')} with a server error or not at all.`,
			// The status without credentials of an open route is what route-open
			// reports as a security finding, which this one is not.
			...sample(qs.map((q) => `${q.verb} ${q.path}  ${!q.public && q.anon >= 200 && q.anon < 300 ? '' : `anon ${status(q.anon)}, `}${q.as} ${status(q.auth)}`
				+ `${q.log.find((e) => e.level >= 3) ? `: ${q.log.find((e) => e.level >= 3).message}` : ''}`), opt.details, more),
		], at]);
		const unbuilt = run.requests.filter((q) => q.log.some((e) => NOT_BUILT.test(e.message)));
		parted(unbuilt, (q) => byDep(q.log), (qs) => ['warn', 'controller-not-built', [
			`${name}: for ${plural(qs.length, 'route', 'routes')} the server cannot build what the controller needs.`,
			...sample(qs.map((q) => `${q.verb} ${q.path}: ${q.log.find((e) => NOT_BUILT.test(e.message)).message}`), opt.details, more),
		], at]);
		const open = run.requests.filter((q) => !q.public && q.anon >= 200 && q.anon < 300);
		if (open.length) {
			add('warn', 'route-open', [
				`${name}: ${plural(open.length, 'route answers', 'routes answer')} without credentials, and the method declares no PublicPage.`,
				...sample(open.map((q) => `${q.verb} ${q.path}  ${q.anon}  ${q.target}`), opt.details, more),
			], { ...at, security: true });
		}

		// What the app registers.
		const listedCommands = (named.commands ?? []).length;
		if (run.newCommands.length < listedCommands) {
			report(onlyDep, 'warn', 'command-not-registered', [
				`${name}: info.xml lists ${plural(listedCommands, 'command', 'commands')}, and occ lists`
				+ ` ${run.newCommands.length} new once the app is enabled.`,
			], at);
		}
		parted(run.commands.filter(failedStep), (x) => byDep(x.log), (cs) => ['warn', 'command-failed', [
			`${name}: occ <command> --help fails for ${plural(cs.length, 'command', 'commands')}.`,
			...sample(cs.map((x) => `${x.name}  exit code ${x.result}`), opt.details, more),
		], at]);
		const missingJobs = (named.backgroundJobs ?? []).filter((c) => !run.listedJobs.includes(c));
		if (missingJobs.length) {
			report(onlyDep, 'warn', 'job-not-listed', [
				`${name}: ${plural(missingJobs.length, 'background job of info.xml is', 'background jobs of info.xml are')}`
				+ ' not in occ background-job:list once the app is enabled.',
				...sample(missingJobs, opt.details, more),
			], at);
		}
		parted(run.jobs.filter(failedStep), (x) => byDep(x.log), (js) => ['warn', 'job-failed', [
			`${name}: occ background-job:execute --force-execute fails for ${plural(js.length, 'job', 'jobs')}.`,
			...sample(js.map((x) => `${x.name}  exit code ${x.result}${x.result === '124' ? ' (stopped after 10 minutes)' : ''}`), opt.details, more),
		], at]);
		const checks = regs.filter((g) => g.method === 'registerSetupCheck').map((g) => g.arguments[0]).filter(Boolean);
		if (checks.length) {
			const found = {};
			for (const cat of Object.values(run.setupChecks.result ?? {})) for (const [cls, v] of Object.entries(cat ?? {})) found[cls] = v;
			const missing = checks.filter((c) => !found[c]);
			const threw = checks.filter((c) => String(found[c]?.description ?? '').startsWith(CHECK_THREW));
			if (missing.length) {
				report(onlyDep, 'warn', 'setupcheck-not-listed', [
					`${name}: occ setupchecks does not list ${plural(missing.length, 'setup check', 'setup checks')} the app registers.`,
					...sample(missing, opt.details, more),
				], at);
			}
			parted(threw, (c) => cause(found[c].description) !== null, (cs) => ['warn', 'setupcheck-failed', [
				`${name}: ${plural(cs.length, 'setup check throws', 'setup checks throw')}.`,
				...sample(cs.map((c) => `${c}: ${String(found[c].description).split('\n')[1] ?? ''}`.trim()), opt.details, more),
			], at]);
		}
		const declared = run.settingsRead ? (named.settings ?? []).filter((c) => !run.newSettings.includes(c)) : [];
		if (declared.length) {
			report(onlyDep, 'warn', 'settings-not-loaded', [
				`${name}: the settings manager has no form of ${plural(declared.length, 'settings class', 'settings classes')} in info.xml.`,
				...sample(declared, opt.details, more),
			], at);
		}
		parted(run.settings.filter((x) => x.result !== '200'), (x) => byDep(x.log), (ss) => ['warn', 'settings-failed', [
			`${name}: ${plural(ss.length, 'settings page does', 'settings pages do')} not answer 200 as the admin.`,
			...sample(ss.map((x) => `${x.name}  ${status(Number(x.result))}`), opt.details, more),
		], at]);
		const caps = run.capabilities;
		if (caps.step && caps.step.result !== '200') {
			report(byDep(caps.step.log), 'warn', 'capabilities-failed', [`${name}: /ocs/v2.php/cloud/capabilities answers ${status(Number(caps.step.result))} once the app is enabled.`], at);
		} else if (regs.some((g) => g.method === 'registerCapability') && !caps.added.length) {
			add('info', 'capability-not-listed', [
				`${name}: the app registers a capability, and the capabilities have no new key once it is enabled.`
				+ ' A capability may leave its key out until the app is configured.',
			], at);
		}
		if (run.dav && run.dav.result !== '207') {
			report(byDep(run.dav.log), 'warn', 'dav-failed', [`${name}: PROPFIND with Depth: 1 on the files of the admin answers ${status(Number(run.dav.result))} with the app enabled.`], at);
		}
		const badRepair = run.repair.filter(failedStep);
		if (badRepair.length) {
			report(badRepair.every((x) => byDep(x.log)), 'warn', 'repair-failed', [
				`${name}: disabling and enabling the app again fails: ${badRepair.map((s) => `occ app:${s.kind === 'reenable' ? 'enable' : 'disable'} exit code ${s.result}`).join(', ')}.`,
			], at);
		}

		// The log, as far as it reaches the app.
		const own = run.log.filter((e) => e.ownsApp);
		// where: how the entries come to count for the app, where it is not that
		// they reach it.
		const logged = (kind, level, id, what, where = null) => {
			const all = own.filter((e) => e.kind === kind);
			const hits = all.filter((e) => !cause(e.message));
			if (all.length > hits.length) {
				const n = all.length - hits.length;
				report(true, level, id, [`${name}: the server logs ${plural(n, 'entry', 'entries')} of ${what} that ${n === 1 ? 'reaches' : 'reach'} the app.`]);
			}
			if (!hits.length) return;
			add(level, id, [
				`${name}: the server logs ${plural(hits.length, 'entry', 'entries')} of ${what} `
					+ `${where ?? `that ${hits.length === 1 ? 'reaches' : 'reach'} the app`}.`,
				...sample([...new Set(hits.map(entryLine))], opt.details, more),
			], at);
		};
		logged('error', 'warn', 'log-errors', 'level 3 (error) or higher');
		logged('dirty', 'warn', 'log-dirty-reads', '"dirty table reads", a read after a write in one request');
		logged('dirty-server', 'info', 'log-dirty-reads-server', '"dirty table reads"',
			'in a request to the app, of a query the server builds');
		logged('transaction', 'warn', 'log-long-transaction', 'a transaction that took longer than 1s');
		logged('deadlock', 'warn', 'log-deadlock', 'a deadlock or a locked database');
		logged('deprecation', 'info', 'log-deprecations', 'a PHP deprecation');

		needsApp();
		if (!folded.length && !list.some((f) => f.tag === run.tag && f.level === 'warn')) {
			add('ok', 'runtime', [
				`${name}: ${plural(run.requests.length, 'route', 'routes')}, ${plural(run.commands.length, 'command', 'commands')}`
				+ ` and ${plural(run.jobs.length, 'job', 'jobs')} ran without a failure, and the log has no error that reaches the app.`,
			], at);
		}
	}
	return sortFindings(list);
}

// Nextcloud refuses an app whose <php max-version> is below the PHP of the
// server, so the app is not fit for that server as it is declared: a warning,
// whatever the run with the cap raised shows. That run, and the one on the PHP
// of max-version where it failed, say whether the cap or the code is the cause.
// php-compat reports the same cap.
function capFinding(run, fallback, name, at, opt, add, more) {
	const raised = run.phpRaised ? `With max-version raised to ${run.phpRaised} in the copy of the app` : 'max-version could not be raised in the copy of the app, and';
	const text = [
		`${name}: the app declares PHP ${run.phpCap} as its highest, and Nextcloud refuses to enable it on PHP ${run.php ?? 'of the server'}.`
		+ ' The app is not fit for this server as it is declared.',
	];
	if (run.stopped !== 'enable') {
		text.push(`  ${raised} it enables, and the audit went on with it: the code runs on this PHP, the declaration lags behind it.`);
	} else {
		text.push(`  ${raised} it does not enable either.`, ...sample(run.enable.output, opt.details, more));
		if (fallback && !fallback.enable.step && !fallback.stopped) {
			text.push(`  No server of Nextcloud ${run.tag} on PHP ${run.retry} ran (ncmake-server:${fallback.tag}); its findings are missing.`);
		} else if (fallback) {
			text.push(`  On PHP ${fallback.php ?? run.retry}, the PHP the app declares, it ${fallback.stopped === 'enable' ? 'does not enable either' : 'enables'};`
				+ ` the findings of that run are those of ${fallback.tag}.`);
		}
	}
	add('warn', 'php-max-below-server', text, { ...at, covers: ['php-compat/php-max-below-server'] });
}

// == Human-readable output ==
function render(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const how = howToRun('RUNTIME_AUDIT_CMDLINE', 'runtime-audit.mjs %s');
	p(`runtime-audit  ${r.app.id ?? 'no app id'}${r.app.version ? ` ${r.app.version}` : ''}`);
	p(`  on ${r.runs.length ? r.runs.map((x) => `Nextcloud ${x.server ?? x.tag}`).join(', ') : 'no server'}.`);
	for (const run of r.runs) {
		if (!run.requests.length && !run.commands.length && !run.jobs.length) continue;
		p();
		p(`${nameOf(run).toUpperCase()}`);
		if (run.requests.length) {
			p(table(['verb', 'path', 'anon', 'as', 'status', 'log'],
				run.requests.map((q) => [q.verb, q.path, status(q.anon), q.as, status(q.auth), q.log.filter((e) => e.ownsApp && e.kind).length || '']),
				['l', 'l', 'r', 'l', 'r', 'r']).split('\n').map((l) => `  ${l}`).join('\n'));
		}
		const ran = (label, steps) => {
			if (!steps.length) return;
			p(`  ${label}:`);
			for (const s of steps) p(`    ${s.name}  ${Number(s.result) === 0 ? 'ok' : s.result}`);
		};
		ran('commands (--help)', run.commands);
		ran('background jobs', run.jobs);
		ran('settings pages', run.settings.map((s) => ({ name: s.name, result: s.result === '200' ? '0' : s.result })));
	}
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('Each server is the image ncmake-server of that major. The staged app was');
	p('enabled at log level 0; each route of the inventory of make php-audit was');
	p('requested without credentials and as a user, or as the admin where the');
	p('route declares neither NoAdminRequired nor PublicPage, a POST, PUT or');
	p('PATCH with an empty JSON object as its body. Each new command');
	p('ran with --help, each background job of the app once, then the setup');
	p('checks, the settings pages, the capabilities, WebDAV, and disabling and');
	p('enabling the app again. A log entry counts where its app field, a file of');
	p('its trace or a class of its trace is the app. What each run left is in');
	p('build/runtime-audit.');
	if (r.range.db === 'pgsql') p('The app names pgsql and not sqlite, so each server was installed on PostgreSQL.');
	if (r.runs.some((x) => x.phpCap)) {
		p('Where the server refused the <php max-version> of the app, it was raised in');
		p('the copy; where the app did not enable even so, it ran once more on the server');
		p('image of that PHP, <tag>-php<minor>.');
	}
	p(`The report is in ${REPORTS}/runtime-audit.txt, the JSON in ${REPORTS}/runtime-audit.json.`);
	p();
	p(`Every entry behind a finding: ${how('--details')}`);
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
if (opt.plan) {
	writePlan(plan(readInventory(), readParams(process.env.RUNTIME_AUDIT_PARAMS)));
} else {
	const r = check();
	r.findings = findings(r, opt);
	const { inventory, ...report } = r;
	// The log entries stay in build/runtime-audit; the JSON names the ones that
	// reach the app.
	for (const run of report.runs) {
		run.log = run.log.filter((e) => e.ownsApp && e.kind);
		for (const q of run.requests) q.log = q.log.filter((e) => e.ownsApp && e.kind);
	}
	const json = toJson(report, die);
	const text = `${render(report)}\n`;
	process.stdout.write(opt.json ? json : text);
	try { fs.mkdirSync(REPORTS, { recursive: true }); } catch (e) { die(`could not create ${REPORTS}: ${e.message}`); }
	writeJsonFile(path.join(REPORTS, 'runtime-audit.json'), json, die);
	writeJsonFile(path.join(REPORTS, 'runtime-audit.txt'), text, die);
	if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
}
