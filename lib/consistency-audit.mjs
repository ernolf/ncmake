#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// consistency-audit - does the checkout agree with itself.
//
// An app states the same fact in several places: the version in appinfo/info.xml
// and in package.json, the PHP floor in info.xml and in composer.json, the PHP
// extensions in info.xml and in composer, the Node version in package.json, in
// .nvmrc and in the CI workflows. Each file is valid on its own, and the defect is
// that they disagree - which no linter sees, because a linter checks one file
// against a rule, and this checks the files against each other.
//
// The second half is what a release needs and a checkout can be missing: the link
// from a published version back to its source, a version range that names a server
// that exists, a lockfile, a lint gate. Each absence is reported with the reason it
// matters, once, and never as a score.
//
// Metadata only: no build output, no install, no bytes, and no npm dependency.
// From the network it reads only whether the links of appinfo/info.xml answer,
// which --no-network leaves out; the major on nextcloud/server master is read by
// make and handed in. It runs on any Nextcloud app, one that never heard
// of ncmake included. What the checkout does not state is reported as undetermined
// rather than guessed. Node 18 or newer.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
	LEGEND,
	cut,
	howToRun,
	num,
	plural,
	renderFindings,
	sortFindings,
	table,
	writeJsonFile,
} from './report-text.mjs';

// == Config ==
const defaults = {
	dir: '.',        // the app checkout; nothing outside it is read
	top: 12,         // rows per table, 0 = all
	details: false,  // every table; the default is the verdict alone
	json: false,
	jsonFile: null,
	// The links of info.xml are the one thing the analyser reads from the network
	// itself; make hands NO_NETWORK=1 in as CONSISTENCY_AUDIT_NO_NETWORK.
	network: process.env.CONSISTENCY_AUDIT_NO_NETWORK !== '1',
};

// The server releases this file knows about. The audit does not look them up, so the state is written down with the month it was taken in, and
// the report names that month wherever it judges by it. The analyser is refreshed
// from the ncmake cache like every module, which is what keeps this current.
const NC = { newest: 35, oldestMaintained: 32, asOf: '2026-09' };

// The major nextcloud/server develops on master: no server has run a <nextcloud
// max-version> beyond it. make reads it from version.php on master and hands it in;
// a run without it, offline or outside make, takes the major after the newest
// released one from the table above and says so.
function masterMajor() {
	const handed = Number(process.env.CONSISTENCY_AUDIT_NC_MASTER);
	return Number.isInteger(handed) && handed > 0
		? { major: handed, from: 'version.php on nextcloud/server master' }
		: { major: NC.newest + 1, from: `this analyser, ${NC.asOf}` };
}

// The newest major nextcloud/server has released, the highest major among its
// release tags vX.Y.Z. The App Store rules let a release reach one major beyond it,
// which is short of master while the next major is branched and not yet released.
// make hands it in; a run without it takes the table above and says so.
function newestMajor() {
	const handed = Number(process.env.CONSISTENCY_AUDIT_NC_NEWEST);
	return Number.isInteger(handed) && handed > 0
		? { major: handed, from: 'the release tags of nextcloud/server' }
		: { major: NC.newest, from: `this analyser, ${NC.asOf}` };
}

// The Node.js release schedule, start, LTS and end date per line, from which the
// core picks the Node an app is built on. make reads the schedule and hands it in
// as one word per line, v<major>=<start>,<lts>,<end>; a run without it takes this
// snapshot and says so.
const NODE_SCHEDULE = {
	asOf: '2026-10',
	lines: {
		12: ['2019-04-23', '2019-10-21', '2022-04-30'],
		13: ['2019-10-22', '', '2020-06-01'],
		14: ['2020-04-21', '2020-10-27', '2023-04-30'],
		15: ['2020-10-20', '', '2021-06-01'],
		16: ['2021-04-20', '2021-10-26', '2023-09-11'],
		17: ['2021-10-19', '', '2022-06-01'],
		18: ['2022-04-19', '2022-10-25', '2025-04-30'],
		19: ['2022-10-18', '', '2023-06-01'],
		20: ['2023-04-18', '2023-10-24', '2026-04-30'],
		21: ['2023-10-17', '', '2024-06-01'],
		22: ['2024-04-24', '2024-10-29', '2027-04-30'],
		23: ['2024-10-16', '', '2025-06-01'],
		24: ['2025-05-06', '2025-10-28', '2028-04-30'],
		25: ['2025-10-15', '', '2026-06-01'],
		26: ['2026-05-05', '2026-10-28', '2029-04-30'],
		27: ['2027-04-22', '', '2030-04-30'],
	},
};

function nodeSchedule() {
	const lines = {};
	for (const word of (process.env.CONSISTENCY_AUDIT_NODE_SCHEDULE ?? '').split(/\s+/)) {
		const m = word.match(/^v(\d+)=([\d-]*),([\d-]*),([\d-]*)$/);
		if (m) lines[m[1]] = [m[2], m[3], m[4]];
	}
	const handed = Object.keys(lines).length > 0;
	return {
		today: new Date().toISOString().slice(0, 10),
		lines: handed ? lines : NODE_SCHEDULE.lines,
		from: handed ? 'schedule.json in nodejs/Release' : `this analyser, ${NODE_SCHEDULE.asOf}`,
	};
}

// The core's choice of the build Node, made the same way: among the lines released
// by today that the spans admit, the newest LTS line that is not end of life, else
// the newest that is not end of life, else the newest at all, which is then marked
// eol. null where the spans admit no released line. lts says whether the line
// picked has entered LTS.
function nodePick(schedule, spans) {
	const { today, lines } = schedule;
	const released = Object.keys(lines).map(Number).filter((m) => lines[m][0] <= today).sort((a, b) => b - a);
	const live = (m) => lines[m][2] > today;
	const lts = (m) => Boolean(lines[m][1]) && lines[m][1] <= today;
	const admitted = released.filter((m) => admits(spans, m));
	if (!admitted.length) return null;
	const current = admitted.filter((m) => live(m) && lts(m)).concat(admitted.filter((m) => live(m) && !lts(m)));
	// The oldest line still maintained is the shortest way out of end of life; an
	// LTS line comes before a current one, which ends within months.
	const maintained = released.filter(live);
	const oldest = maintained.filter(lts).at(-1) ?? maintained.at(-1) ?? null;
	const major = current[0] ?? admitted[0];
	return { major, eol: !current.length, lts: lts(major), end: lines[major][2], oldest };
}

// What the admitted lines still wait for: the first of them that starts after
// today, the first whose LTS starts after today, and whether the spans reach above
// every line released so far. start and lts are null where the schedule lists none.
function nodeAhead(schedule, spans) {
	const { today, lines } = schedule;
	const majors = Object.keys(lines).map(Number).sort((a, b) => a - b);
	const admitted = majors.filter((m) => admits(spans, m));
	const newest = majors.filter((m) => lines[m][0] <= today).at(-1) ?? 0;
	return {
		start: admitted.find((m) => lines[m][0] > today) ?? null,
		lts: admitted.find((m) => lines[m][1] > today) ?? null,
		beyond: spans.some(([, hi]) => hi > newest),
	};
}

// The PHP extensions every Nextcloud server has: those every PHP build carries, and
// the modules the server requires (admin manual, PHP configuration). Only an
// extension beyond these needs a <lib> in info.xml, which the server checks before
// it enables the app.
const SERVER_EXTENSIONS = new Set([
	'core', 'date', 'hash', 'json', 'pcre', 'random', 'reflection', 'spl', 'standard',
	'ctype', 'curl', 'dom', 'fileinfo', 'filter', 'gd', 'libxml', 'mbstring', 'openssl',
	'posix', 'session', 'simplexml', 'xml', 'xmlreader', 'xmlwriter', 'zip', 'zlib',
]);

// The paths an ncmake release ships, keep_dirs and keep_files of the core. make hands
// in the set it packs, keep_extra from ncmake.mk included; a run without it takes
// this copy of the core's defaults and says so.
const KEEP = ['appinfo', 'lib', 'l10n', 'templates', 'img', 'css', 'js', 'vendor', 'composer', 'LICENSES',
	'CHANGELOG.md', 'CHANGELOG.*.md', 'AUTHORS', 'AUTHORS.md', 'REUSE.toml', 'COPYING', 'COPYING.md', 'LICENSE', 'LICENSE.md'];

function keepSet() {
	const handed = (process.env.CONSISTENCY_AUDIT_KEEP ?? '').split(/\s+/).filter(Boolean);
	return handed.length
		? { paths: handed, from: 'the ncmake core and ncmake.mk' }
		: { paths: KEEP, from: 'this analyser, without keep_extra' };
}

// Directories that hold no statement of this app: installed third-party trees and
// the git database.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor']);

// A lockfile names every transitive package, so searching it would find every
// dependency referenced and the reference scan would always pass.
const LOCKFILES = [
	{ file: 'package-lock.json', manager: 'npm' },
	{ file: 'yarn.lock', manager: 'yarn' },
	{ file: 'pnpm-lock.yaml', manager: 'pnpm' },
	{ file: 'composer.lock', manager: 'composer' },
];

// Reading these as text finds nothing and costs the most.
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.woff',
	'.woff2', '.ttf', '.eot', '.zip', '.gz', '.tgz', '.pdf', '.mp3', '.mp4', '.webm', '.map']);

// Beyond this a file is a bundle or a fixture, not a statement about the app.
const READ_MAX = 4 * 1024 * 1024;

