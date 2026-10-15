import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangeKind } from "./bindings/ChangeKind";
import type { FileChange } from "./bindings/FileChange";
import type { Fixture } from "./bindings/Fixture";
import type { RefKind } from "./bindings/RefKind";

// Exhaustive at compile time: adding a variant in Rust breaks these until updated.
const CHANGE_KINDS: Record<ChangeKind, true> = {
  added: true,
  modified: true,
  deleted: true,
  renamed: true,
  copied: true,
  typeChanged: true,
  untracked: true,
  conflicted: true,
};
const REF_KINDS: Record<RefKind, true> = { localBranch: true, remoteBranch: true, tag: true };

// Vitest runs from the repository root.
const load = (name: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), `fixtures/${name}.json`), "utf8")) as Fixture;
const fixture = load("demo-repo");
const edge = load("edge-repo");

function checkFiles(files: readonly FileChange[]) {
  for (const f of files) {
    expect(CHANGE_KINDS).toHaveProperty(f.kind);
    expect(typeof f.path).toBe("string");
    expect(f.oldPath === null || typeof f.oldPath === "string").toBe(true);
  }
}

describe.each([
  ["demo-repo", fixture],
  ["edge-repo", edge],
])("fixtures/%s.json matches the generated types at run time", (_, fixture) => {
  it("commits", () => {
    for (const c of fixture.graph.log) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
      for (const p of c.parents) expect(p).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isInteger(c.authorTime)).toBe(true);
      expect(Number.isInteger(c.committerTime)).toBe(true);
      expect(Number.isInteger(c.authorTzOffset)).toBe(true);
      expect(typeof c.subject).toBe("string");
    }
  });

  it("refs, head, stashes", () => {
    for (const r of fixture.graph.refs.refs) {
      expect(REF_KINDS).toHaveProperty(r.kind);
      expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(["branch", "detached"]).toContain(fixture.graph.refs.head.type);
    for (const s of fixture.graph.stashes) {
      expect(Number.isInteger(s.time)).toBe(true);
      expect(s.selector).toBe(`stash@{${s.index}}`);
    }
  });

  it("file lists", () => {
    checkFiles(fixture.graph.status.staged);
    checkFiles(fixture.graph.status.unstaged);
    checkFiles(fixture.graph.status.conflicted);
    for (const files of Object.values(fixture.commitFiles)) checkFiles(files ?? []);
    for (const files of Object.values(fixture.rangeFiles)) checkFiles(files ?? []);
    expect(Object.keys(fixture.commitFiles).sort()).toEqual(
      fixture.graph.log.map((c) => c.sha).sort(),
    );
    // Every stored selection is of commits in the log, so the UI can ask for it.
    const shas = new Set(fixture.graph.log.map((c) => c.sha));
    for (const key of Object.keys(fixture.rangeFiles)) {
      for (const sha of key.split(",")) expect(shas.has(sha), `${sha} in ${key}`).toBe(true);
    }
  });
});

describe("fixtures/edge-repo.json", () => {
  it("has the cases the demo repo lacks", () => {
    const { refs, status } = edge.graph;
    expect(refs.head.type).toBe("detached");
    expect(refs.refs.filter((r) => r.upstream !== null).map((r) => r.shortName)).toEqual([
      "feature/graph-view",
      "feature/login",
      "main",
    ]);
    expect(refs.refs.filter((r) => r.annotated).map((r) => r.shortName)).toEqual(["v1.2"]);
    // A committed rename and a staged one.
    const renamed = Object.values(edge.commitFiles)
      .flat()
      .filter((f) => f?.kind === "renamed")
      .map((f) => `${f?.oldPath} -> ${f?.path}`);
    expect(renamed).toEqual(["build.sh -> make.sh"]);
    expect(status.staged).toEqual([{ path: "guide.md", oldPath: "docs.md", kind: "renamed" }]);
    // The demo repo's commits are all still there, with the same shas.
    const shas = new Set(edge.graph.log.map((c) => c.sha));
    expect(fixture.graph.log.every((c) => shas.has(c.sha))).toBe(true);
  });
});

describe("fixtures/demo-repo.json", () => {
  it("holds the two-commit selections of §4 by their real commits", () => {
    const sha = (subject: string) => fixture.graph.log.find((c) => c.subject === subject)?.sha;
    const files = (a: string, b: string) => {
      const key = [sha(a), sha(b)].sort().join(",");
      return (fixture.rangeFiles[key] ?? []).map((f) => `${f.kind} ${f.path}`).sort();
    };
    expect(files("Update roadmap", "Add metrics endpoint")).toEqual(["modified README.md"]);
    expect(files("Fix typo in docs", "Add login form")).toEqual([
      "added docs.md",
      "deleted login.js",
    ]);
  });

  it("holds the spec's 9-commit Shift+click range with GitKraken's file list (§2, §4)", () => {
    const nine = Object.entries(fixture.rangeFiles).find(([key]) => key.split(",").length === 9);
    expect(nine).toBeDefined();
    const summary = (nine?.[1] ?? []).map((f) => `${f.kind} ${f.path}`).sort();
    expect(summary).toEqual([
      "added CHANGELOG.md",
      "added api.js",
      "added docs.md",
      "added login.js",
      "modified README.md",
    ]);
  });
});
