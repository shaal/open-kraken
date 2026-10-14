# Roadmap

Task file for the `ship-next` loop. Each top-level `- [ ]` is one task, shipped as one PR, in document order.
Only tasks have checkboxes. Acceptance criteria and notes are plain bullets.

Behavior reference: [docs/graph-behavior-spec.md](docs/graph-behavior-spec.md) (cited as §N).
Stack: Tauri 2 + React + TypeScript (Vite, pnpm). Git access goes through the `git` CLI from Rust.

Layout of the code (set up in the scaffold task):
- `crates/git-data/`: pure Rust crate, **no Tauri dependency**. Reads git data and runs git actions. Tested with `cargo test -p git-data`.
- `src-tauri/`: the Tauri app crate. Thin commands that call `git-data`.
- `src/`: the React frontend. Reads data through an adapter interface: a Tauri adapter and a fixture-JSON adapter (for the browser and tests).

Probes (how each task is verified):
- **logic**: `pnpm test` (Vitest) and/or `cargo test -p git-data`.
- **ui**: Vite dev server with the fixture adapter, checked in a headless browser (screenshots + DOM assertions).
- **app**: the real Tauri window (`pnpm tauri dev`). Use only at milestones; the Mac is in active use.

## Foundation

- [x] **Fixture script: portable and deterministic**
  - Port `docs/fixtures/make-demo-repo.sh` from zsh to bash (Ubuntu CI has no zsh).
  - Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (name, email, date) for every git call, including `git stash push`.
  - Ignore the user's git config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`) so hooks, signing and templates cannot change the result.
  - Acceptance: two runs into different directories give identical SHAs for all commits and the stash; the script still refuses existing paths.
  - Probe: logic (run twice, compare `git rev-parse` of all refs and `refs/stash`).

- [x] **Scaffold: Tauri 2 + React + TS + Vite, workspace, tooling**
  - pnpm project; TypeScript strict; Vitest; ESLint + Prettier; Cargo workspace with `crates/git-data` and `src-tauri`.
  - `pnpm test`, `pnpm typecheck`, `pnpm lint`, `cargo fmt --check`, `cargo clippy`, `cargo test -p git-data` all pass.
  - README: what the project is, prerequisites, dev commands. CLAUDE.md: the real commands.
  - Acceptance: `pnpm tauri dev` opens a window titled "open-kraken".
  - Probe: logic + app (one window screenshot).

- [x] **CI on pull requests**
  - GitHub Actions on `ubuntu-latest`: pnpm install (frozen lockfile), typecheck, lint, Vitest; `cargo fmt --check`, `cargo clippy -p git-data`, `cargo test -p git-data`; `docs/fixtures/verify-demo-repo.sh`.
  - Do not build the Tauri app in CI (needs webkit packages); `git-data` must build without them.
  - Acceptance: the workflow runs green on this task's own PR.
  - Probe: the PR's check run.

## Data

- [x] **git-data: commits, refs, HEAD**
  - `log(repo)`: every commit reachable from branches, remote branches and tags (not stash internals). Fields: sha, parents, author name/email, author time, committer time, subject.
  - `refs(repo)`: local branches, remote branches, tags (annotated tags peeled to the commit), `HEAD` (branch or detached), upstream of each local branch.
  - Parse with NUL separators. Subjects with tabs, `%`, newlines in the body, or non-UTF-8 bytes must not break parsing.
  - Errors: not a repo → typed error; empty repo (no commits) → empty result, not an error; path with spaces works.
  - Probe: logic (`cargo test -p git-data` against the fixture repo built in a temp dir, plus unit tests for the parser).

- [ ] **git-data: working tree and stashes**
  - `status(repo)`: staged and unstaged files with change type (modified, added, deleted, renamed, untracked). Parse `git status --porcelain=v2 -z`.
  - `stashes(repo)`: index, message, stash commit sha, base commit sha.
  - `log()` must also include each stash's base commit, so a stash row always has a commit to connect to (§1), even when no branch contains it.
  - `commit_files(repo, sha)`: changed files of one commit (first parent; root commit vs empty tree). `range_files(repo, shas)` for a multi-selection.
  - Probe: logic (fixture repo: README.md modified, notes.txt untracked, 1 stash).

