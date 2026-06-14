import { describe, expect, test } from 'vitest';
import { createBaselineKind } from './baseline';
import type { BaselineItem } from './baseline';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder, HitPriority } from '../../gfx';
import type { AreaCommand, LinearGradientY, PolylineCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { Coordinate, TimeIndex } from '../../core';

// --- fakes (mirror line.test.ts) ----------------------------------------------

/** Single-value SoA store; timeIndex(i) == i so rows map left→right through horz. */
function fakeStore(values: number[]): PlotStoreView {
  const n = values.length;
  return {
    length: n,
    timeIndex: (i) => i as TimeIndex,
    current: (i) => values[i]!,
    min: (i) => values[i]!,
    max: (i) => values[i]!,
    lane: (_n, i) => values[i]!,
    firstIndexAt: () => null,
    nearestIndexAt: () => -1,
  };
}

/** indexToCoordinate(ix): ix 0→64, 1→74, 2→84, 3→94 (media px); barSpacing 10. */
function horz(barSpacing = 10): HorzGeometry {
  return createHorzGeometry({ width: 100, barSpacing, rightOffset: 0, baseIndex: 3 });
}

/** priceToCoordinate(price) = 200 − price (larger price → smaller/top Y). NaN→NaN. */
function fakePrice(): PriceConverter {
  return {
    priceToCoordinate: (p) => 200 - p,
    firstValue: null,
    mode: 'normal',
    toLogical: (p) => p,
  };
}

function frame(hr = 2, vr = 2): ViewFrame {
  return {
    frame: { mediaSize: { width: 100, height: 100 }, bitmapSize: { width: 100 * hr, height: 100 * vr }, hr, vr },
    now: 0,
  };
}

const REPLACE: StoreDiff = { kind: 'replace' };

/** Converted buffer for `values` over the full window + the kind. */
function setup(values: number[], opts: SeriesOptions = {}, h = horz()) {
  const kind = createBaselineKind(opts);
  const buf = kind.createBuffer();
  kind.itemsFromStore(fakeStore(values), REPLACE, buf);
  kind.convert(buf, itemWindow(0, values.length), frame(), h, fakePrice());
  return { kind, buf };
}

/** Drive emit; return the two lists' first commands (media area, bitmap polyline). */
function emitLists(kind: ReturnType<typeof createBaselineKind>, buf: ItemBuffer<BaselineItem>) {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  return b.finish();
}

// --- fill emission goldens (media-space area; study 06 §4.7) ------------------

describe('baseline.emit — area fill (media, hard-split gradient; study 06 §4.7)', () => {
  test('one media area; baseY = baseLevelCoordinate; points = media x/y UNROUNDED', () => {
    // baseValue price 150 → baseY = priceToCoordinate(150) = 200 − 150 = 50 (media).
    const { kind, buf } = setup([10, 12, 11, 14], { baseValue: { price: 150 } });
    const lists = emitLists(kind, buf);

    expect(lists[0]!.space).toBe('media');
    const fill = lists[0]!.commands[0] as AreaCommand;
    expect(fill.kind).toBe('area');
    expect(fill.baseY).toBe(50); // priceToCoordinate(150)

    // 4 vertices · 2 floats; media centres x 64/74/84/94, y = 200 − v (UNROUNDED).
    expect(Array.from(fill.points)).toEqual([
      64, 190, // (64, 200−10)
      74, 188, // (74, 200−12)
      84, 189, // (84, 200−11)
      94, 186, // (94, 200−14)
    ]);
  });

  test('fill gradient: hard split at r = clamp((baseY−top)/(bottom−top),0,1); 4 stops', () => {
    // relativeGradient false → top 0, bottom mediaHeight 100. baseY = 50.
    // r = clamp((50−0)/(100−0), 0, 1) = 0.5 (the two coincident stops = hard split).
    const { kind, buf } = setup([10, 12], { baseValue: { price: 150 } });
    const fill = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    const g = fill.fill as LinearGradientY;
    expect(g.from).toBe(0);
    expect(g.to).toBe(100);
    expect(g.stops.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
    // top band uses topFill1/2; bottom band uses bottomFill1/2 (study 06 §4.7 defaults).
    expect(g.stops[0]!.color).toBe('rgba(38, 166, 154, 0.28)'); // topFillColor1
    expect(g.stops[1]!.color).toBe('rgba(38, 166, 154, 0.05)'); // topFillColor2
    expect(g.stops[2]!.color).toBe('rgba(239, 83, 80, 0.05)'); // bottomFillColor1
    expect(g.stops[3]!.color).toBe('rgba(239, 83, 80, 0.28)'); // bottomFillColor2
  });

  test('split ratio clamps to 1 when the baseline sits below the band (default base 0)', () => {
    // baseValue 0 → baseY = 200; top 0, bottom 100 → r = clamp(200/100,0,1) = 1.
    const { kind, buf } = setup([10, 12]);
    const fill = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    const g = fill.fill as LinearGradientY;
    expect(g.stops.map((s) => s.offset)).toEqual([0, 1, 1, 1]);
  });
});

// --- top-line emission goldens (bitmap polyline; design 03 §8.5.3) ------------

describe('baseline.emit — top line (bitmap, hard-split line gradient; §8.5.3)', () => {
  test('one bitmap polyline; coords x·hr,y·vr UNROUNDED; width = lineWidth·vr', () => {
    const { kind, buf } = setup([10, 12, 11, 14], { baseValue: { price: 150 } });
    const cmd = emitLists(kind, buf)[1]!.commands[0] as PolylineCommand;

    expect(cmd.kind).toBe('polyline');
    expect(cmd.join).toBe('round');
    expect(cmd.width).toBe(3 * 2); // lineWidth 3 · vr 2

    expect(Array.from(cmd.points)).toEqual([
      128, 380, // (64·2, (200−10)·2)
      148, 376, // (74·2, (200−12)·2)
      168, 378, // (84·2, (200−11)·2)
      188, 372, // (94·2, (200−14)·2)
    ]);
  });

  test('every vertex carries the ONE hard-split LINE gradient → a single run', () => {
    // band span in DEVICE px: top 0·vr2=0, bottom 100·vr2=200, baseY 50·vr2=100.
    // r = clamp((100−0)/(200−0),0,1) = 0.5. line gradient uses topLine/topLine,
    // bottomLine/bottomLine (hard colour switch, no fade — study 06 §4.7).
    const { kind, buf } = setup([10, 12], { baseValue: { price: 150 } });
    const cmd = emitLists(kind, buf)[1]!.commands[0] as PolylineCommand;
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(2); // both vertices in one run (one gradient ref)
    const g = cmd.runs[0]!.fill as LinearGradientY;
    expect(g.from).toBe(0);
    expect(g.to).toBe(200);
    expect(g.stops.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
    expect(g.stops[0]!.color).toBe('rgba(38, 166, 154, 1)'); // topLineColor
    expect(g.stops[1]!.color).toBe('rgba(38, 166, 154, 1)'); // topLineColor (no fade)
    expect(g.stops[2]!.color).toBe('rgba(239, 83, 80, 1)'); // bottomLineColor
    expect(g.stops[3]!.color).toBe('rgba(239, 83, 80, 1)'); // bottomLineColor
  });

  test('NaN value → pen-up gap (NaN,NaN) in the polyline + skipped in the fill', () => {
    const { kind, buf } = setup([10, NaN, 12]);
    const lists = emitLists(kind, buf);
    const fill = lists[0]!.commands[0] as AreaCommand;
    // fill skips the NaN vertex → only two finite points.
    expect(fill.points.length).toBe(4);
    const line = lists[1]!.commands[0] as PolylineCommand;
    expect(line.points.length).toBe(6); // anchor, gap, anchor
    expect(Number.isNaN(line.points[2]!)).toBe(true);
    expect(Number.isNaN(line.points[3]!)).toBe(true);
  });

  test('single visible point → horizontal stub one bar wide, centred (study 06 §4.4)', () => {
    const { kind, buf } = setup([10]); // x centre 64, y 190, barSpacing 10
    const lists = emitLists(kind, buf);
    const fill = lists[0]!.commands[0] as AreaCommand;
    // half = barSpacing/2 = 5 → media stub (59,190)–(69,190).
    expect(Array.from(fill.points)).toEqual([59, 190, 69, 190]);
    const line = lists[1]!.commands[0] as PolylineCommand;
    // line stub in device px: half = (10/2)·hr2 = 10 ; centre 64·2=128 ; y 190·2=380.
    expect(Array.from(line.points)).toEqual([118, 380, 138, 380]);
  });

  test('lineVisible:false → only the fill list, no polyline', () => {
    const { kind, buf } = setup([10, 12], { lineVisible: false });
    const lists = emitLists(kind, buf);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.space).toBe('media');
    expect(lists[0]!.commands[0]!.kind).toBe('area');
  });
});

// --- relativeGradient band span (study 06 §4.7) -------------------------------

describe('baseline.emit — relativeGradient band span (study 06 §4.7)', () => {
  test('top/bottom = min/max y over the visible slice', () => {
    // values 10,14 → y 190,186. min y 186, max y 190. baseValue 150 → baseY 50.
    // r = clamp((50−186)/(190−186),0,1) = clamp(−34,0,1) = 0 (baseline above the band).
    const { kind, buf } = setup([10, 14], { baseValue: { price: 150 }, relativeGradient: true });
    const fill = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    const g = fill.fill as LinearGradientY;
    expect(g.from).toBe(186);
    expect(g.to).toBe(190);
    expect(g.stops.map((s) => s.offset)).toEqual([0, 0, 0, 1]);
  });
});

// --- bar colorer (study 06 §4.3) ----------------------------------------------

describe('baseline — colorer above/below the base (study 06 §4.3)', () => {
  test('above (close ≥ baseValue) → topLineColor; below → bottomLineColor', () => {
    // baseValue price 11 → close 10 below, close 12 above.
    const { buf } = setup([10, 12], { baseValue: { price: 11 } });
    expect(buf.item(0).color).toBe('rgba(239, 83, 80, 1)'); // bottomLineColor (10 < 11)
    expect(buf.item(1).color).toBe('rgba(38, 166, 154, 1)'); // topLineColor (12 ≥ 11)
  });
});

// --- hitTest consistency with the drawn geometry (study 06 §4.12) -------------

describe('baseline.hitTest — geometry equals emit (study 06 §4.12)', () => {
  test('cursor on the top-line segment → Line hit with the true point-segment distance', () => {
    const { kind, buf } = setup([10, 12]); // media centres (64,190)-(74,188)
    // 3px (media) above the segment midpoint (69,189).
    const hit = kind.hitTest(buf, 69 as Coordinate, (189 - 3) as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Line);
    expect(hit!.distance).toBeLessThanOrEqual(4.5); // radius = lineWidth/2(1.5)+tol(3)
  });

  test('cursor far from the line → null', () => {
    const { kind, buf } = setup([10, 12]);
    expect(kind.hitTest(buf, 69 as Coordinate, 100 as Coordinate)).toBeNull();
  });

  test('single point stub is hittable across its bar-width span (Point priority)', () => {
    const { kind, buf } = setup([10]); // centre (64,190), barSpacing 10 → span ±5
    const hit = kind.hitTest(buf, 61 as Coordinate, 190 as Coordinate); // inside [59,69]
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Point);
  });
});

// --- contract -----------------------------------------------------------------

describe('baseline kind — contract', () => {
  test('extendedRange is true (line-like ±1 off-screen segment, study 10 §4.11)', () => {
    expect(createBaselineKind({}).extendedRange).toBe(true);
  });

  test('decimate (sub-pixel spacing) writes a bitmap polyline, buffer unread', () => {
    const kind = createBaselineKind({});
    const b = new DisplayListBuilder();
    kind.decimate(fakeStore([10, 11, 12]), itemWindow(0, 3), frame(2, 2), horz(0.1), fakePrice(), b);
    const lists = b.finish();
    expect(lists[0]!.space).toBe('bitmap');
    expect(lists[0]!.commands[0]!.kind).toBe('polyline');
  });
});
