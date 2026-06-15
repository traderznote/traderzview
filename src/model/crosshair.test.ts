import { describe, expect, test } from 'vitest';
import type { Coordinate, CursorStyle, TimeIndex } from '../core';
import {
  Crosshair,
  CrosshairMode,
  magnetSnapPrice,
  type HoverTarget,
  type MagnetCandidate,
} from './crosshair';

// study 07 is the spec of record: §3.5 (position data flow — applied x is bar-snapped
// via indexToCoordinate, y is magnet-snapped via priceToCoordinate; originX/originY keep
// the raw pointer), §4.8 (magnet snapping, pixel-space comparison, Close vs OHLC keys),
// §5 (clear → index = last bar across series, price/x/y = NaN; Hidden suppresses RENDER
// only — position/events still flow). architecture §4.6/§5.5: HoverTarget is core types
// only (CursorStyle from core), the model NEVER runs hit tests.

describe('CrosshairMode (const-object union, NOT an enum — architecture §4.6)', () => {
  test('exposes the four study-07 modes', () => {
    expect(CrosshairMode.Normal).toBe('normal');
    expect(CrosshairMode.Magnet).toBe('magnet');
    expect(CrosshairMode.Hidden).toBe('hidden');
    expect(CrosshairMode.MagnetOHLC).toBe('magnet-ohlc');
  });
});