- [ ] **Tauri commands, TS types, data adapters**
  - Tauri commands for every `git-data` reader. Shared TS types.
  - Adapter interface in `src/`; Tauri adapter; fixture adapter that loads `fixtures/demo-repo.json`.
  - A dump tool (`cargo run -p git-data --bin dump -- <repo>`) writes that JSON; a script rebuilds the demo repo and regenerates the JSON.
  - Open a repo from a CLI argument or a folder dialog. Show a typed error for a non-repo.
  - Serialize `GitError` with a `kind` the UI can switch on; for `NotRepositoryRoot`, offer to open the root.
  - Measure the IPC cost of `log()`: 100 000 commits are about 14 MB of git output and 24 MB of JSON. Page or stream it if one call is too slow (or record the number for the Performance task).
  - Probe: logic (adapter tests) + app (open the demo repo, see the commit count).

## Layout

- [ ] **Layout: row order** (§6.1)
  - Pure TS. Temporal topological sort: depth-first, started from commits sorted newest-first by committer date.
  - Properties: every parent row is below all its children; result is deterministic for any input order; equals committer-date order when that order is already valid; clock skew handled.
  - Probe: logic (Vitest + fast-check property tests; the fixture repo order).

- [ ] **Layout: lanes, edges, colors** (§6.2–6.4, §1 Edges)
  - Pure TS. Branch children vs merge children; forbidden columns; take over a branch child's lane, else first empty slot, else append; clear (never remove) slots.
  - Output per row: node lane, pass-through lanes, and edge segments (vertical, fork elbow, merge elbow) with lane colors.
  - Properties: no edge passes through another node; a branch's first-parent chain stays in one lane; lanes never shift.
  - Probe: logic (property tests on random DAGs; fixture snapshot).

## Graph view

- [ ] **Graph table with virtualization** (§1 Table)
  - Columns: Branch / Tag, Graph, Commit message. Constant row height. Header row with a gear icon.
  - Rows virtualized with `@tanstack/react-virtual`. 50 000 synthetic commits scroll without frame drops in the browser.
  - Probe: ui (fixture adapter; DOM row count stays bounded while scrolling; screenshot).

- [ ] **Graph lanes rendering** (§1 Nodes, Edges and lanes)
  - Per-row SVG: lane lines, orthogonal edges with rounded 90° elbows, node avatar circle with lane-colored ring (identicon from the email hash, no network requests), merge commits as small solid dots.
  - Row streak in the lane color between node and message; thin lane-colored bar at the left of the message cell.
  - Probe: ui (screenshot of the fixture graph; DOM checks for node kinds).

- [ ] **Ref labels column** (§1 Ref labels)
  - Pills in the lane color with a connector line to the node; laptop / cloud / both / tag icons; `✓` on the checked-out branch; `+N` badge for extra refs; truncation with `…` and the full name on hover.
  - Probe: ui.

- [ ] **WIP and stash rows** (§1 Special rows)
  - WIP row at the top only when the tree is dirty: dashed hollow node, message cell placeholder `// WIP`, change counts.
  - Stash rows: dotted square node, dotted connector to the base commit.
  - Probe: ui (fixture has both).

## Interaction

- [ ] **Selection and keyboard navigation** (§2, §5, §7)
  - Click selects; click on the only selected commit clears; Cmd+click toggles; Shift+click selects `rev-list newer --not older^@`.
  - Keys: ↑/↓ and K/J (rows), ←/→ and H/L (lanes), Shift+↑/↓ (along the branch), ⌘↑/⌘↓ (first/last). Keep the selection in view.
  - Acceptance: the fixture case `Validate email field` → Shift+click `Update roadmap` selects exactly the 9 commits listed in §2.
  - Probe: logic (selection reducer tests) + ui.

- [ ] **Hover effects** (§2)
  - Row hover highlight and full-message tooltip; ghost label of the nearest containing branch on hover and on selection.
  - Branch-label hover expands the pill and fades messages of commits not on that branch (nodes and edges do not fade).
  - Probe: logic (nearest-branch function) + ui.

