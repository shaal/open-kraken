import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Fixture } from "../git/bindings/Fixture";
import {
  LANE_COLOR_COUNT,
  laneColor,
  layoutGraph,
  type GraphLayout,
  type LayoutInput,
  type Segment,
} from "./lanes";
import type { OrderInput } from "./rowOrder";
import { graphNodes, WIP_KEY } from "./specialRows";

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

/** The lines in `lane`, joined: a node lane can have one line per half. */
function line(segments: readonly Segment[], lane: number) {
  const lines = segments.filter((s) => s.kind === "line" && s.lane === lane);
  if (lines.length === 0) return undefined;
  return {
    top: lines.some((s) => s.kind === "line" && s.top),
    bottom: lines.some((s) => s.kind === "line" && s.bottom),
  };
}
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

function laneBySha(layout: GraphLayout<LayoutInput>): Map<string, number> {
  return new Map(layout.rows.map((r) => [r.commit.sha, r.lane]));
}

/**
 * The random histories with special rows: some commits marked special (with a
 * child or a merged parent they are placed like commits), and up to 4 rows that
 * no row has as a parent, on a random commit or on none, as WIP and stash rows
 * are; some of them newer than every commit.
 */
const specialHistories = histories.chain((commits) =>
  fc
    .record({
      flags: fc.array(fc.boolean(), { minLength: commits.length, maxLength: commits.length }),
      extra: fc.array(
        fc.record({
          parent: fc.nat(),
          none: fc.nat({ max: 5 }),
          time: fc.oneof(fc.integer({ min: 0, max: 40 }), fc.constant(Infinity)),
        }),
        { maxLength: 4 },
      ),
    })
    .map(({ flags, extra }) => [
      ...commits.map((c, i): LayoutInput => (flags[i] ? { ...c, special: true } : c)),
      ...extra.map((e, k): LayoutInput => ({
        sha: `s${k}`,
        parents: e.none === 0 ? [] : [`c${e.parent % commits.length}`],
        committerTime: e.time,
        special: true,
      })),
    ]),
);

/** Either kind of random history. */
const anyHistories = fc.oneof(histories, specialHistories);

/** The special rows `layoutGraph` places after the others (refer to `LayoutInput`). */
function deferredShas(rows: readonly LayoutInput[]): Set<string> {
  const shas = new Set(rows.map((c) => c.sha));
  const isParent = new Set(rows.flatMap((c) => c.parents));
  const deferred = rows.filter((c) => {
    if (c.special !== true || isParent.has(c.sha)) return false;
    const [first, ...others] = c.parents;
    return !others.some((p) => p !== first && shas.has(p));
  });
  return new Set(deferred.map((c) => c.sha));
}

const NONE = 0;
const DOTTED = 1;
const SOLID = 2;

/**
 * What row `r` should draw, worked out edge by edge from `layout.edges`: each
 * piece (a node lane's top or bottom half, a lane passed through, an elbow)
 * with the strongest style of the edges that use it.
 */
function expectedPieces(layout: GraphLayout<LayoutInput>, r: number): Map<string, number> {
  const pieces = new Map<string, number>();
  const mark = (key: string, style: number) =>
    pieces.set(key, Math.max(pieces.get(key) ?? NONE, style));
  for (const { childRow: a, parentRow: b, lane: via } of layout.edges) {
    if (r < a || r > b) continue;
    const child = layout.rows[a];
    const parentLane = layout.rows[b]?.lane;
    const style = child?.commit.special === true ? DOTTED : SOLID;
    if (r === a)
      mark(via === child?.lane ? `bottom ${via}` : `elbow ${child?.lane}>${via} down`, style);
    else if (r === b)
      mark(via === parentLane ? `top ${via}` : `elbow ${parentLane}>${via} up`, style);
    else mark(`through ${via}`, style);
  }
  return pieces;
}

/** The same pieces, read from what `segmentsAt` returns; each piece only once. */
function actualPieces(layout: GraphLayout<LayoutInput>, r: number): Map<string, number> {
  const pieces = new Map<string, number>();
  const nodeLane = layout.rows[r]?.lane;
  const add = (key: string, segment: Segment) => {
    expect(pieces.has(key)).toBe(false);
    pieces.set(key, segment.dotted ? DOTTED : SOLID);
  };
  for (const segment of layout.segmentsAt(r)) {
    if (segment.kind === "elbow") {
      add(`elbow ${segment.from}>${segment.to} ${segment.toward}`, segment);
    } else if (segment.lane !== nodeLane) {
      expect([segment.top, segment.bottom]).toEqual([true, true]);
      add(`through ${segment.lane}`, segment);
    } else {
      expect(segment.top || segment.bottom).toBe(true);
      if (segment.top) add(`top ${segment.lane}`, segment);
      if (segment.bottom) add(`bottom ${segment.lane}`, segment);
    }
  }
  return pieces;
}

