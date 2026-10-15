import { describe, expect, it } from "vitest";
import { createFixtureAdapter, loadEdgeFixture } from "../git/fixtureAdapter";
import { RecordingContext } from "../test/recordingContext";
import { drawGraphRows } from "./drawGraph";
import {
  AVATAR_RADIUS,
  AVATAR_RING,
  DOTTED_EDGE_DASH,
  isMergeCommit,
  laneX,
  MERGE_DOT_RADIUS,
  ROW_HEIGHT,
  ROW_MID,
  segmentLane,
  SPECIAL_NODE_RADIUS,
  STASH_DOT_RADIUS,
  STASH_SIDE,
  traceDottedSegment,
  traceSegment,
  WIP_RING_DASHES,
} from "./geometry";
import { identicon } from "./identicon";
import { layoutGraph } from "./lanes";
import { LANE_COLORS, laneColorValue, laneConnectorColor } from "./palette";
import { buildRefLabels } from "./refLabels";
import { graphNodes } from "./specialRows";

async function demoLayout() {
  return layoutGraph((await createFixtureAdapter().graphData("demo-repo")).log);
}

/** The demo repo with its WIP row (row 0, lane 0) and stash (row 1, lane 1). */
async function specialLayout() {
  return layoutGraph(graphNodes(await createFixtureAdapter().graphData("demo-repo")));
}

/** The edge-case fixture with its WIP row and stash (a detached HEAD, a branch on it). */
async function edgeLayout() {
  return layoutGraph(
    graphNodes(await createFixtureAdapter(loadEdgeFixture).graphData("edge-repo")),
  );
}

/**
 * The start points of the dotted strokes' subpaths: vertical ones (a line, or
 * an elbow's turn) and horizontal ones (an elbow's run, a move then a line at
 * the same height).
 */
function dottedSubpaths(ctx: RecordingContext) {
  const vertical: [number, number][] = [];
  const horizontal: [number, number][] = [];
  const firstNode = ctx.calls.findIndex((c) => c.name === "arc");
  const calls = ctx.calls.slice(0, firstNode);
  calls.forEach((call, i) => {
    if (call.name !== "moveTo" || call.lineDash.length === 0) return;
    const [x = 0, y = 0] = call.args;
    const next = calls[i + 1];
    const flat = next?.name === "lineTo" && next.args[1] === y && next.args[0] !== x;
    (flat ? horizontal : vertical).push([x, y]);
  });
  return { vertical, horizontal };
}

async function demoLabels() {
  const graph = await createFixtureAdapter().graphData("demo-repo");
  return buildRefLabels(graph.refs, graph.log);
}

/**
 * The path calls the layout's segments should make in rows first..last, per
 * color; dotted segments under "<color> dotted".
 */
