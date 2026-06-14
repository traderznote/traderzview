import { describe, expect, test } from 'vitest';
import type { HorzKey, Logical, TimeIndex } from '../core';
import { Timeline } from './timeline';
import { timeBehavior } from './horz-behavior';
import type { Time } from './horz-behavior';

const b = timeBehavior();

// A line item is whitespace iff it has no `value`.
type Item = { time: Time; value?: number };
const v = (time: Time, value: number): Item => ({ time, value });
const ws = (time: Time): Item => ({ time });

describe('Timeline — union slot sharing across two series', () => {
  test('equal keys map to equal slots; disjoint keys interleave sorted', () => {
    const tl = new Timeline<Item>(b);
    // series A at 0,2,4 ; series B at 1,2,3
    const a = tl.applySeriesData('A', [v(0, 1), v(2, 1), v(4, 1)], b);
    expect(a.baseIndex).toBe(2 as TimeIndex); // slots [0,2,4] → base = slot 2
    expect([...tl.timeIndicesFor('A')]).toEqual([0, 1, 2]);

    const second = tl.applySeriesData('B', [v(1, 1), v(2, 1), v(3, 1)], b);
    // union keys now [0,1,2,3,4] → 5 slots
    expect(tl.slotCount).toBe(5);
    // A re-indexed: 0→0, 2→2, 4→4
    expect([...tl.timeIndicesFor('A')]).toEqual([0, 2, 4]);
    // B: 1→1, 2→2, 3→3
    expect([...tl.timeIndicesFor('B')]).toEqual([1, 2, 3]);
    expect(second.baseIndex).toBe(4 as TimeIndex); // newest real slot
  });
});

describe('Timeline — prefix diff firstChanged', () => {
  test('appending to the right yields firstChanged at the join', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(0, 1), v(10, 1), v(20, 1)], b);
    const d = tl.applySeriesData('A', [v(0, 1), v(10, 1), v(20, 1), v(30, 1)], b);
    expect(d.firstChanged).toBe(3 as TimeIndex);
  });

  test('inserting a key in the middle yields firstChanged at the insert slot', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(0, 1), v(20, 1)], b);
    const d = tl.applySeriesData('B', [v(10, 1)], b);
    // union goes [0,20] → [0,10,20]; first changed slot is 1 (the 10)
    expect(d.firstChanged).toBe(1 as TimeIndex);
  });

  test('an identical re-apply changes nothing → firstChanged null', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(0, 1), v(10, 1)], b);
    const d = tl.applySeriesData('A', [v(0, 1), v(10, 1)], b);
    expect(d.firstChanged).toBe(null);
  });
});

describe('Timeline — whitespace occupies a slot but yields no plot row', () => {
  test('a whitespace point creates a union slot; baseIndex skips it', () => {
    const tl = new Timeline<Item>(b);
    const d = tl.applySeriesData('A', [v(0, 1), v(10, 1), ws(20)], b);
    expect(tl.slotCount).toBe(3); // whitespace at 20 occupies slot 2
    expect(d.baseIndex).toBe(1 as TimeIndex); // highest REAL slot is slot 1 (key 10)
    // the plot rows the caller should store exclude whitespace:
    expect(d.rows.map((r) => r.item.value)).toEqual([1, 1]);
    expect(d.rows.map((r) => r.timeIndex)).toEqual([0, 1]);
  });

  test('a series of only whitespace → baseIndex null', () => {
    const tl = new Timeline<Item>(b);
    const d = tl.applySeriesData('A', [ws(0), ws(10)], b);
    expect(tl.slotCount).toBe(2);
    expect(d.baseIndex).toBe(null);
  });
});

describe('Timeline — equal-time last-bar update fast path (study 02)', () => {
  test('re-applying with the same last key but a new value touches no timeline slot', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(0, 1), v(10, 1)], b);
    const d = tl.appendOrUpdateLast('A', v(10, 99), b);
    expect(d.firstChanged).toBe(null); // no timeline change
    expect(d.store.kind).toBe('updateLast');
    expect(d.timeIndex).toBe(1 as TimeIndex);
  });

  test('a strictly newer key on an existing slot is an append, slot already present', () => {
    const tl = new Timeline<Item>(b);
    // B already created slot for key 20
    tl.applySeriesData('A', [v(0, 1), v(20, 1)], b);
    const d = tl.appendOrUpdateLast('A', v(10, 5), b); // 10 already a union slot? no
    // 10 is NOT a union slot yet → it inserts → firstChanged = slot 1
    expect(d.firstChanged).toBe(1 as TimeIndex);
    expect(d.store.kind).toBe('insert');
  });

  test('append onto a slot another series already opened updates baseIndex (append, no rebuild)', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('B', [v(0, 1), v(30, 1)], b); // opens union slots 0 and 1 (keys 0,30)
    tl.applySeriesData('A', [v(0, 1)], b); // A has only key 0 → A base slot 0
    const d = tl.appendOrUpdateLast('A', v(30, 7), b); // key 30 is an existing union slot
    expect(d.store.kind).toBe('append');
    expect(d.firstChanged).toBe(null); // union geometry unchanged
    expect(d.baseIndex).toBe(1 as TimeIndex); // slot for key 30 now has real data
    expect(d.timeIndex).toBe(1 as TimeIndex);
  });

  test('updateLast flipping real→whitespace lowers baseIndex', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(0, 1), v(10, 1)], b);
    expect(tl.appendOrUpdateLast('A', ws(10), b).baseIndex).toBe(0 as TimeIndex); // slot 1 now whitespace
    // and back to real raises it again
    expect(tl.appendOrUpdateLast('A', v(10, 5), b).baseIndex).toBe(1 as TimeIndex);
  });
});

