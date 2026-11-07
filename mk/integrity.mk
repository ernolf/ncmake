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
# the checkout keeps no build artefact it would otherwise have to carry. At tag
# time the tree is staged from a fresh clone of HEAD, built there, because the
# release runner builds from the tag as well.
#
# The counterpart, integrity-check, needs no key - it verifies against the
# certificate inside the file - so it runs on a release runner, which is what
# makes it a gate in front of dist rather than a report after it. A runner has no
# developer modules, so integrity-check, the tool it shares with the signing
# steps and the committed certificate live in core; this module adds the steps
# that need the key.
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

# The tag message line naming the gist that carries this release's signature.json.
# Written by integrity-tag, read by the release workflow and by integrity-gist-drop.
integrity_trailer = ncmake-signature

# The two hooks core and appstore.mk offer: the signature is produced between the
# confirmation and the tag, the gist is dropped once the App Store has the release.
# Plain '=' - both are declared ':' with '?=' and are meant to be taken over.
tag_hook     = $(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory integrity-tag
publish_hook = $(MAKE) -f $(firstword $(MAKEFILE_LIST)) --no-print-directory integrity-gist-drop

# Signing is the maintainer's step and fails loudly when the material is missing:
# a tarball that silently lost its signature is the state this module exists to end.
# Split in two so the same test can run inside a recipe line that is already a shell.
integrity_check_material = test -n "$(cert_file)" || { echo "ERROR: certificate not found: $(cert_display) - 'make csr' starts the issuing." >&2; exit 1; }; test -f "$(key_file)" || { echo "ERROR: key not found: $(key_file)" >&2; exit 1; }
integrity_require = @$(integrity_check_material)

# REUSE for the certificate: a .crt carries no comment, so a .license sidecar
# declares it, as nextcloud/server does for its own certificates. Its copyright and
# licence are the ones REUSE.toml states for itself, as make l10n-init takes them for
# its files. An app that does not follow REUSE gets no sidecar, and one that exists
# is left as it is.
integrity_license = $(integrity_certificate).license
# REUSE-IgnoreStart
integrity_write_license = if [ -e "$(integrity_license)" ]; then \
		echo "$(integrity_license) exists, left as it is."; \
	elif [ -d LICENSES ] || [ -e REUSE.toml ] || [ -e .reuse/dep5 ]; then \
		cop=$$(sed -n 's/^\#[[:space:]]*SPDX-FileCopyrightText:[[:space:]]*//p' REUSE.toml 2>/dev/null | head -1); \
		lic=$$(sed -n 's/^\#[[:space:]]*SPDX-License-Identifier:[[:space:]]*//p' REUSE.toml 2>/dev/null | head -1); \
		if [ -n "$$cop" ] && [ -n "$$lic" ]; then \
			printf 'SPDX-FileCopyrightText: %s\nSPDX-License-Identifier: %s\n' "$$cop" "$$lic" > "$(integrity_license)" || exit 1; \
			echo "Wrote $(integrity_license)"; \
		else \
			echo "REUSE.toml states no copyright and license of its own - write $(integrity_license) yourself."; \
		fi; \
	fi
# REUSE-IgnoreEnd

# Pull-request text for integrity-enable. Kept in a make variable and exported so
# the backticks survive into the shell as literal text.
define integrity_enable_body
`make integrity-enable` committed the public code signing certificate of the app as `$(integrity_certificate)`. The file marks the app as signed:

- `make tag` offers to produce `appinfo/signature.json` and names it in the tag message.
- The release workflow refuses to attach a tarball for a release whose tag names no signature.
- Every verification is held against this certificate, so a file signed with another key fails as `CERTIFICATE_MISMATCH`.

It is the public certificate and carries no key material.
endef
export integrity_enable_body

# The tree the tag hook builds and signs.
integrity_tree = $(cache_dir)/integrity-tag

.PHONY: integrity-sign dist-signed integrity-enable integrity-tag integrity-gist-drop

# DIR= points at a tree that already exists, so only the default case needs stage.
integrity-sign: check-app $(if $(DIR),,stage)
	$(integrity_require)
	@test "$$(cd "$(integrity_dir)" 2>/dev/null && pwd -P)" != "$$(pwd -P)" || { echo "ERROR: refusing to write signature.json into the checkout - drop DIR= to sign the staged tree." >&2; exit 1; }
	@$(integrity_run) sign "$(integrity_dir)" "$(app_id)" "$(key_file)" "$(cert_file)"

# Puts the public certificate in the repository, which is what marks the app as
# signed: from here on 'make tag' offers the signature and the release workflow
# refuses a release that names none. COMMIT / PR as for l10n-init; COMMIT, PR,
# BODY and the branch flow are defined in the core.
integrity-enable: check-app
	$(integrity_require)
	@$(if $(BODY),test -r "$(BODY)" || { echo "BODY=$(BODY) is not a readable file" >&2; exit 1; };) commit="$(COMMIT)"; pr="$(PR)"; if [ "$$pr" = "1" ]; then commit=1; fi; \
	if [ "$$commit" = "1" ]; then eval "$$branch_flow"; flow_branch_start ncmake/build/integrity-enable || exit 1; fi; \
	{ mkdir -p "$(dir $(integrity_certificate))" && cp "$(cert_file)" "$(integrity_certificate)"; } || { [ "$$commit" != "1" ] || flow_branch_abort "$$branch"; exit 1; }; \
	echo "Wrote $(integrity_certificate)"; \
	( $(integrity_write_license) ) || { [ "$$commit" != "1" ] || flow_branch_abort "$$branch"; exit 1; }; \
	paths="$(integrity_certificate)"; [ ! -e "$(integrity_license)" ] || paths="$$paths $(integrity_license)"; \
	if [ "$$commit" != "1" ]; then \
		echo "Commit to the repository:"; \
		echo "  git add $$paths && git commit -sm 'build(release): pin the code signing certificate'"; \
	else \
		mkdir -p "$(cache_dir)"; git add -- $$paths; \
		flow_branch_finish "$$branch" "build(release): pin the code signing certificate" "" "$$integrity_enable_body" "$$pr" || exit 1; \
	fi

# The tag hook: runs after the confirmation in 'make tag' and before the tag exists.
# Signs the staged tree, holds it against the committed certificate, puts the file
# in a secret gist and names that gist in the tag message, where the tag's own GPG
# signature covers the line. The key stays on this machine; the runner needs nothing
# but the gist id, which anyone holding it can read and nobody can guess.
# The tree is built and staged in a clone of HEAD, not in the checkout: stage takes
# a git-ignored js/ or vendor/ as it finds it, and an older build there, or a file
# the source no longer builds, would be signed while the runner packs a fresh build
# from the tag. A plain local clone, not --shared, because the build containers
# mount the clone alone and git in there has to find every object.
integrity-tag: check-app
	@test -f "$(integrity_certificate)" || exit 0; \
	printf 'Generate appinfo/signature.json for this release? [Y/n] '; read yn; \
	case "$$yn" in \
		n|N) echo "No signature for v$(version) - the tarball ships without appinfo/signature.json, and $(app_id) is then not integrity-checked on any server."; exit 0;; \
	esac; \
	$(integrity_check_material); \
	command -v gh >/dev/null 2>&1 || { echo "ERROR: gh not found - it uploads the signature gist." >&2; exit 1; }; \
	tree="$(integrity_tree)"; app="$$tree$(if $(app_rel),/$(app_rel))"; staged="$$app/$(patsubst $(CURDIR)/%,%,$(stage_dir))/$(app_id)"; \
	rm -rf "$$tree"; \
	{ git clone -q --no-checkout "$(app_top)" "$$tree" && git -C "$$tree" checkout -q --detach "$$(git rev-parse HEAD)"; } || { echo "ERROR: could not clone HEAD into $$tree." >&2; exit 1; }; \
	echo "==> Building v$(version) in a clean clone of HEAD, as the release runner does"; \
	$(MAKE) -C "$$app" -f "$(abspath $(firstword $(MAKEFILE_LIST)))" --no-print-directory build stage || exit 1; \
	$(integrity_run) sign "$$staged" "$(app_id)" "$(key_file)" "$(cert_file)" || exit 1; \
	$(integrity_run) check "$$staged" "$(app_id)" "$(integrity_certificate)" || exit 1; \
	sig_gist() { l=$$(gh gist list --secret --limit 20) || return 1; printf '%s\n' "$$l" | awk -F '\t' -v d="$(app_id) v$(version) appinfo/signature.json" '$$2 == d { print $$1; exit }'; }; \
	$(net_create); id=$$(net_create sig_gist gh gist create -d "$(app_id) v$(version) appinfo/signature.json" "$$staged/appinfo/signature.json" | tail -1 | sed 's#.*/##'); \
	test -n "$$id" || { echo "ERROR: gh gist create returned no gist id." >&2; exit 1; }; \
	printf '\n%s: %s\n' "$(integrity_trailer)" "$$id" >> "$(tag_message)"; \
	rm -rf "$$tree"; \
	echo "Signature uploaded as the secret gist $$id and named in the tag message."

