# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: App Store management.
#
# Everything that talks to the Nextcloud App Store or needs the signing key
# and certificate lives here: onboarding (csr, register), release signing
# (sign, release), publishing (publish, delete-release) and the read-only
# queries (list-*, ratings). A user who only builds and installs an app never
# needs any of it.

# == App Store configuration ==
apps_cache    = $(cache_dir)/apps.json
apps_etag     = $(cache_dir)/apps.etag
cert_dir     ?= $(HOME)/.nextcloud/certificates
# Make a missing cert dir obvious: cert_dir_note is appended wherever cert_dir is shown,
# require_cert_dir aborts the maintainer targets that need it with a clear message.
cert_dir_note = $(if $(wildcard $(cert_dir)),, [NOT FOUND])
require_cert_dir = @test -d "$(cert_dir)" || { echo "cert dir not found: $(cert_dir) - create it and add the App Store cert/key/token." >&2; exit 1; }
# The canonical download URL of the release tarball asset - the default the
# 'make publish GH=1' prompt offers.
release_url   = https://github.com/$(gh_slug)/releases/download/v$(version)/$(app_id)-$(version).tar.gz
appstore_api  = https://apps.nextcloud.com/api/v1
api_token     = $(shell cat $(cert_dir)/appstore_api-token 2>/dev/null | tr -d '[:space:]')
# The App Store issues the certificate as .crt; some setups store it as .cert.
# Both are accepted; when neither exists, .crt is shown as the expected name.
cert_file     = $(firstword $(wildcard $(cert_dir)/$(app_id).crt $(cert_dir)/$(app_id).cert))
cert_display  = $(or $(cert_file),$(cert_dir)/$(app_id).crt)
key_file      = $(cert_dir)/$(app_id).key
token_file    = $(cert_dir)/appstore_api-token

# Green check / red cross for the help listing, depending on file existence.
mark          = $(if $(wildcard $(1)),$(cok)✓$(c0),$(cno)✗$(c0))

.PHONY: sign release fetch-apps \
        csr register publish list-releases list-releases-full list-for-author delete-release ratings

# Sign the tarball — output is the base64 signature to paste into GitHub Release
sign: check-app $(tarball)
	$(require_cert_dir)
	@echo "Signing $(tarball)..."
	openssl dgst -sha512 -sign "$(key_file)" $(tarball) | openssl base64

# Build tarball and sign in one step
release: dist sign

# == App Store cache ==

# Fetch apps.json with ETag caching (always runs as prerequisite).
# 304 Not Modified → use cached file.
# 200 OK           → update cache and save new ETag.
# Error + cache    → warn and use stale cache.
# Error, no cache  → fail.
fetch-apps:
	@mkdir -p "$(cache_dir)"; \
	_etag=""; \
	test -f "$(apps_etag)" && _etag=$$(cat "$(apps_etag)"); \
	if [ -n "$$_etag" ] && [ -f "$(apps_cache)" ]; then \
		_http=$$(curl -sL --compressed -D /tmp/.ncmake_hdrs -o /tmp/.ncmake_apps_new -w "%{http_code}" \
			-H "If-None-Match: $$_etag" "$(appstore_api)/apps.json"); \
	else \
		_http=$$(curl -sL --compressed -D /tmp/.ncmake_hdrs -o /tmp/.ncmake_apps_new -w "%{http_code}" \
			"$(appstore_api)/apps.json"); \
	fi; \
	case "$$_http" in \
		304) rm -f /tmp/.ncmake_apps_new; \
			echo "(apps.json not modified — using cache)";; \
		200) mv /tmp/.ncmake_apps_new "$(apps_cache)"; \
			_new_etag=$$(grep -i '^etag:' /tmp/.ncmake_hdrs | head -1 \
				| sed 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//' | tr -d '\r\n'); \
			[ -n "$$_new_etag" ] && printf '%s' "$$_new_etag" > "$(apps_etag)"; \
			echo "(apps.json updated)";; \
		*)  rm -f /tmp/.ncmake_apps_new; \
			if [ -f "$(apps_cache)" ]; then \
				echo "(apps.json fetch failed HTTP $$_http — using stale cache)"; \
			else \
				echo "Failed to fetch apps.json (HTTP $$_http)."; exit 1; \
			fi;; \
	esac

# == App Store ==

