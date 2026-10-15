import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Commit } from "../git/bindings/Commit";
import {
  BRANCH_COLUMN_WIDTH,
  graphColumnWidth,
  isMergeCommit,
  laneX,
  ROW_HEIGHT,
} from "./geometry";
import { GraphCanvas } from "./GraphCanvas";
import type { GraphLayout } from "./lanes";
import { laneColorValue, laneConnectorColor, laneStreakColor } from "./palette";
import { RefLabelContent } from "./RefLabel";
import { NO_REF_LABELS, type CommitLabels, type RefLabels } from "./refLabels";

/**
 * Rows rendered above and below the visible ones. They fill the view while a
 * scroll of up to this many rows waits for the next render.
 */
const OVERSCAN = 10;

export interface CommitGraphProps {
  layout: GraphLayout<Commit>;
  /** The Branch / Tag column's labels (`buildRefLabels`); none when left out. */
  labels?: RefLabels;
}

/**
 * Sets or clears the hovered ref label. Clearing leaves another row's hover
 * alone, and keeps the hover while `pointer` is still on the label's expanded copy.
 */
type LabelHover = (sha: string, hovered: boolean, pointer?: { x: number; y: number }) => void;

/**
 * The commit table (spec §1 Table): Branch / Tag, Graph and Commit message
 * columns under a header row, one constant-height row per commit, and a gear
 * button at the right end of the header. Only the rows in view (plus a few
 * around them) are in the DOM, so very long histories scroll smoothly.
 *
 * A read-only `table` for now: the selection and keyboard task makes it an
 * interactive `grid`.
 */
export function CommitGraph({ layout, labels = NO_REF_LABELS }: CommitGraphProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = layout.rows;
  // The commit whose ref label the pointer is on: its label is drawn expanded
  // above the canvas, which a row's own content cannot be. The expanded copy
  // takes no pointer events (presses, drags and text selection go to the row
  // under it), so the hover lasts while the pointer is inside the copy's box.
  const [hovered, setHovered] = useState<string | null>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  /** The pointer's last position over the table, or null when it is outside. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const onCopy = useCallback((x: number, y: number) => {
    const box = copyRef.current?.getBoundingClientRect();
    return box !== undefined && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
  }, []);
  const onLabelHover = useCallback<LabelHover>(
    (sha, on, pointer) => {
      if (!on && pointer && onCopy(pointer.x, pointer.y)) return;
      setHovered((current) => (on ? sha : current === sha ? null : current));
    },
    [onCopy],
  );
  /** Ends the hover once the pointer is off the expanded copy. */
  const leaveCopy = (x: number, y: number) => {
    const sha = copyRef.current?.dataset.sha;
    // Only that copy's hover: a label entered in the meantime keeps its own.
    if (sha && !onCopy(x, y)) setHovered((current) => (current === sha ? null : current));
  };
  // The compiler cannot memoize this component because of the virtualizer's
  // functions. That is fine: what the memoized rows get is stable by itself
  // (the layout and labels per load, onLabelHover from useCallback).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const graphWidth = graphColumnWidth(layout.laneCount);
  const items = virtualizer.getVirtualItems();
  const firstItem = items[0];
  const lastItem = items.at(-1);
  const columns = `${BRANCH_COLUMN_WIDTH}px ${graphWidth}px minmax(0, 1fr)`;
  const hoveredItem =
    hovered === null ? undefined : items.find((item) => rows[item.index]?.commit.sha === hovered);
  const hoveredRow = hoveredItem && rows[hoveredItem.index];
  const hoveredLabels = hoveredRow && labels.get(hoveredRow.commit.sha);

  return (
    <div className="commit-graph">
      <div
        className="commit-graph-table"
        role="table"
        aria-label="Commit graph"
        aria-rowcount={rows.length + 1}
        aria-colcount={3}
      >
        <div
          className="commit-graph-header"
          role="row"
          aria-rowindex={1}
          style={{ gridTemplateColumns: columns, height: ROW_HEIGHT }}
        >
          <div role="columnheader">Branch / Tag</div>
          <div role="columnheader">Graph</div>
          <div role="columnheader">Commit message</div>
        </div>
        <div
          ref={scrollRef}
          className="commit-graph-body"
          role="rowgroup"
          aria-label="Commits"
          // Lets keyboard users scroll: WebKit does not make scrollers focusable.
          tabIndex={0}
          data-testid="commit-graph-body"
          onMouseMove={(e) => {
            pointer.current = { x: e.clientX, y: e.clientY };
            leaveCopy(e.clientX, e.clientY);
          }}
          onMouseLeave={() => {
            pointer.current = null;
            setHovered(null);
          }}
          // The rows move under a still pointer, and Chrome sends no mouse move
          // for that: check the copy against the last pointer position.
          onScroll={() => pointer.current && leaveCopy(pointer.current.x, pointer.current.y)}
        >
          <div className="commit-graph-rows" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <CommitRow
                  key={row.commit.sha}
                  layout={layout}
                  labels={labels}
                  onLabelHover={onLabelHover}
                  index={item.index}
                  top={item.start}
                  columns={columns}
                />
              );
            })}
            {firstItem && lastItem && (
              <GraphCanvas
                layout={layout}
                first={firstItem.index}
                last={lastItem.index}
                top={firstItem.start}
                left={BRANCH_COLUMN_WIDTH}
                width={graphWidth}
                labels={labels}
              />
            )}
            {hoveredItem && hoveredRow && hoveredLabels && (
              // A copy of the hovered label, after the canvas so it is drawn above it.
              <div
                ref={copyRef}
                className="ref-overlay"
                aria-hidden="true"
                data-sha={hoveredRow.commit.sha}
                style={{ top: hoveredItem.start, height: ROW_HEIGHT }}
              >
                <RefLabelContent labels={hoveredLabels} lane={hoveredRow.lane} active />
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Outside the table, so it is not part of a column header's name. The
          column menu (spec §3.10) comes with the column header task. */}
      <button
        type="button"
        className="icon-button commit-graph-settings"
        aria-label="Column settings"
        title="Column settings"
        style={{ height: ROW_HEIGHT }}
        disabled
      >
        <GearIcon />
      </button>
    </div>
  );
}

