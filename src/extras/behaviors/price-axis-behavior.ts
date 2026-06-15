// traderzview · extras/behaviors — the NON-TIME horizontal-scale behaviors (design 05
// §7; the S2/S3 in-tree proof). A chart's horizontal axis need not be time: a `price-axis`
// chart plots value-against-PRICE (an options-greeks / volume-profile x), a `yield-curve`
// chart plots value-against-MATURITY (tenor in days). Both are an ordinary
// IHorzScaleBehavior<number> handed to the PUBLIC `createChartWith(container, backend,
// behavior, ...)` factory — NO bespoke chart factory, NO core change: the three-layer
// §4.3 defaults pipeline runs the behavior's `augmentDefaults` exactly as it does for the
// time behavior (S2), and the behavior MINTS its own integer weights on the open weight
// scale (S3 — the core never enumerated a "price decade" or "tenor week" band, yet a
// behavior may emit any non-negative integer and the tick engine ranks by magnitude).
//
// Built ONLY on the PUBLIC api seams: the IHorzScaleBehavior / HorzPoint strategy surface
// + the LocalizationOptions / HorzScaleOptionGroups groups (design 02 §13.3, re-exported
// at the api barrel) and the core HorzKey brand (extras may import core, arch §3.1) —
// never model/views (dep-cruiser E1). `H = I = number`: the user value IS the behavior's
// internal item, so no per-batch conversion is needed. erasableSyntaxOnly: const-object
// weight bands, no enum.
import type { HorzKey } from '../../core';
import type { HorzPoint, HorzScaleOptionGroups, IHorzScaleBehavior } from '../../api';

// --- the open integer weight bands these behaviors MINT (S3) ------------------------
// The core time behavior enumerates second/minute/hour/day/month/year bands (study 03
// §2). A non-time scale needs DIFFERENT magnitude bands — the weight scale is OPEN, so we
// pick our own: a larger weight = a "rounder", more prominent tick (a decade > a unit; a
// year of maturity > a week). The tick engine only ever COMPARES weights (maxTickWeight +
// the host's bolding threshold), never enumerates them, so any non-negative integer is a
// legal weight the core never named. These constants document the bands we coined.
const PRICE_WEIGHT = {
  Fraction: 5, // a sub-unit gridline (… .25, .5)
  Unit: 10, // a whole unit
  Ten: 20,
  Hundred: 30,
  Thousand: 40,
  TenThousand: 50,
} as const;

/** Largest power-of-ten boundary `v` crosses relative to `prev`, as a minted weight. */
function priceWeight(v: number, prev: number): number {
  if (Math.floor(v / 10000) !== Math.floor(prev / 10000)) return PRICE_WEIGHT.TenThousand;
  if (Math.floor(v / 1000) !== Math.floor(prev / 1000)) return PRICE_WEIGHT.Thousand;
  if (Math.floor(v / 100) !== Math.floor(prev / 100)) return PRICE_WEIGHT.Hundred;
  if (Math.floor(v / 10) !== Math.floor(prev / 10)) return PRICE_WEIGHT.Ten;
  if (Math.floor(v) !== Math.floor(prev)) return PRICE_WEIGHT.Unit;
  // sub-unit: only emit a Fraction weight when the fractional part actually moved.
  return v !== prev ? PRICE_WEIGHT.Fraction : 0;
}

/**
 * A price/level horizontal-scale behavior (design 05 §7). The H item is a plain number
 * (a price level); `key` is the value itself (already sortable), `cacheKey` likewise.
 * `fillWeights` mints decade-magnitude weights on the open scale (S3); `formatTick`/
 * `formatItem` render the number with a configurable precision, honoring the user
 * `priceFormatter` localization hook when present. `augmentDefaults` seeds the
 * localization group (S2 — the three-layer pipeline consults it exactly as for time).
 */
