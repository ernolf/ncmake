#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// php-audit - what the PHP source of an app has, and whether the server can load
// and run it the way the developer manual describes.
//
// The PHP half, php-audit.php, parses appinfo/, lib/ and templates/ with
// nikic/php-parser and states what the source says: the classes, what each file
// refers to and calls. This reads that next to appinfo/info.xml, the Composer
// setup and the autoloader, and holds it against the public API of the server
// over the majors the app declares.
//
// What the server has in which major is data: data/nextcloud-ocp.json is the
// package nextcloud/ocp per major, data/nextcloud-3rdparty.json the Composer
// packages the server ships. A finding that depends on a major takes it from
// there: "the range reaches the major after the last one that has
// ILogger::error" is computed, not written down. What no source states stays a
// table here: which interface the server expects behind an element of info.xml,
// and the major in which the DAV server started to emit preloadCollection.
//
// A class is judged by its ancestry only where all of it is known: the classes
// of the app, of the public API and of PHP itself. A class that extends one of
// a library is left alone, since what that one implements is not known here.
//
// The inventory in the JSON is what the app has: its classes, what it registers
// in Application::register(), what info.xml names and its background jobs. The
// exit code is 0 with or without findings, and 2 when the run itself could not
// be carried out.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readData } from './data.mjs';
import {
	LEGEND,
	howToRun,
	num,
	plural,
	renderFindings,
	sortFindings,
	toJson,
	writeJsonFile,
} from './report-text.mjs';

const SAMPLE = 3;    // places named per finding without --details
const REPORTS = path.join('build', 'reports');
const RAW = path.join('build', 'php-audit');

// == What no source states ==
// The interface or base class the server expects behind a class that info.xml
// names. The element decides which one; the app info schema only says that the
// text is a PHP class. null: only that the class exists is checked.
const SETTINGS = ['OCP\\Settings\\ISettings'];
const SECTION = ['OCP\\Settings\\IIconSection'];
const INFO_XML = [
	{ key: 'backgroundJobs', label: 'background job', within: ['background-jobs'], element: 'job', expects: ['OCP\\BackgroundJob\\IJob'] },
	{ key: 'settings', label: 'admin settings', within: ['settings'], element: 'admin', expects: SETTINGS },
	{ key: 'settings', label: 'personal settings', within: ['settings'], element: 'personal', expects: SETTINGS },
	{ key: 'settings', label: 'delegated admin settings', within: ['settings'], element: 'admin-delegation', expects: SETTINGS },
	{ key: 'sections', label: 'admin section', within: ['settings'], element: 'admin-section', expects: SECTION },
	{ key: 'sections', label: 'personal section', within: ['settings'], element: 'personal-section', expects: SECTION },
	{ key: 'sections', label: 'delegated admin section', within: ['settings'], element: 'admin-delegation-section', expects: SECTION },
	{ key: 'commands', label: 'command', within: ['commands'], element: 'command', expects: ['Symfony\\Component\\Console\\Command\\Command'] },
	{ key: 'davPlugins', label: 'DAV plugin', within: ['sabre', 'plugins'], element: 'plugin', expects: ['Sabre\\DAV\\ServerPlugin'] },
	{ key: 'davPlugins', label: 'address book plugin', within: ['sabre', 'address-book-plugins'], element: 'plugin', expects: null },
	{ key: 'davPlugins', label: 'calendar plugin', within: ['sabre', 'calendar-plugins'], element: 'plugin', expects: null },
	{ key: 'davCollections', label: 'DAV collection', within: ['sabre', 'collections'], element: 'collection', expects: null },
	{ key: 'activity', label: 'activity setting', within: ['activity', 'settings'], element: 'setting', expects: ['OCP\\Activity\\ISetting'] },
	{ key: 'activity', label: 'activity filter', within: ['activity', 'filters'], element: 'filter', expects: ['OCP\\Activity\\IFilter'] },
	{ key: 'activity', label: 'activity provider', within: ['activity', 'providers'], element: 'provider', expects: ['OCP\\Activity\\IProvider'] },
	{ key: 'openMetrics', label: 'OpenMetrics exporter', within: ['openmetrics'], element: 'exporter', expects: ['OCP\\OpenMetrics\\IMetricFamily'] },
];
const REPAIR_KINDS = ['pre-migration', 'post-migration', 'live-migration', 'install', 'uninstall'];
const REPAIR_STEP = 'OCP\\Migration\\IRepairStep';
const REPAIR_EXPENSIVE = 'OCP\\Migration\\IRepairStepExpensive';

// The first major whose DAV server emits preloadCollection before it reads the
// children of a collection ("WebDAV collection preload events" of the developer
// manual). The event has no class in the public API, so no data file has it.
const DAV_PRELOAD_MAJOR = 32;

