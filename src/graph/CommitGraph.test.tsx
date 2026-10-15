import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureAdapter } from "../git/fixtureAdapter";
import { syntheticGraph } from "../git/syntheticAdapter";
import { CommitGraph } from "./CommitGraph";
import { BRANCH_COLUMN_WIDTH, graphColumnWidth, LANE_WIDTH, ROW_HEIGHT } from "./geometry";
import { layoutGraph } from "./lanes";

/** jsdom has no layout: give the scrolling body a real height, like a 560 px tall view. */
const VIEW_HEIGHT = 560;
const VISIBLE_ROWS = VIEW_HEIGHT / ROW_HEIGHT; // 20
const OVERSCAN = 10;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("commit-graph-body") ? VIEW_HEIGHT : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("commit-graph-body") ? 1000 : 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The rendered row indexes, in DOM order. */
function renderedRows(): number[] {
  return [...document.querySelectorAll<HTMLElement>("[data-row-index]")].map((row) =>
    Number(row.dataset.rowIndex),
  );
}

async function demoLayout() {
  const adapter = createFixtureAdapter();
  return layoutGraph((await adapter.graphData("demo-repo")).log);
}

function scrollBodyTo(top: number) {
  const body = screen.getByTestId("commit-graph-body");
  body.scrollTop = top;
  expect(body.scrollTop).toBe(top); // jsdom keeps the value; otherwise this test measures nothing
  act(() => {
    fireEvent.scroll(body);
  });
}

describe("CommitGraph", () => {
  it("has a header row with the three columns and a gear button", async () => {
    render(<CommitGraph layout={await demoLayout()} />);
    const table = screen.getByRole("table", { name: "Commit graph" });
    const header = within(table).getAllByRole("row")[0];
    if (!header) throw new Error("no header row");
    const columns = within(header).getAllByRole("columnheader");
    expect(columns.map((c) => c.textContent)).toEqual(["Branch / Tag", "Graph", "Commit message"]);
    // The gear has its own name, not part of a column header's, and has no menu yet.
    const gear = screen.getByRole("button", { name: "Column settings" });
    expect(gear.closest("[role=columnheader]")).toBeNull();
    expect((gear as HTMLButtonElement).disabled).toBe(true);
    expect(within(table).getByRole("rowgroup", { name: "Commits" }).tabIndex).toBe(0);
  });

  it("shows every demo commit in row order, one message per row", async () => {
    const layout = await demoLayout();
    render(<CommitGraph layout={layout} />);
    expect(renderedRows()).toEqual(layout.rows.map((_, i) => i));
    const messages = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector(".commit-message")?.textContent);
    expect(messages).toEqual(layout.rows.map((r) => r.commit.subject));
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe(
      String(layout.rows.length + 1),
    );
  });

  it("places rows at constant height steps and sizes the scroll area for all rows", async () => {
    const layout = await demoLayout();
    render(<CommitGraph layout={layout} />);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-row-index]")];
    expect(rows.length).toBe(layout.rows.length);
    rows.forEach((row, i) => {
      expect(row.style.transform).toBe(`translateY(${i * ROW_HEIGHT}px)`);
      expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
    });
    const spacer = document.querySelector<HTMLElement>(".commit-graph-rows");
    expect(spacer?.style.height).toBe(`${layout.rows.length * ROW_HEIGHT}px`);
  });

  it("sizes the Graph column from the lane count, the same in the header and every row", async () => {
    const layout = await demoLayout();
    render(<CommitGraph layout={layout} />);
    const expected = `${BRANCH_COLUMN_WIDTH}px ${graphColumnWidth(layout.laneCount)}px minmax(0, 1fr)`;
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(layout.rows.length + 1);
    for (const row of rows) {
      expect(row.style.gridTemplateColumns).toBe(expected);
    }
    expect(graphColumnWidth(0)).toBe(64);
    expect(graphColumnWidth(10)).toBe(11 * LANE_WIDTH);
    expect(graphColumnWidth(1000)).toBe(480);
  });

  describe("with 50 000 commits", () => {
    const layout = layoutGraph(syntheticGraph(50_000).log);
    const maxRows = VISIBLE_ROWS + 2 * OVERSCAN + 2;

    it("renders only the rows in view plus the overscan", () => {
      render(<CommitGraph layout={layout} />);
      const rows = renderedRows();
      expect(rows[0]).toBe(0);
      expect(rows.length).toBeGreaterThanOrEqual(VISIBLE_ROWS);
      expect(rows.length).toBeLessThanOrEqual(maxRows);
      expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe("50001");
      const spacer = document.querySelector<HTMLElement>(".commit-graph-rows");
      expect(spacer?.style.height).toBe(`${50_000 * ROW_HEIGHT}px`);
    });

    it("renders the rows at the new position after scrolling, and drops the old ones", () => {
      render(<CommitGraph layout={layout} />);
      const target = 25_000;
      scrollBodyTo(target * ROW_HEIGHT);
      const rows = renderedRows();
      expect(rows).toContain(target);
      expect(rows).toContain(target + VISIBLE_ROWS - 1);
      expect(rows).not.toContain(0);
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(target - OVERSCAN);
      expect(rows.length).toBeLessThanOrEqual(maxRows);
      const row = document.querySelector<HTMLElement>(`[data-row-index="${target}"]`);
      expect(row?.style.transform).toBe(`translateY(${target * ROW_HEIGHT}px)`);
      expect(row?.getAttribute("aria-rowindex")).toBe(String(target + 2));
      expect(row?.textContent).toBe(layout.rows[target]?.commit.subject);
    });

    it("reaches the last row", () => {
      render(<CommitGraph layout={layout} />);
      scrollBodyTo(50_000 * ROW_HEIGHT - VIEW_HEIGHT);
      const rows = renderedRows();
      expect(Math.max(...rows)).toBe(49_999);
      expect(rows.length).toBeLessThanOrEqual(maxRows);
    });
  });
});
