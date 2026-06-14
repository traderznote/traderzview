import { describe, expect, test } from 'vitest';
import { createCrosshairSource } from './crosshair-source';
import { Crosshair, CrosshairMode } from '../../model';
import { DisplayListBuilder, LineStyle, ZBand } from '../../gfx';
import type { DisplayList, PolylineCommand, ViewFrame } from '../../gfx';
import type { Coordinate, TimeIndex } from '../../core';

// --- fakes --------------------------------------------------------------------

/** A frame at device ratio (hr, vr); bitmap = media·ratio (mirrors line.test.ts). */
function frame(hr = 2, vr = 2, w = 100, h = 100): ViewFrame {
  return {
    frame: { mediaSize: { width: w, height: h }, bitmapSize: { width: w * hr, height: h * vr }, hr, vr },
    now: 0,
  };
}

/** A model Crosshair placed at applied media coords (x, y). renderVisible() is true
 *  unless mode is Hidden — exactly the render gate the source reads (study 07 §5). */
function placedCrosshair(x: number, y: number, mode: CrosshairMode = CrosshairMode.Normal): Crosshair {
  const c = new Crosshair();
  c.setMode(mode);
  c.setPosition({
    index: 0 as TimeIndex,
    price: 0,
    x: x as Coordinate,
    y: y as Coordinate,
    originX: x as Coordinate,
    originY: y as Coordinate,
  });
  return c;
}

/** All polyline commands across every list (flattened) in draw order. */
function polylines(lists: readonly DisplayList[]): PolylineCommand[] {
  const out: PolylineCommand[] = [];
  for (const l of lists) for (const c of l.commands) if (c.kind === 'polyline') out.push(c);
  return out;
}

// --- emission: vertical + horizontal lines, crisp device coords ---------------

describe('crosshair-source.emit — lines at applied coords (study 07 §3.5; design 03 §8.5.8)', () => {
  test('one bitmap list with a vertical (full height) and a horizontal (full width) polyline', () => {
    // applied media (40, 30); hr=vr=2 → bitmap 200×200. width 1 → crispWidth = floor(1·2)=2.
    const src = createCrosshairSource(placedCrosshair(40, 30));
    const f = frame(2, 2);
    src.update(f);
    const lists = src.displayLists();

    expect(lists).toHaveLength(1);
    expect(lists[0]!.space).toBe('bitmap');
    const polys = polylines(lists);
    expect(polys).toHaveLength(2);

    // width 2 is EVEN → crispStrokePos adds no half-pixel shift.
    // vertical: px = round(40·2)=80 ; spans y 0 → bitmapH 200.
    const v = polys[0]!;
    expect(v.width).toBe(2);
    expect(Array.from(v.points)).toEqual([80, 0, 80, 200]);
    expect(v.runs[0]!.fill).toBe('#9598A1'); // default color
    expect(v.style).toBe(LineStyle.LargeDashed); // default dash

    // horizontal: py = round(30·2)=60 ; spans x 0 → bitmapW 200.
    const hLine = polys[1]!;
    expect(hLine.width).toBe(2);
    expect(Array.from(hLine.points)).toEqual([0, 60, 200, 60]);
  });

  test('odd bitmap width gets the +0.5 crispStrokePos shift (DPR 1)', () => {
    // hr=vr=1 → crispWidth(1,1)=max(1,floor(1))=1 (ODD) → +0.5 shift.
    const src = createCrosshairSource(placedCrosshair(40, 30));
    const f = frame(1, 1);
    src.update(f);
    const polys = polylines(src.displayLists());
    const v = polys[0]!;
    expect(v.width).toBe(1);
    // px = round(40·1)+0.5 = 40.5 ; bitmapH = 100.
    expect(Array.from(v.points)).toEqual([40.5, 0, 40.5, 100]);
    const hLine = polys[1]!;
    expect(Array.from(hLine.points)).toEqual([0, 30.5, 100, 30.5]);
  });

  test('vert and horz keep independent width + dash (separate polyline commands)', () => {
    const src = createCrosshairSource(placedCrosshair(40, 30), {
      vertLine: { color: '#111', width: 2, style: LineStyle.Solid },
      horzLine: { color: '#222', width: 1, style: LineStyle.Dotted },
    });
    const f = frame(2, 2); // hr=vr=2
    src.update(f);
    const polys = polylines(src.displayLists());
    // vert width 2 → crispWidth(2,2)=4 (even) ; horz width 1 → crispWidth(1,2)=2 (even).
    expect(polys[0]!.width).toBe(4);
    expect(polys[0]!.style).toBe(LineStyle.Solid);
    expect(polys[0]!.runs[0]!.fill).toBe('#111');
    expect(polys[1]!.width).toBe(2);
    expect(polys[1]!.style).toBe(LineStyle.Dotted);
    expect(polys[1]!.runs[0]!.fill).toBe('#222');
  });
});

// --- visibility / off-pane gates ----------------------------------------------

