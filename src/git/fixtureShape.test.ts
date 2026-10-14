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
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/demo-repo.json"), "utf8"),
) as Fixture;

function checkFiles(files: readonly FileChange[]) {
  for (const f of files) {
    expect(CHANGE_KINDS).toHaveProperty(f.kind);
    expect(typeof f.path).toBe("string");
    expect(f.oldPath === null || typeof f.oldPath === "string").toBe(true);
  }
}

describe("fixtures/demo-repo.json matches the generated types at run time", () => {
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
