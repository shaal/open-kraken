import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { logError } from "../log";
import { drawGraphRows } from "./drawGraph";
import { ROW_HEIGHT } from "./geometry";
import type { GraphLayout } from "./lanes";
import { NO_REF_LABELS, type RefLabels } from "./refLabels";
import type { GraphNode } from "./specialRows";

interface GraphCanvasProps {
  layout: GraphLayout<GraphNode>;
  /** The first and last row in the DOM: the canvas covers exactly these rows. */
  first: number;
  last: number;
  /** Pixels from the top of the scroll area to row `first`. */
  top: number;
  /** Where the Graph column starts, and its width. */
  left: number;
  width: number;
  /** Rows with ref labels get a connector from the column's left edge to the node. */
  labels?: RefLabels;
}

let reportedNoContext = false;

/**
 * The Graph column of the rows in the DOM, drawn on one canvas that sits in the
 * scrolling content, so it moves with the rows. It is redrawn in the same
 * frame as the rows (a layout effect), and clicks go through it to the rows.
 */
export function GraphCanvas({
  layout,
  first,
  last,
  top,
  left,
  width,
  labels = NO_REF_LABELS,
}: GraphCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const height = (last - first + 1) * ROW_HEIGHT;
  const scale = useDevicePixelRatio();
  // A whole number of device pixels, and a CSS box of exactly that size, so the
  // bitmap is not resampled and snapped edges stay on device pixels.
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) {
      if (!reportedNoContext) {
        reportedNoContext = true;
        logError("the commit graph cannot be drawn: no 2D canvas context");
      }
      return;
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawGraphRows(ctx, layout, first, last, width, scale, labels);
  }, [layout, first, last, width, height, scale, labels]);
  return (
    <canvas
      ref={ref}
      className="commit-graph-canvas"
      aria-hidden="true"
      data-first-row={first}
      data-last-row={last}
      width={pixelWidth}
      height={pixelHeight}
      style={{ left, top, width: pixelWidth / scale, height: pixelHeight / scale }}
    />
  );
}

/**
 * The window's device pixel ratio, read again at every render, so a scroll
 * always draws at the current ratio. A resize event or a change of the
 * `(resolution)` media query re-renders at once (the window moved to a
 * display with other pixels, or the page zoom changed). When neither comes
 * (Chrome sends none when only the ratio changes), the canvas keeps the old
 * ratio until the next render.
 */
function useDevicePixelRatio(): number {
  // Any event re-renders, even when the ratio equals an earlier one.
  const [, update] = useReducer((n: number) => n + 1, 0);
  const ratio = window.devicePixelRatio || 1;
  useEffect(() => {
    window.addEventListener("resize", update);
    const query =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(resolution: ${ratio}dppx)`)
        : null;
    // Older WebKit has only the deprecated addListener on media queries.
    if (query?.addEventListener) query.addEventListener("change", update);
    else query?.addListener?.(update);
    return () => {
      window.removeEventListener("resize", update);
      if (query?.removeEventListener) query.removeEventListener("change", update);
      else query?.removeListener?.(update);
    };
  }, [ratio]);
  return ratio;
}
