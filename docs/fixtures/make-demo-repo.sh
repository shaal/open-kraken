#!/bin/zsh
# Builds the demo repo used for docs/graph-behavior-spec.md: 5 branches, 2 merges,
# 2 tags, a remote, a stash and uncommitted changes. Deterministic dates and authors.
# Usage: make-demo-repo.sh <repo-dir> <bare-origin-dir>   (both must not exist yet)
set -euo pipefail
R=$1; O=$2
[[ -e $R || -e $O ]] && { echo "refusing: $R or $O already exists" >&2; exit 1; }; mkdir -p $R; git init -q --bare $O; cd $R
g() { git -c commit.gpgsign=false -c tag.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
g init -q -b main
T=1759300000  # base epoch
n=0
c() { # c <author> <file> <msg>
  n=$((n+1)); local who=$1 f=$2 msg=$3
  echo "$msg ($n)" >> $f; g add -A
  GIT_AUTHOR_NAME=$who GIT_AUTHOR_EMAIL="${who:l}@example.com" GIT_COMMITTER_NAME=$who GIT_COMMITTER_EMAIL="${who:l}@example.com" \
  GIT_AUTHOR_DATE="@$((T + n*7200)) +0000" GIT_COMMITTER_DATE="@$((T + n*7200)) +0000" g commit -q -m "$msg"
}
m() { # m <author> <branch> <msg>
  n=$((n+1)); local who=$1
  GIT_AUTHOR_NAME=$who GIT_AUTHOR_EMAIL="${who:l}@example.com" GIT_COMMITTER_NAME=$who GIT_COMMITTER_EMAIL="${who:l}@example.com" \
  GIT_AUTHOR_DATE="@$((T + n*7200)) +0000" GIT_COMMITTER_DATE="@$((T + n*7200)) +0000" g merge -q --no-ff $2 -m "$3"
}
c Alice README.md "Initial commit"
c Alice build.sh "Add build script"
c Alice README.md "Document setup steps"
g tag v1.0
g checkout -q -b bugfix/crash-on-start HEAD~1
c Dave app.js "Guard against null config"
g checkout -q main
g checkout -q -b feature/login
c Bob login.js "Add login form"
c Bob login.js "Validate email field"
g checkout -q main
c Alice docs.md "Fix typo in docs"
g checkout -q feature/login
c Bob login.js "Add remember-me option"
g checkout -q bugfix/crash-on-start
c Dave app.js "Add regression test for crash"
g checkout -q main
m Alice feature/login "Merge branch 'feature/login'"
g checkout -q -b feature/graph-view
c Carol graph.js "Scaffold graph view"
g checkout -q main
c Alice api.js "Add health endpoint"
g checkout -q feature/graph-view
c Carol graph.js "Draw commit lanes"
c Carol graph.js "Add context menu on commits"
g checkout -q main
g checkout -q -b release/1.1
c Erin CHANGELOG.md "Prepare 1.1 release notes"
g tag v1.1
g checkout -q main
m Alice release/1.1 "Merge branch 'release/1.1'"
g remote add origin $O
g push -q origin main feature/login bugfix/crash-on-start
c Alice api.js "Add metrics endpoint"
g checkout -q feature/graph-view
c Carol graph.js "Highlight branch on hover"
g checkout -q main
c Alice README.md "Update roadmap"
g fetch -q origin
echo "stashed experiment" >> api.js; g stash push -q -m "WIP: experiment with caching"
echo "uncommitted change" >> README.md; echo "new file" > notes.txt
git log --graph --oneline --all --decorate | head -40; echo; git status --short; git stash list
