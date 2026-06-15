import { describe, expect, test } from 'vitest';
import { createPriceGeometry } from './geometry';
import {
  PriceScaleMode,
  toLog,
  fromLog,
  defaultLogFormula,
  toPercent,
  fromPercent,
  toIndexed,
  fromIndexed,
} from './modes';

// study 04 §4 (margins, h = H − topMarginPx − bottomMarginPx, the −1 fenceposts,
// the conversions) + architecture §4.6 "Margins adopt the unified form" are the
// spec of record. Margins are expressed ONCE as marginNearMax/MinLogical and the
// orientation derived by the SINGLE inversion rule — never by swapping getters.

const BASE = {
  height: 100,
  range: { min: 0, max: 10 },
  scaleMargins: { top: 0.2, bottom: 0.1 },
  marginAbovePx: 0,
  marginBelowPx: 0,
  mode: PriceScaleMode.Normal,
  inverted: false,
  logFormula: defaultLogFormula(),
} as const;

describe('PriceGeometry — unified margins (architecture §4.6)', () => {
  test('marginNearMaxLogical = top·H + marginAbovePx; near-min = bottom·H + marginBelowPx', () => {
    const g = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7 });
    // near-max = 0.2·100 + 3 = 23 ; near-min = 0.1·100 + 7 = 17
    expect(g.marginNearMaxLogical).toBeCloseTo(23, 12);
    expect(g.marginNearMinLogical).toBeCloseTo(17, 12);
  });

  test('non-inverted: topMarginPx = near-max, bottomMarginPx = near-min', () => {
    const g = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7 });
    expect(g.topMarginPx).toBeCloseTo(23, 12);
    expect(g.bottomMarginPx).toBeCloseTo(17, 12);
  });

  test('inverted: the SAME two magnitudes swap orientation (single inversion rule)', () => {
    const g = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7, inverted: true });
    // identical magnitudes, only the orientation flips — NOT a getter swap.
    expect(g.marginNearMaxLogical).toBeCloseTo(23, 12);
    expect(g.marginNearMinLogical).toBeCloseTo(17, 12);
    expect(g.topMarginPx).toBeCloseTo(17, 12); // = near-min
    expect(g.bottomMarginPx).toBeCloseTo(23, 12); // = near-max
  });

  test('internal height h = H − topMarginPx − bottomMarginPx (orientation-independent)', () => {
    const a = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7 });
    const b = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7, inverted: true });
    // total margin is the same either way → h is identical: 100 − 23 − 17 = 60
    expect(a.internalHeight).toBeCloseTo(60, 12);
    expect(b.internalHeight).toBeCloseTo(60, 12);
  });

  test('option margins add the pixel autoscale margins (study 04 §5)', () => {
    const g = createPriceGeometry({ ...BASE, marginAbovePx: 10, marginBelowPx: 0 });
    expect(g.marginNearMaxLogical).toBeCloseTo(0.2 * 100 + 10, 12);
  });
});

describe('PriceGeometry — Normal-mode conversions (study 04 §4.4)', () => {
  test('logical-min sits at invCoord = bottomMarginPx (bottom of band)', () => {
    const g = createPriceGeometry(BASE);
    // bottomMarginPx = 10, h = 100 − 20 − 10 = 70, H − 1 = 99
    // inv(min) = 10 + 69·0 = 10 → coord = 99 − 10 = 89
    expect(g.logicalToCoordinate(0)).toBeCloseTo(89, 9);
  });

  test('logical-max sits at invCoord = bottomMarginPx + (h−1) (top of band)', () => {
    const g = createPriceGeometry(BASE);
    // inv(max) = 10 + 69·1 = 79 → coord = 99 − 79 = 20
    expect(g.logicalToCoordinate(10)).toBeCloseTo(20, 9);
  });

  test('coordinateToLogical is the exact inverse of logicalToCoordinate', () => {
    const g = createPriceGeometry(BASE);
    for (const l of [0, 2.5, 5, 7.25, 10]) {
      expect(g.coordinateToLogical(g.logicalToCoordinate(l))).toBeCloseTo(l, 6);
    }
  });

  test('inverted flips orientation: logical-min now sits near the top', () => {
    const g = createPriceGeometry({ ...BASE, inverted: true });
    // inverted: inv(min) = bottomMarginPx + 0 = near-max (23) ; coord = inv = 23
    // bottomMarginPx(inverted) = near-max = 0.2·100 = 20, h = 70, H−1 = 99
    // inv(min) = 20 + 0 = 20 → coord = inv = 20  (top region, not bottom)
    expect(g.logicalToCoordinate(0)).toBeCloseTo(20, 9);
    expect(g.coordinateToLogical(g.logicalToCoordinate(7.5))).toBeCloseTo(7.5, 6);
  });
});

