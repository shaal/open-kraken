import { describe, expect, it } from "vitest";
import {
  ELBOW_RADIUS,
  LANE_WIDTH,
  ROW_HEIGHT,
  ROW_MID,
  isMergeCommit,
  laneX,
  segmentLane,
  traceDottedSegment,
  traceSegment,
} from "./geometry";
import type { Segment } from "./lanes";

describe("laneX", () => {
  it("puts lane centers one lane width apart, on whole pixels", () => {
    expect([0, 1, 2, 3].map(laneX)).toEqual([19, 41, 63, 85]);
    for (let lane = 0; lane < 50; lane++) {
      expect(Number.isInteger(laneX(lane))).toBe(true);
      expect(laneX(lane + 1) - laneX(lane)).toBe(LANE_WIDTH);
    }
  });
});

describe("traceSegment", () => {
  /** The path calls a segment makes, in row `top`. */
  function trace(segment: Segment, top = 0): (string | number)[][] {
    const calls: (string | number)[][] = [];
    traceSegment(
      {
        moveTo: (...a) => calls.push(["moveTo", ...a]),
        lineTo: (...a) => calls.push(["lineTo", ...a]),
        arcTo: (...a) => calls.push(["arcTo", ...a]),
      },
      segment,
      top,
    );
    return calls;
  }

  it("draws lane lines to the exact row edges, so rows join without a seam", () => {
    expect(trace({ kind: "line", lane: 1, top: true, bottom: true })).toEqual([
      ["moveTo", 41, 0],
      ["lineTo", 41, 28],
    ]);
    expect(trace({ kind: "line", lane: 1, top: true, bottom: false })).toEqual([
      ["moveTo", 41, 0],
      ["lineTo", 41, 14],
    ]);
    expect(trace({ kind: "line", lane: 1, top: false, bottom: true })).toEqual([
      ["moveTo", 41, 14],
      ["lineTo", 41, 28],
    ]);
    expect(trace({ kind: "line", lane: 1, top: false, bottom: false })).toEqual([]);
  });

  // Across from the node at the row's center, a rounded corner at lane `to`, then to the edge.
  it("merge going right: across, then down to the bottom edge", () => {
    expect(trace({ kind: "elbow", from: 0, to: 2, toward: "down" })).toEqual([
      ["moveTo", 19, 14],
      ["arcTo", 63, 14, 63, 28, ELBOW_RADIUS],
      ["lineTo", 63, 28],
    ]);
  });

  it("fork going right: across, then up to the top edge", () => {
    expect(trace({ kind: "elbow", from: 0, to: 2, toward: "up" })).toEqual([
      ["moveTo", 19, 14],
      ["arcTo", 63, 14, 63, 0, ELBOW_RADIUS],
      ["lineTo", 63, 0],
    ]);
  });

  it("merge going left: across, then down", () => {
    expect(trace({ kind: "elbow", from: 2, to: 0, toward: "down" })).toEqual([
      ["moveTo", 63, 14],
      ["arcTo", 19, 14, 19, 28, ELBOW_RADIUS],
      ["lineTo", 19, 28],
    ]);
  });

  it("fork going left: across, then up", () => {
    expect(trace({ kind: "elbow", from: 2, to: 0, toward: "up" })).toEqual([
      ["moveTo", 63, 14],
      ["arcTo", 19, 14, 19, 0, ELBOW_RADIUS],
      ["lineTo", 19, 0],
    ]);
  });

  it("offsets everything by the row's top", () => {
    expect(trace({ kind: "elbow", from: 0, to: 1, toward: "down" }, 280)).toEqual([
      ["moveTo", 19, 294],
      ["arcTo", 41, 294, 41, 308, ELBOW_RADIUS],
      ["lineTo", 41, 308],
    ]);
  });

  it("uses a corner radius under half a row and under one lane", () => {
    expect(ELBOW_RADIUS).toBeLessThanOrEqual(ROW_MID);
    expect(ELBOW_RADIUS).toBeLessThan(LANE_WIDTH);
    expect(ROW_MID * 2).toBe(ROW_HEIGHT);
  });

  it("draws nothing for an elbow that does not change lanes", () => {
    expect(trace({ kind: "elbow", from: 1, to: 1, toward: "down" })).toEqual([]);
  });
});

describe("node and color helpers", () => {
  it("treats two or more parents as a merge", () => {
    expect(isMergeCommit({ parents: [] })).toBe(false);
    expect(isMergeCommit({ parents: ["a"] })).toBe(false);
    expect(isMergeCommit({ parents: ["a", "b"] })).toBe(true);
    expect(isMergeCommit({ parents: ["a", "b", "c"] })).toBe(true);
  });

  it("colors a line by its lane and an elbow by the lane it turns into", () => {
    expect(segmentLane({ kind: "line", lane: 3, top: true, bottom: true })).toBe(3);
    expect(segmentLane({ kind: "elbow", from: 0, to: 2, toward: "down" })).toBe(2);
    expect(segmentLane({ kind: "elbow", from: 4, to: 1, toward: "up" })).toBe(1);
  });
});

describe("traceDottedSegment", () => {
  /** The path calls a dotted segment makes, in row `top`. */
  function trace(segment: Segment, top = 0): (string | number)[][] {
    const calls: (string | number)[][] = [];
    traceDottedSegment(
      {
        moveTo: (...a) => calls.push(["moveTo", ...a]),
        lineTo: (...a) => calls.push(["lineTo", ...a]),
        arcTo: (...a) => calls.push(["arcTo", ...a]),
      },
      { ...segment, dotted: true },
      top,
    );
    return calls;
  }
  const line = (top: boolean, bottom: boolean): Segment => ({ kind: "line", lane: 1, top, bottom });
  const elbow = (from: number, to: number, toward: "up" | "down"): Segment => ({
    kind: "elbow",
    from,
    to,
    toward,
  });

  it("starts a line's parts on the 4 px dot grid: a bottom half just below the center", () => {
    const x = laneX(1);
    expect(trace(line(true, true), 56)).toEqual([
      ["moveTo", x, 56],
      ["lineTo", x, 56 + ROW_HEIGHT],
    ]);
    expect(trace(line(true, false))).toEqual([
      ["moveTo", x, 0],
      ["lineTo", x, ROW_MID],
    ]);
    expect(trace(line(false, true))).toEqual([
      ["moveTo", x, 16],
      ["lineTo", x, ROW_HEIGHT],
    ]);
    expect(trace(line(false, false))).toEqual([]);
  });

  it("traces an elbow's turn from the row edge, then its run from the node to where the turn ends", () => {
    const mid = 56 + ROW_MID;
    // Right and left, up and down: the turn's arc ends one radius before the
    // corner, toward the node, exactly where the run ends.
    for (const [from, to, toward, edge] of [
      [0, 1, "up", 56],
      [1, 0, "up", 56],
      [0, 2, "down", 56 + ROW_HEIGHT],
      [2, 0, "down", 56 + ROW_HEIGHT],
    ] as const) {
      const end = laneX(to) - Math.sign(laneX(to) - laneX(from)) * ELBOW_RADIUS;
      expect(trace(elbow(from, to, toward), 56)).toEqual([
        ["moveTo", laneX(to), edge],
        ["arcTo", laneX(to), mid, laneX(from), mid, ELBOW_RADIUS],
        ["moveTo", laneX(from), mid],
        ["lineTo", end, mid],
      ]);
    }
    expect(trace(elbow(1, 1, "up"))).toEqual([]);
  });
});
