#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-actions - is every GitHub Actions workflow of this repository valid.
//
// actionlint (https://github.com/rhysd/actionlint) over every tracked workflow,
// with shellcheck over the scripts of its run: steps. actionlint reads the
// repository's .github/actionlint.yaml or .yml by itself; without one the
// default of the lint-actions workflow applies, which declares the self-hosted
// runner labels of Nextcloud. make hands in both binaries, fetched and checked
// against their digests. Every error actionlint reports fails the check, and so
// does a shellcheck finding of severity error or warning; one of severity info
// or style is a note. actionlint runs shellcheck with --norc, so the disable=
// and enable= of the repository's .shellcheckrc are handed on through
// SHELLCHECK_OPTS, and a run: script is judged by the rules lint-shell applies.

import fs from 'node:fs';
import path from 'node:path';

import { readData } from './data.mjs';
import { configDir, finding, firstFile, isFile, linter, runTool, tracked } from './lint-common.mjs';

const actionlint = process.env.LINT_ACTIONLINT || 'actionlint';
const shellcheck = process.env.LINT_SHELLCHECK || 'shellcheck';

// The self-hosted runner labels the workflows of Nextcloud run on, which actionlint
// does not know: data/github-runners.json, which a workflow of ncmake regenerates
// and the core fetches beside this file. Where it cannot be read, the default
// declares none, and a job on one of them is reported as an unknown label.
const runners = readData('github-runners')?.values?.self_hosted ?? [];
const DEFAULT_CONFIG = `self-hosted-runner:\n  labels:${runners.length ? runners.map((l) => `\n    - ${l}`).join('') : ' []'}\n`;

// Everything under .github/workflows and .ncmake/workflows, and every YAML file
// with a .properties.json beside it, which is how a workflow template lies in
// ernolf/ncmake-workflows.
function collect(root, die) {
	return tracked(root, ['*.yml', '*.yaml'], die).filter((f) => f.startsWith('.github/workflows/')
		|| f.startsWith('.ncmake/workflows/')
		|| isFile(path.join(root, `${f.replace(/\.[^./]*$/, '')}.properties.json`)));
}

// The disable= and enable= directives of a .shellcheckrc as options of shellcheck.
// -e takes no range and no "all", which the directive does: a range becomes its
// codes, and disable=all turns shellcheck off. The other directives, shell= or
// source-path= for instance, mean nothing for a script actionlint hands in on
// stdin with --shell bash.
function shellcheckOpts(file) {
	const words = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '')).join(' ').split(/\s+/);
	const codes = (list) => list.split(',').filter(Boolean).flatMap((c) => {
		const range = /^(?:SC)?(\d+)-(?:SC)?(\d+)$/i.exec(c);
		if (!range) return [c.replace(/^(?:SC)?(\d+)$/i, 'SC$1')];
		const out = [];
		for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(`SC${n}`);
		return out;
	});
	const exclude = [];
	const enable = [];
	for (const w of words) {
		const m = /^(disable|enable)=(.+)$/.exec(w);
		if (m) (m[1] === 'disable' ? exclude : enable).push(...codes(m[2]));
	}
	if (exclude.some((c) => c.toLowerCase() === 'all')) return null;
	return [...(exclude.length ? [`--exclude=${exclude.join(',')}`] : []), ...(enable.length ? [`--enable=${enable.join(',')}`] : [])];
}