// Development tools the manual wants in a vendor-bin/ of the
// composer-bin-plugin, where their dependencies do not meet those of the app.
const DEV_TOOLS = ['vimeo/psalm', 'psalm/phar', 'friendsofphp/php-cs-fixer', 'phpunit/phpunit'];

const JOB = 'OCP\\BackgroundJob\\Job';
const IJOB = 'OCP\\BackgroundJob\\IJob';
const TIMED_JOB = 'OCP\\BackgroundJob\\TimedJob';
const QUEUED_JOB = 'OCP\\BackgroundJob\\QueuedJob';
const LOGGER = 'OCP\\ILogger';
const USER_MANAGER = 'OCP\\IUserManager';
const REGISTRATION = 'OCP\\AppFramework\\Bootstrap\\IRegistrationContext';
const BOOTSTRAP = 'OCP\\AppFramework\\Bootstrap\\IBootstrap';
const TRANSACTIONAL = 'OCP\\AppFramework\\Db\\TTransactional';
const SETUP_CHECK = 'OCP\\SetupCheck\\ISetupCheck';
const CONTAINERS = ['OCP\\Server', 'OCP\\IServerContainer', 'OCP\\AppFramework\\IAppContainer', 'Psr\\Container\\ContainerInterface'];
const APP_CONFIG = ['OCP\\IAppConfig', 'OCP\\AppFramework\\Services\\IAppConfig'];

// == Command line ==
function usage() {
	return `php-audit - what the PHP source of an app has, and whether the server can load it

Usage: php-audit.mjs [options]

Runs in the app checkout, after make php-audit has left what the PHP half
read in ${RAW}/facts.json.

Options:
  --details             every place of a finding, not the first ${SAMPLE}
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The report is written to ${REPORTS}/php-audit.txt and ${REPORTS}/php-audit.json
as well. The exit code is 0 with or without findings, and 2 when the run itself
could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`php-audit: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { details: false, json: false, jsonFile: null };
	for (const arg of argv) {
		switch (arg) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
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

function readJson(file) {
	const text = read(file);
	if (text === null) return null;
	try {
		const doc = JSON.parse(text);
		return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
	} catch {
		return null;
	}
}

// info.xml is read with expressions: the elements this needs are flat lists of
// class names below a named parent.
const inner = (xml, tag) => {
	const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml ?? '');
	return m ? m[1] : null;
};
const texts = (xml, tag) => [...(xml ?? '').matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))]
	.map((m) => m[1].trim()).filter(Boolean);
const className = (s) => s.replace(/^\\+/, '');

function readInfoXml() {
	const raw = read(path.join('appinfo', 'info.xml'));
	if (raw === null) die('no appinfo/info.xml: run it in the checkout of an app');
	const xml = raw.replace(/<!--[\s\S]*?-->/g, '');
	const nc = /<nextcloud\b([^>]*)>/.exec(inner(xml, 'dependencies') ?? '');
	const major = (name) => {
		const m = new RegExp(`${name}\\s*=\\s*["'](\\d+)`).exec(nc ? nc[1] : '');
		return m ? Number(m[1]) : null;
	};
	// <activity> has a <settings> of its own, and it comes first in no fixed order.
	const top = xml.replace(/<activity(?:\s[^>]*)?>[\s\S]*?<\/activity>/, '');
	const named = {};
	const entries = [];
	for (const row of INFO_XML) {
		let scope = row.within[0] === 'activity' ? xml : top;
		for (const tag of row.within) scope = inner(scope, tag);
		for (const name of texts(scope, row.element).map(className)) {
			(named[row.key] ??= []).push(name);
			entries.push({ name, label: row.label, expects: row.expects, element: `<${row.within.join('><')}><${row.element}>` });
		}
	}
	const steps = {};
	const repair = inner(top, 'repair-steps');
	for (const kind of REPAIR_KINDS) {
		for (const name of texts(inner(repair, kind), 'step').map(className)) {
			(steps[kind] ??= []).push(name);
			entries.push({ name, label: 'repair step', expects: [REPAIR_STEP], element: `<repair-steps><${kind}><step>`, repair: kind });
		}
	}
	const navigation = [];
	for (const m of (inner(top, 'navigations') ?? '').matchAll(/<navigation(?:\s[^>]*)?>([\s\S]*?)<\/navigation>/g)) {
		navigation.push({ name: texts(m[1], 'name')[0] ?? null, route: texts(m[1], 'route')[0] ?? null, type: texts(m[1], 'type')[0] ?? 'link' });
	}
	return {
		id: texts(xml, 'id')[0] ?? null,
		version: texts(xml, 'version')[0] ?? null,
		namespace: texts(xml, 'namespace')[0] ?? null,
		min: major('min-version'),
		max: major('max-version'),
		named: { ...named, repairSteps: steps, navigation },
		entries,
	};
}