// The SPDX licence list, release 3.29.0 of spdx/license-list-data (2026-09-16): every
// licence id and every exception id that is not deprecated. package.json and composer.json
// may state any of them. The audit does not look the list up, so it is written down here with the release it is taken from.
const spdxList = (ids) => new Map(ids.trim().split(/\s+/).map((id) => [id.toLowerCase(), id]));
const SPDX_LICENCES = spdxList(`
	0BSD 3D-Slicer-1.0 AAL Abstyles AdaCore-doc Adobe-2006 Adobe-Display-PostScript Adobe-Glyph
	Adobe-Utopia ADSL Advanced-Cryptics-Dictionary AFL-1.1 AFL-1.2 AFL-2.0 AFL-2.1 AFL-3.0 Afmparse
	AGPL-1.0-only AGPL-1.0-or-later AGPL-3.0-only AGPL-3.0-or-later Aladdin ALGLIB-Documentation
	AMD-newlib AMDPLPA AML AML-glslang AMPAS ANTLR-PD ANTLR-PD-fallback any-OSI any-OSI-perl-modules
	Apache-1.0 Apache-1.1 Apache-2.0 APAFML APL-1.0 App-s2p APSL-1.0 APSL-1.1 APSL-1.2 APSL-2.0
	Arphic-1999 Artistic-1.0 Artistic-1.0-cl8 Artistic-1.0-Perl Artistic-2.0 Artistic-dist Aspell-RU
	ASWF-Digital-Assets-1.0 ASWF-Digital-Assets-1.1 atc-game Baekmuk Bahyph Barr bcrypt-Solar-Designer
	Beerware Bitstream-Charter Bitstream-Vera BitTorrent-1.0 BitTorrent-1.1 blessing BlueOak-1.0.0
	Boehm-GC Boehm-GC-without-fee BOLA-1.1 Borceux Brian-Gladman-2-Clause Brian-Gladman-3-Clause
	Brian-Gladman-3-Clause-no-conversion BSD-1-Clause BSD-2-Clause BSD-2-Clause-Darwin
	BSD-2-Clause-first-lines BSD-2-Clause-Patent BSD-2-Clause-pkgconf-disclaimer
	BSD-2-Clause-pos-unchanged BSD-2-Clause-Views BSD-3-Clause BSD-3-Clause-acpica
	BSD-3-Clause-Attribution BSD-3-Clause-Clear BSD-3-Clause-flex BSD-3-Clause-HP BSD-3-Clause-LBNL
	BSD-3-Clause-Modification BSD-3-Clause-No-Military-License BSD-3-Clause-No-Nuclear-License
	BSD-3-Clause-No-Nuclear-License-2014 BSD-3-Clause-No-Nuclear-Warranty BSD-3-Clause-Open-MPI
	BSD-3-Clause-OpenWebUI BSD-3-Clause-Sun BSD-3-Clause-Tso BSD-4-Clause BSD-4-Clause-Shortened
	BSD-4-Clause-UC BSD-4.3RENO BSD-4.3TAHOE BSD-Advertising-Acknowledgement BSD-ask-to-endorse
	BSD-Attribution-HPND-disclaimer BSD-Inferno-Nettverk BSD-Mark-Modifications BSD-Protection
	BSD-Source-alt-GPL BSD-Source-beginning-file BSD-Source-Code BSD-Source-Code-no-disclaimer
	BSD-Systemics BSD-Systemics-W3Works BSL-1.0 Buddy Bugroff BUSL-1.1 bzip2-1.0.6 C-UDA-1.0 CAL-1.0
	CAL-1.0-Combined-Work-Exception Caldera Caldera-no-preamble CAPEC-tou Catharon CATOSL-1.1 CC-BY-1.0
	CC-BY-2.0 CC-BY-2.5 CC-BY-2.5-AU CC-BY-3.0 CC-BY-3.0-AT CC-BY-3.0-AU CC-BY-3.0-DE CC-BY-3.0-IGO
	CC-BY-3.0-NL CC-BY-3.0-US CC-BY-4.0 CC-BY-NC-1.0 CC-BY-NC-2.0 CC-BY-NC-2.5 CC-BY-NC-3.0
	CC-BY-NC-3.0-DE CC-BY-NC-3.0-IGO CC-BY-NC-4.0 CC-BY-NC-ND-1.0 CC-BY-NC-ND-2.0 CC-BY-NC-ND-2.5
	CC-BY-NC-ND-3.0 CC-BY-NC-ND-3.0-DE CC-BY-NC-ND-3.0-IGO CC-BY-NC-ND-4.0 CC-BY-NC-SA-1.0
	CC-BY-NC-SA-2.0 CC-BY-NC-SA-2.0-DE CC-BY-NC-SA-2.0-FR CC-BY-NC-SA-2.0-UK CC-BY-NC-SA-2.5
	CC-BY-NC-SA-3.0 CC-BY-NC-SA-3.0-DE CC-BY-NC-SA-3.0-IGO CC-BY-NC-SA-4.0 CC-BY-ND-1.0 CC-BY-ND-2.0
	CC-BY-ND-2.5 CC-BY-ND-3.0 CC-BY-ND-3.0-DE CC-BY-ND-4.0 CC-BY-SA-1.0 CC-BY-SA-2.0 CC-BY-SA-2.0-UK
	CC-BY-SA-2.1-JP CC-BY-SA-2.5 CC-BY-SA-3.0 CC-BY-SA-3.0-AT CC-BY-SA-3.0-DE CC-BY-SA-3.0-IGO
	CC-BY-SA-4.0 CC-PDDC CC-PDM-1.0 CC-SA-1.0 CC0-1.0 CDDL-1.0 CDDL-1.1 CDL-1.0 CDLA-Permissive-1.0
	CDLA-Permissive-2.0 CDLA-Sharing-1.0 CECILL-1.0 CECILL-1.1 CECILL-2.0 CECILL-2.1 CECILL-B CECILL-C
	CERN-OHL-1.1 CERN-OHL-1.2 CERN-OHL-P-2.0 CERN-OHL-S-2.0 CERN-OHL-W-2.0 CFITSIO check-cvs checkmk
	ClArtistic Clips CMU-Mach CMU-Mach-nodoc CNRI-Jython CNRI-Python CNRI-Python-GPL-Compatible COIL-1.0
	Community-Spec-1.0 Condor-1.1 copyleft-next-0.3.0 copyleft-next-0.3.1 Cornell-Lossless-JPEG CPAL-1.0
	CPL-1.0 CPOL-1.02 Cronyx Crossword CryptoSwift CrystalStacker CUA-OPL-1.0 Cube curl cve-tou
	D-FSL-1.0 DEC-3-Clause diffmark DL-DE-BY-2.0 DL-DE-ZERO-2.0 DOC DocBook-DTD DocBook-Schema
	DocBook-Stylesheet DocBook-XML Dotseqn DRL-1.0 DRL-1.1 DSDP dtoa dvipdfm ECL-1.0 ECL-2.0 EFL-1.0
	EFL-2.0 eGenix Elastic-2.0 Entessa EPICS EPL-1.0 EPL-2.0 ErlPL-1.1 ESA-PL-permissive-2.4
	ESA-PL-strong-copyleft-2.4 ESA-PL-weak-copyleft-2.4 etalab-2.0 EUDatagrid EUPL-1.0 EUPL-1.1 EUPL-1.2
	Eurosym Fair FBM FDK-AAC FDK-MPEG-H Ferguson-Twofish Frameworx-1.0 FreeBSD-DOC FreeImage FSFAP
	FSFAP-no-warranty-disclaimer FSFUL FSFULLR FSFULLRSD FSFULLRWD FSL-1.1-ALv2 FSL-1.1-MIT FTL Furuseth
	fwlw Game-Programming-Gems GCR-docs GD generic-xts GFDL-1.1-invariants-only
	GFDL-1.1-invariants-or-later GFDL-1.1-no-invariants-only GFDL-1.1-no-invariants-or-later
	GFDL-1.1-only GFDL-1.1-or-later GFDL-1.2-invariants-only GFDL-1.2-invariants-or-later
	GFDL-1.2-no-invariants-only GFDL-1.2-no-invariants-or-later GFDL-1.2-only GFDL-1.2-or-later
	GFDL-1.3-invariants-only GFDL-1.3-invariants-or-later GFDL-1.3-no-invariants-only
	GFDL-1.3-no-invariants-or-later GFDL-1.3-only GFDL-1.3-or-later Giftware GL2PS Glide Glulxe GLWTPL
	gnuplot GPL-1.0-only GPL-1.0-or-later GPL-2.0-only GPL-2.0-or-later GPL-3.0-only GPL-3.0-or-later
	Graphics-Gems gSOAP-1.3b gtkbook Gutmann HaskellReport HDF5 hdparm HIDAPI Hippocratic-2.1
	Hippocratic-3.0-core HP-1986 HP-1989 HPND HPND-DEC HPND-doc HPND-doc-sell HPND-export-US
	HPND-export-US-acknowledgement HPND-export-US-modify HPND-export2-US HPND-Fenneberg-Livingston
	HPND-INRIA-IMAG HPND-Intel HPND-Kevlin-Henney HPND-Markus-Kuhn HPND-merchantability-variant
	HPND-MIT-disclaimer HPND-Netrek HPND-Pbmplus HPND-sell-MIT-disclaimer-xserver HPND-sell-regexpr
	HPND-sell-variant HPND-sell-variant-critical-systems HPND-sell-variant-MIT-disclaimer
	HPND-sell-variant-MIT-disclaimer-rev HPND-SMC HPND-UC HPND-UC-export-US HTMLTIDY hyphen-bulgarian
	IBM-pibs ICU IEC-Code-Components-EULA IJG IJG-short ImageMagick iMatix Imlib2 Info-ZIP Informatica
	Inner-Net-2.0 InnoSetup Intel Intel-ACPI Interbase-1.0 IPA IPL-1.0 ISC ISC-Veillard ISO-permission
	Jam JasPer-2.0 jove JPL-image JPNIC JSON Kastrup Kazlib Knuth-CTAN LAL-1.2 LAL-1.3 Latex2e
	Latex2e-translated-notice Leptonica LGPL-2.0-only LGPL-2.0-or-later LGPL-2.1-only LGPL-2.1-or-later
	LGPL-3.0-only LGPL-3.0-or-later LGPLLR Libpng libpng-1.6.35 libpng-2.0 libselinux-1.0 libtiff
	libutil-David-Nugent LiLiQ-P-1.1 LiLiQ-R-1.1 LiLiQ-Rplus-1.1 Linux-man-pages-1-para
	Linux-man-pages-copyleft Linux-man-pages-copyleft-2-para Linux-man-pages-copyleft-var Linux-OpenIB
	LOOP LPD-document LPL-1.0 LPL-1.02 LPPL-1.0 LPPL-1.1 LPPL-1.2 LPPL-1.3a LPPL-1.3c lsof
	Lucida-Bitmap-Fonts LZMA-SDK-9.11-to-9.20 LZMA-SDK-9.22 Mackerras-3-Clause
	Mackerras-3-Clause-acknowledgment magaz mailprio MakeIndex man2html Martin-Birgmeier
	McPhee-slideshow metamail Minpack MIPS MirOS MIT MIT-0 MIT-advertising MIT-Click MIT-CMU MIT-enna
	MIT-feh MIT-Festival MIT-Khronos-old MIT-Modern-Variant MIT-open-group MIT-STK MIT-testregex MIT-Wu
	MITNFA MMIXware MMPL-1.0.1 Motosoto MPEG-SSG mpi-permissive mpich2 MPL-1.0 MPL-1.1 MPL-2.0
	MPL-2.0-no-copyleft-exception mplus MS-LPL MS-PL MS-RL MTLL MulanPSL-1.0 MulanPSL-2.0 Multics Mup
	MVT-1.1 NAIST-2003 NASA-1.3 Naumen NBPL-1.0 NCBI-PD NCGL-UK-2.0 NCL NCSA NetCDF Newsletr NGPL ngrep
	NICTA-1.0 NIST-PD NIST-PD-fallback NIST-PD-TNT NIST-Software NLOD-1.0 NLOD-2.0 NLPL Nokia NOSL Noweb
	NPL-1.0 NPL-1.1 NPOSL-3.0 NRL NTIA-PD NTP NTP-0 O-UDA-1.0 OAR OCCT-PL OCLC-2.0 ODbL-1.0 ODC-By-1.0
	OFFIS OFL-1.0 OFL-1.0-no-RFN OFL-1.0-RFN OFL-1.1 OFL-1.1-no-RFN OFL-1.1-RFN OGC-1.0 OGDL-Taiwan-1.0
	OGL-Canada-2.0 OGL-UK-1.0 OGL-UK-2.0 OGL-UK-3.0 OGTSL OLDAP-1.1 OLDAP-1.2 OLDAP-1.3 OLDAP-1.4
	OLDAP-2.0 OLDAP-2.0.1 OLDAP-2.1 OLDAP-2.2 OLDAP-2.2.1 OLDAP-2.2.2 OLDAP-2.3 OLDAP-2.4 OLDAP-2.5
	OLDAP-2.6 OLDAP-2.7 OLDAP-2.8 OLFL-1.3 OML OpenMDW-1.0 OpenPBS-2.3 OpenSSL OpenSSL-standalone
	OpenVision OPL-1.0 OPL-UK-3.0 OPUBL-1.0 OSC-1.0 OSET-PL-2.1 OSL-1.0 OSL-1.1 OSL-2.0 OSL-2.1 OSL-3.0
	OSSP PADL ParaType-Free-Font-1.3 Parity-6.0.0 Parity-7.0.0 PDDL-1.0 PHP-3.0 PHP-3.01 Pixar pkgconf
	Plexus pnmstitch PolyForm-Noncommercial-1.0.0 PolyForm-Small-Business-1.0.0 PostgreSQL PPL PSF-2.0
	psfrag psutils Python-2.0 Python-2.0.1 python-ldap Qhull QPL-1.0 QPL-1.0-INRIA-2004 radvd Rdisc
	RHeCos-1.1 RPL-1.1 RPL-1.5 RPSL-1.0 RSA-MD RSCPL Ruby Ruby-pty SAX-PD SAX-PD-2.0 Saxpath SCEA
	SchemeReport Sendmail Sendmail-8.23 Sendmail-Open-Source-1.1 SGI-B-1.0 SGI-B-1.1 SGI-B-2.0
	SGI-OpenGL SGMLUG-PM SGP4 SHL-0.5 SHL-0.51 SimPL-2.0 SISSL SISSL-1.2 SL Sleepycat SMAIL-GPL SMLNJ
	SMPPL SNIA snprintf SOFA softSurfer Soundex Spencer-86 Spencer-94 Spencer-99 SPL-1.0 ssh-keyscan
	SSH-OpenSSH SSH-short SSLeay-standalone SSPL-1.0 SugarCRM-1.1.3 SUL-1.0 Sun-PPP Sun-PPP-2000 SunPro
	SWL swrule Symlinks TAPR-OHL-1.0 TCL TCP-wrappers TekHVC TermReadKey TGPPL-1.0 ThirdEye
	threeparttable TMate TORQUE-1.1 TOSL TPDL TPL-1.0 TrustedQSL TTWL TTYP0 TU-Berlin-1.0 TU-Berlin-2.0
	Ubuntu-font-1.0 UCAR UCL-1.0 ulem UMich-Merit Unicode-3.0 Unicode-DFS-2015 Unicode-DFS-2016
	Unicode-TOU UnixCrypt Unlicense Unlicense-libtelnet Unlicense-libwhirlpool UnRAR UPL-1.0 URT-RLE Vim
	Vixie-Cron VOSTROM VSL-1.0 W3C W3C-19980720 W3C-20150513 w3m Watcom-1.0 Widget-Workshop WordNet
	Wsuipa WTFNMFPL WTFPL wwl X11 X11-distribute-modifications-variant X11-no-permit-persons X11-swapped
	Xdebug-1.03 Xerox Xfig XFree86-1.1 xinetd xkeyboard-config-Zinoviev xlock Xnet xpp XSkat xzoom
	YPL-1.0 YPL-1.1 Zed Zeeff Zend-2.0 Zimbra-1.3 Zimbra-1.4 Zlib zlib-acknowledgement ZPL-1.1 ZPL-2.0
	ZPL-2.1
`);
const SPDX_EXCEPTIONS = spdxList(`
	389-exception Asterisk-exception Asterisk-linking-protocols-exception Autoconf-exception-2.0
	Autoconf-exception-3.0 Autoconf-exception-generic Autoconf-exception-generic-3.0
	Autoconf-exception-macro Bison-exception-1.24 Bison-exception-2.2 Bootloader-exception
	CGAL-linking-exception Classpath-exception-2.0 Classpath-exception-2.0-short CLISP-exception-2.0
	cryptsetup-OpenSSL-exception Digia-Qt-LGPL-exception-1.1 DigiRule-FOSS-exception eCos-exception-2.0
	erlang-otp-linking-exception Fawkes-Runtime-exception FLTK-exception fmt-exception
	Font-exception-2.0 freertos-exception-2.0 GCC-exception-2.0 GCC-exception-2.0-note GCC-exception-3.1
	Gmsh-exception GNAT-exception GNOME-examples-exception GNU-compiler-exception gnu-javamail-exception
	Google-Patent-WebM GPL-3.0-389-ds-base-exception GPL-3.0-interface-exception
	GPL-3.0-linking-exception GPL-3.0-linking-source-exception GPL-CC-1.0 GStreamer-exception-2005
	GStreamer-exception-2008 harbour-exception i2p-gpl-java-exception Independent-modules-exception
	KiCad-libraries-exception kvirc-openssl-exception LGPL-3.0-linking-exception
	libpri-OpenH323-exception Libtool-exception Linux-syscall-note LLGPL LLVM-exception LZMA-exception
	mif-exception mxml-exception OCaml-LGPL-linking-exception OCCT-exception-1.0
	OpenJDK-assembly-exception-1.0 openvpn-openssl-exception PCRE2-exception polyparse-exception
	PS-or-PDF-font-exception-20170817 QPL-1.0-INRIA-2004-exception Qt-GPL-exception-1.0
	Qt-LGPL-exception-1.1 Qwt-exception-1.0 romic-exception RRDtool-FLOSS-exception-2.0
	rsync-linking-exception SANE-exception SHL-2.0 SHL-2.1 Simple-Library-Usage-exception
	Spelling-Provider-LGPL-exception sqlitestudio-OpenSSL-exception stunnel-exception SWI-exception
	Swift-exception Texinfo-exception u-boot-exception-2.0 UBDL-exception Universal-FOSS-exception-1.0
	vsftpd-openssl-exception WxWindows-exception-3.1 x11vnc-openssl-exception
`);

// The SPDX ids the App Store accepts in info.xml (its info.xsd, from Nextcloud 31 on).
// Any other SPDX id is valid in package.json and composer.json but not in info.xml.
const APPSTORE_IDS = new Set([
	'0BSD', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
	'BSD-3-Clause-Clear', 'CC0-1.0', 'EUPL-1.2', 'FSFAP', 'GPL-2.0-or-later', 'GPL-3.0-only',
	'GPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
	'MIT', 'MPL-2.0', 'OLDAP-2.7', 'PDDL-1.0', 'SAX-PD', 'Unlicense', 'X11',
]);

// Deprecated SPDX ids. The bare GNU id does not say whether -only or -or-later is
// meant, which is why it was replaced; the '+' form says -or-later.
const GNU_IDS = ['GPL-2.0', 'GPL-3.0', 'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0'];
const SPDX_DEPRECATED = new Map(GNU_IDS.flatMap((g) => [
	[g.toLowerCase(), null],
	...(g.startsWith('AGPL') ? [] : [[`${g.toLowerCase()}+`, `${g}-or-later`]]),
]));

