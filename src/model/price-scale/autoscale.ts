// Autoscale range assembly (study 04 §4.1 — the autoscale pass + finiteMerge +
// degenerate widening + adaptive-log re-derivation; architecture §9.2.3 — margins
// are MAX-merged through ONE merge fn used by series / primitives / indicators).
//
// Each contributor supplies a RAW price range + its own firstValue (needed by the
// percentage / indexed transforms, which are per-source) + optional pixel margins.
// assembleRange returns the merged range already expressed in the mode's logical
// space (raw for Normal, log for Log, percent/indexed for those modes), so the
// PriceGeometry consumes it directly. Returns null when nothing contributes a
// range (the caller keeps its existing range).
import {
  PriceScaleMode,
  logFormulaForRange,
  toIndexed,
  toLogRange,
  toPercent,
  type LogFormula,
  type MinMax,
} from './modes';

export interface AutoscaleMargins {
  readonly above: number;
  readonly below: number;
}

export interface AutoscaleContributor {
  readonly firstValue: number | null; // null = no data → skipped
  readonly range: MinMax | null; // raw price range, or null
  readonly margins: AutoscaleMargins | null;
}

export interface AssembledRange {
  readonly range: MinMax; // in the mode's logical space
  readonly margins: AutoscaleMargins;
  readonly logFormula: LogFormula;
}

/** Minimum of the FINITE candidate values; −Infinity when none is finite. */
function finiteMin(a: number, b: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return Math.min(a, b);
  if (af) return a;
  if (bf) return b;
  return -Infinity;
}

/** Maximum of the FINITE candidate values; +Infinity when none is finite. */
function finiteMax(a: number, b: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return Math.max(a, b);
  if (af) return a;
  if (bf) return b;
  return Infinity;
}

/** Per-bound merge that lets a finite bound win over a non-finite one (study 04 §4.1). */
export function finiteMerge(a: MinMax, b: MinMax): MinMax {
  return { min: finiteMin(a.min, b.min), max: finiteMax(a.max, b.max) };
}

/** MAX-merge of margins across contributors — the ONE merge fn (architecture §9.2.3). */
export function mergeMargins(margins: readonly AutoscaleMargins[]): AutoscaleMargins {
  let above = 0;
  let below = 0;
  for (const m of margins) {
    if (m.above > above) above = m.above;
    if (m.below > below) below = m.below;
  }
  return { above, below };
}

/** A zero-width range is widened by ±5·minMove (10 min-moves total; study 04 §4.1). */
function widenIfDegenerate(range: MinMax, minMove: number): MinMax {
  if (range.min === range.max) {
    return { min: range.min - 5 * minMove, max: range.max + 5 * minMove };
  }
  return range;
}

export function assembleRange(opts: {
  contributors: readonly AutoscaleContributor[];
  mode: PriceScaleMode;
  minMove: number;
  logFormula: LogFormula;
}): AssembledRange | null {
  const { contributors, mode, minMove } = opts;
  const isPercentLike = mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100;
  const transform = mode === PriceScaleMode.Percentage ? toPercent : toIndexed;

  const marginsList: AutoscaleMargins[] = [];
  let mergedRaw: MinMax | null = null;
  let mergedTransformed: MinMax | null = null;

  for (const c of contributors) {
    if (c.firstValue === null || c.range === null) continue; // no data → skip
    if (c.margins !== null) marginsList.push(c.margins);
    mergedRaw = mergedRaw === null ? c.range : finiteMerge(mergedRaw, c.range);
    if (isPercentLike) {
      // percent/indexed transform each source by ITS OWN first value before merging.
      const tr: MinMax = {
        min: transform(c.range.min, c.firstValue),
        max: transform(c.range.max, c.firstValue),
      };
      mergedTransformed = mergedTransformed === null ? tr : finiteMerge(mergedTransformed, tr);
    }
  }

  if (mergedRaw === null) return null;
  const margins = mergeMargins(marginsList);

  if (isPercentLike) {
    const range = widenIfDegenerate(mergedTransformed as MinMax, minMove);
    return { range, margins, logFormula: opts.logFormula };
  }
  if (mode === PriceScaleMode.Logarithmic) {
    // widen in RAW space first, then re-derive the adaptive formula and re-log.
    const widenedRaw = widenIfDegenerate(mergedRaw, minMove);
    const logFormula = logFormulaForRange(widenedRaw);
    return { range: toLogRange(widenedRaw, logFormula), margins, logFormula };
  }
  // Normal
  return { range: widenIfDegenerate(mergedRaw, minMove), margins, logFormula: opts.logFormula };
}
