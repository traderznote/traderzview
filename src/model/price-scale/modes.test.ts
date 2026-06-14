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
} from './modes';

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