interface CommitRowProps {
  /** The whole layout (a stable object), so the memo below holds while scrolling. */
  layout: GraphLayout<Commit>;
  /** All labels (a stable object, like the layout). */
  labels: RefLabels;
  onLabelHover: LabelHover;
  index: number;
  /** Pixels from the top of the scroll area. */
  top: number;
  columns: string;
}

/** One commit row. Memoized: while scrolling, only rows that come into view render. */
const CommitRow = memo(function CommitRow({
  layout,
  labels,
  onLabelHover,
  index,
  top,
  columns,
}: CommitRowProps) {
  const row = layout.rows[index];
  if (!row) return null;
  const rowLabels = labels.get(row.commit.sha);
  const style = {
    gridTemplateColumns: columns,
    height: ROW_HEIGHT,
    transform: `translateY(${top}px)`,
    // The streak and the message cell's bar (spec §1 Edges and lanes) take the
    // node's lane color; the streak starts at the node.
    "--lane-color": laneColorValue(row.lane),
    "--streak-color": laneStreakColor(row.lane),
    "--node-x": `${laneX(row.lane)}px`,
  } as CSSProperties;
  return (
    <div
      className="commit-row"
      role="row"
      aria-rowindex={index + 2}
      data-row-index={index}
      data-lane={row.lane}
      data-node-kind={isMergeCommit(row.commit) ? "merge" : "commit"}
      style={style}
    >
      <div role="cell" className="commit-refs">
        {rowLabels && (
          <RefCell
            sha={row.commit.sha}
            lane={row.lane}
            labels={rowLabels}
            onLabelHover={onLabelHover}
          />
        )}
      </div>
      {/* Drawn by GraphCanvas, over this cell; the label names the node for screen readers. */}
      <div
        role="cell"
        className="commit-lanes"
        aria-label={isMergeCommit(row.commit) ? "Merge commit" : "Commit"}
      />
      <div role="cell" className="commit-message" title={row.commit.subject}>
        {row.commit.subject}
      </div>
    </div>
  );
});

interface RefCellProps {
  sha: string;
  lane: number;
  labels: CommitLabels;
  onLabelHover: LabelHover;
}

/**
 * The Branch / Tag cell of a commit with refs: the label, then a line to the
 * column's right edge, where the canvas continues it to the node.
 */
function RefCell({ sha, lane, labels, onLabelHover }: RefCellProps) {
  // A row scrolled out of the DOM gets no mouseleave: drop its hover here.
  useEffect(() => () => onLabelHover(sha, false), [sha, onLabelHover]);
  return (
    <>
      <span
        className="ref-label"
        data-sha={sha}
        onMouseEnter={() => onLabelHover(sha, true)}
        onMouseLeave={(e) => onLabelHover(sha, false, { x: e.clientX, y: e.clientY })}
      >
        <RefLabelContent labels={labels} lane={lane} active={labels.head} />
      </span>
      <span
        className="ref-connector"
        style={{ backgroundColor: laneConnectorColor(lane, labels.head) }}
      />
    </>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M9.4 1l.3 1.8c.5.2.9.4 1.3.7l1.7-.7 1.4 2.4-1.4 1.1c.1.5.1 1 0 1.5l1.4 1.1-1.4 2.4-1.7-.7c-.4.3-.8.5-1.3.7L9.4 15H6.6l-.3-1.8c-.5-.2-.9-.4-1.3-.7l-1.7.7-1.4-2.4 1.4-1.1a4 4 0 010-1.5L1.9 7.2l1.4-2.4 1.7.7c.4-.3.8-.5 1.3-.7L6.6 1h2.8zM8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"
      />
    </svg>
  );
}
