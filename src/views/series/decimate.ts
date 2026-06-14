// views/series/decimate.ts — the SHARED emit-time column-decimation helper
// (architecture §6 / perf §6.3, the conflation replacement; flagged deviation
// §13.15). All six built-in kinds' `decimate` implementations call it; a custom
// kind may delegate to it or supply its own scan.
//
// WHEN: active only at sub-pixel spacing — `barSpacing · hr < 1` (more than one
// bar per device pixel; the reference's own threshold, study 10 §4.14). At
// `barSpacing · hr ≥ 1` the helper is INACTIVE and returns null, so the engine
// runs the bit-identical `convert`→`emit` normal path instead (perf §4.4.3).
//
// WHAT: a single sequential scan of the visible rows (`window` over the
// `PlotStoreView` SoA `Float64Array` lanes, with NaN/gap handling) maps each row's
// `TimeIndex` to a device-pixel column via `horz`, accumulates the column's min/max
// values, and emits AT MOST ONE min/max vertical segment per device-pixel column
// (mapping min/max to Y via `price`) directly into `out`:
//   • line / area → one (top, bottom) vertex pair per column into the polyline points;
//   • bar / candle → one 1-px-wide hi–lo quad per column into the rects runs;
//   • histogram   → one column rect (baseline → extremum) per column.
// Column colour = the last bar's resolved colour (last-drawn-wins; resolved by the
// kind once and passed in). Cost: O(visibleRows) lane reads emitting O(deviceWidth)
// geometry — at most `ceil(deviceWidth)` segments. The `ItemBuffer` is neither
// populated nor read on this path.
import { assert } from '../../core';
import { LineStyle, type DisplayListBuilder } from '../../gfx';
import type { PlotStoreView } from '../../data';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { ViewFrame } from '../../gfx';
import type { ItemWindow } from './window';

/** Which geometry a kind wants the per-column segment rendered as (architecture
 *  §6 / perf §6.3). */
export type DecimateShape = 'line' | 'area' | 'barlike' | 'histogram';

/** Per-call parameters that vary by kind. Plain data + one resolved colour string;
 *  no per-row allocation, no closures (perf §5.1). */
export interface DecimateOptions {
  readonly shape: DecimateShape;
  /** Resolved column colour (the last visible bar's colour; last-drawn-wins, §6.3). */
  readonly color: string;
  /** Line/area stroke width in media px (used for `polyline`/`area` outline). */
  readonly lineWidth?: number;
  /** Baseline Y in DEVICE px (price→coordinate ·vr) for histogram columns — the
   *  decimated path writes to a `bitmap` (device-px) list. Required for `histogram`;
   *  ignored otherwise. */
  readonly baseY?: number;
}

/** Outcome of a decimation pass. `null` when the helper is INACTIVE (normal path —
 *  `barSpacing · hr ≥ 1`), so the engine knows to fall back to convert→emit. */
export interface DecimateResult {
  /** Device-pixel columns that received a segment. Always ≤ ceil(deviceWidth). */
  readonly columns: number;
  /** Visible rows scanned (the O(visibleRows) cost term). */
  readonly rowsScanned: number;
}

/** True when the decimated path must run for this frame's spacing (perf §6.3). */
export function shouldDecimate(barSpacing: number, hr: number): boolean {
  return barSpacing * hr < 1;
}

/**
 * Run the shared column-decimation scan, writing geometry into `out` (which the
 * caller has already `beginList`'d). Returns `null` when INACTIVE (the normal path
 * must run); otherwise a `DecimateResult` whose `columns ≤ ceil(deviceWidth)`.
 *
 * The scan is a single forward pass: rows are time-ordered, so the device column a
 * row maps to is monotonic; we accumulate min/max within a column and flush one
 * segment when the column advances. NaN values (whitespace / gaps) are skipped; a
 * column with no finite value emits nothing.
 */