function expectedTraces(
  layout: Awaited<ReturnType<typeof specialLayout>>,
  first: number,
  last: number,
): Map<string, string[]> {
  const byColor = new Map<string, string[]>();
  for (let r = first; r <= last; r++) {
    for (const segment of layout.segmentsAt(r)) {
      const color = `${laneColorValue(segmentLane(segment))}${segment.dotted ? " dotted" : ""}`;
      const calls = byColor.get(color) ?? [];
      (segment.dotted ? traceDottedSegment : traceSegment)(
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
 * The path calls the canvas stroked for lines and elbows, per color: the color
 * is the one in effect when stroke() painted the path, not when it was traced.
 * Strokes with the dotted-edge dash pattern are under "<color> dotted"; any
 * other dash pattern fails. The nodes (from the first fill after the first
 * stroke) are left out.
 */
function strokedTraces(ctx: RecordingContext): Map<string, string[]> {
  const byColor = new Map<string, string[]>();
  let pending: string[] = [];
  let stroked = false;
  for (const call of ctx.calls) {
    if (stroked && ["arc", "fill", "fillRect"].includes(call.name)) break;
    if (call.name === "beginPath") pending = [];
    else if (["moveTo", "lineTo", "arcTo"].includes(call.name)) {
      pending.push(`${call.name} ${call.args.join(" ")}`);
    } else if (call.name === "stroke" && pending.length > 0) {
      stroked = true;
      const dotted = call.lineDash.length > 0;
      if (dotted) expect(call.lineDash).toEqual(DOTTED_EDGE_DASH);
      const color = `${String(call.strokeStyle)}${dotted ? " dotted" : ""}`;
      byColor.set(color, [...(byColor.get(color) ?? []), ...pending]);
      pending = [];
    }
  }
  return byColor;
}

/** Where a recorded call is in the context's list; fails for a missing one. */
function indexOfCall(ctx: RecordingContext, call: RecordingContext["calls"][number] | undefined) {
  const index = call === undefined ? -1 : ctx.calls.indexOf(call);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
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

  describe("ref label connectors (spec §1 Ref labels)", () => {
    it("draws a line from the column's left edge to the node of each labeled row, under the lanes", async () => {
      const layout = await demoLayout();
      const labels = await demoLabels();
      const ctx = new RecordingContext();
      drawGraphRows(ctx, layout, 0, 18, 100, 1, labels);
      const firstStroke = ctx.calls.findIndex((c) => c.name === "stroke");
      const connectors = ctx.calls.slice(0, firstStroke).filter((c) => c.name === "fillRect");
      const labeled = layout.rows
        .map((row, r) => ({ row, r }))
        .filter(({ row }) => labels.has(row.commit.sha));
      expect(labeled).toHaveLength(7);
      expect(connectors.map((c) => [c.args, c.fillStyle])).toEqual(
        labeled.map(({ row, r }) => [
          [0, r * ROW_HEIGHT + ROW_MID - 1, laneX(row.lane), 2],
          laneConnectorColor(row.lane, labels.get(row.commit.sha)?.head ?? false),
        ]),
      );
      // Full color only on the checked-out commit (row 0, main); half color elsewhere.
      expect(connectors[0]?.fillStyle).toBe(laneColorValue(0));
      expect(connectors.slice(1).every((c) => String(c.fillStyle).endsWith("80"))).toBe(true);
      // Everything else is drawn as without labels.
      const without = new RecordingContext();
      drawGraphRows(without, layout, 0, 18, 100);
      const shape = (calls: typeof ctx.calls) =>
        calls.map((c) => [c.name, c.args, c.name === "stroke" ? c.strokeStyle : null]);
      expect(shape(ctx.calls.filter((c) => !connectors.includes(c)))).toEqual(shape(without.calls));
    });

    it("draws the connectors of a window of rows from the top of the canvas", async () => {
      const layout = await demoLayout();
      const labels = await demoLabels();
      const ctx = new RecordingContext();
      drawGraphRows(ctx, layout, 3, 6, 100, 1, labels);
      // Rows 3 (origin/main) and 4 (release/1.1) of 3..6 have labels.
      const ys = ctx
        .named("fillRect")
        .filter((c) => c.args[0] === 0)
        .map((c) => c.args[1]);
      expect(ys).toEqual([ROW_MID - 1, ROW_HEIGHT + ROW_MID - 1]);
    });

    it("draws connectors where the cell's CSS line is, at every pixel ratio", async () => {
      // The browser does not snap the cell's 2 px line at fractional ratios, so the
      // canvas does not either: both halves then line up (checked in Chrome).
      const layout = await demoLayout();
      const labels = await demoLabels();
      const at1 = new RecordingContext();
      drawGraphRows(at1, layout, 0, 18, 100, 1, labels);
      const expected = at1
        .named("fillRect")
        .filter((c) => c.args[0] === 0)
        .map((c) => c.args);
      expect(expected).toHaveLength(7);
      for (const scale of [1.25, 1.5, 1.75, 2]) {
        const ctx = new RecordingContext();
        drawGraphRows(ctx, layout, 0, 18, 100, scale, labels);
        const connectors = ctx.named("fillRect").filter((c) => c.args[0] === 0);
        expect(connectors.map((c) => c.args)).toEqual(expected);
      }
    });
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
  describe("WIP and stash rows (spec §1 Special rows)", () => {
    it("strokes the dotted edges with the dot pattern, under the solid lines", async () => {
      const layout = await specialLayout();
      const last = layout.rows.length - 1;
      const ctx = new RecordingContext();
      drawGraphRows(ctx, layout, 0, last, 100);
      const traces = strokedTraces(ctx);
      expect(traces).toEqual(expectedTraces(layout, 0, last));
      expect([...traces.keys()].filter((k) => k.endsWith("dotted"))).toEqual([
        `${laneColorValue(0)} dotted`,
        `${laneColorValue(1)} dotted`,
      ]);
      // Every dotted line stroke comes before every solid one (the nodes start
      // with the WIP node's first arc).
      const firstNode = ctx.calls.findIndex((c) => c.name === "arc");
      const dashed = ctx.calls
        .slice(0, firstNode)
        .filter((c) => c.name === "stroke")
        .map((c) => c.lineDash.length > 0);
      expect(dashed).toEqual([true, true, false, false, false]);
    });

    it("strokes the dotted edges of a window of rows from the top of the canvas", async () => {
      const layout = await specialLayout();
      for (const [first, last] of [
        [1, 3],
        [2, 6],
      ] as const) {
        const ctx = new RecordingContext();
        drawGraphRows(ctx, layout, first, last, 100);
        expect(strokedTraces(ctx)).toEqual(expectedTraces(layout, first, last));
      }
    });

    it("starts every dotted subpath on the dot grid, so the dots line up across rows", async () => {
      const period = DOTTED_EDGE_DASH.reduce((a, b) => a + b, 0);
      expect(ROW_HEIGHT % period).toBe(0);
      for (const layout of [await specialLayout(), await edgeLayout()]) {
        for (const first of [0, 1, 2]) {
          const ctx = new RecordingContext();
          drawGraphRows(ctx, layout, first, 6, 100);
          const { vertical, horizontal } = dottedSubpaths(ctx);
          expect(vertical.length).toBeGreaterThan(0);
          for (const [, y] of vertical) expect(y % period).toBe(0);
          // A horizontal run starts at the center of the node it leaves.
          for (const [x, y] of horizontal) {
            const row = layout.rows[first + (y - ROW_MID) / ROW_HEIGHT];
            expect(x).toBe(laneX(row?.lane ?? -1));
          }
        }
      }
      // The WIP row's line leaves its node from below the center, under the node.
      const segment = { kind: "line", lane: 0, top: false, bottom: true, dotted: true } as const;
      const calls: number[][] = [];
      traceDottedSegment(
        { moveTo: (...a) => calls.push(a), lineTo: (...a) => calls.push(a), arcTo: () => {} },
        segment,
      );
      const startY = calls[0]?.[1] ?? 0;
      expect(startY).toBeGreaterThanOrEqual(ROW_MID);
      expect(startY).toBeLessThan(ROW_MID + SPECIAL_NODE_RADIUS);
    });

    it("puts the dots of several dotted elbows leaving one node in the same places", async () => {
      // Edge fixture: the WIP row (lane 1) and the stash (lane 2) both turn up
      // from HEAD's node (Update roadmap, lane 0, row 3).
      const layout = await edgeLayout();
      const head = layout.rows.findIndex((r) => r.commit.sha === layout.rows[0]?.commit.parents[0]);
      expect(head).toBe(3);
      const ups = layout.segmentsAt(head).filter((s) => s.kind === "elbow" && s.dotted);
      expect(ups).toHaveLength(2);
      const ctx = new RecordingContext();
      drawGraphRows(ctx, layout, 0, 6, 100);
      const runs = dottedSubpaths(ctx).horizontal.filter(
        ([, y]) => y === head * ROW_HEIGHT + ROW_MID,
      );
      // Both runs start at the node's center and go right: the same dash phase.
      expect(runs).toEqual([
        [laneX(0), head * ROW_HEIGHT + ROW_MID],
        [laneX(0), head * ROW_HEIGHT + ROW_MID],
      ]);
    });

    it("draws the WIP node as a hollow circle with a dashed ring in its lane color", async () => {
      const layout = await specialLayout();
      const ctx = new RecordingContext();
      drawGraphRows(ctx, layout, 0, 3, 100);
      const radius = AVATAR_RADIUS - AVATAR_RING / 2;
      const atWip = ctx.named("arc").filter((a) => a.args[0] === laneX(0) && a.args[1] === ROW_MID);
      expect(atWip).toHaveLength(2);
      const [clear, ring] = atWip;
      // The inside is cleared, so the row's own background shows there.
      expect(clear?.args).toEqual([laneX(0), ROW_MID, SPECIAL_NODE_RADIUS, 0, 2 * Math.PI]);
      expect(clear?.globalCompositeOperation).toBe("destination-out");
      const clearFill = ctx.calls.slice(indexOfCall(ctx, clear)).find((c) => c.name === "fill");
      expect(clearFill?.globalCompositeOperation).toBe("destination-out");
      expect(ring?.globalCompositeOperation).toBe("source-over");
      expect(ring?.strokeStyle).toBe(laneColorValue(0));
      expect(ring?.lineWidth).toBe(AVATAR_RING);
      // 12 dashes, a whole number around the circle, one centered at the top.
      const [start = 0, end = 0] = ring?.args.slice(3) ?? [];
      expect(end - start).toBeCloseTo(2 * Math.PI);
      const [dash = 0, gap = 0] = ring?.lineDash ?? [];
      expect(WIP_RING_DASHES * (dash + gap)).toBeCloseTo(2 * Math.PI * radius);
      expect(start + dash / radius / 2).toBeCloseTo(-Math.PI / 2);
      // The stroke after the ring is solid again.
      const next = ctx.calls
        .slice(indexOfCall(ctx, ring) + 1)
        .find((c) => c.name === "setLineDash");
      expect(next?.args).toEqual([]);
    });

    it("draws the stash node as a square of dots with a tray icon in its lane color", async () => {
      const layout = await specialLayout();
      const ctx = new RecordingContext();
      drawGraphRows(ctx, layout, 0, 3, 100);
      const x = laneX(1);
      const y = ROW_HEIGHT + ROW_MID; // row 1
      const half = STASH_SIDE / 2;
      // The inside is cleared first (the square the node covers).
      const clearAt = ctx.calls.findIndex(
        (c) =>
          c.name === "moveTo" &&
          c.args[0] === x - SPECIAL_NODE_RADIUS &&
          c.args[1] === y - SPECIAL_NODE_RADIUS,
      );
      expect(clearAt).toBeGreaterThan(0);
      const clearFill = ctx.calls.slice(clearAt).find((c) => c.name === "fill");
      expect(clearFill?.globalCompositeOperation).toBe("destination-out");
      // 7 round dots per side, 3 px apart: every corner and every side's middle,
      // each once.
      const dots = ctx.named("arc").filter((a) => a.args[2] === STASH_DOT_RADIUS);
      const centers = dots.map((c) => `${c.args[0]},${c.args[1]}`);
      const expected = new Set<string>();
      for (let t = -half; t <= half; t += 3) {
        for (const [dx, dy] of [
          [t, -half],
          [t, half],
          [-half, t],
          [half, t],
        ] as const) {
          expected.add(`${x + dx},${y + dy}`);
        }
      }
      expect(expected.size).toBe(24);
      expect(centers).toHaveLength(24);
      expect(new Set(centers)).toEqual(expected);
      expect(expected.has(`${x},${y + half}`)).toBe(true); // the line leaves under this one
      expect(dots.every((c) => c.fillStyle === laneColorValue(1))).toBe(true);
      expect(dots.every((c) => c.globalCompositeOperation === "source-over")).toBe(true);
      // The tray: one stroke in the lane color, inside the square of dots.
      const trayStroke = ctx
        .named("stroke")
        .find((c) => c.strokeStyle === laneColorValue(1) && c.lineWidth === 1.6);
      const points = ctx.calls
        .slice(indexOfCall(ctx, dots.at(-1)), indexOfCall(ctx, trayStroke))
        .filter((c) => c.name === "moveTo" || c.name === "lineTo");
      expect(points.length).toBeGreaterThan(8);
      for (const p of points) {
        expect(Math.abs((p.args[0] ?? 0) - x) + 0.8).toBeLessThan(half - STASH_DOT_RADIUS);
        expect(Math.abs((p.args[1] ?? 0) - y) + 0.8).toBeLessThan(half - STASH_DOT_RADIUS);
      }
      // Neither node gets an avatar or a merge dot.
      const avatarRings = ctx
        .named("arc")
        .filter((a) => a.args[2] === AVATAR_RADIUS - AVATAR_RING / 2 && a.args[1] === y);
      expect(avatarRings).toHaveLength(0);
    });

    it("leaves no dash pattern, line join or erasing set, and sets none without WIP or stash rows", async () => {
      const ctx = new RecordingContext();
      drawGraphRows(ctx, await specialLayout(), 0, 20, 100);
      expect(ctx.lineDash).toEqual([]);
      expect(ctx.lineJoin).toBe("miter");
      expect(ctx.globalCompositeOperation).toBe("source-over");
      // Avatars and merge dots are solid and drawn normally.
      for (const call of ctx.named("arc").filter((a) => a.args[1] !== ROW_MID)) {
        expect(call.lineDash).toEqual([]);
        if (call.args[2] !== STASH_DOT_RADIUS)
          expect(call.globalCompositeOperation).toBe("source-over");
      }
      const plain = new RecordingContext();
      drawGraphRows(plain, await demoLayout(), 0, 18, 100);
      expect(plain.named("setLineDash")).toHaveLength(0);
      expect(plain.calls.every((c) => c.globalCompositeOperation === "source-over")).toBe(true);
    });
  });
});
