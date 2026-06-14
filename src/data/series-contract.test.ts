import { describe, expect, test } from 'vitest';
import { barContract, singleValueContract } from './series-contract';

describe('singleValueContract (Line/Area/Baseline/Histogram)', () => {
  test('1 lane, all roles on lane 0', () => {
    expect(singleValueContract.laneCount).toBe(1);
    expect(singleValueContract.roles).toEqual({ current: 0, min: 0, max: 0 });
  });

  test('whitespace = no value key', () => {
    expect(singleValueContract.isWhitespace({})).toBe(true);
    expect(singleValueContract.isWhitespace({ value: 5 })).toBe(false);
  });

  test('extractLanes writes value at the offset', () => {
    const out = new Float64Array(2);
    singleValueContract.extractLanes({ value: 7 }, out, 1);
    expect(out[1]).toBe(7);
  });
});

describe('barContract (Bar/Candlestick)', () => {
  test('4 OHLC lanes; roles current=close(3), min=low(2), max=high(1)', () => {
    expect(barContract.laneCount).toBe(4);
    expect(barContract.roles).toEqual({ current: 3, min: 2, max: 1 });
  });

  test('whitespace = no open key', () => {
    expect(barContract.isWhitespace({})).toBe(true);
    expect(barContract.isWhitespace({ open: 1, high: 2, low: 0, close: 1.5 })).toBe(false);
  });

  test('extractLanes writes [open, high, low, close]', () => {
    const out = new Float64Array(4);
    barContract.extractLanes({ open: 10, high: 12, low: 9, close: 11 }, out, 0);
    expect([...out]).toEqual([10, 12, 9, 11]);
  });
});
