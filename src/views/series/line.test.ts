import { describe, expect, test } from 'vitest';
import { createLineKind, LineType } from './line';
import type { LineItem } from './line';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder, LineStyle, HitPriority } from '../../gfx';
import type { CirclesCommand, PolylineCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { Coordinate, TimeIndex } from '../../core';

// --- fakes --------------------------------------------------------------------

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

/** indexToCoordinate(ix) = 99 − (3.5 − ix)·10  for baseIndex 3 / barSpacing 10 / w 100:
 *   ix 0→64, 1→74, 2→84, 3→94 (media px centres). */
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

/** Build a converted buffer for `values` over the full window. Returns the buffer
 *  + the kind so emit/hitTest can be driven against the SAME converted slice. */
function setup(values: number[], opts: SeriesOptions = {}, h = horz()) {
  const kind = createLineKind(opts);
  const buf = kind.createBuffer();
  const store = fakeStore(values);
  kind.itemsFromStore(store, REPLACE, buf);
  kind.convert(buf, itemWindow(0, values.length), frame(), h, fakePrice());
  return { kind, buf, store };
}

/** Drive emit and return the first (polyline) command. */
function emitPolyline(kind: ReturnType<typeof createLineKind>, buf: ItemBuffer<LineItem>): PolylineCommand {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  const lists = b.finish();
  expect(lists[0]!.space).toBe('bitmap');
  return lists[0]!.commands[0] as PolylineCommand;
}

// --- the golden Simple emit (numbers, no backend) -----------------------------

describe('line.emit — Simple (study 06 §4.5 / design 03 §8.5.1)', () => {
  test('one bitmap polyline; coords = x·hr,y·vr UNROUNDED; width = lineWidth·vr; one colour run', () => {
    const { kind, buf } = setup([10, 12, 11, 14]); // default color/lineWidth 3
    const cmd = emitPolyline(kind, buf);

    expect(cmd.kind).toBe('polyline');
    expect(cmd.join).toBe('round'); // study 06 §4.5 lineJoin round, lineCap butt (seam-fixed)
    expect(cmd.style).toBe(LineStyle.Solid);
    expect(cmd.width).toBe(3 * 2); // lineWidth 3 · vr 2

    // 4 vertices · 2 floats. Centres: x 64/74/84/94 ·hr2 ; y (200−v) ·vr2.
    expect(Array.from(cmd.points)).toEqual([
      128, 380, // (64·2, (200−10)·2)
      148, 376, // (74·2, (200−12)·2)
      168, 378, // (84·2, (200−11)·2)
      188, 372, // (94·2, (200−14)·2)
    ]);

    // single colour → single run spanning all 4 vertices; Σcount === vertex count.
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(4);
    expect(cmd.runs[0]!.fill).toBe('#2196f3');
  });

  test('honours an explicit colour and dash style', () => {
    const { kind, buf } = setup([5, 6], { color: '#ff0000', lineStyle: LineStyle.Dashed, lineWidth: 2 });
    const cmd = emitPolyline(kind, buf);
    expect(cmd.style).toBe(LineStyle.Dashed);
    expect(cmd.width).toBe(2 * 2);
    expect(cmd.runs[0]!.fill).toBe('#ff0000');
  });

  test('NaN value → pen-up gap (NaN,NaN) vertex pair, folded into the run count', () => {
    const { kind, buf } = setup([10, NaN, 12]);
    const cmd = emitPolyline(kind, buf);
    // anchor (64·2,190·2) ; gap ; anchor (84·2,188·2)
    expect(cmd.points.length).toBe(6); // 3 vertex slots
    expect(cmd.points[0]).toBe(128);
    expect(Number.isNaN(cmd.points[2]!)).toBe(true); // gap x
    expect(Number.isNaN(cmd.points[3]!)).toBe(true); // gap y
    expect(cmd.points[4]).toBe(168);
    // Σ run counts === total vertex slots (incl. the gap), builder dev-assert holds.
    const sum = cmd.runs.reduce((s, r) => s + r.count, 0);
    expect(sum).toBe(3);
  });

  test('single visible point → horizontal stub of one bar width, centred (study 06 §4.4)', () => {
    const { kind, buf } = setup([10]); // 1 point at index 0, barSpacing 10, x centre 64, y 190
    const cmd = emitPolyline(kind, buf);
    expect(cmd.points.length).toBe(4); // two vertices
    // half = (barSpacing/2)·hr = 5·2 = 10 ; centre x = 64·2 = 128 ; y = 190·2 = 380
    expect(Array.from(cmd.points)).toEqual([118, 380, 138, 380]);
  });
});

describe('line.emit — WithSteps (riser vertex carries the NEW run colour, design 03 §8.5.1)', () => {
  test('inserts the (curX, prevY) intermediate step vertex before (curX, curY)', () => {
    const { kind, buf } = setup([10, 14], { lineType: LineType.WithSteps });
    const cmd = emitPolyline(kind, buf);
    // anchor (64·2, 190·2) ; riser-corner (74·2, 190·2) ; (74·2, 186·2)
    expect(Array.from(cmd.points)).toEqual([
      128, 380, // anchor at item 0 (x64,y190)
      148, 380, // step corner: curX(74·2) at prevY(190·2) — horizontal first
      148, 372, // then vertical to curY: (74·2, 186·2)
    ]);
    // 3 vertices, one colour → one run of 3.
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(3);
  });
});

describe('line.emit — Curved (Catmull-Rom flatten, clamp(ceil(chordPx/2),4,24))', () => {
  test('each segment flattens to the clamped count; endpoints land on the data points', () => {
    // 4 points so interior segments have real neighbours. chord(item0→1) in device px:
    // dx = (74−64)·hr2 = 20, dy = (190−188... )·vr2 — small ; chordPx ≈ 20 → segs = ceil(20/2)=10.
    const { kind, buf } = setup([10, 12, 11, 14], { lineType: LineType.Curved });
    const cmd = emitPolyline(kind, buf);

    // first vertex is the anchor at item 0 (device px).
    expect(cmd.points[0]).toBeCloseTo(128);
    expect(cmd.points[1]).toBeCloseTo(380);

    // segment 0 (item0→item1): chordPx = hypot((74−64)·2, (188−190)·2) = hypot(20,4) ≈ 20.396
    //   → segs = ceil(20.396/2) = 11 ; it contributes (segs−1)=10 intermediate verts + 1 endpoint.
    const chord01 = Math.hypot((74 - 64) * 2, (188 - 190) * 2);
    const segs01 = Math.min(24, Math.max(4, Math.ceil(chord01 / 2)));
    // the (segs01)-th flatten vertex of segment 0 must equal item1's device coord (74·2,188·2).
    const endIdx = (1 + segs01) * 2; // anchor (1 vert) + segs01 verts → index of the (segs01)th
    expect(cmd.points[endIdx - 2]).toBeCloseTo(148); // x of item1
    expect(cmd.points[endIdx - 1]).toBeCloseTo(376); // y of item1

    // every flatten vertex of a segment carries one run colour (uniform here → 1 run).
    expect(cmd.runs).toHaveLength(1);
  });

  test('flatten vertex count obeys the [4,24] clamp at extreme chord lengths', () => {
    // tiny chord (almost coincident points) clamps UP to 4 segments → 4 verts per seg.
    const { kind, buf } = setup([10, 10], { lineType: LineType.Curved }, horz(0.2));
    const cmd = emitPolyline(kind, buf);
    // anchor + 4 flatten verts (segs clamped to 4) = 5 vertices = 10 floats.
    expect(cmd.points.length).toBe(10);
  });
});

describe('line.emit — point markers (study 06 §4.5)', () => {
  test('emits a circles command, back-to-front, radius falls back to lineWidth/2+2', () => {
    const b = new DisplayListBuilder();
    const kind = createLineKind({ pointMarkersVisible: true, lineWidth: 4 });
    const buf = kind.createBuffer();
    kind.itemsFromStore(fakeStore([10, 12]), REPLACE, buf);
    kind.convert(buf, itemWindow(0, 2), frame(), horz(), fakePrice());
    kind.emit(buf, itemWindow(0, 2), frame(), b);
    const cmds = b.finish()[0]!.commands;
    const circ = cmds.find((c) => c.kind === 'circles') as CirclesCommand;
    expect(circ).toBeDefined();
    // 2 markers · 3 floats (x,y,r). radius = (4/2+2)·vr + correction. tickWidth=floor(2)=2 → corr 0.
    expect(circ.coords.length).toBe(6);
    const r = (4 / 2 + 2) * 2; // 8
    // back-to-front: first emitted circle is the LAST item (x 74·2=148, +corr 0).
    expect(circ.coords[0]).toBeCloseTo(148);
    expect(circ.coords[2]).toBeCloseTo(r);
  });
});

// --- hitTest consistency with the drawn geometry ------------------------------

describe('line.hitTest — geometry equals emit (study 06 §4.12)', () => {
  test('cursor on a Simple segment → Line hit with the true point-segment distance', () => {
    const { kind, buf } = setup([10, 12]); // media centres: (64,190)-(74,188)
    // a point 3px (media) directly above the segment midpoint (69,189).
    const hit = kind.hitTest(buf, 69 as Coordinate, (189 - 3) as Coordinate) as ReturnType<typeof kind.hitTest>;
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Line);
    // distance ≈ 3 (perpendicular ~), well within radius = lineWidth/2(1.5)+tol(3) = 4.5.
    expect(hit!.distance).toBeLessThanOrEqual(4.5);
  });

  test('cursor far from the line → null', () => {
    const { kind, buf } = setup([10, 12]);
    expect(kind.hitTest(buf, 69 as Coordinate, 100 as Coordinate)).toBeNull();
  });

  test('cursor on a point marker → Point hit (Point overrides Line)', () => {
    const kind = createLineKind({ pointMarkersVisible: true, lineWidth: 3 });
    const buf = kind.createBuffer();
    kind.itemsFromStore(fakeStore([10, 12]), REPLACE, buf);
    kind.convert(buf, itemWindow(0, 2), frame(), horz(), fakePrice());
    // right on top of item 0's centre (media 64,190).
    const hit = kind.hitTest(buf, 64 as Coordinate, 190 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Point);
    expect(hit!.distance).toBeCloseTo(0);
  });

  test('single point stub is hittable across its bar-width span (Point priority)', () => {
    const { kind, buf } = setup([10]); // centre media (64,190), barSpacing 10 → span ±5 (or ±radius)
    const hit = kind.hitTest(buf, 61 as Coordinate, 190 as Coordinate); // 3px off-centre, inside [59,69]
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Point);
  });

  test('Curved hit uses the SAME flattened polyline emit drew', () => {
    const { kind, buf } = setup([10, 12, 11, 14], { lineType: LineType.Curved });
    // sample the flattened geometry the same way emit does, then probe a point on it.
    const cmd = emitPolyline(kind, buf);
    // pick a mid flatten vertex (device px) and convert back to media (÷hr,÷vr).
    const mx = cmd.points[4]! / 2;
    const my = cmd.points[5]! / 2;
    const hit = kind.hitTest(buf, mx as Coordinate, my as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Line);
    expect(hit!.distance).toBeLessThan(1); // the probe sits ON a drawn vertex
  });
});