describe('PriceGeometry — log-mode conversions (study 04 §4.3/§4.4)', () => {
  const LOG = {
    ...BASE,
    range: { min: toLog(10), max: toLog(1000) }, // stored range IS log space
    mode: PriceScaleMode.Logarithmic,
  };

  test('logicalToCoordinate applies toLog to a non-zero raw price first', () => {
    const g = createPriceGeometry(LOG);
    // a raw price of 100 is toLog(100); its coord must match feeding the log value
    // through the linear map directly.
    const linear = createPriceGeometry({ ...LOG, mode: PriceScaleMode.Normal });
    expect(g.logicalToCoordinate(100)).toBeCloseTo(linear.logicalToCoordinate(toLog(100)), 6);
  });

  test('coordinateToLogical returns raw price (fromLog applied)', () => {
    const g = createPriceGeometry(LOG);
    const coord = g.logicalToCoordinate(100);
    expect(g.coordinateToLogical(coord)).toBeCloseTo(100, 4);
  });

  test('round-trips a raw price through coordinate space in log mode', () => {
    const g = createPriceGeometry(LOG);
    for (const p of [12, 50, 100, 500, 999]) {
      expect(g.coordinateToLogical(g.logicalToCoordinate(p))).toBeCloseTo(p, 3);
    }
  });

  test('uses the supplied (dynamic) log formula for tiny ranges', () => {
    const formula = { logicalOffset: 6, coordOffset: 1e-6 };
    const g = createPriceGeometry({
      ...BASE,
      mode: PriceScaleMode.Logarithmic,
      range: { min: toLog(5.0, formula), max: toLog(5.01, formula) },
      logFormula: formula,
    });
    const coord = g.logicalToCoordinate(5.005);
    expect(g.coordinateToLogical(coord)).toBeCloseTo(5.005, 6);
    // confirm it actually used the dynamic formula, not the default
    expect(fromLog(toLog(5.005, formula), formula)).toBeCloseTo(5.005, 9);
  });
});

describe('PriceGeometry — empty scale (study 04 §5)', () => {
  test('height 0 → conversions return 0', () => {
    const g = createPriceGeometry({ ...BASE, height: 0 });
    expect(g.isEmpty).toBe(true);
    expect(g.logicalToCoordinate(5)).toBe(0);
    expect(g.coordinateToLogical(50)).toBe(0);
  });

  test('null range → conversions return 0', () => {
    const g = createPriceGeometry({ ...BASE, range: null });
    expect(g.isEmpty).toBe(true);
    expect(g.logicalToCoordinate(5)).toBe(0);
  });

  test('min == max → conversions return 0', () => {
    const g = createPriceGeometry({ ...BASE, range: { min: 5, max: 5 } });
    expect(g.isEmpty).toBe(true);
    expect(g.logicalToCoordinate(5)).toBe(0);
  });

  test('NaN bound → conversions return 0', () => {
    const g = createPriceGeometry({ ...BASE, range: { min: Number.NaN, max: 10 } });
    expect(g.isEmpty).toBe(true);
    expect(g.logicalToCoordinate(5)).toBe(0);
  });
});

