import { describe, expect, test } from 'vitest';
import { createPriceLineSource } from './price-line';
import type { PriceLineState } from './price-line';
import { DisplayListBuilder, HitPriority, LineStyle, ZBand } from '../../gfx';
import type { DisplayList, PolylineCommand, ViewFrame } from '../../gfx';
import type { Coordinate } from '../../core';

// --- fakes (mirror crosshair-source.test.ts) ----------------------------------

/** A frame at device ratio (hr, vr); bitmap = media·ratio. */
function frame(hr = 2, vr = 2, w = 100, h = 100): ViewFrame {
  return {
    frame: { mediaSize: { width: w, height: h }, bitmapSize: { width: w * hr, height: h * vr }, hr, vr },
    now: 0,
  };
}

/** A mutable provider so a test can move the price / color between updates. */
function mutableProvider(init: PriceLineState): { provider: () => PriceLineState; set: (s: PriceLineState) => void } {
  let cur = init;
  return { provider: () => cur, set: (s) => { cur = s; } };
}

/** The first polyline command across all lists. */
function poly(lists: readonly DisplayList[]): PolylineCommand {
  for (const l of lists) for (const c of l.commands) if (c.kind === 'polyline') return c;
  throw new Error('no polyline');
}

const STATE: PriceLineState = { y: 30, barColor: '#abc123', text: '30.00' };

// --- emission: one crisp horizontal bitmap line -------------------------------

describe('price-line.emit — horizontal line (study 06 §4.13; design 03 §8.5)', () => {
  test('one bitmap polyline spanning [0, bitmapWidth] at the crisp device y', () => {
    // y 30 media, vr 2 → crispWidth(1,2)=2 (EVEN, no shift); py = round(30·2)=60. bw=200.
    const src = createPriceLineSource(() => STATE);
    src.update(frame(2, 2));
    const lists = src.displayLists();

    expect(lists).toHaveLength(1);
    expect(lists[0]!.space).toBe('bitmap');
    const cmd = poly(lists);
    expect(cmd.width).toBe(2);
    expect(cmd.style).toBe(LineStyle.Dashed); // §4.13 default
    expect(Array.from(cmd.points)).toEqual([0, 60, 200, 60]);
    // one colour run over both vertices.
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(2);
  });

  test('empty priceLineColor falls back to the resolved last-bar color (§4.13)', () => {
    const src = createPriceLineSource(() => STATE); // color '' default
    src.update(frame(2, 2));
    expect(poly(src.displayLists()).runs[0]!.fill).toBe('#abc123');
  });

  test('an explicit priceLineColor overrides the last-bar color', () => {
    const src = createPriceLineSource(() => STATE, { color: '#ff0000' });
    src.update(frame(2, 2));
    expect(poly(src.displayLists()).runs[0]!.fill).toBe('#ff0000');
  });

  test('odd device width gets the +0.5 crispStrokePos shift (DPR 1)', () => {
    // hr=vr=1 → crispWidth(1,1)=1 (ODD) → +0.5 ; py = round(30·1)+0.5 = 30.5 ; bw=100.
    const src = createPriceLineSource(() => STATE);
    src.update(frame(1, 1));
    const cmd = poly(src.displayLists());
    expect(cmd.width).toBe(1);
    expect(Array.from(cmd.points)).toEqual([0, 30.5, 100, 30.5]);
  });

  test('honours an explicit lineWidth and lineStyle', () => {
    // lineWidth 2, vr 2 → crispWidth(2,2)=4 (even).
    const src = createPriceLineSource(() => STATE, { lineWidth: 2, lineStyle: LineStyle.Solid });
    src.update(frame(2, 2));
    const cmd = poly(src.displayLists());
    expect(cmd.width).toBe(4);
    expect(cmd.style).toBe(LineStyle.Solid);
  });
});

// --- visibility / off-pane gates ----------------------------------------------

describe('price-line — render gates (study 06 §4.13 / design 03 §8.5)', () => {
  test('visible:false emits nothing', () => {
    const src = createPriceLineSource(() => STATE, { visible: false });
    src.update(frame(2, 2));
    expect(src.displayLists()).toHaveLength(0);
  });

  test('null y (no last value / no data) emits nothing', () => {
    const src = createPriceLineSource(() => ({ y: null, barColor: '#abc123', text: '' }));
    src.update(frame(2, 2));
    expect(src.displayLists()).toHaveLength(0);
  });

  test('off-pane skip: y·vr above bitmapHeight emits nothing', () => {
    // y 120 media, vr 2 → yDev 240 > bitmapH 200 → suppressed (§4.13 / §8.5.8).
    const src = createPriceLineSource(() => ({ y: 120, barColor: '#abc123', text: '' }));
    src.update(frame(2, 2));
    expect(src.displayLists()).toHaveLength(0);
  });

  test('off-pane skip: negative y emits nothing', () => {
    const src = createPriceLineSource(() => ({ y: -1, barColor: '#abc123', text: '' }));
    src.update(frame(2, 2));
    expect(src.displayLists()).toHaveLength(0);
  });
});

// --- hit testing: |y − lineY| ≤ lineWidth + 7, priority Point -----------------

