#!/usr/bin/env bash
# Rebuilds the demo repo (docs/fixtures/make-demo-repo.sh) and regenerates
# fixtures/demo-repo.json from it with git-data's dump tool. CI runs this and
# fails if the committed file differs.
set -euo pipefail
root=$(cd -P -- "$(dirname -- "$0")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

"$root/docs/fixtures/make-demo-repo.sh" "$tmp/demo-repo" "$tmp/origin.git" >/dev/null
sha() { GIT_CONFIG_GLOBAL=/dev/null git -C "$tmp/demo-repo" rev-parse ":/$1"; }
range() { # range <commit message>...: the commits' shas joined with ","
  local out="" message
  for message in "$@"; do out="$out$(sha "$message"),"; done
  echo "${out%,}"
}

# Shift+click "Validate email field" -> "Update roadmap" selects these 9 commits (spec §2).
shift_range=$(GIT_CONFIG_GLOBAL=/dev/null git -C "$tmp/demo-repo" rev-list main --not "$(sha "Validate email field")^@" | paste -sd, -)

# The selections whose file lists GitKraken showed (docs/graph-behavior-spec.md §4),
# and the spec's Shift+click range.
(cd "$root" && cargo run --quiet --locked -p git-data --bin dump -- "$tmp/demo-repo" \
  --name demo-repo \
  --range "$shift_range" \
  --range "$(range "Scaffold graph view" "Draw commit lanes" "Add context menu on commits")" \
  --range "$(range "Fix typo in docs" "Add login form")" \
  --range "$(range "Update roadmap" "Add metrics endpoint")") >"$root/fixtures/demo-repo.json"
echo "wrote fixtures/demo-repo.json"
