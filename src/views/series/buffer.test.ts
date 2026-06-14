import { describe, expect, test } from 'vitest';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer } from './buffer';

// A trivial Item payload view: reads its own x/y/timeIndex lanes lazily.
interface Pt {
  readonly x: number;
  readonly y: number;
  readonly ti: number;
}
const ptFactory = (b: ItemBuffer<Pt>, i: number): Pt => ({ x: b.x[i]!, y: b.y[i]!, ti: b.timeIndex[i]! });

describe('ReusableItemBuffer', () => {
  test('lanes are addressable and item() materialises a payload view', () => {
    const buf = new ReusableItemBuffer<Pt>(0, ptFactory, 4);
    buf.ensure(3);
    buf.length = 3;
    buf.x[0] = 10;
    buf.y[0] = 20;
    buf.timeIndex[0] = 7;
    const p = buf.item(0);
    expect(p).toEqual({ x: 10, y: 20, ti: 7 });
  });

  test('grows by amortised doubling, never shrinks, copies existing lanes', () => {
    const buf = new ReusableItemBuffer<Pt>(0, ptFactory, 4);
    expect(buf.capacity()).toBe(4);
    buf.ensure(2);
    buf.x[0] = 1;
    buf.x[1] = 2;
    expect(buf.reallocs).toBe(0); // within initial capacity → no alloc

    buf.ensure(5); // 4 → 8
    expect(buf.capacity()).toBe(8);
    expect(buf.reallocs).toBe(1);
    expect(buf.x[0]).toBe(1); // preserved across grow
    expect(buf.x[1]).toBe(2);

    buf.ensure(40); // 8 → 64
    expect(buf.capacity()).toBe(64);
    expect(buf.reallocs).toBe(2);

    const capBefore = buf.capacity();
    buf.ensure(3); // smaller → reuse, never shrink, no realloc
    expect(buf.capacity()).toBe(capBefore);
    expect(buf.reallocs).toBe(2);
  });

  test('backing arrays are reused (same reference) when capacity suffices', () => {
    const buf = new ReusableItemBuffer<Pt>(0, ptFactory, 8);
    const x0 = buf.x;
    const y0 = buf.y;
    buf.ensure(8); // fits → no realloc → same arrays (zero steady-state alloc)
    expect(buf.x).toBe(x0);
    expect(buf.y).toBe(y0);
    expect(buf.reallocs).toBe(0);
  });

  test('extra lane is laneStride wide and grows with capacity', () => {
    const buf = new ReusableItemBuffer<Pt>(2, ptFactory, 4); // OHLC-style 2 extra floats
    expect(buf.laneStride).toBe(2);
    expect(buf.extra.length).toBe(8); // 4 items × 2
    buf.extra[0] = 99;
    buf.ensure(10); // 4 → 16
    expect(buf.extra.length).toBe(32); // 16 × 2
    expect(buf.extra[0]).toBe(99); // preserved
  });

  test('single-Y kinds (laneStride 0) carry an empty extra lane', () => {
    const buf = new ReusableItemBuffer<Pt>(0, ptFactory, 4);
    expect(buf.laneStride).toBe(0);
    expect(buf.extra.length).toBe(0);
    buf.ensure(100); // grows x/y/timeIndex but extra stays empty
    expect(buf.extra.length).toBe(0);
  });
});