// The values info.xml took before the SPDX ids, still accepted by the App Store,
// with the name its fixtures give them. gpl3 is shown as GPLv3, which leaves -only
// or -or-later open.
const APPSTORE_LEGACY = new Map([
	['agpl', { name: 'AGPLv3+', id: 'AGPL-3.0-or-later' }],
	['apache', { name: 'Apache 2.0', id: 'Apache-2.0' }],
	['gpl3', { name: 'GPLv3', id: null }],
	['mit', { name: 'MIT', id: 'MIT' }],
	['mpl', { name: 'Mozilla Public License 2.0', id: 'MPL-2.0' }],
]);

// == Command line ==
function usage() {
	return `consistency-audit - does the checkout agree with itself

Usage: consistency-audit.mjs [options] [dir]

  dir                   the app checkout to audit (default: ${defaults.dir})

Options:
  --top=N               rows per table, 0 for all (default: ${defaults.top})
  --details             print every table behind the findings
  --json                emit the full result as JSON and nothing else
  --json-file=<file>    write that JSON to <file> as well, beside the report
  --no-network          leave the links of appinfo/info.xml unchecked
  -h, --help            this text

The audit reads the checkout: no build, no install. From the network it reads
only whether the links of appinfo/info.xml answer, one HEAD each, which
--no-network or CONSISTENCY_AUDIT_NO_NETWORK=1 leaves out. The major
on nextcloud/server master is handed in by make as CONSISTENCY_AUDIT_NC_MASTER,
the newest released major as CONSISTENCY_AUDIT_NC_NEWEST; without them, the
table of majors in the analyser stands in. The Node.js release schedule is
handed in as CONSISTENCY_AUDIT_NODE_SCHEDULE; without it, the snapshot in the
analyser stands in. The shipped file set is handed in as CONSISTENCY_AUDIT_KEEP;
without it, the core's defaults stand in, without keep_extra. It reports without failing - the exit code is 0 whatever is found,
and 1 only when the run itself could not be carried out.`;
}

function die(msg) {
	process.stderr.write(`consistency-audit: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const opt = { ...defaults };
	let dir = null;
	for (const arg of argv) {
		const eq = arg.indexOf('=');
		const key = eq === -1 ? arg : arg.slice(0, eq);
		const val = eq === -1 ? '' : arg.slice(eq + 1);
		switch (key) {
			case '-h': case '--help': process.stdout.write(`${usage()}\n`); process.exit(0); break;
			case '--json': opt.json = true; break;
			case '--json-file': opt.jsonFile = val; break;
			case '--details': opt.details = true; break;
			case '--no-network': opt.network = false; break;
			case '--top': opt.top = Number(val); break;
			default:
				if (key.startsWith('-')) die(`unknown option: ${key}`);
				if (dir !== null) die(`only one directory can be audited: ${dir}, ${arg}`);
				dir = arg;
		}
	}
	if (dir !== null) opt.dir = dir;
	if (!Number.isInteger(opt.top) || opt.top < 0) die('--top needs a whole number, 0 or more');
	if (opt.jsonFile === '') die('--json-file needs a file');
	return opt;
}

// == What the files state ==
// info.xml is read textually, not parsed. An app with a namespace prefix or a
// stray entity still states a version, and an XML parser would be the first
// dependency this analyser family does not have.
const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '');

function tagText(xml, name) {
	const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
	return m ? m[1].trim() : null;
}

const tagTexts = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))]
	.map((m) => m[1].trim());

function tagAttrs(xml, name) {
	const m = xml.match(new RegExp(`<${name}(\\s[^>]*?)?\\s*/?>`));
	if (!m) return null;
	const out = {};
	for (const a of (m[1] ?? '').matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[a[1]] = a[2];
	return out;
}

function readInfo(root) {
	const file = path.join(root, 'appinfo', 'info.xml');
	if (!fs.existsSync(file)) return null;
	const xml = stripComments(fs.readFileSync(file, 'utf8'));
	const dep = xml.match(/<dependencies>[\s\S]*?<\/dependencies>/)?.[0] ?? '';
	return {
		id: tagText(xml, 'id'),
		// A navigation entry has a <name> of its own, which is not the app's.
		names: tagTexts(xml.replace(/<navigations?\b[\s\S]*?<\/navigations?>/g, ''), 'name'),
		version: tagText(xml, 'version'),
		// The App Store takes any number of <licence> elements.
		licences: [...tagTexts(xml, 'licence'), ...tagTexts(xml, 'license')],
		repository: tagText(xml, 'repository'),
		bugs: tagText(xml, 'bugs'),
		website: tagText(xml, 'website'),
		links: infoLinks(xml),
		nextcloud: tagAttrs(dep, 'nextcloud'),
		php: tagAttrs(dep, 'php'),
		libs: tagTexts(dep, 'lib').map((l) => l.toLowerCase()),
	};
}

// The links of the App Store listing, each with the element it comes from:
// <website>, <bugs>, <repository>, the three of <documentation>, every
// <screenshot> with its small-thumbnail, and every <donation>.
function infoLinks(xml) {
	const out = [];
	const add = (element, url) => { if (url && url.trim()) out.push({ element, url: decodeEntities(url.trim()) }); };
	for (const name of ['website', 'bugs', 'repository']) for (const u of tagTexts(xml, name)) add(`<${name}>`, u);
	const doc = xml.match(/<documentation>[\s\S]*?<\/documentation>/)?.[0] ?? '';
	for (const name of ['user', 'admin', 'developer']) for (const u of tagTexts(doc, name)) add(`<documentation><${name}>`, u);
	for (const m of xml.matchAll(/<screenshot(\s[^>]*)?>([\s\S]*?)<\/screenshot>/g)) {
		add('<screenshot>', m[2]);
		const thumb = /\bsmall-thumbnail\s*=\s*"([^"]*)"/.exec(m[1] ?? '')?.[1];
		if (thumb) add('<screenshot small-thumbnail>', thumb);
	}
	for (const u of tagTexts(xml, 'donation')) add('<donation>', u);
	return out;
}
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// A file that exists but does not parse is a finding of its own, so a broken JSON
// is carried as broken instead of counting as absent.
function readJson(root, name) {
	const file = path.join(root, name);
	if (!fs.existsSync(file)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { _broken: true };
		return { ...parsed, _broken: false };
	} catch {
		return { _broken: true };
	}
}

const readText = (root, name) => {
	const file = path.join(root, name);
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

// The tooling the audit looks for, each by the file that runs it rather than by a
// package in package.json: a declared linter without its configuration does
// nothing. 'legacy' is a form that is still read but no longer the current one,
// 'legacyPkgKey' the same form as a key in package.json.
const TOOLS = [
	{
		id: 'eslint',
		label: 'ESLint',
		bin: 'eslint',
		files: ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
			'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'],
		legacy: ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc'],
		legacyPkgKey: 'eslintConfig',
		configFlags: ['-c', '--config'],
		why: 'nothing checks the frontend sources, so a wrong import is found by the build or not at all',
		legacyWhy: 'ESLint 9 reads the flat config only; the eslintrc form, an .eslintrc file or the eslintConfig key in package.json,'
			+ ' is ignored unless the run is pinned to ESLint 8',
	},
	{
		id: 'stylelint',
		label: 'Stylelint',
		bin: 'stylelint',
		files: ['stylelint.config.js', 'stylelint.config.mjs', 'stylelint.config.cjs',
			'.stylelintrc.js', '.stylelintrc.mjs', '.stylelintrc.cjs', '.stylelintrc.json',
			'.stylelintrc.yml', '.stylelintrc.yaml', '.stylelintrc'],
		pkgKey: 'stylelint',
		configFlags: ['-c', '--config'],
		why: 'stylesheets are unchecked, and a mistake in CSS fails silently instead of loudly',
	},
	{
		id: 'psalm',
		label: 'Psalm',
		bin: 'psalm',
		files: ['psalm.xml', 'psalm.xml.dist'],
		configFlags: ['-c', '--config'],
		why: 'the PHP side has no static analysis, which is what catches a wrong type before the server does',
	},
	{
		id: 'phpunit',
		label: 'PHPUnit',
		bin: 'phpunit',
		files: ['phpunit.xml', 'phpunit.xml.dist', 'tests/phpunit.xml', 'tests/phpunit.xml.dist'],
		// Apps split unit and integration runs into phpunit.unit.xml and the like and
		// hand the file to phpunit in the composer script.
		configFlags: ['-c', '--configuration'],
		// PHPUnit's option parser (sebastian/cli-parser) takes any unambiguous prefix
		// of a long option, and no other PHPUnit option begins with --con.
		configAbbrev: '--con',
		match: { dirs: ['.', 'tests'], name: /^phpunit[\w.-]*\.xml(?:\.dist)?$/ },
		why: 'there is no test harness in the checkout, so nothing can be run against a change',
	},
	{
		id: 'php-cs-fixer',
		label: 'PHP-CS-Fixer',
		bin: 'php-cs-fixer',
		files: ['.php-cs-fixer.dist.php', '.php-cs-fixer.php'],
		configFlags: ['--config'],
		why: 'no coding standard is applied to the PHP sources, so formatting is settled in review instead of by a command',
	},
	{
		id: 'reuse',
		label: 'REUSE',
		files: ['REUSE.toml', '.reuse/dep5'],
		why: 'licensing is not machine-checkable, which the App Store and every distribution ask for',
	},
	{
		id: 'editorconfig',
		label: 'EditorConfig',
		files: ['.editorconfig'],
		why: 'indentation is whatever each contributor\'s editor does',
	},
];

// Every script either manifest declares, as one command line each; a composer
// script given as a list runs its entries one after another.
function listScripts(pkg, composer) {
	const of = (o) => (o && !o._broken && typeof o.scripts === 'object' && o.scripts ? Object.entries(o.scripts) : []);
	return [
		...of(pkg).map(([n, cmd]) => ({ where: 'package.json', n, cmd: String(cmd) })),
		...of(composer).map(([n, cmd]) => ({
			where: 'composer.json', n, cmd: Array.isArray(cmd) ? cmd.join(' && ') : String(cmd),
		})),
	];
}

// The configuration files a command hands the tool by one of its flags, one per
// call of the tool in the command.
function configArgs(cmd, t) {
	if (!t.configFlags) return [];
	// A flag the tool accepts abbreviated is matched in every length from the
	// shortest unambiguous one up to the full name.
	const forms = t.configFlags.flatMap((f) => (t.configAbbrev && f.startsWith(t.configAbbrev)
		? Array.from({ length: f.length - t.configAbbrev.length + 1 }, (_, i) => f.slice(0, t.configAbbrev.length + i))
		: [f]));
	const flag = new RegExp(`(?:^|\\s)(?:${forms.join('|')})(?:\\s+|=)("[^"]*"|'[^']*'|\\S+)`);
	return cmd.split(/&&|\|\||[;|]/)
		.filter((c) => c.includes(t.bin))
		.map((c) => c.slice(c.indexOf(t.bin) + t.bin.length).match(flag)?.[1].replace(/^["']|["']$/g, ''))
		.filter(Boolean);
}

function detectTools(root, pkg, scripts) {
	const exists = (f) => fs.existsSync(path.join(root, f));
	const filesIn = (d) => (exists(d) && fs.statSync(path.join(root, d)).isDirectory()
		? fs.readdirSync(path.join(root, d)).sort() : []);
	return TOOLS.map((t) => {
		// A script that runs the tool with a configuration file names the one it is
		// meant to run with, so that file comes first.
		const callers = t.bin ? scripts.filter((s) => s.cmd.includes(t.bin)).map((s) => {
			const configs = configArgs(s.cmd, t);
			return { ...s, configs, missing: configs.filter((f) => !exists(f)) };
		}) : [];
		let file = callers.flatMap((c) => c.configs).find(exists) ?? t.files.find(exists) ?? null;
		if (!file && t.match) {
			file = t.match.dirs.flatMap((d) => filesIn(d).filter((f) => t.match.name.test(f))
				.map((f) => path.posix.join(d, f)))[0] ?? null;
		}
		// Some tools also read their configuration from a key in package.json. That
		// configures the tool exactly as a dotfile does, so missing it would report a
		// configured tool as unconfigured.
		const hasKey = (key) => Boolean(key && pkg && !pkg._broken && pkg[key] !== undefined);
		if (!file && hasKey(t.pkgKey)) file = `package.json ${t.pkgKey} key`;
		const legacy = file ? null : ((t.legacy ?? []).find((f) => fs.existsSync(path.join(root, f)))
			?? (hasKey(t.legacyPkgKey) ? `package.json ${t.legacyPkgKey} key` : null));
		return {
			id: t.id, label: t.label, bin: t.bin ?? null, file, legacy, callers, why: t.why, legacyWhy: t.legacyWhy ?? null,
		};
	});
}

// The build system in the checkout. GNU make reads the first of MAKEFILE_NAMES it
// finds and none of the others, so the first one present is what make runs and the
// rest are shadowed. The ncmake bootstrap stub fetches the core at run time and is
// a few dozen lines; a committed copy carries the whole core and no longer follows
// the reference, which is what the length tells apart. A build file that never
// mentions ncmake is some other build system.
const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'];

function detectMakefile(root) {
	// Matched against the directory listing rather than with existsSync: where the
	// filesystem ignores case, makefile would also find a Makefile.
	const entries = new Set(fs.readdirSync(root));
	const files = MAKEFILE_NAMES.filter((name) => entries.has(name)).map((name) => {
		const text = readText(root, name);
		const lines = text.split('\n').length;
		const kind = !/ncmake/i.test(text) ? 'foreign' : (lines > 200 ? 'copy' : 'stub');
		return { name, kind, lines };
	});
	if (!files.length) return { present: false, name: null, kind: null, lines: 0, shadowed: [] };
	const [read, ...shadowed] = files;
	return { present: true, ...read, shadowed };
}

function detectLocks(root, ignored) {
	const out = [];
	const present = LOCKFILES.filter((l) => fs.existsSync(path.join(root, l.file)));
	const tracked = gitTracked(root, present.map((l) => l.file));
	for (const l of present) {
		let version = null;
		if (l.file === 'package-lock.json') {
			const j = readJson(root, l.file);
			version = j && !j._broken ? (j.lockfileVersion ?? null) : null;
		}
		const isIgnored = ignored.includes(l.file);
		out.push({ file: l.file, manager: l.manager, version, ignored: isIgnored,
			tracked: tracked ? tracked.has(l.file) : null,
			committed: tracked ? tracked.has(l.file) : !isIgnored });
	}
	return out;
}

// A .gitignore entry keeps only untracked files out: a file committed before the
// entry, or added with git add -f, stays in every clone. Where the root lies in a
// git work tree, git answers what is committed; null means it cannot, and the
// caller falls back to .gitignore. safe.directory keeps git from refusing a
// checkout whose owner differs from the user inside the container.
function gitTracked(root, files) {
	if (!files.length) return new Set();
	const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', root, 'ls-files', '-z', '--', ...files],
		{ encoding: 'utf8' });
	return r.error || r.status !== 0 ? null : new Set(r.stdout.split('\0').filter(Boolean));
}

// Names a .gitignore keeps out of the repository. Only the plain forms matter
// here: a lockfile is ignored as its own name, never through a pattern.
function gitignored(root) {
	const text = readText(root, '.gitignore');
	if (text === null) return [];
	return text.split('\n')
		.map((l) => l.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
		.filter((l) => l && !l.startsWith('#'));
}

// A workflow that runs a linter or a test runner checks the code and builds no
// release asset, so the Node it runs on does not reach what is shipped.
const CHECK_RUNNERS = /\b(?:cypress|playwright|selenium|jest|vitest|eslint|stylelint)\b|\bnpm\s+(?:run\s+)?(?:test|lint|stylelint|e2e)\b/i;

// What the installed workflows run on. Read textually for the same reason info.xml
// is: a YAML parser is a dependency, and the two keys wanted here are unambiguous
// in every generated workflow.
function readWorkflows(root) {
	const dir = path.join(root, '.github', 'workflows');
	if (!fs.existsSync(dir)) return { dir, present: false, files: [], byFile: [], node: [], php: [] };
	const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
	const node = new Set();
	const php = new Set();
	const byFile = [];
	for (const f of files) {
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		const own = { file: f, checks: CHECK_RUNNERS.test(text), node: [], php: [] };
		own.node.push(...keyValues(text, /node-version:[ \t]*(.*)$/));
		own.php.push(...keyValues(text, /php-versions?:[ \t]*(.*)$/));
		own.node = [...new Set(own.node)].sort();
		own.php = [...new Set(own.php)].sort();
		for (const v of own.node) node.add(v);
		for (const v of own.php) php.add(v);
		byFile.push(own);
	}
	return { dir, present: true, files, byFile, node: [...node].sort(), php: [...php].sort() };
}

// The name of the directory the checkout sits in. Inside the throwaway container
// the app is mounted at /app, so the mount point says nothing about the app; the
// make module hands the real name in, and it is used only when the audited path is
// the working directory itself.
function appDirName(dir) {
	const resolved = path.resolve(dir);
	const handed = process.env.CONSISTENCY_AUDIT_APPDIR;
	if (handed && resolved === path.resolve(process.cwd())) return handed;
	return path.basename(resolved);
}

// One value, an inline list, or a reference to something this analyser cannot
// resolve. A ${{ ... }} expression is reported as such rather than guessed at.
// The values of a workflow key. A key with nothing after it on its line holds
// what the block below it lists, as a matrix written one entry per line does;
// a mapping there, such as the description of an input of that name, is no value.
function keyValues(text, re) {
	const out = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const m = lines[i].match(re);
		if (!m) continue;
		if (m[1].split('#')[0].trim()) {
			out.push(...versionList(m[1]));
			continue;
		}
		for (let j = i + 1; j < lines.length; j += 1) {
			const line = lines[j].trim();
			if (!line || line.startsWith('#')) continue;
			const item = lines[j].match(/^([ \t]*)-[ \t]+(.*)$/);
			if (!item || item[1].length < m.index || /^[\w-]+:(?:\s|$)/.test(item[2])) break;
			out.push(...versionList(item[2]));
		}
	}
	return out;
}

function versionList(raw) {
	const s = raw.split('#')[0].trim();
	if (!s) return [];
	if (s.includes('${{')) return [FROM_VARIABLE];
	const inner = s.startsWith('[') ? s.slice(1, s.indexOf(']') === -1 ? s.length : s.indexOf(']')) : s;
	return inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

// A workflow can read its version from a variable this analyser cannot follow.
// That is not a stated version, and it is not an absent one either.
const FROM_VARIABLE = '(from a variable)';

// == Versions ==
// The first number of a range, whatever form the range takes. Enough to compare
// statements about a platform, which is what this audit does; it is not a semver
// implementation and does not pretend to resolve a range.
function majorOf(raw) {
	if (!raw) return null;
	const m = String(raw).match(/(\d+)/);
	return m ? Number(m[1]) : null;
}

// The majors a range admits, as a list of [lowest, highest] spans, one per ||
// alternative, highest Infinity where the range is open. A range states which
// majors are allowed, not which one the app is built on, so it is checked against
// the versions that are stated instead of being compared with them. null where
// a comparator has a form this reading does not cover.
const RE_COMPARATOR = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][\w.-]*)?$/;
function majorSpans(raw) {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	const spans = [];
	for (const alt of raw.split('||')) {
		let lo = 0;
		let hi = Infinity;
		const text = alt.trim().replace(/([<>]=?|=|\^|~)\s+/g, '$1');
		const hyphen = text.match(/^(\S+)\s+-\s+(\S+)$/);
		const comparators = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : text.split(/\s+/).filter(Boolean);
		for (const c of comparators) {
			const m = c.match(RE_COMPARATOR);
			if (!m) return null;
			const [, op = '', major, minor, patch] = m;
			if (!/^\d+$/.test(major)) continue;
			const n = Number(major);
			// A strict bound excludes its own major only where it covers all of it:
			// >20 and <21.0.0 do, >20.0.0 and <21.4 leave part of the major in.
			const noMinor = !/^\d+$/.test(minor ?? '');
			const atStart = noMinor || (Number(minor) === 0 && !/[1-9]/.test(patch ?? ''));
			if (op === '>=') lo = Math.max(lo, n);
			else if (op === '>') lo = Math.max(lo, noMinor ? n + 1 : n);
			else if (op === '<=') hi = Math.min(hi, n);
			else if (op === '<') hi = Math.min(hi, atStart ? n - 1 : n);
			else { lo = Math.max(lo, n); hi = Math.min(hi, n); }
		}
		if (lo <= hi) spans.push([lo, hi]);
	}
	return spans;
}

const admits = (spans, major) => spans.some(([lo, hi]) => major >= lo && major <= hi);

const parts = (v) => String(v ?? '').split(/[^0-9]+/).filter(Boolean).map(Number);

// Compares two dotted versions, shorter one padded with zeros.
function cmpVersion(a, b) {
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	return 0;
}

// The SPDX id of one licence of an expression in its canonical case, with the '+'
// and the WITH exception the expression allows, or null. A LicenseRef- id names a
// licence of the app's own and is valid as written.
function spdxId(value) {
	const [licence, exception, extra] = value.split(/\s+with\s+/i);
	if (extra !== undefined) return null;
	const plus = licence.endsWith('+');
	const key = (plus ? licence.slice(0, -1) : licence).toLowerCase();
	const id = key.startsWith('licenseref-') ? licence.slice(0, plus ? -1 : undefined) : SPDX_LICENCES.get(key);
	if (!id) return null;
	if (exception === undefined) return `${id}${plus ? '+' : ''}`;
	const ex = SPDX_EXCEPTIONS.get(exception.toLowerCase());
	return ex ? `${id}${plus ? '+' : ''} WITH ${ex}` : null;
}

// What a licence statement names, as SPDX ids: an expression in package.json, a
// string or a list in composer.json, any number of elements in info.xml. Each id
// is read on its own; 'id' is null where the value does not say which licence is
// meant, so 'agpl' in info.xml and 'AGPL-3.0-or-later' in package.json compare as
// the same licence, and 'AGPL-3.0-only' against either does not. An SPDX id that
// info.xml states and the App Store does not accept is 'unlisted'; it still names
// its licence for the comparison.
function readLicences(where, value) {
	return (Array.isArray(value) ? value : [value])
		.filter((v) => typeof v === 'string' && v.trim())
		.flatMap((v) => v.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+/i))
		.map((v) => v.trim())
		.map((value) => {
			const key = value.toLowerCase();
			const info = where === 'appinfo/info.xml';
			const legacy = info ? APPSTORE_LEGACY.get(key) : undefined;
			if (legacy) return { where, value, id: legacy.id, kind: 'appstore', name: legacy.name };
			if (SPDX_DEPRECATED.has(key)) return { where, value, id: SPDX_DEPRECATED.get(key), kind: 'deprecated' };
			const id = spdxId(value);
			if (id) return { where, value, id, kind: !info || APPSTORE_IDS.has(id) ? 'spdx' : 'unlisted' };
			return { where, value, id: null, kind: 'none' };
		});
}

// What .nvmrc states. An alias names a release train this analyser cannot resolve
// without the network, so it is carried as unresolved instead of being mapped.
function readNvmrc(root) {
	const text = readText(root, '.nvmrc');
	if (text === null) return null;
	const value = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0] ?? '';
	return { value, major: /^v?\d/.test(value) ? majorOf(value) : null };
}

