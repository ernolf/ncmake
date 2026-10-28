#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-shell - what shellcheck finds in the shell scripts of this repository.
//
// shellcheck (https://www.shellcheck.net) with -x, so a sourced file is followed,
// over every tracked shell script. shellcheck reads a .shellcheckrc by itself. make
// hands in the binary, fetched and checked against its digest. Every finding
// shellcheck reports fails the check; a .shellcheckrc that raises the severity
// keeps the lesser ones from being reported at all.

import fs from 'node:fs';
import path from 'node:path';

import { finding, firstFile, linter, runTool, tracked } from './lint-common.mjs';

const shellcheck = process.env.LINT_SHELLCHECK || 'shellcheck';

// The first line of a file, read without loading a binary in whole.
function firstLine(file) {
	const buf = Buffer.alloc(256);
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		return buf.subarray(0, n).toString('latin1').split('\n')[0];
	} catch {
		return '';
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

// *.sh and *.bash by name; every other file by a shebang that names sh, bash, dash
// or ksh.
function collect(root, die) {
	return tracked(root, [], die).filter((f) => /\.(?:sh|bash)$/.test(f)
		|| /^#!.*\b(?:ba|da|k)?sh\b/.test(firstLine(path.join(root, f))));
}

linter({
	name: 'lint-shell',
	title: 'what shellcheck finds in the shell scripts of this repository',
	what: 'shell scripts',
	legend: [
		'Every finding shellcheck reports is [!] and fails the check, as it fails the',
		'lint-shell workflow. Each names the shellcheck code, whose page says why it',
		'matters and how to fix or disable it.',
	],
	check({ root, die }) {
		const files = collect(root, die);
		const res = { tool: 'shellcheck', config: firstFile(root, ['.shellcheckrc']), files, findings: [] };
		if (!files.length) return res;
		res.version = /version:\s*(\S+)/.exec(runTool(shellcheck, ['--version'], { cwd: root, done: [0], die }).stdout)?.[1] ?? null;
		const r = runTool(shellcheck, ['-x', '-f', 'json1', '--', ...files], { cwd: root, die });
		let raw;
		try { raw = JSON.parse(r.stdout).comments; } catch (e) { die(`shellcheck's JSON could not be read: ${e.message}`); }
		res.findings = raw.map((c) => finding({
			id: `SC${c.code}`,
			file: c.file,
			line: c.line,
			column: c.column,
			message: `${c.level}: ${c.message}`,
			url: `https://www.shellcheck.net/wiki/SC${c.code}`,
			extra: { severity: c.level },
		}));
		return res;
	},
});
