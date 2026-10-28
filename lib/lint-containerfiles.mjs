#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-containerfiles - what hadolint finds in the Containerfiles of this
// repository.
//
// hadolint (https://github.com/hadolint/hadolint) over every tracked Containerfile
// and Dockerfile, with shellcheck over its RUN instructions built in. hadolint reads
// .hadolint.yaml or .hadolint.yml from the working directory, the checkout, by
// itself. make hands in the binary of its GitHub release, fetched and checked
// against its digest.

import fs from 'node:fs';
import path from 'node:path';

import { finding, firstFile, inDependencies, linter, runTool, tracked } from './lint-common.mjs';

const hadolint = process.env.LINT_HADOLINT || 'hadolint';

const CONFIGS = ['.hadolint.yaml', '.hadolint.yml'];

// hadolint's severities from the highest down. A finding at or above the failure
// threshold fails, as hadolint's exit code says; its default threshold is info.
const SEVERITIES = ['error', 'warning', 'info', 'style'];

const NAME = /^(?:(?:Container|Docker)file(?:\..+)?|.+\.(?:Container|Docker|container|docker)file)$/;

// The threshold the configuration sets, read as hadolint reads its two keys; the
// environment variables hadolint also takes are not set by make.
function threshold(root, config) {
	let text = '';
	if (config) { try { text = fs.readFileSync(path.join(root, config), 'utf8'); } catch { /* hadolint reports it */ } }
	if (/^no-fail:\s*true\s*(?:#.*)?$/m.test(text)) return 'none';
	return /^failure-threshold:\s*["']?(\w+)/m.exec(text)?.[1] ?? 'info';
}

linter({
	name: 'lint-containerfiles',
	title: 'what hadolint finds in the Containerfiles of this repository',
	what: 'Containerfiles',
	legend: [
		'A finding at or above hadolint\'s failure threshold is [!] and fails the check,',
		'as it fails the lint-containerfiles workflow; the threshold is info unless',
		'the configuration sets failure-threshold, so style findings are [i]. Each',
		'names the hadolint or shellcheck rule, whose page says how to fix it.',
	],
	check({ root, die }) {
		const files = tracked(root, [], die)
			.filter((f) => !inDependencies(f) && !f.endsWith('.license') && NAME.test(path.posix.basename(f)));
		const config = firstFile(root, CONFIGS);
		const res = { tool: 'hadolint', config, files, findings: [] };
		if (!files.length) return res;
		res.version = /(\d+\.\d+\.\d+\S*)/.exec(runTool(hadolint, ['--version'], { cwd: root, done: [0], die }).stdout)?.[1] ?? null;
		const r = runTool(hadolint, ['-f', 'json', '--', ...files], { cwd: root, die });
		let raw;
		try { raw = JSON.parse(r.stdout || '[]'); } catch (e) { die(`hadolint's JSON could not be read: ${e.message}`); }
		const limit = threshold(root, config);
		const fails = (level) => limit !== 'none' && SEVERITIES.indexOf(level) <= SEVERITIES.indexOf(limit);
		res.findings = raw.map((h) => finding({
			level: fails(h.level) ? 'warn' : 'info',
			id: h.code,
			file: h.file,
			line: h.line,
			column: h.column,
			message: `${h.level}: ${h.message}`,
			url: /^DL/.test(h.code) ? `https://github.com/hadolint/hadolint/wiki/${h.code}`
				: /^SC/.test(h.code) ? `https://www.shellcheck.net/wiki/${h.code}` : null,
			extra: { severity: h.level },
		}));
		// hadolint's exit code is the verdict; a threshold read differently here
		// must not let a failed run pass.
		if (r.status !== 0 && !res.findings.some((f) => f.level === 'warn')) {
			res.findings.push(finding({ id: 'hadolint', message: `hadolint exits with ${r.status} on these files.` }));
		}
		return res;
	},
});
