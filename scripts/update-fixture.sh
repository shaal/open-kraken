#!/usr/bin/env bash
# Rebuilds the demo repo (docs/fixtures/make-demo-repo.sh) and regenerates
# fixtures/demo-repo.json from it with git-data's dump tool, then builds the
# edge-case repo (the demo plus the cases below) into fixtures/edge-repo.json.
# CI runs this and fails if a committed file differs.
set -euo pipefail
root=$(cd -P -- "$(dirname -- "$0")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

# Every git run below, the dumps included, ignores the caller's git config and
# git environment (a global mailmap, for example, would change author names).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT \
  GIT_NAMESPACE GIT_CEILING_DIRECTORIES
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1

"$root/docs/fixtures/make-demo-repo.sh" "$tmp/demo-repo" "$tmp/origin.git" >/dev/null
# sha <commit message>: the commit whose message starts with it. Anchored, because
# the stash's index commit is "index on main: … Update roadmap".
sha() { git -C "$tmp/demo-repo" rev-parse ":/^$1"; }
range() { # range <commit message>...: the commits' shas joined with ","
  local out="" message
  for message in "$@"; do out="$out$(sha "$message"),"; done
  echo "${out%,}"
}

# Shift+click "Validate email field" -> "Update roadmap" selects these 9 commits (spec §2).
shift_range=$(git -C "$tmp/demo-repo" rev-list main --not "$(sha "Validate email field")^@" | paste -sd, -)

# The selections whose file lists GitKraken showed (docs/graph-behavior-spec.md §4),
# and the spec's Shift+click range.
(cd "$root" && cargo run --quiet --locked -p git-data --bin dump -- "$tmp/demo-repo" \
  --name demo-repo \
  --range "$shift_range" \
  --range "$(range "Scaffold graph view" "Draw commit lanes" "Add context menu on commits")" \
  --range "$(range "Fix typo in docs" "Add login form")" \
  --range "$(range "Update roadmap" "Add metrics endpoint")") >"$root/fixtures/demo-repo.json"
echo "wrote fixtures/demo-repo.json"

# The edge-case repo: what the demo repo does not have, for the browser
# (`?fixture=edge`). The demo repo stays as it is: the spec and
# verify-demo-repo.sh rely on its SHAs.
edge="$tmp/edge-repo"
"$root/docs/fixtures/make-demo-repo.sh" "$edge" "$tmp/edge-origin.git" >/dev/null
step=0
eg() { # eg <git args...>: git in the edge repo as Frank, at the next timestamp
  step=$((step + 1))
  local when="@$((1759300000 + (100 + step) * 7200)) +0000" # after every demo commit
  GIT_CONFIG_COUNT=3 \
    GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
    GIT_CONFIG_KEY_1=commit.gpgSign GIT_CONFIG_VALUE_1=false \
    GIT_CONFIG_KEY_2=tag.gpgSign GIT_CONFIG_VALUE_2=false \
    GIT_AUTHOR_NAME=Frank GIT_AUTHOR_EMAIL=frank@example.com GIT_AUTHOR_DATE=$when \
    GIT_COMMITTER_NAME=Frank GIT_COMMITTER_EMAIL=frank@example.com GIT_COMMITTER_DATE=$when \
    git -C "$edge" "$@"
}
at() { git -C "$edge" rev-parse ":/^$1"; } # at <commit message>: like sha, in the edge repo

# Upstreams: main is ahead of origin/main (two labels); feature/login and
# origin/feature/login are one commit (one label, matched by upstream and by
# name); feature/graph-view tracks a remote branch with another name.
eg branch -q --set-upstream-to=origin/main main
eg branch -q --set-upstream-to=origin/feature/login feature/login
eg update-ref refs/remotes/origin/graph "$(at "Highlight branch on hover")"
eg branch -q --set-upstream-to=origin/graph feature/graph-view
# A remote branch with no local branch, and a name too long for the column.
eg update-ref refs/remotes/origin/experiment "$(at "Draw commit lanes")"
eg branch feature/a-very-long-branch-name-that-does-not-fit-the-column "$(at "Add health endpoint")"
# An annotated tag and two lightweight tags on one commit.
metrics=$(at "Add metrics endpoint")
eg tag -a v1.2 -m "Release 1.2" "$metrics"
eg tag nightly "$metrics"
eg tag qa/passed "$metrics"
# A committed rename, then a detached HEAD at main's tip (where main also
# points) with a staged rename in the working tree.
eg checkout -q -b chore/rename-build-script main
eg mv build.sh make.sh
eg commit -q -m "Rename build script"
eg checkout -q --detach main
eg mv docs.md guide.md

(cd "$root" && cargo run --quiet --locked -p git-data --bin dump -- "$edge" \
  --name edge-repo) >"$root/fixtures/edge-repo.json"
echo "wrote fixtures/edge-repo.json"
