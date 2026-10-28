// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-common - what the lint analysers of the lint module share.
//
// Each lint target runs one linter over the tracked files of a checkout, the way
// the lint workflow of the same name in ernolf/ncmake-workflows runs it. The
// analyser of a target knows which files its linter takes, how to call it and how
// to read its output; the command line, the collection of tracked files, the
// report and the exit code are the same for all of them and live here. Knows
// nothing about a particular linter. Node 18 or newer.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	LEGEND,
	howToRun,
	plural,
	renderFindings,
	sortFindings,
	writeJsonFile,
} from './report-text.mjs';

// == Files ==
export const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// A tracked dependency tree is not the repository's own code.
export const inDependencies = (f) => /(?:^|\/)(?:node_modules|vendor)\//.test(f);

// The first of the given files that exists in the checkout, as the linter would
// find it there itself.
export const firstFile = (root, names) => names.find((n) => isFile(path.join(root, n))) ?? null;

// Tracked files only: a checkout carries nothing else worth linting. safe.directory
// keeps git from refusing a checkout whose owner differs from the user inside the
// container. A tracked file deleted from the work tree is not there to lint.
export function tracked(root, pathspecs, die) {
	const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', root, 'ls-files', '-z', '--', ...pathspecs],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (r.error || r.status !== 0) die(`${root} is not a git work tree; the files to check are the tracked ones`);
	return r.stdout.split('\0').filter((f) => f && isFile(path.join(root, f)));
}

// == Running a linter ==
// A linter exits with a code of its own for "found something"; every code outside
// the ones the analyser names as done is a run that failed.
export function runTool(cmd, args, { cwd, env, done = [0, 1], die }) {
	const r = spawnSync(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	});
	if (r.error) die(`could not run ${cmd}: ${r.error.message}`);
	if (!done.includes(r.status)) {
		die(`${path.basename(cmd)} stopped with exit code ${r.status ?? r.signal}:\n${`${r.stderr}\n${r.stdout}`.trim()}`);
	}
	return r;
}

// A default configuration is written into a directory of its own outside the
// checkout, which is removed when the analyser ends. A configuration that imports
// a package finds it through node_modules beside it, linked to the linter's own.
export function configDir(files, modules = null) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmake-lint-'));
	process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	if (modules) fs.symlinkSync(modules, path.join(dir, 'node_modules'));
	return dir;
}

// Whether this Node meets an engines.node range of the forms npm packages use:
// alternatives joined by ||, each ^X.Y.Z or >=X.Y.Z. A form outside these passes,
// so only a range that is understood can stop the run.
const versionParts = (v) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
const atLeast = (a, b) => {
	for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	return true;
};
function nodeMeets(range) {
	const have = versionParts(process.versions.node);
	return range.split('||').some((alt) => {
		const m = /^\s*(\^|>=)\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(alt);
		if (!m) return true;
		const want = versionParts(m[2]);
		return atLeast(have, want) && (m[1] === '>=' || have[0] === want[0]);
	});
}

// The version a package of an npm tool directory declares. With RUNTIME=bare the
// tool runs on the host's Node, which may be older than the package needs; that
// stops the run here, before the tool fails in a way that names no cause.
export function packageVersion(modules, name, die) {
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
	const range = pkg.engines?.node;
	if (range && !nodeMeets(range)) die(`${name} ${pkg.version} needs Node ${range}; this is Node ${process.versions.node}`);
	return pkg.version ?? null;
}

// == Findings ==
// One finding of a linter: where it is, the rule that reports it, what it says and
// the page that explains the rule.
export function finding({ level = 'warn', id, file = null, line = null, column = null, message = '', url = null, extra = {} }) {
	const where = file ? `${file}${line ? `:${line}${column ? `:${column}` : ''}` : ''}` : 'no location';
	return {
		level,
		id,
		file,
		line,
		...extra,
		lines: [`${where}  ${id}`, ...(message ? [message] : []), ...(url ? [url] : [])],
	};
}

// By file and line, so the report reads like the files do.
export const byPlace = (a, b) => String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0);

