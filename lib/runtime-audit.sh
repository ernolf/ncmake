#!/bin/sh
# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# runtime-audit.sh - the half of make runtime-audit that runs on the server.
#
#   runtime-audit.sh <app id> <output directory> [<database>]
#
# Runs as root in a container of ghcr.io/ernolf/ncmake-server, an installed
# Nextcloud server, with the app checkout as the working directory. It copies
# build/stage/<app id> into custom_apps, enables the app at log level 0, runs
# occ upgrade where the server asks for it, and uses what the app registers:
# the requests of build/runtime-audit/plan, its occ commands, its background
# jobs, the setup checks, its settings pages, the capabilities, WebDAV, and
# once more disabling and enabling it. Every step is
# one line of <output directory>/steps with the lines of nextcloud.log it
# covers, so lib/runtime-audit.mjs can tell which step logged what. It judges
# nothing itself and ends with 0 whenever it got as far as writing those files.
#
# A database of "pgsql <user> <password> <name>" moves the server onto the
# PostgreSQL container make started beside it, and an app whose <php
# max-version> the server refuses is enabled with it raised; lib/server-setup.sh
# does both, as for make install-test.

set -u
# sort and comm have to agree on one order.
export LC_ALL=C

app=$1
out=$2
database=${3:-}
dir=$(dirname "$out")
web=/var/www/html
log=$web/data/nextcloud.log
# The admin account the image was installed with, and a user without rights
# that exists for this run only.
admin=admin:admin
user=ncmake-user:$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
tab=$(printf '\t')
# The namespace of the app: the one info.xml names, or its id with a capital
# first letter, as the server derives it.
ns=$(sed -n 's:.*<namespace>\(.*\)</namespace>.*:\1:p' "build/stage/$app/appinfo/info.xml" | head -n 1)
[ -n "$ns" ] || ns=$(printf '%s' "$app" | cut -c1 | tr '[:lower:]' '[:upper:]')$(printf '%s' "$app" | cut -c2-)

occ() { runuser -u www-data -- php "$web/occ" "$@"; }

# begin; ...; record <kind> <name> <result>: one step, with the first and the
# last line of the log that it wrote.
loglines() { if [ -f "$log" ]; then wc -l <"$log"; else echo 0; fi; }
begin() { from=$(loglines); }
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$from" "$(loglines)" >>"$out/steps"; }

# request <kind> <name> <verb> <as> <path> [curl option ...]: one request as
# nobody, as the user or as the admin. The OCS header is what a client that is
# no browser sends; with it the server asks for no CSRF token.
request() {
	kind=$1
	name=$2
	verb=$3
	as=$4
	path=$5
	shift 5
	case $as in
		admin) set -- -u "$admin" "$@" ;;
		user) set -- -u "$user" "$@" ;;
	esac
	begin
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 -X "$verb" -H 'OCS-APIRequest: true' "$@" "http://localhost$path") || code=000
	record "$kind" "$name" "$code"
}

# The names of the occ commands, the background jobs as "<id> <class>" and the
# settings forms as "<admin|personal> <section> <class>", each sorted, so comm
# names what the app added.
commands() { occ list --raw 2>/dev/null | cut -d' ' -f1 | sort; }
jobs() {
	occ background-job:list --limit=100000 --output=json 2>/dev/null \
		| php -r 'foreach (json_decode(stream_get_contents(STDIN), true) ?? [] as $j) { echo $j["id"], " ", $j["class"], "\n"; }' | sort
}
settings() { runuser -u www-data -- php "$dir/runtime-audit.php" settings 2>/dev/null | sort; }

# The files are written as root; hand them to the owner of the checkout, so the
# host can read and remove them whatever runtime started the container.
finish() {
	if [ -f "$log" ]; then cp "$log" "$out/nextcloud.log"; else : >"$out/nextcloud.log"; fi
	chown -R --reference=. "$out" 2>/dev/null
	exit 0
}

: >"$out/steps"
php -r 'echo PHP_VERSION;' >"$out/php"
occ status --output=json >"$out/status.json" 2>"$out/status.err"

. "$dir/server-setup.sh"
# shellcheck disable=SC2086 # the database is the type and its three values
if ! db_setup "$out" $database; then
	echo database >"$out/stopped"
	finish
fi

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