# Generate the signing key and certificate signing request (one-time setup,
# first step of the store onboarding). Prints the CSR for the pull request to
# https://github.com/nextcloud/app-certificate-requests; the certificate issued
# there goes into $(cert_dir) as $(app_id).crt, then 'make register' follows.
# Refuses to overwrite an existing key or CSR.
csr: check-app
	@mkdir -p "$(cert_dir)"
	@test ! -f "$(key_file)" || { echo "ERROR: $(key_file) already exists - refusing to overwrite." >&2; exit 1; }
	@csr="$(cert_dir)/$(app_id).csr"; \
	test ! -f "$$csr" || { echo "ERROR: $$csr already exists - refusing to overwrite." >&2; exit 1; }; \
	echo "Generating key + CSR for '$(app_id)' in $(cert_dir)..."; \
	openssl req -nodes -newkey rsa:4096 -sha256 -keyout "$(key_file)" -out "$$csr" -subj "/CN=$(app_id)" || exit 1; \
	chmod 600 "$(key_file)"; \
	echo; \
	echo "CSR - submit as $(app_id)/$(app_id).csr in a PR to"; \
	echo "https://github.com/nextcloud/app-certificate-requests:"; \
	echo; \
	cat "$$csr"; \
	echo; \
	echo "After the PR is merged, save the issued certificate as $(cert_display)"; \
	echo "and run 'make register'."

# Register the app on the App Store (one-time setup).
# Requires the app certificate (.crt or .cert) and .key in $(cert_dir).
register: check-app
	$(require_cert_dir)
	@set -e; \
	test -n "$(cert_file)" || { echo "Certificate not found: $(cert_dir)/$(app_id).crt (or .cert)"; exit 1; }; \
	test -f "$(key_file)"  || { echo "Key not found: $(key_file)"; exit 1; }; \
	echo "Computing signature over app id '$(app_id)'..."; \
	echo -n "$(app_id)" | openssl dgst -sha512 -sign "$(key_file)" | openssl base64 | tr -d '\n' > /tmp/.ncmake_sig; \
	python3 -c "import json;cert=open('$(cert_file)').read().strip().replace('\n','\r\n');sig=open('/tmp/.ncmake_sig').read();print(json.dumps({'certificate':cert,'signature':sig}))" > /tmp/.ncmake_body; \
	echo "Registering $(app_id) on the App Store..."; \
	http=$$(curl -s -o /tmp/.ncmake_resp -w "%{http_code}" \
		-X POST \
		-H "Authorization: Token $(api_token)" \
		-H "Content-Type: application/json" \
		--data-binary @/tmp/.ncmake_body \
		"$(appstore_api)/apps"); \
	case "$$http" in \
		201) echo "Success — app registered.";; \
		204) echo "Success — registration updated (certificate changed).";; \
		400) echo "HTTP 400 — invalid data or signature:"; cat /tmp/.ncmake_resp; echo; exit 1;; \
		401) echo "HTTP 401 — check $(cert_dir)/appstore_api-token"; exit 1;; \
		403) echo "HTTP 403 — not authorized."; exit 1;; \
		*)   echo "HTTP $$http:"; cat /tmp/.ncmake_resp; echo; exit 1;; \
	esac

