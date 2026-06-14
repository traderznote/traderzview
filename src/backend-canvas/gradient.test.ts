import { describe, expect, test } from 'vitest';
import type { LinearGradientY } from '../gfx';
import { GradientCache } from './gradient';
import { MockContext } from './mock-context.test';

function grad(from: number, to: number, color = '#fff'): LinearGradientY {
  return { from, to, stops: [{ offset: 0, color }] };
}

describe('GradientCache (LRU 16, list-space coords)', () => {
  test('a string fill passes through unchanged', () => {
    const ctx = new MockContext();
    const cache = new GradientCache();
    expect(cache.resolve('#abc', ctx as unknown as CanvasRenderingContext2D)).toBe('#abc');
    expect(ctx.ops('createLinearGradient')).toHaveLength(0);
  });

  test('a LinearGradientY builds createLinearGradient(0, from, 0, to) with list-space coords', () => {
    const ctx = new MockContext();
    const cache = new GradientCache();
    cache.resolve(grad(10, 90), ctx as unknown as CanvasRenderingContext2D);
    expect(ctx.ops('createLinearGradient')[0].args).toEqual([0, 10, 0, 90]);
  });

  test('reusing the SAME object hits the cache (one build)', () => {
    const ctx = new MockContext();
    const cache = new GradientCache();
    const g = grad(0, 100);
    cache.resolve(g, ctx as unknown as CanvasRenderingContext2D);
    cache.resolve(g, ctx as unknown as CanvasRenderingContext2D);
    expect(ctx.ops('createLinearGradient')).toHaveLength(1);
  });

  test('a coordinate change self-invalidates (key carries coords) → rebuild', () => {
    const ctx = new MockContext();
    const cache = new GradientCache();
    cache.resolve(grad(0, 100, '#f00'), ctx as unknown as CanvasRenderingContext2D);
    cache.resolve(grad(0, 200, '#f00'), ctx as unknown as CanvasRenderingContext2D); // to changed
    expect(ctx.ops('createLinearGradient')).toHaveLength(2);
  });

  test('two value-equal objects share one cache entry (value key)', () => {
    const ctx = new MockContext();
    const cache = new GradientCache();
    cache.resolve(grad(0, 50, '#0a0'), ctx as unknown as CanvasRenderingContext2D);
    cache.resolve(grad(0, 50, '#0a0'), ctx as unknown as CanvasRenderingContext2D); // distinct object, same value
    expect(ctx.ops('createLinearGradient')).toHaveLength(1);
  });

  test('LRU capacity 16: the 17th distinct gradient evicts the oldest', () => {
    const ctx = new MockContext();
    const cache = new GradientCache();
    for (let i = 0; i < 16; i++) cache.resolve(grad(0, i + 1), ctx as unknown as CanvasRenderingContext2D);
    expect(ctx.ops('createLinearGradient')).toHaveLength(16);
    // re-resolve the oldest (to=1) — still cached? touch a NEW one first to overflow.
    cache.resolve(grad(0, 17), ctx as unknown as CanvasRenderingContext2D); // 17th → evicts to=1
    expect(ctx.ops('createLinearGradient')).toHaveLength(17);
    cache.resolve(grad(0, 1), ctx as unknown as CanvasRenderingContext2D); // evicted → rebuilds
    expect(ctx.ops('createLinearGradient')).toHaveLength(18);
  });

  test('a cache hit refreshes recency (LRU, not FIFO)', () => {
    const ctx = new MockContext();
    const cache = new GradientCache();
    for (let i = 0; i < 16; i++) cache.resolve(grad(0, i + 1), ctx as unknown as CanvasRenderingContext2D);
    cache.resolve(grad(0, 1), ctx as unknown as CanvasRenderingContext2D); // refresh oldest → now MRU, no build
    expect(ctx.ops('createLinearGradient')).toHaveLength(16);
    cache.resolve(grad(0, 17), ctx as unknown as CanvasRenderingContext2D); // evicts to=2 (now oldest), NOT to=1
    cache.resolve(grad(0, 1), ctx as unknown as CanvasRenderingContext2D); // still cached
    expect(ctx.ops('createLinearGradient')).toHaveLength(17);
  });

  test('stops are added in order to the created gradient', () => {
    const ctx = new MockContext();
    const cache = new GradientCache();
    const g: LinearGradientY = {
      from: 0,
      to: 10,
      stops: [
        { offset: 0, color: '#000' },
        { offset: 0.5, color: '#888' },
        { offset: 1, color: '#fff' },
      ],
    };
    const out = cache.resolve(g, ctx as unknown as CanvasRenderingContext2D) as unknown as {
      stops: { offset: number; color: string }[];
    };
    expect(out.stops).toEqual(g.stops);
  });
});
