/**
 * Draws the Graph column (spec §1 Nodes, Edges and lanes) for a window of
 * rows onto a canvas: lane lines and elbows, then the nodes on top. One canvas
 * for the rows in the DOM costs about half the main-thread time per frame of
 * an SVG per row (measured: ROADMAP.md, "Graph lanes rendering").
 */

import type { Commit } from "../git/bindings/Commit";
import {
  AVATAR_RADIUS,
  AVATAR_RING,
  LINE_WIDTH,
  MERGE_DOT_RADIUS,
  ROW_HEIGHT,
  ROW_MID,
  isMergeCommit,
  laneX,
  segmentLane,
  traceSegment,
  type PathSink,
} from "./geometry";
import { IDENTICON_GRID, identicon } from "./identicon";
import { LANE_COLOR_COUNT, laneColor, type GraphLayout, type Segment } from "./lanes";
import { laneColorValue, laneConnectorColor } from "./palette";
import { NO_REF_LABELS, type RefLabels } from "./refLabels";

/** The canvas calls drawing needs (a subset of CanvasRenderingContext2D). */
export interface GraphContext extends PathSink {
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  stroke(): void;
  fill(): void;
}

/**
 * The identicon fills a square inside the avatar's inner circle: whole-pixel
 * cells from a whole-pixel origin, so neighboring cells join without seams.
 */
const FACE_CELL = Math.floor(((AVATAR_RADIUS - AVATAR_RING) * Math.SQRT2) / IDENTICON_GRID);
const FACE_SIDE = FACE_CELL * IDENTICON_GRID;

/**
 * Draws rows `first`..`last` (inclusive) with row `first` at y = 0. The
 * canvas is cleared first; `width` is its width in CSS pixels, and `scale`
 * the device pixels per CSS pixel it is drawn at.
 */
export function drawGraphRows(
  ctx: GraphContext,
  layout: GraphLayout<Commit>,
  first: number,
  last: number,
  width: number,
  scale = 1,
  labels: RefLabels = NO_REF_LABELS,
): void {
  // Identicon cell edges on device pixels, so faces stay sharp. Below one
  // device pixel per CSS pixel, snapping would collapse cells, so it is skipped.
  const snap = scale >= 1 ? (v: number) => Math.round(v * scale) / scale : (v: number) => v;
  ctx.clearRect(0, 0, width, (last - first + 1) * ROW_HEIGHT);

  // Ref label connectors (spec §1 Ref labels), under everything else: the
  // Branch / Tag cell draws the line up to this column's left edge, and it
  // continues here to the node. Not snapped: the browser draws the cell's line
  // at its exact CSS position too, so at fractional pixel ratios both halves
  // are smoothed alike (measured in Chrome at 1.25 and 1.5).
  if (labels.size > 0) {
    for (let r = first; r <= last; r++) {
      const row = layout.rows[r];
      const label = row && labels.get(row.commit.sha);
      if (!row || !label) continue;
      ctx.fillStyle = laneConnectorColor(row.lane, label.head);
      const y = (r - first) * ROW_HEIGHT + ROW_MID - LINE_WIDTH / 2;
      ctx.fillRect(0, y, laneX(row.lane), LINE_WIDTH);
    }
  }

  // Lines and elbows: one path per lane color, in palette order, so where two
  // colors cross, the same one is on top at every scroll position.
  const bySlot: { segment: Segment; top: number }[][] = Array.from(
    { length: LANE_COLOR_COUNT },
    () => [],
  );
  for (let r = first; r <= last; r++) {
    const top = (r - first) * ROW_HEIGHT;
    for (const segment of layout.segmentsAt(r)) {
      bySlot[laneColor(segmentLane(segment))]?.push({ segment, top });
    }
  }
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = "butt";
  bySlot.forEach((list, slot) => {
    if (list.length === 0) return;
    ctx.strokeStyle = laneColorValue(slot);
    ctx.beginPath();
    for (const { segment, top } of list) traceSegment(ctx, segment, top);
    ctx.stroke();
  });

  // Nodes on top: a dot for a merge, an avatar for any other commit.
  for (let r = first; r <= last; r++) {
    const row = layout.rows[r];
    if (!row) continue;
    const x = laneX(row.lane);
    const y = (r - first) * ROW_HEIGHT + ROW_MID;
    const color = laneColorValue(row.lane);
    if (isMergeCommit(row.commit)) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, MERGE_DOT_RADIUS, 0, 2 * Math.PI);
      ctx.fill();
      continue;
    }
    const face = identicon(row.commit.authorEmail);
    ctx.fillStyle = face.background;
    ctx.beginPath();
    ctx.arc(x, y, AVATAR_RADIUS - AVATAR_RING / 2, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = face.color;
    const left = x - FACE_SIDE / 2;
    const faceTop = y - FACE_SIDE / 2;
    for (const [cx, cy] of face.cells) {
      const x0 = snap(left + cx * FACE_CELL);
      const y0 = snap(faceTop + cy * FACE_CELL);
      ctx.fillRect(
        x0,
        y0,
        snap(left + (cx + 1) * FACE_CELL) - x0,
        snap(faceTop + (cy + 1) * FACE_CELL) - y0,
      );
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = AVATAR_RING;
    ctx.beginPath();
    ctx.arc(x, y, AVATAR_RADIUS - AVATAR_RING / 2, 0, 2 * Math.PI);
    ctx.stroke();
  }
}