# The publish hook: the gist has done its job once the App Store has the release, so
# it is dropped there and not earlier - a job that failed for an unrelated reason
# has to stay re-runnable, and a re-run needs the file again.
integrity-gist-drop: check-app
	@id=$$(git tag -l --format='%(contents)' "v$(version)" 2>/dev/null | sed -n 's/^$(integrity_trailer): *//p' | head -1); \
	test -n "$$id" || exit 0; \
	command -v gh >/dev/null 2>&1 || { echo "WARNING: gh not found - drop the signature gist with 'gh gist delete $$id --yes'." >&2; exit 0; }; \
	$(net_retry); net_retry gh gist delete "$$id" --yes && echo "Signature gist $$id deleted." || echo "WARNING: could not delete the signature gist $$id - drop it with 'gh gist delete $$id --yes'." >&2

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
make integrity-enable [COMMIT=1|PR=1 [BODY=<path>]]    (maintainer, once per app)

Copies the App Store certificate to $(integrity_certificate). That file is
what marks the app as signed: nothing else keeps
that record - not the server, which skips an app without signature.json in
silence, and not the App Store, which verifies the tarball signature and knows
nothing about this one.

Committed, it does two things: 'make tag' offers to produce the signature, and
the release workflow refuses to attach a tarball for a release whose tag names no
signature. It also pins the certificate every verification is held against, so a
file signed with another key fails as CERTIFICATE_MISMATCH.

