import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useRef } from "react";
import type { Commit } from "../git/bindings/Commit";
import { BRANCH_COLUMN_WIDTH, graphColumnWidth, ROW_HEIGHT } from "./geometry";
import type { GraphLayout } from "./lanes";

/**
 * Rows rendered above and below the visible ones. They fill the view while a
 * scroll of up to this many rows waits for the next render.
 */
const OVERSCAN = 10;

export interface CommitGraphProps {
  layout: GraphLayout<Commit>;
}

/**
 * The commit table (spec §1 Table): Branch / Tag, Graph and Commit message
 * columns under a header row, one constant-height row per commit, and a gear
 * button at the right end of the header. Only the rows in view (plus a few
 * around them) are in the DOM, so very long histories scroll smoothly.
 *
 * A read-only `table` for now: the selection and keyboard task makes it an
 * interactive `grid`.
 */
export function CommitGraph({ layout }: CommitGraphProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = layout.rows;
  // The compiler cannot memoize this component because of the virtualizer's
  // functions; nothing here is passed to memoized children, so that is fine.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const columns = `${BRANCH_COLUMN_WIDTH}px ${graphColumnWidth(layout.laneCount)}px minmax(0, 1fr)`;

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
        >
          <div className="commit-graph-rows" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <CommitRow
                  key={row.commit.sha}
                  commit={row.commit}
                  index={item.index}
                  top={item.start}
                  columns={columns}
                />
              );
            })}
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
  commit: Commit;
  index: number;
  /** Pixels from the top of the scroll area. */
  top: number;
  columns: string;
}

/** One commit row. Memoized: while scrolling, only rows that come into view render. */
const CommitRow = memo(function CommitRow({ commit, index, top, columns }: CommitRowProps) {
  return (
    <div
      className="commit-row"
      role="row"
      aria-rowindex={index + 2}
      data-row-index={index}
      style={{
        gridTemplateColumns: columns,
        height: ROW_HEIGHT,
        transform: `translateY(${top}px)`,
      }}
    >
      <div role="cell" className="commit-refs" />
      <div role="cell" className="commit-lanes" />
      <div role="cell" className="commit-message" title={commit.subject}>
        {commit.subject}
      </div>
    </div>
  );
});

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