// == The analyser ==
// spec: {
//   name     the target, e.g. lint-shell
//   title    what the target checks, one line
//   what     what the files are, plural, e.g. "shell scripts"
//   usage    the options the analyser adds, lines for --help
//   option   (arg, opt) => true when it took a further option
//   check    ({ root, opt, die }) => { tool, version, config, files, findings, summary, ...extra }
//            summary, when given, is the line under the title in place of the
//            one built from tool, version and config; findings without files
//            are ok findings that say why nothing was checked
//   defaults true when the target brings a configuration of its own for a
//            repository without one
//   legend   lines below the legend: what is [!] and what is [i]
// }
// check returns no findings for a clean run; the report says so itself.
export function linter(spec) {
	const die = (msg) => {
		process.stderr.write(`${spec.name}: ${msg}\n`);
		process.exit(2);
	};

	const usage = () => `${spec.name} - ${spec.title}

Usage: ${spec.name}.mjs [options] [dir]

  dir                   the git checkout to check (default: .)

Options:
${spec.usage ? `${spec.usage}\n` : ''}  --details             list the files that were checked
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  -h, --help            this text

The check reads the tracked files of the checkout only. The exit code is 0 when no
finding is [!], 1 when one is, and 2 when the run itself could not be carried out.`;

	const opt = { dir: '.', details: false, json: false, jsonFile: null };
	let dir = null;
	for (const arg of process.argv.slice(2)) {
		if (arg === '-h' || arg === '--help') { process.stdout.write(`${usage()}\n`); process.exit(0); }
		if (arg === '--details') { opt.details = true; continue; }
		if (arg === '--json') { opt.json = true; continue; }
		if (arg.startsWith('--json-file=')) { opt.jsonFile = arg.slice('--json-file='.length); continue; }
		if (spec.option?.(arg, opt)) continue;
		if (arg.startsWith('-')) die(`unknown option: ${arg}`);
		if (dir !== null) die(`only one directory can be checked: ${dir}, ${arg}`);
		dir = arg;
	}
	if (dir !== null) opt.dir = dir;
	if (opt.jsonFile === '') die('--json-file needs a file');

	const root = path.resolve(opt.dir);
	const { tool, version = null, config = null, files, findings, summary = null, ...extra } = spec.check({ root, opt, die });
	const report = { root, tool, version, config, ...extra, files, findings: [] };
	if (!files.length) {
		// An analyser that has a reason of its own to check nothing names it.
		report.findings = findings.length ? findings
			: [{ level: 'ok', id: 'no-files', lines: [`No tracked ${spec.what}; nothing to check.`] }];
	} else if (!findings.length) {
		report.findings = [{ level: 'ok', id: tool, lines: [`${tool} finds nothing in ${plural(files.length, 'file', 'files')}.`] }];
	} else {
		report.findings = sortFindings([...findings].sort(byPlace));
	}

	const how = howToRun('LINT_CMDLINE', `${spec.name}.mjs %s`);
	const render = () => {
		const out = [];
		const p = (s = '') => out.push(s);
		p(`${spec.name}  ${root}`);
		p(summary ? `  ${summary}` : files.length
			? `  ${tool}${version ? ` ${version}` : ''}, ${plural(files.length, 'file', 'files')}, `
				+ `${config ? `configuration ${config}` : spec.defaults ? 'the default configuration' : 'no configuration'}.`
			: '  No file to check.');
		if (opt.details && files.length) {
			p();
			p('FILES');
			for (const f of files) p(`  ${f}`);
		}
		p();
		p('FINDINGS');
		for (const l of renderFindings(report.findings)) p(l);
		p();
		p(LEGEND);
		for (const l of spec.legend) p(l);
		p();
		p(`Machine-readable: ${how('--json')}`);
		return out.join('\n');
	};

	const json = opt.json || opt.jsonFile ? `${JSON.stringify(report, null, 2)}\n` : null;
	process.stdout.write(opt.json ? json : `${render()}\n`);
	if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
	process.exitCode = report.findings.some((f) => f.level === 'warn') ? 1 : 0;
}
