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
// The endpoints are every URL the app adds to a server: the routes of
// appinfo/routes.php and of the route attributes, built the way the route parser
// of the server builds them, each with the controller method behind it and what
// that method declares about access, and what the app adds to the DAV server and
// to the capabilities. Which apps may state the root of a route outside OCS is
// data/nextcloud-server.json. Whether an endpoint answers on a real server is
// not asked here.
//
// The inventory in the JSON is what the app has: its classes, what it registers
// in Application::register(), what info.xml names, its background jobs and its
// endpoints. The exit code is 0 with or without findings, and 2 when the run itself could not
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
	sample,
	SAMPLE,
	sortFindings,
	table,
	toJson,
	writeJsonFile,
} from './report-text.mjs';

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

const IJOB = 'OCP\\BackgroundJob\\IJob';
const TIMED_JOB = 'OCP\\BackgroundJob\\TimedJob';
const QUEUED_JOB = 'OCP\\BackgroundJob\\QueuedJob';
const USER_MANAGER = 'OCP\\IUserManager';
const REGISTRATION = 'OCP\\AppFramework\\Bootstrap\\IRegistrationContext';
const BOOTSTRAP = 'OCP\\AppFramework\\Bootstrap\\IBootstrap';
const TRANSACTIONAL = 'OCP\\AppFramework\\Db\\TTransactional';
const SETUP_CHECK = 'OCP\\SetupCheck\\ISetupCheck';
const CONTAINERS = ['OCP\\Server', 'OCP\\IServerContainer', 'OCP\\AppFramework\\IAppContainer', 'Psr\\Container\\ContainerInterface'];
const APP_CONFIG = ['OCP\\IAppConfig', 'OCP\\AppFramework\\Services\\IAppConfig'];

// The route attributes and the parameters of each, in the order of its
// constructor, and the route table each type of Route::TYPE_* goes to.
const ATTRIBUTE = 'OCP\\AppFramework\\Http\\Attribute\\';
const ROUTE_PARAMS = ['verb', 'url', 'requirements', 'defaults', 'root', 'postfix'];
const ROUTE_ATTRIBUTES = {
	[`${ATTRIBUTE}Route`]: { type: null, params: ['type', ...ROUTE_PARAMS] },
	[`${ATTRIBUTE}FrontpageRoute`]: { type: 'routes', params: ROUTE_PARAMS },
	[`${ATTRIBUTE}ApiRoute`]: { type: 'ocs', params: ROUTE_PARAMS },
};
const ROUTE_TYPES = { TYPE_FRONTPAGE: 'routes', TYPE_API: 'ocs' };
// The routes the server makes of one entry of resources, as its route parser
// lists them: the action, the verb, and whether the URL ends in /{id}.
const RESOURCE = [['index', 'GET', false], ['show', 'GET', true], ['create', 'POST', false], ['update', 'PUT', true], ['destroy', 'DELETE', true]];
// The access attributes of a controller method, and the docblock annotation an
// attribute replaced where that one has another name.
const ACCESS = [['NoAdminRequired'], ['PublicPage'], ['NoCSRFRequired'], ['NoTwoFactorRequired'], ['UserRateLimit', 'UserRateThrottle'],
	['AnonRateLimit', 'AnonRateThrottle'], ['BruteForceProtection']];
