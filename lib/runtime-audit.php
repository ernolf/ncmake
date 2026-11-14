<?php

// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// runtime-audit.php - what lib/runtime-audit.sh asks the server and occ does not
// answer.
//
//   runtime-audit.php settings
//
// Runs as the user of the web server in a container of ncmake-server, with the
// server in /var/www/html. It prints one line per settings form the server
// has, "<admin|personal> <section> <class>", read from the settings manager of
// the public API. The page of a section is where its forms are built, and the
// id of a section is in no file of an app that could be read without running
// it.

declare(strict_types=1);

use OCP\App\IAppManager;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Server;
use OCP\Settings\IManager;

if (($argv[1] ?? '') !== 'settings') {
	fwrite(STDERR, "usage: runtime-audit.php settings\n");
	exit(2);
}

require '/var/www/html/lib/base.php';

Server::get(IAppManager::class)->loadApps();
// The personal sections are those of a user: without one in the session,
// reading them ends the process without a word.
Server::get(IUserSession::class)->setUser(Server::get(IUserManager::class)->get('admin'));
$manager = Server::get(IManager::class);
foreach (['admin' => $manager->getAdminSections(), 'personal' => $manager->getPersonalSections()] as $kind => $byPriority) {
	foreach ($byPriority as $sections) {
		foreach ($sections as $section) {
			$id = $section->getID();
			$forms = $kind === 'admin' ? $manager->getAdminSettings($id) : $manager->getPersonalSettings($id);
			foreach ($forms as $list) {
				foreach ($list as $form) {
					echo $kind, ' ', $id, ' ', get_class($form), "\n";
				}
			}
		}
	}
}