describe('line kind — contract', () => {
  test('extendedRange is true (line-likes need the ±1 off-screen segment, study 10 §4.11)', () => {
    expect(createLineKind({}).extendedRange).toBe(true);
  });

  test('lineVisible:false with no markers emits nothing', () => {
    const b = new DisplayListBuilder();
    const kind = createLineKind({ lineVisible: false });
    const buf = kind.createBuffer();
    kind.itemsFromStore(fakeStore([10, 12]), REPLACE, buf);
    kind.convert(buf, itemWindow(0, 2), frame(), horz(), fakePrice());
    kind.emit(buf, itemWindow(0, 2), frame(), b);
    expect(b.finish()).toHaveLength(0);
  });

  test('decimate (sub-pixel spacing) writes a bitmap polyline and leaves the buffer unread', () => {
    const kind = createLineKind({});
    const b = new DisplayListBuilder();
    // barSpacing·hr = 0.1·2 = 0.2 < 1 → decimation active.
    kind.decimate(fakeStore([10, 11, 12]), itemWindow(0, 3), frame(2, 2), horz(0.1), fakePrice(), b);
    const lists = b.finish();
    expect(lists[0]!.space).toBe('bitmap');
    expect(lists[0]!.commands[0]!.kind).toBe('polyline');
  });
});
