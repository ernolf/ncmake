# SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
# SPDX-License-Identifier: MIT
#
# ncmake developer module: git aliases.
#
# git-aliases writes the aliases of the wiki page Git tips into the global git
# configuration of the calling user:
# https://github.com/ernolf/ncmake/wiki/Git-tips
# It never overwrites an alias the user defined differently unless FORCE=1 is
# given.

.PHONY: git-aliases

# == Alias table ==
# One alias per line: the name, then the command exactly as git config stores
# it, the value that would follow alias.<name> in a git config call. Adding an
# alias is one more line. The table is handed to the recipe through $(value),
# so the commands are written without make escaping: a $ stays a single $.
define git_aliases
ci      commit
p       push
pf      push --force-with-lease
pu      push -u origin
amend   commit --amend --no-edit
st      status -sb
lg      log --oneline --graph --decorate -20
last    log -1 HEAD
alias   config --get-regexp ^alias[.]
puh     !b=$(git symbolic-ref --short -q HEAD) || { echo "detached HEAD, no branch" >&2; exit 1; }; case "$b" in main|master) echo "on $b, create the branch first" >&2; exit 1;; esac; printf "push %s to origin? [y/N] " "$b"; read a; [ "$a" = y ] && git push -u origin "$b"
merged  !f() { b=$1; if [ -z "$b" ]; then b=$(git symbolic-ref --short -q HEAD) || { echo "detached HEAD, name the branch: git merged <branch>" >&2; return 1; }; fi; case "$b" in main|master) echo "on $b, name the merged branch: git merged <branch>" >&2; return 1;; esac; git rev-parse -q --verify "refs/heads/$b" >/dev/null || { echo "no local branch $b" >&2; return 1; }; if [ "$(git symbolic-ref --short -q HEAD)" = main ]; then git pull --prune --ff-only || return 1; else old=$(git rev-parse -q --verify refs/heads/main); git fetch --prune origin main:main && git switch main || return 1; [ -z "$old" ] || [ "$old" = "$(git rev-parse HEAD)" ] || git --no-pager diff --stat "$old" HEAD; fi; git branch -D "$b"; }; f
gone    !f() { git fetch --prune || return 1; cur=$(git symbolic-ref --short -q HEAD); LC_ALL=C git for-each-ref --format="%(if:equals=[gone])%(upstream:track)%(then)%(refname:short)%(end)" refs/heads | while read -r b; do [ -n "$b" ] || continue; if [ "$b" = "$cur" ]; then echo "skipping $b, it is checked out: git merged" >&2; else git branch -D "$b"; fi; done; }; f
endef

# Only `git config --global` is called, so no root is needed: run as root, the
# target sets the aliases for root. An existing alias with another command is
# the user's own and is reported with both commands instead of being replaced.
git-aliases: export ncmake_git_aliases := $(value git_aliases)
git-aliases:
	@set -e; \
	command -v git >/dev/null 2>&1 || { echo "ERROR: git not found" >&2; exit 1; }; \
	printf '%s\n' "$$ncmake_git_aliases" | while IFS= read -r line; do \
		[ -n "$$line" ] || continue; \
		name=$${line%% *}; cmd=$${line#"$$name"}; cmd=$${cmd#"$${cmd%%[! ]*}"}; \
		if ! cur=$$(git config --global --get "alias.$$name"); then \
			git config --global "alias.$$name" "$$cmd"; \
			echo "==> git $$name set"; \
		elif [ "$$cur" = "$$cmd" ]; then \
			echo "==> git $$name is already up to date"; \
		elif [ -n "$(FORCE)" ]; then \
			git config --global "alias.$$name" "$$cmd"; \
			echo "==> git $$name overwritten, it was: $$cur"; \
		else \
			echo "==> git $$name is defined differently and left as it is (FORCE=1 overwrites it)"; \
			echo "    yours:  $$cur"; \
			echo "    ncmake: $$cmd"; \
		fi; \
	done; \
	echo ""; \
	echo "==> Aliases now defined (git alias):"; \
	git config --get-regexp '^alias[.]'

define help_git-aliases
make git-aliases [FORCE=1]

Writes the git aliases of the wiki page Git tips into the global git
configuration (~/.gitconfig) of the user who runs it:

  git ci, p, pf, pu    commit, push, push --force-with-lease, push -u origin
  git amend            commit --amend --no-edit
  git st, lg, last     short status, the last 20 commits as a graph, the last commit
  git alias            lists every alias with its command
  git puh              first push of the current branch, after asking; stops on
                       a detached HEAD and on main/master
  git merged           after the merge: fast-forwards main, switches to it,
                       lists the changed files and deletes the branch; on main
                       it takes the branch as argument (git merged <branch>)
  git gone             deletes every local branch whose upstream is gone on
                       origin, except the one checked out

An alias that is not defined yet is set, one with the same command is reported
as up to date. An alias defined with a different command is the user's own: it
is left as it is and reported with both commands. FORCE=1 overwrites it.

No root is needed; run as root, it sets the aliases for root. At the end the
target prints every alias as git alias does.

Details and the reasoning behind each alias:
https://github.com/ernolf/ncmake/wiki/Git-tips
endef

help::
	@echo ""
	@echo "$(ch)Git (developer module):$(c0)"
	@echo "  $(ct)git-aliases$(c0)          Set the git aliases of the wiki page Git tips for the calling user (FORCE=1 overwrites)"
