#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-actions-security - can a workflow of this repository be attacked.
//
// zizmor (https://docs.zizmor.sh) over every tracked GitHub Actions workflow and
// action definition, collected the way the lint-actions-security workflow of
// ernolf/ncmake-workflows collects them, and failed where that workflow fails: on
// a finding of medium severity or above. The run is the same, so a finding shows
// here before it shows in a public CI log.
//
// zizmor runs offline, so it needs no token and reads nothing but the checkout. It
// finds the repository's own configuration by itself, .github/zizmor.yml or
// zizmor.yml at the root, as it does on the runner. make hands in the binary it
// fetched and checked against its digest; this file decides what is checked, how
// the result reads and what fails. Node 18 or newer.

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
	dir: '.',          // the checkout; only its tracked files are checked
	persona: null,     // zizmor's own default, the regular persona
	details: false,
	json: false,
	jsonFile: null,
	sarifFile: null,
};

const PERSONAS = ['regular', 'pedantic', 'auditor'];

// The configuration files zizmor discovers at the root of a git repository, in the
// order it tries them.
const CONFIGS = ['.github/zizmor.yml', '.github/zizmor.yaml', 'zizmor.yml', 'zizmor.yaml'];

// zizmor's exit codes for a completed run: no finding, or the highest severity
// found, informational to high. Every other code is a run that failed.
const DONE = new Set([0, 11, 12, 13, 14]);

// Medium and high fail, as in the workflow; low and informational are shown.
const LEVEL = { High: 'warn', Medium: 'warn', Low: 'info', Informational: 'info' };
const RANK = { High: 0, Medium: 1, Low: 2, Informational: 3 };

