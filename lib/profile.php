<?php

// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// profile.php - what lib/profile.mjs needs of an export of nextcloud/profiler.
//
//   profile.php <app id> <export file> <status file> <output file>
//
// Runs in a container of ncmake-server on the output of occ profiler:export,
// a JSON array of profiles. A profile of one request is about 300 kB, most of
// it the backtrace of each query and the start and stop of each event, and a
// run of make profile records several hundred. This keeps of each request what
// the analyser counts and the one frame of a backtrace it names, and drops the
// profiles of occ itself, which the profiler records as well.
//
// The status of a request comes from the status file, "<verb> <path> <status>"
// per line, as curl received it: the profiler records the status of the
// response object of the server, and a WebDAV response is sent past it, so a
// PUT that created a file is recorded as 200.

declare(strict_types=1);

if (count($argv) !== 5) {
	fwrite(STDERR, "usage: profile.php <app id> <export file> <status file> <output file>\n");
	exit(2);
}
[, $app, $in, $statusFile, $out] = $argv;

$status = [];
foreach (file($statusFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
	$f = explode("\t", $line);
	if (count($f) === 3) {
		$status[$f[0] . ' ' . $f[1]] = (int)$f[2];
	}
}

$profiles = json_decode((string)file_get_contents($in), true);
if (!is_array($profiles)) {
	fwrite(STDERR, "profile.php: $in holds no JSON array\n");
	exit(1);
}

// Where a backtrace reaches the app: the first frame in its directory, relative
// to it. The staged app is always copied into custom_apps, also one the server
// ships.
$dir = "/custom_apps/$app/";
$frameOf = static function (array $trace) use ($dir): ?string {
	foreach ($trace as $t) {
		$file = (string)($t['file'] ?? '');
		$i = strpos($file, $dir);
		if ($i !== false) {
			return substr($file, $i + strlen($dir)) . (isset($t['line']) ? ':' . $t['line'] : '');
		}
	}
	return null;
};

$result = [];
foreach ($profiles as $p) {
	$url = (string)($p['url'] ?? '');
	if (($p['method'] ?? '') === 'occ') {
		continue;
	}
	$c = $p['collectors'] ?? [];

	$queries = [];
	foreach ($c['db']['queries'] ?? [] as $q) {
		$queries[] = [
			'sql' => (string)($q['sql'] ?? ''),
			'params' => json_encode($q['params'] ?? null, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR),
			'frame' => $frameOf($q['backtrace'] ?? []),
		];
	}

	// A cache collector is named "cache/<Local|Distributed|Locking>/<instance>/<prefix>",
	// an operation "<instance>/<prefix>::<op>::<key>". The instance id differs
	// per server and the key per user or file, so an operation counts as its
	// store, prefix and kind.
	$cache = [];
	foreach ($c as $name => $collector) {
		if (!str_starts_with((string)$name, 'cache/')) {
			continue;
		}
		$parts = explode('/', (string)$name, 4);
		foreach ($collector['queries'] ?? [] as $op) {
			$kind = explode('::', (string)($op['op'] ?? ''))[1] ?? '';
			$cache[] = [
				'op' => ($parts[1] ?? '') . ' ' . ($parts[3] ?? '') . ' ' . $kind,
				'hit' => $op['hit'] ?? null,
			];
		}
	}

	// The bootstrap of the app, as the server times it: registering, loading
	// and booting it, each a top-level event of its own.
	$events = $c['event'] ?? [];
	$boot = 0.0;
	foreach (['register_app', 'load_app', 'boot_app'] as $stage) {
		$boot += (float)($events["bootstrap:$stage:$app"]['duration'] ?? 0);
	}

	$result[] = [
		'method' => (string)($p['method'] ?? ''),
		'url' => $url,
		'status' => $status[($p['method'] ?? '') . ' ' . $url] ?? 0,
		'ms' => round((float)($events['runtime']['duration'] ?? 0) * 1000, 1),
		'memory' => (int)($c['memory']['memory'] ?? 0),
		'events' => count($events),
		'boot' => round($boot * 1000, 1),
		'queries' => $queries,
		'cache' => $cache,
	];
}

if (file_put_contents($out, json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR)) === false) {
	fwrite(STDERR, "profile.php: could not write $out\n");
	exit(1);
}