- [ ] **Details panel** (§4)
  - Single commit: sha, message, author, date, parent(s), file list with change-type icons, Path / Tree toggle.
  - Read the full message body on demand (a `commit_message(sha)` reader), not in `log()`.
  - Multi-selection: "N commits selected", commit list, header "Viewing diff between 2 commits" for 2 and "Viewing diff of N commits" for 3+, combined file list.
  - WIP: unstaged and staged file lists (read-only in this roadmap).
  - Panel hides when the selection is cleared.
  - Probe: ui.

- [ ] **Context menus** (§3)
  - Pure TS menu builders for every target in §3 (commit, commit on the checked-out branch, multi-selection, commit with a ref, local branch, remote branch, tag, WIP, stash, column header) and the scope rule §3.0.
  - Items for deferred features (see the end of this file) are left out; every other label, order and separator matches §3 exactly.
  - Native popup through the Tauri menu API. Items whose action is not built yet are present but disabled.
  - Probe: logic (snapshot each builder against §3 strings) + app (one real right-click).

- [ ] **Actions: copy, create branch, tags, checkout**
  - Copy commit sha / branch name / tag name. Create branch here (name prompt). Create tag here, create annotated tag here (prompts).
  - Checkout branch / this commit; double-click a branch label checks it out. A conflict shows the toast "Checkout Failed – N conflict(s) prevents checkout. Commit, stash, or discard your changes first."
  - The graph refreshes after each action. Errors from git show as toasts.
  - Probe: logic (`git-data` action tests on temp fixture copies only) + ui.

- [ ] **Actions: cherry-pick and revert**
  - Cherry pick commit / N commits (in graph order, oldest first); revert commit.
  - On conflict: abort the operation, restore the previous state, and show a toast that names the commit.
  - Probe: logic (temp fixture copies, including a forced conflict) + ui.

- [ ] **Actions: reset**
  - Reset {current} to this commit ▸ Soft / Mixed / Hard. Hard asks for confirmation first.
  - Probe: logic (temp fixture copies; verify index and tree per mode).

- [ ] **Actions: merge and rebase**
  - Merge {ref} into {current}; Rebase {current} onto {ref}; Fast-forward when possible.
  - On conflict: abort (`merge --abort` / `rebase --abort`), restore the previous state, and show a toast.
  - Probe: logic (temp fixture copies, clean case and conflict case).

- [ ] **Actions: delete and rename refs, stash actions**
  - Ref names that are not valid UTF-8 arrive with U+FFFD and cannot be passed back to git: disable actions on them.
  - Delete branch (confirm; not the current branch), rename branch (prompt), delete tag locally.
  - Stash: apply, pop, delete (confirm), edit stash message.
  - Probe: logic (temp fixture copies) + ui.

- [ ] **Drag and drop branch labels** (§3.9)
  - Drag a label onto another label; the drop menu follows the relation rules in §3.9.
  - Probe: logic (drop-menu builder) + ui (drag in the browser).

- [ ] **Column header** (§1 Table, §3.10)
  - Right-click toggles Author, Date / Time, Sha columns; drag to reorder; drag dividers to resize; settings saved per repo.
  - Probe: ui.

- [ ] **Auto-refresh**
  - Watch the repo (`notify` crate) and refresh the graph on changes, debounced; ignore our own lock files. Keep the selection and scroll position across refreshes.
  - `log()` and `refs()` are separate git runs; make sure a refresh that lands between them cannot show a ref pointing at a commit missing from the log.
  - Probe: logic (watcher test on a temp repo) + app.

- [ ] **Performance on large repos**
  - Synthetic repo with 100 000 commits: initial load and layout time measured and recorded in the README; scrolling stays smooth. Move layout to a Web Worker if the main thread blocks.
  - Probe: logic (benchmark) + app.

## Deferred (not in this roadmap)

- AI items (Explain, Recompose).
- Cloud Patches and patch files.
- Worktrees.
- Push, pull, fetch, upstream, pull requests.
- Interactive rebase and interactive cherry-pick views.
- Staging, committing and the commit form.
- Conflict-resolution UI.
- Solo, Hide, Pin to Left.
- Windows and Linux packaging, auto-update, signing.
