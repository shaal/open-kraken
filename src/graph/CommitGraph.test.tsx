import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureAdapter } from "../git/fixtureAdapter";
import { syntheticGraph } from "../git/syntheticAdapter";
import { CommitGraph } from "./CommitGraph";
import {
  BRANCH_COLUMN_WIDTH,
  graphColumnWidth,
  isMergeCommit,
  LANE_WIDTH,
  laneX,
  ROW_HEIGHT,
} from "./geometry";
import { layoutGraph } from "./lanes";
import { laneColorValue, laneStreakColor } from "./palette";
import { RecordingContext } from "../test/recordingContext";

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
    expect(LANE_WIDTH).toBe(22);
    expect(graphColumnWidth(0)).toBe(64); // the minimum
    expect(graphColumnWidth(2)).toBe(64);
    expect(graphColumnWidth(3)).toBe(82); // 8 + 3 × 22 + 8
    expect(graphColumnWidth(10)).toBe(236);
    expect(graphColumnWidth(21)).toBe(478);
    expect(graphColumnWidth(22)).toBe(480); // the maximum: lanes past 21 are cut off
    expect(graphColumnWidth(1000)).toBe(480);
  });

  describe("graph drawing (spec §1 Nodes, Edges and lanes)", () => {
    /** The demo rows as rendered, with the canvas context the graph was drawn on. */
    async function renderedDemo() {
      const ctx = new RecordingContext();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        () => ctx as unknown as CanvasRenderingContext2D,
      );
      const layout = await demoLayout();
      render(<CommitGraph layout={layout} />);
      const rows = [...document.querySelectorAll<HTMLElement>("[data-row-index]")];
      expect(rows).toHaveLength(layout.rows.length);
      return { layout, rows, ctx };
    }

    it("marks each row's node kind: a dot for a merge, an avatar for any other commit", async () => {
      const { layout, rows } = await renderedDemo();
      expect(rows.map((r) => r.dataset.nodeKind)).toEqual(
        layout.rows.map((r) => (isMergeCommit(r.commit) ? "merge" : "commit")),
      );
      expect(rows.filter((r) => r.dataset.nodeKind === "merge")).toHaveLength(2);
    });

    it("gives each row's streak and message bar the node's lane color and position", async () => {
      const { layout, rows } = await renderedDemo();
      rows.forEach((row, i) => {
        const lane = layout.rows[i]?.lane ?? -1;
        expect(row.dataset.lane).toBe(String(lane));
        expect(row.style.getPropertyValue("--lane-color")).toBe(laneColorValue(lane));
        expect(row.style.getPropertyValue("--node-x")).toBe(`${laneX(lane)}px`);
        expect(row.style.getPropertyValue("--streak-color")).toBe(laneStreakColor(lane));
      });
      // The demo repo's lanes, as GitKraken showed them: main 0, graph-view and login 1,
      // release and bugfix 2.
      expect(rows.map((r) => r.dataset.lane).join("")).toBe("0100211010210112000");
    });

    it("names each row's node for screen readers, since the canvas is hidden from them", async () => {
      const { layout, rows } = await renderedDemo();
      rows.forEach((row, i) => {
        const cell = row.querySelector(".commit-lanes");
        expect(cell?.getAttribute("role")).toBe("cell");
        expect(cell?.getAttribute("aria-label")).toBe(
          isMergeCommit(layout.rows[i]?.commit ?? { parents: [] }) ? "Merge commit" : "Commit",
        );
      });
      // The row's text is still just the subject.
      expect(rows[0]?.textContent).toBe(layout.rows[0]?.commit.subject);
    });

    describe("device pixel ratio", () => {
      const original = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
      const setRatio = (value: number) =>
        Object.defineProperty(window, "devicePixelRatio", { value, configurable: true });
      /** Media queries the graph asked for, with the listeners added and removed. */
      let queries: { media: string; added: (() => void)[]; removed: (() => void)[] }[] = [];

      beforeEach(() => {
        queries = [];
        vi.stubGlobal("matchMedia", (media: string) => {
          const entry = { media, added: [] as (() => void)[], removed: [] as (() => void)[] };
          queries.push(entry);
          return {
            media,
            matches: media === `(resolution: ${window.devicePixelRatio}dppx)`,
            addEventListener: (_: string, l: () => void) => entry.added.push(l),
            removeEventListener: (_: string, l: () => void) => entry.removed.push(l),
          };
        });
      });

      afterEach(() => {
        vi.unstubAllGlobals();
        if (original) Object.defineProperty(window, "devicePixelRatio", original);
      });

      async function renderAt(ratio: number) {
        setRatio(ratio);
        const { layout, ctx } = await renderedDemo();
        const width = graphColumnWidth(layout.laneCount);
        const canvas = document.querySelector<HTMLCanvasElement>("canvas.commit-graph-canvas");
        if (!canvas) throw new Error("no graph canvas");
        const size = () => [canvas.width, canvas.height];
        return { width, canvas, ctx, size };
      }

      it("draws at the screen's pixel ratio", async () => {
        const { width, ctx, size } = await renderAt(2);
        expect(size()).toEqual([2 * width, 2 * 19 * ROW_HEIGHT]);
        expect(ctx.named("setTransform").at(-1)?.args).toEqual([2, 0, 0, 2, 0, 0]);
        expect(queries.map((q) => q.media)).toEqual(["(resolution: 2dppx)"]);
      });

      it("redraws when a resize reports a new ratio, and stops listening to the old one", async () => {
        const { width, ctx, size } = await renderAt(2);
        const first = queries[0];
        setRatio(1); // the window moved to a display with 1 pixel per CSS pixel
        act(() => {
          window.dispatchEvent(new Event("resize"));
        });
        expect(size()).toEqual([width, 19 * ROW_HEIGHT]);
        expect(ctx.named("setTransform").at(-1)?.args).toEqual([1, 0, 0, 1, 0, 0]);
        expect(ctx.named("clearRect")).toHaveLength(2); // drawn again at once
        expect(first?.removed).toEqual(first?.added); // the 2dppx listener is gone
        expect(queries.at(-1)?.media).toBe("(resolution: 1dppx)");
      });

      it("draws identicon cells on device pixels at the screen's ratio", async () => {
        const { ctx } = await renderAt(1.5);
        const rects = ctx.named("fillRect");
        expect(rects.length).toBeGreaterThan(0);
        for (const { args } of rects) {
          const [x, y, w, h] = args as [number, number, number, number];
          for (const edge of [x, y, x + w, y + h]) {
            expect(Math.abs(edge * 1.5 - Math.round(edge * 1.5))).toBeLessThan(1e-9);
          }
        }
      });

      it("removes its window listener when the graph goes away", async () => {
        const added = vi.spyOn(window, "addEventListener");
        const removed = vi.spyOn(window, "removeEventListener");
        const { unmount } = render(<CommitGraph layout={await demoLayout()} />);
        const resizeAdded = added.mock.calls.filter(([type]) => type === "resize").map((c) => c[1]);
        expect(resizeAdded).toHaveLength(1);
        unmount();
        const resizeRemoved = removed.mock.calls
          .filter(([type]) => type === "resize")
          .map((c) => c[1]);
        expect(resizeRemoved).toEqual(resizeAdded);
      });

      it("redraws on a resize even back to a ratio it had before", async () => {
        const { width, size, ctx } = await renderAt(2);
        const rerenderWithoutEvent = () =>
          act(() => {
            // A scroll elsewhere: any render reads the live ratio.
            scrollBodyTo(0);
          });
        setRatio(1.5); // no event at all, as in Chrome
        rerenderWithoutEvent();
        setRatio(2);
        act(() => {
          window.dispatchEvent(new Event("resize"));
        });
        expect(size()).toEqual([2 * width, 2 * 19 * ROW_HEIGHT]);
        expect(ctx.named("setTransform").at(-1)?.args).toEqual([2, 0, 0, 2, 0, 0]);
      });

      it("sizes the canvas box to its whole-pixel bitmap at fractional ratios", async () => {
        const { width, canvas } = await renderAt(1.25);
        expect(width * 1.25).not.toBe(Math.round(width * 1.25)); // 82 × 1.25 = 102.5
        expect(canvas.width).toBe(Math.round(width * 1.25));
        expect(parseFloat(canvas.style.width) * 1.25).toBeCloseTo(canvas.width, 6);
        expect(parseFloat(canvas.style.height) * 1.25).toBeCloseTo(canvas.height, 6);
      });

      it("removes its media query listener when the graph goes away", async () => {
        const { unmount } = render(<CommitGraph layout={await demoLayout()} />);
        const query = queries.at(-1);
        expect(query?.added).toHaveLength(1);
        unmount();
        expect(query?.removed).toEqual(query?.added);
      });

      it("redraws when only the media query reports the change", async () => {
        const { width, size } = await renderAt(1);
        setRatio(1.5);
        act(() => queries.at(-1)?.added.forEach((listener) => listener()));
        expect(size()).toEqual([Math.round(1.5 * width), Math.round(1.5 * 19 * ROW_HEIGHT)]);
        expect(queries.at(-1)?.media).toBe("(resolution: 1.5dppx)");
      });

      it("draws at the current ratio at the next render even when no event came", async () => {
        const ctx = new RecordingContext();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
          () => ctx as unknown as CanvasRenderingContext2D,
        );
        setRatio(1);
        const layout = await demoLayout();
        const { rerender } = render(<CommitGraph layout={layout} />);
        const canvas = document.querySelector<HTMLCanvasElement>("canvas.commit-graph-canvas");
        const width = graphColumnWidth(layout.laneCount);
        expect(canvas?.width).toBe(width);
        setRatio(2);
        rerender(<CommitGraph layout={layout} />);
        expect(canvas?.width).toBe(2 * width);
        expect(ctx.named("setTransform").at(-1)?.args).toEqual([2, 0, 0, 2, 0, 0]);
      });

      it("works with older WebKit media queries that have only addListener", async () => {
        const added: (() => void)[] = [];
        const removed: (() => void)[] = [];
        vi.stubGlobal("matchMedia", (media: string) => ({
          media,
          matches: true,
          addListener: (l: () => void) => added.push(l),
          removeListener: (l: () => void) => removed.push(l),
        }));
        const { width, size } = await renderAt(2);
        expect(size()[0]).toBe(2 * width);
        expect(added).toHaveLength(1);
        cleanup();
        expect(removed).toEqual(added);
      });
    });

    it("logs once, and draws nothing, when the canvas has no 2D context", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { GraphCanvas } = await import("./GraphCanvas");
      const layout = await demoLayout();
      const props = { layout, first: 0, last: 3, top: 0, left: 0, width: 82 };
      const { rerender } = render(<GraphCanvas {...props} />);
      rerender(<GraphCanvas {...props} last={4} />);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("no 2D canvas context");
    });

    it("draws the rows in the DOM on one canvas over the Graph column", async () => {
      const { layout, ctx } = await renderedDemo();
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.commit-graph-canvas");
      if (!canvas) throw new Error("no graph canvas");
      expect(document.querySelectorAll("canvas")).toHaveLength(1);
      expect(canvas.getAttribute("aria-hidden")).toBe("true");
      expect([canvas.dataset.firstRow, canvas.dataset.lastRow]).toEqual(["0", "18"]);
      const width = graphColumnWidth(layout.laneCount);
      expect(canvas.style.left).toBe(`${BRANCH_COLUMN_WIDTH}px`);
      expect(canvas.style.top).toBe("0px");
      expect(canvas.style.width).toBe(`${width}px`);
      expect(canvas.style.height).toBe(`${19 * ROW_HEIGHT}px`);
      // It was drawn: every node, and the demo repo's 6 elbows.
      expect(ctx.named("clearRect")).toHaveLength(1);
      expect(ctx.named("arcTo")).toHaveLength(6);
      expect(ctx.named("arc").filter((a) => a.fillStyle && a.args[2] === 5)).toHaveLength(2);
      // No images, links or SVG: nothing that could load from the network.
      expect(document.querySelector("img, image, svg.commit-graph-svg, a[href]")).toBeNull();
    });
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

    it("moves the graph canvas with the rows: it covers exactly the rows in the DOM", () => {
      render(<CommitGraph layout={layout} />);
      for (const target of [0, 25_000, 50_000 - VISIBLE_ROWS]) {
        scrollBodyTo(target * ROW_HEIGHT);
        const rows = renderedRows();
        const canvas = document.querySelector<HTMLCanvasElement>("canvas.commit-graph-canvas");
        const first = Math.min(...rows);
        const last = Math.max(...rows);
        expect([canvas?.dataset.firstRow, canvas?.dataset.lastRow]).toEqual([
          String(first),
          String(last),
        ]);
        expect(canvas?.style.top).toBe(`${first * ROW_HEIGHT}px`);
        expect(canvas?.style.height).toBe(`${(last - first + 1) * ROW_HEIGHT}px`);
      }
    });

    it("draws the rows it covers at every scroll position", () => {
      const ctx = new RecordingContext();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        () => ctx as unknown as CanvasRenderingContext2D,
      );
      render(<CommitGraph layout={layout} />);
      for (const target of [0, 1234, 25_000, 50_000 - VISIBLE_ROWS]) {
        scrollBodyTo(target * ROW_HEIGHT);
        const rows = renderedRows();
        const count = Math.max(...rows) - Math.min(...rows) + 1;
        const lastClear = ctx.calls.map((c) => c.name).lastIndexOf("clearRect");
        expect(ctx.calls[lastClear]?.args[3]).toBe(count * ROW_HEIGHT);
        // After the clear: one fill per node (plus a ring per avatar), one per row.
        const fills = ctx.calls.slice(lastClear).filter((c) => c.name === "fill");
        expect(fills).toHaveLength(count);
      }
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
