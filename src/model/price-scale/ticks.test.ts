import { describe, expect, test } from 'vitest';
import { createPriceGeometry } from './geometry';
import { PriceScaleMode, defaultLogFormula } from './modes';
import { rebuildTickMarks, tickSpan } from './ticks';

describe('tickSpan — minimum of the three divider cycles (study 04 §4.5)', () => {
  // Exact values hand-derived from the §4.5 pseudocode (height 300, base 100 →
  // tickMarkHeight 30, maxTickSpan = (hi-lo)/10). The min-of-three-cycles rule can
  // pick a step that is NOT a "pretty" 10^n×{1,2,2.5,5} value — e.g. (37,1) → 4,
  // because cycle [2.5,2,2] runs 100→40→20→10→4 and that beats the others' 5.
  test('exact step for representative ranges', () => {
    expect(tickSpan(100, 0, 300, 100)).toBe(10);
    expect(tickSpan(10, 0, 300, 100)).toBe(1);
    expect(tickSpan(250, 0, 300, 100)).toBe(25);
    expect(tickSpan(1000, 0, 300, 100)).toBe(100);
    expect(tickSpan(37, 1, 300, 100)).toBe(4);
  });
});

describe('rebuildTickMarks (study 04 §4.6)', () => {
  const geom = createPriceGeometry({
    height: 300,
    range: { min: 0, max: 100 },
    scaleMargins: { top: 0, bottom: 0 },
    marginAbovePx: 0,
    marginBelowPx: 0,
    mode: PriceScaleMode.Normal,
    inverted: false,
    logFormula: defaultLogFormula(),
  });

  test('marks are in-bounds, strictly descending, and ≥ tickMarkHeight apart', () => {
    const marks = rebuildTickMarks(geom, 100);
    expect(marks.length).toBeGreaterThan(0);
    const tickMarkHeight = 30; // ceil(12 * 2.5)
    for (let i = 0; i < marks.length; i++) {
      expect(marks[i].coord).toBeGreaterThanOrEqual(0);
      expect(marks[i].coord).toBeLessThanOrEqual(299);
      if (i > 0) {
        expect(marks[i].logical).toBeLessThan(marks[i - 1].logical);
        expect(Math.abs(marks[i].coord - marks[i - 1].coord)).toBeGreaterThanOrEqual(tickMarkHeight - 1e-9);
      }
    }
  });

  test('empty geometry → no marks', () => {
    const empty = createPriceGeometry({
      height: 0,
      range: null,
      scaleMargins: { top: 0, bottom: 0 },
      marginAbovePx: 0,
      marginBelowPx: 0,
      mode: PriceScaleMode.Normal,
      inverted: false,
      logFormula: defaultLogFormula(),
    });
    expect(rebuildTickMarks(empty, 100)).toEqual([]);
  });
});
