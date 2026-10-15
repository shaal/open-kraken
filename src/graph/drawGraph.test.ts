import { describe, expect, it } from "vitest";
import { createFixtureAdapter } from "../git/fixtureAdapter";
import { RecordingContext } from "../test/recordingContext";
import { drawGraphRows } from "./drawGraph";
import {
  AVATAR_RADIUS,
  AVATAR_RING,
  isMergeCommit,
  laneX,
  MERGE_DOT_RADIUS,
  ROW_HEIGHT,
  ROW_MID,
  segmentLane,
  traceSegment,
} from "./geometry";
import { identicon } from "./identicon";
import { layoutGraph } from "./lanes";
import { LANE_COLORS, laneColorValue } from "./palette";

async function demoLayout() {
  return layoutGraph((await createFixtureAdapter().graphData("demo-repo")).log);
}

/** The path calls the layout's segments should make in rows first..last, per color. */
function expectedTraces(
  layout: Awaited<ReturnType<typeof demoLayout>>,
  first: number,
  last: number,
): Map<string, string[]> {
  const byColor = new Map<string, string[]>();
  for (let r = first; r <= last; r++) {
    for (const segment of layout.segmentsAt(r)) {
      const color = laneColorValue(segmentLane(segment));
      const calls = byColor.get(color) ?? [];
      traceSegment(
        {
          moveTo: (...a) => calls.push(`moveTo ${a.join(" ")}`),
          lineTo: (...a) => calls.push(`lineTo ${a.join(" ")}`),
          arcTo: (...a) => calls.push(`arcTo ${a.join(" ")}`),
        },
        segment,
        (r - first) * ROW_HEIGHT,
      );
      byColor.set(color, calls);
    }
  }
  return byColor;
}

/**
 * The path calls the canvas stroked, per color: the color is the one in effect
 * when stroke() painted the path, not when it was traced.
 */
function strokedTraces(ctx: RecordingContext): Map<string, string[]> {
  const byColor = new Map<string, string[]>();
  let pending: string[] = [];
  for (const call of ctx.calls) {
    if (call.name === "beginPath") pending = [];
    else if (["moveTo", "lineTo", "arcTo"].includes(call.name)) {
      pending.push(`${call.name} ${call.args.join(" ")}`);
    } else if (call.name === "stroke" && pending.length > 0) {
      const color = String(call.strokeStyle);
      byColor.set(color, [...(byColor.get(color) ?? []), ...pending]);
      pending = [];
    }
  }
  return byColor;
}

