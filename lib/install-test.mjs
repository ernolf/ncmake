#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// install-test - does the packaged app install and run on the servers it declares.
//
// make install-test starts an installed Nextcloud server per major it checks,
// the image ghcr.io/ernolf/ncmake-server:<tag>, and lib/install-test.sh leaves
// what happened there under build/install-test/<tag>:
//   php             the PHP the server ran on
//   status.json     occ status, with the version of the server
//   enable.txt      the output of occ app:enable, enable.rc its exit code
//   requests        one line per request: name, HTTP status, path
//   cron.txt        the output of cron.php, cron.rc its exit code
//   apps.json       occ app:list after the run
//   nextcloud.log   the log of the server after the run
//   apache.log      what the web server and PHP wrote to stderr
//   stopped         the step a run did not get past
//   failed          the exit code of a container that did not finish
// build/install-test/range names the majors the app declares, the ones a server
// image exists for and the tags that ran. This reads those files together with
// appinfo/info.xml and turns them into findings. It runs nothing and reads no
// network, and has no npm dependency. Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';

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
	dir: '.',        // the app checkout; build/install-test is read inside it
	details: false,  // every log entry behind a finding instead of the first few
	json: false,
	jsonFile: null,
};
const SAMPLE = 3;    // log entries and output lines named per finding without --details
const LOG_LEVEL = 3; // the lowest level of nextcloud.log that counts: 3 error, 4 fatal
const LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'];

