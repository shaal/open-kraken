#!/usr/bin/env bash
# Checks that make-demo-repo.sh builds the expected repo, deterministically,
# whatever the caller's git config and environment are, and that a refused,
# failed or interrupted run never deletes or modifies anything that existed before.
# Usage: verify-demo-repo.sh [shell]   (shell that runs the builder; default: bash)
set -euo pipefail

# This script's own git calls must not see the caller's config or repo either.
unset CDPATH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_DEFAULT_HASH GIT_DEFAULT_REF_FORMAT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_PAGER=cat

here=$(cd -P -- "$(dirname -- "$0")" && pwd -P)
shell=${1:-bash}
make="$here/make-demo-repo.sh"
tmp=$(mktemp -d)
tmp=$(cd -P -- "$tmp" && pwd -P)
trap 'rm -rf -- "$tmp"' EXIT

# Pinned results. Changing the history in make-demo-repo.sh changes these.
want_repo_refs=$(
  cat <<'EOF'
refs/heads/bugfix/crash-on-start c6653c402cd8f455bddb27ba21d10896ff9f071b
refs/heads/feature/graph-view f66fbcbcf0a309271a0fadc40a780db5ae36e8e7
refs/heads/feature/login 877a264c3e19e5dc6ab57ada951e56e6649f07cb
refs/heads/main 35883939c0918f6444fc665a61ab7484048769c3
refs/heads/release/1.1 9cf147ff2783358c80132b7fa83c80b99c4b4a10
refs/remotes/origin/HEAD 7b0c8b331f8f48d0389c4c194643bd1773956bbd
refs/remotes/origin/bugfix/crash-on-start c6653c402cd8f455bddb27ba21d10896ff9f071b
refs/remotes/origin/feature/login 877a264c3e19e5dc6ab57ada951e56e6649f07cb
refs/remotes/origin/main 7b0c8b331f8f48d0389c4c194643bd1773956bbd
refs/stash ece8df0b818b6a851e8c5b1c454c4f1ca7c82c01
refs/tags/v1.0 b991281ecf9ad85955b42cffc182fb23bb7ee68f
refs/tags/v1.1 9cf147ff2783358c80132b7fa83c80b99c4b4a10
EOF
)
want_origin_refs=$(
  cat <<'EOF'
refs/heads/bugfix/crash-on-start c6653c402cd8f455bddb27ba21d10896ff9f071b
refs/heads/feature/login 877a264c3e19e5dc6ab57ada951e56e6649f07cb
refs/heads/main 7b0c8b331f8f48d0389c4c194643bd1773956bbd
EOF
)

