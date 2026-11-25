#!/bin/sh
# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# install-test.sh - the half of make install-test that runs on the server.
#
#   install-test.sh <app id> <output directory> [<app tree> [<test tree> [<coverage> [<database>]]]]
#
# Runs as root in a container of ghcr.io/ernolf/ncmake-server, an installed
# Nextcloud server, with the app checkout as the working directory. It copies
# the app tree, build/stage/<app id> or the unpacked tarball make install-test
# TARBALL= names, into custom_apps, enables the app, lets the web server
# answer a few requests, runs cron.php and leaves what happened in the output
# directory, where lib/install-test.mjs reads it. It judges nothing itself and
# ends with 0 whenever it got as far as writing those files.
#
# A test tree, the checkout with its dev dependencies as make install-test
# PHPUNIT=1 prepares it, then takes the place of the app in custom_apps, where
# the test bootstraps of apps expect it, and the app's PHPUnit suite runs
# against the same server. That happens after nextcloud.log is copied, so what
# the tests log does not count as a finding of the install. A coverage of 1
# runs it with pcov switched on.
#
# A database of "pgsql <user> <password> <name>" moves the server onto the
# PostgreSQL container make started beside it, and an app whose <php
# max-version> the server refuses is enabled with it raised; lib/server-setup.sh
# does both. It also installs the apps make fetched for an app that needs
# another one, and names in missing the namespaces of those a run lacked.

set -u

app=$1
out=$2
src=${3:-build/stage/$app}
tests=${4:-}
coverage=${5:-}
database=${6:-}
web=/var/www/html
# The facts of data/ the suite needs; make install-test copies them beside this script.
data=$(cd "$(dirname "$0")" && pwd)/tool-configs.json
# The admin account the image was installed with.
auth=admin:admin

occ() { runuser -u www-data -- php "$web/occ" "$@"; }

# request <name> <path> [curl option ...]: one line "<name> <status> <path>".
request() {
	name=$1
	path=$2
	shift 2
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$@" "http://localhost$path") || code=000
	echo "$name $code $path" >>"$out/requests"
}

# The files are written as root; hand them to the owner of the checkout, so the
# host can read and remove them whatever runtime started the container.
finish() {
	deps_missing "$out" "$src"
	chown -R --reference=. "$out" 2>/dev/null
	exit 0
}

php -r 'echo PHP_VERSION;' >"$out/php"
occ status --output=json >"$out/status.json" 2>"$out/status.err"

. "$(dirname "$0")/server-setup.sh"
# shellcheck disable=SC2086 # the database is the type and its three values
if ! db_setup "$out" $database; then
	echo database >"$out/stopped"
	finish
fi
deps_setup "$out"

if ! { cp -a "$src" "$web/custom_apps/$app" && chown -R www-data:www-data "$web/custom_apps/$app"; } 2>"$out/copy.err"; then
	echo copy >"$out/stopped"
	finish
fi
php_cap "$out" "$web/custom_apps/$app"

occ app:enable "$app" >"$out/enable.txt" 2>&1
echo $? >"$out/enable.rc"
php_retry "$out" "$(cat "$out/enable.rc")"

apache2-foreground >"$out/apache.log" 2>&1 &
i=0
until curl -fs -o /dev/null --max-time 5 http://localhost/status.php; do
	i=$((i + 1))
	if [ "$i" -ge 30 ]; then
		echo apache >"$out/stopped"
		finish
	fi
	sleep 1
done

: >"$out/requests"
request status /status.php
request login /index.php/login
request capabilities '/ocs/v2.php/cloud/capabilities?format=json' -u "$auth" -H 'OCS-APIRequest: true'
request dashboard /index.php/apps/dashboard/ -u "$auth"
request files /index.php/apps/files/ -u "$auth"
request settings-user /index.php/settings/user -u "$auth"
request settings-admin /index.php/settings/admin -u "$auth"
request app "/index.php/apps/$app/" -u "$auth"
request dav /remote.php/dav/files/admin/ -u "$auth" -X PROPFIND -H 'Depth: 1'

runuser -u www-data -- php "$web/cron.php" >"$out/cron.txt" 2>&1
echo $? >"$out/cron.rc"

occ app:list --output=json >"$out/apps.json" 2>/dev/null

if [ -f "$web/data/nextcloud.log" ]; then
	cp "$web/data/nextcloud.log" "$out/nextcloud.log"
else
	: >"$out/nextcloud.log"
fi

# The configuration the test:unit script of composer.json names, as the CI
# templates of Nextcloud run it, or else the first configuration file PHPUnit
# looks for, in the root or in tests/. Those names are phpunit/files of
# data/tool-configs.json, which make install-test copies beside this script.
phpunit_config() {
	# shellcheck disable=SC2016 # the variables are PHP, not shell
	php -r '
		$c = json_decode((string) @file_get_contents("composer.json"), true);
		foreach ((array) ($c["scripts"]["test:unit"] ?? []) as $cmd) {
			if (is_string($cmd) && preg_match("/(?:^|\s)(?:-c|--configuration)[= ]+(\S+)/", $cmd, $m) && is_file($m[1])) { echo $m[1]; exit; }
		}
		$d = json_decode((string) @file_get_contents($argv[1]), true);
		foreach (["", "tests/"] as $dir) {
			foreach ((array) ($d["values"]["phpunit"]["files"] ?? []) as $f) {
				if (is_file($dir . $f)) { echo $dir . $f; exit; }
			}
		}' "$1"
}

if [ -n "$tests" ]; then
	cd "$tests" || finish
	config=$(phpunit_config "$data")
	bin=
	for b in vendor-bin/phpunit/vendor/bin/phpunit vendor/bin/phpunit; do
		if [ -f "$b" ]; then
			bin=$b
			break
		fi
	done
	cd - >/dev/null || finish
	if [ -z "$config" ]; then
		echo none >"$out/phpunit.state"
	elif [ -z "$bin" ]; then
		echo nobin >"$out/phpunit.state"
	elif ! { rm -rf "$web/custom_apps/$app" && cp -a "$tests" "$web/custom_apps/$app" && chown -R www-data:www-data "$web/custom_apps/$app"; } 2>"$out/phpunit.copy.err"; then
		echo copy >"$out/phpunit.state"
	else
		echo ran >"$out/phpunit.state"
		echo "$config" >"$out/phpunit.config"
		report=$(mktemp -d)
		chown www-data:www-data "$report"
		set -- -d memory_limit=-1
		if [ "$coverage" = 1 ]; then
			set -- "$@" -d pcov.enabled=1 -d "pcov.directory=$web/custom_apps/$app"
		fi
		set -- "$@" "$bin" -c "$config" --log-junit "$report/junit.xml"
		if [ "$coverage" = 1 ]; then
			set -- "$@" --coverage-clover "$report/coverage.xml" --coverage-html "$report/coverage"
		fi
		(cd "$web/custom_apps/$app" && runuser -u www-data -- php "$@") >"$out/phpunit.txt" 2>&1
		echo $? >"$out/phpunit.rc"
		cp -a "$report/." "$out/" 2>/dev/null
		rm -rf "$report"
	fi
fi
finish