describe("layoutGraph", () => {
  it("draws lines that continue across every row boundary", () => {
    fc.assert(
      fc.property(anyHistories, (commits) => {
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
      fc.property(anyHistories, (commits) => {
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
      fc.property(anyHistories, (commits) => {
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
      fc.property(anyHistories, (commits) => {
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

  it("draws an edge dotted exactly where only dotted edges run (WIP and stash rows)", () => {
    fc.assert(
      fc.property(specialHistories, (commits) => {
        const layout = layoutGraph(commits);
        for (let r = 0; r < layout.rows.length; r++) {
          expect(actualPieces(layout, r)).toEqual(expectedPieces(layout, r));
          // Lines by lane (a node lane's top half before its bottom half), then elbows.
          const segments = layout.segmentsAt(r);
          const lines = segments.filter((s) => s.kind === "line");
          expect(segments.slice(0, lines.length)).toEqual(lines);
          for (let i = 1; i < lines.length; i++) {
            const [prev, here] = [lines[i - 1], lines[i]];
            if (!prev || !here) continue;
            expect(prev.lane).toBeLessThanOrEqual(here.lane);
            if (prev.lane === here.lane) {
              expect([prev.top, prev.bottom, here.top, here.bottom]).toEqual([
                true,
                false,
                false,
                true,
              ]);
              expect(Boolean(prev.dotted)).not.toBe(Boolean(here.dotted));
            }
          }
        }
      }),
      RUNS,
    );
  });

  it("never moves a commit's lane for a WIP or stash row", () => {
    fc.assert(
      fc.property(specialHistories, (rows) => {
        const deferred = deferredShas(rows);
        const layout = layoutGraph(rows);
        // The other rows as plain commits: without the deferred rows, a special
        // row they had as a child could be deferred itself.
        const withoutLayout = layoutGraph(
          rows
            .filter((c) => !deferred.has(c.sha))
            .map((c): LayoutInput => ({ ...c, special: false })),
        );
        const without = laneBySha(withoutLayout);
        for (const row of layout.rows) {
          if (!deferred.has(row.commit.sha)) {
            expect(row.lane).toBe(without.get(row.commit.sha));
          }
          expect(row.lane).toBeLessThan(layout.laneCount);
        }
        // Each one adds a lane at most.
        expect(layout.laneCount).toBeLessThanOrEqual(withoutLayout.laneCount + deferred.size);
      }),
      RUNS,
    );
  });

  it("marks nothing dotted when no row asks for it", () => {
    fc.assert(
      fc.property(histories, (commits) => {
        const layout = layoutGraph(commits);
        for (let r = 0; r < layout.rows.length; r++) {
          for (const segment of layout.segmentsAt(r)) expect("dotted" in segment).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it("places a special row with a child like a commit, and draws a stretch it shares solid", () => {
    // S is special but has a child (c), so it waits in its lane like a commit;
    // merge M then joins that lane toward x.
    const commits: LayoutInput[] = [
      { sha: "c", parents: ["S"], committerTime: 6 },
      { sha: "S", parents: ["x"], committerTime: 5, special: true },
      { sha: "M", parents: ["m0", "x"], committerTime: 4 },
      { sha: "x", parents: ["r"], committerTime: 3 },
      { sha: "m0", parents: ["r"], committerTime: 2 },
      { sha: "r", parents: [], committerTime: 0 },
    ];
    const layout = layoutGraph(commits);
    expect(layout.rows.map((r) => `${r.commit.sha}${r.lane}`)).toEqual([
      "c0",
      "S0",
      "M1",
      "x0",
      "m01",
      "r0",
    ]);
    expect(layout.segmentsAt(1)).toEqual([
      { kind: "line", lane: 0, top: true, bottom: false },
      { kind: "line", lane: 0, top: false, bottom: true, dotted: true },
    ]);
    expect(layout.segmentsAt(2)).toEqual([
      { kind: "line", lane: 0, top: true, bottom: true, dotted: true },
      { kind: "line", lane: 1, top: false, bottom: true },
      { kind: "elbow", from: 1, to: 0, toward: "down" },
    ]);
    // Both edges reach x from above in lane 0: solid.
    expect(layout.segmentsAt(3)).toEqual([
      { kind: "line", lane: 0, top: true, bottom: true },
      { kind: "line", lane: 1, top: true, bottom: true },
    ]);
  });

  it("places a WIP row in a free lane, so the commits keep theirs", () => {
    // Same history with the WIP row on x (HEAD): lanes 0 and 1 are taken above x.
    const commits: LayoutInput[] = [
      { sha: "M", parents: ["m0", "x"], committerTime: 5 },
      { sha: "x", parents: ["r"], committerTime: 3 },
      { sha: "m0", parents: ["r"], committerTime: 2 },
      { sha: "r", parents: [], committerTime: 0 },
    ];
    const without = layoutGraph(commits);
    const layout = layoutGraph([
      ...commits,
      { sha: "WIP", parents: ["x"], committerTime: Infinity, special: true },
    ]);
    expect(without.rows.map((r) => `${r.commit.sha}${r.lane}`)).toEqual(["M0", "x1", "m00", "r0"]);
    expect(layout.rows.map((r) => `${r.commit.sha}${r.lane}`)).toEqual([
      "WIP2",
      "M0",
      "x1",
      "m00",
      "r0",
    ]);
    expect(layout.laneCount).toBe(3);
    // Down lane 2, then across from x's node and up into it.
    expect(layout.segmentsAt(1)).toContainEqual({
      kind: "line",
      lane: 2,
      top: true,
      bottom: true,
      dotted: true,
    });
    expect(layout.segmentsAt(2)).toContainEqual({
      kind: "elbow",
      from: 1,
      to: 2,
      toward: "up",
      dotted: true,
    });
  });

  it("runs a WIP row straight into HEAD's node when HEAD's lane is free above it", () => {
    // HEAD (f1) is on a side branch in lane 1, under main's newer tip m2.
    const commits: LayoutInput[] = [
      { sha: "m2", parents: ["m1"], committerTime: 5 },
      { sha: "f1", parents: ["m1"], committerTime: 4 },
      { sha: "m1", parents: ["r"], committerTime: 2 },
      { sha: "r", parents: [], committerTime: 0 },
    ];
    const plain = layoutGraph(commits);
    expect(plain.rows.map((r) => `${r.commit.sha}${r.lane}`)).toEqual(["m20", "f11", "m10", "r0"]);
    const layout = layoutGraph([
      ...commits,
      { sha: "WIP", parents: ["f1"], committerTime: Infinity, special: true },
    ]);
    // m2 uses lane 0 on the way down, so the leftmost free lane is f1's own.
    expect(layout.rows.map((r) => `${r.commit.sha}${r.lane}`)).toEqual([
      "WIP1",
      "m20",
      "f11",
      "m10",
      "r0",
    ]);
    expect(layout.segmentsAt(1)).toContainEqual({
      kind: "line",
      lane: 1,
      top: true,
      bottom: true,
      dotted: true,
    });
    expect(layout.segmentsAt(2)).toContainEqual({
      kind: "line",
      lane: 1,
      top: true,
      bottom: false,
      dotted: true,
    });
  });

  it("puts a stash in the leftmost free lane, also left of its parent's lane", () => {
    // p is in lane 2 under e's line; lanes 0 and 1 are free below b.
    const commits: LayoutInput[] = [
      { sha: "a", parents: ["b"], committerTime: 20 },
      { sha: "f", parents: ["b"], committerTime: 19 },
      { sha: "e", parents: ["p"], committerTime: 18 },
      { sha: "b", parents: [], committerTime: 17 },
      { sha: "stash@{0}", parents: ["p"], committerTime: 16, special: true },
      { sha: "stash@{1}", parents: ["p"], committerTime: 15.5, special: true },
      { sha: "p", parents: [], committerTime: 15 },
    ];
    const layout = layoutGraph(commits);
    expect(layout.rows.map((r) => `${r.commit.sha}${r.lane}`)).toEqual([
      "a0",
      "f1",
      "e2",
      "b0",
      "stash@{0}0",
      "stash@{1}1",
      "p2",
    ]);
    // Both turn left from p's node, up into their lanes.
    expect(hasElbow(layout.segmentsAt(6), 2, 0, "up")).toBe(true);
    expect(hasElbow(layout.segmentsAt(6), 2, 1, "up")).toBe(true);
  });

  it("keeps a special row's turn off a lane its parent merges into", () => {
    // HEAD (h) merges side branch s; its merge line turns down into lane 1 at
    // h's row, so a stash on h must not turn up into lane 1 there.
    const commits: LayoutInput[] = [
      { sha: "h", parents: ["m", "s"], committerTime: 5 },
      { sha: "m", parents: ["r"], committerTime: 3 },
      { sha: "s", parents: ["r"], committerTime: 2 },
      { sha: "r", parents: [], committerTime: 0 },
      { sha: "WIP", parents: ["h"], committerTime: Infinity, special: true },
      { sha: "stash@{0}", parents: ["h"], committerTime: 9, special: true },
    ];
    const layout = layoutGraph(commits);
    expect(layout.rows.map((r) => `${r.commit.sha}${r.lane}`)).toEqual([
      "WIP0",
      "stash@{0}2",
      "h0",
      "m0",
      "s1",
      "r0",
    ]);
    expect(hasElbow(layout.segmentsAt(2), 0, 1, "down")).toBe(true);
    expect(hasElbow(layout.segmentsAt(2), 0, 2, "up")).toBe(true);
  });

  it("gives special rows lanes past 32 when the commits use 32 (the lane bit sets grow)", () => {
    // 32 branches side by side from the root, then 3 stashes and a WIP row on
    // the root, newer than everything: each needs a lane of its own, past 31.
    const commits: LayoutInput[] = [{ sha: "root", parents: [], committerTime: 0 }];
    const tips = Array.from({ length: 32 }, () => "root");
    for (let i = 0; i < 320; i++) {
      const b = i % 32;
      commits.push({ sha: `w${i}`, parents: [tips[b] ?? "root"], committerTime: i + 1 });
      tips[b] = `w${i}`;
    }
    const special: LayoutInput[] = [
      { sha: "WIP", parents: ["root"], committerTime: Infinity, special: true },
      ...[0, 1, 2].map((i) => ({
        sha: `stash@{${i}}`,
        parents: ["root"],
        committerTime: 1000 - i,
        special: true,
      })),
    ];
    const plain = layoutGraph(commits);
    expect(plain.laneCount).toBe(32);
    const layout = layoutGraph([...commits, ...special]);
    expect(layout.laneCount).toBe(36);
    expect(layout.rows.slice(0, 4).map((r) => `${r.commit.sha} ${r.lane}`)).toEqual([
      "WIP 32",
      "stash@{0} 33",
      "stash@{1} 34",
      "stash@{2} 35",
    ]);
    // The commits keep their lanes, and every piece is where the edges say.
    const lanes = laneBySha(plain);
    for (const row of layout.rows.slice(4)) expect(row.lane).toBe(lanes.get(row.commit.sha));
    for (let r = 0; r < layout.rows.length; r++) {
      expect(actualPieces(layout, r)).toEqual(expectedPieces(layout, r));
    }
  });

  it("puts the WIP and stash rows where GitKraken showed them, without moving the demo's lanes", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), "fixtures/demo-repo.json"), "utf8"),
    ) as Fixture;
    const layout = layoutGraph(graphNodes(fixture.graph));
    const commitsOnly = layoutGraph(fixture.graph.log);
    expect(layout.laneCount).toBe(3);
    // spec §1 Special rows: the WIP row at the top in main's lane, the stash
    // below it in lane 1, then the commits as without them.
    expect(layout.rows.slice(0, 2).map((r) => [r.commit.sha, r.lane])).toEqual([
      [WIP_KEY, 0],
      ["stash@{0}", 1],
    ]);
    expect(layout.rows.slice(2).map((r) => [r.commit.sha, r.lane])).toEqual(
      commitsOnly.rows.map((r) => [r.commit.sha, r.lane]),
    );
    // WIP: dotted down lane 0 to HEAD (Update roadmap). Stash: dotted down from
    // its node, then an elbow from HEAD's node up into lane 1.
    expect(layout.segmentsAt(0)).toEqual([
      { kind: "line", lane: 0, top: false, bottom: true, dotted: true },
    ]);
    expect(layout.segmentsAt(1)).toEqual([
      { kind: "line", lane: 0, top: true, bottom: true, dotted: true },
      { kind: "line", lane: 1, top: false, bottom: true, dotted: true },
    ]);
    expect(layout.segmentsAt(2)).toEqual([
      { kind: "line", lane: 0, top: true, bottom: false, dotted: true },
      { kind: "line", lane: 0, top: false, bottom: true },
      { kind: "elbow", from: 0, to: 1, toward: "up", dotted: true },
    ]);
    for (let r = 3; r < layout.rows.length; r++) {
      expect(layout.segmentsAt(r)).toEqual(commitsOnly.segmentsAt(r - 2));
    }
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
      expect(segments).toContainEqual({ kind: "line", lane: 1, top: true, bottom: true });
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
