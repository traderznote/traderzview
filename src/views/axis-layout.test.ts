import { describe, expect, test } from 'vitest';
import {
  AxisWidthRatchet,
  boldWeight,
  layoutPriceAxis,
  layoutTimeAxis,
} from './axis-layout';
import type { PriceAxisInput, TimeAxisInput } from './axis-layout';
import type { FontSpec, ITextMeasurer } from '../gfx';
import type { AxisLabel } from '../model';

// --- fakes --------------------------------------------------------------------

const FONT: FontSpec = { family: 'sans-serif', size: 12 };

/** Width = text length × per-char (default 10). Lets every assertion hand-derive a
 *  width from a string's length. ascent/descent fixed (irrelevant to layout). */
function measurer(perChar = 10): ITextMeasurer {
  return { measure: (text) => ({ width: text.length * perChar, ascent: 8, descent: 2 }) };
}

/** A back-label fake. `fixedCoordinate` undefined ⇒ aligner-eligible back-label;
 *  defined ⇒ pinned (excluded from width + aligner). */
function label(
  text: string,
  coord: number,
  opts: { fixed?: number; visible?: boolean } = {},
): AxisLabel {
  return {
    coordinate: () => coord,
    fixedCoordinate: opts.fixed === undefined ? undefined : () => opts.fixed,
    text: () => text,
    textColor: () => '#000',
    backColor: () => '#fff',
    visible: opts.visible === undefined ? undefined : () => opts.visible!,
  };
}

const priceInput = (over: Partial<PriceAxisInput> = {}): PriceAxisInput => ({
  ticks: [],
  backLabels: [],
  crosshair: null,
  font: FONT,
  ...over,
});

// chrome for FONT.size 12: border 1 + tickLen 5 + 2·(12/12·5)=10 + labelOffset 5 = 21.
const CHROME = 21;

// --- layoutPriceAxis (study 04 §3.7) ------------------------------------------

describe('layoutPriceAxis — width (study 04 §3.7)', () => {
  test('measures FIRST and LAST tick labels only, then chrome + even-ceil', () => {
    // ticks 'aa'(20) 'zzzzz'(50) 'q'(10): first=20, last=10 → max 20; middle ignored.
    const out = layoutPriceAxis(
      priceInput({ ticks: [{ text: 'aa' }, { text: 'zzzzz' }, { text: 'q' }] }),
      measurer(),
    );
    expect(out.maxLabelWidth).toBe(20); // max(first 20, last 10)
    // 21 + 20 = 41 → even-ceil 42.
    expect(out.width).toBe(42);
  });

  test('back-labels widen the axis and are returned with measured width + coordinate', () => {
    // back-label 'wider!!' length 7 → 70, beats tick 'a'(10).
    const out = layoutPriceAxis(
      priceInput({ ticks: [{ text: 'a' }], backLabels: [label('wider!!', 33)] }),
      measurer(),
    );
    expect(out.maxLabelWidth).toBe(70);
    // 21 + 70 = 91 → even-ceil 92.
    expect(out.width).toBe(92);
    expect(out.labels).toEqual([{ text: 'wider!!', y: 33, width: 70, fixed: false }]);
  });

  test('fixedCoordinate label is EXCLUDED from width but kept in placement (fixed, pinned y)', () => {
    // pinned label length 9 → 90 would dominate, but fixedCoordinate excludes it; the
    // tick 'abcd'(40) sets the width instead.
    const out = layoutPriceAxis(
      priceInput({ ticks: [{ text: 'abcd' }], backLabels: [label('pinned!!!', 7, { fixed: 250 })] }),
      measurer(),
    );
    expect(out.maxLabelWidth).toBe(40); // pinned 90 NOT counted
    expect(out.width).toBe(evenCeilRef(CHROME + 40)); // 61 → 62
    // y is the FIXED coordinate, not coordinate(); fixed flag set.
    expect(out.labels).toEqual([{ text: 'pinned!!!', y: 250, width: 90, fixed: true }]);
  });

  test('invisible back-label is skipped entirely', () => {
    const out = layoutPriceAxis(
      priceInput({ ticks: [{ text: 'a' }], backLabels: [label('ghost', 5, { visible: false })] }),
      measurer(),
    );
    expect(out.maxLabelWidth).toBe(10); // only the tick
    expect(out.labels).toEqual([]);
  });

  test('crosshair samples reserve digit-heavy width (±0.11111111111111)', () => {
    // format echoes the price string; floor(min)+0.111… and ceil(max)−0.111….
    // top 10.2, bottom 12.8 → lo 10.2, hi 12.8 → floor 10 + 0.111…, ceil 13 − 0.111…
    const seen: string[] = [];
    const out = layoutPriceAxis(
      priceInput({
        crosshair: {
          topValue: 10.2,
          bottomValue: 12.8,
          format: (p) => {
            const s = p.toFixed(5);
            seen.push(s);
            return s;
          },
        },
      }),
      measurer(),
    );
    expect(seen).toEqual(['10.11111', '12.88889']); // 10 + 0.111…, 13 − 0.111…
    // both strings length 8 → width 80; chrome 21 → 101 → even-ceil 102.
    expect(out.maxLabelWidth).toBe(80);
    expect(out.width).toBe(102);
  });

  test('nothing measured → 34 px fallback (study 04 §3.7)', () => {
    const out = layoutPriceAxis(priceInput(), measurer());
    expect(out.maxLabelWidth).toBe(0);
    expect(out.width).toBe(34);
  });

  test('minimumWidth is a floor applied after the fallback', () => {
    const out = layoutPriceAxis(priceInput({ minimumWidth: 80 }), measurer());
    expect(out.width).toBe(80); // 34 fallback raised to 80
  });

  test('empty-string label measures 0 (no spurious width)', () => {
    const out = layoutPriceAxis(priceInput({ backLabels: [label('', 0)] }), measurer());
    expect(out.maxLabelWidth).toBe(0);
    expect(out.width).toBe(34); // fallback: nothing measured
  });
});

