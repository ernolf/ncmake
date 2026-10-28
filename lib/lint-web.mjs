#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-web - what ESLint, Stylelint and html-validate find in the plain web files
// of this repository.
//
// For a repository without a package.json, which so has no lint script of its
// own: ESLint (https://eslint.org) over the JavaScript, Stylelint
// (https://stylelint.io) over the CSS, html-validate (https://html-validate.org)
// over the HTML, every tracked file outside a dependency tree that is not a
// minified copy. A repository configuration of a tool wins; without one the
// default of the lint-web workflow applies: ESLint's recommended rules with the
// browser globals, stylelint-config-standard, and html-validate's recommended
// preset. A repository with a package.json passes, as it does in the workflow.
// make hands in the npm packages, installed once per version into the ncmake
// cache, and makes them the node_modules a repository configuration imports from.

import path from 'node:path';

import { configDir, finding, firstFile, inDependencies, isFile, linter, packageVersion, runTool, tracked } from './lint-common.mjs';
import { plural } from './report-text.mjs';

const modules = process.env.LINT_MODULES || null;

const TOOLS = {
	eslint: {
		name: 'ESLint',
		pkg: 'eslint',
		files: /\.(?:js|mjs|cjs)$/,
		configs: ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'],
		default: ['eslint.config.mjs', `import js from '@eslint/js'
import globals from 'globals'
export default [
  js.configs.recommended,
  { languageOptions: { globals: { ...globals.browser } } },
]
`],
		// A file the configuration ignores is no finding, so passing it by name
		// must not warn either.
		args: ['--no-warn-ignored', '-f', 'json'],
		done: [0, 1],
		read: (r) => JSON.parse(r.stdout).flatMap((f) => f.messages.map((m) => ({
			file: f.filePath,
			line: m.line ?? null,
			column: m.column ?? null,
			rule: m.ruleId ?? (m.fatal ? 'parse-error' : 'eslint'),
			error: m.severity === 2,
			message: m.message,
			url: m.ruleId && !m.ruleId.includes('/') ? `https://eslint.org/docs/latest/rules/${m.ruleId}` : null,
		}))),
	},
	stylelint: {
		name: 'Stylelint',
		pkg: 'stylelint',
		files: /\.css$/,
		configs: ['.stylelintrc', '.stylelintrc.cjs', '.stylelintrc.mjs', '.stylelintrc.js', '.stylelintrc.ts',
			'.stylelintrc.json', '.stylelintrc.yaml', '.stylelintrc.yml',
			'stylelint.config.cjs', 'stylelint.config.mjs', 'stylelint.config.js', 'stylelint.config.ts'],
		default: ['stylelint.config.json', '{ "extends": ["stylelint-config-standard"] }\n'],
		args: ['--formatter', 'json'],
		// Stylelint exits with 2 on a finding and writes the report to stderr.
		done: [0, 2],
		read: (r) => JSON.parse(r.stderr || '[]').flatMap((f) => [
			...f.warnings.map((w) => ({
				file: f.source,
				line: w.line ?? null,
				column: w.column ?? null,
				rule: w.rule,
				error: w.severity === 'error',
				// Stylelint ends its text with the rule, which the finding names already.
				message: w.rule ? w.text.replace(` (${w.rule})`, '') : w.text,
				url: w.rule ? `https://stylelint.io/user-guide/rules/${w.rule}` : null,
			})),
			...(f.invalidOptionWarnings ?? []).map((w) => ({ file: f.source, rule: 'invalid-option', error: true, message: w.text })),
		]),
	},
	html: {
		name: 'html-validate',
		pkg: 'html-validate',
		files: /\.html?$/,
		configs: ['.htmlvalidate.json', '.htmlvalidate.js', '.htmlvalidate.mjs', '.htmlvalidate.cjs',
			'html-validate.config.mjs', 'html-validate.config.cjs', 'html-validate.config.js',
			'html-validate.config.mts', 'html-validate.config.cts', 'html-validate.config.ts'],
		// root stops the search for further configuration files above a file.
		default: ['htmlvalidate.json', '{ "root": true, "extends": ["html-validate:recommended"] }\n'],
		args: ['-f', 'json'],
		done: [0, 1],
		read: (r) => JSON.parse(r.stdout || '[]').flatMap((f) => f.messages.map((m) => ({
			file: f.filePath,
			line: m.line ?? null,
			column: m.column ?? null,
			rule: m.ruleId,
			error: m.severity === 2,
			message: m.message,
			url: m.ruleUrl ?? null,
		}))),
	},
};

linter({
	name: 'lint-web',
	title: 'what ESLint, Stylelint and html-validate find in the plain web files',
	what: 'JavaScript, CSS or HTML files outside a package.json repository',
	defaults: true,
	legend: [
		'Errors are [!] and fail the check, as they fail the lint-web workflow;',
		'warnings are [i]. Each names the linter and its rule, whose page says what it',
		'checks.',
	],
	check({ root, die }) {
		const res = { tool: 'lint-web', files: [], findings: [], tools: {} };
		// A repository with a package.json lints through its own scripts.
		if (isFile(path.join(root, 'package.json'))) {
			res.summary = 'package.json present.';
			res.packageJson = true;
			res.findings.push({
				level: 'ok',
				id: 'package-json',
				lines: ['The repository has a package.json and lints through its own scripts; nothing to check.'],
			});
			return res;
		}
		const all = tracked(root, [], die).filter((f) => !inDependencies(f) && !/\.min\.(?:js|css)$/.test(f));
		const parts = [];
		for (const [key, t] of Object.entries(TOOLS)) {
			const files = all.filter((f) => t.files.test(f));
			const config = firstFile(root, t.configs);
			res.tools[key] = { tool: t.name, version: null, config, files };
			if (!files.length) continue;
			if (!modules) die('LINT_MODULES does not name the node_modules of the web linters');
			res.files.push(...files);
			const version = packageVersion(modules, t.pkg, die);
			res.tools[key].version = version;
			parts.push(`${t.name}${version ? ` ${version}` : ''}, ${plural(files.length, 'file', 'files')}, `
				+ `${config ? `configuration ${config}` : 'the default configuration'}.`);
			const args = config ? [] : ['--config', path.join(configDir({ [t.default[0]]: t.default[1] }, modules), t.default[0])];
			const r = runTool(path.join(modules, '.bin', t.pkg), [...t.args, ...args, '--', ...files], { cwd: root, done: t.done, die });
			let found;
			try { found = t.read(r); } catch (e) { die(`the ${t.name} JSON could not be read: ${e.message}\n${r.stderr.trim()}`); }
			for (const m of found) {
				res.findings.push(finding({
					level: m.error ? 'warn' : 'info',
					id: `${key === 'html' ? 'html-validate' : key}/${m.rule}`,
					file: m.file ? path.relative(root, path.resolve(root, m.file)) : null,
					line: m.line,
					column: m.column,
					message: m.message,
					url: m.url,
					extra: { linter: t.name, severity: m.error ? 'error' : 'warning' },
				}));
			}
			if (r.status !== 0 && !found.some((m) => m.error)) die(`${t.name} failed without a finding this analyser can read:\n${r.stderr.trim()}`);
		}
		if (parts.length) res.summary = parts.join('\n  ');
		return res;
	},
});
