/**
 * Author avatars drawn from the email address alone: no network requests.
 *
 * The email (trimmed, lower case) is hashed with 32-bit FNV-1a, and the hash
 * seeds a small PRNG. The PRNG picks a hue and fills a 5 × 5 grid that is
 * mirrored left to right, so every author gets a stable, symmetric pattern.
 */

/** Cells across and down. */
export const IDENTICON_GRID = 5;

export interface Identicon {
  /** The filled cells as [column, row], each from 0 to IDENTICON_GRID - 1. */
  cells: readonly (readonly [number, number])[];
  /** Color of the filled cells. */
  color: string;
  /** Color behind them. */
  background: string;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Authors seen; cleared when it grows past this, so it stays small across many repos. */
export const IDENTICON_CACHE_LIMIT = 10_000;
const cache = new Map<string, Identicon>();

/** The identicon for an email address; the same address always gives the same one. */
export function identicon(email: string): Identicon {
  const key = email.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const rand = prng(fnv1a(key));
  const hue = Math.floor(rand() * 360);
  const half = Math.ceil(IDENTICON_GRID / 2);
  const cells: [number, number][] = [];
  for (let y = 0; y < IDENTICON_GRID; y++) {
    for (let x = 0; x < half; x++) {
      if (rand() < 0.5) continue;
      const mirror = IDENTICON_GRID - 1 - x;
      cells.push([x, y]);
      if (mirror !== x) cells.push([mirror, y]);
    }
  }
  if (cells.length === 0) cells.push([2, 2]); // never an empty face
  const result: Identicon = {
    cells,
    color: `hsl(${hue}, 70%, 62%)`,
    background: `hsl(${hue}, 35%, 22%)`,
  };
  if (cache.size >= IDENTICON_CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}
