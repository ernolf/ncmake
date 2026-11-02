// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// scratch-build - building an app in a throwaway copy of its checkout. build-verify
// rebuilds the committed output this way, build-audit --prove a build with other
// toolchain versions. The copy is a git clone that borrows the checkout's objects
// and takes the tracked files; every step runs with a time limit and writes its log
// beside the tree. The checkout is only read. Node 18 or newer, no npm dependency.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { num } from './report-text.mjs';

// Lines of a failed command's output to print, per stream. The full log is written
// beside the tree - unless that lives in a container, where it goes with the
// container and the printed tail is all there is.
const LOG_TAIL = 40;

// Set by make where the analyser runs in a container: the Node the app declares,
// copied out of its image, while the analyser itself runs on a Node new enough for
// it. Its bin goes first on PATH, so every step, npm and corepack included, runs on
// the app's Node.
export const APP_NODE = process.env.NCMAKE_APP_NODE;

// git is where the checkout says what belongs to it. The tracked files are the
// source a build has to work from; everything else in the working tree - installed
// dependencies, an earlier build, editor leftovers - is not copied, and that is
// what makes the rebuilt tree pristine. safe.directory keeps git from refusing a
// checkout whose owner differs from the user inside the container.
export function git(root, args) {
	const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', root, ...args],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return r.error || r.status !== 0 ? null : r.stdout;
}

// A submodule is tracked as a gitlink (mode 160000): one path, a directory in the
// working tree, empty unless the clone recursed into it. Initialized, it is source
// the build reads like the app's own, so its tracked files are listed under its
// path. One that is not initialized has no files to take and is named apart.
export function trackedFiles(root, prefix = '') {
	const out = git(root, ['ls-files', '-s', '-z']);
	if (out === null) return null;
	const r = { files: [], submodules: [], uninitialized: [] };
	for (const entry of out.split('\0').filter(Boolean)) {
		const rel = entry.slice(entry.indexOf('\t') + 1);
		if (!entry.startsWith('160000 ')) {
			r.files.push(prefix + rel);
			continue;
		}
		r.submodules.push(prefix + rel);
		const sub = fs.existsSync(path.join(root, rel, '.git')) ? trackedFiles(path.join(root, rel), `${prefix}${rel}/`) : null;
		if (sub === null) {
			r.uninitialized.push(prefix + rel);
			continue;
		}
		r.files.push(...sub.files);
		r.submodules.push(...sub.submodules);
		r.uninitialized.push(...sub.uninitialized);
	}
	return r;
}