// == Dependencies ==
// Only the npm side is checked for references. A composer package is reached
// through a namespace, not through its vendor/name, so a literal scan would
// accuse every one of them.
function collectDeps(pkg) {
	const out = [];
	if (!pkg || pkg._broken) return out;
	for (const section of ['dependencies', 'devDependencies']) {
		for (const [name, range] of Object.entries(pkg[section] ?? {})) out.push({ name, range, section });
	}
	return out;
}

// Everything package.json states apart from the dependency sections. A package
// named only in its own declaration is not referenced; named in a script, in
// browserslist or in any other field it is.
function pkgHaystack(pkg) {
	if (!pkg || pkg._broken) return '';
	const rest = { ...pkg };
	for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) delete rest[k];
	return JSON.stringify(rest);
}

function listFiles(root) {
	const out = [];
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r);
			} else if (e.isFile()) {
				out.push(r);
			}
		}
	};
	walk(root, '');
	return out;
}

// Where each package is named outside its own declaration. A plain substring
// search over the checkout: it can call a package used that is only mentioned in
// prose, and that is the direction to err in - a wrong "unused" would send someone
// to remove a package the build needs.
function scanReferences(root, deps, pkg) {
	const lockNames = LOCKFILES.map((l) => l.file);
	const files = listFiles(root).filter((f) => {
		const base = path.basename(f);
		return base !== 'package.json' && !lockNames.includes(base) && !SKIP_EXT.has(path.extname(f).toLowerCase());
	});
	const open = new Map(deps.map((d) => [d.name, null]));
	const hay = pkgHaystack(pkg);
	for (const name of [...open.keys()]) if (hay.includes(name)) open.set(name, 'package.json');
	let read = 0;
	for (const rel of files) {
		if ([...open.values()].every(Boolean)) break;
		const abs = path.join(root, rel);
		let text;
		try {
			if (fs.statSync(abs).size > READ_MAX) continue;
			text = fs.readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		read += 1;
		for (const [name, seen] of open) if (!seen && text.includes(name)) open.set(name, rel);
	}
	return { files: files.length, read, at: open, list: files };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The name ESLint expands to a package: 'eslint-config-' and 'eslint-plugin-' are
// left out, and a scope alone stands for its eslint-config or eslint-plugin.
function eslintShorthand(name) {
	const m = name.match(/^(?:(@[^/]+)\/)?eslint-(config|plugin)(?:-(.+))?$/);
	if (!m || (!m[1] && !m[3])) return null;
	return { short: m[1] ? (m[3] ? `${m[1]}/${m[3]}` : m[1]) : m[3], plugin: m[2] === 'plugin' };
}

// Which installed packages name each package as a peer, from package-lock.json. A
// lockfile before version 2 does not record peers, and then nothing is found here.
function lockPeers(root) {
	const peers = new Map();
	for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
		const lock = readJson(root, file);
		if (!lock || lock._broken) continue;
		for (const [key, entry] of Object.entries(lock.packages ?? {})) {
			if (!key) continue;
			const declarer = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
			for (const name of Object.keys(entry.peerDependencies ?? {})) {
				peers.set(name, [...new Set([...(peers.get(name) ?? []), declarer])]);
			}
		}
		return { file, peers };
	}
	return { file: null, peers };
}

// Packages a tool loads without their name being written: ESLint expands a
// shorthand, TypeScript reads tsconfig.json and takes every @types package unless
// compilerOptions.types narrows the list, and a package another one declares as a
// peer - a loader, a template compiler, a coverage provider - is resolved by that
// package. A peer of a declared package that is itself used nowhere does not count.
function resolveConventions(root, deps, pkg, scan) {
	const via = new Map();
	const open = () => deps.filter((d) => !scan.at.get(d.name) && !via.has(d.name));
	const texts = (files) => files.map((f) => ({ f, text: readText(root, f) ?? '' }));

	const eslint = texts(scan.list.filter((f) => /(?:^|\/)(?:\.eslintrc(?:\.\w+)?|eslint\.config\.[cm]?[jt]s)$/.test(f)));
	if (pkg.eslintConfig) eslint.push({ f: 'package.json', text: JSON.stringify(pkg.eslintConfig) });
	for (const d of open()) {
		const sh = eslintShorthand(d.name);
		if (!sh) continue;
		const s = escapeRe(sh.short);
		const re = new RegExp(sh.plugin ? `["'](?:${s}["']|plugin:${s}/)` : `["']${s}["']`);
		const hit = eslint.find((e) => re.test(e.text));
		if (hit) via.set(d.name, { at: hit.f, via: `ESLint shorthand ${sh.plugin ? `plugin ${sh.short}` : sh.short}` });
	}

	const tsconfigs = texts(scan.list.filter((f) => /(?:^|\/)tsconfig[\w.-]*\.json$/.test(f)));
	if (tsconfigs.length) {
		const unnarrowed = tsconfigs.find((t) => !/"types"\s*:/.test(t.text));
		let sources = null;
		for (const d of open()) {
			if (d.name === 'typescript') {
				via.set(d.name, { at: tsconfigs[0].f, via: 'reads it' });
			} else if (d.name.startsWith('@types/')) {
				if (unnarrowed) {
					via.set(d.name, { at: unnarrowed.f, via: 'TypeScript includes every @types package' });
					continue;
				}
				// Where every tsconfig narrows the list, a package is still taken when a
				// list names it, a reference directive does, or a source imports what it
				// types.
				const typed = d.name.slice('@types/'.length).replace(/^(.+)__/, '@$1/');
				const listed = new RegExp(`"types"\\s*:\\s*\\[[^\\]]*"${escapeRe(typed)}"`);
				const hitList = tsconfigs.find((t) => listed.test(t.text));
				if (hitList) {
					via.set(d.name, { at: hitList.f, via: 'listed in compilerOptions.types' });
					continue;
				}
				const imported = new RegExp(`(?:\\bfrom|\\bimport|\\brequire|reference\\s+types=)\\s*\\(?\\s*["']${escapeRe(typed)}["'/]`);
				sources ??= texts(scan.list.filter((f) => fs.statSync(path.join(root, f)).size <= READ_MAX));
				const hit = sources.find((t) => imported.test(t.text));
				if (hit) via.set(d.name, { at: hit.f, via: `types of ${typed}` });
			}
		}
	}

	const { file, peers } = lockPeers(root);
	const declared = new Set(deps.map((d) => d.name));
	for (let changed = true; changed;) {
		changed = false;
		const unused = new Set(open().map((d) => d.name));
		for (const d of open()) {
			const by = (peers.get(d.name) ?? []).filter((p) => p !== d.name && !(declared.has(p) && unused.has(p)));
			if (!by.length) continue;
			via.set(d.name, { at: file, via: `peer of ${by.slice(0, 2).join(', ')}${by.length > 2 ? ` and ${num(by.length - 2)} more` : ''}` });
			changed = true;
		}
	}
	return via;
}

// == Run-time paths ==
// The directories the app reads at run time. The PHP that ships reaches one through
// __DIR__, the frontend through linkTo or generateFilePath with the app id, which
// @nextcloud/router resolves below the root of the app. imagePath is not followed:
// it always resolves into img/, which ships.
const RE_PHP_DIR = /(?:\bdirname\(\s*(__DIR__|__FILE__)\s*(?:,\s*(\d+)\s*)?\)|\b__DIR__)\s*\.\s*(['"])([^'"$]*)\3/g;
const FRONTEND_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.vue']);

// A keep path covers what lies below it, and a path below a directory covers that
// directory: keep_extra naming one file of it shows the directory is known.
function kept(rel, keep) {
	return keep.some((k) => new RegExp(`^${k.split('*').map(escapeRe).join('[^/]*')}(?:/|$)`).test(rel)
		|| k.startsWith(`${rel}/`));
}

function runtimeDirs(root, appId, keep) {
	const dirs = new Map();
	const note = (rel, at, via) => {
		const top = rel.split('/')[0];
		if (!top || top === '.' || top === '..' || kept(top, keep)) return;
		if (!fs.statSync(path.join(root, top), { throwIfNoEntry: false })?.isDirectory()) return;
		if (!dirs.has(top)) dirs.set(top, []);
		dirs.get(top).push({ at, via });
	};
	const lineOf = (text, index) => text.slice(0, index).split('\n').length;
	const read = (rel) => {
		try {
			const abs = path.join(root, rel);
			return fs.statSync(abs).size > READ_MAX ? null : fs.readFileSync(abs, 'utf8');
		} catch {
			return null;
		}
	};
	const re = appId && new RegExp(`\\b(linkTo|generateFilePath)\\(\\s*(['"\`])${escapeRe(appId)}\\2\\s*,\\s*(['"\`])([^'"\`$]*)\\3`, 'g');
	for (const f of listFiles(root)) {
		const ext = path.extname(f).toLowerCase();
		// composer/ is the generated autoloader, which points into vendor/ and lib/.
		if (ext === '.php' && kept(f, keep) && !f.startsWith('composer/')) {
			const text = read(f);
			if (text === null) continue;
			for (const m of text.matchAll(RE_PHP_DIR)) {
				// dirname(__FILE__) is __DIR__, so it climbs one level less.
				const levels = m[1] ? Number(m[2] ?? 1) - (m[1] === '__FILE__' ? 1 : 0) : 0;
				const base = path.posix.join(path.posix.dirname(f), ...Array(levels).fill('..'));
				note(path.posix.normalize(path.posix.join(base, m[4])), `${f}:${lineOf(text, m.index)}`,
					m[1] ? `dirname(${m[1]}${m[2] ? `, ${m[2]}` : ''})` : '__DIR__');
			}
		} else if (FRONTEND_EXT.has(ext) && re) {
			const text = read(f);
			if (text === null) continue;
			for (const m of text.matchAll(re)) {
				// linkTo names the file below the root of the app, generateFilePath the
				// directory first. A PHP file is a route, not a file the app ships.
				if (m[1] === 'linkTo' && m[4].endsWith('php')) continue;
				note(path.posix.normalize(m[4].replace(/^\/+/, '')), `${f}:${lineOf(text, m.index)}`, m[1]);
			}
		}
	}
	return [...dirs].map(([dir, refs]) => ({ dir, refs })).sort((a, b) => a.dir.localeCompare(b.dir));
}

// == The report model ==
const BUNDLER_PKGS = ['vite', 'webpack', '@nextcloud/vite-config', '@nextcloud/webpack-vue-config'];

// What a lockfile would pin. The packages composer installs into the shipped
// vendor tree, by the test the build uses to decide whether composer runs: php,
// ext-* and the bamarni/composer-bin-plugin are no package of the release.
// null where the manifest is unreadable, so nothing is concluded from it.
const npmRanges = (pkg) => (pkg._broken ? null
	: ['dependencies', 'devDependencies', 'optionalDependencies'].reduce((n, s) => n + Object.keys(pkg[s] ?? {}).length, 0));
const composerPackages = (composer) => (composer._broken ? null
	: Object.keys(composer.require ?? {}).filter((k) => k !== 'php' && k !== 'bamarni/composer-bin-plugin' && !k.startsWith('ext-')));

// The PHP extensions the shipped code requires, each with what requires it: the
// require of composer.json and of every package composer.lock installs. Dev
// requirements never reach the release.
function composerExtensions(composer, lock) {
	const by = new Map();
	const note = (require, who) => {
		for (const k of Object.keys(require ?? {})) {
			if (!k.toLowerCase().startsWith('ext-')) continue;
			const ext = k.slice(4).toLowerCase();
			if (!by.has(ext)) by.set(ext, []);
			if (!by.get(ext).includes(who)) by.get(ext).push(who);
		}
	};
	if (composer && !composer._broken) note(composer.require, 'composer.json');
	if (lock && !lock._broken && Array.isArray(lock.packages)) {
		for (const p of lock.packages) note(p?.require, p?.name ?? 'composer.lock');
	}
	return [...by].map(([ext, who]) => ({ ext, by: who })).sort((a, b) => a.ext.localeCompare(b.ext));
}

function audit(opt) {
	const root = opt.dir;
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`not a directory: ${root}`);

	const info = readInfo(root);
	const pkg = readJson(root, 'package.json');
	const composer = readJson(root, 'composer.json');
	const composerLock = readJson(root, 'composer.lock');
	const ignored = gitignored(root);
	const deps = collectDeps(pkg);
	const scan = pkg && !pkg._broken ? scanReferences(root, deps, pkg) : { files: 0, read: 0, at: new Map(), list: [] };
	const conventions = pkg && !pkg._broken ? resolveConventions(root, deps, pkg, scan) : new Map();
	const keep = keepSet();
	const newest = newestMajor();

	return {
		tool: 'consistency-audit',
		root,
		dirName: appDirName(root),
		server: { ...NC, newest: newest.major, newestFrom: newest.from, master: masterMajor() },
		nodeSchedule: nodeSchedule(),
		app: info && {
			id: info.id,
			names: info.names,
			version: info.version,
			licences: info.licences,
			repository: info.repository,
			bugs: info.bugs,
			website: info.website,
			links: info.links,
			nextcloud: info.nextcloud ? { min: info.nextcloud['min-version'] ?? null, max: info.nextcloud['max-version'] ?? null } : null,
			php: info.php ? { min: info.php['min-version'] ?? null, max: info.php['max-version'] ?? null } : null,
			libs: info.libs,
		},
		package: pkg && {
			broken: pkg._broken,
			name: pkg.name ?? null,
			version: pkg.version ?? null,
			license: pkg.license ?? null,
			node: pkg.engines?.node ?? null,
			packageManager: pkg.packageManager ?? null,
			scripts: typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {},
			bundlers: BUNDLER_PKGS.filter((p) => (pkg.dependencies ?? {})[p] || (pkg.devDependencies ?? {})[p]),
			ranges: npmRanges(pkg),
		},
		composer: composer && {
			broken: composer._broken,
			name: composer.name ?? null,
			license: composer.license ?? null,
			php: composer.require?.php ?? null,
			platformPhp: composer.config?.platform?.php ?? null,
			packages: composerPackages(composer),
			scripts: typeof composer.scripts === 'object' && composer.scripts ? composer.scripts : {},
			lockRead: Boolean(composerLock && !composerLock._broken),
			extensions: composerExtensions(composer, composerLock),
		},
		nvmrc: readNvmrc(root),
		tools: detectTools(root, pkg, listScripts(pkg, composer)),
		licenses: fs.existsSync(path.join(root, 'LICENSES'))
			? fs.readdirSync(path.join(root, 'LICENSES')).filter((f) => f.endsWith('.txt')).sort()
			: null,
		makefile: detectMakefile(root),
		locks: detectLocks(root, ignored),
		ci: readWorkflows(root),
		deps: deps.map((d) => ({ ...d, at: scan.at.get(d.name) ?? conventions.get(d.name)?.at ?? null,
			via: conventions.get(d.name)?.via ?? null })),
		scan: { files: scan.files, read: scan.read },
		runtime: info && { keep: keep.paths, keepFrom: keep.from, dirs: runtimeDirs(root, info.id, keep.paths) },
		findings: [],
	};
}

// == The links of info.xml ==
// Whether each link of the App Store listing leads anywhere: one HEAD per link,
// a GET where a server refuses HEAD, redirects followed one hop at a time so a
// permanent one can be named, and each URL asked once per run. The one network
// read of the audit; --no-network leaves it out.
const LINK_TIMEOUT = 10000;
const LINK_HOPS = 5;
const LINK_UA = 'ncmake consistency-audit (+https://github.com/ernolf/ncmake)';

async function request(url, method) {
	const res = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(LINK_TIMEOUT), headers: { 'user-agent': LINK_UA } });
	res.body?.cancel().catch(() => {});
	return res;
}

