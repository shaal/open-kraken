import { describe, expect, it } from "vitest";
import { IDENTICON_CACHE_LIMIT, IDENTICON_GRID, identicon } from "./identicon";
import { LANE_COLORS, laneColorValue, laneStreakColor } from "./palette";
import { LANE_COLOR_COUNT } from "./lanes";

/** The filled cells of an identicon, as "x,y". */
function cells(face: { cells: readonly (readonly [number, number])[] }): Set<string> {
  return new Set(face.cells.map(([x, y]) => `${x},${y}`));
}

describe("identicon", () => {
  it("is the same for the same address, ignoring case and spaces around it", () => {
    const a = identicon("Dev1@Example.com");
    expect(identicon(" dev1@example.com ")).toEqual(a);
    expect(identicon("dev1@example.com")).toBe(a); // cached
  });

  it("is a mirrored pattern of whole cells inside the grid", () => {
    for (let i = 0; i < 50; i++) {
      const face = identicon(`person${i}@example.com`);
      const filled = cells(face);
      expect(filled.size).toBe(face.cells.length); // no cell twice
      expect(filled.size).toBeGreaterThan(0);
      for (const cell of filled) {
        const [x, y] = cell.split(",").map(Number) as [number, number];
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(IDENTICON_GRID);
        expect(y).toBeLessThan(IDENTICON_GRID);
        expect(filled.has(`${IDENTICON_GRID - 1 - x},${y}`)).toBe(true);
      }
    }
  });

  it("differs between authors", () => {
    const faces = new Set(
      Array.from({ length: 50 }, (_, i) => {
        const face = identicon(`author${i}@example.com`);
        return `${[...cells(face)].sort().join(" ")}|${face.color}`;
      }),
    );
    expect(faces.size).toBeGreaterThanOrEqual(48);
  });

  it("keeps its cache small: it starts over after IDENTICON_CACHE_LIMIT authors", () => {
    const first = identicon("cache-first@example.com");
    expect(identicon("cache-first@example.com")).toBe(first);
    for (let i = 0; i < IDENTICON_CACHE_LIMIT; i++) identicon(`cache-${i}@example.com`);
    const again = identicon("cache-first@example.com");
    expect(again).not.toBe(first); // built again after the cache was cleared
    expect(again).toEqual(first); // and still the same face
  });

  it("uses only local colors: no URLs, no images", () => {
    const face = identicon("someone@example.com");
    expect(face.color).toMatch(/^hsl\(\d+, 70%, 62%\)$/);
    expect(face.background).toMatch(/^hsl\(\d+, 35%, 22%\)$/);
    expect(JSON.stringify(face)).not.toMatch(/http|url\(|href/i);
  });
});

describe("lane colors", () => {
  it("has one distinct color per lane slot and repeats them for later lanes", () => {
    expect(LANE_COLORS).toHaveLength(LANE_COLOR_COUNT);
    expect(new Set(LANE_COLORS).size).toBe(LANE_COLOR_COUNT);
    expect(laneColorValue(0)).toBe(LANE_COLORS[0]);
    expect(laneColorValue(LANE_COLOR_COUNT + 2)).toBe(LANE_COLORS[2]);
    for (const color of LANE_COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("gives the streak the lane color at 16 % opacity, as 8-digit hex", () => {
    expect(laneStreakColor(1)).toBe(`${LANE_COLORS[1]}29`);
    expect(0x29 / 255).toBeCloseTo(0.16, 2);
  });
});