function evenCeilRef(n: number): number {
  const c = Math.ceil(n);
  return c % 2 === 0 ? c : c + 1;
}

// --- AxisWidthRatchet (design 01 §13.6) ---------------------------------------

describe('AxisWidthRatchet — grow-only + hysteresis shrink (§13.6)', () => {
  test('growth quantises UP to the next 8-px step, immediately', () => {
    const r = new AxisWidthRatchet();
    expect(r.update(1)).toBe(8); // 1 → next 8 multiple
    expect(r.update(8)).toBe(8); // exact multiple, no growth
    expect(r.update(9)).toBe(16); // 9 → 16
    expect(r.width).toBe(16);
  });

  test('a smaller desired width does NOT shrink until 30 consecutive ≥8px-slack frames', () => {
    const r = new AxisWidthRatchet();
    r.update(40); // → 40 (5·8)
    // desired 20 = 20px slack ≥ 8: needs 30 consecutive frames.
    for (let i = 0; i < 29; i++) expect(r.update(20)).toBe(40);
    expect(r.update(20)).toBe(24); // 30th frame: shrink to even-ceil(20/8)·8 = 24
  });

  test('a single sub-threshold frame RESETS the shrink run (oscillation guard)', () => {
    const r = new AxisWidthRatchet();
    r.update(40);
    for (let i = 0; i < 20; i++) r.update(20); // 20 frames of slack accrued
    expect(r.update(38)).toBe(40); // slack 2 < 8 → run resets, no shrink
    // must now take a FULL 30 again.
    for (let i = 0; i < 29; i++) expect(r.update(20)).toBe(40);
    expect(r.update(20)).toBe(24); // shrinks only on the 30th consecutive
  });

  test('slack of exactly 8 px counts toward the run; slack of 7 does not', () => {
    const r = new AxisWidthRatchet();
    r.update(40); // 40
    // desired 32 → slack exactly 8 → counts.
    for (let i = 0; i < 30; i++) r.update(32);
    expect(r.width).toBe(32); // shrank (32/8 = 4 exact → 32)
    const r2 = new AxisWidthRatchet();
    r2.update(40);
    for (let i = 0; i < 100; i++) r2.update(33); // slack 7 < 8 → never shrinks
    expect(r2.width).toBe(40);
  });

  test('growth resets a pending shrink run', () => {
    const r = new AxisWidthRatchet();
    r.update(40);
    for (let i = 0; i < 29; i++) r.update(20); // almost there
    expect(r.update(48)).toBe(48); // grow instead → run reset
    for (let i = 0; i < 29; i++) expect(r.update(20)).toBe(48);
    expect(r.update(20)).toBe(24); // full 30 again from the new width
  });

  test('reset clears width and the shrink counter', () => {
    const r = new AxisWidthRatchet();
    r.update(40);
    r.reset();
    expect(r.width).toBe(0);
    expect(r.update(1)).toBe(8);
  });
});

// --- layoutTimeAxis (study 03 §4.13/§4.14) ------------------------------------

const timeInput = (over: Partial<TimeAxisInput> = {}): TimeAxisInput => ({
  marks: [],
  font: FONT,
  width: 200,
  ...over,
});

