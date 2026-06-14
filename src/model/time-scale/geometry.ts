// The HorzGeometry value object (architecture §4.6 / §6, study 03 §4.1–§4.3 are
// the spec of record). A plain immutable snapshot parameterized by exactly
// { width, barSpacing, rightOffset, baseIndex } that exposes the kept index↔
// coordinate transforms. It holds NO model reference, so it is trivially unit-
// testable, serializable, and shareable (the §9.3 "geometry as values" item).
//
// Conventions that are load-bearing for pixel parity (study 03 §5):
//   • the +0.5 centers a logical index within its bar slot;
//   • the −1 anchors the right edge to the last addressable column W − 1;
//   • coordinateToLogical returns a CONTINUOUS float (architecture §13.5) — the
//     api-layer `snapToBar` does the integer ceil, not this object.
//
// indexToCoordinate and coordinateToLogical are TRUE continuous inverses:
//   indexToCoordinate(v) = W − (B + R − v + 0.5)·S − 1
//   coordinateToLogical(x) = B + R + 0.5 − (W − 1 − x)/S        (then 1e-6-quantized)
// (Solving the first for v yields the second; the reference's §4.2 bar-ownership
// formula drops the +0.5 because it feeds an immediate ceil — the lossy public
// path. The value object keeps the un-snapped inverse so zoom-anchor pinning and
// drawing tools get sub-bar precision, study 03 §4.8 / IMPROVE.)
import type { Logical } from '../../core';

/** The four numbers that fully parameterize the horizontal mapping. */
export interface HorzGeometryParams {
  /** W: scale width, media px. */
  readonly width: number;
  /** S: media px per bar. */
  readonly barSpacing: number;
  /** R: bars of right margin (may be fractional / negative). */
  readonly rightOffset: number;
  /** B: newest TimeIndex with data. */
  readonly baseIndex: number;
}

/** Inclusive integer bar range, floor/ceil-widened from the logical borders. */
export interface StrictRange {
  readonly left: number;
  readonly right: number;
}

/** Fractional logical viewport range `[leftBorder, rightBorder]` (study 03 §4.3). */
export interface LogicalRange {
  readonly from: Logical;
  readonly to: Logical;
}

/**
 * The immutable time-geometry value object (architecture §6). Built once per
 * frame from the navigator's live `{ width, barSpacing, rightOffset, baseIndex }`
 * and consumed by views (as a function-bag) and the public time-scale handle.
 */
export interface HorzGeometry extends HorzGeometryParams {
  /** Continuous: x = W − (B + R − ix + 0.5)·S − 1 (study 03 §4.1). */
  indexToCoordinate(ix: number): number;
  /** Continuous float inverse; quantized to 1e-6 (study 03 §4.2; architecture §13.5). */
  coordinateToLogical(x: number): Logical;
  /** `[leftBorder, rightBorder]` floats, or null on an empty scale. */
  visibleLogicalRange(): LogicalRange | null;
  /** `[floor(left), ceil(right)]` ints, or null on an empty scale. */
  visibleStrictRange(): StrictRange | null;
}

/** Quantize to 1e-6 to kill accumulated FP error (study 03 §4.2 / §5). */
function quantize(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** A geometry is empty when it has no width (study 03 §5: also no points / null
 *  base, but those collapse to "the navigator never builds a geometry"). */
function isEmpty(p: HorzGeometryParams): boolean {
  return !(p.width > 0);
}

/** Build a HorzGeometry snapshot. Pure; the returned object is frozen. */
export function createHorzGeometry(p: HorzGeometryParams): HorzGeometry {
  const { width: W, barSpacing: S, rightOffset: R, baseIndex: B } = p;

  const indexToCoordinate = (ix: number): number => W - (B + R - ix + 0.5) * S - 1;

  const coordinateToLogical = (x: number): Logical =>
    quantize(B + R + 0.5 - (W - 1 - x) / S) as Logical;

  const visibleLogicalRange = (): LogicalRange | null => {
    if (isEmpty(p)) return null;
    const barsLength = W / S;
    const rightBorder = R + B;
    const leftBorder = rightBorder - barsLength + 1;
    return { from: leftBorder as Logical, to: rightBorder as Logical };
  };

  const visibleStrictRange = (): StrictRange | null => {
    const lr = visibleLogicalRange();
    if (lr === null) return null;
    return { left: Math.floor(lr.from as number), right: Math.ceil(lr.to as number) };
  };

  return Object.freeze({
    width: W,
    barSpacing: S,
    rightOffset: R,
    baseIndex: B,
    indexToCoordinate,
    coordinateToLogical,
    visibleLogicalRange,
    visibleStrictRange,
  });
}
