// price-line.parity.test.ts — the M11 FINAL emission-parity pass for the Price-line
// SceneSource (study 06 §4.13 horizontal-line family; design 03 §8.5.8). The M9
// deferral was the WIRING (registering this source on the series — owned by the
// integrate phase); the source itself already emits. These goldens close the recipe
// details the M7/M9 emission test left implicit:
//   1. the off-pane gate compares the CRISP-ROUNDED device y (`round(data.y·vpr)`),
//      verbatim with the §4.13 renderer threshold `if y < 0 or y > bitmapHeight → skip`
//      — so a y whose raw ·vr lands in (−0.5, 0) or (bh, bh+0.5] rounds onto the pane
//      edge and DOES draw (the M7 raw-product gate wrongly suppressed it).
//   2. the line spans EXACTLY [0, bitmapWidth] — NOT overdrawn past the ends (unlike
//      the grid's ±lineWidth overdraw); it is a single full-width stroke (§4.13:
//      `moveTo(0, y); lineTo(bitmapWidth, y)`).
//   3. the crisp device y equals `crispStrokePos(y, vr, crispWidth(lineWidth, vr))`
//      (odd device width → +0.5 shift), parity-keyed on the VERTICAL ratio (the cross
//      axis of a horizontal line), matching the grid's horizontal-line emission.
import { describe, expect, test } from 'vitest';
import { createPriceLineSource } from './price-line';
import type { PriceLineState } from './price-line';
import { crispRound, crispStrokePos, crispWidth } from '../../gfx';
import type { DisplayList, PolylineCommand, ViewFrame } from '../../gfx';

function frame(hr = 2, vr = 2, w = 100, h = 100): ViewFrame {
  return {
    frame: { mediaSize: { width: w, height: h }, bitmapSize: { width: w * hr, height: h * vr }, hr, vr },
    now: 0,
  };
}

function poly(lists: readonly DisplayList[]): PolylineCommand {
  for (const l of lists) for (const c of l.commands) if (c.kind === 'polyline') return c;
  throw new Error('no polyline');
}

const at = (y: number | null): PriceLineState => ({ y, barColor: '#abc123', text: '' });

// --- 1. off-pane gate uses round(y·vpr), matching the §4.13 renderer ----------

describe('price-line — off-pane gate compares round(y·vpr) (study 06 §4.13 / §8.5.8)', () => {
  test('y whose raw ·vr is in (−0.5, 0) rounds to device 0 → ON-PANE, draws', () => {
    // y −0.2, vr 2 → raw −0.4 (the M7 gate would suppress), round(−0.4)=0 ∈ [0, bh] → draws.
    const src = createPriceLineSource(() => at(-0.2));
    src.update(frame(2, 2));
    const cmd = poly(src.displayLists());
    expect(cmd.points[1]).toBe(0); // device y rounds onto the top edge
    expect(cmd.points[3]).toBe(0);
  });

  test('y whose raw ·vr is in (bh, bh+0.5] rounds to bh → ON-PANE, draws', () => {
    // bh = 200. y 100.2, vr 2 → raw 200.4, round = 200 == bh → on-pane, draws.
    const src = createPriceLineSource(() => at(100.2));
    src.update(frame(2, 2));
    expect(poly(src.displayLists()).points[1]).toBe(200);
  });

  test('y rounding to −1 (raw ·vr ≤ −0.5) is still suppressed', () => {
    // y −0.3, vr 2 → raw −0.6, round = −1 < 0 → suppressed.
    const src = createPriceLineSource(() => at(-0.3));
    src.update(frame(2, 2));
    expect(src.displayLists()).toHaveLength(0);
  });

  test('y rounding past bh (raw ·vr > bh+0.5) is suppressed', () => {
    // y 100.3, vr 2 → raw 200.6, round = 201 > 200 → suppressed.
    const src = createPriceLineSource(() => at(100.3));
    src.update(frame(2, 2));
    expect(src.displayLists()).toHaveLength(0);
  });

  test('exact top edge (y 0) and exact bottom edge (y == mediaHeight) both draw', () => {
    const top = createPriceLineSource(() => at(0));
    top.update(frame(2, 2));
    expect(top.displayLists()).toHaveLength(1);
    const bottom = createPriceLineSource(() => at(100)); // round(100·2)=200==bh
    bottom.update(frame(2, 2));
    expect(bottom.displayLists()).toHaveLength(1);
  });
});

// --- 2. spans exactly [0, bitmapWidth] — NOT overdrawn ------------------------

describe('price-line — full-width line spans exactly [0, bitmapWidth] (study 06 §4.13)', () => {
  test('the two vertices sit at x=0 and x=bitmapWidth (no ±lineWidth overdraw)', () => {
    // Distinguishes the price line from the GRID, which overdraws horizontal lines by
    // ±lineWidth so dashes do not clip. The price line is a single full-width stroke
    // with NO overdraw (§4.13 renderer: moveTo(0, y); lineTo(bitmapWidth, y)).
    const src = createPriceLineSource(() => at(30));
    src.update(frame(2, 2, 100, 100)); // bitmapWidth 200
    const cmd = poly(src.displayLists());
    expect(cmd.points[0]).toBe(0); // left x — exactly 0, not −width
    expect(cmd.points[2]).toBe(200); // right x — exactly bitmapWidth, not +width
  });

  test('a wider line still spans exactly [0, bitmapWidth] (width affects thickness only)', () => {
    const src = createPriceLineSource(() => at(30), { lineWidth: 3 });
    src.update(frame(2, 2, 100, 100));
    const cmd = poly(src.displayLists());
    expect(cmd.points[0]).toBe(0);
    expect(cmd.points[2]).toBe(200);
    expect(cmd.width).toBe(crispWidth(3, 2)); // 6 — thickness only
  });
});

// --- 3. crisp device y matches the shared gfx crisp recipe --------------------

describe('price-line — crisp y == crispStrokePos(y, vr, crispWidth(lineWidth, vr))', () => {
  test('even device width (DPR 2, lineWidth 1) → no +0.5 shift; y = round(y·vr)', () => {
    const y = 30;
    const src = createPriceLineSource(() => at(y));
    src.update(frame(2, 2));
    const w = crispWidth(1, 2); // 2 (even)
    expect(poly(src.displayLists()).points[1]).toBe(crispStrokePos(y, 2, w)); // round(60)+0 = 60
  });

  test('odd device width (DPR 1, lineWidth 1) → +0.5 shift', () => {
    const y = 30;
    const src = createPriceLineSource(() => at(y));
    src.update(frame(1, 1));
    const w = crispWidth(1, 1); // 1 (odd)
    expect(poly(src.displayLists()).points[1]).toBe(crispStrokePos(y, 1, w)); // round(30)+0.5 = 30.5
  });

  test('the gate y (round(y·vr)) and the drawn y agree on the integer part (parity ref = vr)', () => {
    // The thickness/parity reference is the VERTICAL ratio (cross axis of a horizontal
    // line), exactly as the grid emits its horizontal lines — NOT the horizontal ratio.
    const y = 30;
    const src = createPriceLineSource(() => at(y));
    src.update(frame(3, 2)); // hr 3 (irrelevant to a horizontal line), vr 2
    const w = crispWidth(1, 2); // keyed on vr → 2 (even)
    const drawn = poly(src.displayLists()).points[1]!;
    expect(drawn).toBe(crispStrokePos(y, 2, w));
    expect(Math.trunc(drawn)).toBe(crispRound(y, 2)); // gate integer matches drawn integer
  });
});
