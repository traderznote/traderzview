import { describe, expect, test } from 'vitest';
import { createCandlestickKind } from './candlestick';
import type { CandlestickItem } from './candlestick';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder, HitPriority } from '../../gfx';
import type { RectsCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { Coordinate, TimeIndex } from '../../core';

// --- fakes (mirroring bar/line/histogram tests) -------------------------------

/** OHLC SoA store: rows are [open, high, low, close]; timeIndex(i) == i so rows map
 *  left→right through horz. Role accessors mirror the contract (close=current,
 *  low=min, high=max, open=lane 0). */
function fakeStore(rows: readonly (readonly [number, number, number, number])[]): PlotStoreView {
  return {
    length: rows.length,
    timeIndex: (i) => i as TimeIndex,
    current: (i) => rows[i]![3], // close
    min: (i) => rows[i]![2], // low
    max: (i) => rows[i]![1], // high
    lane: (n, i) => rows[i]![n]!, // lane 0 = open
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

/** Full explicit colours so emit goldens assert exact run fills. */
const COLORS: SeriesOptions = {
  upColor: '#11aa11',
  downColor: '#cc2222',
  borderUpColor: '#0a800a',
  borderDownColor: '#a01010',
  wickUpColor: '#0d990d',
  wickDownColor: '#b01818',
};

/** Build a converted buffer for `rows` over the full window. */
function setup(
  rows: readonly (readonly [number, number, number, number])[],
  opts: SeriesOptions = COLORS,
  h = horz(),
) {
  const kind = createCandlestickKind(opts);
  const buf = kind.createBuffer();
  const store = fakeStore(rows);
  kind.itemsFromStore(store, REPLACE, buf);
  kind.convert(buf, itemWindow(0, rows.length), frame(), h, fakePrice());
  return { kind, buf, store };
}

/** Drive emit; return the bitmap rects commands of list 0 (the pass sequence). */
function emitRects(
  kind: ReturnType<typeof createCandlestickKind>,
  buf: ItemBuffer<CandlestickItem>,
  h = horz(),
): RectsCommand[] {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  const lists = b.finish();
  expect(lists[0]!.space).toBe('bitmap');
  return lists[0]!.commands as RectsCommand[];
}

// --- emit golden — study 06 §4.10 three passes (numbers hand-derived) ----------
//
// Width math @ barSpacing 10, hr 2:
//   optimalCandlestickWidth(10,2): coeff = 1 − 0.2·atan(6)/(π/2) ≈ 0.82103;
//     res = floor(10·0.82103·2)=16; clamp max(2,min(16,floor(20)=20))=16;
//     applyBarParity(16, floor(2)=2) → 16 (same parity). barWidth = 16, halfBar = 8.
//   WICKS: wickWidth = max(floor(2)=2, min(min(floor(2)=2, floor(20)=20)=2, 16)) = 2;
//     wickOffset = floor(2/2) = 1.
//   BORDER width bw: floor(1·2)=2; 16<=4? no; max(floor(2)=2,2)=2; 16<=4? no → bw=2.
//   BODIES: borderVisible && 16<=4? no → bodies drawn, inset by bw=2.
//   borders: barSpacing·hr=20 > 2·bw=4 → HOLLOW frame (4 rects).
//
// item0 up   [o10,h15,l8 ,c12]: openY190 highY185 lowY192 closeY188. x64→round128.
//   body top round(min(190,188)·2)=376, bottom round(190·2)=380; high round(185·2)=370,
//     low round(192·2)=384.
//   wick: left round(128)−1=127, right=128. upper (127,370,2,376−370=6);
//     lower (127,380+1=381,2,384−380=4).
//   border: left round(128)−8=120, right=135, w=16. top edge (122,376,12,2);
//     bottom edge (122,380−2+1=379,12,2); left edge (120,376,2,5); right edge (134,376,2,5).
//   body: inset → left122 right133 top378 bottom378 → (122,378,12,1).
// item1 down [o14,h16,l11,c12]: openY186 highY184 lowY189 closeY188. x74→round148.
//   body top round(186·2)=372, bottom round(188·2)=376; high round(184·2)=368,
//     low round(189·2)=378.
//   wick: left round(148)−1=147, right=148; prevRight 128 → clamp(147,129,148)=147.
//     upper (147,368,2,372−368=4); lower (147,376+1=377,2,378−376=2).
//   border: left round(148)−8=140, right=155, w=16; prevRight 135 → clamp(140,136,155)=140.
//     top edge (142,372,12,2); bottom edge (142,376−2+1=375,12,2);
//     left edge (140,372,2,5); right edge (154,372,2,5).
//   body: inset → left142 right153 top374 bottom374 → (142,374,12,1).

describe('candlestick.emit — three passes wicks→borders→bodies, runs by colour (study 06 §4.10)', () => {
  const rows: readonly (readonly [number, number, number, number])[] = [
    [10, 15, 8, 12], // up
    [14, 16, 11, 12], // down
  ];

  test('the pass sequence is exactly [wicks, borders, bodies], all rects', () => {
    const { kind, buf } = setup(rows);
    const cmds = emitRects(kind, buf);
    expect(cmds).toHaveLength(3);
    expect(cmds.map((c) => c.kind)).toEqual(['rects', 'rects', 'rects']);
  });

  test('PASS 1 wicks: upper+lower stick per bar, centred + offset, runs by wick colour', () => {
    const { kind, buf } = setup(rows);
    const [wicks] = emitRects(kind, buf);
    expect(Array.from(wicks!.coords)).toEqual([
      127, 370, 2, 6, // item0 upper wick
      127, 381, 2, 4, // item0 lower wick
      147, 368, 2, 4, // item1 upper wick
      147, 377, 2, 2, // item1 lower wick
    ]);
    // each bar emits 2 quads of its wick colour → two 2-count runs (up then down).
    expect(wicks!.runs.map((r) => [r.count, r.fill])).toEqual([
      [2, '#0d990d'],
      [2, '#b01818'],
    ]);
  });

  test('PASS 2 borders: hollow frame (4 rects/bar) when barSpacing·hr > 2·bw, runs by border colour', () => {
    const { kind, buf } = setup(rows);
    const [, borders] = emitRects(kind, buf);
    expect(Array.from(borders!.coords)).toEqual([
      122, 376, 12, 2, // item0 top edge
      122, 379, 12, 2, // item0 bottom edge
      120, 376, 2, 5, // item0 left edge
      134, 376, 2, 5, // item0 right edge
      142, 372, 12, 2, // item1 top edge
      142, 375, 12, 2, // item1 bottom edge
      140, 372, 2, 5, // item1 left edge
      154, 372, 2, 5, // item1 right edge
    ]);
    expect(borders!.runs.map((r) => [r.count, r.fill])).toEqual([
      [4, '#0a800a'],
      [4, '#a01010'],
    ]);
  });

  test('PASS 3 bodies: open→close rect inset by bw on all sides, runs by body colour', () => {
    const { kind, buf } = setup(rows);
    const [, , bodies] = emitRects(kind, buf);
    expect(Array.from(bodies!.coords)).toEqual([
      122, 378, 12, 1, // item0 body (inset 2 from 120..135 / 376..380)
      142, 374, 12, 1, // item1 body (inset 2 from 140..155 / 372..376)
    ]);
    expect(bodies!.runs.map((r) => [r.count, r.fill])).toEqual([
      [1, '#11aa11'],
      [1, '#cc2222'],
    ]);
  });

  test('up/down colours (previously ignored borderUp/Down, wickUp/Down) are honoured per pass', () => {
    // open ≤ close ⇒ up; open > close ⇒ down (resolveBarColors). Bodies span ≥ 8px so
    // the bw=2 inset never swallows them and all three passes emit a quad per bar.
    const { kind, buf } = setup([
      [10, 15, 8, 14], // open < close → up (body 372..380)
      [14, 16, 8, 10], // open > close → down (body 372..380)
    ]);
    const [wicks, borders, bodies] = emitRects(kind, buf);
    expect(wicks!.runs.map((r) => r.fill)).toEqual(['#0d990d', '#b01818']);
    expect(borders!.runs.map((r) => r.fill)).toEqual(['#0a800a', '#a01010']);
    expect(bodies!.runs.map((r) => r.fill)).toEqual(['#11aa11', '#cc2222']);
  });

  test('wickVisible:false suppresses the wick pass (borders then bodies remain)', () => {
    const { kind, buf } = setup([[10, 15, 8, 12]], { ...COLORS, wickVisible: false });
    const cmds = emitRects(kind, buf);
    expect(cmds).toHaveLength(2);
    // first surviving pass is borders (hollow frame = 4 quads), then bodies (1 quad).
    expect(cmds[0]!.coords.length).toBe(16); // 4 border quads · 4 floats
    expect(cmds[0]!.runs[0]!.fill).toBe('#0a800a');
    expect(cmds[1]!.coords.length).toBe(4); // 1 body quad
    expect(cmds[1]!.runs[0]!.fill).toBe('#11aa11');
  });

  test('borderVisible:false suppresses borders AND drops the body inset (full-width body)', () => {
    const { kind, buf } = setup([[10, 15, 8, 12]], { ...COLORS, borderVisible: false });
    const cmds = emitRects(kind, buf);
    expect(cmds).toHaveLength(2); // wicks + bodies, no borders
    const bodies = cmds[1]!;
    // no inset: body is the full 120..135 × 376..380 column → (120,376,16,5).
    expect(Array.from(bodies.coords)).toEqual([120, 376, 16, 5]);
  });

  test('NaN OHLC → no quad in any pass (gap skipped)', () => {
    const { kind, buf } = setup([
      [10, 15, 8, 12],
      [NaN, NaN, NaN, NaN],
    ]);
    const [wicks, borders, bodies] = emitRects(kind, buf);
    expect(wicks!.coords.length).toBe(8); // 1 finite candle · 2 wick quads
    expect(borders!.coords.length).toBe(16); // 1 finite candle · 4 border quads
    expect(bodies!.coords.length).toBe(4); // 1 finite candle · 1 body quad
  });

  test('hollow-frame vs filled body switches on barSpacing·hr ≤ 2·bw', () => {
    // barSpacing 0.8, hr 2: optimalCandlestickWidth(0.8,2)=max(floor(2)=2,
    //   min(floor(0.8·0.82103·2)=floor(1.31)=1, floor(0.8·2)=1))=2 → parity vs 2 → 2.
    //   bw: floor(2)=2; barWidth 2 <= 2·2=4 → bw=floor((2−1)·0.5)=floor(0.5)=0;
    //       bw=max(floor(2)=2,0)=2; 2<=4 → bw=max(floor(2)=2,floor(2)=2)=2.
    //   barSpacing·hr = 1.6, 2·bw = 4 → 1.6 ≤ 4 → FILLED rect (1 quad/bar), not 4.
    //   bodies: borderVisible && barWidth 2 <= 2·bw 4 → bodies pass SKIPPED entirely.
    const { kind, buf } = setup([[10, 15, 8, 12]], COLORS, horz(0.8));
    const b = new DisplayListBuilder();
    kind.emit(buf, itemWindow(0, 1), frame(), b);
    const cmds = b.finish()[0]!.commands as RectsCommand[];
    // wicks present, borders present (1 filled quad), bodies SKIPPED.
    expect(cmds).toHaveLength(2);
    const borders = cmds[1]!; // [wicks, borders]
    expect(borders.coords.length).toBe(4); // one filled rect, not a 4-rect frame
    expect(borders.runs[0]!.fill).toBe('#0a800a');
  });

  test('a doji body (open == close) collapses to a 1px-tall fill after inset', () => {
    // open == close == 12 → openY==closeY==188 → top==bottom==376 (before inset).
    // borderVisible inset by bw=2: top 378, bottom 374 → top > bottom → body SKIPPED.
    const { kind, buf } = setup([[12, 15, 8, 12]]);
    const [, , bodies] = emitRects(kind, buf);
    expect(bodies!.coords.length).toBe(0); // border swallowed the doji body
  });
});

// --- hitTest over the converted buffer (study 06 §4.12) -----------------------
//
// converted media: item0 (x64) span [min(185,192)=185 .. 192]; item1 (x74) span
// [184 .. 189]; barSpacing 10, tol 3. slot(0): prev absent → left 64−5−3=56; next
// present → right (64+74)/2+3 = 72. cursor x=64 lands inside.

describe('candlestick.hitTest — column slot + hi–lo vertical range (study 06 §4.12)', () => {
  test('cursor inside a candle hi–lo span → Range hit, distance 0', () => {
    const { kind, buf } = setup([
      [10, 15, 8, 12],
      [14, 16, 11, 12],
    ]);
    const hit = kind.hitTest(buf, 64 as Coordinate, 188 as Coordinate); // inside [185,192]
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBe(0);
  });

  test('cursor just above the high within tolerance → distance to top edge', () => {
    const { kind, buf } = setup([[10, 15, 8, 12]]);
    // highY 185 is the top of the span; probe 2px above it.
    const hit = kind.hitTest(buf, 64 as Coordinate, 183 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBeCloseTo(2);
  });

  test('cursor far below the low (beyond tolerance) → null', () => {
    const { kind, buf } = setup([[10, 15, 8, 12]]); // lowY 192
    expect(kind.hitTest(buf, 64 as Coordinate, 210 as Coordinate)).toBeNull();
  });
});

// --- contract -----------------------------------------------------------------

describe('candlestick kind — contract', () => {
  test('extendedRange is false (a candle is self-contained, no ±1 neighbour)', () => {
    expect(createCandlestickKind({}).extendedRange).toBe(false);
  });

  test('createBuffer uses the OHLC stride-4 extra lane', () => {
    expect(createCandlestickKind({}).createBuffer().laneStride).toBe(4);
  });

  test('decimate (sub-pixel spacing) writes a bitmap rects and leaves the buffer unread', () => {
    const kind = createCandlestickKind({});
    const b = new DisplayListBuilder();
    // barSpacing·hr = 0.1·2 = 0.2 < 1 → decimation active.
    kind.decimate(fakeStore([[10, 11, 9, 10]]), itemWindow(0, 1), frame(2, 2), horz(0.1), fakePrice(), b);
    const lists = b.finish();
    expect(lists[0]!.space).toBe('bitmap');
    expect(lists[0]!.commands[0]!.kind).toBe('rects');
  });
});