const CONTROLLER = 'OCP\\AppFramework\\Controller';
const PUBLIC_SHARE = ['OCP\\AppFramework\\PublicShareController', 'OCP\\AppFramework\\AuthPublicShareController'];
const STATE_CHANGING = ['POST', 'PUT', 'PATCH', 'DELETE'];
const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
// Where the frontend source is: src/ where the app builds its frontend, js/
// where it writes it by hand. The calls that build a URL of the server.
const FRONTEND_DIRS = ['src', 'js'];
const FRONTEND_FILES = /\.(?:[cm]?js|jsx|ts|tsx|vue)$/;
const URL_CALLS = /\b(?:generateUrl|generateOcsUrl|generateRemoteUrl|linkToOCS|linkToRemote)\s*\(/g;

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
		databases: texts(inner(xml, 'dependencies') ?? '', 'database'),
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
	const server = readData('nextcloud-server');
	if (!ocp || !third || !server) die('data/nextcloud-ocp.json, data/nextcloud-3rdparty.json or data/nextcloud-server.json is not beside the analyser - network?');
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
	const m = {
		ocp: ocp.values.classes, third: third.values.packages, sources: { ocp: ocp.file, third: third.file, server: server.file, read: ocp.read },
		// The apps whose routes outside OCS may state their root, in the newest
		// major the app declares.
		rootApps: server.values.root_urls?.[String(hi)] ?? [],
		migrations: server.values.migrations ?? null,
		facts, info, lo, hi, declared: { min: info.min, max: info.max }, classes, errors, ocpMajors: [first, last],
		namespace: `OCA\\${info.namespace ?? (info.id ? info.id[0].toUpperCase() + info.id.slice(1) : '')}`,
	};
	m.routes = routeTable(m);
	return m;
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

// == Routes ==
// The routes of the app as the server builds them. For appinfo/routes.php that
// is the route parser of the server (lib/private/AppFramework/Routing/
// RouteParser.php): the name <controller>#<method> names the class
// <Controller>Controller and the route <app>.<controller>.<method>, and a root
// counts outside OCS only for the apps of data/nextcloud-server.json. For the
// route attributes it is Router::getAttributeRoutes(), which reads them from the
// files *Controller.php directly in lib/Controller/.
const camel = (s) => s.replace(/_[a-z]?/g, (x) => x.slice(1).toUpperCase());
const str = (v) => (typeof v === 'string' ? v : null);
const unset = (v) => v === undefined || v === null;
// A value of the PHP half that is an array, and not its mark for a class
// constant or for what is no constant.
const known = (v) => v !== null && typeof v === 'object' && !('$unknown' in v) && !('$const' in v);
const short = (name) => name.slice(name.lastIndexOf('\\') + 1);
const constName = (v) => (v && typeof v === 'object' && typeof v.$const === 'string' ? v.$const.slice(v.$const.lastIndexOf(':') + 1) : null);
const has = (r, name) => r.attributes.includes(name) || r.annotations.includes((ACCESS.find(([a]) => a === name) ?? [])[1] ?? name);

// The method a class has under a name, its own or an inherited one, with the
// class that declares it. null: it has none. undefined: the class extends or
// uses something that is not known here, so nothing can be said.
function findMethod(m, cls, method) {
	const lower = method.toLowerCase();
	const { all, complete } = ancestry(m, cls);
	let sure = complete;
	for (const n of all) {
		const own = m.classes.get(n);
		if (!own) {
			const name = Object.keys(m.ocp[n]?.methods ?? {}).find((k) => k.toLowerCase() === lower);
			if (name) return { class: n, name, visibility: 'public', static: false, attributes: [], attrs: [], annotations: [], api: true };
			continue;
		}
		const holders = [own];
		for (const t of own.traits) {
			if (m.classes.has(t)) holders.push(m.classes.get(t));
			else sure = false;
		}
		for (const h of holders) {
			const name = Object.keys(h.methods).find((k) => k.toLowerCase() === lower);
			if (name) return { class: h.name, name, file: h.file, ...h.methods[name] };
		}
	}
	return sure ? null : undefined;
}

function routeTable(m) {
	const id = m.info.id ?? '';
	const rows = [];
	const invalid = [];
	const unread = [];
	const rootOf = (ocs, root) => (root !== null && (ocs || m.rootApps.includes(id)) ? root : `/apps/${id}`);
	const add = (ocs, route, source, routeName = null) => {
		const name = str(route.name);
		const url = str(route.url);
		const verb = unset(route.verb) ? 'GET' : str(route.verb);
		const postfix = unset(route.postfix) ? '' : str(route.postfix);
		const root = unset(route.root) ? null : str(route.root);
		if (name === null || url === null || verb === null || postfix === null || (!unset(route.root) && root === null)) { unread.push(source); return; }
		const split = name.split('#');
		if (split.length !== 2 || !split[0] || !split[1]) { invalid.push({ name, source }); return; }
		const [controller, action] = split;
		const local = `${rootOf(ocs, root)}/${url.replace(/^\/+/, '')}`;
		rows.push({
			verb: verb.toUpperCase(),
			ocs,
			local,
			path: `${ocs ? '/ocs/v2.php' : '/index.php'}${local}`,
			name: routeName ?? `${ocs ? 'ocs.' : ''}${id}.${controller}.${action}${postfix}`.toLowerCase(),
			controller: `${camel(controller[0].toUpperCase() + controller.slice(1))}Controller`,
			method: camel(action),
			requirements: known(route.requirements) ? route.requirements : null,
			defaults: known(route.defaults) ? route.defaults : null,
			source,
		});
	};

	const file = 'appinfo/routes.php';
	const tables = [];
	const returned = m.facts.files[file]?.returns;
	if (returned) tables.push([returned.value, at(file, returned.line)]);
	for (const [f, [line, value]] of each(m, 'registered')) tables.push([value, at(f, line)]);
	for (const [value, source] of tables) {
		if (!known(value) || Array.isArray(value)) {
			if (!Array.isArray(value) || value.length) unread.push(source);
			continue;
		}
		for (const [key, ocs] of [['routes', false], ['ocs', true]]) {
			const list = value[key];
			if (list === undefined) continue;
			if (!known(list)) { unread.push(`${source} ${key}`); continue; }
			for (const route of Object.values(list)) {
				if (known(route) && !Array.isArray(route)) add(ocs, route, `${source} ${key}`);
				else unread.push(`${source} ${key}`);
			}
		}
		for (const [key, ocs] of [['resources', false], ['ocs-resources', true]]) {
			const list = value[key];
			if (list === undefined || (Array.isArray(list) && !list.length)) continue;
			if (!known(list) || Array.isArray(list)) { unread.push(`${source} ${key}`); continue; }
			for (const [resource, config] of Object.entries(list)) {
				const url = known(config) ? str(config.url) : null;
				if (url === null) { unread.push(`${source} ${key}`); continue; }
				for (const [action, verb, item] of RESOURCE) {
					add(ocs, { name: `${resource}#${action}`, url: item ? `${url}/{id}` : url, verb, root: config.root }, `${source} ${key}`,
						`${ocs ? 'ocs.' : ''}${id}.${resource.toLowerCase()}.${action}`);
				}
			}
		}
	}

	for (const [f, facts] of Object.entries(m.facts.files)) {
		const base = /^lib\/Controller\/([^/]+)Controller\.php$/.exec(f);
		if (!base || facts.error) continue;
		const cls = facts.classes.find((c) => c.name === `${m.namespace}\\Controller\\${base[1]}Controller`);
		if (!cls) continue;
		for (const [method, mf] of Object.entries(cls.methods)) {
			for (const a of mf.attrs ?? []) {
				const kind = ROUTE_ATTRIBUTES[a.name];
				if (!kind) continue;
				const arg = (name) => a.args[name] ?? a.args[kind.params.indexOf(name)];
				const type = kind.type ?? ROUTE_TYPES[constName(arg('type'))] ?? str(arg('type'));
				if (type !== 'ocs' && type !== 'routes') { unread.push(at(f, a.line)); continue; }
				add(type === 'ocs', { name: `${base[1]}#${method}`, url: arg('url'), verb: arg('verb'), root: arg('root'), postfix: arg('postfix'),
					requirements: arg('requirements'), defaults: arg('defaults') }, at(f, a.line));
			}
		}
	}

	// The class the server asks its container for, and the method on it. A
	// controller the app registers under its short name is found by that name.
	for (const r of rows) {
		const wanted = `${m.namespace}\\Controller\\${r.controller}`;
		const named = [...m.classes.values()].filter((c) => c.kind === 'class' && short(c.name) === short(r.controller));
		const cls = m.classes.get(wanted) ?? (named.length === 1 ? named[0] : null);
		const found = cls ? findMethod(m, cls.name, r.method) : undefined;
		r.class = cls ? cls.name : wanted;
		r.found = found ?? null;
		r.missing = !cls ? (named.length ? null : 'class') : found === null ? 'method' : found && found.visibility !== 'public' ? 'visibility' : null;
		const attributes = found ? found.attributes.filter((n) => n.startsWith(ATTRIBUTE)).map(short) : [];
		r.attributes = ACCESS.map(([a]) => a).filter((a) => attributes.includes(a));
		r.annotations = found ? ACCESS.map(([a, old]) => old ?? a).filter((a) => found.annotations.includes(a)) : [];
		// The scope of an OpenAPI attribute is a text or a constant SCOPE_<NAME>
		// of the attribute, whose value is the name in lower case.
		const scopes = (list) => (list ?? []).filter((a) => a.name === `${ATTRIBUTE}OpenAPI`).map((a) => {
			const v = a.args.scope ?? a.args[0];
			return v === undefined ? 'default' : str(v) ?? constName(v)?.replace(/^SCOPE_/, '').toLowerCase() ?? 'default';
		});
		const own = scopes(found?.attrs);
		const ofClass = scopes(cls?.attrs);
		r.openapi = own.length ? own : ofClass.length ? ofClass : r.ocs ? ['default'] : [];
		const all = cls ? ancestry(m, cls.name).all : new Set();
		r.kind = r.ocs ? 'OCS'
			: has(r, 'PublicPage') || PUBLIC_SHARE.some((p) => all.has(p)) ? 'public'
				: r.verb === 'GET' && has(r, 'NoCSRFRequired') ? 'page' : 'API';
	}
	return { rows, invalid, unread: [...new Set(unread)] };
}

// == References ==
// What the app itself calls: the route names and the paths its PHP, its
// templates and its frontend source name. HOLE stands for the part of a path
// that is no constant, a variable or an expression.
const HOLE = '\u0000';
const wild = (s) => s.includes(HOLE) || /\{[^}]*\}/.test(s);

