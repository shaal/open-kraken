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
  ROW_MID,
} from "./geometry";
import { layoutGraph } from "./lanes";
import { laneColorValue, laneConnectorColor, laneLabelColor, laneStreakColor } from "./palette";
import { buildRefLabels } from "./refLabels";
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

  describe("ref labels (spec §1 Ref labels)", () => {
    async function renderedLabels(fixture = "demo-repo") {
      const graph = await createFixtureAdapter(
        fixture === "edge-repo"
          ? async () => (await import("../git/fixtureAdapter")).loadEdgeFixture()
          : undefined,
      ).graphData(fixture);
      const layout = layoutGraph(graph.log);
      const labels = buildRefLabels(graph.refs, graph.log);
      render(<CommitGraph layout={layout} labels={labels} />);
      const row = (subject: string) => {
        const index = layout.rows.findIndex((r) => r.commit.subject === subject);
        const el = document.querySelector<HTMLElement>(`[data-row-index="${index}"]`);
        if (!el) throw new Error(`no row for ${subject}`);
        return el;
      };
      return { layout, labels, row };
    }
    const pillOf = (row: HTMLElement) => row.querySelector<HTMLElement>(".ref-pill");
    const icons = (el: HTMLElement | null) =>
      [...(el?.querySelectorAll<SVGElement>("svg[data-icon]") ?? [])].map((i) => i.dataset.icon);

    it("shows one pill per labeled commit, with its icons, in the Branch / Tag cell", async () => {
      const { layout, labels, row } = await renderedLabels();
      const pills = document.querySelectorAll(".ref-pill");
      expect(pills).toHaveLength(7);
      // Each pill is in its row's first cell; rows without refs have an empty cell.
      for (const [i, r] of layout.rows.entries()) {
        const cell = document.querySelector(`[data-row-index="${i}"] .commit-refs`);
        expect(cell?.getAttribute("role")).toBe("cell");
        expect(cell?.querySelectorAll(".ref-pill")).toHaveLength(labels.has(r.commit.sha) ? 1 : 0);
      }
      const main = pillOf(row("Update roadmap"));
      expect(main?.querySelector(".ref-name")?.textContent).toBe("main");
      expect(icons(main)).toEqual(["local"]);
      expect(main?.querySelectorAll("svg")).toHaveLength(2); // the ✓, then the laptop
      const remote = pillOf(row("Merge branch 'release/1.1'"));
      expect(remote?.querySelector(".ref-name")?.textContent).toBe("main");
      expect(remote?.title).toBe("origin/main");
      expect(icons(remote)).toEqual(["remote"]);
      const both = pillOf(row("Add regression test for crash"));
      expect(icons(both)).toEqual(["local", "remote"]);
      expect(both?.title).toBe("bugfix/crash-on-start\norigin/bugfix/crash-on-start");
      expect(icons(pillOf(row("Document setup steps")))).toEqual(["tag"]);
      // Only the checked-out branch has a ✓ (the only icon without data-icon).
      expect(document.querySelectorAll(".ref-pill svg:not([data-icon])")).toHaveLength(1);
    });

    it("counts a commit's other refs in a +N badge that names them", async () => {
      const { row } = await renderedLabels("edge-repo");
      const metrics = row("Add metrics endpoint");
      expect(pillOf(metrics)?.querySelector(".ref-name")?.textContent).toBe("nightly");
      const more = metrics.querySelector<HTMLElement>(".ref-more");
      expect(more?.querySelector("[aria-hidden]")?.textContent).toBe("+2");
      expect(more?.title).toBe("qa/passed\nv1.2");
      expect(more?.textContent).toBe("+2, 2 more: qa/passed, tag; v1.2, annotated tag");
      const head = row("Update roadmap");
      expect(pillOf(head)?.textContent).toBe("HEADHEAD, detached, checked out");
      expect(head.querySelector(".ref-more")?.textContent).toBe("+1, 1 more: main, local branch");
      expect(row("Rename build script").querySelector(".ref-more")).toBeNull();
    });

    it("tells screen readers the full names and kinds, not just the visible text", async () => {
      const { row } = await renderedLabels();
      const spoken = (subject: string) =>
        pillOf(row(subject))?.querySelector(".visually-hidden")?.textContent;
      expect(spoken("Update roadmap")).toBe("main, local branch, checked out");
      expect(spoken("Merge branch 'release/1.1'")).toBe("origin/main, remote branch");
      expect(spoken("Add remember-me option")).toBe(
        "feature/login and origin/feature/login, local and remote branch",
      );
      // The visible name and the icons are hidden from them, so nothing is read twice.
      const pill = pillOf(row("Update roadmap"));
      expect(pill?.querySelector(".ref-name")?.getAttribute("aria-hidden")).toBe("true");
      for (const svg of pill?.querySelectorAll("svg") ?? []) {
        expect(svg.getAttribute("aria-hidden")).toBe("true");
      }
    });

    it("colors the pill and its line by the node's lane, brighter for the checked-out commit", async () => {
      const { layout, row } = await renderedLabels();
      for (const [subject, active] of [
        ["Update roadmap", true],
        ["Prepare 1.1 release notes", false],
        ["Highlight branch on hover", false],
      ] as const) {
        const el = row(subject);
        const lane = layout.rows[Number(el.dataset.rowIndex)]?.lane ?? -1;
        expect(pillOf(el)?.style.getPropertyValue("--label-bg")).toBe(laneLabelColor(lane, active));
        const line = el.querySelector<HTMLElement>(".ref-connector");
        // jsdom keeps the color as written, in rgb()/rgba() form.
        expect(line).not.toBeNull();
        expect(toHex(line?.style.backgroundColor ?? "")).toBe(laneConnectorColor(lane, active));
      }
      expect(laneLabelColor(2, false)).toBe("#a24bd84d");
      expect(laneLabelColor(2, true)).toBe("#a24bd880");
    });

    it("expands the hovered label above the canvas, and drops it when the pointer leaves", async () => {
      const { layout, row } = await renderedLabels("edge-repo");
      const long = row("Add health endpoint");
      const index = Number(long.dataset.rowIndex);
      expect(document.querySelector(".ref-overlay")).toBeNull();
      fireEvent.mouseEnter(long.querySelector(".ref-label") as HTMLElement);
      const overlay = document.querySelector<HTMLElement>(".ref-overlay");
      expect(overlay?.dataset.sha).toBe(layout.rows[index]?.commit.sha);
      expect(overlay?.getAttribute("aria-hidden")).toBe("true");
      expect(overlay?.style.top).toBe(`${index * ROW_HEIGHT}px`);
      expect(overlay?.querySelector(".ref-name")?.textContent).toBe(
        "feature/a-very-long-branch-name-that-does-not-fit-the-column",
      );
      const lane = layout.rows[index]?.lane ?? -1;
      expect(
        overlay?.querySelector<HTMLElement>(".ref-pill")?.style.getPropertyValue("--label-bg"),
      ).toBe(laneLabelColor(lane, true));
      // After the canvas in the scrolling content, so it is drawn above it.
      const canvas = document.querySelector("canvas.commit-graph-canvas");
      expect(canvas?.nextElementSibling).toBe(overlay);
      // A leave from another label (events can come out of order) changes nothing.
      // (The leaves go to a message cell: a leave to nothing also leaves the table.)
      const message = long.querySelector(".commit-message");
      fireEvent.mouseLeave(row("Draw commit lanes").querySelector(".ref-label") as HTMLElement, {
        relatedTarget: message,
      });
      expect(document.querySelector(".ref-overlay")).not.toBeNull();
      fireEvent.mouseLeave(long.querySelector(".ref-label") as HTMLElement, {
        relatedTarget: message,
      });
      expect(document.querySelector(".ref-overlay")).toBeNull();
    });

    it("keeps the hover while the pointer is on the expanded copy, and ends it off the copy", async () => {
      // jsdom has no layout: the copy's box is 24–418 px across, at its row's top.
      const BODY_TOP = 110;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const scrolled = document.querySelector(".commit-graph-body")?.scrollTop ?? 0;
        const top = BODY_TOP + parseFloat(this.style.top || "0") - scrolled;
        return this.classList.contains("ref-overlay")
          ? new DOMRect(24, top, 394, ROW_HEIGHT)
          : new DOMRect(0, 0, 0, 0);
      });
      const { layout, row } = await renderedLabels("edge-repo");
      const long = row("Add health endpoint");
      const index = Number(long.dataset.rowIndex);
      const y = BODY_TOP + index * ROW_HEIGHT + ROW_MID;
      const label = long.querySelector(".ref-label") as HTMLElement;
      const body = screen.getByTestId("commit-graph-body");
      const copy = () => document.querySelector<HTMLElement>(".ref-overlay");
      fireEvent.mouseEnter(label);
      expect(copy()?.dataset.sha).toBe(layout.rows[index]?.commit.sha);
      // Off the label but still on the copy (the expanded part): the hover stays.
      const lanes = long.querySelector(".commit-lanes"); // the cell under the expanded part
      fireEvent.mouseLeave(label, { clientX: 300, clientY: y, relatedTarget: lanes });
      fireEvent.mouseMove(body, { clientX: 400, clientY: y });
      expect(copy()).not.toBeNull();
      // Off the copy: it ends.
      fireEvent.mouseMove(body, { clientX: 430, clientY: y });
      expect(copy()).toBeNull();
      // A leave straight off the label and the copy ends it too.
      fireEvent.mouseEnter(label);
      fireEvent.mouseLeave(label, {
        clientX: 300,
        clientY: y + ROW_HEIGHT,
        relatedTarget: row("Scaffold graph view").querySelector(".commit-lanes"),
      });
      expect(copy()).toBeNull();
      // So does leaving the table.
      fireEvent.mouseEnter(label);
      fireEvent.mouseLeave(body);
      expect(copy()).toBeNull();
      // A scroll that moves the copy from under a still pointer ends it (Chrome
      // sends no mouse move then); one that keeps the copy under it does not.
      fireEvent.mouseEnter(label);
      fireEvent.mouseMove(body, { clientX: 300, clientY: y });
      scrollBodyTo(10);
      expect(copy()).not.toBeNull();
      scrollBodyTo(2 * ROW_HEIGHT);
      expect(copy()).toBeNull();
    });

    it("keeps a newly entered label's hover when a move ends the old copy's", async () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const top = parseFloat(this.style.top || "0");
        return this.classList.contains("ref-overlay")
          ? new DOMRect(24, top, 100, ROW_HEIGHT)
          : new DOMRect(0, 0, 0, 0);
      });
      const { row } = await renderedLabels();
      const first = row("Update roadmap");
      const second = row("Prepare 1.1 release notes");
      fireEvent.mouseEnter(first.querySelector(".ref-label") as HTMLElement);
      const firstCopy = document.querySelector<HTMLElement>(".ref-overlay");
      // The pointer goes straight onto the next label. A move can be handled before
      // the copy re-renders, while it still names the old commit: simulate that.
      fireEvent.mouseEnter(second.querySelector(".ref-label") as HTMLElement);
      firstCopy?.setAttribute("data-sha", "0".repeat(40));
      fireEvent.mouseMove(screen.getByTestId("commit-graph-body"), { clientX: 900, clientY: 5 });
      const copy = document.querySelector<HTMLElement>(".ref-overlay");
      expect(copy).not.toBeNull();
    });

    it("moves the expanded label to the next hovered label", async () => {
      const { layout, row } = await renderedLabels();
      fireEvent.mouseEnter(row("Update roadmap").querySelector(".ref-label") as HTMLElement);
      const next = row("Prepare 1.1 release notes");
      fireEvent.mouseLeave(row("Update roadmap").querySelector(".ref-label") as HTMLElement);
      fireEvent.mouseEnter(next.querySelector(".ref-label") as HTMLElement);
      const overlays = document.querySelectorAll<HTMLElement>(".ref-overlay");
      expect(overlays).toHaveLength(1);
      expect(overlays[0]?.dataset.sha).toBe(layout.rows[Number(next.dataset.rowIndex)]?.commit.sha);
      expect(overlays[0]?.querySelector(".ref-more")?.textContent).toContain("+1");
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

    it("drops a hovered label when its row scrolls out of the DOM", () => {
      const graph = syntheticGraph(50_000);
      const labels = buildRefLabels(graph.refs, graph.log);
      render(<CommitGraph layout={layout} labels={labels} />);
      const label = document.querySelector<HTMLElement>(`[data-row-index="0"] .ref-label`);
      expect(label).not.toBeNull(); // main, at the top
      fireEvent.mouseEnter(label as HTMLElement);
      expect(document.querySelector(".ref-overlay")).not.toBeNull();
      scrollBodyTo(25_000 * ROW_HEIGHT); // row 0 unmounts without a mouseleave
      expect(document.querySelector(".ref-overlay")).toBeNull();
      scrollBodyTo(0);
      expect(document.querySelector('[data-row-index="0"] .ref-label')).not.toBeNull();
      expect(document.querySelector(".ref-overlay")).toBeNull();
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

/** `rgb(1, 2, 3)` or `rgba(1, 2, 3, 0.5)` as `#010203` or `#01020380`. */
function toHex(color: string): string {
  const m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(color);
  if (!m) return color;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  const alpha = m[4] === undefined ? "" : hex(Math.round(Number(m[4]) * 255));
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha}`;
}