export function priceAxisBehavior(options?: { precision?: number }): IHorzScaleBehavior<number, number> {
  const precision = options?.precision ?? 2;
  return numberBehavior({
    weightOf: priceWeight,
    label: (v) => v.toFixed(precision),
    augment: (defaults): void => {
      defaults.localization.dateFormat = ''; // a price scale is not a date
    },
  });
}

// --- yield-curve behavior (maturity / tenor in days) --------------------------------

const TENOR_WEIGHT = {
  Day: 10,
  Week: 20,
  Month: 30,
  Year: 40,
} as const;

/** A tenor (days-to-maturity) weight: the largest calendar boundary `v` crosses. */
function tenorWeight(v: number, prev: number): number {
  if (Math.floor(v / 365) !== Math.floor(prev / 365)) return TENOR_WEIGHT.Year;
  if (Math.floor(v / 30) !== Math.floor(prev / 30)) return TENOR_WEIGHT.Month;
  if (Math.floor(v / 7) !== Math.floor(prev / 7)) return TENOR_WEIGHT.Week;
  return v !== prev ? TENOR_WEIGHT.Day : 0;
}

/** Render a tenor (days) as a human label: `1Y`, `6M`, `2W`, `30D`. */
function formatTenor(days: number): string {
  if (days >= 365 && days % 365 === 0) return `${days / 365}Y`;
  if (days >= 30 && days % 30 === 0) return `${days / 30}M`;
  if (days >= 7 && days % 7 === 0) return `${days / 7}W`;
  return `${days}D`;
}

/**
 * A yield-curve horizontal-scale behavior (design 05 §7): the H item is days-to-maturity
 * (a tenor). Same non-time pattern as {@link priceAxisBehavior} — value-keyed, open-scale
 * tenor weights (S3), `formatTick` renders `1Y`/`6M`/`30D`. Proves a chart whose x is
 * neither time nor a linear price drops straight onto `createChartWith` (S2).
 */
export function yieldCurveBehavior(): IHorzScaleBehavior<number, number> {
  return numberBehavior({
    weightOf: tenorWeight,
    label: formatTenor,
    augment: (defaults): void => {
      defaults.localization.dateFormat = '';
    },
  });
}

// --- the shared numeric-behavior core (both non-time behaviors fold through here) ----

interface NumberBehaviorInit {
  /** The minted weight for value `v` given its predecessor `prev` (the open scale, S3). */
  weightOf(v: number, prev: number): number;
  /** The default label for a value (number → string). */
  label(v: number): string;
  augment(defaults: HorzScaleOptionGroups<number>): void;
}

function numberBehavior(init: NumberBehaviorInit): IHorzScaleBehavior<number, number> {
  return {
    // H === I === number; the value is already the sortable key (and the cache identity).
    key: (item) => item as unknown as HorzKey,
    cacheKey: (item) => item,
    toInternal: () => (item) => item, // identity converter — no per-batch conversion
    formatItem: (item, loc) =>
      loc.priceFormatter !== undefined ? loc.priceFormatter(item) : init.label(item),
    formatTick: (item, _weight, loc) =>
      loc.priceFormatter !== undefined ? loc.priceFormatter(item) : init.label(item),
    fillWeights: (points: readonly HorzPoint<number>[], startIndex: number): void => {
      const n = points.length;
      if (n === 0) return;
      let prev: number | null = startIndex > 0 ? points[startIndex - 1]!.item : null;
      for (let i = startIndex; i < n; i++) {
        const cur = points[i]!.item;
        // the first point (no predecessor) gets a top band so it always labels.
        points[i]!.weight = prev === null ? init.weightOf(cur, cur - 1) : init.weightOf(cur, prev);
        prev = cur;
      }
    },
    maxTickWeight: (weights: readonly number[]): number => {
      let max = 0;
      for (const w of weights) if (w > max) max = w;
      return max;
    },
    augmentDefaults: init.augment,
  };
}
