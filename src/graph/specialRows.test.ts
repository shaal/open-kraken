import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangeKind } from "../git/bindings/ChangeKind";
import type { Commit } from "../git/bindings/Commit";
import type { Fixture } from "../git/bindings/Fixture";
import type { GraphData } from "../git/bindings/GraphData";
import type { WorkingTreeStatus } from "../git/bindings/WorkingTreeStatus";
import { layoutGraph } from "./lanes";
import {
  WIP_KEY,
  countChanges,
  graphNodes,
  nodeKind,
  stashSubject,
  type GraphNode,
  type StashRow,
  type WipRow,
} from "./specialRows";

const load = (name: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), `fixtures/${name}.json`), "utf8")) as Fixture;
const demo = load("demo-repo").graph;
const edge = load("edge-repo").graph;

const CLEAN: WorkingTreeStatus = { staged: [], unstaged: [], conflicted: [], skipped: null };

function commit(sha: string, parents: string[], time: number): Commit {
  return {
    sha,
    parents,
    authorName: "A",
    authorEmail: "a@example.com",
    authorTime: time,
    authorTzOffset: 0,
    committerTime: time,
    subject: sha,
  };
}

const wipOf = (nodes: readonly GraphNode[]) =>
  nodes.find((n): n is WipRow => "kind" in n && n.kind === "wip");
const stashesOf = (nodes: readonly GraphNode[]) =>
  nodes.filter((n): n is StashRow => "kind" in n && n.kind === "stash");

describe("graphNodes", () => {
  it("adds a WIP row on HEAD and a row per stash on its base commit (demo repo)", () => {
    const nodes = graphNodes(demo);
    expect(nodes).toHaveLength(demo.log.length + 2);
    expect(nodes.slice(0, demo.log.length)).toEqual(demo.log);
    const head = demo.refs.head.sha;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(wipOf(nodes)).toEqual({
      kind: "wip",
      sha: WIP_KEY,
      parents: [head],
      committerTime: Number.POSITIVE_INFINITY,
      special: true,
      changes: { modified: 1, added: 1, deleted: 0 }, // README.md, untracked notes.txt
    });
    const [stash] = demo.stashes;
    expect(stashesOf(nodes)).toEqual([
      {
        kind: "stash",
        sha: "stash@{0}",
        parents: [stash?.baseSha],
        committerTime: stash?.time,
        special: true,
        stash,
        subject: "WIP: experiment with caching", // git stores "On main: WIP: …"
      },
    ]);
    expect(stash?.message).toBe("On main: WIP: experiment with caching");
  });

  it("joins the WIP row to a detached HEAD, and counts a staged rename as modified", () => {
    const nodes = graphNodes(edge);
    expect(edge.refs.head.type).toBe("detached");
    const wip = wipOf(nodes);
    expect(wip?.parents).toEqual([edge.refs.head.sha]);
    expect(wip?.changes).toEqual({ modified: 2, added: 1, deleted: 0 });
  });

  it("returns the log itself when the tree is clean and there are no stashes", () => {
    const graph: GraphData = { ...demo, status: CLEAN, stashes: [] };
    expect(graphNodes(graph)).toBe(graph.log);
  });

  it("has no WIP row when the working tree was not read", () => {
    const graph: GraphData = { ...demo, status: { ...CLEAN, skipped: "filters" } };
    const nodes = graphNodes(graph);
    expect(wipOf(nodes)).toBeUndefined();
    expect(stashesOf(nodes)).toHaveLength(1);
  });

  it("gives the WIP row no parent when HEAD has no commit (a new repository)", () => {
    const graph: GraphData = {
      log: [],
      refs: {
        head: { type: "branch", name: "refs/heads/main", shortName: "main", sha: null },
        refs: [],
      },
      status: { ...CLEAN, staged: [{ path: "a.txt", oldPath: null, kind: "added" }] },
      stashes: [],
    };
    const nodes = graphNodes(graph);
    expect(nodes).toHaveLength(1);
    expect(wipOf(nodes)?.parents).toEqual([]);
    const layout = layoutGraph(nodes);
    expect(layout.rows.map((r) => [r.commit.sha, r.lane])).toEqual([[WIP_KEY, 0]]);
    expect(layout.segmentsAt(0)).toEqual([]);
  });

  it("keeps the WIP row first, even above commits dated in the far future", () => {
    const graph: GraphData = {
      ...demo,
      log: [commit("aa", ["bb"], Number.MAX_SAFE_INTEGER), commit("bb", [], 1)],
      refs: { ...demo.refs, head: { type: "detached", sha: "bb" } },
      stashes: [],
    };
    const layout = layoutGraph(graphNodes(graph));
    expect(layout.rows.map((r) => r.commit.sha)).toEqual([WIP_KEY, "aa", "bb"]);
  });

  it("does not clash with a commit in the log that is also a stash commit", () => {
    // A branch can point at a stash commit; the log then has it as a commit.
    const [stash] = demo.stashes;
    if (!stash) throw new Error("the demo has a stash");
    const graph: GraphData = {
      ...demo,
      log: [...demo.log, commit(stash.sha, [stash.baseSha], stash.time)],
    };
    const layout = layoutGraph(graphNodes(graph));
    const keys = layout.rows.map((r) => r.commit.sha);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(stash.sha);
    expect(keys).toContain(stash.selector);
  });

  it("gives every stash its own row, also several on one commit", () => {
    const [stash] = demo.stashes;
    if (!stash) throw new Error("the demo has a stash");
    const graph: GraphData = {
      ...demo,
      stashes: [0, 1, 2].map((index) => ({
        ...stash,
        index,
        selector: `stash@{${index}}`,
        time: stash.time - index,
      })),
    };
    const layout = layoutGraph(graphNodes(graph));
    const stashRows = layout.rows.filter((r) => nodeKind(r.commit) === "stash");
    expect(stashRows.map((r) => r.commit.sha)).toEqual(["stash@{0}", "stash@{1}", "stash@{2}"]);
    expect(new Set(stashRows.map((r) => r.lane)).size).toBe(3);
  });
});

