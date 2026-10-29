<?php
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// deps-audit.php - the composer half of make deps-audit.
//
// Runs in the app, on the PHP of the floor build image, and prints one JSON
// object that deps-audit.mjs turns into findings:
//   audit       composer audit --locked --no-dev over composer.lock: the
//               advisories and the abandoned packages of what ships
//   rc, error   its exit code, and what it printed when it did not answer
//   fixes       per package with an advisory: its released versions, the first
//               one above the locked version that each advisory spares and the
//               first one all of them spare, and composer why-not for that one,
//               so the analyser can tell whether composer.json allows it
// Composer decides everything that depends on the constraints; this only picks
// the version to ask about. Plugins stay off: a plugin of the app would run code
// of a package the audit is about.
//
// With DEPS_AUDIT_NO_ADVISORIES=1 (make deps-audit NO_ADVISORIES=1) only the
// abandoned packages are kept, and the bit of the exit code that says an advisory
// was found is cleared, so build/deps-audit holds nothing about a vulnerability.

$composer = getenv('DEPS_AUDIT_COMPOSER') ?: 'composer';
$advisories = getenv('DEPS_AUDIT_NO_ADVISORIES') !== '1';
// composer frames an error to the width of the terminal and breaks its words
// there; a wide one keeps the message on one line.
putenv('COLUMNS=1000');

// One composer command, with its exit code and its two outputs apart.
function run(array $args): array
{
	global $composer;
	$p = proc_open(array_merge([$composer, '--no-interaction', '--no-plugins', '--no-ansi'], $args),
		[1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
	if (!is_resource($p)) {
		return ['rc' => 127, 'out' => '', 'err' => "could not run $composer"];
	}
	$out = stream_get_contents($pipes[1]);
	$err = stream_get_contents($pipes[2]);
	fclose($pipes[1]);
	fclose($pipes[2]);
	return ['rc' => proc_close($p), 'out' => $out, 'err' => $err];
}

// A version as version_compare reads it the same way however many parts it names:
// v1.2 and 1.2.0.0 are one version, and the suffix of a pre-release stays.
function norm(string $v): string
{
	$v = ltrim(trim($v), 'vV');
	if (!preg_match('/^(\d+(?:\.\d+)*)(.*)$/', $v, $m)) {
		return $v;
	}
	$parts = explode('.', $m[1]);
	return implode('.', array_pad($parts, 4, '0')) . $m[2];
}

// affectedVersions of an advisory, as Packagist writes it: alternatives split by
// |, each a list of comparisons split by commas or spaces.
function affected(string $version, string $constraint): bool
{
	$v = norm($version);
	foreach (preg_split('/\s*\|\|?\s*/', trim($constraint)) as $alt) {
		$all = true;
		foreach (preg_split('/\s*,\s*|\s+/', trim($alt), -1, PREG_SPLIT_NO_EMPTY) as $c) {
			if ($c === '*') {
				continue;
			}
			if (!preg_match('/^(<=|>=|<|>|==|=|!=)?\s*(.+)$/', $c, $m)) {
				$all = false;
				break;
			}
			$op = $m[1] === '' || $m[1] === '=' ? '==' : $m[1];
			if (!version_compare($v, norm($m[2]), $op)) {
				$all = false;
				break;
			}
		}
		if ($all) {
			return true;
		}
	}
	return false;
}

// A released version: no branch, no alpha, beta or RC.
function stable(string $v): bool
{
	return (bool) preg_match('/^v?\d+(\.\d+){0,3}$/', $v);
}

$audit = run(['audit', '--locked', '--no-dev', '--format=json', '--abandoned=report']);
$json = json_decode($audit['out'], true);
if (!$advisories && is_array($json)) {
	$json = ['abandoned' => $json['abandoned'] ?? []];
	$audit['rc'] &= ~1;
}
$result = [
	'rc' => $audit['rc'],
	'audit' => is_array($json) ? $json : null,
	'error' => is_array($json) ? null : trim($audit['err'] . "\n" . $audit['out']),
	'fixes' => [],
];

$locked = [];
foreach (json_decode((string) @file_get_contents('composer.lock'), true)['packages'] ?? [] as $p) {
	$locked[$p['name']] = $p['version'];
}

foreach ($result['audit']['advisories'] ?? [] as $name => $advisories) {
	if (!isset($locked[$name])) {
		continue;
	}
	$show = run(['show', '--all', '--format=json', $name]);
	$versions = array_values(array_filter(json_decode($show['out'], true)['versions'] ?? [], 'stable'));
	usort($versions, fn($a, $b) => version_compare(norm($a), norm($b)));
	$above = array_values(array_filter($versions, fn($v) => version_compare(norm($v), norm($locked[$name]), '>')));
	$fix = ['versions' => $show['rc'] === 0 ? $versions : null, 'first' => [], 'all' => null, 'whyNot' => null];
	foreach ($advisories as $a) {
		$fix['first'][$a['advisoryId']] = null;
		foreach ($above as $v) {
			if (!affected($v, $a['affectedVersions'] ?? '*')) {
				$fix['first'][$a['advisoryId']] = $v;
				break;
			}
		}
	}
	foreach ($above as $v) {
		$hit = false;
		foreach ($advisories as $a) {
			$hit = $hit || affected($v, $a['affectedVersions'] ?? '*');
		}
		if (!$hit) {
			$fix['all'] = $v;
			break;
		}
	}
	if ($fix['all'] !== null) {
		$why = run(['why-not', '--locked', $name, ltrim($fix['all'], 'vV')]);
		$fix['whyNot'] = ['rc' => $why['rc'], 'lines' => preg_split('/\R/', trim($why['out']))];
	}
	$result['fixes'][$name] = $fix;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
