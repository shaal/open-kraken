/** Sizes of the commit table, shared by the table and its tests. */

/** Every row has the same height (spec §1 Table). */
export const ROW_HEIGHT = 28;
/** Horizontal space per lane in the Graph column. */
export const LANE_WIDTH = 16;
export const BRANCH_COLUMN_WIDTH = 180;
const MIN_GRAPH_WIDTH = 64;
const MAX_GRAPH_WIDTH = 480;

/** The Graph column fits every lane plus half a lane of margin on each side, within limits. */
export function graphColumnWidth(laneCount: number): number {
  return Math.min(MAX_GRAPH_WIDTH, Math.max(MIN_GRAPH_WIDTH, laneCount * LANE_WIDTH + LANE_WIDTH));
}