# Publish a new release to the App Store. The download URL is ALWAYS required, and
# the tarball is ALWAYS downloaded from it and signed - so the signature can never
# be computed over other bytes than the App Store fetches. The asset may be hosted
# anywhere (curl handles it, including your own server); only when the URL is a
# GitHub release asset AND gh is installed does gh do the download (so private
# repos work too). Two ways to give the URL:
#   make publish              prompt for the download URL (any host)
#   make publish GH=1         pre-fill the standard GitHub release URL for the
#                             current version, so you only press Enter to confirm
# URL=<download-url> sets it non-interactively in either case.
publish: check-app
	$(require_cert_dir)
	@set -e; \
	url="$(URL)"; \
	if [ -z "$$url" ]; then \
		if [ -n "$(GH)" ]; then read -p "Download URL [$(release_url)]: " url; url="$${url:-$(release_url)}"; \
		else read -p "Download URL: " url; fi; \
	fi; \
	test -n "$$url" || { echo "Aborted."; exit 0; }; \
	tmpd=/tmp/.ncmake_publish; rm -rf "$$tmpd"; mkdir -p "$$tmpd"; \
	file="$${url##*/}"; asset="$$tmpd/$$file"; \
	rest="$${url#https://github.com/}"; gh_ok=; \
	if [ "$$rest" != "$$url" ] && command -v gh >/dev/null 2>&1; then \
		slug=$$(printf '%s' "$$rest" | cut -d/ -f1-2); \
		s3=$$(printf '%s' "$$rest" | cut -d/ -f3); s4=$$(printf '%s' "$$rest" | cut -d/ -f4); \
		tag=$$(printf '%s' "$$rest" | cut -d/ -f5); \
		[ "$$s3" = releases ] && [ "$$s4" = download ] && [ -n "$$tag" ] && [ -n "$$file" ] && gh_ok=1; \
	fi; \
	echo "Downloading $$url ..."; \
	if [ -n "$$gh_ok" ]; then \
		gh release download "$$tag" -R "$$slug" -p "$$file" -D "$$tmpd" || { echo "gh release download failed" >&2; exit 1; }; \
	else \
		curl -fL "$$url" -o "$$asset" || { echo "download failed: $$url" >&2; exit 1; }; \
	fi; \
	test -s "$$asset" || { echo "ERROR: downloaded asset is empty or missing: $$asset" >&2; exit 1; }; \
	echo "Computing signature over the downloaded asset..."; \
	openssl dgst -sha512 -sign "$(key_file)" "$$asset" | openssl base64 | tr -d '\n' > /tmp/.ncmake_sig; \
	python3 -c "import sys,json;sig=open('/tmp/.ncmake_sig').read();print(json.dumps({'download':sys.argv[1],'signature':sig}))" "$$url" > /tmp/.ncmake_body; \
	echo "Publishing v$(version) to the App Store..."; \
	http=$$(curl -s -o /tmp/.ncmake_resp -w "%{http_code}" \
		-X POST \
		-H "Authorization: Token $(api_token)" \
		-H "Content-Type: application/json" \
		--data-binary @/tmp/.ncmake_body \
		"$(appstore_api)/apps/releases"); \
	case "$$http" in \
		200) echo "Release v$(version) updated on the App Store.";; \
		201) echo "Release v$(version) published successfully!";; \
		400) echo "HTTP 400 — invalid data, signature or URL not reachable:"; cat /tmp/.ncmake_resp; echo; exit 1;; \
		401) echo "HTTP 401 — check $(cert_dir)/appstore_api-token"; exit 1;; \
		403) echo "HTTP 403 — not authorized."; exit 1;; \
		*)   echo "HTTP $$http:"; cat /tmp/.ncmake_resp; echo; exit 1;; \
	esac

# List published releases of this app (compact JSON)
list-releases: check-app fetch-apps
	@python3 -c "import sys,json;apps=json.load(open('$(apps_cache)'));app=next((a for a in apps if a['id']=='$(app_id)'),None);sys.exit(1) if not app else print(json.dumps({'id':app['id'],'releases':[{'version':r['version'],'created':r['created'],'download':r['download']} for r in app['releases']]},indent=2))" 2>/dev/null \
	|| echo "($(app_id) not found in App Store)"

# Full App Store entry as JSON
list-releases-full: check-app fetch-apps
	@python3 -c "import sys,json;apps=json.load(open('$(apps_cache)'));app=next((a for a in apps if a['id']=='$(app_id)'),None);sys.exit(1) if not app else print(json.dumps(app,indent=2))" 2>/dev/null \
	|| echo "($(app_id) not found in App Store)"

# Find all apps by author name (prompts for search string)
list-for-author: fetch-apps
	@read -p "Author search string: " term; \
	test -n "$$term" || { echo "Aborted."; exit 1; }; \
	python3 -c "import sys,json;apps=json.load(open('$(apps_cache)'));term=sys.argv[1].lower();matched=[{'id':a['id'],'name':next(iter(a.get('translations',{}).values()),{}).get('name',''),'authors':a.get('authors',[]),'releases':[r['version'] for r in a['releases']]} for a in apps if any(term in au['name'].lower() for au in a.get('authors',[]))];print(json.dumps(matched,indent=2))" "$$term" 2>/dev/null \
	|| echo "Failed to search app list."

# Delete a specific release from the App Store (interactive)
delete-release: check-app fetch-apps
	$(require_cert_dir)
	@set -e; \
	releases=$$(python3 -c "import sys,json;apps=json.load(open('$(apps_cache)'));app=next((a for a in apps if a['id']=='$(app_id)'),None);[print(r['version']) for r in (app or {}).get('releases',[])]" 2>/dev/null || true); \
	if [ -n "$$releases" ]; then \
		echo "Published releases:"; \
		echo "$$releases" | sed 's/^/  /'; \
	else \
		echo "(Could not read app data — current version in info.xml: $(version))"; \
	fi; \
	read -p "Version to delete (empty = abort): " ver; \
	test -n "$$ver" || { echo "Aborted."; exit 0; }; \
	read -p "Delete $(app_id) v$$ver from the App Store? [y/N] " confirm; \
	[ "$$confirm" = "y" ] || [ "$$confirm" = "Y" ] || { echo "Aborted."; exit 0; }; \
	http=$$(curl -s -o /dev/null -w "%{http_code}" \
		-X DELETE \
		-H "Authorization: Token $(api_token)" \
		"$(appstore_api)/apps/$(app_id)/releases/$$ver"); \
	case "$$http" in \
		204) echo "Release $$ver deleted successfully.";; \
		401) echo "HTTP 401 — check $(cert_dir)/appstore_api-token"; exit 1;; \
		403) echo "HTTP 403 — not authorized."; exit 1;; \
		404) echo "HTTP 404 — release $$ver not found."; exit 1;; \
		*)   echo "HTTP $$http — unexpected error."; exit 1;; \
	esac

