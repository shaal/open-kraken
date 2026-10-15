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
 *
 * Special rows (the WIP row and the stashes, spec §1 Special rows) are placed
 * after all the other rows, in a lane that is free from their row down to their
 * parent's, so they never move a commit's lane; their edges are dotted.
 */

import { temporalTopologicalOrder, type OrderInput } from "./rowOrder";

/** What laying out needs from a row. */
export interface LayoutInput extends OrderInput {
  /**
   * A row that is not a commit: the WIP row or a stash (spec §1 Special rows).
   * Its edges are dotted. When no row has it as a parent, and its only parent
   * in the list (if any) is its first one (always so for WIP and stash rows), it
   * is placed after all the other rows, in the leftmost lane that is free from
   * its row down to its parent (a new lane when none is). Otherwise it is placed
   * like a commit, and where one of its edges shares a lane with a solid edge
   * (they join), the shared part is solid.
   */
  readonly special?: boolean;
}

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
 * Either is `dotted` when only dotted edges run there (refer to `LayoutInput`).
 * A node lane whose halves differ (dotted above, solid below) gets one line
 * per half.
 */
export type Segment =
  | { kind: "line"; lane: number; top: boolean; bottom: boolean; dotted?: true }
  | { kind: "elbow"; from: number; to: number; toward: "up" | "down"; dotted?: true };

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
   * What to draw in row `r`: lines sorted by lane (a node lane's top half before
   * its bottom half), then elbows. Built on demand,
   * so memory stays proportional to rows + edges, not rows × lanes.
   */
  segmentsAt(r: number): Segment[];
}

type Wait = { sha: string; kind: "first" | "merge" };

/** How an edge (or the strongest of the edges sharing a spot) is drawn. */
type Style = typeof NONE | typeof DOTTED | typeof SOLID;
const NONE = 0;
const DOTTED = 1;
const SOLID = 2;
const DOTTED_PROP = { dotted: true } as const;

function lineSegment(lane: number, top: boolean, bottom: boolean, style: number): Segment {
  return { kind: "line", lane, top, bottom, ...(style === DOTTED && DOTTED_PROP) };
}

