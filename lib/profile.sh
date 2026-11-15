#!/bin/sh
# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# profile.sh - the half of make profile that runs on the server.
#
#   profile.sh <app id> <output directory> <rounds>
#
# Runs as root in a container of ghcr.io/ernolf/ncmake-server, an installed
# Nextcloud server, with the app checkout as the working directory. The
# container shares the network of a Redis container, which listens on
# 127.0.0.1:6379 with the password in REDIS_HOST_PASSWORD: the profiler records
# cache operations only where the caches are Redis.
#
# With nextcloud/profiler enabled, it sends a fixed set of requests that are
# not the app's, three times over:
#   base      without the app
#   previous  with the previous release, build/profile/previous/<app id>, where
#             the recipe put one there; also its own requests
#   app       with build/stage/<app id>, upgraded from the previous release
#             where there is one; also its own requests
# Each phase warms up with two rounds of the set that are not recorded, then
# records <rounds> rounds, one export of the profiler per round, which
# lib/profile.php reduces to <output directory>/<phase>/<round>.json. It
# judges nothing itself and ends with 0 whenever it got as far as writing
# those files.

set -u

app=$1
out=$2
rounds=$3
dir=$(dirname "$out")
web=/var/www/html
tab=$(printf '\t')
admin=admin:admin
user=ncmake-user:$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
# The folder of the PROPFIND with many files, and how many.
many=ncmake-profile-many
files=200
# The status file of the round being counted, empty outside one.
statuses=

occ() { runuser -u www-data -- php "$web/occ" "$@"; }

# The files are written as root; hand them to the owner of the checkout, so the
# host can read and remove them whatever runtime started the container.
finish() {
	chown -R --reference=. "$out" 2>/dev/null
	exit 0
}
stop() {
	echo "$1" >"$out/stopped"
	finish
}

# call <verb> <as> <path> [curl option ...]: one request, its status on stdout.
# The OCS header is what a client that is no browser sends; with it the server
# asks for no CSRF token.
call() {
	verb=$1
	as=$2
	path=$3
	shift 3
	case $as in
		admin) set -- -u "$admin" "$@" ;;
		user) set -- -u "$user" "$@" ;;
	esac
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 -X "$verb" -H 'OCS-APIRequest: true' "$@" "http://localhost$path") || code=000
	[ -z "$statuses" ] || printf '%s\t%s\t%s\n' "$verb" "$path" "$code" >>"$statuses"
	echo "$code"
}

# The set of requests that are not the app's: what a desktop client, the web
# interface and a mobile client send all day. status.php is not among them:
# the profiler records no profile for it.
standard() {
	call PROPFIND admin /remote.php/dav/files/admin/ -H 'Depth: 1' >/dev/null
	call PROPFIND admin "/remote.php/dav/files/admin/$many/" -H 'Depth: 1' >/dev/null
	call PUT admin /remote.php/dav/files/admin/ncmake-profile.txt --data-binary 'ncmake profile' >/dev/null
	call GET admin /remote.php/dav/files/admin/ncmake-profile.txt >/dev/null
	call DELETE admin /remote.php/dav/files/admin/ncmake-profile.txt >/dev/null
	call GET admin /index.php/apps/dashboard/ >/dev/null
	call GET admin '/ocs/v2.php/cloud/capabilities?format=json' >/dev/null
	call GET admin '/ocs/v2.php/cloud/user?format=json' >/dev/null
}

# The requests of the app: build/profile/plan, "<verb> <as> <path>" per line.
own() {
	while IFS=$tab read -r verb as path; do
		call "$verb" "$as" "$path" >/dev/null
	done <"$dir/plan"
}

# measure <phase> <set ...>: two rounds to warm up, then the rounds that count.
measure() {
	phase=$1
	shift
	mkdir -p "$out/$phase"
	for set; do "$set"; done
	for set; do "$set"; done
	r=1
	while [ "$r" -le "$rounds" ]; do
		occ profiler:clear >/dev/null 2>&1
		statuses=$out/$phase/$r.status
		: >"$statuses"
		for set; do "$set"; done
		statuses=
		occ profiler:export >"$out/$phase/export.json" 2>>"$out/$phase/export.err"
		php -d memory_limit=-1 "$dir/profile.php" "$app" "$out/$phase/export.json" "$out/$phase/$r.status" "$out/$phase/$r.json" 2>>"$out/$phase/export.err"
		r=$((r + 1))
	done
	rm -f "$out/$phase/export.json"
}

