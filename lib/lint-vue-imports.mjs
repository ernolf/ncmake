#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-vue-imports - does a source file import the root of @nextcloud/vue.
//
// The root specifier loads the barrel of the whole component library into the
// bundle; an entry point such as @nextcloud/vue/components/NcButton loads one
// component. Four forms reach the barrel: a static import or re-export, a
// side-effect or dynamic import, a CommonJS require, and a test double, where
// both vi.mock and jest.mock end in mock(. Every one of them fails the check, as
// it fails the lint-vue-imports workflow. No linter is involved: the check is the
// one pattern the workflow greps for.

import fs from 'node:fs';
import path from 'node:path';

import { finding, inDependencies, linter, tracked } from './lint-common.mjs';
import { plural } from './report-text.mjs';

// The specifier has to end right after vue, so an entry-point path passes.
const ROOT_IMPORT = /(?:from|import|mock\(|require\()\s*\(?\s*['"]@nextcloud\/vue['"]/;
// A commented-out import is not an import. Only a line that opens with a comment
// marker is dropped, so no real import can be hidden this way.
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

const SOURCE = /\.(?:vue|js|mjs|cjs|jsx|ts|mts|cts|tsx)$/;

linter({
	name: 'lint-vue-imports',
	title: 'does a source file import the root of @nextcloud/vue',
	what: 'Vue, JavaScript or TypeScript files',
	legend: [
		'Every import of the @nextcloud/vue root is [!] and fails the check, as it',
		'fails the lint-vue-imports workflow. Import the component entry point',
		'instead, for example:',
		'  import NcButton from \'@nextcloud/vue/components/NcButton\'',
	],
	check({ root, die }) {
		const files = tracked(root, [], die).filter((f) => !inDependencies(f) && SOURCE.test(f));
		const res = { tool: 'root-import pattern', files, findings: [] };
		if (files.length) res.summary = `The @nextcloud/vue root-import pattern over ${plural(files.length, 'file', 'files')}.`;
		for (const f of files) {
			const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
			for (const [i, l] of lines.entries()) {
				if (!ROOT_IMPORT.test(l) || COMMENT.test(l)) continue;
				res.findings.push(finding({ id: 'nextcloud-vue-root-import', file: f, line: i + 1, message: l.trim() }));
			}
		}
		return res;
	},
});
