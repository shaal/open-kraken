/** Sizes of the commit table and of the graph drawn in it. */

import type { Segment } from "./lanes";

/** What node drawing needs from a commit. */
interface NodeInput {
  parents: readonly string[];
}

/** Every row has the same height (spec §1 Table). */
export const ROW_HEIGHT = 28;
/** The vertical center of a row, where nodes sit and elbows turn. */
export const ROW_MID = ROW_HEIGHT / 2;
/** Horizontal space per lane in the Graph column. */
export const LANE_WIDTH = 22;
/** Space between the Graph column's edges and the outermost lanes. */
export const GRAPH_PADDING = 8;
export const BRANCH_COLUMN_WIDTH = 180;
const MIN_GRAPH_WIDTH = 64;
const MAX_GRAPH_WIDTH = 480;

/** Outer radius of an author avatar, ring included. */
export const AVATAR_RADIUS = 10;
/** Width of the lane-colored ring around an avatar. */
export const AVATAR_RING = 2;
/** Radius of a merge commit's dot. */
export const MERGE_DOT_RADIUS = 5;
/** Radius of an elbow's rounded corner: under half a row and under a lane. */
export const ELBOW_RADIUS = 8;
/** Width of lane lines and edges. */
export const LINE_WIDTH = 2;

/** The Graph column fits every lane plus the padding, within limits. */
export function graphColumnWidth(laneCount: number): number {
  const needed = 2 * GRAPH_PADDING + laneCount * LANE_WIDTH;
  return Math.min(MAX_GRAPH_WIDTH, Math.max(MIN_GRAPH_WIDTH, needed));
}

/** A merge commit (two or more parents) is drawn as a dot; any other commit as an avatar. */
export function isMergeCommit(commit: NodeInput): boolean {
  return commit.parents.length > 1;
}

/** The lane whose color a segment takes: its own lane, or for an elbow the lane it turns into. */
export function segmentLane(segment: Segment): number {
  return segment.kind === "line" ? segment.lane : segment.to;
}

/** The x of a lane's center in the Graph column, on a whole pixel. */
export function laneX(lane: number): number {
  return GRAPH_PADDING + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/** The path calls segments are drawn with (a subset of CanvasRenderingContext2D). */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
}

/**
 * Traces one segment of row `top` (the row's top edge, in px) into `sink`
 * (refer to `Segment` in lanes.ts). Vertical lines run to the row's top and
 * bottom edges exactly, so neighboring rows join without a seam. An elbow runs
 * across from the node at the row's center, turns into lane `to` with a
 * rounded corner, and runs to the top edge (up) or the bottom edge (down).
 */
export function traceSegment(sink: PathSink, segment: Segment, top = 0): void {
  if (segment.kind === "line") {
    if (!segment.top && !segment.bottom) return;
    const x = laneX(segment.lane);
    sink.moveTo(x, top + (segment.top ? 0 : ROW_MID));
    sink.lineTo(x, top + (segment.bottom ? ROW_HEIGHT : ROW_MID));
    return;
  }
  if (segment.from === segment.to) return;
  const from = laneX(segment.from);
  const to = laneX(segment.to);
  const edge = top + (segment.toward === "down" ? ROW_HEIGHT : 0);
  sink.moveTo(from, top + ROW_MID);
  sink.arcTo(to, top + ROW_MID, to, edge, ELBOW_RADIUS);
  sink.lineTo(to, edge);
}