# install <phase> <source directory>: the app into custom_apps, enabled, and
# upgraded where the server asks for it. A previous release is replaced in
# place, as an update of the app replaces it.
install() {
	phase=$1
	rm -rf "$web/custom_apps/$app"
	if ! { cp -a "$2" "$web/custom_apps/$app" && chown -R www-data:www-data "$web/custom_apps/$app"; } 2>"$out/$phase.copy.err"; then
		echo copy >"$out/$phase.stopped"
		return 1
	fi
	sed -n 's:.*<version>\(.*\)</version>.*:\1:p' "$web/custom_apps/$app/appinfo/info.xml" | head -n 1 >"$out/$phase.version"
	occ app:enable "$app" >"$out/$phase.enable.txt" 2>&1
	echo $? >"$out/$phase.enable.rc"
	if occ status --output=json 2>/dev/null | grep -q '"needsDbUpgrade":true'; then
		occ upgrade --no-interaction >"$out/$phase.upgrade.txt" 2>&1
		echo $? >"$out/$phase.upgrade.rc"
	fi
	if [ "$(cat "$out/$phase.enable.rc")" != 0 ] || [ "$(cat "$out/$phase.upgrade.rc" 2>/dev/null || echo 0)" != 0 ]; then
		echo enable >"$out/$phase.stopped"
		return 1
	fi
}

php -r 'echo PHP_VERSION;' >"$out/php"
occ status --output=json >"$out/status.json" 2>"$out/status.err"

i=0
until php -r '$r = new Redis(); exit(@$r->connect("127.0.0.1", 6379, 1.0) && $r->auth(getenv("REDIS_HOST_PASSWORD")) && $r->ping() ? 0 : 1);' 2>/dev/null; do
	i=$((i + 1))
	[ "$i" -lt 30 ] || stop redis
	sleep 1
done
{
	occ config:system:set redis host --value=127.0.0.1
	occ config:system:set redis port --value=6379 --type=integer
	occ config:system:set redis password --value="$REDIS_HOST_PASSWORD"
	occ config:system:set memcache.local --value='\OC\Memcache\Redis'
	occ config:system:set memcache.distributed --value='\OC\Memcache\Redis'
	occ config:system:set memcache.locking --value='\OC\Memcache\Redis'
} >"$out/config.txt" 2>&1 || stop config

apache2-foreground >"$out/apache.log" 2>&1 &
i=0
until curl -fs -o /dev/null --max-time 5 http://localhost/status.php; do
	i=$((i + 1))
	[ "$i" -lt 30 ] || stop apache
	sleep 1
done

OC_PASS=${user#*:} occ user:add --password-from-env "${user%%:*}" >"$out/user.txt" 2>&1

# An app the server ships is disabled first, so the baseline is the server
# without it.
if [ -d "$web/apps/$app" ]; then
	occ app:disable "$app" >"$out/shipped.txt" 2>&1
fi

[ "$(call MKCOL admin "/remote.php/dav/files/admin/$many")" = 201 ] || stop fixtures
n=1
while [ "$n" -le "$files" ]; do
	case $(call PUT admin "/remote.php/dav/files/admin/$many/file-$n.txt" --data-binary "file $n") in
		201 | 204) ;;
		*) stop fixtures ;;
	esac
	n=$((n + 1))
done

{ occ app:enable profiler && occ profiler:enable; } >"$out/profiler.txt" 2>&1 || stop profiler
occ app:list --output=json >"$out/apps.json" 2>/dev/null

measure base standard

if [ -d "$dir/previous/$app" ] && install previous "$dir/previous/$app"; then
	measure previous standard own
fi

install app "build/stage/$app" || finish
measure app standard own

finish
