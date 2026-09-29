# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: server-side integrity signature.
#
# 'make sign' signs the tarball for the App Store. This module writes the other
# signature: appinfo/signature.json, the per-file hash list the server's own
# integrity check reads. Without it a repackaged app is not integrity-checked at
# all - Checker::runInstanceVerification checks a non-shipped app only while the
# installed directory carries that file - and an app that commits a stale one is
# worse, because the shipped file set is then not the set it was signed over.
#
# The documented route is 'occ integrity:sign-app', which needs a Nextcloud
# installation; ncmake has none. The format is fully determined by
# lib/private/IntegrityCheck/Checker.php, so the file is written directly: sha512
# per file, the signed payload being PHP's json_encode over the ksorted map, and
# RSA-PSS with digest sha1, MGF1 sha512 and salt length 0 over it. At salt length
# 0 the scheme is deterministic, so openssl and occ produce identical bytes.
#
# Signed is the staged tree, never the checkout: 'stage' has already applied the
# keep model and .nextcloudignore, so that file set is the shipped file set, and
# the checkout keeps no build artefact it would otherwise have to carry.
#
# The counterpart, integrity-check, needs no key - it verifies against the
# certificate inside the file - so it also runs on a release runner, which is what
# makes it a gate in front of dist rather than a report after it.
#
# Hence the release path: the signature is made here at tag time (integrity-tag, the
# tag hook), reaches the runner through a secret gist named in the signed tag
# message, and is verified there against the committed certificate before the
# tarball is packed. The key stays on this machine and CI holds no secret of ours.

# == Signing material ==
# The same key and certificate mk/appstore.mk resolves: one app, one certificate,
# and the App Store verifies the tarball against the very certificate the server
# then finds inside signature.json. Declared with ?= because modules are read in
# alphabetical order - appstore.mk before this file - so where both are installed
# appstore.mk keeps the names, and where only this one is, they are still defined.
cert_dir     ?= $(HOME)/.nextcloud/certificates
cert_file    ?= $(firstword $(wildcard $(cert_dir)/$(app_id).crt $(cert_dir)/$(app_id).cert))
cert_display ?= $(or $(cert_file),$(cert_dir)/$(app_id).crt)
key_file     ?= $(cert_dir)/$(app_id).key
mark         ?= $(if $(wildcard $(1)),$(cok)✓$(c0),$(cno)✗$(c0))

# == The committed certificate ==
# The public certificate, committed to the repository. It is what marks an app as
# signed - neither the server nor the App Store keeps that record - and it pins the
# certificate the release runner holds the signature against, so a file signed with
# any other key is caught there. It lies outside the keep model and never ships.
integrity_certificate = .ncmake/certificate.crt

# The tag message line naming the gist that carries this release's signature.json.
# Written by integrity-tag, read by the release workflow and by integrity-gist-drop.
integrity_trailer = ncmake-signature

# The two hooks core and appstore.mk offer: the signature is produced between the
# confirmation and the tag, the gist is dropped once the App Store has the release.
# Plain '=' - both are declared ':' with '?=' and are meant to be taken over.
tag_hook     = $(MAKE) --no-print-directory integrity-tag
publish_hook = $(MAKE) --no-print-directory integrity-gist-drop

# Signing is the maintainer's step and fails loudly when the material is missing:
# a tarball that silently lost its signature is the state this module exists to end.
# Split in two so the same test can run inside a recipe line that is already a shell.
integrity_check_material = test -n "$(cert_file)" || { echo "ERROR: certificate not found: $(cert_display) - 'make csr' starts the issuing." >&2; exit 1; }; test -f "$(key_file)" || { echo "ERROR: key not found: $(key_file)" >&2; exit 1; }
integrity_require = @$(integrity_check_material)

# What to sign or check: the staged tree by default, DIR=<path> for a tree that
# already exists elsewhere - a deployed app, an unpacked release. TARBALL=<file>
# is checked from an extraction under the build cache.
integrity_dir   = $(if $(DIR),$(DIR),$(stage_dir)/$(app_id))
integrity_untar = $(cache_dir)/integrity-tarball

# The tool: plain python3 (a core requirement anyway), written to the build cache
# at run time - the same pattern the workflow manager uses for its own tool.
define integrity_tool
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

