// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// data - the facts of the world outside an analyser goes by.
//
// What changes over time and can be read from a source, such as the majors of
// nextcloud/server or the Node.js release schedule, is never written into an
// analyser. It is data/<name>.json in the ncmake repo, which a workflow regenerates
// from the sources the file names (data/update/). The core fetches each file a
// goal needs into data/ beside the analysers and refreshes it like them, so an
// analyser reads no upstream source itself. In a checkout of the ncmake repo the
// files are data/ beside lib/.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// { values, read, sources, file } of data/<name>.json, or null where the file is
// not there, offline before the first fetch. A file that is there and cannot be
// parsed throws: the run cannot be carried out, and says why.
export function readData(name) {
	for (const dir of ['./data/', '../data/']) {
		const file = fileURLToPath(new URL(`${dir}${name}.json`, import.meta.url));
		let text;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		let doc;
		try {
			doc = JSON.parse(text);
		} catch (e) {
			throw new Error(`data/${name}.json cannot be parsed: ${e.message}`);
		}
		return { values: doc.values, read: doc.read, sources: doc.sources, file: `data/${name}.json` };
	}
	return null;
}
