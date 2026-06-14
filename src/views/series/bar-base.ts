// views/series/bar-base.ts — the SHARED bar-like column scaffold (study 06 §4.8
// width math / §4.12 range hit; design 03 §8.5.4–§8.5.6). Histogram, Bar, and
// Candlestick all map a row to a crisp device-px COLUMN and range-hit a cursor
// against the column's vertical extent, so the OHLC lane access, the crisp column
// width (via gfx/crisp), and the range-hit helper live HERE once. The per-kind emit
// (rects/quads, ticks, wicks, hollow frames) stays in each kind's file.
import { lowerBound } from '../../core';
import { HitPriority } from '../../gfx';
import type { HitCandidate } from '../../gfx';
import { applyBarParity, optimalBarWidth, optimalCandlestickWidth } from '../../gfx';

// --- OHLC lane access (laneStride 4) ------------------------------------------

/** `ItemBuffer.extra` stride for an OHLC kind: open/high/low/close media-px Y per
 *  item, laid out [o,h,l,c] (convert fills it; emit/hit read it). */
export const OHLC_LANE_STRIDE = 4;

/** The four OHLC lane offsets within a stride-4 `extra` slot (media-px Y). */
export const OHLC = {
  Open: 0,
  High: 1,
  Low: 2,
  Close: 3,
} as const;
export type OHLC = (typeof OHLC)[keyof typeof OHLC];

/** Read lane `k` (OHLC.*) of item `i` from a stride-4 `extra` array (media-px Y). */
export function ohlc(extra: Float32Array, i: number, k: OHLC): number {
  return extra[i * OHLC_LANE_STRIDE + k]!;
}

/** Write lane `k` (OHLC.*) of item `i` into a stride-4 `extra` array (media-px Y). */
export function setOhlc(extra: Float32Array, i: number, k: OHLC, y: number): void {
  extra[i * OHLC_LANE_STRIDE + k] = y;
}

// --- crisp column width (study 06 §4.8) ---------------------------------------

/** Bar-series column width: `max(floor(hr), optimalBarWidth)` then the parity rule
 *  vs the bars reference line `max(1, floor(hr))` (study 06 §4.8 / §4.9). */
export function barColumnWidth(barSpacing: number, hr: number): number {
  const w = Math.max(Math.floor(hr), optimalBarWidth(barSpacing, hr));
  return applyBarParity(w, Math.max(1, Math.floor(hr)));
}

/** Candlestick column width: `optimalCandlestickWidth` then the parity rule vs the
 *  candle reference line `floor(hr)` — deliberately distinct from bars (study 06 §4.8). */
export function candleColumnWidth(barSpacing: number, hr: number): number {
  return applyBarParity(optimalCandlestickWidth(barSpacing, hr), Math.floor(hr));
}

// --- range hit (study 06 §4.12 bar-likes / histogram / custom fallback) -------

/** Vertical extent of item `i`'s column in media-px Y (top ≤ bottom). Bar/Candle →
 *  [highY, lowY]; Histogram → [min(itemY, baseY), max(itemY, baseY)]. */
export type ColumnSpan = (i: number) => { readonly top: number; readonly bottom: number };

/**
 * Range hit over the converted column slice `[from, to)` (study 06 §4.12). The
 * cursor's column slot is `[midpoint(prev.x, x) .. midpoint(x, next.x)]`, with a
 * side falling back to `x ∓ barSpacing/2` when the neighbour is ABSENT — its time
 * index isn't exactly ±1 (data gap) OR it lies at the visible edge (i == from / to-1).
 * The slot is expanded by `tolerance` on both sides. Inside the vertical range →
 * distance 0; otherwise the distance to the nearest vertical edge (Range priority).
 * Operates in MEDIA px on the x lane emit drew; returns the best candidate or null.
 */
export function hitTestColumns(
  xs: Float32Array,
  timeIndex: Int32Array,
  span: ColumnSpan,
  from: number,
  to: number,
  px: number,
  py: number,
  barSpacing: number,
  tolerance: number,
): HitCandidate | null {
  const count = to - from;
  if (count === 0) return null;
  const half = barSpacing / 2;
  // Candidate window: items whose centre x is within half+tolerance of the cursor.
  const reach = half + tolerance;
  const last = to - 1;
  const lo = lowerBound(xs, px - reach, (a, v) => (a as number) < (v as number), from, to);
  let best: HitCandidate | null = null;
  for (let i = lo > from ? lo - 1 : from; i < to; i++) {
    const x = xs[i]!;
    if (x - reach > px) break;
    if (Number.isNaN(x)) continue;
    // Left edge: midpoint to prev when prev is a present ±1 neighbour, else x − half.
    const prevPresent = i > from && timeIndex[i - 1] === timeIndex[i]! - 1;
    const nextPresent = i < last && timeIndex[i + 1] === timeIndex[i]! + 1;
    const left = (prevPresent ? (xs[i - 1]! + x) / 2 : x - half) - tolerance;
    const right = (nextPresent ? (x + xs[i + 1]!) / 2 : x + half) + tolerance;
    if (px < left || px > right) continue; // cursor outside this column's slot
    const { top, bottom } = span(i);
    if (Number.isNaN(top) || Number.isNaN(bottom)) continue;
    // Vertical: inside [top, bottom] → 0; else distance to nearest edge (within tol).
    let dy: number;
    if (py < top) dy = top - py;
    else if (py > bottom) dy = py - bottom;
    else dy = 0;
    if (dy > tolerance) continue;
    if (best === null || dy < best.distance) best = { distance: dy, priority: HitPriority.Range };
  }
  return best;
}
