import { describe, expect, it } from "vitest";
import { LANE_COLOR_COUNT } from "./lanes";
import { laneLabelColor } from "./palette";

/** WCAG relative luminance of an `#rrggbb` color. */
function luminance([r, g, b]: number[]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** `#rrggbbaa` painted over an opaque `#rrggbb`. */
function over(color: string, background: string): number[] {
  const alpha = parseInt(color.slice(7, 9), 16) / 255;
  const bg = rgb(background);
  return rgb(color).map((c, i) => c * alpha + (bg[i] ?? 0) * (1 - alpha));
}

describe("laneLabelColor", () => {
  it("keeps white label text at 4.5:1 or more for every lane, on every row background", () => {
    // The table's background (App.css :root) and a hovered row's (.commit-row:hover).
    for (const background of ["#1b1d21", "#23262c"]) {
      for (let lane = 0; lane < LANE_COLOR_COUNT; lane++) {
        for (const active of [false, true]) {
          const contrast =
            1.05 / (luminance(over(laneLabelColor(lane, active), background)) + 0.05);
          expect(
            contrast,
            `lane ${lane}, active ${active}, on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("makes an active label brighter than an inactive one", () => {
    for (let lane = 0; lane < LANE_COLOR_COUNT; lane++) {
      const [dim, bright] = [false, true].map((a) =>
        luminance(over(laneLabelColor(lane, a), "#1b1d21")),
      );
      expect(bright).toBeGreaterThan(dim ?? 1);
    }
  });
});
