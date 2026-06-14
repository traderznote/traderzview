import { describe, expect, test } from 'vitest';
import { normalizeWheel, WHEEL_DELTA_LINE, WHEEL_DELTA_PAGE, type WheelLike } from './wheel';

// Golden table hand-derived from study 10 §4.4 / study 07 §4.4 / design 04 §7:
//   adj = 120 (PAGE) | 32 (LINE) | 1 (PIXEL) | 1/dpr (PIXEL, Windows-Chromium)
//   dx =  adj * deltaX / 100
//   dy = -(adj * deltaY / 100)
//   zoom   = dy != 0 ? sign(dy) * min(1, |dy|) : 0      (±1 clamp per event)
//   scroll = dx != 0 ? dx * -80 : 0                     (−80 natural-scroll coeff)
// The function returns post-normalization { scroll, zoom } plus a passthrough
// ctrlKey (the DOM-wiring decides ctrl+vertical → zoom; the math is §4.4 verbatim).

const w = (p: Partial<WheelLike>): WheelLike => ({
  deltaMode: 0,
  deltaX: 0,
  deltaY: 0,
  ctrlKey: false,
  ...p,
});

describe('normalizeWheel constants (study 10 §4.4)', () => {
  test('deltaMode normalization factors are the exact §4.4 values', () => {
    expect(WHEEL_DELTA_PAGE).toBe(120);
    expect(WHEEL_DELTA_LINE).toBe(32);
  });
});

describe('normalizeWheel zoom leg (deltaY → ±1-clamped zoom)', () => {
  test('PIXEL one notch down: dy = -(1*100/100) = -1 → zoom -1', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaY: 100 }), 1);
    expect(r.zoom).toBeCloseTo(-1, 12);
    expect(r.scroll).toBe(0);
  });

  test('PIXEL half notch: dy = -0.5 → zoom -0.5 (sub-unit kept, not clamped)', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaY: 50 }), 1);
    expect(r.zoom).toBeCloseTo(-0.5, 12);
  });

  test('PIXEL big scroll up: dy = 2.4 → clamped to +1 (the ±1 hard clamp)', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaY: -240 }), 1);
    expect(r.zoom).toBe(1);
  });

  test('LINE 3 lines: dy = -(32*3/100) = -0.96 → zoom -0.96', () => {
    const r = normalizeWheel(w({ deltaMode: 1, deltaY: 3 }), 1); // deltaMode 1 = LINE
    expect(r.zoom).toBeCloseTo(-0.96, 12);
  });

  test('PAGE 1 page: dy = -(120*1/100) = -1.2 → clamped to -1', () => {
    const r = normalizeWheel(w({ deltaMode: 2, deltaY: 1 }), 1);
    expect(r.zoom).toBe(-1);
  });
});

describe('normalizeWheel scroll leg (deltaX → −80 px)', () => {
  test('PIXEL 100: dx = 1 → scroll 1*-80 = -80', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaX: 100 }), 1);
    expect(r.scroll).toBeCloseTo(-80, 10);
    expect(r.zoom).toBe(0);
  });

  test('LINE 2 lines: dx = 32*2/100 = 0.64 → scroll 0.64*-80 = -51.2', () => {
    const r = normalizeWheel(w({ deltaMode: 1, deltaX: 2 }), 1);
    expect(r.scroll).toBeCloseTo(-51.2, 10);
  });

  test('positive scroll: PIXEL -100 → dx = -1 → scroll +80 (natural direction)', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaX: -100 }), 1);
    expect(r.scroll).toBeCloseTo(80, 10);
  });
});

describe('normalizeWheel Windows-Chromium ÷DPR correction (bug 1001735)', () => {
  test('PIXEL deltaY=100 at dpr=2: adj = 0.5 → dy = -0.5 → zoom -0.5', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaY: 100 }), 1, true, 2);
    expect(r.zoom).toBeCloseTo(-0.5, 12);
  });

  test('PIXEL deltaX=100 at dpr=2: adj = 0.5 → dx = 0.5 → scroll -40', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaX: 100 }), 1, true, 2);
    expect(r.scroll).toBeCloseTo(-40, 10);
  });

  test('PAGE/LINE ignore the DPR correction (only PIXEL is bugged)', () => {
    // PAGE keeps adj=120 even on Windows-Chromium: dy = -1.2 → clamp -1.
    const r = normalizeWheel(w({ deltaMode: 2, deltaY: 1 }), 1, true, 2);
    expect(r.zoom).toBe(-1);
  });

  test('non-Windows-Chromium PIXEL ignores dpr entirely', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaY: 100 }), 1, false, 2);
    expect(r.zoom).toBeCloseTo(-1, 12); // adj stays 1
  });
});

describe('normalizeWheel speed multiplier + passthrough', () => {
  test('the user speed multiplier scales both legs pre-clamp', () => {
    // speed 0.5: PIXEL deltaY=100 → dy = -0.5 → zoom -0.5 (no longer clamped).
    const r = normalizeWheel(w({ deltaMode: 0, deltaY: 100 }), 0.5);
    expect(r.zoom).toBeCloseTo(-0.5, 12);
    // scroll leg scales too: deltaX=100 → dx=0.5 → scroll -40.
    const s = normalizeWheel(w({ deltaMode: 0, deltaX: 100 }), 0.5);
    expect(s.scroll).toBeCloseTo(-40, 10);
  });

  test('ctrlKey is passed through verbatim (DOM-wiring forces ctrl+vert → zoom)', () => {
    const r = normalizeWheel(w({ deltaMode: 0, deltaY: 100, ctrlKey: true }), 1);
    expect(r.ctrlKey).toBe(true);
    expect(r.zoom).toBeCloseTo(-1, 12);
  });

  test('a fully-zero wheel event produces zero scroll and zero zoom', () => {
    const r = normalizeWheel(w({ deltaMode: 0 }), 1);
    expect(r).toMatchObject({ scroll: 0, zoom: 0, ctrlKey: false });
  });
});