// == Command line ==
function usage() {
	return `install-test - does the packaged app install and run on the servers it declares

Usage: install-test.mjs [options] [dir]

  dir                   the app checkout (default: ${defaults.dir}); make install-test
                        must have run in it, which leaves its runs in
                        build/install-test

Options:
  --details             every log entry behind a finding, not the first ${SAMPLE}
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The exit code is 0 when nothing is worth changing, 1 when at least one finding
is, and 2 when the run itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`install-test: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	for (const arg of argv) {
		switch (arg) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--json': opt.json = true; break;
			case '--details': opt.details = true; break;
			default:
				if (arg.startsWith('--json-file=')) { opt.jsonFile = arg.slice('--json-file='.length); break; }
				if (arg.startsWith('-')) die(`unknown option: ${arg}`);
				if (dir !== null) die(`only one directory can be checked: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (opt.jsonFile === '') die('--json-file needs a file');
	return opt;
}

// == Reading ==
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const readJson = (file) => {
	try { return JSON.parse(read(file)); } catch { return null; }
};
const lines = (text) => (text ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);

function readApp(root) {
	const xml = read(path.join(root, 'appinfo/info.xml'));
	if (xml === null) return null;
	const tag = (name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1] || null;
	return { id: tag('id'), version: tag('version') };
}

// key=value lines, as the recipe writes them.
function readRange(file) {
	const text = read(file);
	if (text === null) return null;
	const range = {};
	for (const l of lines(text)) {
		const i = l.indexOf('=');
		if (i > 0) range[l.slice(0, i)] = l.slice(i + 1);
	}
	return range;
}

// An entry names the app when the server logged it for the app, or when a path
// in its message, its exception or its trace lies in the directory of the app.
function namesApp(entry, raw, id) {
	if (!id) return false;
	if (entry.app === id) return true;
	return raw.includes(`custom_apps\\/${id}\\/`) || raw.includes(`custom_apps/${id}/`);
}

// The message of an entry in one line: that of the exception when there is one.
function messageOf(entry) {
	const ex = entry.exception;
	const text = ex && typeof ex === 'object'
		? `${ex.Exception ?? 'Exception'}: ${ex.Message ?? ''}${ex.File ? ` in ${ex.File}${ex.Line ? `:${ex.Line}` : ''}` : ''}`
		: String(entry.message ?? '');
	return text.replace(/\s+/g, ' ').trim();
}

function readLog(file, id) {
	const text = read(file);
	if (text === null) return null;
	const entries = [];
	let unread = 0;
	for (const raw of lines(text)) {
		let entry;
		try { entry = JSON.parse(raw); } catch { unread++; continue; }
		if (typeof entry?.level !== 'number' || entry.level < LOG_LEVEL) continue;
		entries.push({
			level: entry.level,
			app: entry.app ?? null,
			url: entry.url ?? null,
			message: messageOf(entry),
			namesApp: namesApp(entry, raw, id),
		});
	}
	return { entries, unread };
}

function readRun(dir, tag, id) {
	const status = readJson(path.join(dir, 'status.json'));
	const rc = (name) => {
		const v = read(path.join(dir, name));
		return v === null ? null : Number(v.trim());
	};
	const requests = lines(read(path.join(dir, 'requests'))).map((l) => {
		const [name, code, ...rest] = l.split(' ');
		return { name, status: Number(code), path: rest.join(' ') };
	});
	const apps = readJson(path.join(dir, 'apps.json'));
	return {
		tag,
		server: status?.versionstring ?? null,
		php: read(path.join(dir, 'php'))?.trim() || null,
		failed: rc('failed'),
		stopped: read(path.join(dir, 'stopped'))?.trim() || null,
		enable: { rc: rc('enable.rc'), output: lines(read(path.join(dir, 'enable.txt'))) },
		enabled: apps && id ? Object.hasOwn(apps.enabled ?? {}, id) : null,
		requests,
		cron: { rc: rc('cron.rc'), output: lines(read(path.join(dir, 'cron.txt'))) },
		log: readLog(path.join(dir, 'nextcloud.log'), id),
	};
}

function check(opt) {
	const root = opt.dir;
	const base = path.join(root, 'build/install-test');
	const range = readRange(path.join(base, 'range'));
	if (range === null) die(`${path.join(base, 'range')} is missing: make install-test has to run first`);
	const app = readApp(root);
	const tags = (range.tags ?? '').split(' ').filter(Boolean);
	return {
		root,
		app,
		range,
		runs: tags.map((tag) => readRun(path.join(base, tag), tag, app?.id)),
	};
}

// == Findings ==
function sample(list, details, hint) {
	if (details || list.length <= SAMPLE) return list.map((l) => `  ${l}`);
	return [...list.slice(0, SAMPLE).map((l) => `  ${l}`), `  ... and ${list.length - SAMPLE} more, ${hint}`];
}

const nameOf = (run) => `Nextcloud ${run.server ?? run.tag}${run.php ? ` on PHP ${run.php}` : ''}`;
const entryLine = (e) => `${LEVELS[e.level] ?? `level ${e.level}`}${e.app ? ` (${e.app})` : ''}: ${e.message}`;

function findings(r, opt) {
	const list = [];
	const add = (level, id, text, extra = {}) => list.push({ level, id, lines: text, ...extra });
	const how = howToRun('INSTALL_TEST_CMDLINE', 'install-test.mjs %s');
	const more = `see ${how('--details')}`;
	const { range } = r;

	if (!r.runs.length) {
		const declared = `${range.min || 'no min-version'} to ${range.max || 'no max-version'}`;
		add('info', 'install-no-server', [
			`No server image for a Nextcloud major the app declares (${declared}): images exist for`
			+ ` ${range.first} to ${range.master}, the maintained majors and master. Nothing was installed.`,
		]);
		return list;
	}
	if (range.min && range.first && Number(range.min) < Number(range.first)) {
		add('info', 'install-below-images', [
			`The app declares Nextcloud ${range.min} as its lowest server, and the lowest server image is ${range.first}:`
			+ ' the end-of-life majors below it are not installed.',
		]);
	}

	for (const run of r.runs) {
		const name = nameOf(run);
		const at = { tag: run.tag };
		if (run.failed !== null && run.enable.rc === null && !run.stopped) {
			add('warn', 'install-not-run', [
				`Nextcloud ${run.tag}: the server did not run (exit code ${run.failed}).`,
				'  The image could not be pulled or the container did not start; the lines above the report say which.',
			], at);
			continue;
		}
		if (run.stopped) {
			add('warn', 'install-stopped', [
				run.stopped === 'copy'
					? `${name}: the staged app could not be copied into custom_apps.`
					: `${name}: the web server did not answer, so no request was sent.`,
				`  What it wrote is in build/install-test/${run.tag}.`,
			], at);
			if (run.stopped === 'copy') continue;
		}
		let bad = false;
		if (run.enable.rc !== 0) {
			bad = true;
			add('warn', 'install-enable-failed', [
				`${name}: occ app:enable fails${run.enable.rc === null ? '' : ` with exit code ${run.enable.rc}`}.`,
				...sample(run.enable.output, opt.details, more),
			], at);
		} else if (run.enabled === false) {
			bad = true;
			add('warn', 'install-not-enabled', [
				`${name}: occ app:enable ends with 0, and the app is not among the enabled apps afterwards.`,
				...sample(run.enable.output, opt.details, more),
			], at);
		}
		const broken = run.requests.filter((q) => q.status >= 500 || q.status === 0);
		if (broken.length) {
			bad = true;
			add('warn', 'install-request-failed', [
				`${name}: ${plural(broken.length, 'request is', 'requests are')} answered with a server error once the app is enabled.`,
				...broken.map((q) => `  ${q.status || 'no answer'}  ${q.path}`),
			], at);
		}
		if (run.cron.rc !== null && run.cron.rc !== 0) {
			bad = true;
			add('warn', 'install-cron-failed', [
				`${name}: cron.php ends with exit code ${run.cron.rc} once the app is enabled.`,
				...sample(run.cron.output, opt.details, more),
			], at);
		}
		const own = run.log?.entries.filter((e) => e.namesApp) ?? [];
		const other = run.log?.entries.filter((e) => !e.namesApp) ?? [];
		if (own.length) {
			bad = true;
			add('warn', 'install-log-errors', [
				`${name}: the server logs ${plural(own.length, 'entry', 'entries')} of level ${LOG_LEVEL} or higher that`
				+ ` ${own.length === 1 ? 'names' : 'name'} the app.`,
				...sample([...new Set(own.map(entryLine))], opt.details, more),
			], at);
		}
		if (other.length) {
			add('info', 'install-log-other', [
				`${name}: the server logs ${plural(other.length, 'entry', 'entries')} of level ${LOG_LEVEL} or higher that`
				+ ` ${other.length === 1 ? 'does' : 'do'} not name the app. The server alone logs none on these requests.`,
				...sample([...new Set(other.map(entryLine))], opt.details, more),
			], at);
		}
		if (!bad && !run.stopped) {
			add('ok', 'install', [
				`${name}: the app is enabled, ${plural(run.requests.length, 'request', 'requests')} and cron.php ran`
				+ ` without a server error, and the log has no entry of level ${LOG_LEVEL} or higher that names the app.`,
			], at);
		}
	}
	return sortFindings(list);
}

// == Human-readable output ==
function render(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const how = howToRun('INSTALL_TEST_CMDLINE', 'install-test.mjs %s');
	const { app } = r;
	p(`install-test  ${path.resolve(r.root)}`);
	p(`  ${app ? `${app.id ?? 'no app id'}${app.version ? ` ${app.version}` : ''}` : 'no appinfo/info.xml'}, `
		+ `installed on ${r.runs.length ? r.runs.map((x) => `Nextcloud ${x.server ?? x.tag}`).join(', ') : 'no server'}.`);
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('Each server is the image ncmake-server of that major, a release tarball');
	p('installed on SQLite, on the newest PHP the major runs on. The staged app');
	p('was copied into custom_apps and enabled; then came requests to the login');
	p('page, the dashboard, the files app, the settings, the app itself, OCS and');
	p('WebDAV, and cron.php. What each run left is in build/install-test.');
	p();
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = check(opt);
report.findings = findings(report, opt);
const json = opt.json || opt.jsonFile ? toJson(report, die) : null;
if (opt.json) {
	process.stdout.write(json);
} else {
	process.stdout.write(`${render(report)}\n`);
}
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
process.exitCode = report.findings.some((f) => f.level === 'warn') ? 1 : 0;
