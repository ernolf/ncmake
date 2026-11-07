// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-stylelint-config - the configuration lint-web hands Stylelint in place of
// the checkout's own, LINT_STYLELINT_CONFIG, when Node does not find
// LINT_MODULES from the checkout, as with RUNTIME=bare.
//
// Stylelint resolves extends, plugins, processors and customSyntax with a
// resolver of its own, from the directory of the configuration and then from its
// working directory, which neither a resolve hook nor NODE_PATH reaches. This
// loads the configuration as Stylelint does and resolves each name the same way,
// with Stylelint's own resolver, falling back to LINT_MODULES; a name found in
// neither stays as it is, so Stylelint reports it. A package of the checkout so
// wins. A configuration it extends that lies outside LINT_MODULES would resolve
// its own names from where it lies again, so it goes in rewritten the same way,
// with its ignoreFiles made absolute. Stylelint takes the result as one
// configuration for every file, with --config-basedir the directory of the
// original.

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modules = process.env.LINT_MODULES;
const stylelint = path.join(modules, 'stylelint');
const { cosmiconfig } = createRequire(path.join(stylelint, 'package.json'))('cosmiconfig');
const { default: resolveSilent } = await import(pathToFileURL(path.join(stylelint, 'lib', 'utils', 'resolveSilent.mjs')).href);
const explorer = cosmiconfig('stylelint');

const outside = (file) => path.relative(modules, file).startsWith('..');
const absolute = (dir, glob) => (glob.startsWith('!') ? `!${path.resolve(dir, glob.slice(1))}` : path.resolve(dir, glob));

async function load(file) {
	return (await explorer.load(file))?.config ?? {};
}

async function rewrite(config, dir) {
	const resolve = (name) => (typeof name === 'string'
		? resolveSilent(dir, name) ?? resolveSilent(process.cwd(), name) ?? resolveSilent(modules, name) ?? name
		: name);
	const out = { ...config };
	if (out.extends !== undefined) {
		out.extends = await Promise.all([out.extends].flat().map(async (name) => {
			const file = resolve(name);
			return typeof file === 'string' && path.isAbsolute(file) && outside(file) ? rewrite(await load(file), path.dirname(file)) : file;
		}));
	}
	for (const key of ['plugins', 'processors']) {
		if (out[key] !== undefined) out[key] = [out[key]].flat().map(resolve);
	}
	if (out.customSyntax !== undefined) out.customSyntax = resolve(out.customSyntax);
	if (out.ignoreFiles !== undefined) out.ignoreFiles = [out.ignoreFiles].flat().map((glob) => absolute(dir, glob));
	if (Array.isArray(out.overrides)) out.overrides = await Promise.all(out.overrides.map((o) => rewrite(o, dir)));
	return out;
}

const file = process.env.LINT_STYLELINT_CONFIG;
export default await rewrite(await load(file), path.dirname(file));
