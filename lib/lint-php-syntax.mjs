#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-php-syntax - what php -l finds in the PHP files of this repository, per
// PHP version.
//
// php -l over every tracked PHP file, once for each PHP version the repository
// names, as the lint-php-syntax workflow does. PHP runs outside this analyser:
// make lints the files in one PHP container per version, or with the php of the
// host, and hands in a directory with the output and the exit code of each run,
// <version>.out and <version>.rc. An output opens with the exact PHP version
// that ran. This analyser reads them and makes one report of them.

import fs from 'node:fs';
import path from 'node:path';

import { finding, linter, tracked } from './lint-common.mjs';
import { plural } from './report-text.mjs';

const output = process.env.LINT_PHP_OUTPUT || null;

// A diagnostic as php prints it with display_errors on and log_errors off.
const DIAGNOSTIC = /^(?:PHP )?(Parse error|Fatal error|Warning|Deprecated|Notice):\s+(.*) in (.+) on line (\d+)$/;
// The line php -l closes a file with that it could not compile.
const FAILED = /^Errors parsing (.+)$/;

linter({
	name: 'lint-php-syntax',
	title: 'what php -l finds in the PHP files of this repository, per PHP version',
	what: 'PHP files',
	legend: [
		'A parse or fatal error is [!] and fails the check, as it fails the',
		'lint-php-syntax workflow, under the PHP version that reports it. A warning or',
		'deprecation php -l prints at compile time is [i]: it passes there, but the',
		'next PHP version may turn it into an error.',
	],
	check({ root, die }) {
		const files = tracked(root, ['*.php', '*.phtml'], die);
		const res = { tool: 'php -l', files, findings: [], versions: [] };
		if (!files.length) return res;
		if (!output) die('LINT_PHP_OUTPUT does not name the directory of the php -l runs');
		let names;
		try { names = fs.readdirSync(output).filter((n) => n.endsWith('.rc')); } catch (e) { die(`${output} cannot be read: ${e.message}`); }
		if (!names.length) die(`${output} holds no php -l run`);
		for (const name of names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
			const asked = name.slice(0, -'.rc'.length);
			const rc = Number(fs.readFileSync(path.join(output, name), 'utf8').trim());
			let text = '';
			try { text = fs.readFileSync(path.join(output, `${asked}.out`), 'utf8'); } catch { /* reported below */ }
			// What the container runtime prints while it pulls the image comes first.
			const all = text.split('\n');
			const at = all.findIndex((l) => /^\d+\.\d+\.\d+\S*$/.test(l.trim()));
			const version = at < 0 ? null : all[at].trim();
			const lines = all.slice(at + 1);
			res.versions.push({ asked, version, status: rc });
			if (!version) {
				res.findings.push(finding({ id: `php-${asked}`, message: `PHP ${asked} did not run: ${text.trim() || `exit code ${rc}`}` }));
				continue;
			}
			const own = [];
			for (const l of lines) {
				const d = DIAGNOSTIC.exec(l.trim());
				if (d) {
					const [, kind, message, file, line] = d;
					own.push(finding({
						level: /error$/.test(kind) ? 'warn' : 'info',
						id: `php-${asked}/${kind.toLowerCase().replace(' ', '-')}`,
						file: path.relative(root, path.resolve(root, file)),
						line: Number(line),
						message,
						extra: { php: version, kind },
					}));
					continue;
				}
				const f = FAILED.exec(l.trim());
				// A file php -l refuses without a diagnostic this analyser reads still
				// fails, as the exit code of php says.
				if (f && !own.some((o) => o.level === 'warn' && o.file === path.relative(root, path.resolve(root, f[1])))) {
					own.push(finding({ id: `php-${asked}/error`, file: f[1], message: 'php -l cannot compile this file.', extra: { php: version } }));
				}
			}
			if (rc !== 0 && !own.some((o) => o.level === 'warn')) {
				own.push(finding({ id: `php-${asked}`, message: `php -l under PHP ${version} exits with ${rc}:\n${lines.join('\n').trim()}` }));
			}
			res.findings.push(...own);
		}
		res.summary = `php -l over ${plural(files.length, 'file', 'files')}, PHP ${res.versions.map((v) => v.version ?? `${v.asked} (did not run)`).join(', ')}.`;
		return res;
	},
});
