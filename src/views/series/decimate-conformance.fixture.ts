// views/series/decimate-conformance.fixture.ts — HEADLESS conformance fixtures for
// the shared emit-time column-decimation helper (perf §6.3; caps §4.2 R2/S8;
// deviation §11.1). NOT a test: pure data + a stub raster the decimate tests and the
// doc-03 §9 backend conformance suite compose against, exactly as scripts/demo-chart.mjs
// composes against a stub ISurface. Importable from views (no DOM, no backend). Three
// fixtures, one per §6.3 clause: (1) a SEEDED PlotStoreView (mulberry32, the §4.1
// generator) both the bit-identical pair and the per-column tests drive; (2) the
// S8/R2 "bulk" scene params (1 line + 1 candle, 1 M points, fitContent → sub-pixel —
// the ≤60-command cap of §4.4.3); (3) a stub COLUMN RASTER (composeColumns) mapping a
// finished DisplayList to per-device-column vertical coverage, so a sub-pixel fixture
// pins decimated-vs-full visual parity within AA tolerance (§6.3; §11.1 overdraw-only).
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { ViewFrame } from '../../gfx';
import type { DisplayList, PolylineCommand, RectsCommand } from '../../gfx';
import type { PlotStoreView } from '../../data';
import type { TimeIndex } from '../../core';

/** mulberry32 — the perf §4.1 seeded generator (`seed = 0x7eadbeef` by default), so
 *  every fixture run sees identical bytes (headless, deterministic). */
export function mulberry32(seed = 0x7eadbeef): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A finite-row SoA store over OHLC-ish lanes. `timeIndex(i) == startIndex + i` so
 *  rows map left→right monotonically through `HorzGeometry` (the helper's forward-
 *  scan precondition). `min`/`max`/`current` are the low/high/close role accessors;
 *  single-value (line) fixtures pass `lows === highs === closes`. NaN rows model
 *  whitespace/gaps. Mirrors the data-layer `PlotStoreView` face exactly. */
export function fixtureStore(
  lows: readonly number[],
  highs: readonly number[],
  closes: readonly number[] = lows,
  startIndex = 0,
): PlotStoreView {
  const n = lows.length;
  return {
    length: n,
    timeIndex: (i) => (startIndex + i) as TimeIndex,
    current: (i) => closes[i]!,
    min: (i) => lows[i]!,
    max: (i) => highs[i]!,
    lane: (k, i) => (k === 0 ? lows[i]! : k === 1 ? highs[i]! : closes[i]!),
    firstIndexAt: () => null,
    nearestIndexAt: () => -1,
  };
}

/** Build a seeded random-walk store of `n` OHLC rows (the §4.1 realistic walk). The
 *  same body feeds the bit-identical pair (driven at barSpacing·hr ≥ 1) and the
 *  per-column / cap tests (driven sub-pixel) — identical data, different spacing. */
export function seededWalk(n: number, seed = 0x7eadbeef): PlotStoreView {
  const rnd = mulberry32(seed);
  const lows: number[] = new Array(n);
  const highs: number[] = new Array(n);
  const closes: number[] = new Array(n);
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += (rnd() - 0.5) * 2; // ±1 step
    const c = price;
    const spread = 0.5 + rnd(); // 0.5..1.5
    lows[i] = c - spread;
    highs[i] = c + spread;
    closes[i] = c;
  }
  return fixtureStore(lows, highs, closes, 0);
}

/** A linear price converter Y = K − price (a larger price → a smaller, higher Y,
 *  matching the screen's downward Y axis), in media px. Identity-ish so hand-derived
 *  expectations are trivial. */
export function fixturePrice(k = 1000): PriceConverter {
  return {
    priceToCoordinate: (price) => k - price,
    firstValue: null,
    mode: 'normal',
    toLogical: (price) => price,
  };
}

/** A `ViewFrame` with square device ratios `hr === vr`. The decimated path writes
 *  DEVICE-px geometry into a bitmap list (perf §6.3), so `bitmapSize = mediaSize·hr`. */
export function fixtureFrame(mediaWidth: number, mediaHeight: number, hr: number): ViewFrame {
  return {
    frame: {
      mediaSize: { width: mediaWidth, height: mediaHeight },
      bitmapSize: { width: mediaWidth * hr, height: mediaHeight * hr },
      hr,
      vr: hr,
    },
    now: 0,
  };
}

/** A `HorzGeometry` whose rows fall inside `[0, width)` media px (study 03 §4.1). */
export function fixtureHorz(barSpacing: number, baseIndex: number, width: number): HorzGeometry {
  return createHorzGeometry({ width, barSpacing, rightOffset: 0, baseIndex });
}

