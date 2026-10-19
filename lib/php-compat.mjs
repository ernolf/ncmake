#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// php-compat - does the app run on the PHP versions its servers run it on.
//
// make php-compat runs the checkout in the build image of each PHP minor it
// checks and leaves the output of every run under build/php-compat/<minor>:
//   version         the PHP the run actually ran on
//   platform.json   composer check-platform-reqs --no-dev --format=json, run
//                   when vendor/ or composer.lock gives it packages to check
//   platform.rc     its exit code, platform.err its error output
//   lint.txt        what php -l reported for the PHP files that ship
//   failed          the exit code of a run that did not finish
// build/php-compat/range names the floor, the ceiling and where the ceiling came
// from, and the ceiling of master, beyond which <php max-version> does not raise
// it. A run on the PHP ahead of master leaves the same files in
// build/php-compat/next, and range names its image tag as next. This reads those
// files together with appinfo/info.xml and the installed packages, and turns them
// into findings. It runs nothing and reads no network, and has no npm dependency.
// Node 18 or newer.

import fs from 'node:fs';
import path from 'node:path';

import {
	LEGEND,
	howToRun,
	num,
	plural,
	renderFindings,
	sortFindings,
	writeJsonFile,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',        // the app checkout; build/php-compat is read inside it
	details: false,  // every file behind a finding instead of the first few
	json: false,
	jsonFile: null,
};
const SAMPLE = 3;    // files named per finding without --details
// The directories php -l covers, as make php-compat passes them.
const LINTED = ['appinfo', 'lib', 'templates', 'vendor'];

// == Command line ==
function usage() {
	return `php-compat - does the app run on the PHP versions its servers run it on

Usage: php-compat.mjs [options] [dir]

  dir                   the app checkout (default: ${defaults.dir}); make php-compat
                        must have run in it, which leaves its runs in
                        build/php-compat

Options:
  --details             every file behind a finding, not the first ${SAMPLE}
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The exit code is 0 when nothing is worth changing, 1 when at least one finding
is, and 2 when the run itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`php-compat: ${msg}\n`);
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
const cmpVersion = (a, b) => {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
};
const minorOf = (v) => v.split('.').slice(0, 2).join('.');
// PHP names a build before its release by its stage, as in 8.6.0alpha1 or 8.6.0RC3.
const preRelease = (v) => /\d(?:alpha|beta|RC)\d*$/i.test(v);
const NEXT_IMAGE = 'ghcr.io/ernolf/ncmake-php';

// info.xml is read textually, as the other analysers do.
function readInfo(root) {
	const xml = read(path.join(root, 'appinfo', 'info.xml'))?.replace(/<!--[\s\S]*?-->/g, '');
	if (!xml) return null;
	const tag = (name) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? null;
	const attr = (name, a) => xml.match(new RegExp(`<${name}\\s[^>]*\\b${a}="([^"]*)"`))?.[1] ?? null;
	return {
		id: tag('id'),
		version: tag('version'),
		phpMax: attr('php', 'max-version'),
		ncMax: attr('nextcloud', 'max-version'),
	};
}

// The package a file under vendor/ belongs to, and the packages make build leaves
// out. Composer 2 lists those as dev-package-names in vendor/composer/installed.json.
function readVendor(root) {
	const installed = readJson(path.join(root, 'vendor', 'composer', 'installed.json'));
	return {
		present: fs.existsSync(path.join(root, 'vendor')),
		dev: new Set(installed?.['dev-package-names'] ?? []),
	};
}
const packageOf = (file) => {
	const m = file.replace(/^\.\//, '').match(/^vendor\/([^/]+\/[^/]+)\//);
	return m ? m[1] : null;
};

// Whether composer.json requires anything that composer installs into vendor/.
function needsVendor(root) {
	const json = readJson(path.join(root, 'composer.json'));
	return Object.keys(json?.require ?? {}).some((k) => k !== 'php' && !/^(ext|lib|php)-/.test(k));
}

function countPhp(root) {
	let n = 0;
	const walk = (dir) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.isDirectory()) walk(path.join(dir, e.name));
			else if (e.isFile() && e.name.endsWith('.php')) n++;
		}
	};
	for (const d of LINTED) walk(path.join(root, d));
	return n;
}