// A path as its segments, without the front controller, the query and the
// fragment. open: it ends in something that is no constant, so it is a prefix.
function pathRef(raw, more = {}) {
	const segs = raw.replace(/[?#].*$/s, '').replace(/^\/+/, '').replace(/^(?:index\.php|ocs\/v[12]\.php)\//, '').split('/');
	const open = segs.length > 1 && segs[segs.length - 1] === HOLE;
	if (open) segs[segs.length - 1] = '';
	else if (segs.length > 1 && segs[segs.length - 1] === '') segs.pop();
	return { segs, open, ...more };
}

function matches(route, ref) {
	const n = ref.open ? ref.segs.length - 1 : ref.segs.length;
	if (ref.open ? route.length < ref.segs.length : route.length !== n) return false;
	for (let i = 0; i < n; i++) if (route[i] !== ref.segs[i] && !wild(route[i]) && !wild(ref.segs[i])) return false;
	return true;
}

// A path that is the start of a route: the frontend names it once and puts
// the rest behind it somewhere else.
function leads(route, ref) {
	const segs = ref.segs[ref.segs.length - 1] === '' ? ref.segs.slice(0, -1) : ref.segs;
	return route.length > segs.length && segs.every((s, i) => s === route[i] || wild(s) || wild(route[i]));
}

// The text that string literals joined by + build, read at pos; what stands
// between them and is no literal becomes a HOLE. null: no literal starts there.
function joined(src, pos) {
	const n = Math.min(src.length, pos + 2000);
	let out = '';
	let i = pos;
	for (let part = 0; ; part++) {
		while (i < n && /\s/.test(src[i])) i++;
		const q = src[i];
		if (q === '\'' || q === '"' || q === '`') {
			for (i++; ; ) {
				if (i >= n || (q !== '`' && src[i] === '\n')) return part ? out : null;
				const ch = src[i];
				if (ch === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
				if (ch === q) { i++; break; }
				if (q === '`' && ch === '$' && src[i + 1] === '{') {
					let depth = 0;
					for (i++; i < n; i++) {
						if (src[i] === '{') depth++;
						else if (src[i] === '}' && --depth === 0) { i++; break; }
					}
					out += HOLE;
					continue;
				}
				out += ch;
				i++;
			}
		} else {
			if (!part) return null;
			const from = i;
			for (let depth = 0; i < n; i++) {
				const ch = src[i];
				if ('([{'.includes(ch)) depth++;
				else if (')]}'.includes(ch)) { if (!depth) break; depth--; } else if (!depth && '+,;:?\n'.includes(ch)) break;
			}
			if (i === from) break;
			out += HOLE;
		}
		while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
		// A bundler writes a template literal as "<text>".concat(<expression>).
		if (src.startsWith('.concat(', i)) { out += HOLE; break; }
		if (src[i] !== '+' || src[i + 1] === '+' || src[i + 1] === '=') break;
		i++;
	}
	return out;
}

function frontendFiles() {
	const walk = (dir, out) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = `${dir}/${e.name}`;
			if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p, out); } else if (e.isFile() && FRONTEND_FILES.test(e.name)) out.push(p);
		}
		return out;
	};
	for (const dir of FRONTEND_DIRS) {
		const files = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? walk(dir, []) : [];
		if (files.length) return files.sort();
	}
	return [];
}

