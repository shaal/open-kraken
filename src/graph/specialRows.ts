/**
 * The WIP row and the stash rows (spec §1 Special rows). They take rows like
 * commits: the WIP row is newer than every commit and has HEAD's commit as its
 * parent; a stash row sits at the time the stash was made and has the commit
 * it was made on as its parent. As `special` rows they get their lanes after
 * the commits, so they never move a commit (refer to `LayoutInput` in lanes.ts),
 * and their edges are dotted.
 */

import type { ChangeKind } from "../git/bindings/ChangeKind";
import type { Commit } from "../git/bindings/Commit";
import type { GraphData } from "../git/bindings/GraphData";
import type { Stash } from "../git/bindings/Stash";
import type { WorkingTreeStatus } from "../git/bindings/WorkingTreeStatus";
import { isMergeCommit } from "./geometry";

/**
 * The WIP row's key in the layout (its `sha`). Commit ids are hex digits, so
 * this key cannot be one.
 */
export const WIP_KEY = "WIP";

/** How many changed paths the WIP row shows, by what happened to each one. */
export interface ChangeCounts {
  modified: number;
  added: number;
  deleted: number;
}

/** Uncommitted changes, drawn as the first row. */
export interface WipRow {
  kind: "wip";
  /** `WIP_KEY`, not a commit id. */
  sha: string;
  /** HEAD's commit, when HEAD has one (a new repository has none). */
  parents: string[];
  /** Newer than any commit, so the row is always the first one. */
  committerTime: number;
  special: true;
  changes: ChangeCounts;
}

/** One stash entry, drawn as a row joined to the commit it was made on. */
export interface StashRow {
  kind: "stash";
  /**
   * The stash's selector (`stash@{0}`), not a commit id: it is unique in the
   * stash list, and cannot clash with a commit in the log (a branch can point
   * at a stash commit).
   */
  sha: string;
  /** The commit the stash was made on. */
  parents: string[];
  /** When the stash was made. */
  committerTime: number;
  special: true;
  stash: Stash;
  /** The message as shown: git's "On <branch>: " prefix is left out. */
  subject: string;
}

/** One row of the graph. Only WIP and stash rows have a `kind`. */
export type GraphNode = Commit | WipRow | StashRow;

/** What a row's node looks like (spec §1 Nodes). */
export type NodeKind = "commit" | "merge" | "wip" | "stash";

export function nodeKind(node: GraphNode): NodeKind {
  if ("kind" in node) return node.kind;
  return isMergeCommit(node) ? "merge" : "commit";
}

/**
 * The rows to lay out: the commits, a WIP row when the work tree has changes,
 * and a row per stash. Without either, the log itself is returned.
 */
export function graphNodes(graph: GraphData): readonly GraphNode[] {
  const changes = countChanges(graph.status);
  const dirty = changes.modified + changes.added + changes.deleted > 0;
  if (!dirty && graph.stashes.length === 0) return graph.log;
  const nodes: GraphNode[] = [...graph.log];
  if (dirty) {
    const head = graph.refs.head.sha;
    nodes.push({
      kind: "wip",
      sha: WIP_KEY,
      parents: head === null ? [] : [head],
      committerTime: Number.POSITIVE_INFINITY,
      special: true,
      changes,
    });
  }
  for (const stash of graph.stashes) {
    nodes.push({
      kind: "stash",
      sha: stash.selector,
      parents: [stash.baseSha],
      committerTime: stash.time,
      special: true,
      stash,
      subject: stashSubject(stash.message),
    });
  }
  return nodes;
}

/**
 * The WIP row's counts. Each changed path counts once, by what happened to it
 * between HEAD and the work tree: added (new in the index, untracked, or
 * marked with `git add -N`),
 * deleted (gone from the work tree, or a staged deletion), else modified
 * (renames, type changes and conflicts too). A status that was not read has
 * no changes.
 */
export function countChanges(status: WorkingTreeStatus): ChangeCounts {
  const byPath = new Map<string, { staged?: ChangeKind; unstaged?: ChangeKind }>();
  const entry = (path: string) => {
    let found = byPath.get(path);
    if (!found) {
      found = {};
      byPath.set(path, found);
    }
    return found;
  };
  for (const file of status.staged) entry(file.path).staged = file.kind;
  for (const file of status.unstaged) entry(file.path).unstaged = file.kind;
  for (const file of status.conflicted) entry(file.path).unstaged = "conflicted";
  const counts: ChangeCounts = { modified: 0, added: 0, deleted: 0 };
  for (const { staged, unstaged } of byPath.values()) {
    // New: added or copied in the index, or only in the work tree (untracked,
    // or "added" for a file marked with `git add -N`).
    const newPath =
      staged === "added" ||
      staged === "copied" ||
      (staged === undefined && (unstaged === "untracked" || unstaged === "added"));
    const inHead = !newPath;
    const inWorkTree = unstaged !== "deleted" && !(staged === "deleted" && unstaged === undefined);
    if (!inHead) counts.added += 1;
    else if (!inWorkTree) counts.deleted += 1;
    else counts.modified += 1;
  }
  return counts;
}

/**
 * A stash message as the row shows it. `git stash push -m <message>` stores
 * "On <branch>: <message>", and GitKraken shows only <message> (spec §1). Branch
 * names cannot contain ":", so the prefix ends at the first ": ". Other
 * messages ("WIP on main: …") are kept whole.
 */
export function stashSubject(message: string): string {
  const match = /^On [^:]+: (.+)$/s.exec(message);
  return match?.[1] ?? message;
}
