#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-version - do the version files of an app agree with appinfo/info.xml.
//
// The App Store and the server read the version in appinfo/info.xml, npm and
// composer read their own manifest. Every tracked package.json, composer.json and
// the two root entries of package-lock.json that state a version are held against
// info.xml, and each one that differs fails the check, as it fails the
// lint-version workflow. The versions are compared as written: make version writes
// the same string into every file, and 1.2.0-beta.1 is not 1.2.0-rc.1.

import fs from 'node:fs';
import path from 'node:path';

import { finding, linter, tracked } from './lint-common.mjs';
import { plural } from './report-text.mjs';

const INFO = 'appinfo/info.xml';

// Each manifest with the places in it that state the version.
const MANIFESTS = [
	['package.json', [['version', (j) => j.version]]],
	['composer.json', [['version', (j) => j.version]]],
	['package-lock.json', [
		['version', (j) => j.version],
		['packages[""].version', (j) => j.packages?.['']?.version],
	]],
];

// info.xml is read textually, as the other analysers do.
function infoVersion(root) {
	const xml = fs.readFileSync(path.join(root, INFO), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
	return xml.match(/<version(?:\s[^>]*)?>([\s\S]*?)<\/version>/)?.[1].trim() || null;
}

linter({
	name: 'lint-version',
	title: 'do the version files of an app agree with appinfo/info.xml',
	what: 'version files',
	legend: [
		'Every version that differs from the one in appinfo/info.xml is [!] and fails',
		'the check, as it fails the lint-version workflow, and so is a manifest that is',
		'not valid JSON. make version bumps info.xml, composer.json and package.json and',
		're-syncs the lockfile in one step, so they cannot drift apart. A file that',
		'states no version is not checked.',
	],
	check({ root, die }) {
		const present = new Set(tracked(root, [INFO, ...MANIFESTS.map(([f]) => f)], die));
		const res = { tool: 'version comparison', files: [], findings: [] };
		if (!present.has(INFO)) {
			res.findings.push({ level: 'ok', id: 'no-info-xml', lines: [`No tracked ${INFO}; nothing to compare against.`] });
			return res;
		}
		const reference = infoVersion(root);
		res.files.push(INFO);
		if (!reference) {
			res.summary = `${INFO} states no version.`;
			res.findings.push(finding({ id: 'no-version', file: INFO, message: `${INFO} states no version, which the App Store requires.` }));
			return res;
		}
		let stated = 0;
		for (const [file, keys] of MANIFESTS) {
			if (!present.has(file)) continue;
			res.files.push(file);
			let json;
			try {
				json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
			} catch (e) {
				res.findings.push(finding({ id: 'unreadable-json', file, message: `not valid JSON, so its version cannot be checked: ${e.message}` }));
				continue;
			}
			for (const [key, get] of keys) {
				const v = get(json);
				if (typeof v !== 'string') continue;
				stated += 1;
				if (v !== reference) {
					res.findings.push(finding({ id: 'version-drift', file, message: `${key} is ${v}, ${INFO} says ${reference}` }));
				}
			}
		}
		res.summary = stated
			? `Version ${reference} of ${INFO} against ${plural(stated, 'version', 'versions')} in the manifests.`
			: `Version ${reference} of ${INFO}; no manifest states a version.`;
		return res;
	},
});