describe("drawGraphRows", () => {
  it("clears the window, then strokes exactly the layout's segments in their lane colors", async () => {
    const layout = await demoLayout();
    const ctx = new RecordingContext();
    drawGraphRows(ctx, layout, 0, 18, 100);
    expect(ctx.calls[0]).toMatchObject({ name: "clearRect", args: [0, 0, 100, 19 * ROW_HEIGHT] });
    expect(strokedTraces(ctx)).toEqual(expectedTraces(layout, 0, 18));
    // Lines and elbows come first, one path per color, 2 px wide; then the nodes.
    const firstNode = ctx.calls.findIndex((c) => c.name === "arc");
    const lineStrokes = ctx.calls.slice(0, firstNode).filter((c) => c.name === "stroke");
    expect(lineStrokes.length).toBeGreaterThan(1);
    expect(new Set(lineStrokes.map((c) => c.strokeStyle)).size).toBe(lineStrokes.length);
    expect(lineStrokes.every((c) => c.lineWidth === 2)).toBe(true);
    // In palette order, so crossings look the same at every scroll position.
    const order = lineStrokes.map((c) => LANE_COLORS.indexOf(String(c.strokeStyle)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(ctx.named("arcTo")).toHaveLength(6); // the demo repo's 6 elbows
  });

  it("draws a dot for each merge and an avatar for every other commit, in the node's lane", async () => {
    const layout = await demoLayout();
    const ctx = new RecordingContext();
    drawGraphRows(ctx, layout, 0, 18, 100);
    const arcs = ctx.named("arc");
    const dots = arcs.filter((a) => a.args[2] === MERGE_DOT_RADIUS);
    const avatars = arcs.filter((a) => a.args[2] === AVATAR_RADIUS - AVATAR_RING / 2);
    expect(dots).toHaveLength(2);
    expect(avatars).toHaveLength(2 * 17); // fill, then the ring
    layout.rows.forEach((row, r) => {
      const at = (a: { args: number[] }) =>
        a.args[0] === laneX(row.lane) && a.args[1] === r * ROW_HEIGHT + ROW_MID;
      const color = laneColorValue(row.lane);
      if (isMergeCommit(row.commit)) {
        expect(dots.filter(at).map((a) => a.fillStyle)).toEqual([color]);
      } else {
        const [fill, ring] = avatars.filter(at);
        expect(fill?.fillStyle).toBe(identicon(row.commit.authorEmail).background);
        expect(ring?.strokeStyle).toBe(color);
      }
    });
    // Each avatar's face: one square per identicon cell.
    const cells = layout.rows
      .filter((row) => !isMergeCommit(row.commit))
      .reduce((n, row) => n + identicon(row.commit.authorEmail).cells.length, 0);
    expect(ctx.named("fillRect")).toHaveLength(cells);
  });

  it("draws a window of rows from the top of the canvas", async () => {
    const layout = await demoLayout();
    const ctx = new RecordingContext();
    drawGraphRows(ctx, layout, 5, 9, 100);
    expect(ctx.calls[0]).toMatchObject({ name: "clearRect", args: [0, 0, 100, 5 * ROW_HEIGHT] });
    expect(strokedTraces(ctx)).toEqual(expectedTraces(layout, 5, 9));
    const ys = new Set(ctx.named("arc").map((a) => a.args[1]));
    expect([...ys].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([14, 42, 70, 98, 126]);
  });

  it("draws identicon cells on whole pixels, so faces have no seams", async () => {
    const layout = await demoLayout();
    const ctx = new RecordingContext();
    drawGraphRows(ctx, layout, 0, 18, 100);
    const rects = ctx.named("fillRect");
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      expect(rect.args.every(Number.isInteger)).toBe(true);
    }
  });

  it("puts identicon cell edges on device pixels at fractional pixel ratios too", async () => {
    const layout = await demoLayout();
    // At whole ratios the CSS edges are already whole; these need the snapping.
    for (const scale of [1.25, 1.5, 1.75]) {
      const ctx = new RecordingContext();
      drawGraphRows(ctx, layout, 0, 18, 100, scale);
      for (const { args } of ctx.named("fillRect")) {
        const [x, y, w, h] = args as [number, number, number, number];
        for (const edge of [x, y, x + w, y + h]) {
          expect(Math.abs(edge * scale - Math.round(edge * scale))).toBeLessThan(1e-9);
        }
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
      }
    }
  });

  it("never collapses identicon cells, even below one device pixel per CSS pixel", async () => {
    const layout = await demoLayout();
    for (const scale of [0.25, 0.33, 0.5, 0.75]) {
      const ctx = new RecordingContext();
      drawGraphRows(ctx, layout, 0, 18, 100, scale);
      for (const { args } of ctx.named("fillRect")) {
        expect(args[2]).toBeGreaterThan(0);
        expect(args[3]).toBeGreaterThan(0);
      }
    }
  });

  it("draws an elbow that goes left when the merged parent's lane is on the left", () => {
    // main: A - B - M; feature: A - C - F, where F merges B (main) into the feature.
    const at = (sha: string, parents: string[], time: number) => ({
      sha,
      parents,
      authorName: "x",
      authorEmail: "x@example.com",
      authorTime: time,
      authorTzOffset: 0,
      committerTime: time,
      subject: sha,
    });
    const layout = layoutGraph([
      at("m", ["b"], 5),
      at("f", ["c", "b"], 4),
      at("c", ["a"], 3),
      at("b", ["a"], 2),
      at("a", [], 1),
    ]);
    expect(layout.rows.map((r) => `${r.commit.sha}${r.lane}`)).toEqual([
      "m0",
      "f1",
      "c1",
      "b0",
      "a0",
    ]);
    expect(layout.segmentsAt(1)).toContainEqual({ kind: "elbow", from: 1, to: 0, toward: "down" });
    const ctx = new RecordingContext();
    drawGraphRows(ctx, layout, 0, 4, 100);
    // From F's node in lane 1, across to the left, then down lane 0, in lane 0's color.
    const mid = ROW_HEIGHT + ROW_MID;
    expect(strokedTraces(ctx).get(laneColorValue(0))).toEqual(
      expect.arrayContaining([
        `moveTo ${laneX(1)} ${mid}`,
        `arcTo ${laneX(0)} ${mid} ${laneX(0)} ${2 * ROW_HEIGHT} 8`,
        `lineTo ${laneX(0)} ${2 * ROW_HEIGHT}`,
      ]),
    );
  });
});
