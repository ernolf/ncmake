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
amend   commit -a --amend --no-edit
st      status -sb
lg      log --oneline --graph --decorate -20
last    log -1 HEAD
co      checkout
br      branch
sw      switch
unstage reset HEAD --
alias   config --get-regexp ^alias[.]
swc     !f() { b=$1; if [ -z "$b" ]; then [ -t 0 ] || { echo "no terminal to ask on" >&2; return 1; }; printf "new branch: "; read -r b; [ -n "$b" ] || { echo "no branch name given" >&2; return 1; }; else shift; fi; cur=$(git symbolic-ref --short -q HEAD) || cur="a detached HEAD"; if [ -z "$*" ] && [ "$cur" != main ] && [ "$cur" != master ]; then [ -t 0 ] || { echo "on $cur, not main; name the start point: git swc $b main" >&2; return 1; }; printf "on %s, not main: create %s from here? [y/N] " "$cur" "$b"; read -r a; case "$a" in [yY]) ;; *) return 1;; esac; fi; git switch -c "$b" "$@"; }; f
puh     !f() { b=$(git symbolic-ref --short -q HEAD) || { echo "detached HEAD, no branch" >&2; exit 1; }; case "$b" in main|master) echo "on $b, create the branch first" >&2; exit 1;; esac; git fetch -q --prune origin || exit; case "$(LC_ALL=C git for-each-ref --format="%(upstream:track)" "refs/heads/$b")" in *gone*) echo "origin no longer has $b, it was merged or deleted there: git merged cleans up" >&2; exit 1;; esac; case "${1-}" in -y|--yes) git push -u origin "$b"; exit;; "") ;; *) echo "usage: git puh [-y|--yes]" >&2; exit 2;; esac; [ -t 0 ] || { echo "no terminal to ask on" >&2; exit 1; }; printf "push %s to origin? [y/n] " "$b"; s=$(stty -g); trap "stty $s" EXIT; trap "exit 130" INT; stty -icanon -echo min 1 time 0; while a=$(dd bs=1 count=1 2>/dev/null); do case "$a" in [yY]) echo "$a"; stty "$s"; git push -u origin "$b"; exit;; [nN]) echo "$a"; exit 1;; esac; done; }; f
merged  !f() { base=main; b=; while [ $# -gt 0 ]; do case "$1" in into) [ -n "${2-}" ] || { echo "usage: git merged [<branch>] [into <base>]" >&2; return 1; }; base=$2; shift 2;; *) [ -z "$b" ] || { echo "usage: git merged [<branch>] [into <base>]" >&2; return 1; }; b=$1; shift;; esac; done; if [ -z "$b" ]; then b=$(git symbolic-ref --short -q HEAD) || { echo "detached HEAD, name the branch: git merged <branch>" >&2; return 1; }; fi; case "$b" in main|master|"$base") echo "on $b, name the merged branch: git merged <branch> [into <base>]" >&2; return 1;; esac; git rev-parse -q --verify "refs/heads/$b" >/dev/null || { echo "no local branch $b" >&2; return 1; }; if [ "$(git symbolic-ref --short -q HEAD)" = "$base" ]; then git pull --prune --ff-only || return 1; else old=$(git rev-parse -q --verify "refs/heads/$base"); if [ -n "$old" ]; then git fetch --prune origin "+refs/heads/*:refs/remotes/origin/*" "$base:$base"; else git fetch --prune origin "+refs/heads/*:refs/remotes/origin/*"; fi && git switch "$base" || return 1; [ -z "$old" ] || [ "$old" = "$(git rev-parse HEAD)" ] || git --no-pager diff --stat "$old" HEAD; fi; git branch -D "$b"; }; f
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
  git co, br, sw       checkout, branch, switch
  git unstage          reset HEAD --, takes files out of the index
  git amend            commit -a --amend --no-edit, folds every change to a
                       tracked file into the last commit
  git st, lg, last     short status, the last 20 commits as a graph, the last commit
  git alias            lists every alias with its command
  git swc [<branch>]   creates the branch and switches to it; asks for the name
                       when none is given, and asks before it starts from a
                       branch other than main/master unless a start point
                       follows the name (git swc <branch> main)
  git puh [-y]         first push of the current branch, after a single y or n
                       key; -y pushes without asking. Stops on a detached HEAD,
                       on main/master, on a branch whose upstream is gone on
                       origin and, without -y, without a terminal
  git merged           after the merge: fast-forwards main, switches to it,
                       lists the changed files and deletes the branch; on main
                       it takes the branch as argument (git merged <branch>);
                       into <base> does the same for another base branch
                       (git merged into stable1.2)
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