function tracked(file) {
	try {
		execFileSync('git', ['ls-files', '--error-unmatch', '--', file], { stdio: ['ignore', 'ignore', 'ignore'] });
		return true;
	} catch {
		return false;
	}
}

const inRepo = () => {
	try {
		return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true';
	} catch {
		return false;
	}
};

// == The model ==
function load() {
	const ocp = readData('nextcloud-ocp');
	const third = readData('nextcloud-3rdparty');
	if (!ocp || !third) die('data/nextcloud-ocp.json or data/nextcloud-3rdparty.json is not beside the analyser - network?');
	const factsFile = path.join(RAW, 'facts.json');
	const err = (read(path.join(RAW, 'facts.err')) ?? '').trim();
	let facts;
	try {
		facts = JSON.parse(read(factsFile) ?? '');
	} catch {
		die(`the PHP half left no result in ${factsFile}${err ? `: ${err.split('\n').slice(-3).join(' ')}` : ' - run make php-audit'}`);
	}
	const info = readInfoXml();
	const majors = ocp.values.majors;
	const first = majors[0];
	const last = majors[majors.length - 1];
	const lo = Math.min(Math.max(info.min ?? first, first), last);
	const hi = Math.max(Math.min(info.max ?? last, last), lo);

	const classes = new Map();
	const errors = [];
	for (const [file, f] of Object.entries(facts.files)) {
		if (f.error) { errors.push({ file, error: f.error }); continue; }
		for (const c of f.classes) if (!classes.has(c.name)) classes.set(c.name, { ...c, file });
	}
	return {
		ocp: ocp.values.classes, third: third.values.packages, sources: { ocp: ocp.file, third: third.file, read: ocp.read },
		facts, info, lo, hi, declared: { min: info.min, max: info.max }, classes, errors,
		namespace: `OCA\\${info.namespace ?? (info.id ? info.id[0].toUpperCase() + info.id.slice(1) : '')}`,
	};
}

// Everything a class is: itself, what it extends and implements, and what
// those do. complete says that every name on the way was a class of the app,
// of the public API or of PHP, so that "is not a ..." can be said.
function ancestry(m, name) {
	const all = new Set();
	let complete = true;
	const queue = [name];
	while (queue.length) {
		const n = queue.pop();
		if (all.has(n)) continue;
		all.add(n);
		const own = m.classes.get(n);
		if (own) queue.push(...own.extends, ...own.implements);
		else if (m.ocp[n]) queue.push(...m.ocp[n].parents);
		else if (n.includes('\\')) complete = false;
	}
	return { all, complete };
}

const is = (m, name, target) => ancestry(m, name).all.has(target);

// The majors of the declared range a method or a class of the public API is in:
// [first, last] as the data has them, or null where it has none.
const methodMajors = (m, cls, method) => m.ocp[cls]?.methods?.[method] ?? null;

function* each(m, kind) {
	for (const [file, f] of Object.entries(m.facts.files)) {
		if (f.error) continue;
		for (const row of f[kind]) yield [file, row];
	}
}

// Every method call, as an object.
function* calls(m) {
	for (const [file, c] of each(m, 'calls')) {
		yield { file, line: c[0], cls: c[1], method: c[2], name: c[3], on: c[4], innerName: c[5], innerOn: c[6], args: c[7] };
	}
}

const classArg = (arg) => (typeof arg === 'string' && (arg.startsWith('c:') || arg.startsWith('n:')) ? arg.slice(2) : null);
const at = (file, line) => `${file}:${line}`;
// Places that start with <file>:<line>, in the order of the files and the lines.
const byPlace = (a, b) => {
	const [fa, la] = a.split(' ')[0].split(':');
	const [fb, lb] = b.split(' ')[0].split(':');
	return fa.localeCompare(fb) || la - lb;
};
const span = (list) => {
	const s = [...list].sort((a, b) => a - b);
	return s.length === 1 || s[s.length - 1] - s[0] !== s.length - 1 ? s.join(', ') : `${s[0]} to ${s[s.length - 1]}`;
};