export function decimateColumns(
  store: PlotStoreView,
  window: ItemWindow,
  frame: ViewFrame,
  horz: HorzGeometry,
  price: PriceConverter,
  out: DisplayListBuilder,
  opts: DecimateOptions,
): DecimateResult | null {
  const hr = frame.frame.hr;
  const vr = frame.frame.vr;
  if (!shouldDecimate(horz.barSpacing, hr)) return null; // INACTIVE → engine runs convert→emit

  if (__DEV__ && opts.shape === 'histogram') {
    assert(opts.baseY !== undefined, 'histogram decimation requires opts.baseY');
  }

  const from = window.from < 0 ? 0 : window.from;
  const to = window.to > store.length ? store.length : window.to;
  const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);

  // One writer for the whole pass; the builder folds equal-colour runs. The module-
  // scope `emitColumn` (below) does the per-column geometry so no closure is created
  // inside frame code (perf §5.1).
  const lineLike = opts.shape === 'line' || opts.shape === 'area';
  const poly = lineLike ? out.polyline(opts.lineWidth ?? 1, LineStyle.Solid, 'miter') : null;
  const rects = lineLike ? null : out.rects({});

  // Column accumulator (no per-column objects — three locals).
  let curCol = -1;
  let colMin = Number.POSITIVE_INFINITY; // smallest price in the column
  let colMax = Number.NEGATIVE_INFINITY; // largest price in the column
  let columns = 0;
  let rowsScanned = 0;

  for (let i = from; i < to; i++) {
    const lo = store.min(i);
    const hi = store.max(i);
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue; // gap / whitespace
    rowsScanned++;
    // Row → device-pixel column (media-px X · hr, floored to the pixel grid).
    const xMedia = horz.indexToCoordinate(store.timeIndex(i) as number);
    const col = Math.floor(xMedia * hr);
    if (col !== curCol) {
      if (curCol >= 0 && emitColumn(poly, rects, opts, price, vr, curCol, colMin, colMax)) columns++;
      curCol = col;
      colMin = lo;
      colMax = hi;
    } else {
      if (lo < colMin) colMin = lo;
      if (hi > colMax) colMax = hi;
    }
  }
  if (curCol >= 0 && emitColumn(poly, rects, opts, price, vr, curCol, colMin, colMax)) columns++;

  if (__DEV__) assert(columns <= deviceWidth, 'decimation emitted more columns than device pixels');
  return { columns, rowsScanned };
}

/** Emit one column's min/max segment. Module-scope (not a per-frame closure, perf
 *  §5.1). Returns true iff a segment was written. */
function emitColumn(
  poly: ReturnType<DisplayListBuilder['polyline']> | null,
  rects: ReturnType<DisplayListBuilder['rects']> | null,
  opts: DecimateOptions,
  price: PriceConverter,
  vr: number,
  col: number,
  colMin: number,
  colMax: number,
): boolean {
  if (colMin === Number.POSITIVE_INFINITY) return false; // empty column
  // Decimated geometry is written into the caller's `bitmap` list, so coordinates
  // are DEVICE px (perf §6.3: one 1-device-px-wide segment per device-pixel column).
  // `col` is already a device-pixel column; Y is media-px price → device via ·vr.
  // Y grows downward, so the larger price maps to the smaller (top) Y.
  const yTop = price.priceToCoordinate(colMax) * vr;
  const yBot = price.priceToCoordinate(colMin) * vr;
  const x = col; // device-pixel column
  const w = 1; // 1 device px wide
  const fill = opts.color;
  if (poly !== null) {
    // One vertical segment as two vertices + a pen-up gap between columns.
    poly.vertex(x, yTop, fill);
    poly.vertex(x, yBot, fill);
    poly.gap();
    return true;
  }
  if (rects !== null) {
    if (opts.shape === 'histogram') {
      // One column from the baseline (device-px, passed in by the kind) to the
      // extremum furthest from it.
      const baseY = opts.baseY ?? 0;
      const ext = Math.abs(yTop - baseY) >= Math.abs(yBot - baseY) ? yTop : yBot;
      const top = Math.min(ext, baseY);
      rects.quad(x, top, w, Math.abs(ext - baseY), fill);
    } else {
      // bar/candle: one 1-px-wide hi–lo quad (yTop is the high, yBot the low).
      const h = yBot - yTop;
      rects.quad(x, yTop, w, h < 0 ? 0 : h, fill);
    }
    return true;
  }
  return false;
}
