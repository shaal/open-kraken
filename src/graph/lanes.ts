/**
 * Lanes (columns) and edges for the commit graph (spec §6.2–6.4, §1 Edges).
 *
 * Rows come from the temporal topological order. Going down the rows, every lane
 * is either empty or "waiting" for one commit below:
 * - a commit's own lane waits for its first parent, so a branch is a straight line;
 * - at a merge, each other parent gets a lane at once (an existing lane already
 *   waiting for that parent, else the first empty one, else a new one).
 * A commit takes the leftmost lane waiting for it as a first parent (else one
 * waiting for it as a merged parent, else the first empty lane); the other lanes
 * waiting for it end there. Lanes are only emptied, never removed, so lane
 * numbers never shift. A waiting lane belongs to one commit, so no edge can pass
 * through another commit's node.
 *
 * This reproduces the lanes GitKraken showed for the demo repository.
 */

import { temporalTopologicalOrder, type OrderInput } from "./rowOrder";

/** How many lane colors the palette has; lane `n` uses color `n % LANE_COLOR_COUNT`. */
export const LANE_COLOR_COUNT = 8;

/** The palette index for a lane. Lines and nodes take the color of their lane. */
export function laneColor(lane: number): number {
  return lane % LANE_COLOR_COUNT;
}

/**
 * Something to draw in one row cell. Coordinates are lanes; the node sits at
 * the vertical center of its row.
 * - `line`: a vertical line in `lane`, from the top edge to the center (`top`)
 *   and/or from the center to the bottom edge (`bottom`).
 * - `elbow`: a horizontal line at the center from the node lane `from` to lane
 *   `to`, then a rounded turn into `to`, going up to the top edge or down to the
 *   bottom edge. Colored like lane `to` (the lane the edge travels in).
 */
export type Segment =
  | { kind: "line"; lane: number; top: boolean; bottom: boolean }
  | { kind: "elbow"; from: number; to: number; toward: "up" | "down" };

export interface LayoutRow<T> {
  commit: T;
  /** The lane of this row's node. */
  lane: number;
}

/** One parent link: from the child's row down to the parent's row, through `lane`. */
export interface LayoutEdge {
  childRow: number;
  parentRow: number;
  /** The lane the edge runs in between the two rows. */
  lane: number;
}

export interface GraphLayout<T> {
  rows: LayoutRow<T>[];
  edges: LayoutEdge[];
  /** How many lanes the widest row needs. */
  laneCount: number;
  /**
   * What to draw in row `r`: lines sorted by lane, then elbows. Built on demand,
   * so memory stays proportional to rows + edges, not rows × lanes.
   */
  segmentsAt(r: number): Segment[];
}

type Wait = { sha: string; kind: "first" | "merge" };

