#!/bin/sh
# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# server-setup.sh - what lib/install-test.sh and lib/runtime-audit.sh do to the
# server before they enable the app, sourced by both. It expects occ() of the
# script that sources it.
#
# The server of the image is installed on SQLite. An app whose info.xml names
# <database> without sqlite is refused there, so make starts the server beside a
# PostgreSQL container when the app names pgsql, and db_setup installs the
# server on it before the app is copied in. php_cap finds out whether the server
# refuses the app for its <php max-version>, and raises it in the copy, so the
# run shows whether the app runs on that PHP anyway.

# db_setup <output directory> [pgsql <user> <password> <database>]
# Writes db, the database the server runs on; for pgsql also pgsql.txt, the
# output of the install, and pgsql.rc, its exit code. PostgreSQL starts in its
# own container, which shares the network of this one; until it accepts a
# connection the install waits, at most two minutes.
# The server is installed anew rather than converted: occ db:convert-type
# fails on the sequences of the server's own tables (Nextcloud 33). config.php
# keeps what the image set beside the install, without the keys of the install
# itself, and the data directory starts empty, as for a first install; the mode
# of background jobs, which lives in the database, is set again as the image
# sets it.
db_setup() {
	setup_dir=$1
	shift
	if [ "${1:-}" != pgsql ]; then
		echo sqlite >"$setup_dir/db"
		return 0
	fi
	echo pgsql >"$setup_dir/db"
	i=0
	# PHP prints an uncaught exception on stdout.
	until php -r 'new PDO("pgsql:host=127.0.0.1;dbname=" . $argv[3], $argv[1], $argv[2]);' -- "$2" "$3" "$4" >/dev/null 2>&1; do
		i=$((i + 1))
		if [ "$i" -ge 120 ]; then
			echo "PostgreSQL accepted no connection within 120 seconds." >"$setup_dir/pgsql.txt"
			echo 1 >"$setup_dir/pgsql.rc"
			return 1
		fi
		sleep 1
	done
	{
		php -r '
			include $argv[1];
			foreach (["installed", "version", "dbtype", "dbname", "dbhost", "dbport", "dbuser", "dbpassword", "dbtableprefix"] as $k) unset($CONFIG[$k]);
			file_put_contents($argv[1], "<?php\n\$CONFIG = " . var_export($CONFIG, true) . ";\n");
		' -- "$web/config/config.php" &&
			find "$web/data" -mindepth 1 -delete &&
			occ maintenance:install --no-interaction --database pgsql --database-host 127.0.0.1 \
				--database-name "$4" --database-user "$2" --database-pass "$3" \
				--admin-user admin --admin-pass admin --data-dir "$web/data" &&
			occ background:cron
	} >"$setup_dir/pgsql.txt" 2>&1
	rc=$?
	echo "$rc" >"$setup_dir/pgsql.rc"
	return "$rc"
}

# php_cap <output directory> <app directory>
# Nextcloud compares the PHP it runs on with <php max-version> to the precision
# of the shorter of the two, so max-version 8.4 admits 8.4.30 and refuses 8.5.0.
# Where it refuses the app, php-cap holds max-version and php-raised the minor
# of the server it is raised to in the copy of the app.
php_cap() {
	setup_dir=$1
	cap=$(php -r '
		$x = @simplexml_load_file($argv[1]);
		$max = $x === false ? "" : trim((string) ($x->dependencies->php["max-version"] ?? ""));
		if ($max === "") exit;
		$a = explode(".", PHP_VERSION);
		$b = explode(".", $max);
		$n = min(count($a), count($b));
		if (version_compare(implode(".", array_slice($a, 0, $n)), implode(".", array_slice($b, 0, $n)), ">")) echo $max;
	' -- "$2/appinfo/info.xml")
	[ -n "$cap" ] || return 0
	minor=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')
	echo "$cap" >"$setup_dir/php-cap"
	php -r '
		$d = new DOMDocument();
		$d->load($argv[1]);
		foreach ($d->getElementsByTagName("php") as $p) {
			if ($p->parentNode->nodeName === "dependencies") $p->setAttribute("max-version", $argv[2]);
		}
		$d->save($argv[1]);
	' -- "$2/appinfo/info.xml" "$minor" && echo "$minor" >"$setup_dir/php-raised"
}

# php_retry <output directory> <enabled>
# A raised cap the app still is not enabled with leaves retry, the minor of
# max-version: make runs the app once more on the server image of that PHP,
# <tag>-php<minor>, where the server admits it as it is.
php_retry() {
	[ -s "$1/php-raised" ] && [ "$2" != 0 ] || return 0
	php -r '$v = explode(".", $argv[1]); echo $v[0] . "." . ($v[1] ?? "0");' -- "$(cat "$1/php-cap")" >"$1/retry"
}
