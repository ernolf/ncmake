// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// report-text - the terminal form of an ncmake analyser's output.
//
// Figures, tables, findings: the shape every analyser prints its result in, so a
// second one does not invent a second look. Knows nothing about what is being
// measured.

import fs from 'node:fs';
import path from 'node:path';

// == Figures ==
export const num = (n) => (n === null || n === undefined ? '' : n.toLocaleString('en-US'));
export const pct = (x) => `${(x * 100).toFixed(1)} %`;
export const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

// How to run the analyser again with other options. The caller passes its own
// command line as a template with %s for the options, so a hint names the
// command that was actually typed instead of the path of the script inside the
// container.
export function howToRun(envVar, fallback) {
	const cmdline = process.env[envVar] || fallback;
	return (flags) => (cmdline.includes('%s') ? cmdline.replace('%s', flags) : `${cmdline} ${flags}`);
}

// == Tables ==
export function table(head, rows, align) {
	const all = [head, ...rows];
	const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
	const line = (r) => r
		.map((c, i) => {
			const s = String(c ?? '');
			return align[i] === 'r' ? s.padStart(w[i]) : s.padEnd(w[i]);
		})
		.join('  ')
		.replace(/\s+$/, '');
	return [line(head), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join('\n');
}

export function cut(rows, top) {
	if (top === 0 || rows.length <= top) return { rows, hidden: 0 };
	return { rows: rows.slice(0, top), hidden: rows.length - top };
}

// == Findings ==
const MARK = { warn: '[!] ', info: '[i] ', ok: '[ok]' };
const WRAP = 73;   // plus the seven columns the finding marker occupies

// Break a finding into terminal lines. Leading spaces mark a list item and are
// kept, indented by two more on the continuation lines, so an item stays one
// visual block.
function wrap(text, width) {
	const indent = /^ */.exec(text)[0];
	const hang = indent ? `${indent}  ` : '';
	const lines = [];
	let cur = indent;
	for (const word of text.trim().split(/\s+/)) {
		// A unit never starts a line: it stays with the figure it belongs to, even
		// when that takes the line one column past the width.
		const glued = /^B[.,:;)\]]*$/.test(word);
		if (!cur.trim()) cur += word;
		else if (glued || cur.length + 1 + word.length <= width) cur += ` ${word}`;
		else { lines.push(cur); cur = hang + word; }
	}
	if (cur.trim()) lines.push(cur);
	return lines;
}

// Every finding as terminal lines: the marker in the first line's gutter, the
// rest indented under it.
export function renderFindings(list) {
	const out = [];
	for (const f of list) {
		const [first, ...rest] = f.lines;
		for (const [i, l] of wrap(first, WRAP).entries()) out.push(i === 0 ? `  ${MARK[f.level]} ${l}` : `       ${l}`);
		for (const l of rest) for (const w of wrap(l, WRAP)) out.push(`       ${w}`);
	}
	return out;
}

// Worth changing first, nothing found last.
const RANK = { warn: 0, info: 1, ok: 2 };

export const sortFindings = (list) => [...list].sort((a, b) => RANK[a.level] - RANK[b.level]);

export const LEGEND = '[!] worth changing   [i] worth knowing   [ok] nothing found';

// == Paths ==
// A directory the analyser resolved is absolute; in one sentence with a relative
// one as it was given that reads wrong, so name it the way it was given.
export function shortPath(p) {
	const rel = path.relative(process.cwd(), p);
	return !rel || rel.startsWith('..') ? p : rel;
}

// == The JSON ==
// What --json prints and --json-file writes. JSON.stringify writes half of a
// surrogate pair as an escape that strict parsers such as jq refuse, and with it
// the whole file. A string like that is a defect of the analyser, so the run
// stops before anything is printed or written and names the field.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function loneSurrogateAt(v, at) {
	if (typeof v === 'string') return LONE_SURROGATE.test(v) ? at : null;
	if (v === null || typeof v !== 'object') return null;
	for (const [k, x] of Object.entries(v)) {
		const p = Array.isArray(v) ? `${at}[${k}]` : `${at}.${k}`;
		const found = LONE_SURROGATE.test(k) ? p : loneSurrogateAt(x, p);
		if (found) return found;
	}
	return null;
}

export function toJson(value, die, replacer = null) {
	const json = `${JSON.stringify(value, replacer, 2)}\n`;
	// Escaped surrogates only appear unpaired: a pair is written as it is.
	if (/(?<!\\)(?:\\\\)*\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(json)) {
		die(`the JSON has half a character at ${loneSurrogateAt(JSON.parse(json), '') || '.'}, a defect of the analyser`);
	}
	return json;
}

// == The JSON file ==
// --json-file takes what --json prints, from the run that prints the text report.
// The JSON goes to a file of its own in the same directory first and is renamed
// over the target, so a run that fails on the way leaves an existing file whole.
export function writeJsonFile(file, json, die) {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	try {
		fs.writeFileSync(tmp, json);
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		die(`could not write the JSON file: ${e.message}`);
	}
}
