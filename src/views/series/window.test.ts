import { describe, expect, test } from 'vitest';
import { MutableItemWindow, itemWindow } from './window';
import type { ItemWindow } from './window';

describe('ItemWindow', () => {
  test('itemWindow builds an immutable [from, to) slice', () => {
    const w: ItemWindow = itemWindow(3, 9);
    expect(w.from).toBe(3);
    expect(w.to).toBe(9);
  });

  test('itemWindow clamps to to ≥ from', () => {
    const w = itemWindow(9, 3);
    expect(w.from).toBe(9);
    expect(w.to).toBe(9); // empty, not inverted
  });

  test('MutableItemWindow re-points in place with zero allocation', () => {
    const w = new MutableItemWindow();
    expect(w.isEmpty()).toBe(true);
    const same = w.set(2, 10);
    expect(same).toBe(w); // returns this — reusable, no new object
    expect(w.from).toBe(2);
    expect(w.to).toBe(10);
    expect(w.count()).toBe(8);
    expect(w.isEmpty()).toBe(false);

    w.set(5, 5);
    expect(w.count()).toBe(0);
    expect(w.isEmpty()).toBe(true);
  });

  test('MutableItemWindow clamps inverted ranges to empty', () => {
    const w = new MutableItemWindow();
    w.set(8, 1);
    expect(w.from).toBe(8);
    expect(w.to).toBe(8);
    expect(w.count()).toBe(0);
  });

  test('a MutableItemWindow satisfies the ItemWindow contract structurally', () => {
    const w = new MutableItemWindow().set(1, 4);
    const asInterface: ItemWindow = w;
    expect(asInterface.from).toBe(1);
    expect(asInterface.to).toBe(4);
  });
});