describe("countChanges", () => {
  const status = (
    staged: [string, ChangeKind][],
    unstaged: [string, ChangeKind][] = [],
    conflicted: string[] = [],
  ): WorkingTreeStatus => ({
    staged: staged.map(([path, kind]) => ({ path, oldPath: null, kind })),
    unstaged: unstaged.map(([path, kind]) => ({ path, oldPath: null, kind })),
    conflicted: conflicted.map((path) => ({ path, oldPath: null, kind: "conflicted" })),
    skipped: null,
  });
  const kind = (s: WorkingTreeStatus) => {
    const counts = countChanges(s);
    const kinds = Object.entries(counts).filter(([, n]) => n > 0);
    expect(kinds.map(([, n]) => n)).toEqual([1]); // one path, counted once
    return kinds[0]?.[0];
  };

  it("counts each path once, by what happened to it between HEAD and the work tree", () => {
    const cases: [WorkingTreeStatus, string][] = [
      [status([], [["f", "modified"]]), "modified"],
      [status([["f", "modified"]]), "modified"],
      [status([["f", "modified"]], [["f", "modified"]]), "modified"],
      [status([], [["f", "untracked"]]), "added"],
      [status([], [["f", "added"]]), "added"], // `git add -N`: ".A" in porcelain v2
      [status([["f", "added"]]), "added"],
      [status([["f", "copied"]]), "added"],
      [status([["f", "added"]], [["f", "modified"]]), "added"],
      [status([["f", "added"]], [["f", "deleted"]]), "added"], // still new in the index
      [status([], [["f", "deleted"]]), "deleted"],
      [status([["f", "deleted"]]), "deleted"],
      [status([["f", "modified"]], [["f", "deleted"]]), "deleted"],
      [status([["f", "renamed"]], [["f", "deleted"]]), "deleted"],
      [status([["f", "deleted"]], [["f", "untracked"]]), "modified"], // `git rm --cached`
      [status([["f", "renamed"]]), "modified"],
      [status([["f", "renamed"]], [["f", "modified"]]), "modified"],
      [status([["f", "typeChanged"]]), "modified"],
      [status([], [], ["f"]), "modified"],
    ];
    for (const [s, expected] of cases) {
      expect([JSON.stringify(s), kind(s)]).toEqual([JSON.stringify(s), expected]);
    }
  });

  it("adds up several paths, and is zero for a clean or unread tree", () => {
    const s = status(
      [
        ["a", "added"],
        ["b", "deleted"],
        ["c", "modified"],
      ],
      [
        ["c", "modified"],
        ["d", "untracked"],
        ["e", "deleted"],
      ],
      ["f"],
    );
    expect(countChanges(s)).toEqual({ modified: 2, added: 2, deleted: 2 });
    expect(countChanges(CLEAN)).toEqual({ modified: 0, added: 0, deleted: 0 });
    expect(countChanges({ ...CLEAN, skipped: "filters" })).toEqual({
      modified: 0,
      added: 0,
      deleted: 0,
    });
  });
});

describe("stashSubject", () => {
  it("leaves out git's 'On <branch>: ' prefix of a stash pushed with a message", () => {
    expect(stashSubject("On main: WIP: experiment with caching")).toBe(
      "WIP: experiment with caching",
    );
    expect(stashSubject("On feature/a-b: fix: it")).toBe("fix: it");
    expect(stashSubject("On (no branch): detached work")).toBe("detached work");
    expect(stashSubject("On main: two\nlines")).toBe("two\nlines");
  });

  it("keeps other messages whole", () => {
    expect(stashSubject("WIP on main: 3588393 Update roadmap")).toBe(
      "WIP on main: 3588393 Update roadmap",
    );
    expect(stashSubject("On main: ")).toBe("On main: ");
    expect(stashSubject("On main:x")).toBe("On main:x");
    // Branch names cannot contain ":", so this is not git's prefix.
    expect(stashSubject("On a:b: c")).toBe("On a:b: c");
    expect(stashSubject("")).toBe("");
  });
});

describe("nodeKind", () => {
  it("tells commits, merges, WIP and stash rows apart", () => {
    const nodes = graphNodes(demo);
    const kinds = nodes.map(nodeKind);
    expect(kinds.filter((k) => k === "merge")).toHaveLength(2);
    expect(kinds.filter((k) => k === "commit")).toHaveLength(17);
    expect(kinds.slice(-2)).toEqual(["wip", "stash"]);
  });
});