# The names ExcludeFileByNameFilterIterator drops: what a desktop or an admin can
# leave in an app directory without the app knowing about it.
EXCLUDED_NAMES = (
    '.DS_Store',
    '.directory',
    '.rnd',
    '.webapp',
    'Thumbs.db',
    'nextcloud-init-sync.lock',
)
EXCLUDED_PATTERNS = (re.compile(r'^\.webapp-nextcloud-(\d+\.){2}(\d+)(-r\d+)?$$'),)
SIGNATURE_PATH = 'appinfo/signature.json'
PSS = ['-pkeyopt', 'rsa_padding_mode:pss', '-pkeyopt', 'rsa_pss_saltlen:0', '-pkeyopt', 'rsa_mgf1_md:sha512']


def fail(message):
    sys.exit('ERROR: %s' % message)


def is_excluded(name):
    return name in EXCLUDED_NAMES or any(p.match(name) for p in EXCLUDED_PATTERNS)


def collect(root):
    hashes = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if is_excluded(name):
                continue
            path = os.path.join(dirpath, name)
            relative = os.path.relpath(path, root).replace(os.sep, '/')
            if relative == SIGNATURE_PATH:
                continue
            digest = hashlib.sha512()
            with open(path, 'rb') as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b''):
                    digest.update(chunk)
            hashes[relative] = digest.hexdigest()
    return dict(sorted(hashes.items()))


def payload(hashes):
    # What the signature covers: PHP json_encode over the ksorted map - compact,
    # non-ASCII as \uXXXX, and the slash escaped. The verifier re-sorts and
    # re-encodes, so the order in the file is free but the escaping is not.
    text = json.dumps(hashes, separators=(',', ':'), sort_keys=True, ensure_ascii=True)
    return text.replace('/', '\\/').encode('ascii')


def openssl(arguments, stdin=None):
    result = subprocess.run(['openssl'] + arguments, input=stdin,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        fail('openssl %s: %s' % (arguments[0], result.stderr.decode('utf-8', 'replace').strip()))
    return result.stdout


def fingerprint(certificate):
    text = openssl(['x509', '-in', certificate, '-noout', '-fingerprint', '-sha256'])
    return text.decode('ascii', 'replace').strip().split('=', 1)[-1].upper()


def common_name(certificate):
    subject = openssl(['x509', '-in', certificate, '-noout', '-subject', '-nameopt', 'RFC2253'])
    found = re.search(r'CN=([^,]+)', subject.decode('utf-8', 'replace'))
    return found.group(1).strip() if found else ''


def sign(root, app_id, key, certificate):
    name = common_name(certificate)
    if name != app_id:
        fail('certificate CN is "%s" but the app id is "%s" - the server rejects that pairing' % (name, app_id))
    hashes = collect(root)
    signature = openssl(['pkeyutl', '-sign', '-inkey', key, '-rawin', '-digest', 'sha1'] + PSS,
                        payload(hashes))
    with open(certificate, 'r', encoding='utf-8') as handle:
        pem = handle.read().strip()
    # phpseclib writes the PEM with CRLF and no trailing newline; an occ-signed app
    # carries it that way, so a file written here stays comparable to one of those.
    pem = pem.replace('\r\n', '\n').replace('\n', '\r\n')
    document = {
        'hashes': hashes,
        'signature': base64.b64encode(signature).decode('ascii'),
        'certificate': pem,
    }
    target = os.path.join(root, 'appinfo', 'signature.json')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(json.dumps(document, indent=4).replace('/', '\\/'))
    print('Signed %d files -> %s' % (len(hashes), target))


def check(root, app_id, pinned=None):
    path = os.path.join(root, 'appinfo', 'signature.json')
    if not os.path.isfile(path):
        fail('%s not found - the app would not be integrity-checked at all' % path)
    with open(path, 'r', encoding='utf-8') as handle:
        document = json.load(handle)
    expected = document['hashes']
    actual = collect(root)

    # The three classes Checker::verify reports, in its order.
    problems = [('EXTRA_FILE', name) for name in sorted(set(actual) - set(expected))]
    problems += [('FILE_MISSING', name) for name in sorted(set(expected) - set(actual))]
    problems += [('INVALID_HASH', name) for name in sorted(set(expected) & set(actual))
                 if expected[name] != actual[name]]

    with tempfile.TemporaryDirectory() as scratch:
        certificate = os.path.join(scratch, 'certificate.crt')
        with open(certificate, 'w', encoding='utf-8', newline='') as handle:
            handle.write(document['certificate'])
        name = common_name(certificate)
        if name != app_id:
            problems.append(('CERTIFICATE_CN', '%s, expected %s' % (name, app_id)))
        # Against the committed certificate: the hashes and the signature agree with
        # each other in any self-signed file, so only the pin says the key was the
        # app's own. It is the check the release runner is there for.
        if pinned and fingerprint(certificate) != fingerprint(pinned):
            problems.append(('CERTIFICATE_MISMATCH', 'not the certificate in %s' % pinned))
        public_key = os.path.join(scratch, 'certificate.pub')
        with open(public_key, 'wb') as handle:
            handle.write(openssl(['x509', '-in', certificate, '-pubkey', '-noout']))
        data = os.path.join(scratch, 'payload')
        with open(data, 'wb') as handle:
            handle.write(payload(expected))
        raw = os.path.join(scratch, 'signature')
        with open(raw, 'wb') as handle:
            handle.write(base64.b64decode(document['signature']))
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', public_key,
                                 '-rawin', '-digest', 'sha1', '-sigfile', raw, '-in', data] + PSS,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode != 0:
            problems.append(('INVALID_SIGNATURE', result.stderr.decode('utf-8', 'replace').strip()
                             or 'the signature does not match the hashes in the file'))

    print('%s: %d files in signature.json, %d in %s' % (app_id, len(expected), len(actual), root))
    if problems:
        for kind, detail in problems:
            print('  %-18s %s' % (kind, detail))
        sys.exit(1)
    # The chain against resources/codesigning/root.crt is the server's check: that
    # root certificate is not ncmake's to carry.
    print('  no errors found, signature valid for CN=%s' % app_id)