function references(m) {
	const id = m.info.id ?? '';
	const base = `apps/${id}`;
	const marker = `${base}/`;
	// Where the path of the app starts in a text: at apps/<id> as a whole word.
	const rootIn = (s) => {
		for (let i = s.indexOf(base); i >= 0; i = s.indexOf(base, i + 1)) if (!/[\w-]/.test(s[i + base.length] ?? '')) return i;
		return -1;
	};
	const anchored = new RegExp(`^/?(?:index\\.php/|ocs/v[12]\\.php/)?apps/${id.replace(/[^\w-]/g, '\\$&')}(?:/|$)`);
	const names = new Set();
	const paths = [];
	const shown = (s) => s.replaceAll(HOLE, '...');

	const php = (file, line, arg) => {
		if (typeof arg !== 'string' || !/^[sp]:/.test(arg)) return;
		const value = arg.slice(2);
		if (arg[0] === 's') names.add(value.toLowerCase());
		const i = value.indexOf(marker);
		if (i < 0) return;
		const whole = arg[0] === 'p' ? `${value}${HOLE}` : value;
		paths.push(pathRef(whole.slice(i), { file, line, from: file.startsWith('templates/') ? 'template' : 'php', anchored: anchored.test(value), shown: shown(whole) }));
	};
	for (const [file, c] of each(m, 'calls')) for (const a of c[7]) php(file, c[0], a);
	for (const [file, f] of each(m, 'funcs')) for (const a of f[2]) php(file, f[0], a);
	for (const [file, n] of each(m, 'news')) for (const a of n[2]) php(file, n[0], a);
	for (const n of m.info.named.navigation) if (n.route) names.add(n.route.toLowerCase());

	// A frontend that names the path of the app alone, apps/<id>, puts the
	// rest behind it somewhere else. Every text that starts with a slash is
	// then a path below the app that it may call.
	const files = frontendFiles();
	const relative = [];
	let built = false;
	for (const file of files) {
		const src = read(file) ?? '';
		const seen = new Set();
		const lineOf = (start) => src.slice(0, start).split('\n').length;
		const take = (start, call) => {
			if (seen.has(start)) return;
			const whole = joined(src, start);
			if (whole === null) return;
			seen.add(start);
			const i = rootIn(whole);
			if (!call && i < 0) return;
			if (i >= 0) {
				const rest = whole.slice(i + base.length).replace(/[?#].*$/s, '');
				if (rest === '' || rest === '/' || rest === HOLE || rest === `/${HOLE}`) built = true;
				if (rest.endsWith(HOLE) && rest.length <= 2) return;
			}
			paths.push(pathRef(call || i < 0 ? whole : whole.slice(i), { file, line: lineOf(start), from: 'frontend', anchored: anchored.test(whole), shown: shown(whole) }));
		};
		for (const c of src.matchAll(URL_CALLS)) {
			let start = c.index + c[0].length;
			while (/\s/.test(src[start] ?? '')) start++;
			take(start, true);
		}
		for (let i = src.indexOf(base); i >= 0; i = src.indexOf(base, i + 1)) {
			let start = i;
			while (start > 0 && !'\'"`\n'.includes(src[start - 1])) start--;
			if (start > 0 && src[start - 1] !== '\n') take(start - 1, false);
		}
		for (const q of src.matchAll(/['"`]\/(?=[\w{$])/g)) {
			if (seen.has(q.index)) continue;
			const whole = joined(src, q.index);
			if (whole !== null) relative.push(pathRef(`${base}${whole}`, { file, line: lineOf(q.index), from: 'frontend', anchored: false, shown: shown(whole) }));
		}
	}
	if (built) paths.push(...relative);
	return { names, paths, frontend: files.length, built };
}
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
	// One row per endpoint: the routes, then what answers on the DAV server and
	// in the capabilities.
	const endpoints = m.routes.rows.map((r) => ({
		kind: r.kind, verb: r.verb, path: r.path, name: r.name, target: `${r.class}::${r.method}`,
		attributes: r.attributes, annotations: r.annotations, openapi: r.openapi,
		requirements: r.requirements, defaults: r.defaults, source: r.source,
	})).sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb));
	for (const name of [...(m.info.named.davPlugins ?? []), ...(m.info.named.davCollections ?? [])]) {
		endpoints.push({ kind: 'DAV', verb: null, path: '/remote.php/dav', name: null, target: name, attributes: [], annotations: [], openapi: [], requirements: null, defaults: null, source: 'appinfo/info.xml' });
	}
	for (const r of registrations) {
		if (r.method !== 'registerCapability') continue;
		endpoints.push({ kind: 'capability', verb: 'GET', path: '/ocs/v2.php/cloud/capabilities', name: null, target: r.arguments[0], attributes: [], annotations: [], openapi: [], requirements: null, defaults: null, source: at(r.file, r.line) });
	}
	return {
		classes: [...m.classes.values()].map((c) => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }))
			.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
		registrations,
		infoXml: m.info.named,
		backgroundJobs: jobs.sort((a, b) => a.class.localeCompare(b.class)),
		endpoints,
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
		out.push({ id, level, ...more, places, lines: [...lines, ...sample(places, opt.details, `see ${how('--details')}`)] });
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
	ocpFindings(m, add, range);

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

	// -- Endpoints --
	const { rows, invalid, unread } = m.routes;
	const refs = references(m);
	const place = (r) => `${r.verb} ${r.path}  ${r.name}  ${r.source}`;
	const target = (r) => `${r.class}::${r.method}()`;
	if (unread.length) {
		add('routes-unreadable', 'info', [
			`${plural(unread.length, 'place states', 'places state')} routes that are no constants, so this cannot read them: the server builds them at run time. The inventory lacks them, and what depends on the full list of routes is left out: route-unreferenced, ocs-unreferenced, frontend-url-without-route, controller-method-unrouted and the operations of openapi-drift that no route provides.`,
		], unread);
	}
	const broken = [
		...invalid.map((r) => `${r.source} ${r.name}: the name is not <controller>#<method>`),
		...rows.filter((r) => r.missing).map((r) => `${place(r)}: ${r.missing === 'class' ? `no class ${r.class}` : r.missing === 'method' ? `${r.class} has no method ${r.method}()` : `${target(r)} is ${r.found.visibility}`}`),
	];
	if (broken.length) {
		add('route-target-missing', 'warn', [
			`${plural(broken.length, 'route names', 'routes name')} a controller class or a method that does not exist, or a method that is not public. A request to such a route ends in an error.`,
		], broken);
	}
	const norm = (p) => p.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
	// Two routes of one verb and path are two routes where their requirements
	// tell them apart, the way a version in the path does.
	const groups = new Map();
	for (const r of rows) {
		for (const [key, label] of [[`${r.verb} ${norm(r.path)} ${JSON.stringify(r.requirements ?? {})}`, `${r.verb} ${r.path}`], [r.name, r.name]]) {
			if (!groups.has(key)) groups.set(key, { label, set: new Set() });
			groups.get(key).set.add(r);
		}
	}
	const twice = [...groups.values()].filter((g) => g.set.size > 1).map((g) => `${g.label}: ${[...g.set].map((r) => `${r.name} at ${r.source}`).join(', ')}`);
	if (twice.length) {
		add('route-duplicate', 'warn', [
			`${plural(twice.length, 'verb and path or route name is', 'verbs and paths or route names are')} declared more than once. The server keeps one route per name and takes the first that matches a request, so the other one is never reached.`,
		], twice);
	}
	const complete = !unread.length;
	const segs = new Map(rows.map((r) => [r, pathRef(r.local).segs]));
	if (complete) {
		const called = (r) => refs.names.has(r.name) || (r.ocs && refs.names.has(r.name.slice('ocs.'.length))) || refs.paths.some((p) => matches(segs.get(r), p));
		const idle = rows.filter((r) => !r.missing && !called(r));
		const where = `a route name or a path in the PHP source and the templates${refs.frontend ? `, in ${plural(refs.frontend, 'file', 'files')} of the frontend source` : ''} and in the navigation of info.xml`;
		const plain = idle.filter((r) => !r.ocs);
		if (plain.length) {
			add('route-unreferenced', 'warn', [
				`Nothing in the app calls ${plural(plain.length, 'route', 'routes')} outside OCS. Looked for: ${where}. ${refs.built ? 'The frontend puts the path of the app and the rest of a URL together at run time, so every text there that reads like a path below the app counted as a call. ' : ''}A route stays behind when the frontend stops calling it. A route that only a client outside the app calls shows here as well.`,
			], plain.map(place));
		}
		const ocs = idle.filter((r) => r.ocs);
		if (ocs.length) {
			add('ocs-unreferenced', 'info', [
				`Nothing in the app calls ${plural(ocs.length, 'OCS route', 'OCS routes')}. OCS is there for clients outside the app, so this is no defect in itself.`,
			], ocs.map(place));
		}
		const id = m.info.id ?? '';
		const lost = refs.paths.filter((p) => p.from !== 'php' && p.anchored && p.segs[0] === 'apps' && p.segs[1] === id
			&& p.segs.length > (p.open ? 3 : 2) && !(!wild(p.segs[2]) && fs.existsSync(p.segs[2]))
			&& !rows.some((r) => matches(segs.get(r), p) || leads(segs.get(r), p)));
		if (lost.length) {
			add('frontend-url-without-route', 'warn', [
				`The frontend or a template builds ${plural(lost.length, 'URL', 'URLs')} below /apps/${id}/ that no route of the app matches. The request fails at run time.`,
			], lost.map((p) => `${at(p.file, p.line)} ${p.shown}`).sort(byPlace));
		}
		const routed = new Set(rows.filter((r) => r.found).map((r) => `${r.found.class}::${r.found.name.toLowerCase()}`));
		const unrouted = [];
		for (const c of m.classes.values()) {
			if (c.kind !== 'class') continue;
			const a = ancestry(m, c.name).all;
			if (!a.has(CONTROLLER)) continue;
			const api = [...a].filter((n) => !m.classes.has(n)).flatMap((n) => Object.keys(m.ocp[n]?.methods ?? {})).map((k) => k.toLowerCase());
			for (const [name, f] of Object.entries(c.methods)) {
				if (f.visibility !== 'public' || f.static || f.abstract || name.startsWith('__') || api.includes(name.toLowerCase())) continue;
				if (!routed.has(`${c.name}::${name.toLowerCase()}`)) unrouted.push(`${at(c.file, f.line)} ${c.name}::${name}()`);
			}
		}
		if (unrouted.length) {
			add('controller-method-unrouted', 'info', [
				`${plural(unrouted.length, 'public method of a controller is', 'public methods of controllers are')} reached by no route.`,
			], unrouted.sort(byPlace));
		}
	}

	// One place per controller method, however many routes lead to it.
	const methods = new Map(rows.filter((r) => r.found && !r.found.api).map((r) => [`${r.found.class}::${r.found.name}`, r]));
	const where = (r) => `${at(r.found.file, r.found.line)} ${r.found.class}::${r.found.name}()`;
	const csrf = rows.filter((r) => !r.ocs && STATE_CHANGING.includes(r.verb) && has(r, 'NoCSRFRequired'));
	if (csrf.length) {
		add('csrf-off-state-changing', 'warn', [
			`${plural(csrf.length, 'route', 'routes')} outside OCS that ${csrf.length === 1 ? 'changes' : 'change'} state with POST, PUT, PATCH or DELETE ${csrf.length === 1 ? 'has' : 'have'} the CSRF check switched off with NoCSRFRequired. Another site can then send the request with the session of a logged-in user.`,
		], csrf.map((r) => `${r.verb} ${r.path}  ${target(r)}`), { security: true });
	}
	const open = [...methods.values()].filter((r) => has(r, 'PublicPage') && !has(r, 'AnonRateLimit') && !has(r, 'BruteForceProtection'));
	if (open.length) {
		add('public-without-rate-limit', 'info', [
			`${plural(open.length, 'method', 'methods')} that anyone can call without logging in (PublicPage) ${open.length === 1 ? 'has' : 'have'} neither AnonRateLimit nor BruteForceProtection, so nothing limits how often.`,
		], open.map(where).sort(byPlace), { security: true });
	}
	const since = (a) => m.ocp[`${ATTRIBUTE}${a}`]?.majors?.[0] ?? null;
	const old = [];
	for (const r of methods.values()) {
		const stale = ACCESS.filter(([a, was]) => r.annotations.includes(was ?? a) && !r.attributes.includes(a) && since(a) !== null && since(a) <= lo);
		if (stale.length) old.push(`${where(r)} ${stale.map(([a, was]) => `@${was ?? a} (#[${a}] since Nextcloud ${since(a)})`).join(', ')}`);
	}
	if (old.length) {
		add('annotations-only', 'info', [
			`${plural(old.length, 'method declares', 'methods declare')} access with a docblock annotation only, where every major of ${range} has the attribute. An annotation is a comment: a typing error in it is not an error, and the method is then protected as if it had none.`,
		], old.sort(byPlace), { security: true });
	}

	const specs = fs.readdirSync('.').filter((f) => /^openapi.*\.json$/.test(f)).sort();
	const ocsRows = rows.filter((r) => r.ocs);
	if (specs.length) {
		const ops = new Map();
		for (const spec of specs) {
			for (const [p, item] of Object.entries(readJson(spec)?.paths ?? {})) {
				for (const verb of HTTP_VERBS) if (item && typeof item === 'object' && item[verb]) ops.set(`${verb.toUpperCase()} ${norm(p)}`, spec);
			}
		}
		const have = new Set(rows.map((r) => `${r.verb} ${norm(r.path)}`));
		const drift = [
			// A route for OPTIONS answers the preflight request of a browser;
			// no client calls it, and no specification lists it.
			...ocsRows.filter((r) => r.verb !== 'OPTIONS' && r.openapi.some((s) => s !== 'ignore') && !ops.has(`${r.verb} ${norm(r.path)}`))
				.map((r) => `${r.verb} ${r.path}  ${target(r)}: not in ${specs.join(', ')}`),
			...(complete ? [...ops].filter(([key]) => !have.has(key)).map(([key, spec]) => `${key}: in ${spec}, and no route provides it`) : []),
		];
		if (drift.length) {
			add('openapi-drift', 'warn', [
				`The OpenAPI specification and the routes differ in ${plural(drift.length, 'operation', 'operations')}. A client generated from the specification then calls what is not there, or lacks what is. This holds the routes against the specification and does not generate it again.`,
			], drift);
		}
	} else if (ocsRows.length) {
		add('openapi-missing', 'info', [
			`The app has ${plural(ocsRows.length, 'OCS route', 'OCS routes')} and no openapi.json. Clients of OCS are generated from such a specification, and nothing else tells them what these routes take and return.`,
		]);
	}

	migrationFindings(m, add);

	if (!out.length) out.push({ id: 'none', level: 'ok', places: [], lines: ['Nothing found in the PHP source that the checks of this audit cover.'] });
	return sortFindings(out);
}

// == The public API over the majors ==
// Every symbol of OCP and NCU the app uses, held against the majors
// data/nextcloud-ocp.json has it in and the major that deprecates it: a class
// it names, a method it calls on a receiver whose type the file states, a
// method of its own that overrides one of the API, which the server calls, and
// a class constant. A member the data does not have is left alone: __call, a
// receiver of a union type or a method of an app class can stand behind it.
// The first major of the data is no addition: the data starts there.
function ocpSymbols(m) {
	const found = [];
	const public_ = (name) => name.startsWith('OCP\\') || name.startsWith('NCU\\');
	for (const [file, f] of Object.entries(m.facts.files)) {
		if (f.error) continue;
		for (const [name, line] of Object.entries(f.refs)) {
			const c = m.ocp[name];
			if (public_(name) && c) found.push({ place: at(file, line), symbol: name, majors: c.majors, deprecated: c.deprecated });
		}
	}
	for (const c of calls(m)) {
		if (!c.on) continue;
		const r = findMethod(m, c.on, c.name);
		if (!r?.api) continue;
		const d = m.ocp[r.class];
		found.push({ place: at(c.file, c.line), symbol: `${r.class}::${r.name}()`, majors: d.methods[r.name], deprecated: d.deprecated_members?.[r.name] });
	}
	for (const c of m.classes.values()) {
		const apis = [...ancestry(m, c.name).all].filter((n) => m.ocp[n]);
		for (const [name, meth] of Object.entries(c.methods)) {
			if (name.startsWith('__')) continue;
			for (const parent of apis) {
				const r = findMethod(m, parent, name);
				if (!r?.api) continue;
				const d = m.ocp[r.class];
				found.push({ place: `${at(c.file, meth.line)} ${c.name}::${name}() overrides`, symbol: `${r.class}::${r.name}()`, majors: d.methods[r.name], deprecated: d.deprecated_members?.[r.name], override: true });
				break;
			}
		}
	}
	for (const [file, [line, cls, name]] of each(m, 'consts')) {
		if (!m.ocp[cls]) continue;
		for (const n of ancestry(m, cls).all) {
			const d = m.ocp[n];
			if (!d?.constants?.[name]) continue;
			found.push({ place: at(file, line), symbol: `${n}::${name}`, majors: d.constants[name], deprecated: d.deprecated_members?.[name] });
			break;
		}
	}
	return found;
}

function ocpFindings(m, add, range) {
	const { lo, hi } = m;
	const [first, last] = m.ocpMajors;
	const missing = [];
	const early = [];
	const soon = [];
	const deprecated = [];
	const seen = new Set();
	const note = (dep) => (dep?.[1] ? `; ${dep[1]}` : '');
	for (const s of ocpSymbols(m)) {
		const key = `${s.place.split(' ')[0]} ${s.symbol}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const [a, b] = s.majors;
		if (b < hi) {
			missing.push(`${s.place} ${s.symbol}: Nextcloud ${b} is the last major to have it, the app declares up to ${hi}${note(s.deprecated)}`);
		} else if (a > lo && a > first && !s.override) {
			early.push(`${s.place} ${s.symbol}: there since Nextcloud ${a}, the app declares from ${lo}`);
		} else if (s.deprecated && b < last) {
			soon.push(`${s.place} ${s.symbol}: deprecated since Nextcloud ${s.deprecated[0]}, Nextcloud ${b} is the last major to have it${note(s.deprecated)}`);
		} else if (s.deprecated && s.deprecated[0] <= hi && !s.override) {
			deprecated.push(`${s.place} ${s.symbol}: deprecated since Nextcloud ${s.deprecated[0]}${note(s.deprecated)}`);
		}
	}
	const files = (list) => plural(new Set(list.map((p) => p.split(':')[0])).size, 'file', 'files');
	if (missing.length) {
		add('ocp-missing', 'warn', [
			`${plural(missing.length, 'use', 'uses')} in ${files(missing)} of the public API that a major of ${range} no longer has. The app fails there where it comes to that line, or the server no longer calls the method it overrides.`,
		], missing.sort(byPlace));
	}
	if (early.length) {
		add('ocp-since-above-min', 'warn', [
			`${plural(early.length, 'use', 'uses')} in ${files(early)} of the public API that the oldest majors of ${range} do not have yet. Either min-version in appinfo/info.xml goes up, or the app does without it there.`,
		], early.sort(byPlace));
	}
	if (soon.length) {
		add('ocp-removed-soon', 'warn', [
			`${plural(soon.length, 'use', 'uses')} in ${files(soon)} of the public API that is deprecated and that Nextcloud ${last} no longer has: the app fails on the first major without it, once it declares that one.`,
		], soon.sort(byPlace));
	}
	if (deprecated.length) {
		add('ocp-deprecated', 'info', [
			`${plural(deprecated.length, 'use', 'uses')} in ${files(deprecated)} of the public API that is deprecated in ${range}. The text of the tag names the replacement where it has one.`,
		], deprecated.sort(byPlace));
	}
}

// == Migrations ==
// What OC\DB\MigrationService checks in the schema a migration leaves before the
// server applies it. The checks of each major, the table prefix, the values of
// the type constants and the NotNull default of a column are
// data/nextcloud-server.json. The schema is built here from the calls in
// changeSchema(), one migration after the other in the order of the server; as
// there, a step is held against the schema before it, and only what it adds or
// changes is checked. The names have to be unique in the schema of an install.
const MIGRATION_FILE = /^lib\/Migration\/(?:.+\/)?(Version[^/]{1,255})\.php$/i;
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// MigrationService::sortMigrations().
function migrationOrder(a, b) {
	const x = /(\d+)Date(\d+)/.exec(a.base);
	const y = /(\d+)Date(\d+)/.exec(b.base);
	if (x && y) return Number(x[1]) - Number(y[1]) || natural(x[2], y[2]);
	return natural(a.base, b.base);
}

function migrationSchema(m) {
	const d = m.migrations;
	const steps = [];
	for (const [file, f] of Object.entries(m.facts.files)) {
		const hit = MIGRATION_FILE.exec(file);
		if (hit && !f.error) steps.push({ file, base: hit[1], calls: f.migrations ?? [], classes: f.classes.map((c) => c.name) });
	}
	steps.sort(migrationOrder);
	const typeOf = (v) => (typeof v === 'string' ? v : (typeof v?.$const === 'string' ? d.types[v.$const] ?? null : null));
	const options = (col, o) => {
		if (!o || typeof o !== 'object' || Array.isArray(o)) return;
		if ('notnull' in o) col.notnull = typeof o.notnull === 'boolean' ? o.notnull : null;
		if ('default' in o) col.default = o.default;
		if ('length' in o) col.length = typeof o.length === 'number' ? o.length : null;
		if ('type' in o) col.type = typeOf(o.type);
	};
	const fresh = () => ({ columns: new Map(), indexes: new Map(), fks: new Map(), primary: null });
	const tables = new Map();
	const events = [];
	const unknown = [];
	for (const step of steps) {
		const ev = (kind, line, more) => events.push({ kind, place: at(step.file, line), ...more });
		const version = step.base.slice(7);
		if (version === '0') ev('reserved', 1, {});
		if (!step.classes.includes(`${m.namespace}\\Migration\\${step.base}`)) ev('class', 1, { expected: `${m.namespace}\\Migration\\${step.base}` });
		const before = new Map([...tables].map(([t, s]) => [t, {
			columns: new Map([...s.columns].map(([c, col]) => [c, col.length])),
			indexes: new Set(s.indexes.keys()), fks: new Set(s.fks.keys()), primary: s.primary !== null,
		}]));
		for (const [line, table, , method, args, column] of step.calls) {
			if (typeof table !== 'string') { unknown.push(`${at(step.file, line)} ${method}() on a table whose name is no constant`); continue; }
			if (method === 'createTable') {
				tables.set(table, fresh());
				if (!before.has(table)) ev('table', line, { table });
				continue;
			}
			if (method === 'dropTable') { tables.delete(table); continue; }
			if (!tables.has(table)) {
				// A table of another app or of the server: it exists before the step.
				tables.set(table, fresh());
				before.set(table, { columns: new Map(), indexes: new Set(), fks: new Set(), primary: true });
			}
			const s = tables.get(table);
			const was = before.get(table);
			if (column !== null) {
				const col = typeof column === 'string' ? s.columns.get(column) : undefined;
				if (!col) continue;
				if (method === 'setNotnull') col.notnull = typeof args[0] === 'boolean' ? args[0] : null;
				else if (method === 'setDefault') col.default = args[0];
				else if (method === 'setLength') col.length = typeof args[0] === 'number' ? args[0] : null;
				else if (method === 'setType') col.type = null;
				else if (method === 'setOptions') options(col, args[0]);
				continue;
			}
			const name = args[0];
			switch (method) {
			case 'addColumn': {
				if (typeof name !== 'string') { unknown.push(`${at(step.file, line)} a column of ${table} whose name is no constant`); break; }
				const col = { line, type: typeOf(args[1]), notnull: d.column_notnull, default: null, length: null };
				options(col, args[2]);
				s.columns.set(name, col);
				if (!was?.columns.has(name)) ev('name', line, { what: `column ${table}.${name}`, name });
				break;
			}
			case 'changeColumn':
			case 'modifyColumn':
				if (typeof name === 'string' && s.columns.has(name)) options(s.columns.get(name), args[1]);
				break;
			case 'dropColumn':
				s.columns.delete(name);
				break;
			case 'addIndex':
			case 'addUniqueIndex':
			case 'addUniqueConstraint':
				// An index without a name gets one from Doctrine, which is not checked here.
				if (typeof args[1] === 'string') {
					s.indexes.set(args[1], at(step.file, line));
					if (!was?.indexes.has(args[1])) ev('name', line, { what: `index ${args[1]} of ${table}`, name: args[1] });
				}
				break;
			case 'dropIndex':
				s.indexes.delete(name);
				break;
			case 'renameIndex':
				if (typeof args[1] === 'string') {
					s.indexes.delete(name);
					s.indexes.set(args[1], at(step.file, line));
					if (!was?.indexes.has(args[1])) ev('name', line, { what: `index ${args[1]} of ${table}`, name: args[1] });
				}
				break;
			case 'addForeignKeyConstraint':
				if (typeof args[4] === 'string') {
					s.fks.set(args[4], at(step.file, line));
					if (!was?.fks.has(args[4])) ev('name', line, { what: `foreign key ${args[4]} of ${table}`, name: args[4] });
				}
				break;
			case 'setPrimaryKey':
				s.primary = typeof args[1] === 'string' ? args[1] : 'primary';
				s.primaryAt = at(step.file, line);
				if (!was?.primary) {
					if (s.primary === 'primary') ev('primary', line, { table });
					else ev('name', line, { what: `primary key ${s.primary} of ${table}`, name: s.primary });
				}
				break;
			case 'dropPrimaryKey':
				s.primary = null;
				break;
			default:
			}
		}
		const bool = d.types['OCP\\DB\\Types::BOOLEAN'];
		const string = d.types['OCP\\DB\\Types::STRING'];
		for (const [table, s] of tables) {
			const was = before.get(table);
			for (const [name, col] of s.columns) {
				const place = { place: at(step.file, col.line) };
				if (!was?.columns.has(name)) {
					if (col.notnull === true && col.type === null) unknown.push(`${place.place} the type of ${table}.${name}, which is no constant`);
					if (col.notnull === true && col.type === bool) events.push({ kind: 'bool', ...place, what: `${table}.${name}` });
					if (was && col.notnull === true && col.default === '') events.push({ kind: 'empty', ...place, what: `${table}.${name}` });
					if (col.type === string && col.length !== null) events.push({ kind: 'string', ...place, what: `${table}.${name}`, length: col.length });
				} else if (col.type === string && col.length !== null && col.length !== was.columns.get(name)) {
					events.push({ kind: 'string', ...place, what: `${table}.${name}`, length: col.length });
				}
			}
		}
	}
	// The constraint names of the schema of an install, the way
	// MigrationService::ensureUniqueNamesConstraints() collects them.
	const owners = new Map();
	for (const [table, s] of tables) {
		const names = [...s.indexes, ...s.fks, ...(s.primary && s.primary.toLowerCase() !== 'primary' ? [[s.primary.toLowerCase(), s.primaryAt]] : [])];
		for (const [name, place] of names) {
			if (owners.has(name)) events.push({ kind: 'collision', place, what: `${name} of ${table}, also on ${owners.get(name)}` });
			else owners.set(name, table);
		}
	}
	return { steps, events, unknown };
}

function migrationFindings(m, add) {
	const d = m.migrations;
	if (!d) return;
	const { steps, events, unknown } = migrationSchema(m);
	if (!steps.length) return;
	const p = d.table_prefix.length;
	const majors = [];
	for (let major = m.lo; major <= m.hi; major++) majors.push(major);
	const unchecked = majors.filter((major) => !d.rules[String(major)]);
	// The server holds an app against Oracle when info.xml lists no database or lists it.
	const oracle = (r) => !m.info.databases.length || m.info.databases.includes(r.oracle);
	const fails = (e) => majors.filter((major) => {
		const r = d.rules[String(major)];
		if (!r) return false;
		const named = !r.oracle_only || oracle(r);
		switch (e.kind) {
		case 'table': return named && e.table.length + r.table.prefixes * p > r.table.max;
		case 'primary': return named && e.table.length + r.primary.prefixes * p > r.primary.max;
		case 'name': return named && e.name.length > r.name;
		case 'bool': return r.bool_notnull && oracle(r);
		case 'empty': return oracle(r);
		case 'string': return r.string_length !== null && oracle(r) && e.length > r.string_length;
		case 'collision': return r.unique_names;
		default: return true;
		}
	});
	const listed = (kinds, text) => events.filter((e) => kinds.includes(e.kind)).map((e) => ({ e, majors: fails(e) }))
		.filter((x) => x.majors.length).map((x) => `${x.e.place} ${text(x.e)}, in Nextcloud ${span(x.majors)}`);
	const gated = 'Up to Nextcloud 32 the server checks this only where info.xml lists no database, or lists oci among them.';

	const names = listed(['table', 'primary', 'name'], (e) => (e.kind === 'table' ? `table ${e.table}: ${e.table.length} characters and the prefix ${d.table_prefix}`
		: e.kind === 'primary' ? `the primary key of ${e.table}, named after the table: ${e.table.length} characters and the prefix ${d.table_prefix}`
			: `${e.what}: ${e.name.length} characters`));
	if (names.length) {
		add('migration-name-length', 'warn', [
			`${plural(names.length, 'name', 'names')} in the migrations ${names.length === 1 ? 'is' : 'are'} longer than the server allows, so it stops the install or the update of the app with an exception. The table names are counted with the default prefix ${d.table_prefix}.`,
			`  ${gated}`,
		], names.sort(byPlace));
	}
	const bools = listed(['bool'], (e) => e.what);
	if (bools.length) {
		add('migration-bool-notnull', 'warn', [
			`${plural(bools.length, 'boolean column is', 'boolean columns are')} NotNull. Oracle cannot store false in such a column, so the server stops the migration with an exception. A boolean column needs notnull false.`,
			`  ${gated} From Nextcloud 33 on the server makes the column nullable on Oracle itself.`,
		], bools.sort(byPlace));
	}
	const empty = listed(['empty'], (e) => e.what);
	if (empty.length) {
		add('migration-notnull-empty-default', 'warn', [
			`${plural(empty.length, 'column added', 'columns added')} to an existing table ${empty.length === 1 ? 'is' : 'are'} NotNull with '' as the default. Oracle stores '' as null, so the server stops the update with an exception.`,
			`  The server checks this only where info.xml lists no database, or lists oci among them.`,
		], empty.sort(byPlace));
	}
	const strings = listed(['string'], (e) => `${e.what}: length ${num(e.length)}`);
	if (strings.length) {
		add('migration-string-length', 'warn', [
			`${plural(strings.length, 'string column is', 'string columns are')} longer than the server allows for the type string, so it stops the migration with an exception. A longer text needs the type text.`,
			`  The server checks this only where info.xml lists no database, or lists oci among them.`,
		], strings.sort(byPlace));
	}
	const collisions = listed(['collision'], (e) => e.what);
	if (collisions.length) {
		add('migration-name-collision', 'warn', [
			`${plural(collisions.length, 'index or constraint name is', 'index or constraint names are')} used on two tables. PostgreSQL keeps these names in one namespace per schema, so the server stops the install of the app with an exception, and logs the collision on an update.`,
		], collisions);
	}
	const classes = events.filter((e) => e.kind === 'class' || e.kind === 'reserved')
		.map((e) => (e.kind === 'class' ? `${e.place} has no class ${e.expected}` : `${e.place} is version 0, which the server reserves`));
	if (classes.length) {
		add('migration-class-name', 'warn', [
			`The server loads a migration in lib/Migration/ as the class ${m.namespace}\\Migration\\<file name>, and refuses version 0. ${plural(classes.length, 'file does', 'files do')} not fit that, and the migrations of the app do not run.`,
		], classes.sort(byPlace));
	}
	if (unknown.length || unchecked.length) {
		add('migration-not-checked', 'info', [
			...(unchecked.length ? [`ncmake has no checks of MigrationService for Nextcloud ${span(unchecked)}; the migrations are not held against ${unchecked.length === 1 ? 'it' : 'them'}.`] : []),
			...(unknown.length ? ['Part of the migrations could not be held against the checks of the server, since a name or a type there is no constant.'] : []),
		], unknown.sort(byPlace));
	}
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
	p('ENDPOINTS');
	if (inv.endpoints.length) {
		const prefix = `${r.app.namespace}\\Controller\\`;
		const cell = (e) => [e.verb ?? '', e.path, e.kind, e.target?.startsWith(prefix) ? e.target.slice(prefix.length) : e.target ?? '',
			[...e.attributes, ...e.annotations.map((a) => `@${a}`), ...e.openapi.filter((s) => s !== 'default').map((s) => `openapi:${s}`)].join(' ')];
		for (const l of table(['verb', 'path', 'kind', 'target', 'access'], inv.endpoints.map(cell), ['l', 'l', 'l', 'l', 'l']).split('\n')) p(`  ${l}`);
	} else {
		p('  The app brings no route, no DAV plugin and no capability.');
	}
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p(`nikic/php-parser${r.parser ? ` ${r.parser}` : ''} on PHP ${r.php} read the source; what the server has in which`);
	p(`major comes from ${r.data.ocp} and ${r.data.third} of ncmake, read`);
	p(`${r.data.read}. A class is judged by what it extends only where all of that is`);
	p('a class of the app, of OCP or of PHP. An endpoint is a route as the server');
	p(`builds it (${r.data.server}); whether it answers is not asked here.`);
	p('The inventory is in the JSON.');
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