OC_PASS=${user#*:} occ user:add --password-from-env "${user%%:*}" >"$out/user.txt" 2>&1

# What the server has without the app. An app the server ships is disabled
# first, so its own commands and settings count as new.
if [ -d "$web/apps/$app" ]; then
	occ app:disable "$app" >"$out/shipped.txt" 2>&1
fi
commands >"$out/commands.before"
settings >"$out/settings.before"
curl -s --max-time 120 -u "$admin" -H 'OCS-APIRequest: true' -o "$out/capabilities.before.json" 'http://localhost/ocs/v2.php/cloud/capabilities?format=json'

occ config:system:set loglevel --value=0 --type=integer >/dev/null 2>&1

if ! { cp -a "build/stage/$app" "$web/custom_apps/$app" && chown -R www-data:www-data "$web/custom_apps/$app"; } 2>"$out/copy.err"; then
	echo copy >"$out/stopped"
	finish
fi
php_cap "$out" "$web/custom_apps/$app"

begin
occ app:enable "$app" >"$out/enable.txt" 2>&1
rc=$?
record enable "$app" "$rc"
php_retry "$out" "$rc"
if [ "$rc" -ne 0 ]; then
	echo enable >"$out/stopped"
	finish
fi

# A newer release of an app the server ships, copied into custom_apps, wins
# over the shipped one, and the server answers 503 until occ upgrade ran.
if occ status --output=json 2>/dev/null | grep -q '"needsDbUpgrade":true'; then
	begin
	occ upgrade --no-interaction >"$out/upgrade.txt" 2>&1
	rc=$?
	record upgrade "$app" "$rc"
	if [ "$rc" -ne 0 ]; then
		echo upgrade >"$out/stopped"
		finish
	fi
fi

# The routes the router of the server has for the app.
occ router:list --output=json "$app" >"$out/routes.json" 2>"$out/routes.err"
echo $? >"$out/routes.rc"

commands >"$out/commands.after"
comm -13 "$out/commands.before" "$out/commands.after" | while read -r name; do
	begin
	timeout 300 runuser -u www-data -- php "$web/occ" "$name" --help >/dev/null 2>>"$out/commands.err"
	record command "$name" $?
done

# The jobs of the app are those of its namespace: occ upgrade adds jobs of the
# server, and the jobs of an app the server ships are there before it is
# enabled again.
jobs >"$out/jobs.after"
while read -r id class; do
	case $class in
		"OCA\\$ns\\"*) ;;
		*) continue ;;
	esac
	begin
	echo "== $class" >>"$out/jobs.txt"
	timeout 600 runuser -u www-data -- php "$web/occ" background-job:execute --force-execute "$id" >>"$out/jobs.txt" 2>&1
	record job "$class" $?
done <"$out/jobs.after"

begin
timeout 600 runuser -u www-data -- php "$web/occ" setupchecks --output=json >"$out/setupchecks.json" 2>"$out/setupchecks.err"
record setupchecks all $?

# A verb that carries a body gets one, as every client of an app sends it: an
# empty JSON object. A request without a Content-Type is one no client sends, and
# an app that reads its parameters by the content type rightly refuses it.
while IFS=$tab read -r name verb as path; do
	case $verb in
		POST | PUT | PATCH) request request "$name:$as" "$verb" "$as" "$path" -H 'Content-Type: application/json' --data '{}' ;;
		*) request request "$name:$as" "$verb" "$as" "$path" ;;
	esac
done <"$dir/plan"

settings >"$out/settings.after"
comm -13 "$out/settings.before" "$out/settings.after" | cut -d' ' -f1,2 | sort -u | while read -r kind section; do
	case $kind in
		admin) path=/index.php/settings/admin/$section ;;
		*) path=/index.php/settings/user/$section ;;
	esac
	request settings "$kind/$section" GET admin "$path"
done

request capabilities all GET admin '/ocs/v2.php/cloud/capabilities?format=json' -o "$out/capabilities.after.json"
request dav all PROPFIND admin /remote.php/dav/files/admin/ -H 'Depth: 1'

begin
occ app:disable "$app" >"$out/disable.txt" 2>&1
record disable "$app" $?
begin
occ app:enable "$app" >"$out/reenable.txt" 2>&1
record reenable "$app" $?

finish
