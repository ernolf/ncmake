#!/bin/sh
# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# install-test.sh - the half of make install-test that runs on the server.
#
#   install-test.sh <app id> <output directory>
#
# Runs as root in a container of ghcr.io/ernolf/ncmake-server, an installed
# Nextcloud server, with the app checkout as the working directory. It copies
# build/stage/<app id> into custom_apps, enables the app, lets the web server
# answer a few requests, runs cron.php and leaves what happened in the output
# directory, where lib/install-test.mjs reads it. It judges nothing itself and
# ends with 0 whenever it got as far as writing those files.

set -u

app=$1
out=$2
web=/var/www/html
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
	chown -R --reference=. "$out" 2>/dev/null
	exit 0
}

php -r 'echo PHP_VERSION;' >"$out/php"
occ status --output=json >"$out/status.json" 2>"$out/status.err"

if ! { cp -a "build/stage/$app" "$web/custom_apps/$app" && chown -R www-data:www-data "$web/custom_apps/$app"; } 2>"$out/copy.err"; then
	echo copy >"$out/stopped"
	finish
fi

occ app:enable "$app" >"$out/enable.txt" 2>&1
echo $? >"$out/enable.rc"

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
finish
