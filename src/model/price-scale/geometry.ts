// The PriceGeometry value object (architecture §4.6 / §6; study 04 §4.4 is the
// kept conversion math). A plain immutable snapshot: given a height, a logical-
// space range, the margin parameters, the mode, inversion and the active log
// formula, it exposes price⇄coordinate transforms. It holds NO model reference,
// so it is trivially unit-testable, serializable and shareable (§9.3 "geometry as
// values").
//
// MARGINS ADOPT THE UNIFIED FORM (architecture §4.6, study 04 IMPROVE — adopted,
// not declined). The reference swaps two getters under inversion, a recurring bug
// source. traderzview computes margins ONCE as `marginNearMaxLogical` and
// `marginNearMinLogical` (each = its option-fraction-of-H term PLUS its pixel
// autoscale-margin term) and derives `topMarginPx`/`bottomMarginPx` from those two
// by the SINGLE inversion rule (non-inverted: top = near-max, bottom = near-min;
// inverted: they swap orientation). The kept magnitudes are unchanged from study
// 04 §4 — only the open implementer choice is removed.
//
// Conventions load-bearing for pixel parity (study 04 §5):
//   • `h = H − topMarginPx − bottomMarginPx` (internal band the range maps onto);
//   • the −1s: the drawable band is `h − 1` px tall and the pane bottom is `H − 1`;
//   • coordinates are NOT rounded — fractional y is emitted, renderers decide;
//   • an EMPTY scale (height 0, no range, min==max, or NaN bound) → all
//     conversions return 0.
import { PriceScaleMode, fromLog, toLog, type LogFormula, type MinMax } from './modes';

/** The parameters that fully define the vertical mapping for one frame. */
export interface PriceGeometryParams {
  /** H: scale height, media px. */
  readonly height: number;
  /** The visible price range in LOGICAL space (null on an unset/empty scale). */
  readonly range: MinMax | null;
  /** Option margins as fractions of H (study 04 §2; default top 0.2 / bottom 0.1). */
  readonly scaleMargins: { readonly top: number; readonly bottom: number };
  /** Pixel autoscale margin above the data (study 04 §2; adds to the top fraction). */
  readonly marginAbovePx: number;
  /** Pixel autoscale margin below the data (adds to the bottom fraction). */
  readonly marginBelowPx: number;
  /** Active scale mode (selects the log transform; Percentage/Indexed map linearly
   *  here because the range is already in their logical space). */
  readonly mode: PriceScaleMode;
  /** Inversion: "up is down". Implemented as NOT flipping (study 04 §2). */
  readonly inverted: boolean;
  /** The log formula in effect (only consulted in Logarithmic mode). */
  readonly logFormula: LogFormula;
}

/** The immutable price-geometry snapshot (architecture §6). */
export interface PriceGeometry extends PriceGeometryParams {
  /** Margin band adjacent to logical-MAX = top·H + marginAbovePx (study 04 §4). */
  readonly marginNearMaxLogical: number;
  /** Margin band adjacent to logical-MIN = bottom·H + marginBelowPx. */
  readonly marginNearMinLogical: number;
  /** Pixels reserved at the TOP — derived by the single inversion rule. */
  readonly topMarginPx: number;
  /** Pixels reserved at the BOTTOM — derived by the single inversion rule. */
  readonly bottomMarginPx: number;
  /** h = H − topMarginPx − bottomMarginPx (orientation-independent). */
  readonly internalHeight: number;
  /** Empty: H ≤ 0, no range, min == max, or a NaN bound (study 04 §5). */
  readonly isEmpty: boolean;
  /** logical/raw price → coordinate (study 04 §4.4). Returns 0 on an empty scale. */
  logicalToCoordinate(logical: number): number;
  /** coordinate → logical/raw price (study 04 §4.4). Returns 0 on an empty scale. */
  coordinateToLogical(coord: number): number;
}

function rangeIsEmpty(range: MinMax | null): boolean {
  if (range === null) return true;
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) return true;
  return range.min === range.max;
}

/** Build a PriceGeometry snapshot. Pure; the returned object is frozen. */
export function createPriceGeometry(p: PriceGeometryParams): PriceGeometry {
  const H = p.height;

  // Unified margins (architecture §4.6): each band = option fraction of H PLUS its
  // pixel autoscale margin. Computed ONCE; orientation derived below.
  const marginNearMaxLogical = p.scaleMargins.top * H + p.marginAbovePx;
  const marginNearMinLogical = p.scaleMargins.bottom * H + p.marginBelowPx;

  // THE SINGLE INVERSION RULE — no getter swap. Non-inverted: logical-max sits at
  // the top, so the top band is the near-max margin. Inverted: the orientation
  // flips, so the top band becomes the near-min margin.
  const topMarginPx = p.inverted ? marginNearMinLogical : marginNearMaxLogical;
  const bottomMarginPx = p.inverted ? marginNearMaxLogical : marginNearMinLogical;
  const internalHeight = H - topMarginPx - bottomMarginPx;

  const isEmpty = !(H > 0) || rangeIsEmpty(p.range);
  const isLog = p.mode === PriceScaleMode.Logarithmic;

  const logicalToCoordinate = (logical: number): number => {
    if (isEmpty) return 0;
    const range = p.range as MinMax;
    // Log transform skipped when the value is exactly 0 (study 04 §5: JS truthiness
    // guard doubling as the "is zero" test).
    let value = logical;
    if (isLog && logical !== 0) value = toLog(logical, p.logFormula);
    const length = range.max - range.min;
    const inv = bottomMarginPx + (internalHeight - 1) * ((value - range.min) / length);
    return p.inverted ? inv : H - 1 - inv;
  };

  const coordinateToLogical = (coord: number): number => {
    if (isEmpty) return 0;
    const range = p.range as MinMax;
    const inv = p.inverted ? coord : H - 1 - coord;
    const length = range.max - range.min;
    const logical = range.min + length * ((inv - bottomMarginPx) / (internalHeight - 1));
    return isLog ? fromLog(logical, p.logFormula) : logical;
  };

  return Object.freeze({
    ...p,
    marginNearMaxLogical,
    marginNearMinLogical,
    topMarginPx,
    bottomMarginPx,
    internalHeight,
    isEmpty,
    logicalToCoordinate,
    coordinateToLogical,
  });
}