// == Command line ==
function usage() {
	return `lint-actions-security - can a workflow of this repository be attacked

Usage: lint-actions-security.mjs [options] [dir]

  dir                   the git checkout to check (default: ${defaults.dir})

Options:
  --persona=<name>      zizmor's persona: ${PERSONAS.join(', ')} (default: regular)
  --details             list the files that were checked
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  --sarif-file=<file>   write the findings as SARIF to <file>, for code scanning
  -h, --help            this text

The check reads the tracked files of the checkout only, with zizmor offline. The
exit code is 0 when no finding is of medium severity or above, 1 when one is, and
2 when the run itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`lint-actions-security: ${msg}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	for (const arg of argv) {
		switch (arg) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--details': opt.details = true; break;
			case '--json': opt.json = true; break;
			default:
				if (arg.startsWith('--json-file=')) { opt.jsonFile = arg.slice('--json-file='.length); break; }
				if (arg.startsWith('--sarif-file=')) { opt.sarifFile = arg.slice('--sarif-file='.length); break; }
				if (arg.startsWith('--persona=')) { opt.persona = arg.slice('--persona='.length); break; }
				if (arg.startsWith('-')) die(`unknown option: ${arg}`);
				if (dir !== null) die(`only one directory can be checked: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (opt.jsonFile === '') die('--json-file needs a file');
	if (opt.sarifFile === '') die('--sarif-file needs a file');
	if (opt.persona !== null && !PERSONAS.includes(opt.persona)) die(`unknown persona: ${opt.persona} (${PERSONAS.join(', ')})`);
	return opt;
}

// == The files ==
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Tracked files only: a checkout carries nothing else worth checking. Everything
// under .github/workflows and .ncmake/workflows, every action.yml outside a
// dependency tree, and every YAML file with a .properties.json beside it, which is
// how a workflow template lies in ernolf/ncmake-workflows. safe.directory keeps git
// from refusing a checkout whose owner differs from the user inside the container.
function collect(root) {
	const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', root, 'ls-files', '-z', '--', '*.yml', '*.yaml'],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (r.error || r.status !== 0) die(`${root} is not a git work tree; the files to check are the tracked ones`);
	const out = [];
	for (const f of r.stdout.split('\0').filter(Boolean)) {
		if (!isFile(path.join(root, f))) continue;
		if (f.startsWith('.github/workflows/') || f.startsWith('.ncmake/workflows/')) { out.push(f); continue; }
		if (/(?:^|\/)(?:node_modules|vendor)\//.test(f)) continue;
		const base = path.posix.basename(f);
		if (base === 'action.yml' || base === 'action.yaml') { out.push(f); continue; }
		if (isFile(path.join(root, `${f.replace(/\.[^./]*$/, '')}.properties.json`))) out.push(f);
	}
	return out;
}

// == zizmor ==
const zizmor = process.env.LINT_ACTIONS_SECURITY_ZIZMOR || 'zizmor';

function run(root, args) {
	const r = spawnSync(zizmor, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	if (r.error) die(`could not run ${zizmor}: ${r.error.message}`);
	return r;
}

function scan(root, files, opt, format) {
	const args = ['--offline', '--no-progress', '--color', 'never', '--format', format];
	if (opt.persona) args.push('--persona', opt.persona);
	const r = run(root, [...args, '--', ...files]);
	// zizmor logs its progress on stderr; what it warns about is passed on.
	const said = r.stderr.split('\n').filter((l) => /^\s*(?:WARN|ERROR)\b/.test(l));
	if (r.status !== 0 && !(format === 'json' && DONE.has(r.status))) {
		die(`zizmor stopped with exit code ${r.status ?? r.signal}:\n${r.stderr.trim()}`);
	}
	if (said.length) process.stderr.write(`${said.join('\n')}\n`);
	return r.stdout;
}

// One finding of zizmor's JSON. Its primary location is where the finding is; the
// others only point at the step or workflow around it. zizmor counts rows from 0.
function finding(z) {
	const severity = z.determinations?.severity ?? 'Unknown';
	const confidence = z.determinations?.confidence ?? 'Unknown';
	const loc = z.locations?.find((l) => l.symbolic?.kind === 'Primary') ?? z.locations?.[0];
	const file = loc?.symbolic?.key?.Local?.verbatim_path ?? null;
	const row = loc?.concrete?.location?.start_point?.row;
	const line = Number.isInteger(row) ? row + 1 : null;
	const where = file ? `${file}${line ? `:${line}` : ''}` : 'no location';
	const what = [z.desc, loc?.symbolic?.annotation].filter(Boolean).join(': ');
	return {
		level: LEVEL[severity] ?? 'info',
		id: z.ident,
		security: true,
		file,
		line,
		severity: severity.toLowerCase(),
		confidence: confidence.toLowerCase(),
		url: z.url ?? null,
		lines: [
			`${where}  ${z.ident}, ${severity.toLowerCase()} severity, ${confidence.toLowerCase()} confidence.`,
			...(what ? [`${what}.`] : []),
			...(z.url ? [z.url] : []),
		],
	};
}

// == The check ==
function lint(opt) {
	const root = path.resolve(opt.dir);
	const files = collect(root);
	const config = CONFIGS.find((c) => isFile(path.join(root, c))) ?? null;
	const report = {
		root,
		zizmor: null,
		persona: opt.persona ?? 'regular',
		config,
		files,
		findings: [],
	};
	if (!files.length) {
		report.findings.push({ level: 'ok', id: 'no-workflows', lines: ['No tracked workflow or action definition; nothing to check.'] });
		return report;
	}
	report.zizmor = run(root, ['--version']).stdout.trim().replace(/^zizmor\s+/, '') || null;
	let raw;
	try { raw = JSON.parse(scan(root, files, opt, 'json')); } catch (e) { die(`zizmor's JSON could not be read: ${e.message}`); }
	if (!Array.isArray(raw)) die('zizmor\'s JSON is not a list of findings');
	const rank = (z) => RANK[z.determinations?.severity] ?? RANK.Informational + 1;
	const found = raw.filter((z) => !z.ignored).map((z) => ({ z, f: finding(z) }))
		.sort((a, b) => rank(a.z) - rank(b.z) || String(a.f.file).localeCompare(String(b.f.file)) || (a.f.line ?? 0) - (b.f.line ?? 0))
		.map(({ f }) => f);
	report.findings = found.length
		? sortFindings(found)
		: [{ level: 'ok', id: 'zizmor', lines: [`zizmor finds nothing in ${plural(files.length, 'file', 'files')}.`] }];
	if (opt.sarifFile) writeFile(opt.sarifFile, scan(root, files, opt, 'sarif'), 'SARIF');
	return report;
}

// Written beside the target and renamed over it, as the JSON file is, so a run that
// fails on the way leaves an existing file whole.
function writeFile(file, text, what) {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	try {
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		die(`could not write the ${what} file: ${e.message}`);
	}
}

// == Human-readable output ==
const how = howToRun('LINT_ACTIONS_SECURITY_CMDLINE', 'lint-actions-security.mjs %s');

function render(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);
	p(`lint-actions-security  ${r.root}`);
	p(r.zizmor
		? `  zizmor ${r.zizmor}, offline, ${r.persona} persona, ${plural(r.files.length, 'file', 'files')}, `
			+ `${r.config ? `configuration ${r.config}` : 'no configuration'}.`
		: '  No file to check.');
	if (opt.details && r.files.length) {
		p();
		p('FILES');
		for (const f of r.files) p(`  ${f}`);
	}
	p();
	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('Findings of medium and high severity are [!] and fail the check, as they fail');
	p('the lint-actions-security workflow; low and informational ones are [i]. Every');
	p('finding names the zizmor audit that explains it and how to fix or ignore it.');
	p();
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = lint(opt);
const json = opt.json || opt.jsonFile ? `${JSON.stringify(report, null, 2)}\n` : null;
if (opt.json) {
	process.stdout.write(json);
} else {
	process.stdout.write(`${render(report, opt)}\n`);
}
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
process.exitCode = report.findings.some((f) => f.level === 'warn') ? 1 : 0;