// What a failed request says about the link: a host that does not resolve is
// dead, a timeout or a refused connection may be temporary.
function failure(e) {
	if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { error: 'timeout' };
	const code = e?.cause?.code ?? e?.code ?? null;
	if (code === 'ENOTFOUND') return { error: 'unresolved' };
	return { error: 'connection', code };
}

async function probe(url) {
	let current = url;
	let permanent = true;
	for (let hop = 0; hop <= LINK_HOPS; hop++) {
		let res;
		try {
			res = await request(current, 'HEAD');
			if ([400, 403, 405, 501].includes(res.status)) res = await request(current, 'GET');
		} catch (e) {
			return { ...failure(e), final: current, hops: hop };
		}
		const location = res.headers.get('location');
		if (res.status >= 300 && res.status < 400 && location) {
			permanent &&= res.status === 301 || res.status === 308;
			try {
				current = new URL(location, current).href;
			} catch {
				return { status: res.status, final: current, hops: hop };
			}
			continue;
		}
		return { status: res.status, type: res.headers.get('content-type'), final: current, hops: hop, permanent: hop > 0 && permanent };
	}
	return { error: 'redirects', final: current, hops: LINK_HOPS };
}

// The repository of origin, owner/repo, for the screenshots pinned to a release
// tag of it, which make version moves along with the version (#304).
function originSlug(root) {
	const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
	if (r.status !== 0) return null;
	return r.stdout.trim().replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') || null;
}
const hasTag = (root, tag) => spawnSync('git', ['-c', 'safe.directory=*', '-C', root, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0;

// A screenshot pinned to a release tag of the app's own repository that does not
// answer, while this checkout has no such tag: make version moved it to the next
// release, which is not tagged yet. The URL answers once the tag is pushed; until
// then the file has to be in the working tree the tag will be cut from. A tag the
// checkout lacks but origin has, as in a shallow clone, answers and is not asked.
function pendingTag(root, slug, link) {
	if (!slug || !link.element.startsWith('<screenshot')) return null;
	const own = escapeRe(slug);
	const m = new RegExp(`^https://(?:raw\\.githubusercontent\\.com/${own}/|cdn\\.jsdelivr\\.net/gh/${own}@)(v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)/([^?#]+)`, 'i').exec(link.url);
	if (!m || hasTag(root, m[1])) return null;
	const file = decodeURIComponent(m[2]);
	return { tag: m[1], path: file, present: fs.existsSync(path.join(root, file)) };
}

async function checkLinks(r, opt) {
	const links = r.app?.links ?? [];
	if (!links.length || !opt.network) return { checked: false, network: opt.network, list: links.map((l) => ({ ...l })) };
	const slug = originSlug(r.root);
	const asked = new Map();
	const ask = (url) => {
		if (!asked.has(url)) asked.set(url, probe(url));
		return asked.get(url);
	};
	const list = await Promise.all(links.map(async (l) => {
		if (!/^https?:\/\//i.test(l.url)) return { ...l, error: 'scheme' };
		const out = { ...l, ...await ask(l.url) };
		if (out.status === 404) {
			const pending = pendingTag(r.root, slug, l);
			if (pending) return { ...l, pending };
		}
		// A plain http link the server does not move to https: whether the same
		// address answers over https.
		if (/^http:/i.test(l.url) && !out.error && out.status < 400 && !/^https:/i.test(out.final)) {
			const secure = await ask(l.url.replace(/^http:/i, 'https:'));
			out.https = !secure.error && secure.status < 400;
		}
		return out;
	}));
	return { checked: true, network: true, list };
}

// == Findings ==
// A finding names the files it read and what they say. Where the checkout is
// silent, the finding says what is missing and why it would be worth stating,
// which is not the same as claiming a defect.
function findings(r) {
	const out = [];
	const add = (level, id, lines) => out.push({ level, id, lines });
	// One finding per id: where several statements share one, the finding carries
	// them all at the level of the worst.
	const worst = (levels) => ['warn', 'info', 'ok'].find((l) => levels.includes(l));
	const app = r.app;
	const pkg = r.package;
	const asOf = `as of ${r.server.asOf}`;

	// -- is this a Nextcloud app at all --
	if (!app) {
		add('info', 'not-an-app', [
			'No appinfo/info.xml here, so this is not a Nextcloud app checkout, or not its root.',
			'  Everything the server and the App Store read comes from that file; without it'
			+ ' the version, the licence, the supported servers and the source link cannot be'
			+ ' checked against anything.',
		]);
	}
	const broken = [['package.json', pkg], ['composer.json', r.composer]].filter(([, f]) => f?.broken).map(([name]) => name);
	if (broken.length) {
		const one = broken.length === 1;
		add('warn', 'unreadable-json', [
			`${broken.join(' and ')} ${one ? 'is' : 'are'} present but ${one ? 'does' : 'do'} not parse as JSON.`,
			`  Every tool that reads ${one ? 'it' : 'them'} fails the same way, so nothing ${one ? 'this file states' : 'these files state'}`
			+ ' could be taken into account here.',
		]);
	}

	// -- the version, stated twice --
	if (app?.version && pkg && !pkg.broken && pkg.version) {
		if (cmpVersion(app.version, pkg.version) === 0) {
			add('ok', 'versions-agree', [`Version ${app.version} in appinfo/info.xml and package.json.`]);
		} else {
			add('warn', 'version-drift', [
				`Version drift: appinfo/info.xml says ${app.version}, package.json says ${pkg.version}.`,
				'  The App Store and the server read info.xml; everything on the node side reads'
				+ ' package.json. Whichever is behind, a release ends up carrying two version'
				+ ' numbers, and only one of them reaches the user.',
			]);
		}
	} else if (app?.version && pkg && !pkg.broken && !pkg.version) {
		add('info', 'version-drift', [
			`Version ${app.version} in appinfo/info.xml; package.json states no version.`,
			'  Nothing is inconsistent then, and nothing has to be kept in step either. Stating'
			+ ' it in both places is what makes a release bump reviewable in the diff.',
		]);
	} else if (!app?.version && app) {
		add('warn', 'version-drift', ['appinfo/info.xml states no version, which the App Store requires.']);
	}

	// -- the app id against the directory it sits in --
	if (app?.id) {
		const dir = r.dirName;
		if (dir !== app.id) {
			add('info', 'app-id', [
				`The app id is ${app.id}, the checkout directory is ${dir}.`,
				'  The server finds an app by its directory name, so the installed directory has'
				+ ' to be named after the id. A checkout can be named anything, which is why this'
				+ ' is a note and not a defect - but a tarball built from this directory name'
				+ ' would not load.',
			]);
		}
	}

	// -- the name the App Store shows --
	if (app) {
		const named = [...new Set(app.names.filter((n) => /nextcloud/i.test(n)))];
		if (named.length) {
			add('warn', 'app-name', [
				`The app name ${named.join(', ')} in appinfo/info.xml uses Nextcloud.`,
				'  The App Store publishing rules say apps must not use Nextcloud in their name;'
				+ ' a name that does reads as an app of Nextcloud itself.',
			]);
		}
	}

	// -- where a release points back to --
	if (app) {
		const shape = (u) => (u && /^https?:\/\/\S+$/.test(u.trim()));
		const missing = [];
		if (!app.repository) missing.push('<repository>');
		if (!app.bugs) missing.push('<bugs>');
		if (missing.length) {
			add('warn', 'repository-link', [
				`appinfo/info.xml states no ${missing.join(' and no ')}.`,
				'  <repository> is the only machine-readable link from a published release back to'
				+ ' the source it was built from, and <bugs> is where the App Store page sends a'
				+ ' report. Without them a user of the release has no way back to the project.',
			]);
		} else if (!shape(app.repository) || !shape(app.bugs)) {
			add('warn', 'repository-link', [
				'A link in appinfo/info.xml is not an http(s) URL:'
				+ `${shape(app.repository) ? '' : ` <repository> ${app.repository}`}`
				+ `${shape(app.bugs) ? '' : ` <bugs> ${app.bugs}`}.`,
				'  Neither a browser nor the App Store can follow it; whether an http(s) link'
				+ ' answers is checked under link-dead.',
			]);
		} else {
			add('ok', 'repository-link', ['appinfo/info.xml links its repository and its bug tracker.']);
		}
	}

	// -- whether the links lead anywhere --
	if (app?.links?.length) {
		const L = r.links;
		const n = app.links.length;
		const many = n === 1 ? 'link' : `${n} links`;
		const where = (l) => `  ${l.element} ${l.url}`;
		const after = (l) => (l.final && l.final !== l.url ? `, after a redirect to ${l.final}` : '');
		const answer = (l) => ({
			unresolved: 'its host does not resolve',
			timeout: `no answer within ${LINK_TIMEOUT / 1000} s`,
			connection: `the connection failed${l.code ? ` (${l.code})` : ''}`,
			redirects: `more than ${LINK_HOPS} redirects`,
			scheme: 'not an http(s) URL',
		}[l.error] ?? `HTTP ${l.status}`) + after(l);
		const answered = L.list.filter((l) => l.status);
		if (!L.checked) {
			add('info', 'link-unchecked', [
				`The ${many} of appinfo/info.xml ${n === 1 ? 'is' : 'are'} not checked: the run reads no network (NO_NETWORK=1 or --no-network).`,
			]);
		} else if (!answered.length && L.list.some((l) => l.error && l.error !== 'scheme' && l.error !== 'unresolved')) {
			add('info', 'link-unchecked', [
				`None of the ${many} of appinfo/info.xml answered, so they are left unchecked.`,
				'  Most likely this run has no network; NO_NETWORK=1 says so up front.',
			]);
		} else {
			const isShot = (l) => l.element.startsWith('<screenshot');
			const ownField = (l) => l.element === '<repository>' || l.element === '<bugs>';
			const dead = L.list.filter((l) => (l.pending && !l.pending.present)
				|| [404, 410].includes(l.status) || l.error === 'unresolved' || (l.error === 'scheme' && !ownField(l)));
			const failing = L.list.filter((l) => !dead.includes(l) && !l.pending
				&& (l.status >= 400 || ['timeout', 'connection', 'redirects'].includes(l.error)));
			const notImage = L.list.filter((l) => isShot(l) && l.status >= 200 && l.status < 300
				&& !/^image\//i.test(l.type ?? ''));
			// A move that only drops .git or a trailing slash is the same address:
			// <repository> names the git URL, which the forge sends to its page.
			const bare = (u) => u.toLowerCase().replace(/(\.git)?\/?$/, '');
			const moved = L.list.filter((l) => l.permanent && l.status >= 200 && l.status < 300 && bare(l.final) !== bare(l.url));
			const insecure = L.list.filter((l) => l.https);
			const pending = L.list.filter((l) => l.pending?.present);
			if (dead.length) {
				add('warn', 'link-dead', [
					`${dead.length === 1 ? 'A link' : `${dead.length} links`} of appinfo/info.xml ${dead.length === 1 ? 'leads' : 'lead'} nowhere:`,
					...dead.map((l) => `${where(l)}: ${l.pending
						? `tag ${l.pending.tag} does not exist yet and ${l.pending.path} is not in the working tree`
						: answer(l)}`),
					'  The App Store page shows these links as they are; a reader who follows one ends'
					+ ' on an error page.',
				]);
			}
			if (notImage.length) {
				add('warn', 'screenshot-not-image', [
					`${notImage.length === 1 ? 'A screenshot' : `${notImage.length} screenshots`} of appinfo/info.xml ${notImage.length === 1 ? 'is' : 'are'} not served as an image:`,
					...notImage.map((l) => `${where(l)}: ${l.type ?? 'no content type'}${after(l)}`),
					'  The App Store shows the bytes behind the URL, so it needs the image itself;'
					+ ' a github.com/.../blob/... URL is the page around it, raw.githubusercontent.com'
					+ ' serves the file.',
				]);
			}
			if (failing.length) {
				add('info', 'link-error', [
					`${failing.length === 1 ? 'A link' : `${failing.length} links`} of appinfo/info.xml did not answer as expected:`,
					...failing.map((l) => `${where(l)}: ${answer(l)}`),
					'  This may be temporary, or a server that refuses requests without a browser;'
					+ ' worth opening once by hand.',
				]);
			}
			if (moved.length) {
				add('info', 'link-redirect', [
					`${moved.length === 1 ? 'A link' : `${moved.length} links`} of appinfo/info.xml ${moved.length === 1 ? 'has' : 'have'} moved permanently:`,
					...moved.flatMap((l) => [where(l), `    now ${l.final}`]),
					'  The old address works only as long as the redirect is kept; the new one can'
					+ ' be stated directly.',
				]);
			}
			if (insecure.length) {
				add('info', 'link-insecure', [
					`${insecure.length === 1 ? 'A link' : `${insecure.length} links`} of appinfo/info.xml ${insecure.length === 1 ? 'uses' : 'use'} http, while the same address answers over https:`,
					...insecure.map(where),
				]);
			}
			if (pending.length) {
				add('info', 'link-pending', [
					`${pending.length === 1 ? 'A screenshot points' : `${pending.length} screenshots point`} to a release tag that does not exist yet:`,
					...pending.map((l) => `${where(l)}: ${l.pending.path} is in the working tree`),
					'  make version moved them to the next release; they answer once that tag is pushed.',
				]);
			}
			if (!dead.length && !notImage.length && !failing.length && !moved.length && !insecure.length) {
				add('ok', 'link-dead', [`The ${many} of appinfo/info.xml ${n === 1 ? 'answers' : 'answer'}${pending.length ? ', or will once the next tag is pushed' : ''}.`]);
			}
		}
	}

	// -- which servers the release is for --
	if (app) {
		const nc = app.nextcloud;
		const min = majorOf(nc?.min);
		const max = majorOf(nc?.max);
		if (!nc || (!min && !max)) {
			add('warn', 'nextcloud-support', [
				'appinfo/info.xml declares no <nextcloud> dependency.',
				'  That range is what the App Store matches against a server asking for updates,'
				+ ' and what the server checks before it enables the app. Without it the release'
				+ ' states nothing about where it runs.',
			]);
		} else {
			const lines = [`Declares Nextcloud ${min ?? '?'} to ${max ?? 'no upper bound'}`
				+ `; the oldest maintained major is ${r.server.oldestMaintained} (${asOf}), the newest`
				+ ` released ${r.server.newest} (${r.server.newestFrom}).`];
			let level = 'ok';
			if (!max) {
				level = 'warn';
				lines.push('  Without max-version the range has no end, so the App Store keeps offering'
					+ ' this release to servers that did not exist when it was built.');
			}
			if (min && max && min > max) {
				level = 'warn';
				lines.push(`  min-version ${min} is above max-version ${max}, so the range covers no`
					+ ' server at all.');
			}
			if (min && min > r.server.newest) {
				level = 'warn';
				lines.push(`  min-version ${min} is above the newest released major (${r.server.newest}`
					+ `, ${r.server.newestFrom}), so no server installs this release.`);
			}
			if (max && max > r.server.master.major) {
				level = 'warn';
				lines.push(`  max-version ${max} is above ${r.server.master.major}, the major nextcloud/server`
					+ ` develops on master (${r.server.master.from}), so the server enables the app`
					+ ' and the App Store offers it on majors nobody has run it on.');
			} else if (max && max > r.server.newest + 1) {
				level = 'warn';
				lines.push(`  max-version ${max} is above ${r.server.newest + 1}, the newest released major`
					+ ` plus one (${r.server.newestFrom}). The App Store publishing rules let a release`
					+ ' reach no further than that at the time it is released.');
			}
			if (max && max < r.server.oldestMaintained) {
				level = 'warn';
				lines.push(`  max-version ${max} is below the oldest maintained major`
					+ ` (${r.server.oldestMaintained}, ${asOf}), so the release covers only servers`
					+ ' that no longer receive fixes.');
			}
			if (min && min < r.server.oldestMaintained) {
				if (level === 'ok') level = 'info';
				lines.push(`  min-version ${min} reaches below the oldest maintained major`
					+ ` (${r.server.oldestMaintained}), which means the code has to keep working with`
					+ ' APIs that are no longer tested upstream.');
			}
			add(level, 'nextcloud-support', lines);
		}
	}

	// -- the PHP floor, stated in two files --
	if (app || r.composer) {
		const infoMin = app?.php?.min ?? null;
		const req = r.composer?.broken ? null : (r.composer?.php ?? null);
		const reqMin = req ? req.match(/\d+(?:\.\d+)*/)?.[0] ?? null : null;
		const platform = r.composer?.platformPhp ?? null;
		const composerSays = !r.composer ? 'no composer.json in the checkout'
			: (r.composer.broken ? 'composer.json could not be read' : 'composer.json states no php requirement');
		if (infoMin && reqMin && cmpVersion(infoMin, reqMin) < 0) {
			add('warn', 'php-support', [
				`PHP floor drift: appinfo/info.xml says min-version ${infoMin}, composer.json`
				+ ` requires php ${req}.`,
				'  The server enables the app on PHP from the info.xml bound, below the composer'
				+ ' floor, so packages resolved for that floor can run on a PHP they do not support.',
			]);
		} else if (infoMin && reqMin && cmpVersion(infoMin, reqMin) > 0) {
			// Below min-version the server does not enable the app, and make build
			// resolves vendor/ on that floor or above, so no code runs on the lower bound.
			add('info', 'php-support', [
				`PHP floors differ: appinfo/info.xml says min-version ${infoMin}, composer.json`
				+ ` requires php ${req}.`,
				'  The info.xml floor is the one that applies: the server does not enable the app'
				+ ` below it. The composer requirement can be raised to ${infoMin}.`,
			]);
		} else if (infoMin && reqMin) {
			add('ok', 'php-support', [`PHP ${infoMin} is the floor in appinfo/info.xml and in composer.json`
				+ `${platform ? `, platform ${platform}` : ''}.`]);
		} else if (infoMin || reqMin) {
			add('info', 'php-support', [
				`PHP floor stated once: ${infoMin ? `appinfo/info.xml min-version ${infoMin}` : `composer.json requires php ${req}`}`
				+ `; ${infoMin ? composerSays : 'appinfo/info.xml declares no php dependency'}.`,
				'  Nothing contradicts anything here. Stating it in both places is what keeps a'
				+ ' composer install from resolving packages for a PHP the server will not run.',
			]);
		}
		if (app?.php?.max) {
			const phpMax = app.php.max;
			add('info', 'php-support-max', [
				`appinfo/info.xml caps PHP at max-version ${phpMax}.`,
				'  A server on a newer PHP refuses to enable the app, so this cap has to be'
				+ ' raised deliberately with every PHP release, not left where it was.',
			]);
		}
	}

	// -- the PHP extensions, stated in info.xml and in composer --
	if (app && r.composer && !r.composer.broken) {
		const beyond = r.composer.extensions.filter((e) => !SERVER_EXTENSIONS.has(e.ext));
		const missing = beyond.filter((e) => !app.libs.includes(e.ext));
		const partial = !r.composer.lockRead && r.composer.packages.length
			? ['  composer.lock is not in the checkout, so only composer.json was read; the packages'
				+ ' composer resolves may require more.']
			: [];
		if (missing.length) {
			const one = missing.length === 1;
			add('warn', 'php-extensions', [
				`${plural(missing.length, 'PHP extension is', 'PHP extensions are')} required by composer but`
				+ ' not listed as <lib> in appinfo/info.xml:',
				...missing.map((e) => `  ${e.ext} (${e.by.join(', ')})`),
				`  A Nextcloud server need not load ${one ? 'it' : 'them'}. The server checks <lib>`
				+ ' before it enables the app; composer only checks where it runs. Without the <lib>'
				+ ` the app is enabled anyway and the first call into ${one ? 'the extension' : 'a missing one'}`
				+ ' fails at runtime.',
				...partial,
			]);
		} else if (beyond.length) {
			add(partial.length ? 'info' : 'ok', 'php-extensions', [
				'appinfo/info.xml lists every PHP extension composer requires beyond a standard server'
				+ ` as <lib>: ${beyond.map((e) => e.ext).join(', ')}.`,
				...partial,
			]);
		}
	}

	// -- which Node the app is built with --
	{
		const stated = [];
		// A range takes no part in the comparison of majors; what it admits is
		// checked instead. One that cannot be read is compared by its first number.
		const spans = majorSpans(pkg?.node);
		const engines = pkg?.node
			? { where: 'package.json engines.node', value: pkg.node, major: spans ? null : majorOf(pkg.node) }
			: null;
		if (engines) stated.push(engines);
		if (r.nvmrc) stated.push({ where: '.nvmrc', value: r.nvmrc.value, major: r.nvmrc.major });
		for (const w of r.ci.byFile) {
			for (const v of w.node) {
				if (v !== FROM_VARIABLE) stated.push({ where: w.file, value: v, major: majorOf(v), ci: true, checks: w.checks });
			}
		}
		const ciVariable = r.ci.node.includes(FROM_VARIABLE);
		const ciStated = stated.some((x) => x.ci);
		// The core builds on the newest line the range admits; where every admitted
		// line is past its end, the release gets no security fixes on any of them.
		const pick = spans && nodePick(r.nodeSchedule, spans);
		const ahead = spans && nodeAhead(r.nodeSchedule, spans);
		const dates = r.nodeSchedule.lines;
		const asOf = `  Node release dates from ${r.nodeSchedule.from}, as of ${r.nodeSchedule.today}.`;
		if (pick?.eol) {
			add('warn', 'node-eol', [
				`engines.node ${pkg.node} in package.json admits only end-of-life Node lines:`
					+ ` the release is built on Node ${pick.major}, which reached end of life on ${pick.end}.`,
				'  That Node receives no security fixes, and the lockfile is resolved for it.'
					+ `${pick.oldest ? ` The oldest line still maintained is Node ${pick.oldest}.` : ''}`,
				asOf,
			]);
		} else if (spans && !pick && ahead.beyond) {
			// With no line to pick, the core builds on the newest LTS line, outside the range.
			add('warn', 'node-unreleased', [
				`engines.node ${pkg.node} in package.json admits no Node line released so far:`
					+ `${ahead.start ? ` the first it admits, Node ${ahead.start}, starts on ${dates[ahead.start][0]}.`
						: ' the schedule lists no line it admits.'}`,
				'  No Node can build the app; make falls back to the newest LTS line, which the range does not admit.',
				asOf,
			]);
		} else if (pick && !pick.lts) {
			add('warn', 'node-no-lts', [
				`engines.node ${pkg.node} in package.json admits no LTS Node line:`
					+ ` the release is built on Node ${pick.major}, a current line`
					+ `${ahead.lts ? `, and the first line it admits enters LTS on ${dates[ahead.lts][1]} (Node ${ahead.lts}).`
						: ', and the schedule names no LTS start for a line it admits.'}`,
				'  A contributor on the current LTS cannot build the app, and a distribution or CI image'
					+ ' that tracks LTS does not carry that Node.',
				asOf,
			]);
		}
		// A lint or test workflow on another major does not reach the release, so it
		// is compared against the rest and does not make them disagree. Where only
		// such workflows state a version, they are all there is to go by.
		const core = stated.some((s) => !s.checks) ? stated.filter((s) => !s.checks) : stated;
		const majors = [...new Set(core.map((s) => s.major).filter(Boolean))];
		const outside = (s) => Boolean(spans && s.major && !admits(spans, s.major));
		const outOfRange = core.filter(outside);
		const offChecks = stated.filter((s) => !core.includes(s) && s.major
			&& ((majors.length && !majors.includes(s.major)) || outside(s)));
		const checksLine = offChecks.length
			? [`  The checks run on another Node: ${offChecks.map((s) => `${s.value} (${s.where})`).join(', ')}.`
				+ ' They lint and test the code and build no release asset, so this decides only'
				+ ' what those runs see.']
			: [];
		if (!stated.length) {
			add('info', 'node-version', [
				'No Node version is stated: no engines.node, no .nvmrc, and'
				+ `${ciVariable ? ' the workflows read node-version from a variable'
					: ' no node-version in the installed workflows'}.`,
				'  Whoever builds the app uses whatever Node they have, and a build that works on'
				+ ' one machine is then not evidence for the next.',
			]);
		} else if (majors.length > 1 || outOfRange.length) {
			add('warn', 'node-version', [
				`Node versions disagree: ${core.map((s) => `${s.value} (${s.where})`).join(', ')}.`,
				...outOfRange.length
					? [`  ${outOfRange.map((s) => `${s.value} (${s.where})`).join(', ')} ${outOfRange.length === 1 ? 'lies' : 'lie'}`
						+ ` outside engines.node ${pkg.node}.`]
					: [],
				'  The release is built on one of them and a contributor may build on another; a'
				+ ' different major gets a different lockfile and, with a native dependency, a'
				+ ' different build.',
				...checksLine,
			]);
		} else {
			const missing = [];
			if (!pkg?.node) missing.push('engines.node in package.json');
			if (!r.nvmrc) missing.push('.nvmrc');
			if (r.ci.present && !ciStated && !ciVariable) missing.push('node-version in the workflows');
			// A range only bounds the stated major, so it is named as such next to it.
			// Where the range is all the release side states, each place keeps its own value.
			const bounding = majors.length && spans ? engines : null;
			const agreeing = stated.filter((s) => !offChecks.includes(s) && s !== bounding);
			const lines = [!majors.length && spans
				? `Node stated as ${agreeing.map((s) => `${s.value} (${s.where})`).join(', ')}.`
				: `Node ${majors[0] ?? core[0].value} stated in ${[...new Set(agreeing.map((s) => s.where))].join(', ')}`
					+ `${bounding ? `, within ${bounding.where} ${bounding.value}` : ''}.`];
			if (missing.length) {
				lines.push(`  Not stated in ${missing.join(', ')}, so nothing keeps the other places`
					+ ' from drifting away from it.');
			}
			if (ciVariable && !ciStated) {
				lines.push('  The workflows read node-version from a variable, which is not resolved'
					+ ' here, so whether CI builds on that major is not decidable from the checkout.');
			}
			lines.push(...checksLine);
			add(missing.length || offChecks.length ? 'info' : 'ok', 'node-version', lines);
		}
	}

	// -- whether an install can be repeated --
	{
		const node = r.locks.filter((l) => l.manager !== 'composer');
		const php = r.locks.find((l) => l.manager === 'composer');
		const uncommitted = r.locks.filter((l) => !l.committed);
		// The npm side and the composer side go into one finding, which takes the
		// worse of the two levels.
		const lock = [];
		// A manifest that declares nothing to install has nothing a lockfile pins.
		if (pkg && !node.length && pkg.ranges !== 0) {
			lock.push(['warn', [
				'package.json without a lockfile.',
				'  Every install resolves the ranges afresh, so two builds of the same commit can'
				+ ' contain different code, and npm ci - what CI uses - does not run at all.',
			]]);
		} else if (node.length > 1) {
			add('warn', 'two-package-managers', [
				`Two lockfiles: ${node.map((l) => l.file).join(', ')}.`,
				'  They resolve the same ranges independently, so the tree depends on which'
				+ ' command a contributor happens to run, and one of the two files is stale from'
				+ ' the moment the other is updated.',
			]);
		} else if (node.length) {
			const l = node[0];
			lock.push(['ok', [`${l.file}${l.version ? ` (lockfileVersion ${l.version})` : ''}`
				+ `${php ? ' and composer.lock' : ''} in the checkout`
				+ `${pkg?.packageManager ? `, packageManager ${pkg.packageManager}` : ''}.`]]);
		}
		if (uncommitted.length) {
			add('warn', 'lockfiles-not-committed', [
				uncommitted[0].tracked === null
					? `.gitignore keeps ${uncommitted.map((l) => l.file).join(', ')} out of the repository.`
					: `${uncommitted.map((l) => `${l.file}${l.ignored ? ' (listed in .gitignore)' : ''}`).join(', ')}`
						+ ` ${uncommitted.length === 1 ? 'is' : 'are'} not tracked by git.`,
				'  A lockfile that is not committed pins nothing: it exists on the machine that'
				+ ' wrote it and nowhere else.',
			]);
		}
		if (r.composer && !php && r.composer.packages?.length !== 0) {
			lock.push(['info', [
				'composer.json without composer.lock.',
				'  An app ships its vendor tree, so the versions in it are part of the release;'
				+ ' committing the lockfile is what makes that tree reproducible.',
			]]);
		}
		if (lock.length) add(worst(lock.map(([level]) => level)), 'lockfiles', lock.flatMap(([, lines]) => lines));
	}

	// -- two bundlers in one tree --
	if (pkg?.bundlers?.length) {
		const vite = pkg.bundlers.filter((b) => b.includes('vite'));
		const webpack = pkg.bundlers.filter((b) => b.includes('webpack'));
		if (vite.length && webpack.length) {
			add('warn', 'two-bundlers', [
				`Both bundlers are installed: ${vite.join(', ')} and ${webpack.join(', ')}.`,
				'  The build scripts decide which one produces the committed assets; the other'
				+ ' keeps its config, its plugins and its share of every install, and drifts out'
				+ ' of use without anyone noticing.',
			]);
		}
	}

	// -- what runs over the sources, and what does not --
	{
		const legacy = r.tools.filter((t) => t.legacy);
		const missing = r.tools.filter((t) => !t.file && !t.legacy);
		const have = r.tools.filter((t) => t.file || t.legacy)
			.map((t) => (t.file ? `${t.label} (${t.file})` : `${t.label} (${t.legacy}, superseded form)`));
		const lines = [`Tooling in the checkout: ${have.length ? have.join(', ') : 'none of the configurations this audit looks for'}.`];
		for (const t of legacy) lines.push(` ${t.label} is configured in ${t.legacy}: ${t.legacyWhy}.`);
		for (const t of missing) lines.push(` No ${t.label} configuration: ${t.why}.`);
		add(legacy.length || missing.length ? 'info' : 'ok', 'tooling', lines);
	}

	// -- a command that cannot run --
	// A script calls a tool that has no configuration in the checkout, or hands it a
	// configuration file that is not there. Unlike a missing linter, which is a
	// choice, this is a command that fails for whoever runs it, and it is found by
	// comparing two files - which is this audit's job. Every such script is one line
	// of the same finding.
	{
		const lines = [];
		const scripts = (callers) => [...new Set(callers.map((c) => c.where))].map((w) => {
			const names = callers.filter((c) => c.where === w).map((c) => c.n);
			return `${w} ${names.length === 1 ? 'script' : 'scripts'} ${names.join(', ')}`;
		}).join(' and ');
		for (const t of r.tools) {
			const named = t.callers.filter((c) => c.missing.length);
			const bare = t.file || t.legacy ? [] : t.callers.filter((c) => !c.configs.length);
			if (named.length) {
				const files = [...new Set(named.flatMap((c) => c.missing))];
				lines.push(`${scripts(named)} ${named.length === 1 ? 'runs' : 'run'} ${t.bin} with ${files.join(', ')},`
					+ ` which ${files.length === 1 ? 'is' : 'are'} not in the checkout.`, `  ${named[0].cmd}`);
			}
			if (bare.length) {
				lines.push(`${scripts(bare)} ${bare.length === 1 ? 'calls' : 'call'} ${t.bin},`
					+ ` and no ${t.label} configuration is in the checkout.`, `  ${bare[0].cmd}`);
			}
		}
		if (lines.length) {
			add('warn', 'script-without-config', [...lines,
				'  The command is there to be run, so whoever runs it gets a tool that has'
				+ ' nothing to go by - and CI, if it runs the script, reports the failure as the'
				+ ' change under test.']);
		}
	}

	// -- how this checkout is built --
	{
		const m = r.makefile;
		const hidden = m.shadowed.map((f) => f.name).join(' and ');
		const hiddenNcmake = m.shadowed.find((f) => f.kind !== 'foreign');
		const shadowLines = !m.shadowed.length ? [] : [
			`  make reads ${m.name} and never ${hidden}; ${m.shadowed.length > 1 ? 'those run' : 'it runs'}`
			+ ` only with make -f <name>.`,
		];
		if (!m.present) {
			add('info', 'ncmake-bootstrap', [
				'No GNUmakefile, makefile or Makefile in the checkout.',
				'  Nothing in the repository says how the app is built, released or packaged, so'
				+ ' every step lives in whoever does it.',
			]);
		} else if (hiddenNcmake && m.kind === 'foreign') {
			add('warn', 'ncmake-bootstrap', [
				`The ncmake ${hiddenNcmake.kind === 'copy' ? 'copy' : 'bootstrap stub'} in ${hiddenNcmake.name}`
				+ ` is never read: make reads ${m.name} (${num(m.lines)} lines) first, so no ncmake target exists.`,
				`  Committed as GNUmakefile (git mv ${hiddenNcmake.name} GNUmakefile), ncmake is the file make`
				+ ' reads, whatever other build file the app keeps.',
			]);
		} else if (m.kind === 'copy') {
			add('info', 'ncmake-bootstrap', [
				`The ${m.name} is a full ncmake copy (${num(m.lines)} lines), not the bootstrap stub.`,
				'  A copy stops following the reference, so a fix upstream never arrives; the stub'
				+ ' fetches the current core on every run.',
				...shadowLines,
			]);
		} else if (m.kind === 'foreign') {
			add('info', 'ncmake-bootstrap', [
				`The ${m.name} (${num(m.lines)} lines) does not mention ncmake.`,
				'  Nothing to reconcile - this audit only notes which build system the checkout'
				+ ' carries.',
				...shadowLines,
			]);
		} else if (m.name !== 'GNUmakefile') {
			add('info', 'ncmake-bootstrap', [
				`The ncmake bootstrap stub is in place as ${m.name} (${num(m.lines)} lines).`,
				`  make reads a GNUmakefile${m.name === 'Makefile' ? ' or makefile' : ''} before it, so one`
				+ ' added later hides every ncmake target. Committed as GNUmakefile'
				+ ` (git mv ${m.name} GNUmakefile), the stub is read first.`,
				...shadowLines,
			]);
		} else {
			add('ok', 'ncmake-bootstrap', [
				`The ncmake bootstrap stub is in place (${num(m.lines)} lines).`,
				...shadowLines,
			]);
		}
	}

	// -- a directory the app reads and the release does not ship --
	// The build passes and the tarball is packed without it; the app fails later, in
	// the one code path that reads it. Outside ncmake the app packs its own set, so
	// there it is what adopting ncmake would need.
	if (r.runtime) {
		const { dirs, keepFrom } = r.runtime;
		const ncmake = r.makefile.kind === 'stub' || r.makefile.kind === 'copy';
		if (dirs.length) {
			const lines = dirs.map(({ dir, refs }) => `${dir}/ is read at run time and is not in the shipped file set:`
				+ ` ${refs[0].at} reaches it through ${refs[0].via}`
				+ `${refs.length > 1 ? `, as ${plural(refs.length - 1, 'further place does', 'further places do')}` : ''}.`);
			const them = dirs.length === 1 ? 'it' : 'them';
			lines.push(`  ${ncmake ? 'A release' : 'An ncmake release'} ships only the paths of the keep set (${keepFrom}),`
				+ ` so the tarball lacks ${them} and the app fails in the code that reads ${them}, while the build`
				+ ` and the packing pass. In ncmake.mk, keep_extra += ${dirs.map((d) => d.dir).join(' ')} ships ${them}.`);
			add(ncmake ? 'warn' : 'info', 'runtime-dirs-not-shipped', lines);
		} else {
			add('ok', 'runtime-dirs-not-shipped', ['Every directory the shipped PHP reaches through __DIR__ and the'
				+ ` frontend through linkTo is in the shipped file set (${keepFrom}).`]);
		}
	}

	// -- packages nothing in the checkout names --
	if (pkg && !pkg.broken && r.deps.length) {
		const unref = r.deps.filter((d) => !d.at);
		const conv = r.deps.filter((d) => d.via).length;
		const byConvention = conv ? `, ${num(conv)} of them by convention` : '';
		if (unref.length) {
			add('info', 'unreferenced-dependencies', [
				`${plural(unref.length, 'declared package is', 'declared packages are')} named nowhere`
				+ ` in the checkout: ${unref.slice(0, 8).map((d) => d.name).join(', ')}`
				+ `${unref.length > 8 ? `, and ${num(unref.length - 8)} more` : ''}.`,
				`  Searched as literal names over ${plural(r.scan.read, 'file', 'files')}, package.json`
				+ ' excluded apart from its non-dependency fields, lockfiles excluded; then as an'
				+ ' ESLint shorthand, as what TypeScript takes from a tsconfig, and as a peer of'
				+ ' an installed package in package-lock.json. A package loaded some other way is'
				+ ' not named anywhere either, so this is a list to check, not a list to remove.',
			]);
		} else {
			add('ok', 'unreferenced-dependencies', [`All ${num(r.deps.length)} declared packages are named`
				+ ` somewhere in the checkout${byConvention}.`]);
		}
	}

	// -- the licence, stated in up to three files --
	{
		const stated = [
			...(app?.licences ?? []).flatMap((v) => readLicences('appinfo/info.xml', v)),
			...readLicences('package.json', pkg?.license),
			...readLicences('composer.json', r.composer?.license),
		];
		// Each value is named with the files that use it, so the reader sees which
		// form is where.
		const named = (list) => [...new Set(list.map((x) => x.value))]
			.map((v) => `${v} (${[...new Set(list.filter((x) => x.value === v).map((x) => x.where))].join(', ')})`)
			.join(', ');
		// Only what maps to an id is compared: a value that does not say which licence
		// it means agrees with nothing and contradicts nothing, and is named instead.
		const byFile = new Map();
		for (const x of stated.filter((s) => s.id)) byFile.set(x.where, [...(byFile.get(x.where) ?? []), x.id]);
		const drift = new Set([...byFile.values()].map((ids) => [...new Set(ids)].sort().join(' '))).size > 1;
		const levels = [drift ? 'warn' : (r.licenses ? 'ok' : 'info')];
		const lines = [];
		if (drift) {
			lines.push(`The licence is stated differently: ${named(stated)}.`,
				'  Whoever redistributes the app has to pick one of them, and the App Store shows'
				+ ' the one from info.xml.');
		} else if (stated.length) {
			const files = r.licenses?.length ? `, LICENSES/ holds ${r.licenses.join(', ')}` : '';
			lines.push(`Licence ${named(stated)}${files}.`);
		}
		const kind = (k) => stated.filter((s) => s.kind === k);
		const distinct = (list) => [...new Set(list.map((s) => s.value))].map((v) => list.filter((s) => s.value === v));
		// The App Store takes the SPDX ids in info.xml from Nextcloud 31 on; below that
		// the deprecated value is the only one a release can state.
		const min = majorOf(app?.nextcloud?.min);
		for (const [x] of distinct(kind('appstore'))) {
			if (!x.id || min >= 31) levels.push('info');
			lines.push(`  ${x.value} in appinfo/info.xml is a deprecated App Store value, shown there as ${x.name}`
				+ `${!x.id ? ', which does not say whether -only or -or-later is meant' : (x.id === x.name ? '' : `, which is ${x.id}`)}.`
				+ `${min >= 31 ? ` With min-version ${min} info.xml can state an SPDX id instead.`
					: ' An SPDX id there needs a <nextcloud> min-version of 31 or higher.'}`);
		}
		for (const same of distinct(kind('deprecated'))) {
			const { id } = same[0];
			levels.push(id ? 'info' : 'warn');
			lines.push(`  ${named(same)} is a deprecated SPDX id`
				+ `${id ? `; the current one is ${id}` : ', replaced because it does not say whether -only or -or-later is meant'}.`);
		}
		const unlisted = kind('unlisted');
		if (unlisted.length) {
			levels.push('warn');
			lines.push(`  Not accepted by the App Store in info.xml: ${named(unlisted)}. Its info.xsd lists`
				+ ' only some SPDX ids.');
		}
		const none = kind('none');
		if (none.length) {
			levels.push('warn');
			lines.push(`  No SPDX id: ${named(none)}. Only an SPDX id says which licence is meant, and for`
				+ ' a GNU licence whether -only or -or-later.');
		}
		if (stated.length && !r.licenses) {
			lines.push('  No LICENSES/ directory, so the licence text itself is not in the checkout, which'
				+ ' is what REUSE and the distributions check for.');
		}
		if (lines.length) add(worst(levels), 'license-drift', lines);
	}

	return sortFindings(out);
}

// == Human-readable output ==
// How to run this again with other options.
const how = howToRun('CONSISTENCY_AUDIT_CMDLINE', 'consistency-audit.mjs %s');

function renderSummary(r) {
	const out = [];
	const p = (s = '') => out.push(s);
	const app = r.app;
	const pkg = r.package;

	p(`consistency-audit  ${path.resolve(r.root)}`);
	p(`  ${app ? `${app.id ?? 'no app id'}${app.version ? ` ${app.version}` : ''}` : 'no appinfo/info.xml'}, `
		+ `${pkg ? (pkg.broken ? 'package.json unreadable' : `${plural(r.deps.length, 'declared package', 'declared packages')}`)
			: 'no package.json'}, `
		+ `${r.composer ? 'composer.json' : 'no composer.json'}, `
		+ `${r.ci.present ? plural(r.ci.files.length, 'installed workflow', 'installed workflows') : 'no installed workflows'}.`);
	p();

	p('FINDINGS');
	for (const l of renderFindings(r.findings)) p(l);
	p();
	p(LEGEND);
	p('The audit compares what the checkout states about itself in more than one place,');
	p('and names what a release needs that the checkout does not state. It reads');
	p('metadata only: no build, no install; from the network only whether the links');
	p('of appinfo/info.xml answer. The oldest maintained server');
	p(`major is as of ${r.server.asOf}, written into the analyser and refreshed with it;`);
	p(`the newest released, ${r.server.newest}, is from ${r.server.newestFrom};`);
	p(`the major on master, ${r.server.master.major}, is from ${r.server.master.from}.`);
	p();
	p(`All tables: ${how('--details')}`);
	p(`Machine-readable: ${how('--json')}`);
	return out.join('\n');
}

function renderDetails(r, opt) {
	const out = [];
	const p = (s = '') => out.push(s);
	const app = r.app;
	const pkg = r.package;

	p();
	p('== What the checkout states ==');
	p('One row per statement, with the file it comes from. An empty value means the file');
	p('is there and says nothing about it.');
	p();
	const rows = [];
	const say = (what, where, value) => rows.push([what, where, value ?? '']);
	if (app) {
		say('App id', 'appinfo/info.xml', app.id);
		say('Name', 'appinfo/info.xml', app.names.join(', '));
		say('Version', 'appinfo/info.xml', app.version);
		say('Licence', 'appinfo/info.xml', app.licences.join(', '));
		say('Repository', 'appinfo/info.xml', app.repository);
		say('Bug tracker', 'appinfo/info.xml', app.bugs);
		say('Website', 'appinfo/info.xml', app.website);
	}
	if (pkg && !pkg.broken) {
		say('Name', 'package.json', pkg.name);
		say('Version', 'package.json', pkg.version);
		say('Licence', 'package.json', pkg.license);
		say('Node', 'package.json engines', pkg.node);
		say('Package manager', 'package.json', pkg.packageManager);
	}
	if (r.nvmrc) say('Node', '.nvmrc', r.nvmrc.value);
	if (r.composer && !r.composer.broken) {
		say('Name', 'composer.json', r.composer.name);
		say('Licence', 'composer.json', r.composer.license);
		say('PHP', 'composer.json require', r.composer.php);
		say('PHP', 'composer.json config.platform', r.composer.platformPhp);
	}
	p(table(['Statement', 'Where', 'Value'], rows, ['l', 'l', 'l']));
	p();

	p('== Declared platform support ==');
	p('The range the App Store matches a server against, and the PHP bound the server');
	p('checks before it enables the app.');
	p();
	p(table(
		['Platform', 'Minimum', 'Maximum', 'Source'],
		[
			['Nextcloud', app?.nextcloud?.min ?? '', app?.nextcloud?.max ?? '', 'appinfo/info.xml'],
			['PHP', app?.php?.min ?? '', app?.php?.max ?? '', 'appinfo/info.xml'],
			['PHP', r.composer?.php ?? '', '', 'composer.json require'],
			['Nextcloud (maintained)', r.server.oldestMaintained, '', `this analyser, ${r.server.asOf}`],
			['Nextcloud (released)', '', r.server.newest, r.server.newestFrom],
			['Nextcloud (master)', '', r.server.master.major, r.server.master.from],
		],
		['l', 'l', 'l', 'l'],
	));
	p();

	if (r.ci.present) {
		p('== Installed workflows ==');
		p('One row per workflow, with the versions it names. An empty cell means the');
		p('workflow sets up no version of that language at all; a value read from a');
		p('variable is not resolved here. A workflow that runs a linter or a test runner');
		p('is marked as checks: the Node it runs on does not reach the release.');
		p();
		const shownCi = cut(r.ci.byFile, opt.top);
		p(table(
			['Workflow', 'Kind', 'Node', 'PHP'],
			shownCi.rows.map((w) => [w.file, w.checks ? 'checks' : '', w.node.join(', '), w.php.join(', ')]),
			['l', 'l', 'l', 'l'],
		));
		if (shownCi.hidden) p(`... ${num(shownCi.hidden)} further workflows not shown, use ${how('--details --top=0')}`);
		p();
	}

	p('== Tooling ==');
	p('Each tool by the configuration file that runs it, because a declared package');
	p('without its configuration does nothing.');
	p();
	p(table(
		['Tool', 'Configuration', 'State'],
		r.tools.map((t) => [t.label, t.file ?? t.legacy ?? '', t.file ? 'current form' : (t.legacy ? 'superseded form' : 'not configured')]),
		['l', 'l', 'l'],
	));
	p();

	if (r.locks.length) {
		p('== Lockfiles ==');
		p('The format version is the schema of the lockfile itself, not the version of the');
		if (r.locks[0].tracked === null) {
			p('tool that wrote it. Committed is read from .gitignore, which is all the checkout');
			p('can say without git.');
		} else {
			p('tool that wrote it. Committed is what git tracks.');
		}
		p();
		p(table(
			['File', 'Manager', 'Format version', 'Committed'],
			r.locks.map((l) => [l.file, l.manager, l.version ?? '', l.committed ? 'yes' : (l.tracked === null ? 'no, in .gitignore' : 'no, untracked')]),
			['l', 'l', 'r', 'l'],
		));
		p();
	}

	if (r.deps.length) {
		p('== Declared packages ==');
		p('Where each package is first named outside its own declaration. A package no');
		p('file names literally is looked for where a tool loads it by convention, and');
		p('the convention is given; one loaded some other way shows as named nowhere.');
		p();
		const list = [...r.deps].sort((a, b) => Number(Boolean(a.at)) - Number(Boolean(b.at)) || a.name.localeCompare(b.name));
		const shown = cut(list, opt.top);
		p(table(
			['Package', 'Range', 'Section', 'First named in'],
			shown.rows.map((d) => [d.name, d.range, d.section, d.at ? `${d.at}${d.via ? ` (${d.via})` : ''}` : 'nowhere']),
			['l', 'l', 'l', 'l'],
		));
		if (shown.hidden) p(`... ${num(shown.hidden)} further packages not shown, use ${how('--details --top=0')}`);
		p();
	}

	return out.join('\n').replace(/\n+$/, '');
}

// == Main ==
const opt = parseArgs(process.argv.slice(2));
const report = audit(opt);
report.links = await checkLinks(report, opt);
report.findings = findings(report);
const json = opt.json || opt.jsonFile ? `${JSON.stringify(report, null, 2)}\n` : null;
if (opt.json) {
	process.stdout.write(json);
} else {
	const text = renderSummary(report) + (opt.details ? renderDetails(report, opt) : '');
	process.stdout.write(`${text}\n`);
}
if (opt.jsonFile) writeJsonFile(opt.jsonFile, json, die);
