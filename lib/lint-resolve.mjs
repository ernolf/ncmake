// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-resolve - preloaded into a linter with --import, so that an import of a
// configuration in the checkout falls back to the packages make hands in.
//
// In the container those packages are /node_modules, where Node looks last
// anyway. With RUNTIME=bare they sit in the ncmake cache, outside every path Node
// searches from the checkout; this registers lint-resolve-hooks.mjs, which tries
// LINT_MODULES once the normal resolution has failed; a require goes through
// NODE_PATH instead (moduleEnv in lint-common.mjs). A package of the checkout
// so wins in both runtimes. module.registerHooks (Node 22.15) runs the hook in
// the thread of the linter; module.register (Node 20.6), which Node 26
// deprecates with a warning on stderr, where Stylelint writes its report, serves
// only a Node without it. On an older Node nothing is registered.

import module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.LINT_MODULES) {
	const data = pathToFileURL(path.join(process.env.LINT_MODULES, 'noop.js')).href;
	if (module.registerHooks) {
		const hooks = await import('./lint-resolve-hooks.mjs');
		hooks.initialize(data);
		module.registerHooks({ resolve: hooks.resolveSync });
	} else if (module.register) {
		module.register('./lint-resolve-hooks.mjs', import.meta.url, { data });
	}
}