// A tracked symlink is copied as the content it points at, which is what a build
// reads through it anyway.
export function copyTracked(root, files, dest) {
	let n = 0;
	for (const rel of files) {
		const from = path.join(root, rel);
		if (!fs.existsSync(from)) continue;   // tracked, and deleted in the working tree
		const to = path.join(dest, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(from, to);
		n++;
	}
	return n;
}

// A build may ask git about its own source, the files it lists or the tag it
// describes, and a fresh clone has the answers. So the tree starts as a clone that
// borrows the checkout's objects, HEAD and tags and checks nothing out; once the
// tracked files are copied in, the index takes exactly those, so git lists what the
// tree holds. -f because a tracked file can match .gitignore. Both write into the
// tree only.
export function gitClone(root, tree) {
	return git(root, ['clone', '-q', '--shared', '--no-checkout', root, tree]) !== null;
}

export function gitIndex(tree) {
	return git(tree, ['add', '-A', '-f']) !== null;
}

// A rebuild installs the way make build does (node_install in core/Makefile): with
// the package manager whose lock the app ships, from that lock. npm-shrinkwrap.json
// wins over package-lock.json, as in npm. Yarn 2 and later write a __metadata block
// into yarn.lock and take --immutable, Yarn 1 takes --frozen-lockfile. update is the
// install that may rewrite the lock, for a tree whose package.json was changed.
export function packageManager(tree) {
	const lock = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
		.find((f) => fs.existsSync(path.join(tree, f))) ?? null;
	if (lock === 'pnpm-lock.yaml') {
		return { name: 'pnpm', lock, install: 'pnpm install --frozen-lockfile', update: 'pnpm install --no-frozen-lockfile' };
	}
	if (lock === 'yarn.lock') {
		const berry = /^__metadata:/m.test(fs.readFileSync(path.join(tree, lock), 'utf8'));
		return {
			name: 'yarn', lock, install: `yarn install ${berry ? '--immutable' : '--frozen-lockfile'}`,
			update: berry ? 'YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install' : 'yarn install',
		};
	}
	return { name: 'npm', lock, install: lock ? 'npm ci' : 'npm install', update: 'npm install' };
}

// pnpm and yarn come through corepack, as in make build (node_pm_setup), in the
// version the packageManager field of package.json names. Node 25 and later no
// longer ship corepack, so there it is installed from npm first. The shims go into
// the scratch directory, which keeps the rebuild from writing anywhere else, and
// onto PATH, where a script of the app that calls pnpm or yarn itself finds them.
// AUTO_PIN=0 keeps corepack from writing a packageManager field into package.json.
export function corepack(pm, cwd, scratch, minutes) {
	const prefix = path.join(scratch, 'node-pm');
	const bin = path.join(prefix, 'bin');
	fs.mkdirSync(bin, { recursive: true });
	process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
	process.env.COREPACK_ENABLE_AUTO_PIN = '0';
	process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
	return step(`corepack enable ${pm}`, `{ command -v corepack >/dev/null || npm install --global --prefix '${prefix}' corepack; }`
		+ ` && corepack enable --install-directory '${bin}' ${pm}`, cwd, scratch, minutes);
}

// One step of the rebuild. Its output is captured rather than streamed: a passing
// step prints nothing, a failing one prints its tail, and the full log is written
// beside the tree either way. The command is a fixed literal, so running it through
// a shell raises no quoting question and finds npm where it is a wrapper script
// rather than an executable.
//
// A step that does not end within its time limit is stopped as a whole: it runs
// in a process group of its own, so the signal reaches npm, the install scripts
// and the bundler it started, not only the shell. In a group of its own it no
// longer gets the Ctrl-C of the terminal, so an interrupt or a termination of
// this run is passed on to the group before the run ends.
const KILL_GRACE = 10 * 1000;
const PASSED_ON = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function step(name, cmd, cwd, logDir, minutes) {
	const started = Date.now();
	process.stderr.write(`  ${name} ...`);
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let finished = false;
		let killer = null;
		const child = spawn(cmd, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const group = (signal) => {
			try {
				process.kill(-child.pid, signal);
			} catch {
				// the group has ended already
			}
		};
		const passOn = (signal) => {
			group(signal);
			for (const s of PASSED_ON) process.removeListener(s, passOn);
			process.kill(process.pid, signal);
		};
		for (const s of PASSED_ON) process.on(s, passOn);
		const timer = minutes > 0 ? setTimeout(() => {
			timedOut = true;
			group('SIGTERM');
			killer = setTimeout(() => group('SIGKILL'), KILL_GRACE);
		}, minutes * 60 * 1000) : null;

		const finish = (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			clearTimeout(killer);
			for (const s of PASSED_ON) process.removeListener(s, passOn);
			const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
			const log = `${name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.log`;
			fs.writeFileSync(path.join(logDir, log), `${stdout}${stderr}`);
			process.stderr.write(` ${seconds} s${timedOut ? ` (stopped after ${num(minutes)} min)` : code === 0 ? '' : ` (exit ${code})`}\n`);
			resolve({ name, cmd, log, seconds, code, timedOut, stdout, stderr });
		};
		child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
		child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
		// A process that left the group can still hold the output pipes open, and
		// the step would then wait for it after all.
		child.on('exit', () => {
			if (!timedOut) return;
			child.stdout.destroy();
			child.stderr.destroy();
		});
		child.on('error', (e) => {
			stderr += `${e.message}\n`;
			finish(-1);
		});
		child.on('close', (code) => finish(code ?? -1));
	});
}

// Each stream gets a tail of its own: webpack --progress writes its progress to
// stderr and the compiler errors to stdout, so the last lines of the two written
// one after the other are progress lines only and the error is not among them.
export function printTail(s) {
	for (const [stream, text] of [['stdout', s.stdout], ['stderr', s.stderr]]) {
		if (!text.trim()) continue;
		const lines = text.replace(/\n+$/, '').split('\n');
		const shown = lines.slice(Math.max(0, lines.length - LOG_TAIL));
		process.stderr.write(`    -- ${stream}${shown.length < lines.length ? `, last ${shown.length} lines` : ''} --\n`);
		for (const l of shown) process.stderr.write(`    ${l}\n`);
	}
}

// The tool versions that produced the rebuild, for the record: a rebuild is only
// comparable to one made with the same toolchain.
export function version(cmd, cwd) {
	const r = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true });
	return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}