describe('layoutTimeAxis — height (study 03 §4.14)', () => {
  test('optimal height = ceil(border+tickLen+F+padTop+padBottom+labelBottomOffset), even', () => {
    // F 12: 1 + 5 + 12 + 3 + 3 + 4 = 28 → even 28.
    expect(layoutTimeAxis(timeInput(), measurer()).height).toBe(28);
  });

  test('odd optimal height rounds UP to even', () => {
    // F 13: padTop=padBottom=39/12=3.25, lbo=52/12≈4.333; 1+5+13+3.25+3.25+4.333=29.83
    // → ceil 30 (already even). Use F 14: pads 3.5/3.5, lbo 4.667; 1+5+14+11.667=31.667
    // → ceil 32.
    expect(layoutTimeAxis(timeInput({ font: { family: 'x', size: 14 } }), measurer()).height).toBe(32);
  });

  test('minimumHeight is a floor (also even-rounded)', () => {
    expect(layoutTimeAxis(timeInput({ minimumHeight: 41 }), measurer()).height).toBe(42);
  });
});

describe('layoutTimeAxis — bold pass (study 03 §4.13)', () => {
  test('boldWeight returns the max visible weight', () => {
    expect(boldWeight([{ coordinate: 0, label: 'a', weight: 50, needAlign: false }])).toBe(50);
    expect(boldWeight([])).toBeNull();
  });

  test('Hour1 quirk: a max strictly between Hour1 (30) and Day (50) drops to 30', () => {
    // weight 31 (Hour3) as max → reduced to 30 so a 15:00 mark is not lone-bolded.
    expect(
      boldWeight([
        { coordinate: 0, label: 'a', weight: 31, needAlign: false },
        { coordinate: 0, label: 'b', weight: 20, needAlign: false },
      ]),
    ).toBe(30);
    // exactly 30 stays 30; exactly 50 stays 50 (boundaries are NOT in the open range).
    expect(boldWeight([{ coordinate: 0, label: 'a', weight: 30, needAlign: false }])).toBe(30);
    expect(boldWeight([{ coordinate: 0, label: 'a', weight: 50, needAlign: false }])).toBe(50);
  });

  test('marks with weight ≥ boldWeight are bold; below it are not', () => {
    const out = layoutTimeAxis(
      timeInput({
        marks: [
          { coordinate: 50, label: 'big', weight: 70, needAlign: false },
          { coordinate: 100, label: 'sm', weight: 20, needAlign: false },
        ],
      }),
      measurer(),
    );
    expect(out.labels.map((l) => l.bold)).toEqual([true, false]); // max 70 → only 70 bold
  });

  test('allowBoldLabels:false makes nothing bold', () => {
    const out = layoutTimeAxis(
      timeInput({
        allowBoldLabels: false,
        marks: [{ coordinate: 50, label: 'x', weight: 70, needAlign: false }],
      }),
      measurer(),
    );
    expect(out.labels[0]!.bold).toBe(false);
  });
});

describe('layoutTimeAxis — edge alignment (study 03 §4.14)', () => {
  test('a centred non-edge label has x = coordinate − halfWidth, center = coordinate', () => {
    // 'abcd' len 4 → width 40 → half 20. coord 100 → x 80.
    const out = layoutTimeAxis(
      timeInput({ marks: [{ coordinate: 100, label: 'abcd', weight: 50, needAlign: false }] }),
      measurer(),
    );
    expect(out.labels[0]).toEqual({ x: 80, center: 100, text: 'abcd', bold: true });
  });

  test('needAlign left-edge label shifts RIGHT so its left edge is ≥ 0', () => {
    // coord 5, 'abcd' half 20 → raw x = −15 → clamped to 0. center stays 5.
    const out = layoutTimeAxis(
      timeInput({ marks: [{ coordinate: 5, label: 'abcd', weight: 50, needAlign: true }] }),
      measurer(),
    );
    expect(out.labels[0]!.x).toBe(0);
    expect(out.labels[0]!.center).toBe(5);
  });

  test('needAlign right-edge label shifts LEFT so its right edge is ≤ width', () => {
    // width 200, coord 195, half 20 → raw x 175, right 215 > 200 → x = 200 − 40 = 160.
    const out = layoutTimeAxis(
      timeInput({ width: 200, marks: [{ coordinate: 195, label: 'abcd', weight: 50, needAlign: true }] }),
      measurer(),
    );
    expect(out.labels[0]!.x).toBe(160);
  });

  test('a NON-needAlign edge label is NOT shifted (may clip — study 03 §4.14)', () => {
    const out = layoutTimeAxis(
      timeInput({ marks: [{ coordinate: 5, label: 'abcd', weight: 50, needAlign: false }] }),
      measurer(),
    );
    expect(out.labels[0]!.x).toBe(-15); // raw centred position, no clamp
  });
});
