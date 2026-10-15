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

- [x] **git-data: working tree and stashes**
  - `status(repo)`: staged and unstaged files with change type (modified, added, deleted, renamed, untracked). Parse `git status --porcelain=v2 -z`.
  - `stashes(repo)`: index, message, stash commit sha, base commit sha.
  - `log()` must also include each stash's base commit, so a stash row always has a commit to connect to (§1), even when no branch contains it.
  - `commit_files(repo, sha)`: changed files of one commit (first parent; root commit vs empty tree). `range_files(repo, shas)` for a multi-selection.
  - Probe: logic (fixture repo: README.md modified, notes.txt untracked, 1 stash).

- [x] **Tauri commands, TS types, data adapters**
  - Tauri commands for every `git-data` reader. Shared TS types.
  - Adapter interface in `src/`; Tauri adapter; fixture adapter that loads `fixtures/demo-repo.json`.
  - A dump tool (`cargo run -p git-data --bin dump -- <repo>`) writes that JSON; a script rebuilds the demo repo and regenerates the JSON.
  - Open a repo from a CLI argument or a folder dialog. Show a typed error for a non-repo.
  - Serialize `GitError` with a `kind` the UI can switch on; for `NotRepositoryRoot`, offer to open the root.
  - Measure the IPC cost of `log()`: 100 000 commits are about 14 MB of git output and 24 MB of JSON. Page or stream it if one call is too slow (or record the number for the Performance task).
  - Probe: logic (adapter tests) + app (open the demo repo, see the commit count).

## Layout

- [x] **Layout: row order** (§6.1)
  - Pure TS. Temporal topological sort: depth-first, started from commits sorted newest-first by committer date.
  - Properties: every parent row is below all its children; result is deterministic for any input order; equals committer-date order when that order is already valid; clock skew handled.
  - Probe: logic (Vitest + fast-check property tests; the fixture repo order).

- [x] **Layout: lanes, edges, colors** (§6.2–6.4, §1 Edges)
  - Pure TS. Lanes wait for a commit: a commit's lane waits for its first parent; a merge reserves (or joins) a lane for each other parent; a commit takes the leftmost lane waiting for it as a first parent, else as a merged parent, else the first empty slot, else appends; slots are cleared, never removed. (Chosen over Vigier's forbidden columns: it reproduces GitKraken's demo-repo lanes.)
  - Output per row: node lane, pass-through lanes, and edge segments (vertical, fork elbow, merge elbow) with lane colors.
  - Properties: no edge passes through another node; a first-parent link stays in its lane except at a fork (only the leftmost branch continues); lanes never shift.
  - Probe: logic (property tests on random DAGs; fixture snapshot).

## Graph view

