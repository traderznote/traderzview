import { describe, expect, test } from 'vitest';
import {
  PriceScaleMode,
  isAutoScaleForced,
  refusesManualScale,
  toPercent,
  fromPercent,
  toIndexed,
  fromIndexed,
  toLog,
  fromLog,
  toLogRange,
  fromLogRange,
  defaultLogFormula,
  logFormulaForRange,
  canConvertFromLog,
  reexpressLogRange,
  deNoiseLogVisibleRange,
} from './modes';
import { precisionByMinMove } from '../../fmt';

// study 04 §4.2 (percent/indexed), §4.3 (log + adaptive formula), architecture
// §13.10 (indexed inverse FIXED) are the spec of record.

describe('mode flags (study 04 §3.4, architecture §4.6)', () => {
  test('the four modes are distinct const-object members (no enum)', () => {
    expect(PriceScaleMode.Normal).not.toBe(PriceScaleMode.Logarithmic);
    expect(PriceScaleMode.Percentage).not.toBe(PriceScaleMode.IndexedTo100);
  });

  test('percentage and indexed refuse manual scale; normal and log allow it', () => {
    expect(refusesManualScale(PriceScaleMode.Percentage)).toBe(true);
    expect(refusesManualScale(PriceScaleMode.IndexedTo100)).toBe(true);
    expect(refusesManualScale(PriceScaleMode.Normal)).toBe(false);
    expect(refusesManualScale(PriceScaleMode.Logarithmic)).toBe(false);
  });

  test('percentage and indexed force autoScale on entry; normal/log do not', () => {
    expect(isAutoScaleForced(PriceScaleMode.Percentage)).toBe(true);
    expect(isAutoScaleForced(PriceScaleMode.IndexedTo100)).toBe(true);
    expect(isAutoScaleForced(PriceScaleMode.Normal)).toBe(false);
    expect(isAutoScaleForced(PriceScaleMode.Logarithmic)).toBe(false);
  });
});

describe('percentage transform (study 04 §4.2)', () => {
  test('positive base: r = 100·(v−b)/b', () => {
    expect(toPercent(110, 100)).toBeCloseTo(10, 12);
    expect(toPercent(90, 100)).toBeCloseTo(-10, 12);
    expect(toPercent(100, 100)).toBeCloseTo(0, 12);
  });

  test('positive base round-trips exactly', () => {
    const b = 100;
    for (const v of [50, 100, 137.25, 200, -30]) {
      expect(fromPercent(toPercent(v, b), b)).toBeCloseTo(v, 9);
    }
  });

  test('negative base negates so "price up" still maps up, and round-trips', () => {
    const b = -100;
    // v = -90 is "up" from -100; r = 100·(-90+100)/-100 = -10; negated → +10
    expect(toPercent(-90, b)).toBeCloseTo(10, 12);
    for (const v of [-50, -100, -137.25, -10]) {
      expect(fromPercent(toPercent(v, b), b)).toBeCloseTo(v, 9);
    }
  });
});

describe('indexed-to-100 transform (study 04 §4.2, architecture §13.10 FIX)', () => {
  test('positive base: index = percent + 100', () => {
    expect(toIndexed(110, 100)).toBeCloseTo(110, 12);
    expect(toIndexed(100, 100)).toBeCloseTo(100, 12);
    expect(toIndexed(90, 100)).toBeCloseTo(90, 12);
  });

  test('positive base round-trips exactly', () => {
    const b = 100;
    for (const v of [50, 100, 137.25, 200]) {
      expect(fromIndexed(toIndexed(v, b), b)).toBeCloseTo(v, 9);
    }
  });

  // THE §13.10 FIX: the reference's pair was NOT a true inverse for b<0
  // (round-tripped to v + 2b). traderzview negates the percent part BEFORE
  // adding 100 so the pair is a true inverse for either sign of base.
  test('negative base IS a true inverse (the §13.10 FIX)', () => {
    const b = -100;
    for (const v of [-50, -100, -137.25, -10, -250]) {
      expect(fromIndexed(toIndexed(v, b), b)).toBeCloseTo(v, 9);
    }
  });

  test('negative base: "price up" maps above 100 (direction preserved)', () => {
    const b = -100;
    // -90 is up from -100 → percent +10 → index 110 (> 100)
    expect(toIndexed(-90, b)).toBeGreaterThan(100);
    // -110 is down → below 100
    expect(toIndexed(-110, b)).toBeLessThan(100);
  });

  test('indexed at base value equals exactly 100 for either sign', () => {
    expect(toIndexed(100, 100)).toBeCloseTo(100, 12);
    expect(toIndexed(-100, -100)).toBeCloseTo(100, 12);
  });
});