describe('Timeline — keyToLogical / logicalToKey', () => {
  const make = () => {
    const tl = new Timeline<Item>(b);
    // keys 0, 10, 30 (non-uniform gaps) → slots 0,1,2
    tl.applySeriesData('A', [v(0, 1), v(10, 1), v(30, 1)], b);
    return tl;
  };

  test('exact slot keys map to exact integer logicals and back', () => {
    const tl = make();
    expect(tl.keyToLogical(0 as HorzKey)).toBe(0 as Logical);
    expect(tl.keyToLogical(10 as HorzKey)).toBe(1 as Logical);
    expect(tl.keyToLogical(30 as HorzKey)).toBe(2 as Logical);
    expect(tl.logicalToKey(0 as Logical)).toBe(0 as HorzKey);
    expect(tl.logicalToKey(1 as Logical)).toBe(10 as HorzKey);
    expect(tl.logicalToKey(2 as Logical)).toBe(30 as HorzKey);
  });

  test('piecewise-linear interpolation between slots', () => {
    const tl = make();
    // key 5 is halfway between slot 0 (key0) and slot 1 (key10) → logical 0.5
    expect(tl.keyToLogical(5 as HorzKey)).toBeCloseTo(0.5, 9);
    // logical 1.5 sits halfway between key10 and key30 → key 20
    expect(tl.logicalToKey(1.5 as Logical)).toBeCloseTo(20, 6);
  });

  test('monotone and mutually inverse up to FP across the grid', () => {
    const tl = make();
    let prev = -Infinity;
    for (let k = 0; k <= 30; k += 0.5) {
      const lg = tl.keyToLogical(k as HorzKey, { extrapolate: true })!;
      expect(lg).toBeGreaterThan(prev);
      prev = lg;
      const back = tl.logicalToKey(lg as Logical, { extrapolate: true })!;
      expect(back).toBeCloseTo(k, 6);
    }
  });

  test('off-grid in non-extrapolate mode beyond the ends returns null', () => {
    const tl = make();
    expect(tl.keyToLogical(-5 as HorzKey)).toBe(null);
    expect(tl.keyToLogical(40 as HorzKey)).toBe(null);
    expect(tl.logicalToKey(-0.5 as Logical)).toBe(null);
    expect(tl.logicalToKey(2.5 as Logical)).toBe(null);
  });

  test('extrapolation uses the mean gap of the nearest up-to-10 end gaps', () => {
    const tl = new Timeline<Item>(b);
    // uniform gap of 10 → mean gap 10
    tl.applySeriesData('A', [v(0, 1), v(10, 1), v(20, 1), v(30, 1)], b);
    // one logical past the right end (slot 3) → key 30 + 10 = 40
    expect(tl.logicalToKey(4 as Logical, { extrapolate: true })).toBeCloseTo(40, 6);
    // one logical before the left end → key 0 - 10 = -10
    expect(tl.logicalToKey(-1 as Logical, { extrapolate: true })).toBeCloseTo(-10, 6);
    // and the inverse
    expect(tl.keyToLogical(40 as HorzKey, { extrapolate: true })).toBeCloseTo(4, 6);
    expect(tl.keyToLogical(-10 as HorzKey, { extrapolate: true })).toBeCloseTo(-1, 6);
  });

  test('null with fewer than 2 slots (even with extrapolate)', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(5, 1)], b);
    expect(tl.keyToLogical(5 as HorzKey, { extrapolate: true })).toBe(null);
    expect(tl.logicalToKey(0 as Logical, { extrapolate: true })).toBe(null);
    const empty = new Timeline<Item>(b);
    expect(empty.keyToLogical(0 as HorzKey, { extrapolate: true })).toBe(null);
  });
});

describe('Timeline — keysInRange', () => {
  test('logical range in → real-slot keys out, clamped to the grid', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(0, 1), v(10, 1), v(20, 1), v(30, 1)], b);
    // fractional range [0.5, 2.5] → slots 1,2 (keys 10,20)
    expect([...tl.keysInRange({ from: 0.5 as Logical, to: 2.5 as Logical })]).toEqual([10, 20]);
    // a range covering everything
    expect([...tl.keysInRange({ from: -5 as Logical, to: 99 as Logical })]).toEqual([0, 10, 20, 30]);
    // an empty intersection
    expect([...tl.keysInRange({ from: 5 as Logical, to: 5.4 as Logical })]).toEqual([]);
  });
});

describe('Timeline — nearestIndexAt (FIXED §13.14, total over non-empty)', () => {
  test('clamps to the end bar, including a single-element timeline', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(10, 1)], b); // single slot
    expect(tl.nearestSlotAt(10 as HorzKey, 'left')).toBe(0);
    expect(tl.nearestSlotAt(10 as HorzKey, 'right')).toBe(0);
    expect(tl.nearestSlotAt(-5 as HorzKey, 'right')).toBe(0); // clamps, not null
    expect(tl.nearestSlotAt(99 as HorzKey, 'left')).toBe(0);
  });

  test('between slots snaps by direction; exact hit returns the slot', () => {
    const tl = new Timeline<Item>(b);
    tl.applySeriesData('A', [v(0, 1), v(10, 1), v(20, 1)], b);
    expect(tl.nearestSlotAt(10 as HorzKey, 'left')).toBe(1); // exact
    expect(tl.nearestSlotAt(7 as HorzKey, 'left')).toBe(0);
    expect(tl.nearestSlotAt(7 as HorzKey, 'right')).toBe(1);
    expect(tl.nearestSlotAt(100 as HorzKey, 'left')).toBe(2); // clamp to last
  });
});