// == The inventory ==
function inventory(m) {
	const registrations = [];
	for (const c of calls(m)) {
		if (c.on === REGISTRATION && c.name.startsWith('register')) {
			registrations.push({ method: c.name, arguments: c.args.map((a) => classArg(a) ?? (typeof a === 'string' ? a.slice(2) : null)), file: c.file, line: c.line });
		}
	}
	const listed = new Set(m.info.named.backgroundJobs ?? []);
	const jobs = [];
	for (const c of m.classes.values()) {
		if (c.kind !== 'class' || c.abstract) continue;
		const a = ancestry(m, c.name).all;
		if (!a.has(IJOB) && !listed.has(c.name)) continue;
		const own = [...a].filter((n) => m.classes.has(n));
		const arg = (method) => {
			for (const call of calls(m)) if (call.name === method && own.includes(call.cls) && call.args[0]) return call.args[0];
			return null;
		};
		const interval = arg('setInterval');
		const sensitivity = arg('setTimeSensitivity');
		const parallel = arg('setAllowParallelRuns');
		jobs.push({
			class: c.name,
			file: c.file,
			kind: a.has(TIMED_JOB) ? 'timed' : a.has(QUEUED_JOB) ? 'queued' : a.has(IJOB) ? 'job' : 'unknown',
			interval: interval?.startsWith('i:') ? Number(interval.slice(2)) : null,
			timeSensitivity: sensitivity ? sensitivity.replace(/^k:.*::/, '').replace(/^i:/, '') : null,
			parallelRuns: parallel === 'b:false' ? false : parallel === 'b:true' ? true : null,
			inInfoXml: listed.has(c.name),
		});
	}
	return {
		classes: [...m.classes.values()].map((c) => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }))
			.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
		registrations,
		infoXml: m.info.named,
		backgroundJobs: jobs.sort((a, b) => a.class.localeCompare(b.class)),
	};
}