# Show ratings for this app from the App Store
ratings: check-app
	@curl -sf "$(appstore_api)/ratings.json" 2>/dev/null \
	| python3 -c "import sys,json;d=json.load(sys.stdin);own=[r for r in d if r.get('app')=='$(app_id)'];avg=round(sum(r['rating'] for r in own)/len(own)*5,2) if own else None;print(json.dumps({'app':'$(app_id)','count':len(own),'avgRating':avg,'ratings':[{'rating':round(r['rating']*5,1),'ratedAt':r['ratedAt'],'comment':next(iter(r.get('translations',{}).values()),{}).get('comment','')} for r in sorted(own,key=lambda r:r['ratedAt'],reverse=True)]},indent=2))" 2>/dev/null \
	|| echo "Failed to fetch ratings."

define help_sign
make sign    (maintainer)

Signs the built tarball with the App Store key and prints the base64 signature.
Needs <app_id>.key in the cert dir and a tarball from make dist. make release
runs dist and sign in one step.
endef

define help_csr
make csr    (maintainer, one-time)

Generates the signing key and certificate request for the App Store. Writes
<app_id>.key (chmod 600) and prints the CSR to submit as <app_id>/<app_id>.csr in
a PR to github.com/nextcloud/app-certificate-requests. Refuses to overwrite an
existing key or CSR. After the PR is merged, save the issued certificate as
<app_id>.crt in the cert dir and run make register.
endef

define help_register
make register    (maintainer, one-time)

Registers the app id and certificate on the App Store. Needs <app_id>.crt (or
.cert), <app_id>.key and appstore_api-token in the cert dir (make help shows
their status). Run make csr first if you have no certificate yet.
endef

define help_publish
make publish [GH=1] [URL=...]    (maintainer)

Submits a release to the App Store: downloads the tarball from the given URL,
signs exactly those bytes and posts the URL plus signature. Prompts for the URL;
GH=1 pre-fills the standard GitHub release asset URL to confirm, URL= sets it
directly. A GitHub asset uses gh when available, so private repos work.
endef

help::
	@echo ""
	@echo "$(ch)App Store (developer module)$(c0)  $(cd)(cert dir: $(cert_dir)$(cert_dir_note))$(c0)"
	@printf "           %b token: %s\n" "$(call mark,$(token_file))" "$(token_file)"
	@printf "           %b cert:  %s\n" "$(call mark,$(cert_file))" "$(cert_display)"
	@printf "           %b key:   %s\n" "$(call mark,$(key_file))" "$(key_file)"
	@echo ""
	@echo "  $(ct)sign$(c0)                 Sign the tarball (base64 signature for publish / App Store)  $(cm)[m]$(c0)"
	@echo "  $(ct)release$(c0)              dist + sign in one step  $(cm)[m]$(c0)"
	@echo "  $(ct)csr$(c0)                  Generate the signing key + certificate request (one-time).  $(cm)[m]$(c0)"
	@echo "  $(ct)register$(c0)             Register app on the App Store (one-time).  $(cm)[m]$(c0)"
	@echo "                       Needs the certificate (.crt or .cert) and .key."
	@echo "  $(ct)publish$(c0)              Publish a release: downloads the asset from the URL and signs it.  $(cm)[m]$(c0)"
	@echo "                       Prompts for the URL; $(cv)GH=1$(c0) pre-fills the standard GitHub URL to confirm."
	@echo "  $(ct)list-releases$(c0)        List published releases (compact JSON)."
	@echo "  $(ct)list-releases-full$(c0)   Full App Store entry as JSON."
	@echo "  $(ct)list-for-author$(c0)      Find all apps by author (prompts for name)."
	@echo "  $(ct)delete-release$(c0)       Delete a release (shows list, prompts for version).  $(cm)[m]$(c0)"
	@echo "  $(ct)ratings$(c0)              Show app ratings from the App Store."
	@echo ""
	@echo "  $(cd)apps.json cache: $(apps_cache)$(c0)"
	@echo "  $(cd)         (ETag: $(apps_etag))$(c0)"