/**
 * The S8 / R2 "bulk" scene parameters (perf §4.1 R2; §4.2 pan-at-fitContent; §9.2 S8).
 * 1 M points, `fitContent` over a 1600×900 DPR-2 viewport ⇒ barSpacing·hr well below
 * 1 (sub-pixel, decimation active). The ≤ 60-command cap (§4.4.3) is the budget S8
 * asserts; this object lets the headless test reconstruct the spacing without a real
 * navigator. (`barSpacing = width / points` is the fitContent spacing for the whole
 * series in view; ·hr ≪ 1 confirms the helper engages.)
 */
export const S8_SCENE = {
  points: 1_000_000,
  mediaWidth: 1600,
  mediaHeight: 900,
  hr: 2,
  /** fitContent spacing (media px per bar) when all `points` fill `mediaWidth`. */
  get barSpacing(): number {
    return this.mediaWidth / this.points;
  },
  /** The §4.4.3 / S8 hard cap on total draw commands for the decimated R2 frame. */
  commandCap: 60,
} as const;

/** Per-device-column vertical coverage: for each on-screen device column x, the
 *  min/max device-px Y any geometry painted into it (an inclusive interval), plus a
 *  flag for which columns were touched. The stub "raster" — no real pixels, just the
 *  column → [yTop, yBot] span every renderer must reproduce (§6.3 one segment/column).
 */
export interface ColumnRaster {
  readonly width: number; // device columns [0, width)
  readonly touched: Uint8Array; // 1 iff a segment covered column x
  readonly yTop: Float64Array; // smallest device-px Y painted in column x (∞ if untouched)
  readonly yBot: Float64Array; // largest device-px Y painted in column x (−∞ if untouched)
}

function blankRaster(width: number): ColumnRaster {
  const w = Math.max(0, Math.ceil(width));
  const yTop = new Float64Array(w).fill(Number.POSITIVE_INFINITY);
  const yBot = new Float64Array(w).fill(Number.NEGATIVE_INFINITY);
  return { width: w, touched: new Uint8Array(w), yTop, yBot };
}

function cover(r: ColumnRaster, col: number, y0: number, y1: number): void {
  const c = Math.floor(col);
  if (c < 0 || c >= r.width) return; // off-screen column — not rasterized
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  r.touched[c] = 1;
  if (lo < r.yTop[c]!) r.yTop[c] = lo;
  if (hi > r.yBot[c]!) r.yBot[c] = hi;
}

/**
 * Compose a finished DEVICE-px `DisplayList` (decimated output, or full-resolution
 * emit scaled to device px) into a `ColumnRaster` — what a backend would scan-convert,
 * reduced to the only property decimation parity cares about: which device column
 * carries which vertical extent. polyline → connected segments (gap = pen-up);
 * rects → each quad covers columns [x,x+w) over [y,y+h]. (Bitmap-space ⇒ device px.)
 */
export function composeColumns(lists: readonly DisplayList[], deviceWidth: number): ColumnRaster {
  const raster = blankRaster(deviceWidth);
  for (const list of lists) {
    for (const cmd of list.commands) {
      if (cmd.kind === 'polyline') rasterPolyline(raster, cmd);
      else if (cmd.kind === 'rects') rasterRects(raster, cmd);
    }
  }
  return raster;
}

function rasterPolyline(r: ColumnRaster, cmd: PolylineCommand): void {
  const p = cmd.points;
  // Walk consecutive finite vertices as CONNECTED segments (a (NaN,NaN) gap breaks the
  // run); cover every column a segment crosses with its Y-extent there (linear at the
  // column edges). Handles BOTH the decimated polyline (vertical (x,yTop)→(x,yBot) pair
  // → that column's [yTop,yBot]) and a full-resolution polyline (slanted cross-column
  // segments → each crossed column's true extent).
  let hasPrev = false;
  let px = 0;
  let py = 0;
  for (let o = 0; o + 1 < p.length; o += 2) {
    const x = p[o]!;
    const y = p[o + 1]!;
    if (Number.isNaN(x) || Number.isNaN(y)) {
      hasPrev = false; // pen-up
      continue;
    }
    if (hasPrev) coverSegment(r, px, py, x, y);
    else cover(r, x, y, y); // lone start vertex — at least its own pixel
    px = x;
    py = y;
    hasPrev = true;
  }
}

/** Cover every device column a segment (ax,ay)→(bx,by) crosses with the segment's
 *  vertical extent in that column (linear Y at the column's [lo,hi] x-overlap). A
 *  VERTICAL segment (dx == 0 — the decimated column's (x,yTop)→(x,yBot) pair) covers
 *  its single column's FULL [ay,by] span. */
