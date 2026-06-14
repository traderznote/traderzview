import { describe, expect, test } from 'vitest';
import {
  finiteMerge,
  mergeMargins,
  assembleRange,
  type AutoscaleContributor,
} from './autoscale';
import { PriceScaleMode, toLog, defaultLogFormula } from './modes';

// study 04 §4.1 (autoscale pass, finiteMerge, degenerate widening, adaptive log)
// + architecture §9.2.3 (margins MAX-merged — ONE merge fn) are the spec of record.

describe('finiteMerge (study 04 §4.1)', () => {
  test('per-bound min of mins, max of maxes', () => {
    expect(finiteMerge({ min: 10, max: 50 }, { min: 5, max: 80 })).toEqual({ min: 5, max: 80 });
  });

  test('a non-finite bound does not poison the merge (finite wins)', () => {
    expect(finiteMerge({ min: 10, max: 50 }, { min: Number.NaN, max: 80 })).toEqual({
      min: 10,
      max: 80,
    });
    expect(finiteMerge({ min: 10, max: 50 }, { min: -Infinity, max: Infinity })).toEqual({
      min: 10,
      max: 50,
    });
  });

  test('both bounds non-finite falls back to −∞ (min) / +∞ (max)', () => {
    expect(finiteMerge({ min: Number.NaN, max: Number.NaN }, { min: Infinity, max: -Infinity })).toEqual(
      { min: -Infinity, max: Infinity },
    );
  });
});

describe('mergeMargins — MAX merge, the ONE merge fn (architecture §9.2.3)', () => {
  test('takes the max of each side across contributors', () => {
    const m = mergeMargins([
      { above: 5, below: 2 },
      { above: 3, below: 9 },
      { above: 8, below: 1 },
    ]);
    expect(m).toEqual({ above: 8, below: 9 });
  });

  test('no margins → zero/zero', () => {
    expect(mergeMargins([])).toEqual({ above: 0, below: 0 });
  });
});

const MIN_MOVE = 0.01;

describe('assembleRange — Normal mode (study 04 §4.1)', () => {
  test('merges per-source ranges and MAX-merges their margins', () => {
    const contributors: AutoscaleContributor[] = [
      { firstValue: 100, range: { min: 10, max: 50 }, margins: { above: 5, below: 2 } },
      { firstValue: 100, range: { min: 5, max: 80 }, margins: { above: 3, below: 9 } },
    ];
    const out = assembleRange({
      contributors,
      mode: PriceScaleMode.Normal,
      minMove: MIN_MOVE,
      logFormula: defaultLogFormula(),
    });
    expect(out!.range).toEqual({ min: 5, max: 80 });
    expect(out!.margins).toEqual({ above: 5, below: 9 });
  });

  test('sources with a null first value are skipped', () => {
    const out = assembleRange({
      contributors: [
        { firstValue: null, range: { min: 1, max: 2 }, margins: null },
        { firstValue: 100, range: { min: 10, max: 20 }, margins: null },
      ],
      mode: PriceScaleMode.Normal,
      minMove: MIN_MOVE,
      logFormula: defaultLogFormula(),
    });
    expect(out!.range).toEqual({ min: 10, max: 20 });
  });

  test('no contributing range → null result (caller keeps existing range)', () => {
    const out = assembleRange({
      contributors: [{ firstValue: 100, range: null, margins: null }],
      mode: PriceScaleMode.Normal,
      minMove: MIN_MOVE,
      logFormula: defaultLogFormula(),
    });
    expect(out).toBeNull();
  });

  test('degenerate single price widens by ±5·minMove (10 min-moves total)', () => {
    const out = assembleRange({
      contributors: [{ firstValue: 100, range: { min: 42, max: 42 }, margins: null }],
      mode: PriceScaleMode.Normal,
      minMove: MIN_MOVE,
      logFormula: defaultLogFormula(),
    });
    expect(out!.range.min).toBeCloseTo(42 - 5 * MIN_MOVE, 9);
    expect(out!.range.max).toBeCloseTo(42 + 5 * MIN_MOVE, 9);
  });
});

describe('assembleRange — Percentage mode (study 04 §4.1)', () => {
  test('transforms each source range by its OWN first value before merging', () => {
    const out = assembleRange({
      contributors: [{ firstValue: 100, range: { min: 90, max: 110 }, margins: null }],
      mode: PriceScaleMode.Percentage,
      minMove: MIN_MOVE,
      logFormula: defaultLogFormula(),
    });
    // toPercent(90,100) = -10 ; toPercent(110,100) = +10
    expect(out!.range.min).toBeCloseTo(-10, 9);
    expect(out!.range.max).toBeCloseTo(10, 9);
  });
});

describe('assembleRange — Logarithmic mode (study 04 §4.1/§4.3)', () => {
  test('stores the range in log space using the active formula', () => {
    const out = assembleRange({
      contributors: [{ firstValue: 50, range: { min: 10, max: 1000 }, margins: null }],
      mode: PriceScaleMode.Logarithmic,
      minMove: MIN_MOVE,
      logFormula: defaultLogFormula(),
    });
    expect(out!.range.min).toBeCloseTo(toLog(10), 9);
    expect(out!.range.max).toBeCloseTo(toLog(1000), 9);
  });

  test('re-derives the adaptive formula for a tiny raw range and re-expresses it', () => {
    const out = assembleRange({
      contributors: [{ firstValue: 5, range: { min: 5.0, max: 5.5 }, margins: null }],
      mode: PriceScaleMode.Logarithmic,
      minMove: MIN_MOVE,
      logFormula: defaultLogFormula(),
    });
    // d = 0.5 → L = 5, C = 1e-5  (study 04 §4.3)
    expect(out!.logFormula.logicalOffset).toBe(5);
    expect(out!.logFormula.coordOffset).toBeCloseTo(1e-5, 18);
    // the stored range is expressed in the NEW formula
    expect(out!.range.min).toBeCloseTo(toLog(5.0, out!.logFormula), 9);
    expect(out!.range.max).toBeCloseTo(toLog(5.5, out!.logFormula), 9);
  });

  test('degenerate single price in log mode widens in RAW space then re-logs', () => {
    const out = assembleRange({
      contributors: [{ firstValue: 100, range: { min: 100, max: 100 }, margins: null }],
      mode: PriceScaleMode.Logarithmic,
      minMove: MIN_MOVE,
      logFormula: defaultLogFormula(),
    });
    // widened raw range is [100 − 0.05, 100 + 0.05]; the stored range is its log
    expect(out!.range.min).toBeCloseTo(toLog(100 - 5 * MIN_MOVE, out!.logFormula), 6);
    expect(out!.range.max).toBeCloseTo(toLog(100 + 5 * MIN_MOVE, out!.logFormula), 6);
  });
});