It is the public certificate; it carries no key material. It sits outside the
keep model, so it is not part of the tarball.

Where the app follows REUSE, the certificate gets the sidecar
$(integrity_license) with the copyright and license REUSE.toml states for
itself, as nextcloud/server keeps one next to each of its certificates. An
existing sidecar is left as it is.

Without flags it only writes the files and prints the command that commits them.
COMMIT=1 commits them on ncmake/build/integrity-enable, from main or a stable*
branch, without pushing. PR=1 implies COMMIT=1 and additionally pushes and opens
the pull request; BODY=<path> replaces its text with the contents of that file.

  make integrity-enable
  make integrity-enable PR=1

To stop signing, remove the file from the repository. The next release then ships
unsigned, which costs the integrity check and nothing else.
endef

define help_integrity-tag
make integrity-tag    (the tag hook, not called by hand)

Installed as $$(tag_hook), so it runs inside 'make tag' between the confirmation
and the tag. Does nothing while $(integrity_certificate) is absent.

Otherwise it asks, clones HEAD into $(integrity_tree), builds and stages
there, signs the staged tree, holds it against the committed certificate,
uploads appinfo/signature.json as a secret gist and writes

  $(integrity_trailer): <gist id>

into the tag message, where the tag's GPG signature covers it. The key never
leaves this machine: the runner reads the gist without any token, since a secret
gist is readable by anyone holding its id and findable by nobody.

The clone keeps the checkout out of the signature: a git-ignored js/ or vendor/
there may hold an older build, or files the source no longer builds, while the
release runner builds the tarball fresh from the tag.

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
	@echo "                       $(cd)add $(cv)COMMIT=1$(cd) to commit on a branch, or $(cv)PR=1$(cd) to commit and open the PR$(c0)"
	@echo "  $(ct)integrity-sign$(c0)       Write appinfo/signature.json into the staged tree  $(cm)[m]$(c0)"
	@echo "                       $(cv)DIR=<path>$(c0) signs a tree that already exists (a deployed app)."
	@echo "  $(ct)dist-signed$(c0)          stage + sign + check + tarball, in that order  $(cm)[m]$(c0)"