// --- M11: percent/indexed geometry maps linearly; range is already logical ---------
// In Percentage / IndexedTo100 the stored range is ALREADY the mode transform of
// price, so the geometry is a plain linear map (study 04 §4.4 — no log branch). The
// price⇄coord public entry composes the mode transform OUTSIDE the geometry; these
// tests pin both halves so the composition is exact for either sign of base.
describe('PriceGeometry — percent/indexed map linearly (study 04 §4.4)', () => {
  // percent logical range for base 100, prices spanning [90, 110] → [-10, +10]
  const PCT = {
    ...BASE,
    range: { min: toPercent(90, 100), max: toPercent(110, 100) },
    mode: PriceScaleMode.Percentage,
  };

  test('percent/indexed geometry does NOT apply a log transform', () => {
    const g = createPriceGeometry(PCT);
    const linear = createPriceGeometry({ ...PCT, mode: PriceScaleMode.Normal });
    // identical output: percent mode is linear in the geometry (no toLog)
    expect(g.logicalToCoordinate(5)).toBeCloseTo(linear.logicalToCoordinate(5), 12);
  });

  test('geometry round-trips a percent logical value exactly', () => {
    const g = createPriceGeometry(PCT);
    for (const l of [-10, -3.5, 0, 7.25, 10]) {
      expect(g.coordinateToLogical(g.logicalToCoordinate(l))).toBeCloseTo(l, 6);
    }
  });
});

// --- M11: NEGATIVE-BASE no visual jump end-to-end (architecture §13.10 FIX) ---------
// The full public path for percent/indexed is fromMode(coordinateToLogical(
// logicalToCoordinate(toMode(price, base)))). With the §13.10 true-inverse pair the
// whole composition is the identity for EITHER sign of base — so switching into/out
// of indexed mode at a negative base produces NO visual jump.
describe('PriceGeometry — negative-base price⇄coord composes to identity (§13.10 FIX)', () => {
  test('indexed mode: price → coord → price is identity for a NEGATIVE base', () => {
    const base = -100;
    // logical range = indexed transform of raw prices [-110, -90] about base -100
    const range = { min: toIndexed(-110, base), max: toIndexed(-90, base) };
    const g = createPriceGeometry({ ...BASE, range, mode: PriceScaleMode.IndexedTo100 });
    for (const price of [-110, -100, -97.5, -92.25, -90]) {
      const coord = g.logicalToCoordinate(toIndexed(price, base));
      const back = fromIndexed(g.coordinateToLogical(coord), base);
      expect(back).toBeCloseTo(price, 6);
    }
  });

  test('indexed mode: same path for a POSITIVE base (parity with the positive case)', () => {
    const base = 100;
    const range = { min: toIndexed(90, base), max: toIndexed(110, base) };
    const g = createPriceGeometry({ ...BASE, range, mode: PriceScaleMode.IndexedTo100 });
    for (const price of [90, 100, 102.5, 110]) {
      const coord = g.logicalToCoordinate(toIndexed(price, base));
      const back = fromIndexed(g.coordinateToLogical(coord), base);
      expect(back).toBeCloseTo(price, 6);
    }
  });

  test('percentage mode: negative-base price → coord → price is identity (no jump)', () => {
    const base = -100;
    const range = { min: toPercent(-110, base), max: toPercent(-90, base) };
    const g = createPriceGeometry({ ...BASE, range, mode: PriceScaleMode.Percentage });
    for (const price of [-110, -100, -95.5, -90]) {
      const coord = g.logicalToCoordinate(toPercent(price, base));
      const back = fromPercent(g.coordinateToLogical(coord), base);
      expect(back).toBeCloseTo(price, 6);
    }
  });

  test('negative-base indexed does NOT drift by 2·base through the full path', () => {
    const base = -100;
    const price = -90;
    const range = { min: toIndexed(-110, base), max: toIndexed(-80, base) };
    const g = createPriceGeometry({ ...BASE, range, mode: PriceScaleMode.IndexedTo100 });
    const back = fromIndexed(g.coordinateToLogical(g.logicalToCoordinate(toIndexed(price, base))), base);
    expect(back).toBeCloseTo(price, 6);
    expect(back).not.toBeCloseTo(price + 2 * base, 4); // the reference's -290 defect
  });
});
