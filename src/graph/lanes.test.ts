import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../git/bindings/Fixture";
import { LANE_COLOR_COUNT, laneColor, layoutGraph, type GraphLayout, type Segment } from "./lanes";
import type { OrderInput } from "./rowOrder";

type Node = OrderInput;

/**
 * Random histories: merges, octopus merges, many roots, clock skew, and some
 * parents that are not in the list (as when history is filtered).
 */
const histories = fc
  .array(
    fc.record({
      parentCount: fc.nat({ max: 4 }),
      picks: fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
      missing: fc.nat({ max: 9 }),
      time: fc.integer({ min: 0, max: 40 }),
    }),
    { minLength: 1, maxLength: 80 },
  )
  .map((specs) =>
    specs.map((spec, i): Node => {
      const parents: string[] = [];
      for (let k = 0; k < Math.min(spec.parentCount, i); k++) {
        parents.push(`c${(spec.picks[k] ?? 0) % i}`);
      }
      if (spec.missing === 0) parents.unshift(`gone${i}`); // a first parent outside the list
      return { sha: `c${i}`, parents, committerTime: spec.time };
    }),
  );

const RUNS = { numRuns: 400 };

const line = (segments: readonly Segment[], lane: number) =>
  segments.find((s) => s.kind === "line" && s.lane === lane) as
    Extract<Segment, { kind: "line" }> | undefined;
const hasElbow = (segments: readonly Segment[], from: number, to: number, toward: "up" | "down") =>
  segments.some((s) => s.kind === "elbow" && s.from === from && s.to === to && s.toward === toward);

function leavesBottom(segments: readonly Segment[], lane: number): boolean {
  return (
    line(segments, lane)?.bottom === true ||
    segments.some((s) => s.kind === "elbow" && s.to === lane && s.toward === "down")
  );
}
function entersTop(segments: readonly Segment[], lane: number): boolean {
  return (
    line(segments, lane)?.top === true ||
    segments.some((s) => s.kind === "elbow" && s.to === lane && s.toward === "up")
  );
}

function laneBySha(layout: GraphLayout<Node>): Map<string, number> {
  return new Map(layout.rows.map((r) => [r.commit.sha, r.lane]));
}

