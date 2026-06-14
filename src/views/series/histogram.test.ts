import { describe, expect, test } from 'vitest';
import { createHistogramKind } from './histogram';
import type { HistogramItem } from './histogram';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder, HitPriority } from '../../gfx';
import type { RectsCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { Coordinate, TimeIndex } from '../../core';

// --- fakes (mirroring line.test.ts) -------------------------------------------

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

/** indexToCoordinate(ix): ix 0→64, 1→74, 2→84, 3→94 (media px centres). */
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

/** Build a converted buffer for `values` over the full window. */
function setup(values: number[], opts: SeriesOptions = {}, h = horz()) {
  const kind = createHistogramKind(opts);
  const buf = kind.createBuffer();
  const store = fakeStore(values);
  kind.itemsFromStore(store, REPLACE, buf);
  kind.convert(buf, itemWindow(0, values.length), frame(), h, fakePrice());
  return { kind, buf, store };
}

/** Drive emit and return the first (rects) command. */
function emitRects(kind: ReturnType<typeof createHistogramKind>, buf: ItemBuffer<HistogramItem>): RectsCommand {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  const lists = b.finish();
  expect(lists[0]!.space).toBe('bitmap');
  return lists[0]!.commands[0] as RectsCommand;
}

// --- emit golden (numbers hand-derived from the §4.11 recipe + the fakes) ------
//
// PHASE 1 (barSpacing 10, hr 2):
//   spacing     = ceil(10·2)=20 > 1 → max(1, floor(2)) = 2          (1px gap, ·hr)
//   columnWidth = round(10·2) − spacing = 20 − 2 = 18  (EVEN → half=9, bias 1px left)
//   This is ~(barSpacing·hr − gap) = 18, NOT ~0.3·barSpacing·hr (= 6, the Bar width).
//   item0 x64 → centre round(128)=128 → left=128−9=119, right=128+9−1=136 (w=18)
//   item1 x74 → centre round(148)=148 → left=148−9=139, right=148+9−1=156 (w=18)
//   ALIGNMENT (ti 0,1 adjacent): cur.left−prev.right = 139−136 = 3 = spacing+1 → no change.
//   FIX: right ≥ left. EQUALIZE: minWidth=min(ceil(20)=20, 18,18)=18 ≮ 4 → no shave.
// PHASE 2 (vr 2): tickWidth = max(1, floor(2)) = 2.
//   base 0 → baseY media=200 → baseY = round(400)=400; topBase = 400−floor(2/2)=399,
//   bottomBase = 399+2 = 401.

describe('histogram.emit — one bitmap rects, §4.11 column geometry (design 03 §8.5.4)', () => {
  test('above-base columns span [round(y·vr) .. bottomBase]; width ≈ barSpacing−gap', () => {
    const { kind, buf } = setup([10, 12]); // default color '#26a69a', base 0
    const cmd = emitRects(kind, buf);

    expect(cmd.kind).toBe('rects');
    // 2 columns · 4 floats (x,y,w,h). columnWidth 18 (NOT 6); left = centre − half(9).
    //   item0 v10: yc = round((200−10)·2)=380 ≤ 399 → [380 .. 401], h=21.
    //   item1 v12: yc = round((200−12)·2)=376 ≤ 399 → [376 .. 401], h=25.
    expect(Array.from(cmd.coords)).toEqual([
      119, 380, 18, 21, // (left 119, top 380, w 136−119+1=18, h 401−380=21)
      139, 376, 18, 25, // (left 139, top 376, w 156−139+1=18, h 401−376=25)
    ]);
    // single colour → single run spanning both quads; Σcount === quad count.
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(2);
    expect(cmd.runs[0]!.fill).toBe('#26a69a');
  });

  test('column width is ≈ barSpacing − gap, NOT ≈ 0.3·barSpacing (the Bar width)', () => {
    const { kind, buf } = setup([10, 12]);
    const cmd = emitRects(kind, buf);
    const w0 = cmd.coords[2]!; // first quad's width float
    expect(w0).toBe(18); // round(10·2) − 2
    expect(w0).toBeGreaterThan(Math.floor(10 * 0.3 * 2)); // 18 ≫ 6 (the Bar §4.9 column)
  });

  test('below-base column straddles: base above the value → [topBase .. y−tickW/2+tickW]', () => {
    // base 15 → baseY media = 185 → baseY = round(370)=370; topBase = 370−floor(2/2)=369,
    //   bottomBase = 371. value 10: yc = round(380)=380 > 369 → below.
    //   top = topBase 369, bottom = 380 − floor(2/2) + 2 = 381 → h = 12. (geometry: w 18)
    const { kind, buf } = setup([10], { base: 15 });
    const cmd = emitRects(kind, buf);
    expect(Array.from(cmd.coords)).toEqual([119, 369, 18, 12]);
  });

  test('a zero-height column still paints a tickWidth tick at the base line', () => {
    // value == base (0): yc = round(400)=400 > topBase 399 → below.
    //   top = 399, bottom = 400 − floor(2/2) + 2 = 401 → h = 2 = tickWidth (a visible tick).
    const { kind, buf } = setup([0]); // base 0
    const cmd = emitRects(kind, buf);
    expect(Array.from(cmd.coords)).toEqual([119, 399, 18, 2]);
    expect(cmd.coords[3]).toBe(Math.max(1, Math.floor(2))); // h === tickWidth, never 0
  });

  test('NaN value → no quad emitted (gap), and an explicit colour is honoured', () => {
    const { kind, buf } = setup([10, NaN, 12], { color: '#ff0000' });
    const cmd = emitRects(kind, buf);
    // 2 finite columns → 8 floats; the NaN row contributes nothing.
    expect(cmd.coords.length).toBe(8);
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(2);
    expect(cmd.runs[0]!.fill).toBe('#ff0000');
  });
});

// --- hitTest over the converted buffer (study 06 §4.12) -----------------------
//
// converted media: item0 (x64, y190), item1 (x74, y188); baseY 200; barSpacing 10.
// span(0) = [min(190,200)=190 .. max=200]; span(1) = [188 .. 200].
// slot(0): prev absent (from) → left = 64−5−tol = 56; next present (ti 1) → right =
//   (64+74)/2 + tol = 72. cursor x=64 lands inside.

describe('histogram.hitTest — column slot + base-straddle vertical range (study 06 §4.12)', () => {
  test('cursor inside a column → Range hit, distance 0', () => {
    const { kind, buf } = setup([10, 12]);
    const hit = kind.hitTest(buf, 64 as Coordinate, 195 as Coordinate); // inside [190,200]
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBe(0);
  });

  test('cursor just above the top within tolerance → Range hit, distance to top edge', () => {
    const { kind, buf } = setup([10, 12]);
    const hit = kind.hitTest(buf, 64 as Coordinate, 188 as Coordinate); // 2px above top 190
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBeCloseTo(2);
  });

  test('cursor far below the column (beyond tolerance) → null', () => {
    const { kind, buf } = setup([10, 12]);
    expect(kind.hitTest(buf, 64 as Coordinate, 210 as Coordinate)).toBeNull(); // 10px below base 200
  });
});

// --- contract -----------------------------------------------------------------

describe('histogram kind — contract', () => {
  test('extendedRange is false (columns are self-contained, no ±1 neighbour)', () => {
    expect(createHistogramKind({}).extendedRange).toBe(false);
  });

  test('decimate (sub-pixel spacing) writes a bitmap rects and leaves the buffer unread', () => {
    const kind = createHistogramKind({});
    const b = new DisplayListBuilder();
    // barSpacing·hr = 0.1·2 = 0.2 < 1 → decimation active.
    kind.decimate(fakeStore([10, 11, 12]), itemWindow(0, 3), frame(2, 2), horz(0.1), fakePrice(), b);
    const lists = b.finish();
    expect(lists[0]!.space).toBe('bitmap');
    expect(lists[0]!.commands[0]!.kind).toBe('rects');
  });
});