describe('logarithmic transform (study 04 §4.3)', () => {
  test('zero guard: |p| < 1e−15 maps to 0 both ways', () => {
    expect(toLog(0)).toBe(0);
    expect(toLog(1e-16)).toBe(0);
    expect(fromLog(0)).toBe(0);
    expect(fromLog(1e-16)).toBe(0);
  });

  test('default formula: toLog(1) ≈ 4 (L=4, C=1e−4)', () => {
    // sign·(log10(|1| + 1e-4) + 4) ≈ log10(1.0001) + 4 ≈ 4.0000434
    expect(toLog(1)).toBeCloseTo(Math.log10(1.0001) + 4, 9);
  });

  test('symmetric around 0: toLog(−p) = −toLog(p)', () => {
    expect(toLog(-50)).toBeCloseTo(-toLog(50), 12);
  });

  test('toLog/fromLog round-trip across magnitudes', () => {
    for (const p of [0.001, 0.5, 1, 42, 1000, -7, -1234.5]) {
      expect(fromLog(toLog(p))).toBeCloseTo(p, 6);
    }
  });

  test('range helpers apply the point transform to both bounds', () => {
    const r = toLogRange({ min: 10, max: 100 });
    expect(r.min).toBeCloseTo(toLog(10), 12);
    expect(r.max).toBeCloseTo(toLog(100), 12);
    const back = fromLogRange(r);
    expect(back.min).toBeCloseTo(10, 6);
    expect(back.max).toBeCloseTo(100, 6);
  });
});

describe('adaptive log formula (study 04 §4.3)', () => {
  test('null range → default formula', () => {
    expect(logFormulaForRange(null)).toEqual(defaultLogFormula());
  });

  test('range width ≥ 1 → default formula', () => {
    expect(logFormulaForRange({ min: 10, max: 100 })).toEqual(defaultLogFormula());
  });

  test('range width < 1e−15 → default formula', () => {
    expect(logFormulaForRange({ min: 5, max: 5 + 1e-16 })).toEqual(defaultLogFormula());
  });

  test('tiny range: L = 4 + ceil(|log10(d)|), C = 10^(−L)', () => {
    // d = 0.5 → log10 ≈ -0.301 → digits = ceil(0.301) = 1 → L=5, C=1e-5
    const f = logFormulaForRange({ min: 5.0, max: 5.5 });
    expect(f.logicalOffset).toBe(5);
    expect(f.coordOffset).toBeCloseTo(1e-5, 18);
  });

  test('tiny-range round-trip uses the re-derived formula (dynamic re-derivation)', () => {
    const raw = { min: 5.0, max: 5.001 }; // d = 0.001
    const f = logFormulaForRange(raw);
    // round-trip a value with the dynamic formula
    const x = toLog(5.0005, f);
    expect(fromLog(x, f)).toBeCloseTo(5.0005, 9);
    // the default formula would flatten the distinction; the dynamic one separates
    const lo = toLog(5.0, f);
    const hi = toLog(5.001, f);
    expect(hi - lo).toBeGreaterThan(toLog(5.001) - toLog(5.0));
  });
});

