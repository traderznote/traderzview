import { describe, expect, test } from 'vitest';
import { PriceScaleMode } from './price-scale/modes';
import {
  DEFAULT_CHART_OPTIONS,
  DEFAULT_PRICE_SCALE_OPTIONS,
  DEFAULT_TIME_SCALE_OPTIONS,
  buildHorzGeometry,
  buildPriceConverter,
  formatPaneId,
} from './shared';

describe('formatPaneId', () => {
  test('mints p0, p1, ... in creation order', () => {
    expect(formatPaneId(0)).toBe('p0');
    expect(formatPaneId(1)).toBe('p1');
    expect(formatPaneId(42)).toBe('p42');
  });
});

describe('defaults tables', () => {
  test('chart defaults match design 02 §6.1', () => {
    expect(DEFAULT_CHART_OPTIONS.addDefaultPane).toBe(true);
    expect(DEFAULT_CHART_OPTIONS.hoveredSeriesOnTop).toBe(true);
    expect(DEFAULT_CHART_OPTIONS.defaultPriceScaleId).toBe('right');
    expect(DEFAULT_CHART_OPTIONS.validation).toBe('throw');
  });

  test('time-scale defaults match design 02 §6.5', () => {
    expect(DEFAULT_TIME_SCALE_OPTIONS.barSpacing).toBe(6);
    expect(DEFAULT_TIME_SCALE_OPTIONS.minBarSpacing).toBe(0.5);
    expect(DEFAULT_TIME_SCALE_OPTIONS.rightOffset).toBe(0);
  });

  test('right/left price-scale visibility differs (design 02 §6.6)', () => {
    expect(DEFAULT_PRICE_SCALE_OPTIONS.right.visible).toBe(true);
    expect(DEFAULT_PRICE_SCALE_OPTIONS.left.visible).toBe(false);
    expect(DEFAULT_PRICE_SCALE_OPTIONS.right.scaleMargins).toEqual({ top: 0.2, bottom: 0.1 });
  });
});

describe('buildHorzGeometry', () => {
  test('produces a frozen HorzGeometry value object views consume', () => {
    const g = buildHorzGeometry({ width: 600, barSpacing: 6, rightOffset: 0, baseIndex: 10 });
    expect(Object.isFrozen(g)).toBe(true);
    // x = W − (B + R − ix + 0.5)·S − 1
    expect(g.indexToCoordinate(10)).toBeCloseTo(600 - (10 + 0 - 10 + 0.5) * 6 - 1);
    // continuous round-trip inverse
    const x = g.indexToCoordinate(7);
    expect(g.coordinateToLogical(x)).toBeCloseTo(7);
  });
});

describe('buildPriceConverter', () => {
  test('exposes priceToCoordinate, firstValue, mode flag, toLogical (arch §6)', () => {
    const pc = buildPriceConverter({
      height: 400,
      range: { min: 0, max: 100 },
      scaleMargins: { top: 0, bottom: 0 },
      marginAbovePx: 0,
      marginBelowPx: 0,
      mode: PriceScaleMode.Normal,
      inverted: false,
      firstValue: 50,
    });
    expect(pc.mode).toBe('normal');
    expect(pc.firstValue).toBe(50);
    // top of band = max price; bottom = min price
    expect(pc.priceToCoordinate(100)).toBeCloseTo(0);
    expect(pc.priceToCoordinate(0)).toBeCloseTo(399);
    expect(typeof pc.toLogical(50)).toBe('number');
  });

  test('maps each PriceScaleMode to its public string flag', () => {
    const mk = (mode: PriceScaleMode): string =>
      buildPriceConverter({
        height: 100,
        range: { min: 1, max: 2 },
        scaleMargins: { top: 0, bottom: 0 },
        marginAbovePx: 0,
        marginBelowPx: 0,
        mode,
        inverted: false,
        firstValue: 1,
      }).mode;
    expect(mk(PriceScaleMode.Normal)).toBe('normal');
    expect(mk(PriceScaleMode.Logarithmic)).toBe('log');
    expect(mk(PriceScaleMode.Percentage)).toBe('percent');
    expect(mk(PriceScaleMode.IndexedTo100)).toBe('indexed');
  });

  test('null firstValue in percent mode yields null firstValue flag', () => {
    const pc = buildPriceConverter({
      height: 100,
      range: { min: -10, max: 10 },
      scaleMargins: { top: 0, bottom: 0 },
      marginAbovePx: 0,
      marginBelowPx: 0,
      mode: PriceScaleMode.Percentage,
      inverted: false,
      firstValue: null,
    });
    expect(pc.firstValue).toBeNull();
  });
});
