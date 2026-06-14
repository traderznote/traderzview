import { describe, expect, test } from 'vitest';
import type { Logical } from '../../core';
import { createHorzGeometry } from './geometry';

// study 03 §4.1/§4.2 are the spec of record: the +0.5 slot-centering and the
// −1 last-column anchor. The value object exposes CONTINUOUS-float inverses
// (architecture §6, §13.5); integer ceil snapping is a separate api-layer call.

describe('HorzGeometry — index → coordinate (study 03 §4.1)', () => {
  test('exact formula x = W − (B + R − ix + 0.5)·S − 1', () => {
    const g = createHorzGeometry({ width: 800, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    // ix = baseIndex (rightmost data bar): deltaFromRight = 0
    // x = 800 − (0 + 0.5)·6 − 1 = 800 − 3 − 1 = 796
    expect(g.indexToCoordinate(100)).toBe(796);
  });

  test('right offset pushes the base bar left by R·S', () => {
    const g = createHorzGeometry({ width: 800, barSpacing: 6, rightOffset: 5, baseIndex: 100 });
    // deltaFromRight = B + R − ix = 100 + 5 − 100 = 5
    // x = 800 − (5 + 0.5)·6 − 1 = 800 − 33 − 1 = 766
    expect(g.indexToCoordinate(100)).toBe(766);
  });

  test('one bar left of base is exactly S px to the left', () => {
    const g = createHorzGeometry({ width: 800, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    expect(g.indexToCoordinate(100) - g.indexToCoordinate(99)).toBeCloseTo(6, 9);
  });

  test('accepts fractional (continuous) logical input', () => {
    const g = createHorzGeometry({ width: 800, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    // halfway between bar 99 and bar 100
    const mid = g.indexToCoordinate(99.5);
    expect(mid).toBeCloseTo((g.indexToCoordinate(99) + g.indexToCoordinate(100)) / 2, 9);
  });
});

describe('HorzGeometry — coordinate → logical (study 03 §4.2, continuous)', () => {
  test('continuous float inverse of indexToCoordinate', () => {
    const g = createHorzGeometry({ width: 800, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    // the coordinate of bar-100 center maps back to logical 100
    expect(g.coordinateToLogical(796)).toBeCloseTo(100, 6);
  });

  test('is quantized to 1e-6 to kill float noise (study 03 §5)', () => {
    const g = createHorzGeometry({ width: 800, barSpacing: 7, rightOffset: 3, baseIndex: 42 });
    const lg = g.coordinateToLogical(123.456789);
    // result has at most 6 fractional digits
    expect(lg).toBe(Math.round((lg as number) * 1e6) / 1e6);
  });
});

describe('HorzGeometry — mutual continuous inverse (roadmap §M5(c))', () => {
  const cases: { width: number; barSpacing: number; rightOffset: number; baseIndex: number }[] = [
    { width: 800, barSpacing: 6, rightOffset: 0, baseIndex: 100 },
    { width: 1000, barSpacing: 12.5, rightOffset: 7.25, baseIndex: 0 },
    { width: 333, barSpacing: 0.5, rightOffset: -4.5, baseIndex: 9 },
    { width: 640, barSpacing: 3.3333, rightOffset: 13, baseIndex: 500 },
  ];

  test('coordinateToLogical(indexToCoordinate(v)) ≈ v for continuous v', () => {
    for (const p of cases) {
      const g = createHorzGeometry(p);
      for (const v of [-12.5, -1, 0, 0.5, 3.7, 50, 99.999, 250.25]) {
        const round = g.coordinateToLogical(g.indexToCoordinate(v));
        expect(round as number).toBeCloseTo(v, 5);
      }
    }
  });

  test('indexToCoordinate(coordinateToLogical(x)) ≈ x for continuous x', () => {
    for (const p of cases) {
      const g = createHorzGeometry(p);
      for (const x of [0, 1, 17.5, 200, 333.33, 640]) {
        const round = g.indexToCoordinate(g.coordinateToLogical(x) as number);
        expect(round).toBeCloseTo(x, 4);
      }
    }
  });
});

describe('HorzGeometry — visible range (study 03 §4.3)', () => {
  test('logical range borders: rightBorder = R + B, leftBorder = right − W/S + 1', () => {
    const g = createHorzGeometry({ width: 600, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    const r = g.visibleLogicalRange();
    expect(r).not.toBeNull();
    // barsLength = 600/6 = 100; right = 0 + 100 = 100; left = 100 − 100 + 1 = 1
    expect(r!.from as number).toBeCloseTo(1, 9);
    expect(r!.to as number).toBeCloseTo(100, 9);
  });

  test('count right − left + 1 equals barsLength (the +1 invariant)', () => {
    const g = createHorzGeometry({ width: 600, barSpacing: 6, rightOffset: 12, baseIndex: 100 });
    const r = g.visibleLogicalRange()!;
    expect((r.to as number) - (r.from as number) + 1).toBeCloseTo(600 / 6, 9);
  });

  test('strict range widens outward (floor left, ceil right)', () => {
    const g = createHorzGeometry({ width: 605, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    const logical = g.visibleLogicalRange()!;
    const strict = g.visibleStrictRange()!;
    expect(strict.left).toBe(Math.floor(logical.from as number));
    expect(strict.right).toBe(Math.ceil(logical.to as number));
  });

  test('empty when width is 0', () => {
    const g = createHorzGeometry({ width: 0, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    expect(g.visibleLogicalRange()).toBeNull();
    expect(g.visibleStrictRange()).toBeNull();
  });

  test('the leftmost/rightmost logical borders map to the viewport edges', () => {
    const g = createHorzGeometry({ width: 600, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    const r = g.visibleLogicalRange()!;
    // rightBorder center sits at the last addressable column W − 1, +0.5 slot
    expect(g.indexToCoordinate(r.to as number)).toBeCloseTo(600 - 1 - 0.5 * 6, 6);
  });
});

describe('HorzGeometry — exposed parameters are immutable readbacks', () => {
  test('width / barSpacing / rightOffset / baseIndex round-trip', () => {
    const g = createHorzGeometry({ width: 800, barSpacing: 6.5, rightOffset: 2, baseIndex: 17 });
    expect(g.width).toBe(800);
    expect(g.barSpacing).toBe(6.5);
    expect(g.rightOffset).toBe(2);
    expect(g.baseIndex).toBe(17);
  });

  test('coordinateToLogical brands its output as Logical', () => {
    const g = createHorzGeometry({ width: 800, barSpacing: 6, rightOffset: 0, baseIndex: 100 });
    const lg: Logical | null = g.coordinateToLogical(400);
    expect(typeof lg).toBe('number');
  });
});
