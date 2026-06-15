// area.parity.test.ts — the M11 FINAL emission-parity pass for the Area kind
// (study 06 §4.6 / design 03 §8.5.2). These goldens lock the recipe details that
// the M7 emission test left implicit and that the full-stack parity pass closes:
//   1. the fill GRADIENT bottom coordinate is ALWAYS the pane height, independent of
//      `invertFilledArea` / `baseLevelCoordinate` (§4.6: the gradient spans
//      `topCoordinate → bitmapHeight`; only the polygon CLOSE uses baseY). An inverted
//      area must NOT collapse the gradient to a degenerate [topY, 0] span.
//   2. the guarded final flush — a per-point colour change landing on the LAST visible
//      item never emits a degenerate single-vertex `area` (study 06 §4.4 final-flush
//      guard, expressed as the lazy `area` writer).
//   3. a per-point colour change immediately AFTER a NaN gap drops the pending share
//      (no continuation), so the post-gap run opens fresh at the new colour.
import { describe, expect, test } from 'vitest';
import { createAreaKind } from './area';
import type { AreaItem, AreaPointColors } from './area';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder } from '../../gfx';
import type { AreaCommand, LinearGradientY, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { TimeIndex } from '../../core';

// --- fakes (identical math to area.test.ts) -----------------------------------

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

/** indexToCoordinate: ix 0→64, 1→74, 2→84, 3→94 (media px centres, barSpacing 10). */
function horz(barSpacing = 10): HorzGeometry {
  return createHorzGeometry({ width: 100, barSpacing, rightOffset: 0, baseIndex: 3 });
}

/** priceToCoordinate(price) = 200 − price. NaN → NaN. */
function fakePrice(): PriceConverter {
  return { priceToCoordinate: (p) => 200 - p, firstValue: null, mode: 'normal', toLogical: (p) => p };
}

function frame(hr = 2, vr = 2): ViewFrame {
  return {
    frame: { mediaSize: { width: 100, height: 100 }, bitmapSize: { width: 100 * hr, height: 100 * vr }, hr, vr },
    now: 0,
  };
}

const REPLACE: StoreDiff = { kind: 'replace' };

function setup(values: number[], opts: Parameters<typeof createAreaKind>[0] = {}, h = horz()) {
  const { kind, buffer } = createAreaKind(opts);
  kind.itemsFromStore(fakeStore(values), REPLACE, buffer);
  kind.convert(buffer, itemWindow(0, values.length), frame(), h, fakePrice());
  return { kind, buf: buffer };
}

function emitLists(kind: ReturnType<typeof createAreaKind>['kind'], buf: ItemBuffer<AreaItem>) {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  return b.finish();
}

const grad = (a: AreaCommand): LinearGradientY => a.fill as LinearGradientY;

// --- 1. gradient bottom is pane height regardless of invert / base ------------

describe('area.emit — fill gradient spans topCoordinate → paneHeight, NOT baseY (study 06 §4.6)', () => {
  test('non-inverted: polygon baseY === paneHeight === gradient.to (they coincide here)', () => {
    const { kind, buf } = setup([10, 12]); // pane height 100, not inverted → baseY 100
    const area = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    expect(area.baseY).toBe(100);
    const g = grad(area);
    expect(g.from).toBe(0); // topCoordinate
    expect(g.to).toBe(100); // paneHeight
  });

  test('INVERTED: polygon closes UP to 0, but the gradient STILL spans 0 → paneHeight', () => {
    // The M7 emission used baseY as the gradient bottom, which for an inverted area
    // (baseY 0) collapsed the gradient to a degenerate [0, 0] span. The parity fix
    // keeps the gradient bottom at the pane height (study 06 §4.6).
    const { kind, buf } = setup([10, 12], { invertFilledArea: true });
    const area = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    expect(area.baseY).toBe(0); // polygon closes to the top edge
    const g = grad(area);
    expect(g.from).toBe(0); // topCoordinate
    expect(g.to).toBe(100); // STILL paneHeight, NOT baseY (0)
    expect(g.from).not.toBe(g.to); // never degenerate
  });

  test('INVERTED single point: same — stub closes to 0, gradient to paneHeight', () => {
    const { kind, buf } = setup([10], { invertFilledArea: true });
    const area = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    expect(area.baseY).toBe(0);
    expect(grad(area).to).toBe(100);
  });

  test('relativeGradient + inverted: top = min visible y, bottom STILL paneHeight', () => {
    // values 10,14 → y 190,186 → min y (top) 186. Gradient from 186 to 100? No — the
    // bottom is fixed at the pane height 100. (top can sit BELOW bottom for an inverted
    // chart; the gradient direction is the renderer's concern — we only assert the
    // coordinates the recipe produces.)
    const { kind, buf } = setup([10, 14], { invertFilledArea: true, relativeGradient: true });
    const g = grad(emitLists(kind, buf)[0]!.commands[0] as AreaCommand);
    expect(g.from).toBe(186); // highest visible point's y
    expect(g.to).toBe(100); // paneHeight, NOT baseY (0)
  });

  test('inverted does not change the per-point split gradient bottoms', () => {
    const pointColors = (i: number): AreaPointColors | undefined => (i === 1 ? { topColor: '#abcdef' } : undefined);
    const { kind, buf } = setup([10, 12, 11], { pointColors, invertFilledArea: true });
    const fill = emitLists(kind, buf)[0]!.commands as AreaCommand[];
    expect(fill).toHaveLength(2);
    expect(grad(fill[0]!).to).toBe(100); // both split commands keep the pane-height bottom
    expect(grad(fill[1]!).to).toBe(100);
    expect(fill[0]!.baseY).toBe(0); // both close UP to 0
    expect(fill[1]!.baseY).toBe(0);
  });
});

// --- 2. guarded final flush (study 06 §4.4) -----------------------------------

describe('area.emit — guarded final flush (no degenerate single-vertex area, study 06 §4.4)', () => {
  test('a topColor change on the LAST item closes the prior run and emits NO 1-vertex area', () => {
    // index 0,1 default; index 2 (the LAST) overrides topColor. The change closes run A
    // AT vertex 2 and defers vertex 2 as the next run's anchor — but there is no further
    // item, so the deferred single boundary vertex must be DROPPED (the reference's
    // guarded flush: an unconditional final flush would emit a degenerate area).
    const pointColors = (i: number): AreaPointColors | undefined => (i === 2 ? { topColor: '#abcdef' } : undefined);
    const { kind, buf } = setup([10, 12, 11], { pointColors });
    const fill = emitLists(kind, buf)[0]!.commands as AreaCommand[];

    // EXACTLY one area command: run A = [v0, v1, v2-as-close]. No second 1-vertex area.
    expect(fill).toHaveLength(1);
    // v0,v1 plus the closing v2 (the boundary vertex re-emitted to terminate the run).
    expect(Array.from(fill[0]!.points)).toEqual([64, 190, 74, 188, 84, 189]);
    // run A keeps the DEFAULT top stop (the change leaves nothing visible after it).
    expect(grad(fill[0]!).stops[0]!.color).toBe('rgba( 46, 220, 135, 0.4)');
  });

  test('a colour change one item before the last still splits into two real areas', () => {
    // sanity: change at index 1 of a 3-item series → run A [v0,v1], run B [v1,v2] (both
    // have ≥2 vertices, neither degenerate). Distinguishes the guard from a blanket drop.
    const pointColors = (i: number): AreaPointColors | undefined => (i === 1 ? { topColor: '#abcdef' } : undefined);
    const { kind, buf } = setup([10, 12, 11], { pointColors });
    const fill = emitLists(kind, buf)[0]!.commands as AreaCommand[];
    expect(fill).toHaveLength(2);
    expect(fill[0]!.points.length).toBe(4); // v0, v1
    expect(fill[1]!.points.length).toBe(4); // shared v1, v2
  });
});

// --- 3. colour change immediately after a gap --------------------------------

describe('area.emit — NaN gap drops a pending colour-boundary share (no continuation)', () => {
  test('NaN at index 1 then a topColor change at index 2 opens a fresh run at v2', () => {
    // index 0 default; index 1 NaN (gap); index 2 overrides topColor. The gap closes
    // any open run; the post-gap run must open FRESH at v2 with the override colour —
    // there is no boundary vertex to share across the gap.
    const pointColors = (i: number): AreaPointColors | undefined => (i === 2 ? { topColor: '#abcdef' } : undefined);
    const { kind, buf } = setup([10, NaN, 11], { pointColors });
    const fill = emitLists(kind, buf)[0]!.commands as AreaCommand[];

    // run A = the lone v0 — but a single finite point before a gap is itself a 1-vertex
    // run. The lazy writer opened it for v0; the gap then nulls the writer WITHOUT a
    // share. So run A holds only v0 (default colour) and run B holds only v2 (override).
    expect(fill).toHaveLength(2);
    expect(Array.from(fill[0]!.points)).toEqual([64, 190]); // v0 only (gap terminated it)
    expect(grad(fill[0]!).stops[0]!.color).toBe('rgba( 46, 220, 135, 0.4)'); // default
    expect(Array.from(fill[1]!.points)).toEqual([84, 189]); // v2 only, no shared boundary
    expect(grad(fill[1]!).stops[0]!.color).toBe('#abcdef'); // override (fresh open)
  });
});
