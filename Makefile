# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake's own Makefile. This repository IS ncmake, not a Nextcloud app, so it
# needs none of the app targets (build, psalm, dist, rsync, cp, the App Store
# block, version/changelog/tag - those all assume an app with an info.xml). It
# manages its own CI workflows through the very workflow module it ships, and
# runs the same REUSE lint the apps use. Everything below is just the handful of
# core values those two pieces read, reproduced so this file stays standalone and
# pulls in nothing else. Consuming apps use the full core Makefile via the
# bootstrap stub instead.

# == Config ==
# The values mk/workflows.mk reads from the core Makefile.
ncmake_ref = $(or $(NCMAKE_REF),main)
ncmake_raw = https://raw.githubusercontent.com/ernolf/ncmake/$(ncmake_ref)
gh_slug    = $(shell git remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$$##')
cache_dir  = $(CURDIR)/build/cache

# == Container runtime (for 'make reuse') ==
# reuse runs in the official fsfe/reuse container, so the host needs no reuse
# tool. Auto-detected (podman preferred, then docker); RUNTIME=bare expects the
# reuse tool on PATH. Override on the command line, e.g. 'make reuse RUNTIME=docker'.
have_podman := $(shell command -v podman 2>/dev/null)
have_docker := $(shell command -v docker 2>/dev/null)
ifneq ($(have_podman),)
  default_runtime := podman
else ifneq ($(have_docker),)
  default_runtime := docker
else
  default_runtime := none
endif
RUNTIME     ?= $(default_runtime)
reuse_image ?= docker.io/fsfe/reuse:latest
no_runtime   = sh -c 'echo >&2; echo "ERROR: no container runtime found (podman/docker). Install podman: apt-get install podman, or use RUNTIME=bare to run reuse on the host." >&2; echo >&2; exit 1'
ifeq ($(RUNTIME),bare)
  reuse_run = reuse
else ifeq ($(RUNTIME),none)
  reuse_run = $(no_runtime)
else ifeq ($(RUNTIME),podman)
  container = podman run --rm -v "$(CURDIR)":/app -w /app
else ifeq ($(RUNTIME),docker-rootless)
  container = docker run --rm -v "$(CURDIR)":/app -w /app
else ifeq ($(RUNTIME),docker)
  container = docker run --rm --user $(shell id -u):$(shell id -g) -v "$(CURDIR)":/app -w /app
else
  $(error Unknown RUNTIME '$(RUNTIME)'. Use: podman | docker | docker-rootless | bare)
endif
ifeq ($(filter $(RUNTIME),bare none),)
  reuse_run = $(container) $(reuse_image)
endif

# == Help palette ==
# Colors on a terminal, off when piped/redirected or NO_COLOR is set
# (https://no-color.org). MAKE_TERMOUT is empty when stdout is not a terminal;
# on make < 4.1 it is undefined, so colors default on there.
ncmake_tty := $(if $(filter undefined,$(origin MAKE_TERMOUT)),1,$(MAKE_TERMOUT))
ifeq ($(strip $(NO_COLOR)),)
  ifneq ($(strip $(ncmake_tty)),)
    ESC := $(shell printf '\033')
    c0  := $(ESC)[0m
    ch  := $(ESC)[1;36m
    ct  := $(ESC)[32m
    cd  := $(ESC)[2m
    cv  := $(ESC)[33m
  endif
endif

.DEFAULT_GOAL := help
.PHONY: help reuse clean dist-clean dev-init

# REUSE compliance check (https://reuse.software) in the official fsfe/reuse
# container; RUNTIME=bare expects the reuse tool on the host. Licensing is a
# property of the whole tree, so this needs no app - it runs right here.
reuse:
	@echo "==> reuse lint (RUNTIME=$(RUNTIME))"
	@$(reuse_run) lint

clean:
	rm -rf build

# Remove every git-ignored file for a true from-scratch state (build/ and any
# other ignored output); mirrors the core target so the habit carries over.
dist-clean: clean
	git clean -dffX

# ncmake ships the workflow module in mk/, so it is always present here. This
# target exists only so the shared updater command 'make dev-init &&
# make workflows-update' - where a consuming app fetches the module first - runs
# unchanged on ncmake too. Intentionally not listed in help.
dev-init:
	@:

# == Help header ==
# Double-colon so the workflow module (included below) prints its section in the
# middle and the footer rule prints last.
help::
	@echo "$(cd)Usage: make <target>    (no target = this help)$(c0)"
	@echo ""
	@echo "$(ch)Lint:$(c0)"
	@echo "  $(ct)reuse$(c0)                Run the REUSE compliance check in the fsfe/reuse container"

# == Developer module: CI workflow manager ==
include mk/workflows.mk

# == Help footer ==
help::
	@echo ""
	@echo "$(ch)Utility:$(c0)"
	@echo "  $(ct)clean$(c0)                Remove the build/ directory"
	@echo "  $(ct)dist-clean$(c0)           Remove all git-ignored files (build outputs)"
	@echo "  $(ct)help$(c0)                 Show this help"
	@echo ""
	@echo "  $(cd)Details on one target:$(c0) $(ct)make help-<target>$(c0)   $(cd)(e.g. make help-workflows-list)$(c0)"

# == Per-target help ==
# `make help-<target>` prints the extended help_<target> the module defines.
define help_reuse
make reuse

Runs the REUSE compliance check (https://reuse.software) over the whole tree in
the official fsfe/reuse container. RUNTIME=bare runs a reuse tool installed on
the host instead.
endef
help-%:
	@:$(info $(or $(help_$*),No extended help for "$*". Run "make help" for the target list.))