describe('magnetSnapPrice (study 07 §4.8)', () => {
  // A trivial linear price↔coordinate pair: y = 100 - price (so price 30 → y 70).
  const priceToCoordinate = (p: number): number => 100 - p;
  const coordinateToPrice = (y: number): number => 100 - y;

  test('Normal mode passes the price through unchanged', () => {
    const out = magnetSnapPrice({
      mode: CrosshairMode.Normal,
      price: 42.7,
      candidates: [{ open: 40, high: 50, low: 39, close: 45 }],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(42.7);
  });

  test('Magnet snaps to the nearest CLOSE in pixel space', () => {
    // close=45 (y=55) and close=20 (y=80). Pointer price 30 → y=70; nearest y is 80 → price 20.
    const out = magnetSnapPrice({
      mode: CrosshairMode.Magnet,
      price: 30,
      candidates: [
        { open: 41, high: 50, low: 39, close: 45 },
        { open: 19, high: 25, low: 15, close: 20 },
      ],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(20);
  });

  test('Magnet considers ONLY close; MagnetOHLC considers all four (study 07 §4.8)', () => {
    const candidates: MagnetCandidate[] = [{ open: 40, high: 90, low: 10, close: 45 }];
    // pointer price 12 → y=88. Magnet: only close=45 (y=55). MagnetOHLC: low=10 (y=90) is closest.
    const magnet = magnetSnapPrice({
      mode: CrosshairMode.Magnet,
      price: 12,
      candidates,
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(magnet).toBe(45);
    const ohlc = magnetSnapPrice({
      mode: CrosshairMode.MagnetOHLC,
      price: 12,
      candidates,
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(ohlc).toBe(10);
  });

  test('no candidates → price passes through unchanged (study 07 §4.8 / §5)', () => {
    const out = magnetSnapPrice({
      mode: CrosshairMode.Magnet,
      price: 33,
      candidates: [],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(33);
  });

  test('Hidden mode never snaps — price passes through (study 07 §5)', () => {
    const out = magnetSnapPrice({
      mode: CrosshairMode.Hidden,
      price: 30,
      candidates: [{ open: 40, high: 50, low: 39, close: 45 }],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(30);
  });

  // M11 parity hardening — study 07 §4.8 + §5 -----------------------------------------

  test('a candidate on its OWN price scale competes in pixel space (study 07 §4.8)', () => {
    // Default scale: y = 100 - price. A SECOND series lives on a scale stretched 2x with a
    // -100 offset: y = 100 - 2*(price - 100) = 300 - 2*price (so its price 130 → y=40).
    // Pointer price 50 → default y=50.
    //   default-scale candidate close=45 → default y=55 → |55-50| = 5.
    //   own-scale candidate    close=130 → own     y=40 → |40-50| = 10.
    // Nearest pixel Y is 55 → converted back through the DEFAULT scale → price 45.
    const ownScale = (p: number): number => 300 - 2 * p;
    const out = magnetSnapPrice({
      mode: CrosshairMode.Magnet,
      price: 50,
      candidates: [
        { open: 41, high: 50, low: 39, close: 45 }, // default scale (no converter)
        { open: 120, high: 140, low: 115, close: 130, priceToCoordinate: ownScale },
      ],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(45);
  });

  test('own-scale candidate can WIN, but the result is a DEFAULT-scale price (study 07 §4.8 final note)', () => {
    // Same scales as above. Pointer price 35 → default y=65.
    //   default-scale candidate close=45 → default y=55 → |55-65| = 10.
    //   own-scale candidate    close=130 → own     y=40 → |40-65| = 25.
    //   own-scale candidate    close=120 → own     y=60 → |60-65| = 5.  ← nearest pixel Y=60.
    // Winning Y=60 is converted back through the DEFAULT scale: coordinateToPrice(60) = 40.
    const ownScale = (p: number): number => 300 - 2 * p;
    const out = magnetSnapPrice({
      mode: CrosshairMode.Magnet,
      price: 35,
      candidates: [
        { open: 41, high: 50, low: 39, close: 45 },
        { open: 118, high: 122, low: 115, close: 120, priceToCoordinate: ownScale },
      ],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(40); // 100 - 60, NOT the own-scale price 120
  });

  test('NaN candidate values (no datum / gap at index) are skipped (study 07 §5)', () => {
    // close=NaN must be skipped; the only finite close is 45 (y=55) → snap to 45.
    const out = magnetSnapPrice({
      mode: CrosshairMode.Magnet,
      price: 30,
      candidates: [
        { open: NaN, high: NaN, low: NaN, close: NaN }, // series has no bar here
        { open: 41, high: 50, low: 39, close: 45 },
      ],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(45);
  });

  test('MagnetOHLC skips NaN OHLC slots but still snaps to the finite ones (study 07 §5)', () => {
    // open=NaN, high=NaN are skipped; low=10 (y=90), close=45 (y=55) remain.
    // pointer 12 → y=88; nearest finite is low=10 (y=90) → price 10.
    const out = magnetSnapPrice({
      mode: CrosshairMode.MagnetOHLC,
      price: 12,
      candidates: [{ open: NaN, high: NaN, low: 10, close: 45 }],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(10);
  });

  test('a NaN pointer price (empty default scale) survives the pipeline (study 07 §5)', () => {
    // priceToCoordinate(NaN) = NaN → no meaningful nearest → NaN passes through, hiding the line.
    const out = magnetSnapPrice({
      mode: CrosshairMode.Magnet,
      price: NaN,
      candidates: [{ open: 40, high: 50, low: 39, close: 45 }],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(Number.isNaN(out)).toBe(true);
  });

  test('every candidate value NaN → price passes through unchanged (study 07 §5)', () => {
    const out = magnetSnapPrice({
      mode: CrosshairMode.MagnetOHLC,
      price: 33,
      candidates: [{ open: NaN, high: NaN, low: NaN, close: NaN }],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(33);
  });

  test('equal-distance candidates keep the FIRST seen (strict < tie-break)', () => {
    // pointer 50 → y=50. close=55 → y=45 (|45-50|=5); close=45 → y=55 (|55-50|=5). Tie.
    // The first-seen (close=55) must win because the comparison is strict `<`.
    const out = magnetSnapPrice({
      mode: CrosshairMode.Magnet,
      price: 50,
      candidates: [
        { open: 55, high: 56, low: 54, close: 55 },
        { open: 45, high: 46, low: 44, close: 45 },
      ],
      priceToCoordinate,
      coordinateToPrice,
    });
    expect(out).toBe(55);
  });
});

describe('Crosshair position set/clear (study 07 §3.5 / §5)', () => {
  test('setPosition records origin coords and bar-snaps x / price-snaps y', () => {
    const ch = new Crosshair();
    ch.setPosition({
      index: 7 as TimeIndex,
      price: 42 as number,
      originX: 123.4 as Coordinate,
      originY: 56.7 as Coordinate,
      x: 120 as Coordinate, // = indexToCoordinate(7), supplied by the host pipeline
      y: 58 as Coordinate, // = priceToCoordinate(snapped price)
    });
    expect(ch.visible()).toBe(true);
    const p = ch.position();
    expect(p).not.toBeNull();
    expect(p?.index).toBe(7);
    expect(p?.price).toBe(42);
    // the RENDERED x/y are the re-derived (snapped) coords, not the raw pointer (study 07 §3.5)
    expect(p?.x).toBe(120);
    expect(p?.y).toBe(58);
    // origin coords keep the raw pointer so scroll/zoom can re-snap (study 07 §5)
    expect(p?.originX).toBe(123.4);
    expect(p?.originY).toBe(56.7);
  });

  test('clear sets index to the last bar across series, price/x/y to NaN (study 07 §5)', () => {
    const ch = new Crosshair();
    ch.setPosition({
      index: 7 as TimeIndex,
      price: 42,
      originX: 1 as Coordinate,
      originY: 2 as Coordinate,
      x: 3 as Coordinate,
      y: 4 as Coordinate,
    });
    ch.clear(11 as TimeIndex); // 11 = last bar index across all series
    expect(ch.visible()).toBe(false);
    const p = ch.position();
    expect(p).not.toBeNull();
    expect(p?.index).toBe(11); // keeps the time-axis label meaningful
    expect(Number.isNaN(p?.price as number)).toBe(true);
    expect(Number.isNaN(p?.x as number)).toBe(true);
    expect(Number.isNaN(p?.y as number)).toBe(true);
  });

  test('clear with null last-bar index yields a null position', () => {
    const ch = new Crosshair();
    ch.clear(null);
    expect(ch.visible()).toBe(false);
    expect(ch.position()).toBeNull();
  });
});

describe('Hidden mode suppresses rendering only (study 07 §5)', () => {
  test('position still flows when mode is Hidden', () => {
    const ch = new Crosshair();
    ch.setMode(CrosshairMode.Hidden);
    ch.setPosition({
      index: 2 as TimeIndex,
      price: 5,
      originX: 1 as Coordinate,
      originY: 1 as Coordinate,
      x: 2 as Coordinate,
      y: 3 as Coordinate,
    });
    expect(ch.mode()).toBe(CrosshairMode.Hidden);
    expect(ch.position()?.index).toBe(2); // position updates regardless of mode
    expect(ch.renderVisible()).toBe(false); // ...but rendering is suppressed
  });

  test('renderVisible reflects both visibility and a non-Hidden mode', () => {
    const ch = new Crosshair();
    ch.setPosition({
      index: 2 as TimeIndex,
      price: 5,
      originX: 1 as Coordinate,
      originY: 1 as Coordinate,
      x: 2 as Coordinate,
      y: 3 as Coordinate,
    });
    expect(ch.renderVisible()).toBe(true);
    ch.clear(2 as TimeIndex);
    expect(ch.renderVisible()).toBe(false);
  });
});

describe('HoverTarget set/clear — core types only (architecture §5.5)', () => {
  test('the host sets the hover target from a views hit-test result', () => {
    const ch = new Crosshair();
    expect(ch.hover()).toBeNull();
    const target: HoverTarget = {
      sourceId: 'series-1',
      seriesId: 'series-1',
      externalId: 'order-42',
      cursor: 'pointer' as CursorStyle, // CursorStyle is a CORE type, never gfx
      data: { kind: 'marker' },
    };
    ch.setHover(target);
    expect(ch.hover()).toEqual(target);
    expect(ch.hover()?.cursor).toBe('pointer');
    ch.setHover(null);
    expect(ch.hover()).toBeNull();
  });
});

describe('tracking-mode position state (study 07 §4.13 — STATE only, here)', () => {
  test('the model holds the tracking flag the host toggles', () => {
    const ch = new Crosshair();
    expect(ch.isTracking()).toBe(false);
    ch.setTracking(true);
    expect(ch.isTracking()).toBe(true);
    ch.setTracking(false);
    expect(ch.isTracking()).toBe(false);
  });
});