if len(sys.argv) < 4:
    sys.exit('usage: ncmake_integrity.py sign <root> <app id> <key> <certificate>\n'
             '       ncmake_integrity.py check <root> <app id> [<pinned certificate>]')
if sys.argv[1] == 'sign':
    sign(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
elif sys.argv[1] == 'check':
    check(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
else:
    sys.exit('unknown command: %s' % sys.argv[1])
endef
export integrity_tool

integrity_run = mkdir -p "$(cache_dir)" && printf '%s\n' "$$integrity_tool" > "$(cache_dir)/ncmake_integrity.py" && python3 "$(cache_dir)/ncmake_integrity.py"

.PHONY: integrity-sign integrity-check dist-signed integrity-enable integrity-tag integrity-gist-drop

# DIR= points at a tree that already exists, so only the default case needs stage.
integrity-sign: check-app $(if $(DIR),,stage)
	$(integrity_require)
	@test "$$(cd "$(integrity_dir)" 2>/dev/null && pwd -P)" != "$$(pwd -P)" || { echo "ERROR: refusing to write signature.json into the checkout - drop DIR= to sign the staged tree." >&2; exit 1; }
	@$(integrity_run) sign "$(integrity_dir)" "$(app_id)" "$(key_file)" "$(cert_file)"

integrity-check: check-app $(if $(or $(DIR),$(TARBALL)),,stage)
	@if [ -n "$(TARBALL)" ]; then \
		test -f "$(TARBALL)" || { echo "ERROR: tarball not found: $(TARBALL)" >&2; exit 1; }; \
		rm -rf "$(integrity_untar)"; mkdir -p "$(integrity_untar)"; \
		tar xzf "$(TARBALL)" -C "$(integrity_untar)"; \
		root="$(integrity_untar)/$(app_id)"; \
	else \
		root="$(integrity_dir)"; \
	fi; \
	$(integrity_run) check "$$root" "$(app_id)" $(wildcard $(integrity_certificate))

# Puts the public certificate in the repository, which is what marks the app as
# signed: from here on 'make tag' offers the signature and the release workflow
# refuses a release that names none.
integrity-enable: check-app
	$(integrity_require)
	@mkdir -p "$(dir $(integrity_certificate))"
	@cp "$(cert_file)" "$(integrity_certificate)"
	@echo "Wrote $(integrity_certificate) - it belongs in the repository:"
	@echo "  git add $(integrity_certificate) && git commit -s -m 'build(release): pin the code signing certificate'"

# The tag hook: runs after the confirmation in 'make tag' and before the tag exists.
# Signs the staged tree, holds it against the committed certificate, puts the file
# in a secret gist and names that gist in the tag message, where the tag's own GPG
# signature covers the line. The key stays on this machine; the runner needs nothing
# but the gist id, which anyone holding it can read and nobody can guess.
integrity-tag: check-app
	@test -f "$(integrity_certificate)" || exit 0; \
	printf 'Generate appinfo/signature.json for this release? [Y/n] '; read yn; \
	case "$$yn" in \
		n|N) echo "No signature for v$(version) - the tarball ships without appinfo/signature.json, and $(app_id) is then not integrity-checked on any server."; exit 0;; \
	esac; \
	$(integrity_check_material); \
	command -v gh >/dev/null 2>&1 || { echo "ERROR: gh not found - it uploads the signature gist." >&2; exit 1; }; \
	$(MAKE) --no-print-directory stage || exit 1; \
	$(integrity_run) sign "$(stage_dir)/$(app_id)" "$(app_id)" "$(key_file)" "$(cert_file)" || exit 1; \
	$(integrity_run) check "$(stage_dir)/$(app_id)" "$(app_id)" "$(integrity_certificate)" || exit 1; \
	id=$$(gh gist create -d "$(app_id) v$(version) appinfo/signature.json" "$(stage_dir)/$(app_id)/appinfo/signature.json" | tail -1 | sed 's#.*/##'); \
	test -n "$$id" || { echo "ERROR: gh gist create returned no gist id." >&2; exit 1; }; \
	printf '\n%s: %s\n' "$(integrity_trailer)" "$$id" >> "$(tag_message)"; \
	echo "Signature uploaded as the secret gist $$id and named in the tag message."

# The publish hook: the gist has done its job once the App Store has the release, so
# it is dropped there and not earlier - a job that failed for an unrelated reason
# has to stay re-runnable, and a re-run needs the file again.
integrity-gist-drop: check-app
	@id=$$(git tag -l --format='%(contents)' "v$(version)" 2>/dev/null | sed -n 's/^$(integrity_trailer): *//p' | head -1); \
	test -n "$$id" || exit 0; \
	command -v gh >/dev/null 2>&1 || { echo "WARNING: gh not found - drop the signature gist with 'gh gist delete $$id --yes'." >&2; exit 0; }; \
	gh gist delete "$$id" --yes && echo "Signature gist $$id deleted." || echo "WARNING: could not delete the signature gist $$id - drop it with 'gh gist delete $$id --yes'." >&2

# Left to right, and stage exactly once: stage wipes its directory, so it has to
# be the first of the three to reach it - signing a tree that dist then rebuilds
# would ship no signature at all. The same shape as 'release: dist sign'; both are
# order-dependent and neither survives make -j.
dist-signed: integrity-sign integrity-check dist

define help_integrity-sign
make integrity-sign [DIR=<path>]

Writes appinfo/signature.json - the per-file hash list the server's integrity
check reads. Not the tarball signature 'make sign' produces for the App Store:
that one proves where the archive came from, this one lets the server tell an
installed app apart from a modified one. An app packaged without it is not
integrity-checked at all, and silently so.

Signed is the staged tree, not the checkout: stage has applied the keep model
and .nextcloudignore, so what it holds is what ships. The file lists sha512 per
file, the payload is PHP's json_encode over the ksorted map, and the signature
is RSA-PSS with digest sha1, MGF1 sha512 and salt length 0 - the scheme
'occ integrity:sign-app' uses, and deterministic at salt length 0, so both sides
write the same bytes. The key never leaves this machine.

Key and certificate are the ones mk/appstore.mk resolves, $(app_id).key and
$(app_id).crt (or .cert) in the cert dir, and the certificate's CN has to be the
app id - the server rejects any other pairing, so the step refuses it here.

  make integrity-sign              the staged tree, after stage
  make integrity-sign DIR=/var/www/nextcloud/apps/$(app_id)   a deployed app

DIR= signs a tree that already exists and skips stage; it refuses the checkout
itself. To pack a signed tarball in one go, use dist-signed.
endef

define help_integrity-check
make integrity-check [DIR=<path>|TARBALL=<file>]

Holds a tree against the appinfo/signature.json inside it: the hashes are
recomputed and compared, and the signature is verified against the certificate
the file carries. Differences are reported in the classes Checker::verify uses -
EXTRA_FILE, FILE_MISSING, INVALID_HASH - plus a CN that is not the app id and a
signature that does not match. Any of them exits non-zero.

While $(integrity_certificate) is committed, the certificate in the file is
also held against it (CERTIFICATE_MISMATCH): hashes and signature agree with each
other in any self-signed file, so only that pin says the key was the app's own.

It needs no private key, only openssl and python3, so it runs wherever the
tarball goes - on a release runner as a gate in front of dist, or against an app
already installed on a server.

  make integrity-check             the staged tree, after stage
  make integrity-check TARBALL=build/artifacts/dist/$(app_id)-$(version).tar.gz
  make integrity-check DIR=/var/www/nextcloud/apps/$(app_id)

What it does not check is the certificate chain: that the certificate was issued
by Nextcloud is verified by the server against resources/codesigning/root.crt,
and that root is not ncmake's to carry.
endef

define help_dist-signed
make dist-signed

The signed tarball: stage, integrity-sign into the staged tree, integrity-check
against what was just written, then dist. Same output as 'make dist' with
appinfo/signature.json in it - the appinfo keep dir carries the file into the
archive - and the check in the middle means a tarball that goes anywhere has
been verified the way the server will verify it.

The three steps are ordered by their position in the prerequisite list and stage
runs once for all of them, so this target is not parallel-safe; run it without
-j, as 'make release'.

Its place in a release is a fallback. The normal path signs at tag time and lets
the runner build, verify and pack; dist-signed is the way out when the runner
build cannot be repaired quickly and the tarball has to be produced here and
attached by hand.
endef

define help_integrity-enable
make integrity-enable    (maintainer, once per app)

Copies the App Store certificate to $(integrity_certificate) and leaves it
for you to commit. That file is what marks the app as signed: nothing else keeps
that record - not the server, which skips an app without signature.json in
silence, and not the App Store, which verifies the tarball signature and knows
nothing about this one.

Committed, it does two things: 'make tag' offers to produce the signature, and
the release workflow refuses to attach a tarball for a release whose tag names no
signature. It also pins the certificate every verification is held against, so a
file signed with another key fails as CERTIFICATE_MISMATCH.

It is the public certificate; it carries no key material. It sits outside the
keep model, so it is not part of the tarball.

To stop signing, remove the file from the repository. The next release then ships
unsigned, which costs the integrity check and nothing else.
endef

define help_integrity-tag
make integrity-tag    (the tag hook, not called by hand)

Installed as $$(tag_hook), so it runs inside 'make tag' between the confirmation
and the tag. Does nothing while $(integrity_certificate) is absent.

Otherwise it asks, stages, signs the staged tree, holds it against the committed
certificate, uploads appinfo/signature.json as a secret gist and writes

  $(integrity_trailer): <gist id>

into the tag message, where the tag's GPG signature covers it. The key never
leaves this machine: the runner reads the gist without any token, since a secret
gist is readable by anyone holding its id and findable by nobody.

Answering n skips the signature for this release, with no further question.
endef

define help_integrity-gist-drop
make integrity-gist-drop    (the publish hook, not called by hand)

Installed as $$(publish_hook), so it runs at the end of 'make publish' once the
App Store has answered 200 or 201. Reads the gist id out of the tag message of
v$(version) and deletes that gist.

Not earlier: a release job that failed for an unrelated reason has to stay
re-runnable, and a re-run needs the file again. Called by hand it is harmless -
without an id in the tag message it does nothing.
endef

help::
	@echo ""
	@echo "$(ch)Integrity signature (developer module)$(c0)  $(cd)(cert dir: $(cert_dir))$(c0)"
	@printf "           %b cert:  %s\n" "$(call mark,$(cert_file))" "$(cert_display)"
	@printf "           %b key:   %s\n" "$(call mark,$(key_file))" "$(key_file)"
	@printf "           %b app:   %s\n" "$(call mark,$(integrity_certificate))" "$(integrity_certificate)$(if $(wildcard $(integrity_certificate)),, - $(app_id) is not marked as signed)"
	@echo ""
	@echo "  $(ct)integrity-enable$(c0)     Commit the certificate - marks $(app_id) as signed  $(cm)[m]$(c0)"
	@echo "                       $(cd)Then 'make tag' offers the signature and the runner verifies it.$(c0)"
	@echo "  $(ct)integrity-sign$(c0)       Write appinfo/signature.json into the staged tree  $(cm)[m]$(c0)"
	@echo "                       $(cv)DIR=<path>$(c0) signs a tree that already exists (a deployed app)."
	@echo "  $(ct)integrity-check$(c0)      Hold a tree against its signature.json - hashes and signature"
	@echo "                       $(cv)DIR=<path>$(c0) or $(cv)TARBALL=<file>$(c0); needs no key, runs in CI."
	@echo "  $(ct)dist-signed$(c0)          stage + sign + check + tarball, in that order  $(cm)[m]$(c0)"
