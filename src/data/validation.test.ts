import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { barContract, singleValueContract } from './series-contract';
import { timeBehavior } from './horz-behavior';
import type { Time } from './horz-behavior';
import { validateSeriesData } from './validation';

const b = timeBehavior();

type Item = { time: Time; value?: number };
const v = (time: Time, value: number): Item => ({ time, value });

describe('validation — cheap always-on: ascending/unique keys', () => {
  test('strictly ascending unique keys pass (throw mode)', () => {
    const items = [v(0, 1), v(10, 2), v(20, 3)];
    const kept = validateSeriesData(items, singleValueContract, b, { validation: 'throw' });
    expect(kept).toBe(items); // same reference, nothing dropped
  });

  test('throw: out-of-order keys raise an error carrying the index and both keys', () => {
    const items = [v(10, 1), v(5, 2)];
    expect(() => validateSeriesData(items, singleValueContract, b, { validation: 'throw' })).toThrow(/index 1/);
    try {
      validateSeriesData(items, singleValueContract, b, { validation: 'throw' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('10');
      expect(msg).toContain('5');
    }
  });

  test('throw: duplicate keys raise an error', () => {
    const items = [v(0, 1), v(0, 2)];
    expect(() => validateSeriesData(items, singleValueContract, b, { validation: 'throw' })).toThrow(/index 1/);
  });
});

describe('validation — cheap always-on: finite + magnitude bound', () => {
  test('throw: a non-finite extracted lane raises', () => {
    const items = [v(0, 1), v(10, Number.POSITIVE_INFINITY)];
    expect(() => validateSeriesData(items, singleValueContract, b, { validation: 'throw' })).toThrow(/index 1/);
  });

  test('throw: NaN raises', () => {
    const items = [v(0, Number.NaN)];
    expect(() => validateSeriesData(items, singleValueContract, b, { validation: 'throw' })).toThrow();
  });

  test('throw: |v| beyond 2^53/100 raises', () => {
    const tooBig = Math.pow(2, 53) / 100 + 1;
    const items = [v(0, tooBig)];
    expect(() => validateSeriesData(items, singleValueContract, b, { validation: 'throw' })).toThrow();
    // exactly at the bound is allowed
    const atBound = [v(0, Math.pow(2, 53) / 100)];
    expect(() => validateSeriesData(atBound, singleValueContract, b, { validation: 'throw' })).not.toThrow();
  });

  test('whitespace items skip lane checks but still count for ordering', () => {
    const items: Item[] = [{ time: 0 }, v(10, 1)]; // whitespace at 0
    expect(() => validateSeriesData(items, singleValueContract, b, { validation: 'throw' })).not.toThrow();
  });
});

describe('validation — cheap always-on: date-string regex', () => {
  test('throw: a malformed date string raises', () => {
    const items = [{ time: '2024-1-1' as Time, value: 1 }];
    expect(() => validateSeriesData(items, singleValueContract, b, { validation: 'throw' })).toThrow();
  });

  test('a well-formed date string passes', () => {
    const items = [{ time: '2024-01-01' as Time, value: 1 }, { time: '2024-01-02' as Time, value: 2 }];
    expect(() => validateSeriesData(items, singleValueContract, b, { validation: 'throw' })).not.toThrow();
  });
});

describe('validation — warn mode drops offending items and logs once', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  test('drops the non-finite + out-of-order items, keeps the rest, logs ONCE', () => {
    // v(8,2) is dropped (8 ≤ the previous kept key 10); v(5,NaN) is dropped
    // (non-finite) without advancing the ascending watermark.
    const items = [v(0, 1), v(10, 4), v(5, Number.NaN), v(8, 2), v(20, 5)];
    const kept = validateSeriesData(items, singleValueContract, b, { validation: 'warn' });
    expect(kept.map((i) => i.time)).toEqual([0, 10, 20]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('warn keeps the chart consistent (kept keys strictly ascending)', () => {
    const items = [v(0, 1), v(0, 2), v(10, 3)]; // dup at 0
    const kept = validateSeriesData(items, singleValueContract, b, { validation: 'warn' });
    const keys = kept.map((i) => b.key(i.time));
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThan(keys[i - 1]);
  });
});

describe('validation — off mode skips everything', () => {
  test('off: garbage passes through untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const items = [v(10, 1), v(5, Number.NaN)];
    const kept = validateSeriesData(items, singleValueContract, b, { validation: 'off' });
    expect(kept).toBe(items);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('validation — does not mutate user input', () => {
  test('throw mode leaves the input array and items untouched', () => {
    const items = [v(0, 1), v(10, 2)];
    const snapshot = JSON.parse(JSON.stringify(items));
    validateSeriesData(items, singleValueContract, b, { validation: 'throw' });
    expect(items).toEqual(snapshot);
  });
});

describe('validation — dev-only OHLC sanity (high≥max, low≤min)', () => {
  test('throw: high below max(open,close) raises in dev', () => {
    const items = [{ time: 0 as Time, open: 10, high: 9, low: 8, close: 11 }]; // high<close
    expect(() => validateSeriesData(items, barContract, b, { validation: 'throw' })).toThrow();
  });

  test('valid OHLC passes', () => {
    const items = [{ time: 0 as Time, open: 10, high: 15, low: 8, close: 12 }];
    expect(() => validateSeriesData(items, barContract, b, { validation: 'throw' })).not.toThrow();
  });
});
