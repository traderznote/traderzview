import { describe, expect, test } from 'vitest';
import type { FontSpec } from './commands';
import { CachedTextMeasurer } from './text-measure';

const font: FontSpec = { family: 'sans', size: 12 };
const fontB: FontSpec = { family: 'sans', size: 14 };

function stub(widthFor: (t: string) => number, capacity?: number) {
  let calls = 0;
  const seen: string[] = [];
  const m = new CachedTextMeasurer((text) => {
    calls++;
    seen.push(text);
    return { width: widthFor(text), ascent: 9, descent: 2 };
  }, capacity);
  return { m, calls: () => calls, seen };
}

describe('CachedTextMeasurer', () => {
  test('digit fold: 2-9 → 0, so "12.34" and "19.87" share one entry', () => {
    const { m, calls } = stub((t) => t.length);
    m.measure('12.34', font);
    const r = m.measure('19.87', font);
    expect(calls()).toBe(1); // hit on the folded key
    expect(r.width).toBe(5); // width measured for the first string
  });

  test('resets the cache when the font changes', () => {
    const { m, calls } = stub(() => 10);
    m.measure('1', font);
    m.measure('1', font);
    expect(calls()).toBe(1);
    m.measure('1', fontB);
    expect(calls()).toBe(2);
  });

  test('Firefox zero-width for non-empty text is returned but never cached', () => {
    const { m, calls } = stub(() => 0);
    expect(m.measure('x', font).width).toBe(0);
    expect(m.measure('x', font).width).toBe(0);
    expect(calls()).toBe(2);
  });

  test('LRU: a hit refreshes recency under capacity pressure', () => {
    const { m, seen } = stub(() => 1, 2);
    m.measure('a', font);
    m.measure('b', font);
    m.measure('a', font); // refresh a
    m.measure('c', font); // evict b
    expect(seen).toEqual(['a', 'b', 'c']);
    m.measure('a', font); // still cached
    expect(seen).toEqual(['a', 'b', 'c']);
    m.measure('b', font); // re-measure
    expect(seen).toEqual(['a', 'b', 'c', 'b']);
  });
});
