#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-actions - is every GitHub Actions workflow of this repository valid.
//
// actionlint (https://github.com/rhysd/actionlint) over every tracked workflow,
// with shellcheck over the scripts of its run: steps. actionlint reads the
// repository's .github/actionlint.yaml or .yml by itself. make hands in both
// binaries, fetched and checked against their digests. Every error actionlint
// reports fails the check.

import path from 'node:path';

import { finding, firstFile, isFile, linter, runTool, tracked } from './lint-common.mjs';

const actionlint = process.env.LINT_ACTIONLINT || 'actionlint';
const shellcheck = process.env.LINT_SHELLCHECK || 'shellcheck';

// Everything under .github/workflows and .ncmake/workflows, and every YAML file
// with a .properties.json beside it, which is how a workflow template lies in
// ernolf/ncmake-workflows.
function collect(root, die) {
	return tracked(root, ['*.yml', '*.yaml'], die).filter((f) => f.startsWith('.github/workflows/')
		|| f.startsWith('.ncmake/workflows/')
		|| isFile(path.join(root, `${f.replace(/\.[^./]*$/, '')}.properties.json`)));
}

linter({
	name: 'lint-actions',
	title: 'is every GitHub Actions workflow of this repository valid',
	what: 'workflows',
	legend: [
		'Every error actionlint reports is [!] and fails the check, as it fails the',
		'lint-actions workflow: a syntax error, an unknown key, a wrong expression, an',
		'action input that does not exist, a shellcheck finding in a run: script.',
	],
	check({ root, die }) {
		const files = collect(root, die);
		const res = { tool: 'actionlint', config: firstFile(root, ['.github/actionlint.yaml', '.github/actionlint.yml']), files, findings: [] };
		if (!files.length) return res;
		res.version = runTool(actionlint, ['-version'], { cwd: root, done: [0], die }).stdout.split('\n')[0].trim() || null;
		// -pyflakes= turns the Python check off, which the runner has no pyflakes for.
		const r = runTool(actionlint, ['-format', '{{json .}}', '-no-color', `-shellcheck=${shellcheck}`, '-pyflakes=', '--', ...files],
			{ cwd: root, die });
		let raw;
		try { raw = JSON.parse(r.stdout || 'null') ?? []; } catch (e) { die(`actionlint's JSON could not be read: ${e.message}`); }
		res.findings = raw.map((e) => finding({
			id: e.kind,
			file: e.filepath,
			line: e.line,
			column: e.column,
			message: e.message,
		}));
		return res;
	},
});
