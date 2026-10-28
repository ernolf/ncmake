#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-yaml - what yamllint finds in the YAML files of this repository.
//
// yamllint (https://yamllint.readthedocs.io) over every tracked YAML file. A
// repository configuration, .yamllint, .yamllint.yaml or .yamllint.yml, wins;
// without one the default of the lint-yaml workflow applies: yamllint's own
// default, with true and false as the only truthy values, keys not checked, and
// neither line length nor document start. make hands in yamllint and the two
// packages it needs, fetched and checked against their digests; Python is the one
// of the container.

import { configDir, finding, firstFile, linter, runTool, tracked } from './lint-common.mjs';

const python = process.env.LINT_PYTHON || 'python3';
const yamllint = process.env.LINT_YAMLLINT || null;

const CONFIGS = ['.yamllint', '.yamllint.yaml', '.yamllint.yml'];

const DEFAULT = `extends: default
rules:
  truthy:
    allowed-values: ['true', 'false']
    check-keys: false
  line-length: disable
  document-start: disable
`;

// yamllint's parsable format: file:line:column: [level] message (rule).
const LINE = /^(.+?):(\d+):(\d+): \[(error|warning)\] (.*?)(?: \(([\w-]+)\))?$/;

linter({
	name: 'lint-yaml',
	title: 'what yamllint finds in the YAML files of this repository',
	what: 'YAML files',
	defaults: true,
	legend: [
		'Errors are [!] and fail the check, as they fail the lint-yaml workflow;',
		'warnings are [i], unless the configuration sets strict, which fails on them',
		'too. Each names the yamllint rule, whose page says what it checks.',
	],
	check({ root, die }) {
		const files = tracked(root, ['*.yml', '*.yaml'], die);
		const res = { tool: 'yamllint', config: firstFile(root, CONFIGS), files, findings: [] };
		if (!files.length) return res;
		// A repository configuration in the working directory comes before the
		// file YAMLLINT_CONFIG_FILE names, so the default never overrides it.
		const env = {
			YAMLLINT_CONFIG_FILE: `${configDir({ 'yamllint.yml': DEFAULT })}/yamllint.yml`,
			...(yamllint ? { PYTHONPATH: yamllint } : {}),
		};
		const args = ['-B', '-m', 'yamllint'];
		res.version = runTool(python, [...args, '--version'], { cwd: root, env, done: [0], die }).stdout.trim().replace(/^yamllint\s+/, '') || null;
		// 2 is a run with warnings only, under strict.
		const r = runTool(python, [...args, '-f', 'parsable', '--', ...files], { cwd: root, env, done: [0, 1, 2], die });
		for (const l of r.stdout.split('\n')) {
			const m = LINE.exec(l);
			if (!m) continue;
			const [, file, line, column, level, message, rule] = m;
			res.findings.push(finding({
				level: level === 'error' || r.status === 2 ? 'warn' : 'info',
				id: rule ?? 'syntax',
				file,
				line: Number(line),
				column: Number(column),
				message: `${level}: ${message}`,
				url: rule ? `https://yamllint.readthedocs.io/en/stable/rules.html#module-yamllint.rules.${rule.replace(/-/g, '_')}` : null,
				extra: { severity: level },
			}));
		}
		return res;
	},
});