describe('canConvertFromLog (study 04 §4.3)', () => {
  test('finite both bounds → true', () => {
    expect(canConvertFromLog(toLogRange({ min: 10, max: 100 }))).toBe(true);
  });

  test('non-finite bound → false', () => {
    expect(canConvertFromLog({ min: Number.NaN, max: 5 })).toBe(false);
    expect(canConvertFromLog({ min: 0, max: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

// --- M11: indexed negative-base round-trips to IDENTITY (architecture §13.10) -----
// The §13.10 FIX promise restated as the property the navigator/converter rely on:
// the forward+inverse pair composes to the identity for EITHER sign of base, so a
// mode/formula change at a negative base produces NO visual jump.
describe('indexed-to-100 negative-base composes to IDENTITY (architecture §13.10 FIX)', () => {
  test('fromIndexed∘toIndexed = identity for negative base (no v+2b drift)', () => {
    for (const b of [-100, -1, -0.5, -1234.5]) {
      for (const v of [-50, -100, -137.25, -10, -250, -0.25]) {
        expect(fromIndexed(toIndexed(v, b), b)).toBeCloseTo(v, 9);
      }
    }
  });

  test('toIndexed∘fromIndexed = identity (the other composition order) for negative base', () => {
    const b = -100;
    for (const x of [80, 95, 100, 110, 137.5]) {
      expect(toIndexed(fromIndexed(x, b), b)).toBeCloseTo(x, 9);
    }
  });

  test('explicitly NOT the reference defect: a negative-base round-trip does NOT land at v+2b', () => {
    const b = -100;
    const v = -90;
    const back = fromIndexed(toIndexed(v, b), b);
    expect(back).toBeCloseTo(v, 9);
    expect(back).not.toBeCloseTo(v + 2 * b, 6); // v+2b = -290 — the reference's wrong result
  });

  test('percentage negative base also composes to identity (already correct in the reference)', () => {
    const b = -100;
    for (const v of [-50, -137.25, -10]) {
      expect(fromPercent(toPercent(v, b), b)).toBeCloseTo(v, 9);
    }
  });
});

// --- M11: mid-drag re-expression of a live log range (study 04 §4.1/§5/§6) ---------
describe('reexpressLogRange — mid-drag re-expression (study 04 §4.1 "re-express live drag snapshot")', () => {
  test('same formula is the identity (content-equal old/new → range unchanged)', () => {
    const f = defaultLogFormula();
    const r = toLogRange({ min: 10, max: 100 }, f);
    const out = reexpressLogRange(r, f, f);
    expect(out.min).toBeCloseTo(r.min, 9);
    expect(out.max).toBeCloseTo(r.max, 9);
  });

  test('preserves the RAW prices the bounds denote across a formula change (no visual jump)', () => {
    // a range pinned to raw [5.0, 5.5] under the default formula, then the adaptive
    // formula kicks in (d = 0.5 → L=5,C=1e-5). The re-expressed range must denote
    // the SAME raw prices under the new formula.
    const oldF = defaultLogFormula();
    const newF = logFormulaForRange({ min: 5.0, max: 5.5 });
    expect(newF.logicalOffset).toBe(5); // sanity: the adaptive formula actually changed
    const stored = toLogRange({ min: 5.0, max: 5.5 }, oldF);
    const re = reexpressLogRange(stored, oldF, newF);
    // re-expressed bounds are the new formula's encoding of the same raw prices
    expect(re.min).toBeCloseTo(toLog(5.0, newF), 9);
    expect(re.max).toBeCloseTo(toLog(5.5, newF), 9);
    // and decode back to the original raw prices under the new formula
    expect(fromLog(re.min, newF)).toBeCloseTo(5.0, 7);
    expect(fromLog(re.max, newF)).toBeCloseTo(5.5, 7);
  });

  test('is the exact compose toLogRange(fromLogRange(r, old), new)', () => {
    const oldF = { logicalOffset: 4, coordOffset: 1e-4 };
    const newF = { logicalOffset: 6, coordOffset: 1e-6 };
    const r = toLogRange({ min: 42, max: 137 }, oldF);
    const out = reexpressLogRange(r, oldF, newF);
    const expected = toLogRange(fromLogRange(r, oldF), newF);
    expect(out.min).toBeCloseTo(expected.min, 12);
    expect(out.max).toBeCloseTo(expected.max, 12);
  });

  test('does NOT re-sort bounds (study 04 §4.2: ranges are not re-sorted)', () => {
    // a deliberately inverted (min > max) log range stays inverted after re-expression
    const oldF = defaultLogFormula();
    const newF = logFormulaForRange({ min: 5.0, max: 5.1 });
    const inverted = { min: toLog(5.1, oldF), max: toLog(5.0, oldF) }; // min > max on purpose
    const out = reexpressLogRange(inverted, oldF, newF);
    expect(out.min).toBeGreaterThan(out.max);
  });
});

// --- M11: log de-noise on getVisibleRange (design 02 §10 / study 09 §4.8) ----------
describe('deNoiseLogVisibleRange — getVisibleRange de-noise (study 09 §4.8)', () => {
  test('snaps fromLog bounds to the tick grid and trims to precisionByMinMove', () => {
    // store raw [10, 100] in log space, then de-noise back: round(v/minMove)*minMove
    const minMove = 0.01;
    const f = defaultLogFormula();
    const stored = toLogRange({ min: 10, max: 100 }, f);
    const out = deNoiseLogVisibleRange(stored, f, minMove);
    expect(out.from).toBeCloseTo(10, 9);
    expect(out.to).toBeCloseTo(100, 9);
    // exactness: the result is on the tick grid to precisionByMinMove(0.01) = 2 dp
    expect(precisionByMinMove(minMove)).toBe(2);
    expect(out.from).toBe(Number((10).toFixed(2)));
    expect(out.to).toBe(Number((100).toFixed(2)));
  });

  test('hand-derived: a noisy fromLog value snaps to the nearest minMove and rounds', () => {
    // hand-derive: raw bound 12.3456 with minMove 0.01 → round(1234.56)*0.01 = 12.35
    const minMove = 0.01;
    const precision = precisionByMinMove(minMove); // 2
    const f = defaultLogFormula();
    const stored = { min: toLog(12.3456, f), max: toLog(987.654, f) };
    const out = deNoiseLogVisibleRange(stored, f, minMove);
    // expected = toNumber( (round(v/minMove)*minMove).toFixed(precision) )
    const expFrom = Number((Math.round(12.3456 / minMove) * minMove).toFixed(precision));
    const expTo = Number((Math.round(987.654 / minMove) * minMove).toFixed(precision));
    expect(out.from).toBe(expFrom); // 12.35
    expect(out.to).toBe(expTo); // 987.65
    expect(out.from).toBe(12.35);
    expect(out.to).toBe(987.65);
  });

  test('minMove 0.25 snaps to quarter ticks (precision 2)', () => {
    const minMove = 0.25;
    const f = defaultLogFormula();
    // raw 100.30 → round(401.2)*0.25 = 100.25 ; raw 100.40 → round(401.6)*0.25 = 100.50
    const stored = { min: toLog(100.3, f), max: toLog(100.4, f) };
    const out = deNoiseLogVisibleRange(stored, f, minMove);
    expect(out.from).toBe(100.25);
    expect(out.to).toBe(100.5);
  });

  test('minMove >= 1 → precision 0, snaps to integers', () => {
    const minMove = 1;
    const f = defaultLogFormula();
    const stored = { min: toLog(10.4, f), max: toLog(99.6, f) };
    const out = deNoiseLogVisibleRange(stored, f, minMove);
    expect(precisionByMinMove(minMove)).toBe(0);
    expect(out.from).toBe(10);
    expect(out.to).toBe(100);
  });

  test('kills exp(log(x)) float noise: result is bit-stable to the tick grid', () => {
    // round-tripping 137.25 through log space leaves ~1e-13 noise; de-noise pins it.
    const minMove = 0.01;
    const f = logFormulaForRange({ min: 137.2, max: 137.3 }); // d = 0.1 < 1 → adaptive (L=5)
    const stored = { min: toLog(137.25, f), max: toLog(137.26, f) };
    const out = deNoiseLogVisibleRange(stored, f, minMove);
    expect(out.from).toBe(137.25);
    expect(out.to).toBe(137.26);
    // the raw fromLog values carry noise that === would reject; the de-noised ones don't
    expect(Number.isInteger(out.from / minMove)).toBe(true);
  });

  test('does NOT re-sort: from/to keep the stored bound order (study 04 §4.2)', () => {
    const minMove = 0.01;
    const f = defaultLogFormula();
    const inverted = { min: toLog(100, f), max: toLog(10, f) }; // min encodes a larger raw price
    const out = deNoiseLogVisibleRange(inverted, f, minMove);
    expect(out.from).toBeCloseTo(100, 6);
    expect(out.to).toBeCloseTo(10, 6);
    expect(out.from).toBeGreaterThan(out.to);
  });
});
