#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-shell - what shellcheck finds in the shell scripts of this repository, and
// the names a declaration leaves unset under set -u.
//
// shellcheck (https://www.shellcheck.net) with -x, so a sourced file is followed,
// over every tracked shell script. shellcheck reads a .shellcheckrc by itself. make
// hands in the binary, fetched and checked against its digest. Every finding
// shellcheck reports fails the check; a .shellcheckrc that raises the severity
// keeps the lesser ones from being reported at all.
//
// Beside it, the rule unset-local: in a script that switches on set -u, a name
// that local, declare or typeset declares without a value is unset, and every
// path that reads it before assigning it ends the script with "unbound
// variable". shellcheck has no check for that, so a branch added later aborts
// the script at run time with every check green. The rule asks for a value at
// the declaration, which leaves no such path. A variable that is meant to stay
// unset takes "# ncmake disable=unset-local" on the line before, as a
// shellcheck finding takes "# shellcheck disable=".

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

// == unset-local ==
const UNSET_LOCAL = 'unset-local';
const DIRECTIVE = new RegExp(`#\\s*ncmake\\s+disable=(?:[\\w-]+,)*${UNSET_LOCAL}\\b`);
// A set command that switches on nounset, by its short or its long option.
const NOUNSET = /^[ \t]*set[ \t]+(?:[^#\n]*[ \t])?(?:-[A-Za-z]*u[A-Za-z]*\b|-o[ \t]+nounset\b)/m;
const DECLARERS = new Set(['local', 'declare', 'typeset']);
// The words after which a command starts.
const STARTERS = new Set(['\n', ';', ';;', '&', '&&', '|', '||', '|&', '{', '(', ')', '!',
	'if', 'then', 'elif', 'else', 'while', 'until', 'do']);

// The words of a script with the line each starts on. An operator or a newline is
// a word of its own; a comment and the body of a here-document are no words, and
// a quote, an expansion or a substitution belongs to the word it stands in, to
// any depth and across lines.
function shellWords(src) {
	const out = [];
	const heredocs = [];
	const n = src.length;
	let i = 0;
	let line = 1;
	while (i < n) {
		const c = src[i];
		if (c === '\n') {
			out.push({ w: '\n', line });
			line += 1;
			i += 1;
			while (heredocs.length) {
				const { word, tabs } = heredocs.shift();
				while (i < n) {
					const end = src.indexOf('\n', i);
					const raw = src.slice(i, end < 0 ? n : end);
					i = end < 0 ? n : end + 1;
					line += 1;
					if ((tabs ? raw.replace(/^\t+/, '') : raw) === word) break;
				}
			}
			continue;
		}
		if (c === ' ' || c === '\t') { i += 1; continue; }
		if (c === '\\' && src[i + 1] === '\n') { i += 2; line += 1; continue; }
		if (c === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
		const op = /^(?:;;|&&|\|\||\|&|<<<|<<-|<<|[;&|(){}<>])/.exec(src.slice(i, i + 3));
		if (op) {
			if (op[0] === '<<' || op[0] === '<<-') {
				const m = /^[ \t]*(['"]?)\\?([\w.-]+)\1/.exec(src.slice(i + op[0].length));
				if (m) {
					heredocs.push({ word: m[2], tabs: op[0] === '<<-' });
					i += op[0].length + m[0].length;
					continue;
				}
			}
			out.push({ w: op[0], line });
			i += op[0].length;
			continue;
		}
		const start = line;
		const open = [];
		let w = '';
		while (i < n) {
			const d = src[i];
			const top = open[open.length - 1];
			if (!open.length && /[ \t\n;&|<>()]/.test(d)) break;
			if (d === '\n') line += 1;
			if (top === "'") { w += d; if (d === "'") open.pop(); i += 1; continue; }
			if (d === '\\') { if (src[i + 1] === '\n') line += 1; w += d + (src[i + 1] ?? ''); i += 2; continue; }
			if (top === '`') { w += d; if (d === '`') open.pop(); i += 1; continue; }
			if (d === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) { open.push(`$${src[i + 1]}`); w += d + src[i + 1]; i += 2; continue; }
			if (d === '`') { open.push(d); w += d; i += 1; continue; }
			if (top === '"') { w += d; if (d === '"') open.pop(); i += 1; continue; }
			if (d === "'" || d === '"') { open.push(d); w += d; i += 1; continue; }
			if (top === '${') { w += d; if (d === '}') open.pop(); i += 1; continue; }
			if (top === '$(' || top === '(') {
				if (d === '(') open.push('(');
				else if (d === ')') open.pop();
				w += d;
				i += 1;
				continue;
			}
			// An array assignment, name=( ... ), is one word.
			if (d === '=' && src[i + 1] === '(') { open.push('('); w += '=('; i += 2; continue; }
			w += d;
			i += 1;
		}
		out.push({ w, line: start });
	}
	return out;
}

// The names a declaration leaves without a value, in a script that switches on
// set -u. local - saves the shell options and declares nothing, and -p, -f and
// -F print instead of declaring.
function unsetLocals(src) {
	if (!NOUNSET.test(src)) return [];
	const lines = src.split('\n');
	const exempt = (l) => DIRECTIVE.test(lines[l - 1] ?? '') || DIRECTIVE.test(lines[l - 2] ?? '');
	const words = shellWords(src);
	const found = [];
	let atStart = true;
	for (let k = 0; k < words.length; k += 1) {
		const { w } = words[k];
		if (atStart && DECLARERS.has(w)) {
			let j = k + 1;
			let options = true;
			let declares = true;
			const names = [];
			for (; j < words.length && !STARTERS.has(words[j].w); j += 1) {
				const a = words[j].w;
				if (options && a === '--') { options = false; continue; }
				if (options && /^[-+]/.test(a)) {
					if (a === '-' || /[fFp]/.test(a)) declares = false;
					continue;
				}
				options = false;
				if (/^[A-Za-z_]\w*$/.test(a)) names.push({ name: a, line: words[j].line });
			}
			if (declares) for (const x of names) if (!exempt(x.line)) found.push({ ...x, declarer: w });
			k = j - 1;
			atStart = false;
			continue;
		}
		// An assignment before a command leaves the command in first place.
		atStart = STARTERS.has(w) || (atStart && /^[A-Za-z_]\w*=/.test(w));
	}
	return found;
}

linter({
	name: 'lint-shell',
	title: 'what shellcheck finds in the shell scripts of this repository',
	what: 'shell scripts',
	legend: [
		'Every finding shellcheck reports is [!] and fails the check, as it fails the',
		'lint-shell workflow. Each names the shellcheck code, whose page says why it',
		'matters and how to fix or disable it.',
		`${UNSET_LOCAL} is [!] as well: in a script under set -u, a name that local or`,
		'declare leaves without a value aborts the script on every path that reads it',
		'first. Give it a value, local x="" or local -a x=(); one that is meant to stay',
		`unset takes "# ncmake disable=${UNSET_LOCAL}" and the reason on the line before.`,
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
		for (const file of files) {
			for (const x of unsetLocals(fs.readFileSync(path.join(root, file), 'latin1'))) {
				res.findings.push(finding({
					id: UNSET_LOCAL,
					file,
					line: x.line,
					message: `${x.declarer} ${x.name} has no value, and the script runs with set -u: give it one, ${x.name}="" or ${x.name}=()`,
					url: 'https://github.com/ernolf/ncmake/wiki/Lint#-unset-local',
				}));
			}
		}
		return res;
	},
});