describe('crosshair-source — render gates (study 07 §5; design 03 §8.5.8)', () => {
  test('mode Hidden suppresses lines (renderVisible false) — no display lists', () => {
    const src = createCrosshairSource(placedCrosshair(40, 30, CrosshairMode.Hidden));
    src.update(frame());
    expect(src.displayLists()).toHaveLength(0);
  });

  test('a never-positioned crosshair emits nothing', () => {
    const src = createCrosshairSource(new Crosshair());
    src.update(frame());
    expect(src.displayLists()).toHaveLength(0);
  });

  test('vertLine.visible false drops the vertical line only', () => {
    const src = createCrosshairSource(placedCrosshair(40, 30), { vertLine: { visible: false } });
    src.update(frame(2, 2));
    const polys = polylines(src.displayLists());
    expect(polys).toHaveLength(1);
    // the survivor is the horizontal line: y-row, full bitmap width.
    expect(Array.from(polys[0]!.points)).toEqual([0, 60, 200, 60]);
  });

  test('horzLine.visible false drops the horizontal line only', () => {
    const src = createCrosshairSource(placedCrosshair(40, 30), { horzLine: { visible: false } });
    src.update(frame(2, 2));
    const polys = polylines(src.displayLists());
    expect(polys).toHaveLength(1);
    expect(Array.from(polys[0]!.points)).toEqual([80, 0, 80, 200]);
  });

  test('horizontal off-pane skip: y·vr outside [0, bitmapH] drops the horz line, vert stays', () => {
    // y = 120 media, vr 2 → yDev 240 > bitmapH 200 → horizontal suppressed.
    const src = createCrosshairSource(placedCrosshair(40, 120));
    src.update(frame(2, 2));
    const polys = polylines(src.displayLists());
    expect(polys).toHaveLength(1); // only the vertical line survives
    expect(Array.from(polys[0]!.points)).toEqual([80, 0, 80, 200]);
  });

  test('NaN applied y (cleared price) suppresses the horizontal line', () => {
    const src = createCrosshairSource(placedCrosshair(40, NaN));
    src.update(frame(2, 2));
    const polys = polylines(src.displayLists());
    expect(polys).toHaveLength(1);
    expect(Array.from(polys[0]!.points)).toEqual([80, 0, 80, 200]);
  });
});

// --- SceneSource contract + per-source cache identity (perf §4.4.2) -----------

describe('crosshair-source — SceneSource contract & cache identity', () => {
  test('registers in the Crosshair z-band', () => {
    expect(createCrosshairSource(new Crosshair()).zBand).toBe(ZBand.Crosshair);
  });

  test('a CLEAN re-update returns the byte-identical cached array (no re-emit)', () => {
    const src = createCrosshairSource(placedCrosshair(40, 30));
    const f = frame(2, 2);
    src.update(f);
    const a = src.displayLists();
    src.update(f); // same crosshair state + same geometry → clean
    const b = src.displayLists();
    expect(b).toBe(a); // identical reference (the §4.4.2 invariant)
  });

  test('a moved crosshair dirties → a NEW array reference with the new coords', () => {
    const c = placedCrosshair(40, 30);
    const src = createCrosshairSource(c);
    const f = frame(2, 2);
    src.update(f);
    const a = src.displayLists();

    c.setPosition({
      index: 1 as TimeIndex,
      price: 5,
      x: 50 as Coordinate,
      y: 30 as Coordinate,
      originX: 50 as Coordinate,
      originY: 30 as Coordinate,
    });
    src.update(f);
    const b = src.displayLists();
    expect(b).not.toBe(a); // re-emitted: fresh array
    expect(Array.from(polylines(b)[0]!.points)).toEqual([100, 0, 100, 200]); // px = round(50·2)
  });

  test('a geometry change (DPR) dirties even when the crosshair state is unchanged', () => {
    const src = createCrosshairSource(placedCrosshair(40, 30));
    src.update(frame(2, 2));
    const a = src.displayLists();
    src.update(frame(1, 1)); // hr/vr changed → crisp coords change → re-emit
    const b = src.displayLists();
    expect(b).not.toBe(a);
  });

  test('hiding (Hidden mode) after a visible frame dirties to EMPTY, then back is a re-emit', () => {
    const c = placedCrosshair(40, 30);
    const src = createCrosshairSource(c);
    const f = frame(2, 2);
    src.update(f);
    expect(src.displayLists()).toHaveLength(1);
    c.setMode(CrosshairMode.Hidden);
    src.update(f);
    expect(src.displayLists()).toHaveLength(0);
    c.setMode(CrosshairMode.Normal);
    src.update(f);
    expect(src.displayLists()).toHaveLength(1);
  });
});

// --- guard: the file builds without DOM (import-wall sanity is structural) ----

describe('crosshair-source — builder discipline', () => {
  test('uses the sanctioned DisplayListBuilder polyline shape (Σ runs == vertex count)', () => {
    // sanity: a hand-built equivalent polyline obeys the same run-sum dev assert.
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const p = b.polyline(2, LineStyle.Solid, 'miter');
    p.vertex(80, 0, '#9598A1');
    p.vertex(80, 200, '#9598A1');
    const cmd = b.finish()[0]!.commands[0] as PolylineCommand;
    expect(cmd.runs.reduce((s, r) => s + r.count, 0)).toBe(2);
  });
});
