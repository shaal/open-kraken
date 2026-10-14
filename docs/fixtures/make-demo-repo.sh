#!/usr/bin/env bash
# Builds the demo repo used for docs/graph-behavior-spec.md: 5 branches, 2 merges,
# 2 tags, a remote, a stash and uncommitted changes.
# Deterministic: every commit (stash included) has a fixed author, committer and
# date, and the caller's git config is ignored, so every run gives the same SHAs.
# Usage: make-demo-repo.sh <repo-dir> <bare-origin-dir>
#   Both directories must not exist yet; their parent directories must exist.
# Needs bash 3.2+ and git 2.32+. Check with verify-demo-repo.sh.
set -euo pipefail
unset CDPATH # a caller's CDPATH could make `cd` land in another directory

usage() {
  echo "usage: $0 <repo-dir> <bare-origin-dir>   (new directories; parents must exist)" >&2
  exit 2
}
[[ $# -eq 2 && -n $1 && -n $2 ]] || usage

# Ignore the caller's git config and git environment (hooks, signing, templates,
# ignore and attributes files, hash and ref formats, default branch, identity, pager).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CEILING_DIRECTORIES \
  GIT_NAMESPACE GIT_TEMPLATE_DIR GIT_DEFAULT_HASH GIT_DEFAULT_REF_FORMAT \
  GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_COMMITTER_DATE
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat
export GIT_CONFIG_COUNT=4 \
  GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
  GIT_CONFIG_KEY_1=commit.gpgsign GIT_CONFIG_VALUE_1=false \
  GIT_CONFIG_KEY_2=core.excludesFile GIT_CONFIG_VALUE_2=/dev/null \
  GIT_CONFIG_KEY_3=core.attributesFile GIT_CONFIG_VALUE_3=/dev/null

read -r major minor <<<"$(git version | sed -E 's/^git version ([0-9]+)\.([0-9]+).*/\1 \2/')"
if ((major < 2 || (major == 2 && minor < 32))); then
  echo "git 2.32 or newer is required" >&2
  exit 1
fi

refuse() {
  echo "refusing: $*" >&2
  exit 1
}
resolve() { # resolve <path>: print <canonical existing parent>/<new name>, or refuse
  local leaf parent
  [[ $1 != *$'\n'* ]] || refuse "path contains a newline"
  leaf=$(basename -- "$1")
  parent=$(dirname -- "$1")
  case $leaf in
  . | .. | /) refuse "$1 must end in a new directory name" ;;
  esac
  case $parent in
  /*) ;;
  *) parent="./$parent" ;; # never let cd treat it as an option or as "-" (OLDPWD)
  esac
  [[ -d $parent ]] || refuse "the parent directory of $1 does not exist"
  parent=$(cd -P -- "$parent" && pwd -P && echo .) # the "." keeps a trailing newline from being stripped
  parent=${parent%.}
  parent=${parent%$'\n'}
  [[ $parent != *$'\n'* ]] || refuse "the resolved path of $1 contains a newline"
  parent=${parent%/}
  [[ ! -e $parent/$leaf && ! -L $parent/$leaf ]] || refuse "$1 already exists"
  printf '%s/%s\n' "$parent" "$leaf"
}
R=$(resolve "$1")
O=$(resolve "$2")
[[ $R != "$O" ]] || refuse "the repo and the origin are the same path"

# A failure or signal from here on removes the two directories this run created.
# They are created with a plain mkdir, which fails if they exist, so the cleanup
# can never remove anything that existed before.
made_r=
made_o=
cleanup() {
  local status=$?
  set +e # a failed rm must not stop the rest of the cleanup or change the exit status
  if ((status != 0)); then
    if [[ -n $made_o ]]; then rm -rf -- "$made_o"; fi
    if [[ -n $made_r ]]; then rm -rf -- "$made_r"; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE

mkdir -- "$O"
made_o=$O
mkdir -- "$R"
made_r=$R
git init -q --bare -b main --object-format=sha1 --template= "$O"
git init -q -b main --object-format=sha1 --template= "$R"
cd -- "$R"
[[ -d $R/.git ]] || refuse "git init did not create $R/.git"
GIT_CEILING_DIRECTORIES=$(dirname -- "$R") # never fall through to a repo that encloses $R
export GIT_CEILING_DIRECTORIES

T=1759300000 # base epoch; step n is dated T + n * 2h
n=0
as() { # as <name> <git args...>: run git as <name> at the next timestamp
  local who=$1 email when
  shift
  email="$(printf '%s' "$who" | tr '[:upper:]' '[:lower:]')@example.com"
  n=$((n + 1))
  when="@$((T + n * 7200)) +0000"
  GIT_AUTHOR_NAME=$who GIT_AUTHOR_EMAIL=$email GIT_AUTHOR_DATE=$when \
    GIT_COMMITTER_NAME=$who GIT_COMMITTER_EMAIL=$email GIT_COMMITTER_DATE=$when \
    git "$@"
}
c() { # c <author> <file> <msg>: append a line to <file> and commit it
  echo "$3 ($((n + 1)))" >>"$2"
  git add -A
  as "$1" commit -q -m "$3"
}
m() { # m <author> <branch> <msg>: merge <branch> with a merge commit
  as "$1" merge -q --no-ff "$2" -m "$3"
}

c Alice README.md "Initial commit"
c Alice build.sh "Add build script"
c Alice README.md "Document setup steps"
git tag v1.0
git checkout -q -b bugfix/crash-on-start HEAD~1
c Dave app.js "Guard against null config"
git checkout -q main
git checkout -q -b feature/login
c Bob login.js "Add login form"
c Bob login.js "Validate email field"
git checkout -q main
c Alice docs.md "Fix typo in docs"
git checkout -q feature/login
c Bob login.js "Add remember-me option"
git checkout -q bugfix/crash-on-start
c Dave app.js "Add regression test for crash"
git checkout -q main
m Alice feature/login "Merge branch 'feature/login'"
git checkout -q -b feature/graph-view
c Carol graph.js "Scaffold graph view"
git checkout -q main
c Alice api.js "Add health endpoint"
git checkout -q feature/graph-view
c Carol graph.js "Draw commit lanes"
c Carol graph.js "Add context menu on commits"
git checkout -q main
git checkout -q -b release/1.1
c Erin CHANGELOG.md "Prepare 1.1 release notes"
git tag v1.1
git checkout -q main
m Alice release/1.1 "Merge branch 'release/1.1'"
git remote add origin "$O"
git push -q origin main feature/login bugfix/crash-on-start
c Alice api.js "Add metrics endpoint"
git checkout -q feature/graph-view
c Carol graph.js "Highlight branch on hover"
git checkout -q main
c Alice README.md "Update roadmap"
git fetch -q origin
git remote set-head origin main >/dev/null # newer git creates origin/HEAD on fetch; make it the same everywhere
echo "stashed experiment" >>api.js
as Alice stash push -q -m "WIP: experiment with caching"
echo "uncommitted change" >>README.md
echo "new file" >notes.txt

# The build is complete: nothing is removed from here on, and output errors
# (for example `| head -1` or a closed stdout) cannot fail the run.
made_r=
made_o=
trap '' PIPE
{
  git log --graph --oneline --all --decorate
  echo
  git status --short
  git stash list
} || true