// php -l reports a message in the form "<Kind>: <text> in <file> on line <n>"; the
// "Errors parsing <file>" that follows a parse error says nothing more.
const LINT_LINE = /^(?:PHP )?(Parse error|Fatal error|Warning|Deprecated|Notice)(?: \([^)]*\))?:\s+(.*) in (\S.*?) on line (\d+)$/;

function readRun(root, minor) {
	const dir = path.join(root, 'build', 'php-compat', minor);
	const run = { minor, dir: minor, version: read(path.join(dir, 'version'))?.trim() || null, failed: read(path.join(dir, 'failed'))?.trim() || null };
	const rc = read(path.join(dir, 'platform.rc'));
	run.platform = rc === null ? null : {
		rc: Number(rc.trim()),
		reqs: readJson(path.join(dir, 'platform.json')),
		err: (read(path.join(dir, 'platform.err')) ?? '').trim(),
	};
	const lint = read(path.join(dir, 'lint.txt'));
	run.linted = lint !== null;
	run.lint = [];
	run.unparsed = [];
	for (const line of (lint ?? '').split('\n')) {
		if (!line.trim() || line.startsWith('Errors parsing ')) continue;
		const m = line.match(LINT_LINE);
		if (m) run.lint.push({ kind: m[1], message: m[2], file: m[3].replace(/^\.\//, ''), line: Number(m[4]) });
		else run.unparsed.push(line);
	}
	return run;
}

function check(opt) {
	const root = opt.dir;
	const base = path.join(root, 'build', 'php-compat');
	if (!fs.existsSync(base)) die(`no ${path.join('build', 'php-compat')} in ${root} - make php-compat writes it`);
	const range = Object.fromEntries((read(path.join(base, 'range')) ?? '').split('\n')
		.map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
	const minors = fs.readdirSync(base, { withFileTypes: true })
		.filter((d) => d.isDirectory() && /^\d+\.\d+$/.test(d.name)).map((d) => d.name).sort(cmpVersion);
	// The run ahead of master is named after the PHP it ran on, which only it knows.
	let next = null;
	if (range.next && fs.existsSync(path.join(base, 'next'))) {
		next = readRun(root, 'next');
		next.image = `${NEXT_IMAGE}:${range.next}`;
		next.minor = next.version ?? next.image;
	}
	return {
		root,
		app: readInfo(root),
		range,
		vendor: readVendor(root),
		needsVendor: needsVendor(root),
		composer: fs.existsSync(path.join(root, 'composer.json')),
		composerName: readJson(path.join(root, 'composer.json'))?.name ?? null,
		lock: fs.existsSync(path.join(root, 'composer.lock')),
		files: countPhp(root),
		runs: minors.map((m) => readRun(root, m)),
		next,
		findings: [],
	};
}

// composer prints an exception as a framed message between its class name and the
// trace, after a line that names where it came from; the message is what explains it.
function errorMessage(err) {
	const lines = err.split('\n').map((l) => l.trim());
	const at = lines.findIndex((l) => /^\[[\w\\]+\]$/.test(l));
	const end = lines.findIndex((l, i) => i > at && l === 'Exception trace:');
	const message = at < 0 ? [] : lines.slice(at + 1, end < 0 ? undefined : end).filter(Boolean);
	return message.length ? message : lines.filter(Boolean).slice(-3);
}

// == Findings ==
const listMinors = (set) => [...set].sort(cmpVersion).join(', ');

function sample(items, details, more) {
	const shown = details ? items : items.slice(0, SAMPLE);
	const lines = shown.map((s) => `  ${s}`);
	if (shown.length < items.length) lines.push(`  ... ${num(items.length - shown.length)} more, ${more}`);
	return lines;
}

function findings(r, opt) {
	const out = [];
	const add = (level, id, lines) => out.push({ level, id, lines });
	const how = howToRun('PHP_COMPAT_CMDLINE', 'php-compat.mjs %s');
	const { floor, ceiling, server, declared, master, nextcloud } = r.range;
	const nc = nextcloud ? `Nextcloud ${nextcloud}` : 'Nextcloud master';
	const nx = r.next;

	// -- the declared PHP range against the server's --
	if (declared && server && cmpVersion(declared, server) < 0) {
		add('warn', 'php-max-below-server', [
			`<php max-version="${r.app?.phpMax ?? declared}"> in appinfo/info.xml is below PHP ${server}, the newest PHP ${nc} runs on.`,
			`  A server on PHP ${server} refuses to enable the app: Nextcloud holds <php max-version> against the PHP it runs on.`
			+ ` Raise it to ${server}, or remove it and let the server range decide.`,
		]);
	}
	if (declared && master && cmpVersion(declared, master) > 0) {
		let what = `php-compat checked up to ${master}.`;
		if (nx?.version) {
			what = preRelease(nx.version)
				? `PHP ${declared} has no release yet: php-compat ran its newest build, ${nx.version}, apart from the range.`
				: `PHP ${nx.version} is released, and php-compat ran it apart from the range.`;
		} else if (nx) {
			what = `${nx.image} could not be run: ncmake publishes it once PHP ${declared} has a release, an alpha, a beta or an RC.`;
		}
		add('warn', 'php-max-above-master', [
			`<php max-version="${r.app?.phpMax ?? declared}"> in appinfo/info.xml is above PHP ${master}, the newest PHP`
			+ ' Nextcloud master runs on, so no server has run the app on it.',
			'  Once a server allows a newer PHP, it enables the app there although nobody has checked the app on that PHP.'
			+ ` Lower it to ${master}, and raise it once the app is tested on the newer PHP. ${what}`,
		]);
	}

	// -- each run --
	runFindings(r, r.runs, add, opt, how);

	// -- the PHP ahead of master --
	// What its run finds is for preparing the app, so nothing of it is marked [!].
	const ahead = (level, id, lines) => add(level === 'warn' ? 'info' : level, id.replace(/^php-/, 'php-next-'), lines);
	if (nx?.version && master && cmpVersion(minorOf(nx.version), master) <= 0) {
		add('info', 'php-next-none', [
			`${nx.image} carries PHP ${nx.version}, which Nextcloud master runs on already, so no PHP ahead of master is published.`,
			'  Its run is left out of the findings.',
		]);
	} else if (nx) {
		const before = out.length;
		runFindings(r, [nx], ahead, opt, how);
		if (nx.version) {
			const stage = preRelease(nx.version) ? 'no release yet' : 'released, not yet run by Nextcloud master';
			const found = out.length > before;
			add(found ? 'info' : 'ok', 'php-next', [
				found
					? `PHP ${nx.version} (${stage}): the findings named after it are for preparing the app.`
					: `PHP ${nx.version} (${stage}): ${nx.platform ? 'every installed package accepts it, and ' : ''}${plural(r.files, 'PHP file parses', 'PHP files parse')}.`,
				`  It ran in ${nx.image}, ahead of every server, so this prepares the app; it does not show that a server runs it.`,
			]);
		}
	}

	if (r.composer && !r.vendor.present && !r.lock && r.runs.some((x) => x.version && !x.failed)) {
		add('info', 'php-platform-none', [
			'composer.json has no composer.lock and vendor/ is not there, so composer had no packages to check.',
			'  make build writes both; run make php-compat after it.',
		]);
	}
	if (r.needsVendor && !r.vendor.present && r.lock) {
		add('info', 'php-vendor', [
			'vendor/ is not there, so composer checked composer.lock and only the files of the app were linted.',
			'  make build installs what ships; run make php-compat after it to cover the dependencies too.',
		]);
	}
	const checked = r.runs.filter((x) => x.version && !x.failed);
	if (checked.length && !out.some((f) => f.level === 'warn')) {
		add('ok', 'php-compat', [
			`PHP ${checked.map((x) => x.minor).join(', ')}: ${checked.some((x) => x.platform) ? 'every installed package accepts it, and ' : ''}${plural(r.files, 'PHP file parses', 'PHP files parse')}.`,
			floor && ceiling ? `  Floor ${floor}, ceiling ${ceiling}${server && server !== ceiling ? ` (${nc}: ${server})` : ` (${nc})`}.` : '',
		].filter(Boolean));
	}
	return sortFindings(out);
}

// The findings of each run in runs, through add. The platform requirements and the
// lint messages of all of them are reported together, each with the PHP it failed on.
function runFindings(r, runs, add, opt, how) {
	const platform = new Map();  // requirement -> { req, minors }
	const lint = new Map();      // message site -> { ...entry, minors }
	const lacking = new Map();   // extension -> minors
	for (const run of runs) {
		if (run.failed || !run.version) {
			add('warn', 'php-run-failed', [
				`${run.image ?? `PHP ${run.minor}`} could not be checked: the run ${run.failed ? `ended with exit code ${run.failed}` : 'left no result'}.`,
				'  Its output above names the reason; an image that cannot be pulled or built is the usual one.',
			]);
			continue;
		}
		if (!run.image && minorOf(run.version) !== run.minor) {
			add('info', 'php-run-version', [
				`The run for PHP ${run.minor} ran on PHP ${run.version}, so what it reports is about ${minorOf(run.version)}.`,
				'  The runtime does not choose the PHP per minor: RUNTIME=bare runs the PHP of the host, and a'
				+ ' php_base_image set in ncmake.mk names one minor for all of them.',
			]);
		}
		if (run.platform) {
			const reqs = Array.isArray(run.platform.reqs) ? run.platform.reqs : null;
			if (!reqs && run.platform.rc !== 0) {
				add('warn', 'php-platform-run', [
					`composer check-platform-reqs did not finish on PHP ${run.minor} (exit code ${run.platform.rc}).`,
					...errorMessage(run.platform.err).map((l) => `  ${l}`),
				]);
			}
			for (const q of reqs ?? []) {
				if (q.status !== 'failed' && q.status !== 'missing') continue;
				const f = q.failed_requirement ?? {};
				if (/^ext-/.test(q.name) && q.status === 'missing') {
					if (!lacking.has(q.name)) lacking.set(q.name, { minors: new Set(), by: new Set() });
					lacking.get(q.name).minors.add(run.minor);
					lacking.get(q.name).by.add(f.source ?? '__root__');
					continue;
				}
				const key = `${q.name}\0${f.source}\0${f.type}\0${f.constraint}`;
				if (!platform.has(key)) platform.set(key, { name: q.name, status: q.status, ...f, minors: new Set() });
				platform.get(key).minors.add(run.minor);
			}
		}
		for (const e of run.lint) {
			const key = `${e.kind}\0${e.file}\0${e.line}\0${e.message}`;
			if (!lint.has(key)) lint.set(key, { ...e, pkg: packageOf(e.file), minors: new Set() });
			lint.get(key).minors.add(run.minor);
		}
		if (run.unparsed.length) {
			add('info', 'php-lint-other', [
				`php -l on PHP ${run.minor} printed ${plural(run.unparsed.length, 'line', 'lines')} that name no file:`,
				...sample(run.unparsed, opt.details, `see build/php-compat/${run.dir}/lint.txt`),
			]);
		}
	}
	// composer names the app by the name in its composer.json, and __root__ without one.
	const isApp = (s) => s === '__root__' || (r.composerName && s === r.composerName);
	const who = (s) => (isApp(s) ? 'the app' : s);

	// A requirement on the PHP itself decides whether the package runs; one on an
	// extension or a library only whether the build image carries it.
	for (const p of platform.values()) {
		const onPhp = p.name === 'php' || p.name.startsWith('php-');
		const head = `${who(p.source)} ${p.type ?? 'requires'} ${p.target ?? p.name} ${p.constraint ?? ''}`.trim();
		add(onPhp ? 'warn' : 'info', onPhp ? 'php-platform' : 'php-platform-ext', onPhp ? [
			`${head}, which PHP ${listMinors(p.minors)} does not meet.`,
			isApp(p.source)
				? '  composer.json excludes a PHP the servers of the app run it on; widen the constraint.'
				: `  The package installs on the floor and breaks on a server that runs PHP ${listMinors(p.minors)};`
				+ ' update it to a release that allows that PHP, or lower <nextcloud max-version>.',
		] : [
			`${head}, which the build image of PHP ${listMinors(p.minors)} does not meet.`,
			'  Whether a server meets it depends on how its PHP is built, not on the app.',
		]);
	}
	for (const [ext, x] of lacking) {
		add('info', 'php-platform-ext', [
			`${ext} is required by ${[...x.by].map(who).join(', ')}, and the build image of PHP ${listMinors(x.minors)} does not load it.`,
			'  A server has to load it for the app to run; make build installs the dependencies regardless.',
		]);
	}

	// Parse and compile errors stop the server from loading the file; a dev package
	// does not ship with make build, so its errors are only worth knowing.
	const errors = [...lint.values()].filter((e) => e.kind === 'Parse error' || e.kind === 'Fatal error');
	const shipped = errors.filter((e) => !r.vendor.dev.has(e.pkg));
	const devOnly = errors.filter((e) => r.vendor.dev.has(e.pkg));
	const site = (e) => `${e.file}:${e.line} (PHP ${listMinors(e.minors)}) ${e.message}`;
	if (shipped.length) {
		add('warn', 'php-lint-error', [
			`${plural(shipped.length, 'error', 'errors')} in shipped PHP files: a server on that PHP cannot load them.`,
			...sample(shipped.map(site), opt.details, `see ${how('--details')}`),
		]);
	}
	if (devOnly.length) {
		const pkgs = [...new Set(devOnly.map((e) => e.pkg))];
		add('info', 'php-lint-dev', [
			`${plural(devOnly.length, 'error', 'errors')} in ${plural(pkgs.length, 'dev package', 'dev packages')} (${pkgs.join(', ')}).`,
			'  vendor/ holds the dev packages of a composer install; make build leaves them out, so none of this ships.',
		]);
	}
	const notes = [...lint.values()].filter((e) => !errors.includes(e) && !r.vendor.dev.has(e.pkg));
	if (notes.length) {
		const byOwner = new Map();
		for (const e of notes) {
			const owner = e.pkg ?? 'the app';
			if (!byOwner.has(owner)) byOwner.set(owner, { n: 0, minors: new Set() });
			byOwner.get(owner).n++;
			for (const m of e.minors) byOwner.get(owner).minors.add(m);
		}
		const owners = [...byOwner].sort((a, b) => b[1].n - a[1].n)
			.map(([o, x]) => `${o}: ${num(x.n)} (PHP ${listMinors(x.minors)})`);
		add('info', 'php-lint-notice', [
			`${plural(notes.length, 'deprecation or warning', 'deprecations or warnings')} while parsing the shipped PHP files.`,
			'  Each still works on that PHP, and is what a later PHP removes.',
			...sample(opt.details ? notes.map((e) => `${e.kind}: ${site(e)}`) : owners, opt.details, `see ${how('--details')}`),
		]);
	}

}

// == Human-readable output ==
function render(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const how = howToRun('PHP_COMPAT_CMDLINE', 'php-compat.mjs %s');
	const app = r.app;
	const { floor, ceiling, server, nextcloud } = r.range;
	p(`php-compat  ${path.resolve(r.root)}`);
	p(`  ${app ? `${app.id ?? 'no app id'}${app.version ? ` ${app.version}` : ''}` : 'no appinfo/info.xml'}, `
		+ `PHP ${r.runs.map((x) => x.minor).join(', ') || 'none'} checked`
		+ `${r.next?.version ? `, ${r.next.version} ahead of master` : ''}`
		+ `${floor ? `; floor ${floor}` : ''}${ceiling ? `, ceiling ${ceiling}` : ''}`
		+ `${server ? ` (Nextcloud ${nextcloud || 'master'} runs up to ${server})` : ''}.`);
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('Each PHP version ran in the build image of that minor: composer');
	p('check-platform-reqs --no-dev over the installed packages, and php -l over');
	p(`${LINTED.map((d) => `${d}/`).join(', ')}. The output of each run is in build/php-compat.`);
	if (r.next) p(`The PHP ahead of master ran in ${r.next.image}, its output is in build/php-compat/next.`);
	p();
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = check(opt);
report.findings = findings(report, opt);
const json = opt.json || opt.jsonFile
	? `${JSON.stringify(JSON.parse(JSON.stringify(report, (k, v) => (v instanceof Set ? [...v] : v))), null, 2)}\n`
	: null;
if (opt.json) {
	process.stdout.write(json);
} else {
	process.stdout.write(`${render(report)}\n`);
}
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
process.exitCode = report.findings.some((f) => f.level === 'warn') ? 1 : 0;
