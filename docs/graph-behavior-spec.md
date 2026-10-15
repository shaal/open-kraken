# Commit graph: behavior spec

Target behavior for the open-kraken commit graph, modeled on GitKraken Desktop.
Observed on GitKraken Desktop **12.6.0** (2026-10-14) with a synthetic demo repo
(5 branches, 2 merges, 2 tags, 1 stash, a remote, uncommitted changes).
Rebuild that repo with `docs/fixtures/make-demo-repo.sh <repo-dir> <origin-dir>` (two new directories; their parents must exist). It gives the same SHAs on every run and platform; `docs/fixtures/verify-demo-repo.sh` checks that. Use it to compare open-kraken against this spec.

## Source policy (clean room)

- No GitKraken code, type definitions, styles or bundles are read or copied.
  The graph package (`@gitkraken/gitkraken-components`) license forbids reverse
  engineering and building similar software from it.
- Behavior comes only from public GitKraken help pages and from screenshots of
  normal app use.
- Code references must have a license checked first. GPL sources
  (`pvigier/gitamine`, git `graph.c`, gitk) are read as prose/ideas only.
- Screenshots of GitKraken stay out of this repo.

| Tag | Meaning |
|---|---|
| `[obs]` | Observed in GitKraken 12.6.0 by normal use (screenshot) |
| `[docs]` | Public GitKraken help page |
| `[choice]` | open-kraken design decision, not observed in GitKraken |

In menu labels, `{current}` is the checked-out branch, `{ref}` the clicked branch or tag, `{sha}` a short SHA.

## 1. Layout and visuals `[obs]`

### Table

- Columns: **Branch / Tag**, **Graph**, **Commit message**. Optional: Author, Date / Time, Sha.
- A gear icon sits at the right end of the header row.
- One commit per row, newest at the top. Row height is constant.
- Row order: two rows that are adjacent on screen can be on different lanes. ↑/↓ follow row order. For movement across lanes or along a branch, refer to section 5.

### Special rows

- **WIP row** (top, only with uncommitted changes): dashed hollow circle node in the current branch color, joined to HEAD's commit by a dotted line. The message cell is an inline text input with placeholder `// WIP`, and has no lane-colored bar. Change counts follow it (`✎ 1  + 1` = 1 modified, 1 added; the untracked `notes.txt` counts as added).
- **Stash row**: dotted square node with a stash (tray) icon, joined to its base commit by a dotted line: down from the square, then a rounded elbow across into the base commit's node. Message = stash message without git's `On <branch>: ` prefix (`On main: WIP: experiment with caching` reads `WIP: experiment with caching`).
- Inside both nodes is the background color: lines and the row streak do not show through.
- Demo repo: the WIP row in lane 0 (main's), the stash row under it in lane 1, then `Update roadmap` (HEAD) in lane 0 and `Highlight branch on hover` in lane 1.

Choices for cases the demo repo does not show `[choice]`:
- Both rows take rows like commits (section 6): the WIP row is newer than every commit, with HEAD's commit as its parent; a stash row sits at the time the stash was made, with its base commit as its parent. Their lanes are chosen after all the commits' lanes, so they never move or recolor a commit: the leftmost lane that is free from the row down to the parent, else a new lane. "Free" means no node or line in that lane on those rows, and no elbow turning into it there, also in the parent's row (so the dotted turn never hides under the parent's own merge line); in the parent's row, the parent's own lane counts as free. When the parent's lane is free above it, it is the leftmost free one: nothing waited for the parent there, so the parent took the first empty lane, and every lane left of it carries a line through the row above the parent. The line then runs straight into the parent's node. The demo repo comes out as observed.
- So a WIP or stash row can be in another lane than its parent, joined by a dotted elbow into the parent's node (as the observed stash is). It then takes that lane's color: the current branch's color only when it is in HEAD's lane, as in the demo.
- No WIP row when the working tree was not read (`skipped`, refer to "Repository trust" in ROADMAP.md). A WIP row with no HEAD commit (a new repository) has no line; neither has a stash whose base commit is not in the history read.
- The counts: each changed path counts once, by what happened to it between HEAD and the work tree: added (new in the index, untracked, or marked with `git add -N`), deleted (gone from the work tree, or a staged deletion), else modified (renames, type changes and conflicts too). A deleted count shows `−` in red. A count of zero is not shown (observed: no deleted count in the demo). The repository summary's "N changed files" counts the same way.
- The `// WIP` input is drawn, but cannot be typed in: it comes with the commit form, which this roadmap defers.
- A stash message keeps git's text when it has no `On <branch>: ` prefix (`WIP on main: 3588393 Update roadmap`), or nothing after it. The tooltip is git's whole message.