describe("layoutGraph", () => {
  it("draws lines that continue across every row boundary", () => {
    fc.assert(
      fc.property(histories, (commits) => {
        const layout = layoutGraph(commits);
        const n = layout.rows.length;
        for (let r = 0; r + 1 < n; r++) {
          const here = layout.segmentsAt(r);
          const below = layout.segmentsAt(r + 1);
          for (let lane = 0; lane < layout.laneCount; lane++) {
            expect(leavesBottom(here, lane)).toBe(entersTop(below, lane));
          }
        }
        for (let lane = 0; lane < layout.laneCount; lane++) {
          expect(entersTop(layout.segmentsAt(0), lane)).toBe(false);
          expect(leavesBottom(layout.segmentsAt(n - 1), lane)).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it("traces every edge in its own lane, from the child's node to the parent's node", () => {
    fc.assert(
      fc.property(histories, (commits) => {
        const layout = layoutGraph(commits);
        for (const edge of layout.edges) {
          const childLane = layout.rows[edge.childRow]?.lane ?? -1;
          const parentLane = layout.rows[edge.parentRow]?.lane ?? -1;
          const start = layout.segmentsAt(edge.childRow);
          if (edge.lane === childLane) expect(line(start, childLane)?.bottom).toBe(true);
          else expect(hasElbow(start, childLane, edge.lane, "down")).toBe(true);
          for (let r = edge.childRow + 1; r < edge.parentRow; r++) {
            const cell = line(layout.segmentsAt(r), edge.lane);
            expect(cell?.top && cell.bottom).toBe(true);
          }
          const end = layout.segmentsAt(edge.parentRow);
          if (edge.lane === parentLane) expect(line(end, parentLane)?.top).toBe(true);
          else expect(hasElbow(end, parentLane, edge.lane, "up")).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("never passes an edge through another node, or shares a lane between edges to different commits", () => {
    fc.assert(
      fc.property(histories, (commits) => {
        const { rows, edges } = layoutGraph(commits);
        for (const edge of edges) {
          for (let r = edge.childRow + 1; r < edge.parentRow; r++) {
            expect(rows[r]?.lane).not.toBe(edge.lane);
          }
        }
        for (const a of edges) {
          for (const b of edges) {
            if (a === b || a.lane !== b.lane) continue;
            if (Math.max(a.childRow, b.childRow) < Math.min(a.parentRow, b.parentRow)) {
              expect(a.parentRow).toBe(b.parentRow); // they join toward the same commit
            }
          }
        }
      }),
      RUNS,
    );
  });

  it("goes straight down from a node only to its first parent", () => {
    fc.assert(
      fc.property(histories, (commits) => {
        const layout = layoutGraph(commits);
        const rowOf = new Map(layout.rows.map((r, i) => [r.commit.sha, i]));
        for (const [r, row] of layout.rows.entries()) {
          const straight = line(layout.segmentsAt(r), row.lane)?.bottom === true;
          const first = row.commit.parents[0];
          const firstInList = first !== undefined && rowOf.has(first);
          expect(straight).toBe(firstInList);
          for (const edge of layout.edges) {
            if (edge.childRow !== r || edge.lane !== row.lane) continue;
            expect(edge.parentRow).toBe(rowOf.get(first ?? ""));
          }
        }
      }),
      RUNS,
    );
  });

  it("keeps first-parent links straight except where a fork ends a branch", () => {
    fc.assert(
      fc.property(histories, (commits) => {
        const layout = layoutGraph(commits);
        const lane = laneBySha(layout);
        const shas = new Set(commits.map((c) => c.sha));
        for (const child of commits) {
          const parent = child.parents[0];
          if (parent === undefined || !shas.has(parent)) continue;
          if (lane.get(parent) === lane.get(child.sha)) continue;
          // Bent link: the parent is a fork, continuing a branch child further left.
          const branchChildren = commits.filter((c) => c.parents[0] === parent);
          const leftmost = Math.min(...branchChildren.map((c) => lane.get(c.sha) ?? Infinity));
          expect(branchChildren.length).toBeGreaterThan(1);
          expect(lane.get(parent)).toBe(leftmost);
          expect(leftmost).toBeLessThan(lane.get(child.sha) ?? -1);
        }
      }),
      RUNS,
    );
  });

  it("stays within the reported width and does not depend on input order", () => {
    fc.assert(
      fc.property(
        histories,
        fc.array(fc.integer(), { minLength: 80, maxLength: 80 }),
        (commits, keys) => {
          const layout = layoutGraph(commits);
          for (const [r, row] of layout.rows.entries()) {
            expect(row.lane).toBeLessThan(layout.laneCount);
            const lineLanes = layout
              .segmentsAt(r)
              .flatMap((seg) => (seg.kind === "line" ? [seg.lane] : []));
            expect(lineLanes).toEqual([...lineLanes].sort((x, y) => x - y)); // sorted by lane
            for (const s of layout.segmentsAt(r)) {
              for (const l of s.kind === "line" ? [s.lane] : [s.from, s.to]) {
                expect(l).toBeLessThan(layout.laneCount);
              }
            }
          }
          const shuffled = commits
            .map((c, i) => ({ c, k: keys[i] ?? 0, i }))
            .sort((x, y) => x.k - y.k || x.i - y.i)
            .map((x) => x.c);
          const again = layoutGraph(shuffled);
          const picture = (l: GraphLayout<Node>) =>
            l.rows.map((row, r) => [row.commit.sha, row.lane, l.segmentsAt(r)]);
          expect(picture(again)).toEqual(picture(layout));
        },
      ),
    );
  });

  it("reproduces the lanes and edges GitKraken showed for the demo repo", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), "fixtures/demo-repo.json"), "utf8"),
    ) as Fixture;
    const layout = layoutGraph(fixture.graph.log);
    expect(layout.laneCount).toBe(3);
    expect(layout.rows.map((r) => `${r.lane} ${r.commit.subject}`)).toEqual([
      "0 Update roadmap",
      "1 Highlight branch on hover",
      "0 Add metrics endpoint",
      "0 Merge branch 'release/1.1'",
      "2 Prepare 1.1 release notes",
      "1 Add context menu on commits",
      "1 Draw commit lanes",
      "0 Add health endpoint",
      "1 Scaffold graph view",
      "0 Merge branch 'feature/login'",
      "2 Add regression test for crash",
      "1 Add remember-me option",
      "0 Fix typo in docs",
      "1 Validate email field",
      "1 Add login form",
      "2 Guard against null config",
      "0 Document setup steps",
      "0 Add build script",
      "0 Initial commit",
    ]);
    const at = (subject: string) => {
      const r = layout.rows.findIndex((row) => row.commit.subject === subject);
      return layout.segmentsAt(r);
    };
    // Merges go right then down into the merged lane; forks go right then up.
    // Their horizontal runs cross lane 1, as in GitKraken (spec §1 Edges).
    for (const [subject, toward] of [
      ["Merge branch 'release/1.1'", "down"],
      ["Add health endpoint", "up"],
    ] as const) {
      const segments = at(subject);
      expect(hasElbow(segments, 0, 2, toward)).toBe(true);
      expect(line(segments, 1)).toEqual({ kind: "line", lane: 1, top: true, bottom: true });
    }
    expect(hasElbow(at("Merge branch 'feature/login'"), 0, 1, "down")).toBe(true);
    expect(hasElbow(at("Merge branch 'feature/login'"), 0, 1, "up")).toBe(true);
    expect(at("Initial commit")).toEqual([{ kind: "line", lane: 0, top: true, bottom: false }]);
  });

  it("draws an elbow to the left when the target lane is on the left", () => {
    // main is merged into feature (lane 1), then feature is merged back into main.
    const commits: Node[] = [
      { sha: "back", parents: ["main1", "f2"], committerTime: 6 },
      { sha: "main1", parents: ["main0"], committerTime: 5 },
      { sha: "f2", parents: ["f1", "main0"], committerTime: 4 },
      { sha: "f1", parents: ["root"], committerTime: 3 },
      { sha: "main0", parents: ["root"], committerTime: 2 },
      { sha: "root", parents: [], committerTime: 0 },
    ];
    const layout = layoutGraph(commits);
    const lane = laneBySha(layout);
    expect([lane.get("main1"), lane.get("f2")]).toEqual([0, 1]);
    const f2Row = layout.rows.findIndex((r) => r.commit.sha === "f2");
    // f2 (lane 1) merges main0, whose lane 0 is already waiting for it: go left, then down.
    expect(hasElbow(layout.segmentsAt(f2Row), 1, 0, "down")).toBe(true);
  });

  it("does not draw straight down to a merged parent when the first parent is missing", () => {
    const commits: Node[] = [
      { sha: "m", parents: ["gone", "q"], committerTime: 2 },
      { sha: "q", parents: [], committerTime: 1 },
    ];
    const layout = layoutGraph(commits);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 1]);
    expect(hasElbow(layout.segmentsAt(0), 0, 1, "down")).toBe(true);
    expect(line(layout.segmentsAt(0), 0)).toBeUndefined();
  });

  it("lets two merges of the same commit share one lane", () => {
    const commits: Node[] = [
      { sha: "m2", parents: ["main1", "side"], committerTime: 5 },
      { sha: "main1", parents: ["m1"], committerTime: 4 },
      { sha: "m1", parents: ["main0", "side"], committerTime: 3 },
      { sha: "main0", parents: ["root"], committerTime: 2 },
      { sha: "side", parents: ["root"], committerTime: 1 },
      { sha: "root", parents: [], committerTime: 0 },
    ];
    const layout = layoutGraph(commits);
    expect(layout.laneCount).toBe(2);
    const merges = layout.edges.filter((e) => layout.rows[e.parentRow]?.commit.sha === "side");
    expect(merges.map((e) => e.lane)).toEqual([1, 1]);
  });

  it("colors lanes from the palette", () => {
    expect(laneColor(0)).toBe(0);
    expect(laneColor(LANE_COLOR_COUNT + 2)).toBe(2);
  });

  it("lays out 100 000 commits quickly with a bounded width", () => {
    // A main line with a short side branch merged back every 100 commits.
    const commits: Node[] = [];
    let previous: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const base = previous;
      let last = base;
      for (let k = 0; k < 99; k++) {
        const sha = `b${i}-${k}`;
        commits.push({ sha, parents: last ? [last] : [], committerTime: i * 100 + k });
        last = sha;
      }
      const merge = `m${i}`;
      commits.push({
        sha: merge,
        parents: base ? [base, last ?? ""] : [last ?? ""],
        committerTime: i * 100 + 99,
      });
      previous = merge;
    }
    const started = performance.now();
    const layout = layoutGraph(commits);
    const ms = performance.now() - started;
    expect(layout.rows).toHaveLength(100_000);
    expect(layout.laneCount).toBeLessThanOrEqual(3);
    expect(ms).toBeLessThan(3000);
  });

  it("handles wide histories without materializing every pass-through line", () => {
    // 200 long-lived branches side by side for 20 000 rows (4 000 000 lane cells).
    const commits: Node[] = [];
    const tips: string[] = [];
    const root = "root";
    commits.push({ sha: root, parents: [], committerTime: 0 });
    for (let b = 0; b < 200; b++) tips.push(root);
    for (let i = 0; i < 20_000; i++) {
      const b = i % 200;
      const sha = `w${i}`;
      commits.push({ sha, parents: [tips[b] ?? root], committerTime: i + 1 });
      tips[b] = sha;
    }
    const started = performance.now();
    const layout = layoutGraph(commits);
    const ms = performance.now() - started;
    expect(layout.laneCount).toBe(200);
    expect(ms).toBeLessThan(3000);
    // Rendering one screen of rows touches only those rows.
    const visible = performance.now();
    for (let r = 10_000; r < 10_060; r++) layout.segmentsAt(r);
    expect(performance.now() - visible).toBeLessThan(100);
    expect(layout.segmentsAt(10_000).filter((s) => s.kind === "line")).toHaveLength(200);
  });
});