// == Findings ==
function findings(m, inv, opt) {
	const out = [];
	const how = howToRun('PHP_AUDIT_CMDLINE', 'php-audit.mjs %s');
	const { lo, hi } = m;
	const range = lo === hi ? `Nextcloud ${lo}` : `Nextcloud ${lo} to ${hi}`;
	// A finding: what it says, and the places it is about.
	const add = (id, level, lines, places = [], more = {}) => {
		const shown = opt.details ? places : places.slice(0, SAMPLE);
		const list = shown.map((s) => `  ${s}`);
		if (shown.length < places.length) list.push(`  ... ${num(places.length - shown.length)} more, see ${how('--details')}`);
		out.push({ id, level, ...more, places, lines: [...lines, ...list] });
	};

	// -- Class loading --
	const rootComposer = readJson('composer.json');
	const subComposer = readJson(path.join('composer', 'composer.json'));
	const composers = [[rootComposer, '.', 'composer.json'], [subComposer, 'composer', 'composer/composer.json']].filter(([doc]) => doc);
	const autoload = read(path.join('composer', 'autoload.php'));
	const prefix = `${m.namespace}\\`;
	if (autoload === null) {
		add('autoloader-generic', 'warn', [
			'The app ships no composer/autoload.php, so the server registers its generic loader for lib/ and looks every class up in the file system.',
			`  A composer/composer.json with config.vendor-dir ".", config.optimize-autoloader true, a config.autoloader-suffix and autoload.psr-4 {"${prefix.replaceAll('\\', '\\\\')}": "../lib/"} makes composer dump-autoload write composer/autoload.php with a class map; the code of the app does not change.`,
		]);
	} else {
		const [owner, , ownerFile] = composers.find(([, dir]) => dir === 'composer') ?? composers[0] ?? [];
		if (owner && owner.config?.['optimize-autoloader'] !== true) {
			add('autoloader-not-optimized', 'warn', [
				`composer/autoload.php is there, but ${ownerFile} does not set config.optimize-autoloader, so no class map is dumped at release time and every class is looked up in the file system.`,
			]);
		}
		const maps = composers.some(([doc, dir]) => Object.entries(doc.autoload?.['psr-4'] ?? {})
			.some(([ns, dirs]) => ns === prefix && [dirs].flat().some((d) => path.posix.normalize(path.posix.join(dir, String(d), '.')) === 'lib')));
		if (composers.length && !maps) {
			add('autoloader-app-namespace', 'warn', [
				`composer/autoload.php is there, but autoload.psr-4 of ${composers.map((c) => c[2]).join(' and ')} does not map ${prefix} to lib/. With a Composer autoloader the server registers no loader of its own for the classes of the app.`,
			]);
		}
		if (/vendor\/autoload\.php/.test(autoload)) {
			const there = inRepo() ? tracked('vendor/autoload.php') : fs.existsSync(path.join('vendor', 'autoload.php'));
			const built = rootComposer && path.posix.normalize(String(rootComposer.config?.['vendor-dir'] ?? 'vendor')) === 'vendor';
			if (!there && !built) {
				add('autoloader-not-shipped', 'warn', [
					'composer/autoload.php requires vendor/autoload.php, which is neither committed nor written by the build: there is no composer.json in the root that installs into vendor/. A release without it fails on every request.',
				]);
			}
		}
	}
	const strict = composers.flatMap(([doc, , file]) => ['classmap-authoritative', 'apcu-autoloader']
		.filter((k) => doc.config?.[k] === true).map((k) => `${file}: config.${k}`));
	if (strict.length) {
		add('autoloader-authoritative', 'warn', [
			'The Composer autoloader is optimized beyond level 1. The manual allows only config.optimize-autoloader: an authoritative class map breaks the upgrade of the app, and APCu is no required extension.',
		], strict);
	}
	const psr0 = composers.filter(([doc]) => Object.keys(doc.autoload?.['psr-0'] ?? {}).length).map((c) => `${c[2]}: autoload.psr-0`);
	if (psr0.length) add('psr-0', 'warn', ['A psr-0 autoload entry. PSR-0 is deprecated, and the server no longer loads the classes of an app by it.'], psr0);
	const stray = [];
	for (const c of m.classes.values()) {
		if (!c.file.startsWith('lib/')) continue;
		const expected = prefix + c.file.slice(4, -4).replaceAll('/', '\\');
		if (c.name !== expected) stray.push(`${at(c.file, c.line)} ${c.name}, by its path ${expected}`);
	}
	if (stray.length) {
		add('namespace-mismatch', 'warn', [
			`${plural(stray.length, 'class', 'classes')} in lib/ whose name does not follow PSR-4 below ${m.namespace}, the namespace the server derives from ${m.info.namespace ? '<namespace> of info.xml' : 'the app id'}. The loader of the server does not find such a class.`,
		], stray);
	}

	// -- Dependencies --
	const installed = readJson(path.join('vendor', 'composer', 'installed.json'));
	const lock = readJson('composer.lock');
	const dev = new Set((installed?.['dev-package-names'] ?? []).map((n) => String(n).toLowerCase()));
	const shipped = (installed ? (Array.isArray(installed.packages) ? installed.packages : []) : lock?.packages ?? [])
		.filter((p) => p && typeof p.name === 'string' && !dev.has(p.name.toLowerCase()));
	const shadows = [];
	for (const p of shipped) {
		const has = (m.third[p.name.toLowerCase()] ?? []).filter((major) => major >= lo && major <= hi);
		if (has.length) shadows.push(`${p.name} ${p.version ?? ''}`.trim() + `, in 3rdparty/ of Nextcloud ${span(has)}`);
	}
	if (shadows.length) {
		add('vendor-shadows-server', 'warn', [
			`vendor/ ships ${plural(shadows.length, 'package', 'packages')} that the server ships itself in a major of ${range}. Both copies define the same classes, and the autoloader that is asked first decides which version runs.`,
		], shadows);
	}
	const tools = DEV_TOOLS.filter((t) => rootComposer?.['require-dev']?.[t] !== undefined);
	if (tools.length) {
		add('dev-tools-in-root', 'info', [
			`${tools.join(', ')} ${tools.length === 1 ? 'is' : 'are'} in require-dev of composer.json. The manual recommends a vendor-bin/ of bamarni/composer-bin-plugin per tool, so that the dependencies of a tool cannot conflict with those of the app.`,
		]);
	}

	// -- Public API --
	const priv = [];
	for (const [file, f] of Object.entries(m.facts.files)) {
		if (f.error) continue;
		for (const [name, line] of Object.entries(f.refs)) {
			if (name === 'OC' || name.startsWith('OC\\') || /^OC_[A-Za-z]/.test(name)) priv.push({ file, line, text: name });
		}
		for (const line of f.ocserver) priv.push({ file, line, text: 'OC::$server' });
	}
	if (priv.length) {
		priv.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
		add('private-api', 'warn', [
			`${plural(priv.length, 'use', 'uses')} of the private API of the server in ${plural(new Set(priv.map((p) => p.file)).size, 'file', 'files')}. Only OCP and NCU are public: what is below OC changes without notice between majors.`,
		], priv.map((p) => `${at(p.file, p.line)} ${p.text}`));
	}
	const consumed = [];
	for (const c of m.classes.values()) {
		for (const parent of [...c.extends, ...c.implements]) {
			const since = m.ocp[parent]?.consumable;
			if (since !== undefined && since <= hi && m.ocp[parent].majors[1] >= lo) consumed.push(`${at(c.file, c.line)} ${c.name} ${c.extends.includes(parent) ? 'extends' : 'implements'} ${parent}`);
		}
	}
	if (consumed.length) {
		add('implements-consumable', 'warn', [
			`${plural(consumed.length, 'class implements', 'classes implement')} or ${consumed.length === 1 ? 'extends' : 'extend'} what the public API marks #[Consumable] in a major of ${range}: an app calls it, and the server may add a method to it in any release, which breaks a class that implements it.`,
		], consumed);
	}
	const logger = [];
	let loggerLast = null;
	for (const c of calls(m)) {
		const majors = c.on === LOGGER ? methodMajors(m, LOGGER, c.name) : null;
		if (majors && majors[1] < hi) { logger.push(`${at(c.file, c.line)} ${c.name}()`); loggerLast = majors[1]; }
	}
	if (logger.length) {
		add('ilogger-methods', 'warn', [
			`${plural(logger.length, 'call', 'calls')} of a logging method of OCP\\ILogger, which Nextcloud ${loggerLast} is the last major to have, while the app declares ${range}. Psr\\Log\\LoggerInterface has the same methods.`,
		], logger);
	}

	// -- Registrations --
	const missing = [];
	const wrong = [];
	const expensive = [];
	for (const e of m.info.entries) {
		const own = m.classes.get(e.name);
		if (!own) {
			if (e.name.startsWith(prefix)) missing.push(`${e.name}, ${e.label} in ${e.element}`);
			continue;
		}
		const a = ancestry(m, e.name);
		if (e.expects && a.complete && !e.expects.some((x) => a.all.has(x))) {
			wrong.push(`${at(own.file, own.line)} ${e.name}, ${e.label} in ${e.element}, is no ${e.expects.join(' or ')}`);
		}
		if (e.repair && e.repair !== 'post-migration' && a.all.has(REPAIR_EXPENSIVE)) {
			expensive.push(`${at(own.file, own.line)} ${e.name} in ${e.element}`);
		}
	}
	if (missing.length) {
		add('info-xml-class-missing', 'warn', [
			`appinfo/info.xml names ${plural(missing.length, 'class', 'classes')} that appinfo/ and lib/ do not have. The server fails when it comes to load one.`,
		], missing);
	}
	if (wrong.length) {
		add('info-xml-class-wrong-type', 'warn', [
			`appinfo/info.xml names ${plural(wrong.length, 'class', 'classes')} that ${wrong.length === 1 ? 'is' : 'are'} not what the server expects in that place.`,
		], wrong);
	}
	if (expensive.length) {
		add('repair-expensive-step', 'warn', [
			`${plural(expensive.length, 'repair step', 'repair steps')} that ${expensive.length === 1 ? 'implements' : 'implement'} IRepairStepExpensive outside <post-migration>. The server skips an expensive step unless it is asked for, which is meant for the repair after a migration.`,
		], expensive);
	}
	const checks = [];
	for (const r of inv.registrations) {
		const name = r.method === 'registerSetupCheck' ? r.arguments[0] : null;
		const own = name ? m.classes.get(name) : null;
		if (!own) continue;
		const a = ancestry(m, name);
		if (a.complete && !a.all.has(SETUP_CHECK)) checks.push(`${at(r.file, r.line)} ${name}`);
	}
	if (checks.length) {
		add('setup-check-wrong-type', 'warn', [
			`registerSetupCheck() is given ${plural(checks.length, 'class', 'classes')} that ${checks.length === 1 ? 'does' : 'do'} not implement ${SETUP_CHECK}.`,
		], checks);
	}
	const executeLast = methodMajors(m, JOB, 'execute')?.[1] ?? null;
	const executes = [];
	if (executeLast !== null && executeLast < hi) {
		for (const c of m.classes.values()) {
			if (c.kind === 'class' && c.methods.execute && is(m, c.name, JOB)) executes.push(`${at(c.file, c.methods.execute.line)} ${c.name}::execute()`);
		}
	}
	if (executes.length) {
		add('job-execute', 'warn', [
			`${plural(executes.length, 'background job overrides', 'background jobs override')} execute(), which Nextcloud ${executeLast} is the last major to have, while the app declares ${range}. The server calls start()${methodMajors(m, JOB, 'start') ? `, there since Nextcloud ${methodMajors(m, JOB, 'start')[0]}` : ''}, and a job does its work in run().`,
		], executes);
	}
	const legacy = ['install.php', 'update.php', 'preupdate.php'].map((f) => `appinfo/${f}`).filter((f) => fs.existsSync(f));
	if (legacy.length) {
		add('install-php', 'warn', [
			`${legacy.join(', ')} ${legacy.length === 1 ? 'is' : 'are'} deprecated: a repair step in <repair-steps> of info.xml does the same, with the classes of the app loaded and its output in the log.`,
		]);
	}

	// -- Performance --
	const dav = new Map();
	for (const c of calls(m)) {
		if (c.name !== 'on' || !c.cls || typeof c.args[0] !== 'string') continue;
		const event = c.args[0].replace(/^s:/, '');
		if (event !== 'propFind' && event !== 'preloadCollection') continue;
		const seen = dav.get(c.cls) ?? dav.set(c.cls, { file: c.file }).get(c.cls);
		seen[event] ??= c.line;
	}
	const unpreloaded = [...dav].filter(([, s]) => s.propFind && !s.preloadCollection).map(([cls, s]) => `${at(s.file, s.propFind)} ${cls}`);
	if (unpreloaded.length && hi >= DAV_PRELOAD_MAJOR) {
		add('dav-without-preload', 'warn', [
			`${plural(unpreloaded.length, 'DAV plugin listens', 'DAV plugins listen')} to propFind and not to preloadCollection, which the server emits from Nextcloud ${DAV_PRELOAD_MAJOR} on before it reads the children of a collection. Without that listener a PROPFIND with Depth above 0 runs the queries of the plugin once per child.`,
		], unpreloaded);
	}
	const nameSince = methodMajors(m, USER_MANAGER, 'getDisplayName')?.[0] ?? null;
	const lookups = [];
	if (nameSince !== null && nameSince <= hi) {
		for (const c of calls(m)) {
			if (c.name === 'getDisplayName' && c.innerName === 'get' && c.innerOn === USER_MANAGER) lookups.push(at(c.file, c.line));
		}
	}
	if (lookups.length) {
		add('display-name-lookup', 'warn', [
			`${plural(lookups.length, 'place loads', 'places load')} a user with IUserManager::get() only to ask for the display name. IUserManager::getDisplayName(), there since Nextcloud ${nameSince}, answers from a cache and loads no user.`,
		], lookups);
	}
	const atomic = methodMajors(m, TRANSACTIONAL, 'atomic');
	const retry = methodMajors(m, TRANSACTIONAL, 'atomicRetry');
	const begins = [...calls(m)].filter((c) => c.name === 'beginTransaction');
	const ends = [...calls(m)].some((c) => c.name === 'commit' || c.name === 'rollBack');
	if (begins.length && ends && atomic && atomic[0] <= hi) {
		add('transaction-manual', 'info', [
			`${plural(begins.length, 'transaction is', 'transactions are')} opened and closed by hand. The trait TTransactional has atomic() since Nextcloud ${atomic[0]}${retry ? ` and atomicRetry() since Nextcloud ${retry[0]}, which repeats a transaction that ran into a deadlock, as the manual recommends` : ''}.`,
		], begins.map((c) => at(c.file, c.line)));
	}
	const sensitivitySince = methodMajors(m, TIMED_JOB, 'setTimeSensitivity')?.[0] ?? null;
	const insensitive = sensitivitySince !== null && sensitivitySince <= hi
		? inv.backgroundJobs.filter((j) => j.kind === 'timed' && j.timeSensitivity === null) : [];
	if (insensitive.length) {
		add('job-time-sensitivity', 'info', [
			`${plural(insensitive.length, 'timed job does', 'timed jobs do')} not say whether ${insensitive.length === 1 ? 'it is' : 'they are'} time sensitive. A job that sets TIME_INSENSITIVE with setTimeSensitivity() is moved to the maintenance window of the server; whether a job is heavy enough for that only its maintainer knows.`,
		], insensitive.map((j) => `${j.file} ${j.class}`));
	}
	const boots = [];
	for (const c of calls(m)) {
		if (c.method !== 'boot' || !c.cls || !is(m, c.cls, BOOTSTRAP)) continue;
		const listener = c.name === 'addListener' || c.name === 'addServiceListener';
		const query = c.name === 'injectFn' || ((c.name === 'get' || c.name === 'query')
			&& (CONTAINERS.includes(c.on) || c.innerName === 'getAppContainer' || c.innerName === 'getServerContainer'));
		if (listener || query) boots.push(`${at(c.file, c.line)} ${c.name}()`);
	}
	if (boots.length) {
		add('boot-listener', 'warn', [
			`boot() registers a listener or takes a service from the container in ${plural(boots.length, 'place', 'places')}. boot() runs once for every process of the server, so each of them is built on every request. registerEventListener() in register() builds a listener only when its event fires.`,
		], boots);
	}

	// -- Platform services --
	const clock = [];
	for (const [file, f] of each(m, 'funcs')) if (file.startsWith('lib/') && f[1] === 'time') clock.push(`${at(file, f[0])} time()`);
	for (const [file, n] of each(m, 'news')) {
		if (file.startsWith('lib/') && (n[1] === 'DateTime' || n[1] === 'DateTimeImmutable') && (n[2].length === 0 || n[2][0] === 's:now')) clock.push(`${at(file, n[0])} new ${n[1]}()`);
	}
	if (clock.length) {
		const psr = (m.ocp['OCP\\AppFramework\\Utility\\ITimeFactory']?.parents ?? []).includes('Psr\\Clock\\ClockInterface');
		add('time-direct', 'info', [
			`lib/ reads the clock directly in ${plural(clock.length, 'place', 'places')}. OCP\\AppFramework\\Utility\\ITimeFactory${psr ? ', a PSR-20 ClockInterface,' : ''} gives the same time and can be replaced in a test.`,
		], clock.sort(byPlace));
	}
	const lexiconSince = methodMajors(m, REGISTRATION, 'registerConfigLexicon')?.[0] ?? null;
	const reads = [...calls(m)].filter((c) => (APP_CONFIG.includes(c.on) && /^(get|set|has)/.test(c.name))
		|| (c.on === 'OCP\\IConfig' && /^(get|set)AppValue$/.test(c.name)));
	if (reads.length && lexiconSince !== null && lexiconSince <= hi && !inv.registrations.some((r) => r.method === 'registerConfigLexicon')) {
		add('config-without-lexicon', 'info', [
			`The app reads and writes its app config in ${plural(reads.length, 'place', 'places')} and registers no config lexicon, which IRegistrationContext::registerConfigLexicon() takes since Nextcloud ${lexiconSince}. A lexicon states the type, the default and the sensitivity of each key in one place.`,
		], reads.map((c) => `${at(c.file, c.line)} ${c.name}()`));
	}
	const http = [];
	for (const [file, f] of each(m, 'funcs')) {
		if (/^curl_(init|exec|multi_init)$/.test(f[1])) http.push(`${at(file, f[0])} ${f[1]}()`);
		else if ((f[1] === 'file_get_contents' || f[1] === 'fopen') && /^s:https?:\/\//i.test(f[2][0] ?? '')) http.push(`${at(file, f[0])} ${f[1]}() of a URL`);
	}
	for (const [file, n] of each(m, 'news')) if (n[1] === 'GuzzleHttp\\Client') http.push(`${at(file, n[0])} new ${n[1]}()`);
	if (http.length) {
		add('http-client-direct', 'warn', [
			`${plural(http.length, 'outgoing HTTP request does', 'outgoing HTTP requests do')} not go through OCP\\Http\\Client\\IClientService. Only its client applies the proxy, the certificate bundle and the timeouts of the server, and refuses a request to a local address unless the administrator allows it.`,
		], http.sort(byPlace), { security: true });
	}

	if (!out.length) out.push({ id: 'none', level: 'ok', places: [], lines: ['Nothing found in the PHP source that the checks of this audit cover.'] });
	return sortFindings(out);
}

// == Human-readable output ==
function render(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const how = howToRun('PHP_AUDIT_CMDLINE', 'php-audit.mjs %s');
	const inv = r.inventory;
	const named = Object.values(inv.infoXml).reduce((n, v) => n + (Array.isArray(v) ? v.length : Object.values(v).flat().length), 0);
	p(`php-audit  ${r.app.id ?? 'no app id'}${r.app.version ? ` ${r.app.version}` : ''}`);
	p(`  ${plural(r.files, 'PHP file', 'PHP files')} in appinfo/, lib/ and templates/, ${plural(inv.classes.length, 'class', 'classes')},`);
	p(`  namespace ${r.app.namespace}, held against Nextcloud ${r.range.lo === r.range.hi ? r.range.lo : `${r.range.lo} to ${r.range.hi}`}.`);
	p();
	p('INVENTORY');
	p(`  ${plural(inv.registrations.length, 'registration', 'registrations')} with IRegistrationContext, ${plural(inv.backgroundJobs.length, 'background job', 'background jobs')},`);
	p(`  ${plural(named, 'entry', 'entries')} of info.xml that ${named === 1 ? 'names' : 'name'} a class or a navigation.`);
	for (const j of inv.backgroundJobs) {
		const facts = [j.kind, j.interval !== null ? `every ${num(j.interval)} s` : null, j.timeSensitivity, j.parallelRuns === false ? 'no parallel runs' : null,
			j.inInfoXml || j.kind !== 'timed' ? null : 'not in info.xml'].filter(Boolean);
		p(`  ${j.class}: ${facts.join(', ')}`);
	}
	if (r.parseErrors.length) {
		p(`  ${plural(r.parseErrors.length, 'file', 'files')} could not be parsed and ${r.parseErrors.length === 1 ? 'is' : 'are'} not in the audit: ${r.parseErrors.map((e) => e.file).join(', ')}`);
	}
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p(`nikic/php-parser${r.parser ? ` ${r.parser}` : ''} on PHP ${r.php} read the source; what the server has in which`);
	p(`major comes from ${r.data.ocp} and ${r.data.third} of ncmake, read`);
	p(`${r.data.read}. A class is judged by what it extends only where all of that is`);
	p('a class of the app, of OCP or of PHP. The inventory is in the JSON.');
	p(`The report is in ${REPORTS}/php-audit.txt, the JSON in ${REPORTS}/php-audit.json.`);
	p();
	p(`Every place of a finding: ${how('--details')}`);
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const model = load();
const inv = inventory(model);
const report = {
	app: { id: model.info.id, version: model.info.version, namespace: model.namespace },
	range: { lo: model.lo, hi: model.hi, declared: model.declared },
	parser: process.env.PHP_AUDIT_PARSER_VERSION || null,
	php: model.facts.php,
	data: model.sources,
	files: Object.keys(model.facts.files).length,
	parseErrors: model.errors,
	inventory: inv,
	findings: findings(model, inv, opt),
};
const json = toJson(report, die);
const text = `${render(report)}\n`;
process.stdout.write(opt.json ? json : text);
try { fs.mkdirSync(REPORTS, { recursive: true }); } catch (e) { die(`could not create ${REPORTS}: ${e.message}`); }
writeJsonFile(path.join(REPORTS, 'php-audit.json'), json, die);
writeJsonFile(path.join(REPORTS, 'php-audit.txt'), text, die);
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