/** Lays out commits: row order, a lane per commit, and what to draw in each row. */
export function layoutGraph<T extends OrderInput>(commits: readonly T[]): GraphLayout<T> {
  const ordered = temporalTopologicalOrder(commits);
  const row = new Map(ordered.map((c, i) => [c.sha, i]));

  // Pass 1: a lane for every commit, and the lane every edge travels in.
  const lanes: (Wait | null)[] = [];
  const laneOf: number[] = [];
  const edgeLane = new Map<string, number>(); // `${child}\n${parent}` -> lane
  const firstEmpty = () => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  ordered.forEach((commit, r) => {
    let firstWait = -1;
    let mergeWait = -1;
    lanes.forEach((wait, j) => {
      if (wait?.sha !== commit.sha) return;
      if (wait.kind === "first" && firstWait === -1) firstWait = j;
      if (wait.kind === "merge" && mergeWait === -1) mergeWait = j;
      lanes[j] = null; // the edges waiting here end at this commit
    });
    const lane = firstWait !== -1 ? firstWait : mergeWait !== -1 ? mergeWait : firstEmpty();
    laneOf[r] = lane;

    // Parents outside the list are ignored; a repeated parent counts once.
    const [firstParent, ...others] = commit.parents;
    const first = firstParent !== undefined && row.has(firstParent) ? firstParent : undefined;
    const merged = [...new Set(others)].filter((p) => p !== firstParent && row.has(p));
    // Hold the node's lane while placing merged parents: straight down from a
    // node always means "first parent", even when the first parent is missing.
    lanes[lane] =
      first !== undefined ? { sha: first, kind: "first" } : { sha: commit.sha, kind: "first" };
    if (first !== undefined) {
      edgeLane.set(`${commit.sha}\n${first}`, lane);
    }
    for (const parent of merged) {
      let target = lanes.findIndex((wait) => wait?.sha === parent);
      if (target === -1) {
        target = firstEmpty();
        lanes[target] = { sha: parent, kind: "merge" };
      }
      edgeLane.set(`${commit.sha}\n${parent}`, target);
    }
    if (first === undefined) lanes[lane] = null;
  });

  // Pass 2: for every row, the node lane's line halves, the elbows, and (packed
  // as bits) the lanes that edges pass straight through.
  const rowCount = ordered.length;
  const words = Math.max(1, Math.ceil(lanes.length / 32));
  const passThrough = new Uint32Array(rowCount * words);
  const nodeTop = new Uint8Array(rowCount);
  const nodeBottom = new Uint8Array(rowCount);
  const elbows = new Map<number, Map<string, Segment>>();
  const addElbow = (r: number, from: number, to: number, toward: "up" | "down") => {
    let cell = elbows.get(r);
    if (!cell) {
      cell = new Map();
      elbows.set(r, cell);
    }
    cell.set(`${from}>${to}${toward}`, { kind: "elbow", from, to, toward });
  };

  const edges: LayoutEdge[] = [];
  ordered.forEach((commit, a) => {
    const childLane = laneOf[a] ?? 0;
    for (const parent of new Set(commit.parents)) {
      const b = row.get(parent);
      const via = edgeLane.get(`${commit.sha}\n${parent}`);
      if (b === undefined || via === undefined) continue;
      const parentLane = laneOf[b] ?? 0;
      edges.push({ childRow: a, parentRow: b, lane: via });
      if (via === childLane) nodeBottom[a] = 1;
      else addElbow(a, childLane, via, "down");
      const word = via >>> 5;
      const bit = 1 << (via & 31);
      for (let r = a + 1; r < b; r++) {
        passThrough[r * words + word] = (passThrough[r * words + word] ?? 0) | bit;
      }
      if (via === parentLane) nodeTop[b] = 1;
      else addElbow(b, parentLane, via, "up");
    }
  });

  const rows = ordered.map((commit, r): LayoutRow<T> => ({ commit, lane: laneOf[r] ?? 0 }));
  const segmentsAt = (r: number): Segment[] => {
    if (r < 0 || r >= rowCount) return [];
    const nodeLane = laneOf[r] ?? 0;
    const segments: Segment[] = [];
    const top = nodeTop[r] === 1;
    const bottom = nodeBottom[r] === 1;
    let nodeLineAdded = !(top || bottom);
    for (let w = 0; w < words; w++) {
      let bits = passThrough[r * words + w] ?? 0;
      while (bits !== 0) {
        const lowest = bits & -bits;
        const lane = w * 32 + (31 - Math.clz32(lowest));
        bits ^= lowest;
        if (!nodeLineAdded && nodeLane < lane) {
          segments.push({ kind: "line", lane: nodeLane, top, bottom });
          nodeLineAdded = true;
        }
        segments.push({ kind: "line", lane, top: true, bottom: true });
      }
    }
    if (!nodeLineAdded) segments.push({ kind: "line", lane: nodeLane, top, bottom });
    segments.push(...(elbows.get(r)?.values() ?? []));
    return segments;
  };
  return { rows, edges, laneCount: lanes.length, segmentsAt };
}