// actionlint names the run: key as the place of every shellcheck finding in that
// script, and the place in the script only in the message. For a literal block
// (run: |) the script starts on the next line at the indentation of the block, for
// a plain value on the line of the key after it. A folded, quoted or explicitly
// indented value moves the text of the script against the file, so its findings
// keep the place of the key.
function inFile(lines, line, column, sLine, sCol) {
	const m = /^run:([ \t]*)(.*)$/.exec(lines[line - 1]?.slice(column - 1) ?? '');
	if (!m) return null;
	const value = m[2].replace(/(?:^|[ \t])#.*$/, '').trimEnd();
	if (/^\|[-+]?$/.test(value)) {
		const first = lines.slice(line).find((l) => l.trim());
		const indent = first ? /^ */.exec(first)[0].length : 0;
		const target = lines[line + sLine - 1];
		if (!indent || target === undefined || (target.trim() && !target.startsWith(' '.repeat(indent)))) return null;
		return { line: line + sLine, column: indent + sCol };
	}
	if (value && !/^[|>'"&*!{[]/.test(value) && sLine === 1 && sCol <= value.length) {
		return { line, column: column + 'run:'.length + m[1].length + sCol - 1 };
	}
	return null;
}

linter({
	name: 'lint-actions',
	title: 'is every GitHub Actions workflow of this repository valid',
	what: 'workflows',
	defaults: true,
	legend: [
		'Every error actionlint reports is [!] and fails the check, as it fails the',
		'lint-actions workflow: a syntax error, an unknown key, a wrong expression, an',
		'action input that does not exist, untrusted input in a run: script, and a',
		'shellcheck finding of severity error or warning in a run: script. A shellcheck',
		'finding of severity info or style is [i]. The repository\'s .shellcheckrc',
		'decides which shellcheck codes are checked, as it does for lint-shell.',
	],
	check({ root, die }) {
		const files = collect(root, die);
		const shellcheckrc = firstFile(root, ['.shellcheckrc']);
		const res = { tool: 'actionlint', config: firstFile(root, ['.github/actionlint.yaml', '.github/actionlint.yml']), shellcheckrc, files, findings: [] };
		if (!files.length) return res;
		res.version = runTool(actionlint, ['-version'], { cwd: root, done: [0], die }).stdout.split('\n')[0].trim() || null;
		const args = res.config ? [] : ['-config-file', path.join(configDir({ 'actionlint.yaml': DEFAULT_CONFIG }), 'actionlint.yaml')];
		const opts = shellcheckrc ? shellcheckOpts(path.join(root, shellcheckrc)) : [];
		const env = opts?.length ? { SHELLCHECK_OPTS: [process.env.SHELLCHECK_OPTS, ...opts].filter(Boolean).join(' ') } : {};
		// -pyflakes= turns the Python check off, which the runner has no pyflakes for;
		// -shellcheck= turns shellcheck off, for a .shellcheckrc with disable=all.
		const r = runTool(actionlint, ['-format', '{{json .}}', '-no-color', `-shellcheck=${opts ? shellcheck : ''}`, '-pyflakes=', ...args, '--', ...files],
			{ cwd: root, env, die });
		let raw;
		try { raw = JSON.parse(r.stdout || 'null') ?? []; } catch (e) { die(`actionlint's JSON could not be read: ${e.message}`); }
		const text = new Map();
		const linesOf = (f) => {
			if (!text.has(f)) text.set(f, fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/));
			return text.get(f);
		};
		res.findings = raw.map((e) => {
			const sc = e.kind === 'shellcheck' && /^shellcheck reported issue in this script: SC(\d+):(\w+):(\d+):(\d+): (.*)$/s.exec(e.message);
			if (!sc) {
				return finding({
					id: e.kind,
					file: e.filepath,
					line: e.line,
					column: e.column,
					message: e.message,
					extra: e.kind === 'expression' && /is potentially untrusted/.test(e.message) ? { security: true } : {},
				});
			}
			const [, code, severity, sLine, sCol, message] = sc;
			const at = inFile(linesOf(e.filepath), e.line, e.column, Number(sLine), Number(sCol));
			return finding({
				level: severity === 'info' || severity === 'style' ? 'info' : 'warn',
				id: e.kind,
				file: e.filepath,
				line: at?.line ?? e.line,
				column: at?.column ?? e.column,
				message: `SC${code} ${severity}: ${message}${at ? '' : ` (line ${sLine}, column ${sCol} of the run: script)`}`,
				url: `https://www.shellcheck.net/wiki/SC${code}`,
				extra: { code: `SC${code}`, severity },
			});
		});
		if (!res.config && !runners.length) {
			res.findings.push({
				level: 'info',
				id: 'runner-labels',
				lines: ['The default configuration declares no self-hosted runner label: data/github-runners.json'
					+ ' of ncmake could not be read, so a job on a runner of Nextcloud is reported as an unknown label.'],
			});
		}
		return res;
	},
});
