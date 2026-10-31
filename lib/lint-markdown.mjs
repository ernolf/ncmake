#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-markdown - what markdownlint finds in the Markdown files of this
// repository.
//
// markdownlint-cli2 (https://github.com/DavidAnson/markdownlint-cli2) over every
// tracked Markdown file outside a dependency tree. A repository configuration
// wins; without one the default of the lint-markdown workflow applies: every rule,
// except line length, blank lines inside a block quote, inline HTML, a first line
// that is no heading, link fragments and table column style, and with a heading
// repeated only under another parent, as a changelog repeats its sections in
// every release. make hands in the npm package, installed once per version into
// the ncmake cache.

import path from 'node:path';

import { configDir, finding, firstFile, inDependencies, linter, packageVersion, runTool, tracked } from './lint-common.mjs';

const modules = process.env.LINT_MODULES || null;

const CONFIGS = [
	'.markdownlint-cli2.jsonc', '.markdownlint-cli2.yaml', '.markdownlint-cli2.cjs', '.markdownlint-cli2.mjs',
	'.markdownlint.jsonc', '.markdownlint.json', '.markdownlint.yaml', '.markdownlint.yml',
	'.markdownlint.cjs', '.markdownlint.mjs',
];

const DEFAULT = `${JSON.stringify({
	config: {
		default: true,
		MD013: false,
		MD024: { siblings_only: true },
		MD028: false,
		MD033: false,
		MD041: false,
		MD051: false,
		MD060: false,
	},
}, null, 2)}\n`;

// The default output of markdownlint-cli2, one finding per line on stderr:
// file:line[:column] error|warning MDnnn/name description [detail] [Context: ...].
const LINE = /^(.+?):(\d+)(?::(\d+))? (error|warning) (MD\d+)\/(\S+) (.*)$/;

linter({
	name: 'lint-markdown',
	title: 'what markdownlint finds in the Markdown files of this repository',
	what: 'Markdown files',
	defaults: true,
	legend: [
		'Errors are [!] and fail the check, as they fail the lint-markdown workflow; a',
		'rule the configuration sets to warning gives [i]. Each names the markdownlint',
		'rule, whose page says what it checks.',
	],
	check({ root, die }) {
		const files = tracked(root, ['*.md'], die).filter((f) => !inDependencies(f));
		const config = firstFile(root, CONFIGS);
		const res = { tool: 'markdownlint-cli2', config, files, findings: [] };
		if (!files.length) return res;
		if (!modules) die('LINT_MODULES does not name the node_modules of markdownlint-cli2');
		res.version = packageVersion(modules, 'markdownlint-cli2', die);
		const args = config ? [] : ['--config', path.join(configDir({ '.markdownlint-cli2.jsonc': DEFAULT }), '.markdownlint-cli2.jsonc')];
		// Everything after -- is a literal path, not a glob.
		const r = runTool(path.join(modules, '.bin', 'markdownlint-cli2'), [...args, '--', ...files], { cwd: root, die });
		for (const l of r.stderr.split('\n')) {
			const m = LINE.exec(l);
			if (!m) continue;
			const [, file, line, column, level, rule, name, message] = m;
			res.findings.push(finding({
				level: level === 'error' ? 'warn' : 'info',
				id: `${rule}/${name}`,
				file,
				line: Number(line),
				column: column ? Number(column) : null,
				message,
				url: `https://github.com/DavidAnson/markdownlint/blob/main/doc/${rule.toLowerCase()}.md`,
				extra: { severity: level },
			}));
		}
		if (r.status !== 0 && !res.findings.some((f) => f.level === 'warn')) {
			die(`markdownlint-cli2 failed without a finding this analyser can read:\n${r.stderr.trim()}`);
		}
		return res;
	},
});
