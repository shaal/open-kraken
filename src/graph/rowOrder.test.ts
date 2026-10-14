import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../git/bindings/Fixture";
import { temporalTopologicalOrder, type OrderInput } from "./rowOrder";

type Node = OrderInput;

/**
 * Random histories: commit i may have parents among commits 0..i-1, so the
 * index order is a valid ancestry. `dates` decides committer times.
 */
function history(dates: "consistent" | "random") {
  return fc
    .array(
      fc.record({
        parentCount: fc.nat({ max: 5 }), // up to octopus merges
        picks: fc.array(fc.nat(), { minLength: 5, maxLength: 5 }),
        time: fc.integer({ min: 0, max: 50 }),
      }),
      { minLength: 1, maxLength: 60 },
    )
    .map((specs) =>
      specs.map((spec, i): Node => {
        const parents = new Set<string>();
        for (let k = 0; k < Math.min(spec.parentCount, i); k++) {
          parents.add(`c${(spec.picks[k] ?? 0) % i}`);
        }
        // Consistent: strictly newer than any earlier commit (so than its parents).
        const committerTime = dates === "consistent" ? i * 10 + (spec.time % 10) : spec.time;
        return { sha: `c${i}`, parents: [...parents], committerTime };
      }),
    );
}

function rows(order: readonly Node[]): Map<string, number> {
  return new Map(order.map((c, i) => [c.sha, i]));
}

/** Reorders `items` by random sort keys (any permutation can come out). */
function permuted<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i % keys.length] ?? 0, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((entry) => entry.item);
}
const sortKeys = fc.array(fc.integer(), { minLength: 60, maxLength: 60 });

const byDate = (a: Node, b: Node) =>
  b.committerTime - a.committerTime || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0);

