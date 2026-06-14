import { describe, expect, test } from 'vitest';
import { barContract, singleValueContract } from './series-contract';
import { PlotStore } from './plot-store';

describe('PlotStore — single-value (1 lane)', () => {
  test('role accessors all read lane 0; timeIndex tracks the slot', () => {
    const s = new PlotStore(singleValueContract);
    s.setData([{ value: 10 }, { value: 20 }, { value: 30 }], [0, 1, 2]);
    expect(s.length).toBe(3);
    expect(s.current(1)).toBe(20);
    expect(s.min(1)).toBe(20);
    expect(s.max(1)).toBe(20);
    expect(s.lane(0, 2)).toBe(30);
    expect(s.timeIndex(2)).toBe(2);
  });

  test('whitespace items occupy no plot row', () => {
    const s = new PlotStore(singleValueContract);
    s.setData([{ value: 10 }, {}, { value: 30 }], [0, 1, 2]);
    expect(s.length).toBe(2);
    expect(s.timeIndex(0)).toBe(0);
    expect(s.timeIndex(1)).toBe(2);
  });

  test('valueRange = min/max over the value lane', () => {
    const s = new PlotStore(singleValueContract);
    s.setData([{ value: 10 }, { value: 5 }, { value: 30 }], [0, 1, 2]);
    expect(s.valueRange()).toEqual({ min: 5, max: 30 });
  });
});

describe('PlotStore — bar (4 lanes OHLC)', () => {
  test('current=close, min=low, max=high; raw lane reads open', () => {
    const s = new PlotStore(barContract);
    s.setData([{ open: 10, high: 15, low: 8, close: 12 }], [0]);
    expect(s.current(0)).toBe(12);
    expect(s.min(0)).toBe(8);
    expect(s.max(0)).toBe(15);
    expect(s.lane(0, 0)).toBe(10);
  });

  test('valueRange = min(lows), max(highs)', () => {
    const s = new PlotStore(barContract);
    s.setData(
      [
        { open: 10, high: 15, low: 8, close: 12 },
        { open: 12, high: 20, low: 11, close: 18 },
      ],
      [0, 1],
    );
    expect(s.valueRange()).toEqual({ min: 8, max: 20 });
  });
});

describe('PlotStore — search (§13.14)', () => {
  const make = () => {
    const s = new PlotStore(singleValueContract);
    s.setData([{ value: 1 }, { value: 2 }, { value: 3 }], [0, 5, 10]);
    return s;
  };

  test('firstIndexAt: exact hit, else null', () => {
    const s = make();
    expect(s.firstIndexAt(5)).toBe(1);
    expect(s.firstIndexAt(7)).toBe(null);
  });

  test('nearestIndexAt clamps to the ends (total over a non-empty store)', () => {
    const s = make();
    expect(s.nearestIndexAt(3, 'left')).toBe(0);
    expect(s.nearestIndexAt(3, 'right')).toBe(1);
    expect(s.nearestIndexAt(-1, 'left')).toBe(0);
    expect(s.nearestIndexAt(-1, 'right')).toBe(0);
    expect(s.nearestIndexAt(99, 'left')).toBe(2);
    expect(s.nearestIndexAt(99, 'right')).toBe(2);
    expect(s.nearestIndexAt(5, 'left')).toBe(1); // exact
  });
});

describe('PlotStore — chunked min/max (chunk = 30)', () => {
  const seeded = (n: number) => {
    let x = 0x7eadbeef >>> 0;
    const vals: number[] = [];
    for (let i = 0; i < n; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      vals.push(Math.round((x / 0xffffffff) * 1000) - 500);
    }
    return vals;
  };

  test('equals a cold scan across multiple chunks', () => {
    const s = new PlotStore(singleValueContract);
    const vals = seeded(75);
    s.setData(vals.map((value) => ({ value })), vals.map((_, i) => i));
    expect(s.valueRange()).toEqual({ min: Math.min(...vals), max: Math.max(...vals) });
  });

  test('append recomputes only chunks ≥ firstChanged and stays correct', () => {
    const s = new PlotStore(singleValueContract);
    const a = seeded(35);
    s.setData(a.map((value) => ({ value })), a.map((_, i) => i));
    const b = [999, -999, 0, 0, 0];
    const diff = s.append(b.map((value) => ({ value })), b.map((_, i) => 35 + i));
    expect(diff).toEqual({ kind: 'append', count: 5 });
    const all = [...a, ...b];
    expect(s.valueRange()).toEqual({ min: Math.min(...all), max: Math.max(...all) });
  });
});