### Nodes

- Normal commit: circular author avatar with a ring in the lane color.
- Merge commit: small solid dot in the lane color, no avatar.
- WIP: dashed hollow circle. Stash: dotted square.

### Edges and lanes

- Each lane has one color. The color stays the same along the whole lane.
- Edges are **orthogonal with rounded elbows**: vertical in a lane, horizontal across lanes, with a rounded 90° corner. No diagonals.
- Fork: from the parent node, go right, then turn up into the child lane.
- Merge: from the merge dot, go right, then turn down into the merged lane.
- When the target lane is on the left, the elbow goes left instead (for example when `main` is merged into a feature branch). `[choice]`
- An elbow's horizontal run may cross other lanes' lines: in the demo repo the release merge and the release fork both cross lane 1. `[obs]`
- Each row has a translucent "streak" in the lane color between the node and the message column.
- The message cell has a thin vertical bar on its left edge, in the commit's lane color.

### Ref labels (Branch / Tag column)

- A pill in the lane color, joined to its node by a thin horizontal line. The pill and the line of the checked-out commit are brighter. `[obs]`
- Icons in the pill: a laptop for a local branch, a cloud for a remote branch, both when local and remote point to the same commit, and a tag icon for a tag. `✓` marks the checked-out branch.
- A local branch and a remote branch with the same name (`x` and `origin/x`) on one commit share one pill with both icons. `[obs]` The demo repo sets no upstreams, so the match is probably by name (an inference, implemented as a `[choice]` below).
- A remote branch without such a local branch shows its name without the remote: `origin/main` reads "main" with a cloud. `[obs]`
- Several refs on one commit: one pill plus a `+N` badge. `+N` counts pills, not refs: a local branch with its remote counts once (observed: `bugfix/crash-on-start` with its remote had no badge; `release/1.1` with the tag `v1.1` had `+1`).
- Long names are cut off with `…`. Hovering a pill shows the full name.
- **Ghost label**: a selected or hovered commit with no ref shows a faded pill of its nearest containing branch.

Choices for cases the demo repo does not show `[choice]`:
- A remote branch joins a local branch at the same commit when it is that branch's upstream, even with another name, or else when it has the same name on its remote. The upstream match comes first. Each remote branch joins one local branch at most: when several branches track it, the one with its name, else the checked-out one, else the first by name.
- A remote-only pill drops its remote unless another ref on the same commit would then read the same: `origin/x` beside `up/x`, or `origin/v1.1` beside a tag `v1.1`, stay whole.
- Order of the refs on one commit (the first is the pill, the rest are the `+N`): a detached HEAD, the checked-out branch, other local branches, remote-only branches, tags. Each group is sorted by name, in code-unit order. Observed: `release/1.1` was shown before the tag `v1.1`.
- A detached HEAD gets its own "HEAD" pill with `✓`. No branch gets the `✓` then, even one at the same commit. The `✓` goes to the checked-out branch only where HEAD points: refs and HEAD are separate reads and can disagree after a commit lands between them.
- Hovering a label draws it at its full width, brighter, above the graph, but not past the right edge of the table (there it is cut off with `…`). The tooltip lists the full names (`origin/main`); the `+N` badge's tooltip lists the other refs.
- A ref whose commit is not in the history read (refs and history are separate reads) gets no label.

## 2. Interactions