describe("temporalTopologicalOrder", () => {
  it("puts every commit above all of its parents, whatever the dates", () => {
    fc.assert(
      fc.property(history("random"), (commits) => {
        const order = temporalTopologicalOrder(commits);
        const row = rows(order);
        for (const c of commits) {
          for (const p of c.parents) {
            expect(row.get(p)).toBeGreaterThan(row.get(c.sha) ?? Infinity);
          }
        }
      }),
    );
  });

  it("returns every commit exactly once", () => {
    fc.assert(
      fc.property(history("random"), (commits) => {
        const order = temporalTopologicalOrder(commits);
        expect(order.map((c) => c.sha).sort()).toEqual(commits.map((c) => c.sha).sort());
      }),
    );
  });

  it("does not depend on the input order", () => {
    fc.assert(
      fc.property(history("random"), sortKeys, (commits, keys) => {
        const a = temporalTopologicalOrder(commits).map((c) => c.sha);
        const b = temporalTopologicalOrder(permuted(commits, keys)).map((c) => c.sha);
        expect(b).toEqual(a);
      }),
    );
  });

  it("is plain newest-first date order when the dates agree with the history", () => {
    fc.assert(
      fc.property(history("consistent"), (commits) => {
        const order = temporalTopologicalOrder(commits).map((c) => c.sha);
        expect(order).toEqual([...commits].sort(byDate).map((c) => c.sha));
      }),
    );
  });

  it("is the (date, sha) order whenever that order already puts children first, ties included", () => {
    fc.assert(
      fc.property(history("random"), (commits) => {
        const dateOrder = [...commits].sort(byDate);
        const row = rows(dateOrder);
        const valid = commits.every((c) =>
          c.parents.every((p) => (row.get(p) ?? -1) > (row.get(c.sha) ?? Infinity)),
        );
        fc.pre(valid);
        expect(temporalTopologicalOrder(commits).map((c) => c.sha)).toEqual(
          dateOrder.map((c) => c.sha),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("visits children newest first", () => {
    // P is newest; its children are both older (skew). The newest child comes first.
    const commits: Node[] = [
      { sha: "P", parents: [], committerTime: 100 },
      { sha: "K1", parents: ["P"], committerTime: 10 },
      { sha: "K2", parents: ["P"], committerTime: 20 },
    ];
    expect(temporalTopologicalOrder(commits).map((c) => c.sha)).toEqual(["K2", "K1", "P"]);
  });

  it("lets the history win over the sha tie-break", () => {
    // Same date: "a" sorts first by sha, but it is the parent of "b".
    const commits: Node[] = [
      { sha: "a", parents: [], committerTime: 1 },
      { sha: "b", parents: ["a"], committerTime: 1 },
    ];
    expect(temporalTopologicalOrder(commits).map((c) => c.sha)).toEqual(["b", "a"]);
  });

  it("handles clock skew: a child dated before its parent still comes first", () => {
    const commits: Node[] = [
      { sha: "parent", parents: [], committerTime: 200 },
      { sha: "child", parents: ["parent"], committerTime: 100 },
      { sha: "unrelated", parents: [], committerTime: 150 },
    ];
    // The newest commit is placed as high as it can go: directly below its
    // (skewed) child, and above the older unrelated commit.
    expect(temporalTopologicalOrder(commits).map((c) => c.sha)).toEqual([
      "child",
      "parent",
      "unrelated",
    ]);
  });

  it("orders equal dates by sha", () => {
    const commits: Node[] = [
      { sha: "b", parents: [], committerTime: 1 },
      { sha: "a", parents: [], committerTime: 1 },
    ];
    expect(temporalTopologicalOrder(commits).map((c) => c.sha)).toEqual(["a", "b"]);
  });

  it("ignores parents that are not in the list, and repeated parents", () => {
    const commits: Node[] = [
      { sha: "x", parents: ["missing", "y", "y"], committerTime: 2 },
      { sha: "y", parents: [], committerTime: 1 },
    ];
    expect(temporalTopologicalOrder(commits).map((c) => c.sha)).toEqual(["x", "y"]);
  });

  it("rejects a sha that appears twice", () => {
    const twice: Node[] = [
      { sha: "a", parents: [], committerTime: 1 },
      { sha: "a", parents: [], committerTime: 2 },
    ];
    expect(() => temporalTopologicalOrder(twice)).toThrow(/duplicate/);
  });

  it("handles an empty list", () => {
    expect(temporalTopologicalOrder([])).toEqual([]);
  });

  it("matches the row order GitKraken showed for the demo repo", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), "fixtures/demo-repo.json"), "utf8"),
    ) as Fixture;
    const subjects = temporalTopologicalOrder(fixture.graph.log).map((c) => c.subject);
    expect(subjects).toEqual([
      "Update roadmap",
      "Highlight branch on hover",
      "Add metrics endpoint",
      "Merge branch 'release/1.1'",
      "Prepare 1.1 release notes",
      "Add context menu on commits",
      "Draw commit lanes",
      "Add health endpoint",
      "Scaffold graph view",
      "Merge branch 'feature/login'",
      "Add regression test for crash",
      "Add remember-me option",
      "Fix typo in docs",
      "Validate email field",
      "Add login form",
      "Guard against null config",
      "Document setup steps",
      "Add build script",
      "Initial commit",
    ]);
  });

  it("orders 100 000 commits without overflowing the stack", () => {
    // One long chain plus a side branch every 1 000 commits, dates reversed (worst skew).
    const commits: Node[] = [];
    for (let i = 0; i < 100_000; i++) {
      const parents = i === 0 ? [] : [`m${i - 1}`];
      commits.push({ sha: `m${i}`, parents, committerTime: 100_000 - i });
      if (i % 1000 === 500) {
        commits.push({ sha: `s${i}`, parents: [`m${i}`], committerTime: 0 });
      }
    }
    const started = performance.now();
    const order = temporalTopologicalOrder(commits);
    const ms = performance.now() - started;
    expect(order).toHaveLength(commits.length);
    const row = rows(order);
    expect(row.get("m99999")).toBeLessThan(row.get("m0") ?? 0);
    expect(row.get("s500")).toBeLessThan(row.get("m500") ?? 0);
    expect(ms).toBeLessThan(2000);
  });
});