/** Lays out commits: row order, a lane per commit, and what to draw in each row. */
export function layoutGraph<T extends LayoutInput>(commits: readonly T[]): GraphLayout<T> {
  const ordered = temporalTopologicalOrder(commits);
  const row = new Map(ordered.map((c, i) => [c.sha, i]));

  // Pass 1: a lane for every commit, and the lane every edge travels in. Special
  // rows that can wait (refer to `LayoutInput`) are left for pass 3.
  const deferred: number[] = [];
  const isParent = new Set(ordered.flatMap((c) => c.parents));
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
    // Parents outside the list are ignored; a repeated parent counts once.
    const [firstParent, ...others] = commit.parents;
    const first = firstParent !== undefined && row.has(firstParent) ? firstParent : undefined;
    const merged = [...new Set(others)].filter((p) => p !== firstParent && row.has(p));
    if (commit.special === true && !isParent.has(commit.sha) && merged.length === 0) {
      deferred.push(r);
      laneOf[r] = -1;
      return;
    }
    const lane = firstWait !== -1 ? firstWait : mergeWait !== -1 ? mergeWait : firstEmpty();
    laneOf[r] = lane;
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
  // as bits) the lanes that edges pass straight through. Dotted edges have their
  // own bits, made only when there are special rows; a half or an elbow keeps
  // the strongest style that reaches it (NONE < DOTTED < SOLID). Each deferred
  // row can add a lane at most.
  const rowCount = ordered.length;
  const words = Math.max(1, Math.ceil((lanes.length + deferred.length) / 32));
  const passThrough = new Uint32Array(rowCount * words);
  const dottedThrough = ordered.some((c) => c.special === true)
    ? new Uint32Array(rowCount * words)
    : null;
  const nodeTop = new Uint8Array(rowCount);
  const nodeBottom = new Uint8Array(rowCount);
  const elbows = new Map<number, Map<string, Segment>>();
  const addElbow = (r: number, from: number, to: number, toward: "up" | "down", style: Style) => {
    let cell = elbows.get(r);
    if (!cell) {
      cell = new Map();
      elbows.set(r, cell);
    }
    const key = `${from}>${to}${toward}`;
    if (style === DOTTED && cell.has(key)) return; // a solid one (or this one) is there
    cell.set(key, { kind: "elbow", from, to, toward, ...(style === DOTTED && DOTTED_PROP) });
  };

  const edges: LayoutEdge[] = [];
  ordered.forEach((commit, a) => {
    const childLane = laneOf[a] ?? 0;
    const style: Style = commit.special === true ? DOTTED : SOLID;
    const through = style === DOTTED && dottedThrough ? dottedThrough : passThrough;
    for (const parent of new Set(commit.parents)) {
      const b = row.get(parent);
      const via = edgeLane.get(`${commit.sha}\n${parent}`);
      if (b === undefined || via === undefined) continue;
      const parentLane = laneOf[b] ?? 0;
      edges.push({ childRow: a, parentRow: b, lane: via });
      if (via === childLane) nodeBottom[a] = Math.max(nodeBottom[a] ?? NONE, style);
      else addElbow(a, childLane, via, "down", style);
      const word = via >>> 5;
      const bit = 1 << (via & 31);
      for (let r = a + 1; r < b; r++) {
        through[r * words + word] = (through[r * words + word] ?? 0) | bit;
      }
      if (via === parentLane) nodeTop[b] = Math.max(nodeTop[b] ?? NONE, style);
      else addElbow(b, parentLane, via, "up", style);
    }
  });

  // Pass 3: the deferred special rows, top to bottom. Each takes the leftmost
  // lane that no node or line uses, and no elbow turns into, from its row down
  // to its parent's row (there the parent's own lane is allowed, and no elbow
  // may turn into the lane, so the dotted turn is not hidden under a solid one).
  // When the parent's lane is free, it is that one, so the edge runs straight
  // into the parent's node: a free lane above the parent means nothing waited
  // for the parent there, so it took the first empty lane at its row; every lane
  // left of that one was waiting for a commit further down, so its line runs
  // through the row above the parent.
  let laneCount = lanes.length;
  if (deferred.length > 0 && dottedThrough) {
    // The lanes each row's elbows turn into.
    const turns = new Uint32Array(rowCount * words);
    const addTurn = (r: number, to: number) => {
      const at = r * words + (to >>> 5);
      turns[at] = (turns[at] ?? 0) | (1 << (to & 31));
    };
    for (const [r, cell] of elbows) {
      for (const elbow of cell.values()) {
        if (elbow.kind === "elbow") addTurn(r, elbow.to);
      }
    }
    const used = new Uint32Array(words);
    for (const s of deferred) {
      const parentSha = ordered[s]?.parents.find((p) => row.has(p));
      const p = parentSha === undefined ? undefined : row.get(parentSha);
      used.fill(0);
      for (let r = s; r < (p ?? s + 1); r++) {
        for (let w = 0; w < words; w++) {
          const at = r * words + w;
          used[w] =
            (used[w] ?? 0) | (passThrough[at] ?? 0) | (dottedThrough[at] ?? 0) | (turns[at] ?? 0);
        }
        const node = laneOf[r] ?? -1;
        if (node >= 0) used[node >>> 5] = (used[node >>> 5] ?? 0) | (1 << (node & 31));
      }
      if (p !== undefined) {
        for (let w = 0; w < words; w++) {
          const at = p * words + w;
          used[w] =
            (used[w] ?? 0) | (passThrough[at] ?? 0) | (dottedThrough[at] ?? 0) | (turns[at] ?? 0);
        }
      }
      const free = (lane: number) => ((used[lane >>> 5] ?? 0) & (1 << (lane & 31))) === 0;
      const parentLane = p === undefined ? -1 : (laneOf[p] ?? -1);
      let lane = 0;
      while (!free(lane)) lane += 1; // lane `laneCount` is always free
      laneOf[s] = lane;
      laneCount = Math.max(laneCount, lane + 1);
      if (p === undefined) continue;
      edges.push({ childRow: s, parentRow: p, lane });
      nodeBottom[s] = DOTTED;
      for (let r = s + 1; r < p; r++) {
        const at = r * words + (lane >>> 5);
        dottedThrough[at] = (dottedThrough[at] ?? 0) | (1 << (lane & 31));
      }
      if (lane === parentLane) {
        nodeTop[p] = Math.max(nodeTop[p] ?? NONE, DOTTED);
      } else {
        addElbow(p, parentLane, lane, "up", DOTTED);
      }
    }
  }

  const rows = ordered.map((commit, r): LayoutRow<T> => ({ commit, lane: laneOf[r] ?? 0 }));
  const segmentsAt = (r: number): Segment[] => {
    if (r < 0 || r >= rowCount) return [];
    const nodeLane = laneOf[r] ?? 0;
    const segments: Segment[] = [];
    const top = (nodeTop[r] ?? NONE) as Style;
    const bottom = (nodeBottom[r] ?? NONE) as Style;
    const addNodeLine = () => {
      if (top === NONE || bottom === NONE || top === bottom) {
        segments.push(lineSegment(nodeLane, top !== NONE, bottom !== NONE, Math.max(top, bottom)));
      } else {
        segments.push(lineSegment(nodeLane, true, false, top));
        segments.push(lineSegment(nodeLane, false, true, bottom));
      }
    };
    let nodeLineAdded = top === NONE && bottom === NONE;
    for (let w = 0; w < words; w++) {
      const solid = passThrough[r * words + w] ?? 0;
      let bits = solid | (dottedThrough?.[r * words + w] ?? 0);
      while (bits !== 0) {
        const lowest = bits & -bits;
        const lane = w * 32 + (31 - Math.clz32(lowest));
        bits ^= lowest;
        if (!nodeLineAdded && nodeLane < lane) {
          addNodeLine();
          nodeLineAdded = true;
        }
        segments.push(lineSegment(lane, true, true, (solid & lowest) !== 0 ? SOLID : DOTTED));
      }
    }
    if (!nodeLineAdded) addNodeLine();
    segments.push(...(elbows.get(r)?.values() ?? []));
    return segments;
  };
  return { rows, edges, laneCount, segmentsAt };
}