describe('price-line.hitTest — fixed 7px pad, Point priority (study 06 §4.13)', () => {
  test('cursor within lineWidth+7 of the line → Point hit with the vertical distance', () => {
    // lineWidth 1 → threshold 8 ; probe 5px below media y 30 → d 5 ≤ 8.
    const src = createPriceLineSource(() => STATE);
    const hit = src.hitTest!(50 as Coordinate, 35 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Point);
    expect(hit!.distance).toBeCloseTo(5);
  });

  test('x is ignored — the whole row is hittable at any x', () => {
    const src = createPriceLineSource(() => STATE);
    expect(src.hitTest!(0 as Coordinate, 30 as Coordinate, frame())!.distance).toBeCloseTo(0);
    expect(src.hitTest!(999 as Coordinate, 30 as Coordinate, frame())!.distance).toBeCloseTo(0);
  });

  test('cursor beyond lineWidth+7 → null', () => {
    const src = createPriceLineSource(() => STATE);
    // 10px off, threshold 8 → miss.
    expect(src.hitTest!(50 as Coordinate, 40 as Coordinate, frame())).toBeNull();
  });

  test('a wider line widens the hit band by exactly lineWidth', () => {
    // lineWidth 3 → threshold 10 ; probe 10px off → exactly on the boundary (≤).
    const src = createPriceLineSource(() => STATE, { lineWidth: 3 });
    expect(src.hitTest!(50 as Coordinate, 40 as Coordinate, frame())!.distance).toBeCloseTo(10);
    // 11px off → miss.
    expect(src.hitTest!(50 as Coordinate, 41 as Coordinate, frame())).toBeNull();
  });

  test('hidden line is never hit (visible:false / null y)', () => {
    expect(createPriceLineSource(() => STATE, { visible: false }).hitTest!(0 as Coordinate, 30 as Coordinate, frame())).toBeNull();
    const noData = createPriceLineSource(() => ({ y: null, barColor: '#abc123', text: '' }));
    expect(noData.hitTest!(0 as Coordinate, 30 as Coordinate, frame())).toBeNull();
  });

  test('a custom line echoes its externalId on a hit', () => {
    const src = createPriceLineSource(() => STATE, { externalId: 'pl-7' });
    expect(src.hitTest!(0 as Coordinate, 30 as Coordinate, frame())!.externalId).toBe('pl-7');
  });
});

// --- axis-label hook ----------------------------------------------------------

describe('price-line.axisLabel — mirrors the line off the same provider', () => {
  test('coordinate/text/colors track the provider; back == text color == resolved fill', () => {
    const src = createPriceLineSource(() => STATE); // empty color → falls back to barColor
    const label = src.axisLabel();
    expect(label.coordinate()).toBe(30);
    expect(label.text()).toBe('30.00');
    expect(label.textColor()).toBe('#abc123');
    expect(label.backColor()).toBe('#abc123');
    expect(label.visible!()).toBe(true);
  });

  test('axisLabelVisible:false hides the label even when the line draws', () => {
    const src = createPriceLineSource(() => STATE, { axisLabelVisible: false });
    expect(src.axisLabel().visible!()).toBe(false);
  });

  test('null y hides the label', () => {
    const src = createPriceLineSource(() => ({ y: null, barColor: '#abc123', text: '' }));
    expect(src.axisLabel().visible!()).toBe(false);
  });
});

// --- SceneSource contract + per-source cache identity (perf §4.4.2) -----------

describe('price-line — SceneSource contract & cache identity', () => {
  test('registers in the AboveSeries z-band (drawn above the series)', () => {
    expect(createPriceLineSource(() => STATE).zBand).toBe(ZBand.AboveSeries);
  });

  test('a CLEAN re-update returns the byte-identical cached array (no re-emit)', () => {
    const src = createPriceLineSource(() => STATE);
    const f = frame(2, 2);
    src.update(f);
    const a = src.displayLists();
    src.update(f); // same state + same geometry → clean
    expect(src.displayLists()).toBe(a); // identical reference (§4.4.2)
  });

  test('a moved price dirties → a NEW array with the new crisp y', () => {
    const { provider, set } = mutableProvider(STATE);
    const src = createPriceLineSource(provider);
    const f = frame(2, 2);
    src.update(f);
    const a = src.displayLists();
    set({ y: 40, barColor: '#abc123', text: '40.00' });
    src.update(f);
    const b = src.displayLists();
    expect(b).not.toBe(a);
    expect(Array.from(poly(b).points)).toEqual([0, 80, 200, 80]); // py = round(40·2)
  });

  test('a color change (same y) dirties to a fresh array', () => {
    const { provider, set } = mutableProvider(STATE);
    const src = createPriceLineSource(provider);
    const f = frame(2, 2);
    src.update(f);
    const a = src.displayLists();
    set({ y: 30, barColor: '#000000', text: '30.00' });
    src.update(f);
    expect(src.displayLists()).not.toBe(a);
  });

  test('a geometry change (DPR) dirties even when the state is unchanged', () => {
    const src = createPriceLineSource(() => STATE);
    src.update(frame(2, 2));
    const a = src.displayLists();
    src.update(frame(1, 1)); // vr changed → crisp coords change → re-emit
    expect(src.displayLists()).not.toBe(a);
  });

  test('going off-pane dirties to EMPTY, then back on-pane re-emits', () => {
    const { provider, set } = mutableProvider(STATE);
    const src = createPriceLineSource(provider);
    const f = frame(2, 2);
    src.update(f);
    expect(src.displayLists()).toHaveLength(1);
    set({ y: 200, barColor: '#abc123', text: '' }); // yDev 400 > 200 → off-pane
    src.update(f);
    expect(src.displayLists()).toHaveLength(0);
    set(STATE);
    src.update(f);
    expect(src.displayLists()).toHaveLength(1);
  });

  test('uses the sanctioned polyline shape (Σ runs == vertex count)', () => {
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const p = b.polyline(2, LineStyle.Dashed, 'miter');
    p.vertex(0, 60, '#abc123');
    p.vertex(200, 60, '#abc123');
    const cmd = b.finish()[0]!.commands[0] as PolylineCommand;
    expect(cmd.runs.reduce((s, r) => s + r.count, 0)).toBe(2);
  });
});
