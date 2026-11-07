// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// lint-resolve-hooks - the resolve hook lint-resolve.mjs registers. A package
// name that the normal resolution does not find is resolved again as if it were
// imported from the directory of LINT_MODULES. A relative path, an absolute path
// and a URL are left alone: they name a file, not a package. resolveSync is the
// form module.registerHooks takes, resolve the one of module.register.

let parent = null;

export function initialize(data) {
	parent = data;
}

const again = (specifier, e) => e?.code === 'ERR_MODULE_NOT_FOUND'
	&& parent && !/^[./]/.test(specifier) && !URL.canParse(specifier);

export function resolveSync(specifier, context, next) {
	try {
		return next(specifier, context);
	} catch (e) {
		if (!again(specifier, e)) throw e;
		return next(specifier, { ...context, parentURL: parent });
	}
}

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (e) {
		if (!again(specifier, e)) throw e;
		return next(specifier, { ...context, parentURL: parent });
	}
}