function coverSegment(r: ColumnRaster, ax: number, ay: number, bx: number, by: number): void {
  const dx = bx - ax;
  if (dx === 0) {
    cover(r, ax, ay, by); // vertical: the column's whole [min,max] extent
    return;
  }
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const c0 = Math.floor(x0);
  const c1 = Math.floor(x1);
  const yAt = (x: number): number => ay + ((x - ax) / dx) * (by - ay);
  for (let c = c0; c <= c1; c++) {
    const lo = Math.max(x0, c);
    const hi = Math.min(x1, c + 1);
    if (hi < lo) continue;
    cover(r, c, yAt(lo), yAt(hi));
  }
}

function rasterRects(r: ColumnRaster, cmd: RectsCommand): void {
  const c = cmd.coords;
  for (let o = 0; o + 3 < c.length; o += 4) {
    const x = c[o]!;
    const y = c[o + 1]!;
    const w = c[o + 2]!;
    const h = c[o + 3]!;
    const x0 = Math.floor(x);
    const x1 = Math.ceil(x + w);
    for (let col = x0; col < x1; col++) cover(r, col, y, y + h);
  }
}

/**
 * Compare two column rasters within an AA tolerance (device px). Decimation parity
 * is NOT bit-identity below 1 bar/pixel — overlapping 1-px draws vs our single min/max
 * segment differ by sub-pixel AA only (§11.1). Asserts: each column is touched by BOTH
 * (extent agreeing within `tol`) or NEITHER — no coverage gained/lost, no extent drift
 * past `tol`. Returns the worst delta + first mismatching column for diagnosis.
 */
export interface RasterDiff {
  readonly maxDelta: number; // worst |yTop−yTop'| or |yBot−yBot'| over co-touched columns
  readonly coverageMismatch: number; // count of columns touched by exactly one raster
  readonly firstMismatchCol: number; // -1 if none
}

export function diffColumns(a: ColumnRaster, b: ColumnRaster): RasterDiff {
  const w = Math.max(a.width, b.width);
  let maxDelta = 0;
  let coverageMismatch = 0;
  let firstMismatchCol = -1;
  for (let c = 0; c < w; c++) {
    const ta = c < a.width ? a.touched[c]! : 0;
    const tb = c < b.width ? b.touched[c]! : 0;
    if (ta !== tb) {
      coverageMismatch++;
      if (firstMismatchCol < 0) firstMismatchCol = c;
      continue;
    }
    if (ta === 0) continue; // both untouched — agree
    const dTop = Math.abs(a.yTop[c]! - b.yTop[c]!);
    const dBot = Math.abs(a.yBot[c]! - b.yBot[c]!);
    const d = Math.max(dTop, dBot);
    if (d > maxDelta) maxDelta = d;
    if (firstMismatchCol < 0 && d > 0) firstMismatchCol = c;
  }
  return { maxDelta, coverageMismatch, firstMismatchCol };
}

/**
 * The FULL-RESOLUTION reference picture at sub-pixel spacing: per device column, the
 * vertical extent the reference's CONFLATION-OFF overlapping 1-px draws produced. At
 * sub-pixel zoom the reference draws one ~1-px mark per row; adjacent rows in a column
 * overdraw, so the *visible* result is the UNION of their extents = the column min/max
 * — exactly what our single min/max segment reproduces (decimation removes OVERDRAW,
 * never coverage, §11.1). The correct §6.3 AA-parity baseline (NOT the connected emit
 * polyline, whose slanted cross-column segments paint pixels the overlapping draws
 * never did). Built directly from store + geometry, same column/Y mapping the helper
 * uses (`floor(indexToCoordinate(timeIndex)·hr)`; `price`→device ·vr).
 */
export function referenceColumnEnvelope(
  store: PlotStoreView,
  from: number,
  to: number,
  frame: ViewFrame,
  horz: HorzGeometry,
  price: PriceConverter,
): ColumnRaster {
  const hr = frame.frame.hr;
  const vr = frame.frame.vr;
  const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);
  const r = blankRaster(deviceWidth);
  const lo = from < 0 ? 0 : from;
  const hi = to > store.length ? store.length : to;
  for (let i = lo; i < hi; i++) {
    const min = store.min(i);
    const max = store.max(i);
    if (Number.isNaN(min) || Number.isNaN(max)) continue;
    const col = Math.floor(horz.indexToCoordinate(store.timeIndex(i) as number) * hr);
    // Device-px Y: larger price → smaller (top) Y, matching the screen's downward axis.
    cover(r, col, price.priceToCoordinate(max) * vr, price.priceToCoordinate(min) * vr);
  }
  return r;
}

/** Default AA tolerance: half a device pixel — the most a single min/max segment's
 *  edge can differ from the overlapping-draw envelope it replaces (§6.3/§11.1). */
export const AA_TOLERANCE = 0.5;
