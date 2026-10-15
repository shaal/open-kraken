/**
 * Draws the Graph column (spec §1 Nodes, Edges and lanes, Special rows) for a
 * window of rows onto a canvas: lane lines and elbows, then the nodes on top.
 * One canvas for the rows in the DOM costs about half the main-thread time per
 * frame of an SVG per row (measured: ROADMAP.md, "Graph lanes rendering").
 */

import {
  AVATAR_RADIUS,
  AVATAR_RING,
  DOTTED_EDGE_DASH,
  LINE_WIDTH,
  MERGE_DOT_RADIUS,
  ROW_HEIGHT,
  ROW_MID,
  SPECIAL_NODE_RADIUS,
  STASH_DOT_RADIUS,
  STASH_DOT_STEPS,
  STASH_SIDE,
  WIP_RING_DASHES,
  isMergeCommit,
  laneX,
  segmentLane,
  traceDottedSegment,
  traceSegment,
  type PathSink,
} from "./geometry";
import { IDENTICON_GRID, identicon } from "./identicon";
import { LANE_COLOR_COUNT, laneColor, type GraphLayout, type Segment } from "./lanes";
import { laneColorValue, laneConnectorColor } from "./palette";
import { NO_REF_LABELS, type RefLabels } from "./refLabels";
import type { GraphNode } from "./specialRows";