fail=0
check() { # check <description> <expected> <actual>
  if [[ $2 == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    echo "     expected: $2"
    echo "     actual:   $3"
    fail=1
  fi
}
refs() { git -C "$1" for-each-ref --format='%(refname) %(objectname)' 2>&1; }
exists() { if [[ -e $1 || -L $1 ]]; then echo present; else echo absent; fi; }
listing() { (cd -P -- "$1" && ls -A) | tr '\n' ' ' | sed 's/ $//'; }
status_line() { git -C "$1" status --porcelain --untracked-files=normal | tr '\n' '|' | sed 's/|$//'; }
build() { # build <dir>: create <dir> and build <dir>/repo and <dir>/origin.git in it
  mkdir -p -- "$1"
  "$shell" "$make" "$1/repo" "$1/origin.git" >/dev/null
}
refused() { # refused <description> <repo> <origin>: builder must exit 1 and say "refusing"
  local err says code=0
  err=$("$shell" "$make" "$2" "$3" 2>&1 >/dev/null) || code=$?
  says="no: $err"
  if [[ $err == *refusing* ]]; then says=yes; fi # no `case` here: bash 3.2 misparses it inside $(...)
  check "$1: exit 1" "1" "$code"
  check "$1: says refusing" "yes" "$says"
}
precious() { # precious <dir>: make an existing directory with content to protect
  mkdir -p -- "$1"
  echo precious >"$1/file"
}

# 1. Clean build: pinned refs and expected content.
build "$tmp/a"
a="$tmp/a/repo"
check "repo refs and SHAs (pinned)" "$want_repo_refs" "$(refs "$a")"
check "origin refs and SHAs (pinned)" "$want_origin_refs" "$(refs "$tmp/a/origin.git")"
check "commit count (branches, tags, remotes)" "19" \
  "$(git -C "$a" rev-list --count --branches --tags --remotes)"
check "stash count" "1" "$(git -C "$a" stash list | wc -l | tr -d ' ')"
check "working tree" " M README.md|?? notes.txt" "$(status_line "$a")"
check "HEAD" "main" "$(git -C "$a" symbolic-ref --short HEAD)"
check "object format" "sha1" "$(git -C "$a" rev-parse --show-object-format)"

# 2. Unusual but valid paths.
build "$tmp/b dir"
check "path with a space" "$want_repo_refs" "$(refs "$tmp/b dir/repo")"
decoy="$tmp/decoy/c/repo" # same relative path as the target, so a CDPATH-following cd would pick it
mkdir -p "$decoy" "$tmp/c"
git -C "$decoy" init -q
(cd "$tmp" && CDPATH="$tmp/decoy" "$shell" "$make" c/repo c/origin.git >/dev/null 2>&1) || true
check "relative paths under a hostile CDPATH" "$want_repo_refs" "$(refs "$tmp/c/repo")"
check "decoy repo untouched" "" "$(refs "$decoy")"
mkdir -p "$tmp/dash"
(cd "$tmp/dash" && "$shell" "$make" -dash -dash-origin >/dev/null 2>&1) || true
check "relative paths that start with a dash" "$want_repo_refs" "$(refs "$tmp/dash/-dash")"
mkdir -p "$tmp/minus" "$tmp/oldpwd"
(cd "$tmp/minus" && OLDPWD="$tmp/oldpwd" "$shell" "$make" - origin.git >/dev/null 2>&1) || true
check "a path named - (not OLDPWD)" "$want_repo_refs" "$(refs "$tmp/minus/-")"
check "OLDPWD directory untouched" "" "$(listing "$tmp/oldpwd")"
mkdir -p "$tmp/trail"
"$shell" "$make" "$tmp/trail/repo/" "$tmp/trail/origin.git//" >/dev/null 2>&1 || true
check "trailing slashes" "$want_repo_refs" "$(refs "$tmp/trail/repo")"

# 3. Hostile caller config and git environment must not change the result.
h="$tmp/home"
mkdir -p "$h/hooks" "$h/xdg/git" "$tmp/d"
printf '#!/bin/sh\nexit 1\n' >"$h/hooks/pre-commit"
chmod +x "$h/hooks/pre-commit"
for f in "$h/.gitconfig" "$h/xdg/git/config"; do
  cat >"$f" <<EOF
[user]
	name = Somebody Else
	email = else@example.org
[commit]
	gpgsign = true
[core]
	hooksPath = $h/hooks
[init]
	defaultBranch = trunk
	defaultObjectFormat = sha256
	defaultRefFormat = reftable
[filter "evil"]
	clean = tr a-z A-Z
	required = true
EOF
done
printf 'notes.txt\n*.js\n' >"$h/xdg/git/ignore"
printf '* filter=evil\n' >"$h/xdg/git/attributes"
code=0
env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_NOSYSTEM -u GIT_PAGER \
  HOME="$h" XDG_CONFIG_HOME="$h/xdg" GIT_DEFAULT_HASH=sha256 GIT_DEFAULT_REF_FORMAT=reftable \
  GIT_AUTHOR_NAME=Intruder GIT_COMMITTER_DATE="@0 +0000" GIT_CONFIG_PARAMETERS="'commit.gpgsign=true'" \
  GIT_CONFIG_COUNT=9 GIT_DIR="$decoy/.git" \
  "$shell" "$make" "$tmp/d/repo" "$tmp/d/origin.git" >/dev/null 2>&1 || code=$?
check "hostile run: exit 0" "0" "$code"
check "hostile config, ignore/attributes files and git env are ignored" "$want_repo_refs" "$(refs "$tmp/d/repo")"
check "hostile run: working tree" " M README.md|?? notes.txt" "$(status_line "$tmp/d/repo")"
check "hostile run: decoy repo untouched" "" "$(refs "$decoy")"

# 4. Refusals: nothing that existed is changed, nothing new is created.
before=$(refs "$a")
refused "existing repo path" "$a" "$tmp/a/new-origin.git"
check "existing repo unchanged" "$before" "$(refs "$a")"
check "no origin created on refusal" "absent" "$(exists "$tmp/a/new-origin.git")"
ln -s "$tmp/nowhere" "$tmp/dangling"
refused "dangling symlink as repo path" "$tmp/dangling" "$tmp/a/o2.git"
check "dangling target not created" "absent" "$(exists "$tmp/nowhere")"
precious "$tmp/k/existing"
refused "path ending in .. (resolves to an existing dir)" "$tmp/k/existing/new/.." "$tmp/k/o.git"
refused "path ending in ." "$tmp/k/existing/." "$tmp/k/o.git"
refused "repo path with .. in the middle, parent missing" "$tmp/k/nope/../existing" "$tmp/k/o.git"
mkdir -p "$tmp/k/made"
refused "repo path with .. in the middle via an existing dir" "$tmp/k/made/../existing" "$tmp/k/o.git"
refused "origin path with .. in the middle, to an existing dir" "$tmp/k/r" "$tmp/k/made/../existing"
check "existing dir behind .. paths untouched" "file" "$(listing "$tmp/k/existing")"
check "existing dir content unchanged" "precious" "$(cat "$tmp/k/existing/file")"
check "nothing created next to it" "existing made" "$(listing "$tmp/k")"
refused "missing parent directory" "$tmp/l/missing/repo" "$tmp/l/origin.git"
check "missing parent: nothing created" "absent" "$(exists "$tmp/l")"
mkdir -p "$tmp/m"
refused "same path twice" "$tmp/m/same" "$tmp/m/same"
refused "origin inside the repo" "$tmp/m/repo" "$tmp/m/repo/origin.git"
refused "repo inside the origin" "$tmp/m/origin.git/repo" "$tmp/m/origin.git"
refused "newline in a path" "$tmp/m/re"$'\n'"po" "$tmp/m/origin.git"
check "nothing created by any refusal" "" "$(listing "$tmp/m")"

# 5. A failed or interrupted build removes only what it created.
real_git=$(command -v git)
fake() { # fake <dir> <git subcommand> <command run instead of it>: a git wrapper on PATH
  mkdir -p -- "$1"
  # shellcheck disable=SC2016 # the wrapper's own $1 and $@ must stay literal
  printf '#!/usr/bin/env bash\nif [[ ${1-} == %s ]]; then %s; fi\nexec "%s" "$@"\n' "$2" "$3" "$real_git" >"$1/git"
  chmod +x "$1/git"
}
fake "$tmp/fake-fail" merge "exit 1"
# $PPID must stay literal: inside the wrapper it is the builder's pid.
# shellcheck disable=SC2016
fake "$tmp/fake-term" merge 'kill -TERM $PPID; exit 1'
# shellcheck disable=SC2016
fake "$tmp/fake-int" merge 'kill -INT $PPID; exit 1'
# shellcheck disable=SC2016
fake "$tmp/fake-hup" merge 'kill -HUP $PPID; exit 1'
for kind in fail:1 term:143 int:130 hup:129; do
  name=${kind%%:*}
  want=${kind#*:}
  dir="$tmp/n-$name"
  precious "$dir/sibling"
  code=0
  PATH="$tmp/fake-$name:$PATH" "$shell" "$make" "$dir/repo" "$dir/origin.git" >/dev/null 2>&1 || code=$?
  check "build stopped by $name: exit $want" "$want" "$code"
  check "build stopped by $name: only the new dirs removed" "sibling" "$(listing "$dir")"
  check "build stopped by $name: sibling untouched" "precious" "$(cat "$dir/sibling/file")"
done

# A git init that "succeeds" without creating a repo must not let the build fall
# through to a repo that encloses the target.
outer="$tmp/outer"
mkdir -p "$outer/x"
git -C "$outer" init -q
echo keep >"$outer/keep.txt"
git -C "$outer" add keep.txt
GIT_AUTHOR_NAME=o GIT_AUTHOR_EMAIL=o@o GIT_COMMITTER_NAME=o GIT_COMMITTER_EMAIL=o@o git -C "$outer" commit -q -m outer
outer_before=$(refs "$outer")
fake "$tmp/fake-init" init "exit 0"
code=0
PATH="$tmp/fake-init:$PATH" "$shell" "$make" "$outer/x/repo" "$outer/x/origin.git" >/dev/null 2>&1 || code=$?
check "silent git init failure: build fails" "yes" "$( ((code != 0)) && echo yes || echo "no (exit $code)")"
check "silent git init failure: enclosing repo refs unchanged" "$outer_before" "$(refs "$outer")"
check "silent git init failure: enclosing repo tree unchanged" "" "$(status_line "$outer")"
check "silent git init failure: new dirs removed" "" "$(listing "$outer/x")"

# 6. A finished build is kept even when its output cannot be written.
mkdir -p "$tmp/p" "$tmp/q"
set +e
"$shell" "$make" "$tmp/p/repo" "$tmp/p/origin.git" | head -1 >/dev/null
code=${PIPESTATUS[0]}
set -e
check "stdout piped to head -1: exit 0" "0" "$code"
check "stdout piped to head -1: repo kept" "$want_repo_refs" "$(refs "$tmp/p/repo")"
code=0
"$shell" "$make" "$tmp/q/repo" "$tmp/q/origin.git" >&- 2>/dev/null || code=$?
check "closed stdout: exit 0" "0" "$code"
check "closed stdout: repo kept" "$want_repo_refs" "$(refs "$tmp/q/repo")"

# 7. Usage errors.
code=0
"$shell" "$make" >/dev/null 2>&1 || code=$?
check "usage error without arguments (exit 2)" "2" "$code"
code=0
"$shell" "$make" "" "$tmp/m/origin.git" >/dev/null 2>&1 || code=$?
check "usage error with an empty argument (exit 2)" "2" "$code"

exit "$fail"