- [x] **Graph table with virtualization** (§1 Table)
  - Columns: Branch / Tag, Graph, Commit message. Constant row height. Header row with a gear icon.
  - Rows virtualized with `@tanstack/react-virtual`. 50 000 synthetic commits scroll without frame drops in the browser.
  - Probe: ui (fixture adapter; DOM row count stays bounded while scrolling; screenshot).
  - Done, with open items below. In a browser, `?synthetic=<count>` serves a generated history (1 to 1 000 000 commits, with refs). `scripts/perf/scroll-bench.js` scrolls with real wheel events (every 16 ms) and first checks that it detects injected stalls, a long frame and blank rows; each run fails unless the graph really scrolled. Production build (`pnpm build && pnpm preview`), headless Chrome 155, 1280×800, 50 000 commits: 35–45 rows in the DOM; every visible row was in the DOM at every animation frame (main-thread state; pixels not sampled); 1–3 ms of main-thread work per frame (3–5 ms with the CPU 4× slower). Late frames (1.5 frame periods or more after the previous one) per 300 frames, across runs: 0–1 at 140 px per event and at 2800 px per event (about 100 rows per event); with the CPU 4× slower, 0–3 and 0–6.
  - WebKit (Playwright's WebKit 2227, the Safari 26 engine, headless at 30 frames per second; run from a scratch harness with playwright-core 1.57.0 and the same in-page recorder): 35–45 rows in the DOM; no late or blank frames at 140 or 2800 px per wheel event; the list moves on 93 % of frames; Tab reaches the rows and Page Down scrolls them; 1 000 000 commits (28 000 000 px) scroll to the last row.
  - Open: in headless Chrome the list position changes on only about 49 % of frames (main-thread view). This matches Chrome, not our code: a hand-written list that writes new row text in its scroll handler also gets 47 %; moving rows without new text gets 70 %, as does a static text list; an empty scroller gets 93 %. Overscan 10 to 80 (35 to 185 rows in the DOM) changes nothing, and WebKit moves the same list on 93 % of frames. Turning off the virtualizer's `flushSync` gives 64 % in Chrome but blank rows at 2800 px per event, so it stays on.
  - Open: headless WebKit sometimes stops responding during long fast wheel scrolling (its content process then sleeps at 0 % CPU, so this is not a script loop). Over 5 interleaved rounds it stopped for the app 2 times, a static text list with no script 2 times, a hand-written list 1 time and an empty scroller 0 times (the app also stopped in 3 earlier runs). So it follows text painting in this environment (an older WebKit build on a newer macOS, screen locked), not our code. Check in the Tauri window (WKWebView), which is not measured yet.
  - Open: in some early runs, the first wheel run had one late frame of 44–167 ms. It did not come back in later runs from a new browser, with long-frame attribution on.

- [x] **Graph lanes rendering** (§1 Nodes, Edges and lanes)
  - Per-row slices (SVG at first; now one canvas for the rows in the DOM, see below): lane lines, orthogonal edges with rounded 90° elbows, node avatar circle with lane-colored ring (identicon from the email hash, no network requests), merge commits as small solid dots.
  - Row streak in the lane color between node and message; thin lane-colored bar at the left of the message cell.
  - Probe: ui (screenshot of the fixture graph; DOM checks for node kinds).
  - Done. `traceSegment` (geometry.ts) traces lines and rounded elbows (`arcTo`); `drawGraphRows` draws the rows in the DOM on one canvas (`GraphCanvas`), lines first in palette order, then the nodes; identicons are our own 5 × 5 mirrored pattern from an FNV-1a hash of the email, with cell edges on device pixels at pixel ratios of 1 and above (at ratios such as 1.25 the cells alternate by one device pixel in size); the streak and the message bar are CSS per row. The demo repo matches GitKraken's lanes and elbows (our screenshot compared with `~/Desktop/gk-shots/03-demo-tab.png`, taken while using GitKraken normally: main 0, graph-view and login 1, release and bugfix 2; merges across then down, forks across then up; 2 merge dots, 17 avatars, 6 elbows). Rows carry `data-node-kind` and the Graph cell an `aria-label` ("Merge commit" / "Commit").
  - Why a canvas: an SVG per row was built first (that build was replaced and is not kept in the tree). `scripts/perf/scroll-bench.js` as committed here, production build, headless Chrome, 50 000 commits, both builds run in turn: at 140 px per wheel event both had 0–2 late frames per 300; at 2800 px per event with the CPU 4× slower, the SVG build had 76–80 late frames and 8.5–8.7 ms of main-thread work per frame, the canvas build 4 and 4.5–5 ms. The canvas build across 9 runs at full speed (one by a reviewer): 0–1 late frames per 300, no blank rows, 0.8–2.5 ms per frame, the same as the table task's baseline; with the CPU 4× slower, 0–2 late frames at 140 px and 0–4 at 2800 px per event.
  - Open: the 22nd lane and beyond do not fit the 480 px maximum of the Graph column and are cut off (with 16 px lanes, 29 lanes fitted). The column header task (column resizing) owns the fix; a horizontal scroll or narrower lanes past a limit are options.
  - Device pixel ratio: a page loaded at ratio 2 (Chrome emulation) gets a 2× canvas and draws sharp lines and faces (screenshot checked). The bitmap is a whole number of device pixels and its CSS box is sized to match. A resize re-renders at the current ratio at once, also when going back to an earlier ratio (seen in Chrome emulation). Every render reads the current ratio, so a scroll after a change draws at the new one (seen in Chrome emulation at ratios from 1 to 3). Open: when only the ratio changes, Chrome's headless emulation sends no resize, media query or ResizeObserver signal, so the canvas keeps the old ratio until the next render; check a real display change in the Tauri window.

- [x] **Ref labels column** (§1 Ref labels)
  - Pills in the lane color with a connector line to the node; laptop / cloud / both / tag icons; `✓` on the checked-out branch; `+N` badge for extra refs; truncation with `…` and the full name on hover.
  - A ref whose commit is missing from the log (refs and log are separate reads) is skipped, not an error.
  - The graph canvas covers only the Graph column and paints above the rows: draw a connector in the Branch / Tag cell up to the column edge and on the canvas from the edge to the node, and keep an expanded label above the canvas.
  - The demo fixture has no upstreams, annotated tags, renames or detached HEAD: extend `scripts/update-fixture.sh` (or add a second fixture) to cover them in the browser.
  - Probe: ui.
  - Done. `buildRefLabels` (refLabels.ts) builds the pills of every commit once per load; the rules not seen in GitKraken (upstream matching, ref order, the detached "HEAD" pill) are marked `[choice]` in §1. The Branch / Tag cell shows the first pill and a `+N` badge, then a line to the column edge; `drawGraphRows` continues the line to the node, under the lanes. The demo repo gets GitKraken's labels (compared with `~/Desktop/gk-shots/03-demo-tab.png`).
  - Hover: a copy of the label at full width (up to the table's right edge) is drawn after the canvas (`.ref-overlay`). The copy takes no pointer events, so presses, drags and text selection reach the row under it (a version where the copy took the pointer broke drag selection in Chrome and WebKit). The hover lasts while the pointer is inside the copy's box: a label's mouseleave, a mouse move, and a scroll each check the pointer against that box (Chrome sends no mouse move when rows scroll under a still pointer). A row that leaves the DOM drops its hover. Checked with real input in Chrome and WebKit: one mount and no unmount along the expanded name, gone past its end; a wheel scroll moves the hover to the label now under the pointer, or ends it; a drag from a label selects from that row.
  - Edge-case fixture: `fixtures/edge-repo.json` (`?fixture=edge` in a browser), built by `scripts/update-fixture.sh` from the demo repo plus upstreams (one with another name), an annotated and two lightweight tags on one commit, a remote-only branch, a long name, a committed and a staged rename, and a detached HEAD at main's tip. The demo repo and its SHAs do not change. The script now ignores the caller's git config and git environment for every git run, the dumps included (a global mailmap changed author names before). Two runs, a run with a hostile global config, a run under `/bin/bash` 3.2, and a run on Linux (git 2.47, Docker) give the same two files.
  - Fixed in passing: `scripts/update-fixture.sh` looked up "Update roadmap" with `:/Update roadmap`, which on git 2.56 (and on CI) found the stash's index commit ("index on main: … Update roadmap"), and on git 2.47 the real commit. The demo fixture held that selection under a commit the log does not have. The lookups are now anchored (`:/^…`); fixtureShape.test.ts checks that every stored selection is of commits in the log.
  - Checked in headless Chrome at pixel ratios 1, 1.25, 1.5, 1.75 and 2: the cell's line and the canvas line join on the same device pixel rows (identical pixels at 1, 1.5 and 2; at 1.25 and 1.75 the edge rows are shaded differently, because the canvas starts on a half device pixel). The long name is cut off (its text is 364 px wide in a 118 px box) and the hover copy shows all of it. WebKit (playwright-core 1.57.0 with webkit-2227): the same labels, cut-off and hover. White label text has a contrast of 4.5:1 or more for every lane color (palette.test.ts).
  - Scroll bench (production build, 50 000 commits, which have 7 labels in the first view): at full speed 0–1 late frames per 300 and 1.4–2.8 ms of main-thread work per frame (4 runs, the last on the final code). With the CPU 4× slower at 2800 px per event, in 9 rounds interleaved with a build of `main`: 2–12 late frames for this build and 1–13 for `main`, 4.7–6.2 ms per frame for both (the machine load was 3.7–5.7, so the spread is noise).

- [ ] **WIP and stash rows** (§1 Special rows)
  - WIP row at the top only when the tree is dirty: dashed hollow node, message cell placeholder `// WIP`, change counts.
  - Stash rows: dotted square node, dotted connector to the base commit.
  - Draw these nodes and connectors in `drawGraphRows`; its `GraphContext` needs `setLineDash` for dashed and dotted strokes.
  - Probe: ui (fixture has both).

## Interaction

- [ ] **Selection and keyboard navigation** (§2, §5, §7)
  - Click selects; click on the only selected commit clears; Cmd+click toggles; Shift+click selects `rev-list newer --not older^@`.
  - Keys: ↑/↓ and K/J (rows), ←/→ and H/L (lanes), Shift+↑/↓ (along the branch), ⌘↑/⌘↓ (first/last). Keep the selection in view.
  - Acceptance: the fixture case `Validate email field` → Shift+click `Update roadmap` selects exactly the 9 commits listed in §2.
  - Probe: logic (selection reducer tests) + ui.

- [ ] **Hover effects** (§2)
  - Row hover highlight and full-message tooltip; ghost label of the nearest containing branch on hover and on selection.
  - Branch-label hover expands the pill and fades messages of commits not on that branch (nodes and edges do not fade). The expansion is done (Ref labels task: `hovered` in CommitGraph); add the fade.
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
  - Baseline from the Tauri task (debug build, one `graph_data` call, measured by the frontend): 100 000 commits load in about 2.0 s (1.85–2.13 s over 3 runs); the 19-commit demo repo in about 210 ms, mostly process starts (about 12 git runs, and `Repo::open` runs twice). Candidates: cache the open `Repo`, page or stream the log, a compact encoding.
  - Scrolling baseline and its open items: refer to "Graph table with virtualization" above (`scripts/perf/scroll-bench.js`). Re-run it after the lanes rendering task.
  - Since the table task, "Loaded in" (and the open log line) also includes the layout; the log line gives the layout time separately. The baseline above is one `graph_data` call without layout.
  - Rows are 28 px, so 1 000 000 commits are 28 000 000 px tall. Chrome and WebKit (Safari 26 engine) scroll that to the last row; engines limit element heights at some tens of millions of px, so check WebKitGTK (Linux) before very large repositories, and scale the scroll range if its limit is lower.
  - Probe: logic (benchmark) + app.

- [ ] **Repository trust**
  - A repository's own `.git/config` can make reads run programs. Since the Tauri task: `core.fsmonitor` is forced off; `status()` is skipped (with a reason) when the repository's local/worktree config defines filter drivers; submodule work trees are not read (`--ignore-submodules=dirty`), so no git runs inside a submodule.
  - Add the trust prompt: ask before reading the working tree of a repository whose config defines filters (remember the answer per repository); trusted repositories get full status, including uncommitted changes inside submodules. Look for other config that can run programs during the reads we do (for example `log.showSignature` → `gpg.program`, already forced off).
  - Probe: logic (a repository whose config sets a clean filter that writes a marker file: no marker before trust).

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
