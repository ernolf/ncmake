// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// route-plan - the routes of an app as requests a server can be sent.
//
// make runtime-audit requests every route of the inventory of make php-audit,
// make profile measures them: both fill the parameters of a path the same way,
// so a route one of them requests is one the other can request too. A parameter
// is filled from the defaults of the route or from "<name>=<value> ...", as
// runtime_params in ncmake.mk sets it, and a route with one left unfilled is not
// requested: nothing is guessed.

export const has = (e, name) => e.attributes.includes(name) || e.annotations.includes(name);

// "<name>=<value> ...", as ncmake.mk sets runtime_params.
export function readParams(text) {
	const params = {};
	for (const pair of (text ?? '').split(/\s+/).filter(Boolean)) {
		const i = pair.indexOf('=');
		if (i > 0) params[pair.slice(0, i)] = pair.slice(i + 1);
	}
	return params;
}

// A route is requested as the user when it declares that no admin is needed or
// that it is public, and as the admin otherwise. route is the index of the
// endpoint in the inventory.
export function plan(inv, params) {
	const routes = [];
	const skipped = [];
	inv.inventory.endpoints.forEach((e, i) => {
		if (e.kind === 'DAV' || e.kind === 'capability') return;
		const missing = [];
		const url = e.path.replace(/\{([^}]+)\}/g, (all, name) => {
			const v = params[name] ?? e.defaults?.[name];
			if (v === undefined || v === null || v === '') { missing.push(name); return all; }
			return encodeURIComponent(String(v)).replace(/%2F/gi, '/');
		});
		if (missing.length) { skipped.push({ route: i, verb: e.verb, path: e.path, missing }); return; }
		const as = has(e, 'NoAdminRequired') || has(e, 'PublicPage') ? 'user' : 'admin';
		routes.push({ route: i, verb: e.verb, path: url, as });
	});
	return { routes, skipped };
}
