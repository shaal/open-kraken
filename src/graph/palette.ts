import { LANE_COLOR_COUNT, laneColor } from "./lanes";

/**
 * One color per lane slot (`lane % LANE_COLOR_COUNT`), chosen to stay apart on
 * the dark background and from each other.
 */
export const LANE_COLORS: readonly string[] = [
  "#4fa8cf", // teal
  "#3f7ff2", // blue
  "#a24bd8", // purple
  "#e0539b", // pink
  "#ef8a3c", // orange
  "#d9bf2b", // yellow
  "#45b86a", // green
  "#e5534b", // red
];

if (LANE_COLORS.length !== LANE_COLOR_COUNT) {
  throw new Error("LANE_COLORS needs one color per lane slot");
}

/** The CSS color of a lane. */
export function laneColorValue(lane: number): string {
  return LANE_COLORS[laneColor(lane)] ?? "#888888";
}

/**
 * A lane's color at 16 % opacity, for the row streak. Computed here, not with
 * CSS `color-mix()`, which older WebKit versions in the Tauri window lack.
 */
export function laneStreakColor(lane: number): string {
  return `${laneColorValue(lane)}29`;
}

/**
 * A ref label's background: the lane color at 30 %, or at 50 % for the
 * commit HEAD points at and for a hovered label. White text on it keeps a
 * contrast of 4.5:1 or more for every lane color, on the table's background
 * and on a hovered row's (palette.test.ts).
 */
export function laneLabelColor(lane: number, active: boolean): string {
  return `${laneColorValue(lane)}${active ? "80" : "4d"}`;
}

/**
 * The line from a ref label to its node: the lane color at 50 %, or the full
 * color for the commit HEAD points at.
 */
export function laneConnectorColor(lane: number, active: boolean): string {
  return active ? laneColorValue(lane) : `${laneColorValue(lane)}80`;
}