| Gesture | Target | Result | Evidence |
|---|---|---|---|
| Hover | Commit row | Light row highlight, ghost label of the nearest branch, tooltip with the full message | `[obs]` |
| Hover | Branch label | The pill expands to the full name. Messages of commits not on that branch fade; graph nodes and edges do not fade | `[obs]` |
| Click | Commit | Selects the row (full-width highlight). Right panel shows commit details (section 4) | `[obs]` |
| Click | The commit that is already selected | Clears the selection. The right panel hides | `[obs]` |
| Click | WIP row | Right panel shows unstaged/staged files and the commit form | `[obs]` |
| Shift+click | Commit | Selects the git range `older^..newer` (reachable from the newer commit, minus everything reachable from the older commit's parents). **This is not the row range.** Commits that are not ancestors of the newer end are skipped, even when their rows sit between the two ends. Example: `Validate email field` → `Update roadmap` selected 9 commits through a merge and skipped the unmerged `feature/graph-view` and `bugfix` commits | `[obs]` |
| Cmd/Ctrl+click | Commit | Adds a commit to the selection. Commits do not need to be adjacent or on the same lane | `[obs]` |
| ↑ / ↓ | With a selection | Moves the selection one row (full list in section 5) | `[obs]` |
| Double-click | Commit row | **No checkout** (observed with a clean tree and with a dirty one). The help page says it checks out the ghost branch. Inference, not confirmed: it acts as two clicks (select, then clear), which matches the click-toggle row above | `[obs]` vs `[docs]` |
| Double-click | Ghost label | No checkout | `[obs]` |
| Double-click | Branch label | Checks out that branch. If local changes conflict, a toast appears: **"Checkout Failed – 1 conflict prevents checkout. Commit, stash, or discard your changes first."** | `[obs]` |
| Right-click | Any target | Native OS context menu (section 3). Right-click **does not change the selection** (see 3.0). Exception: right-click on the WIP row selects WIP and focuses its message input | `[obs]` |
| Drag | Branch label onto another label | Drop menu (section 3.9) | `[obs]` |
| Drag | Column header / divider | Reorder / resize; saved per repository | `[docs]` |

## 3. Context menus `[obs]`

All menus are native OS menus. `---` marks a separator. `▸` marks a submenu. The menu content depends on the target, the selection, and the ancestry.

### 3.0 Menu scope rule

- If the target is **in** the current selection, the menu acts on the whole selection (3.3).
- If the target is **outside** the selection, the menu acts on that target only. The selection and the right panel stay the same.
- When a multi-selection is active somewhere else, a branch-label menu leaves out `Cherry pick commit`, `Create patch from commit`, and `Share commit as Cloud Patch` (observed once; compare 3.5).

### 3.1 Commit with no ref (single)

```
Checkout this commit
---
Create worktree from this commit
---
Create branch here
Cherry pick commit
Rebase {current} onto this commit
Reset {current} to this commit ▸
Revert commit
---
Copy commit sha
Create patch from commit
Share commit as Cloud Patch
---
Compare commit against working directory
---
Create tag here
Create annotated tag here
```

### 3.1b Commit on the checked-out branch, below HEAD

The menu is the same as 3.1. Between `Revert commit` and `Copy commit sha`, it adds this history-editing group (`{sha}` = the clicked commit):

```
---
Recompose commit with AI (Preview)
Recompose N children of {sha} with AI (Preview)
Interactive Rebase N children of {sha}
Edit commit message
Drop commit
Move commit up
```

### 3.2 Reset submenu

```
Soft - keep all changes
Mixed - keep working copy but reset in…
Hard - discard all changes
```

The screenshot cuts off the "Mixed" label. It probably ends "reset index".

### 3.3 Multi-selection (N commits)

The menu is the same as 3.1, with these changes:

- `Cherry pick N commits`
- `Create patch from commits`
- `Share commits as Cloud Patch`. When the commits are not adjacent, this item is disabled and reads `Share commits as Cloud Patch (Commits are not adjacent)`.

**Squash** gating is still an open question. Two cases were observed:

- **Shown:** 2 adjacent commits on the checked-out branch, and the range included HEAD (HEAD and its parent).
- **Not shown:** 3 commits on `feature/graph-view`, which was not checked out.

The demo repo cannot tell "on the checked-out branch" apart from "the range ends at HEAD". The help pages list these prerequisites:
- More than one commit.
- One ancestor-descendant line.
- The commits are consecutive.
- The oldest commit has a parent.

One GitKraken learn page also requires that the youngest commit is HEAD. In the "Shown" case, the history group from 3.1b becomes:

```
Recompose 2 commits with AI (Preview)
Recompose N children of {sha} with AI (Preview)
Interactive Rebase N children of {sha}
Squash 2 commits
Drop 2 commits
```

When the commits are on a branch that is not checked out, there is no Squash item (3 commits on `feature/graph-view`).

Right panel header (count-based):
- Exactly 2 commits: "Viewing diff between 2 commits".
- 3 or more commits: "Viewing diff of N commits", with one combined diff.

### 3.4 Commit that has a ref

Right-clicking the row of a commit that has a branch shows **that branch's menu** (3.5 or 3.6), not the plain commit menu.

### 3.5 Local branch label (not checked out)

Captured with one commit selected. Items marked `*` are left out when a multi-selection is active elsewhere (3.0).

```
Pull (fast-forward if possible)
Push
Set Upstream
---
Merge {ref} into {current}
Rebase {current} onto {ref}
---
Checkout ▸                  → {ref} | this commit
---
Create worktree from ▸      → {ref} | this commit
---
Create branch here
Cherry pick commit *
Reset {current} to this commit ▸
Revert commit
---
Explain Branch Changes (Preview)
---
Rename {ref}
Delete {ref}
---
Copy branch name
Copy commit sha
Create patch from commit *
Share commit as Cloud Patch *
---
Pin to Left
Solo
---
Compare commit against working directory
---
Create tag here
Create annotated tag here
```

### 3.6 Remote branch label (`origin/main`, which `main` already contains)

```
Rebase {current} onto origin/main
Interactive Rebase {current} onto origin/main
---
Checkout ▸
---
Create worktree from ▸
---
Create branch here
Reset {current} to this commit ▸
Revert commit
---
Recompose N children of {sha} with AI (Preview)
Interactive Rebase N children of {sha}
---
Push {current} and start a pull request to origin/main
Explain Branch Changes (Preview)
---
Delete origin/main
---
Copy branch name
Copy commit sha
---
Pin to Left
Solo
---
Compare commit against working directory
---
Create tag here
Create annotated tag here
```

### 3.7 Tag label

```
Push {tag} to origin
---
Fast-forward {tag} to {current}
Merge {current} into {tag}
Rebase {current} onto {tag}
---
Checkout this commit
---
Create worktree from this commit
---
Explain Branch Changes (Preview)
---
Create branch here
Reset {current} to this commit ▸
Revert commit
---
Delete {tag} locally
---
Copy tag name
---
Solo
---
Annotate {tag}
```

### 3.8 WIP row / stash row

WIP: `Explain working changes (Preview)`. A right-click also focuses the inline WIP message input.

Stash:

```
Apply Stash
Pop Stash
Delete Stash
---
Edit stash message
---
Share stash as Cloud Patch
---
Hide
```

### 3.9 Drop menu (drag a branch label onto another label)

The items depend on how the two branches relate. Three cases were observed (`main` is checked out):

| Drag | Relation | Menu |
|---|---|---|
| `feature/graph-view` → `main` | unmerged branch onto the current one | `Merge feature/graph-view into main` · `Rebase feature/graph-view onto main` · `Interactive Rebase feature/graph-view onto main` |
| `main` → `feature/graph-view` | current branch onto an unmerged one | `Merge main into feature/graph-view` · `Rebase main onto feature/graph-view` · `---` · `Reset main to this commit ▸` |
| `feature/login` → `main` | dragged branch already contained in target | `Fast-forward feature/login to main` · `Merge main into feature/login` · `Rebase feature/login onto main` |

Rule that fits all three:
- Merge and rebase name the dragged branch as the source: "Merge {dragged} into {target}" and "Rebase {dragged} onto {target}".
- When the dragged branch is an ancestor of the target, a merge in that direction would do nothing. The menu then offers `Fast-forward {dragged} to {target}` and turns the merge around.

### 3.10 Column header

```
✓ Branch / Tag
✓ Graph
✓ Commit message
  Author
  Date / Time
  Sha
---
Compact Graph Column
Smart Branch Visibility
---
Reset columns to default layout
Reset columns to compact layout
```

## 4. Right panel after a click `[obs]`

- **Commit**:
  - Banner "N file changes in working directory" with a **View Changes** button.
  - `commit: {sha}` and an AI button: **Explain commit** for a commit not on the current branch, **Recompose commit with AI ▾** for HEAD.
  - The message box.
  - Author avatar, name, "authored {date} @ {time}", and `parent: {sha}`.
  - A change summary ("1 modified"), a Path / Tree toggle, and a "View all files" checkbox.
  - The file list with change-type icons.
- **WIP**:
  - Header "N file changes on {current}" and a discard (trash) button.
  - Unstaged files with **Stage All Changes**, then Staged files.
  - The commit form: summary, description, and "Amend previous commit".
  - The **Stage Changes to Commit** button.
- **Multi-selection**: "N commits selected" and a list of the selected commits (message, date, author, SHA), then the combined file list. `[obs]` The file list depends on the count:
  - Exactly 2 commits: the difference between the two, from the older to the newer. Example: `Fix typo in docs` + `Add login form` → docs.md added, login.js deleted. `Update roadmap` + its parent `Add metrics endpoint` → README.md modified only.
  - 3 or more: one combined diff to the newest commit, from the first parent of the oldest selected commit on the newest commit's first-parent line, so that commit's own changes count. Examples: `Scaffold graph view` … `Add context menu on commits` → graph.js added. The 9-commit Shift+click range of §2 (`Validate email field` … `Update roadmap`) → README.md modified; api.js, CHANGELOG.md, docs.md, login.js added (the base is the parent of `Fix typo in docs`, the oldest selected commit on main's first-parent line; `Validate email field` is not on it).
  - `git-data`'s `range_files` implements this. "Older" and "newer" follow ancestry (a parent is always older than its child, whatever the dates say); unrelated commits go by commit date.

## 5. Keyboard shortcuts `[obs]`

Copied from the in-app Keyboard Shortcuts panel. Only ↑/↓ were tested; the other keys are as the panel lists them. The panel opens with ⌘/ (or the keyboard icon in the status bar) and has a filter (⌘F). The graph-related entries:

| Action | Keys |
|---|---|
| Select previous / next item | ↑ or K / ↓ or J |
| Select item to the right / left (across lanes) | → or L / ← or H |
| Select next / previous item in branch | Shift+↓ or Shift+J / Shift+↑ or Shift+K |
| Select first / last item | ⌘↑ / ⌘↓ |
| Undo / Redo | ⌘Z / ⌘Y or ⌘⇧Z |
| Search commits | ⌘F |
| Command palette | ⌘P |
| Create branch | ⌘B |
| Fetch all | ⌘L |
| Toggle left panel / commit details panel | ⌘J / ⌘K |
| Stage / unstage current file | S / U |
| Stage all / unstage all | ⌘⇧S / ⌘⇧U |
| Commit / stage all + commit (in message input) | ⌘Return / ⌘⇧Return |
| Focus commit message | ⌘⇧M |
| File history / blame search | ⌘⇧H |
| Close view | Escape |

## 6. Layout algorithm `[choice]`

Rows follow the prose description in Pierre Vigier, "Commit graph drawing algorithms" (2019). Lanes reserve a merged parent's lane at the merge (as `git log --graph` does) instead of Vigier's forbidden columns, because that reproduces the lanes GitKraken showed for the demo repo (Vigier's rule swaps two rows of it). Do not copy gitamine code (GPL-3.0).

1. **Rows:** a temporal topological sort. Depth-first topological order, started from commits sorted newest-first by committer date. Every parent sits below its children, even with clock skew. Equal dates are ordered by sha, so the result never depends on the input order; the history still wins over that tie-break (a child is always above its parent). With skew, the newest commit is placed as high as it can go: directly below its skewed children. When the dates agree with the history, the result is plain newest-first date order, which is the order GitKraken showed for the demo repo. Implemented in `src/graph/rowOrder.ts`.
2. **Child kinds:** a child whose first parent is the commit is a *branch child*; any other child is a *merge child*.
3. **Columns:** scan rows top to bottom. Each lane is empty or *waits* for one commit below.
   - A commit's own lane waits for its first parent, so a branch is a straight line.
   - At a merge, each other parent gets a lane at once: a lane already waiting for that parent (the edges join), else the first empty lane other than the merge's own, else a new lane. (A merge whose first parent is missing keeps its own lane empty, so nothing runs straight down from it.)
   - A commit takes the leftmost lane waiting for it as a first parent (a branch child's lane); else a lane waiting for it as a merged parent; else the first empty lane, else a new lane. The other lanes waiting for it end at it.
   - Lanes are emptied, never removed, so lane numbers never shift. A waiting lane belongs to one commit, so no edge passes through another node.
4. **Edges:** an edge runs from the child's row to the parent's row in one lane. It leaves the child straight down when it runs in the child's lane, else with an elbow (merge: across, then down); it reaches the parent straight when it runs in the parent's lane, else with an elbow (fork: across from the parent, then up). Each lane has one color (`lane % 8`); an elbow takes the color of the lane the edge runs in. Implemented in `src/graph/lanes.ts`; the demo repo comes out in GitKraken's lanes (main 0; graph-view and login 1; release and bugfix 2). Guarantees: no edge passes through another node; two edges share a lane only when they lead to the same commit (they join); a node's straight-down line is always its first parent (a missing first parent leaves it empty); a commit with no parents and no children in the list has no line at all; a first-parent link bends only at a fork, where every branch but the leftmost ends with an elbow.

Apache-2.0 code reference, if needed: `dolthub/commit-graph`.

## 7. Rendering and state `[choice]`

- Virtualize rows (`@tanstack/react-virtual` or `react-window`, both MIT).
- Draw the lane segments, nodes and elbows of the rows in the DOM on one canvas that sits in the scrolling content (so it moves with the rows), and redraw it in the same frame as the rows. The streak and the message bar are CSS on each row. An SVG per row was measured first and was slower; the numbers are in ROADMAP.md, "Graph lanes rendering".
- Selection = a set of SHAs plus an anchor SHA.
  - Shift+click: order the two ends by row. The selection is `rev-list newer --not older^@`.
  - Cmd+click: toggle one SHA.
  - Plain click on the only selected SHA: clear the selection and hide the details panel.
  - Keyboard: row order (↑↓), lane order (←→), and branch order (Shift+↑↓). See section 5.
  - Right-click: never change the selection. Pick the menu scope by rule 3.0.
- Use the OS-native context menu (Electron `Menu` or Tauri menu). Build it from (target kind, selection, ancestry relation to `{current}`), and disable items with a reason suffix when a precondition fails.

## Out of scope / not observed

- Squash gating: is it "on the checked-out branch" or "the range ends at HEAD"? Refer to 3.3.
- The views that open after an action: interactive rebase, interactive cherry-pick, AI recompose, and merge conflict resolution.
- A small relative-date pill ("a year ago") at the right edge of the graph. Its purpose is not confirmed; it may be a scroll-position date marker.
- Windows/Linux modifier keys. All observations are from macOS.

## Sources

- GitKraken Desktop help: [Interface](https://help.gitkraken.com/gitkraken-desktop/interface/), [Branching and merging](https://help.gitkraken.com/gitkraken-desktop/branching-and-merging/), [Hiding and soloing](https://help.gitkraken.com/gitkraken-desktop/hiding-and-soloing/), [Cherry-pick](https://help.gitkraken.com/gitkraken-client/cherrypick/)
- Pierre Vigier, [Commit graph drawing algorithms](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html)
