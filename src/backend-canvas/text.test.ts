import { describe, expect, test } from 'vitest';
import type { FontSpec } from '../gfx';
import { CanvasTextMeasurer, fontString } from './text';
import { MockContext } from './mock-context.test';

const font: FontSpec = { family: 'Arial, sans-serif', size: 12 };

describe('fontString', () => {
  test('builds a CSS font shorthand: style weight size family', () => {
    expect(fontString({ family: 'Arial', size: 12 })).toBe('normal normal 12px Arial');
    expect(fontString({ family: 'Arial', size: 14, weight: 'bold' })).toBe('normal bold 14px Arial');
    expect(fontString({ family: 'Arial', size: 10, style: 'italic', weight: 500 })).toBe('italic 500 10px Arial');
  });
});

describe('CanvasTextMeasurer', () => {
  test('sets the font on the measuring ctx and returns width + actual bounding box metrics', () => {
    const ctx = new MockContext();
    const m = new CanvasTextMeasurer(ctx as unknown as CanvasRenderingContext2D);
    const r = m.measure('ABCD', font); // mock width = len*7 = 28
    expect(r.width).toBe(28);
    expect(r.ascent).toBe(8); // actualBoundingBoxAscent from the mock
    expect(r.descent).toBe(2);
    expect(ctx.font).toBe('normal normal 12px Arial, sans-serif');
  });

  test('falls back to 0.8·size / 0.2·size when actualBoundingBox fields are missing', () => {
    const ctx = new MockContext();
    // override measureText to omit the actualBoundingBox fields (older engines)
    (ctx as unknown as { measureText: (t: string) => { width: number } }).measureText = (t: string) => ({
      width: t.length * 5,
    });
    const m = new CanvasTextMeasurer(ctx as unknown as CanvasRenderingContext2D);
    const r = m.measure('xx', { family: 'X', size: 20 });
    expect(r.width).toBe(10);
    expect(r.ascent).toBeCloseTo(16); // 0.8 * 20
    expect(r.descent).toBeCloseTo(4); // 0.2 * 20
  });
});