/** The canvas calls drawing needs (a subset of CanvasRenderingContext2D). */
export interface GraphContext extends PathSink {
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  /** Set back to "source-over" after each use. */
  globalCompositeOperation: GlobalCompositeOperation;
  /** Every dashed stroke sets its pattern and then clears it (`[]`) again. */
  setLineDash(segments: number[]): void;
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

/** The WIP ring's radius (the middle of its outline, like an avatar's ring). */
const WIP_RING_RADIUS = AVATAR_RADIUS - AVATAR_RING / 2;
/** The WIP ring's dashes: 60 % dash, 40 % gap, a whole number around the circle. */
const WIP_RING_PERIOD = (2 * Math.PI * WIP_RING_RADIUS) / WIP_RING_DASHES;
const WIP_RING_DASH = [0.6 * WIP_RING_PERIOD, 0.4 * WIP_RING_PERIOD];
/** Where the ring's pattern starts, so that a dash is centered at the top. */
const WIP_RING_START = -Math.PI / 2 - (0.6 * Math.PI) / WIP_RING_DASHES;

/**
 * Draws rows `first`..`last` (inclusive) with row `first` at y = 0. The
 * canvas is cleared first; `width` is its width in CSS pixels, and `scale`
 * the device pixels per CSS pixel it is drawn at.
 */
export function drawGraphRows(
  ctx: GraphContext,
  layout: GraphLayout<GraphNode>,
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
  // colors cross, the same one is on top at every scroll position. Dotted ones
  // (to the WIP and stash rows) first, so solid lines cover them.
  const solid: Traced[][] = Array.from({ length: LANE_COLOR_COUNT }, () => []);
  const dotted: Traced[][] = Array.from({ length: LANE_COLOR_COUNT }, () => []);
  let anyDotted = false;
  for (let r = first; r <= last; r++) {
    const top = (r - first) * ROW_HEIGHT;
    for (const segment of layout.segmentsAt(r)) {
      anyDotted ||= segment.dotted === true;
      const slots = segment.dotted ? dotted : solid;
      slots[laneColor(segmentLane(segment))]?.push({ segment, top });
    }
  }
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = "butt";
  if (anyDotted) {
    ctx.setLineDash([...DOTTED_EDGE_DASH]);
    strokeSlots(ctx, dotted, traceDottedSegment);
    ctx.setLineDash([]);
  }
  strokeSlots(ctx, solid, traceSegment);

  // Nodes on top: a dot for a merge, an avatar for any other commit, a dashed
  // ring for WIP and a dotted square for a stash.
  for (let r = first; r <= last; r++) {
    const row = layout.rows[r];
    if (!row) continue;
    const x = laneX(row.lane);
    const y = (r - first) * ROW_HEIGHT + ROW_MID;
    const color = laneColorValue(row.lane);
    const node = row.commit;
    if ("kind" in node) {
      if (node.kind === "wip") drawWipNode(ctx, x, y, color);
      else drawStashNode(ctx, x, y, color);
      continue;
    }
    if (isMergeCommit(node)) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, MERGE_DOT_RADIUS, 0, 2 * Math.PI);
      ctx.fill();
      continue;
    }
    const face = identicon(node.authorEmail);
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

/** A segment and the top of its row on the canvas. */
interface Traced {
  segment: Segment;
  top: number;
}

/** Strokes each lane color's segments as one path, in palette order. */
function strokeSlots(
  ctx: GraphContext,
  slots: readonly Traced[][],
  trace: (sink: PathSink, segment: Segment, top: number) => void,
): void {
  slots.forEach((list, slot) => {
    if (list.length === 0) return;
    ctx.strokeStyle = laneColorValue(slot);
    ctx.beginPath();
    for (const { segment, top } of list) trace(ctx, segment, top);
    ctx.stroke();
  });
}

/**
 * Clears the canvas inside a WIP or stash node, so the row's background shows
 * there (hovered or not) and no line runs inside it.
 */
function clearInside(ctx: GraphContext, trace: () => void): void {
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  ctx.beginPath();
  trace();
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

/** The WIP node: a hollow circle with a dashed ring in the lane color. */
function drawWipNode(ctx: GraphContext, x: number, y: number, color: string): void {
  clearInside(ctx, () => ctx.arc(x, y, SPECIAL_NODE_RADIUS, 0, 2 * Math.PI));
  ctx.strokeStyle = color;
  ctx.lineWidth = AVATAR_RING;
  ctx.setLineDash(WIP_RING_DASH);
  ctx.beginPath();
  ctx.arc(x, y, WIP_RING_RADIUS, WIP_RING_START, WIP_RING_START + 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * The stash node: a square of round dots in the lane color with a stash (tray)
 * icon inside. The dots are placed one by one: a dash pattern would start
 * again at each side and shift the corner dots.
 */
function drawStashNode(ctx: GraphContext, x: number, y: number, color: string): void {
  const outer = SPECIAL_NODE_RADIUS;
  clearInside(ctx, () => {
    ctx.moveTo(x - outer, y - outer);
    ctx.lineTo(x + outer, y - outer);
    ctx.lineTo(x + outer, y + outer);
    ctx.lineTo(x - outer, y + outer);
  });
  ctx.fillStyle = color;
  ctx.beginPath();
  const half = STASH_SIDE / 2;
  const step = STASH_SIDE / STASH_DOT_STEPS;
  const dot = (cx: number, cy: number) => {
    ctx.moveTo(cx + STASH_DOT_RADIUS, cy);
    ctx.arc(cx, cy, STASH_DOT_RADIUS, 0, 2 * Math.PI);
  };
  for (let i = 0; i < STASH_DOT_STEPS; i++) {
    // Each side from its first corner, clockwise: every corner is drawn once.
    const t = -half + i * step;
    dot(x + t, y - half);
    dot(x + half, y + t);
    dot(x - t, y + half);
    dot(x - half, y - t);
  }
  ctx.fill();
  // The tray: a body with slanted upper sides, and its opening across the middle.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x - 3.5, y - 4);
  ctx.lineTo(x + 3.5, y - 4);
  ctx.lineTo(x + 6, y + 0.5);
  ctx.lineTo(x + 6, y + 4);
  ctx.lineTo(x - 6, y + 4);
  ctx.lineTo(x - 6, y + 0.5);
  ctx.lineTo(x - 3.5, y - 4);
  ctx.moveTo(x - 6, y + 0.5);
  ctx.lineTo(x - 2.5, y + 0.5);
  ctx.lineTo(x - 1.75, y + 2);
  ctx.lineTo(x + 1.75, y + 2);
  ctx.lineTo(x + 2.5, y + 0.5);
  ctx.lineTo(x + 6, y + 0.5);
  ctx.stroke();
  ctx.lineJoin = "miter";
}
