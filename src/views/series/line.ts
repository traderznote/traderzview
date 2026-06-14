// views/series/line.ts — the Line SeriesKind (study 06 §4.4–§4.5; design 03 §8.5.1).
// One of the six built-in kinds plugged into the generic series engine (kind.ts).
// laneStride 0: x/y lanes hold media-px centre X / media-px Y (y===NaN = gap); the
// per-item payload carries only the resolved stroke colour (study 06 §4.3).
// extendedRange true so an edge-crossing segment stays connected (study 10 §4.11).
//
// emit produces ONE bitmap polyline (coords x·hr,y·vr UNROUNDED, AA-smooth) via the
// shared walkLine + optional marker circles (line-base.ts). hitTest mirrors emit via
// the shared hitTestLine scaffold over the converted buffer (MEDIA px); convert
// captures hr/vr/barSpacing/from/to so the curve flatten equals emit's. decimate
// delegates to the shared column helper (decimate.ts) — buffer unread at sub-pixel.
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import { resolveBarColors } from '../../model';
import { LineStyle } from '../../gfx';
import type { DisplayListBuilder, HitCandidate, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';
import { decimateColumns } from './decimate';
import { LineType, walkLine, emitMarkers, hitTestLine } from './line-base';
import type { LineHitParams } from './line-base';

export { LineType };

/** The Line per-item payload view: the resolved stroke colour for style runs. */
export interface LineItem {
  readonly color: string;
}

/** Shared hit-test tolerance default (study 06 §4.12 / §4.17). */
const DEFAULT_HIT_TOLERANCE = 3;

export interface LineKindOptions {
  /** Stroke colour (study 06 default '#2196f3'). */
  readonly color: string;
  /** Stroke width in media px, 1–4 (default 3). */
  readonly lineWidth: number;
  /** Dash style (default Solid). */
  readonly lineStyle: LineStyle;
  /** Topology (default Simple). */
  readonly lineType: LineType;
  /** Whether the stroke is drawn (default true). */
  readonly lineVisible: boolean;
  /** Whether point markers are drawn (default false). */
  readonly pointMarkersVisible: boolean;
  /** Explicit marker radius; falsy → `lineWidth/2 + 2` (study 06 §4.5 falsy-OR). */
  readonly pointMarkersRadius?: number;
  /** Hit-test tolerance, media px (default 3). */
  readonly hitTestTolerance: number;
}

/** Merge user `SeriesOptions` with the Line defaults (study 06 §4.17). */
function resolveLineOptions(options: SeriesOptions): LineKindOptions {
  return {
    color: (options.color as string | undefined) ?? '#2196f3',
    lineWidth: (options.lineWidth as number | undefined) ?? 3,
    lineStyle: (options.lineStyle as LineStyle | undefined) ?? LineStyle.Solid,
    lineType: (options.lineType as LineType | undefined) ?? LineType.Simple,
    lineVisible: (options.lineVisible as boolean | undefined) ?? true,
    pointMarkersVisible: (options.pointMarkersVisible as boolean | undefined) ?? false,
    pointMarkersRadius: options.pointMarkersRadius as number | undefined,
    hitTestTolerance: (options.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

/** Point-marker radius resolved by the reference's falsy-OR (study 06 §4.5): present
 *  only when markers are visible; an explicit 0 falls back to the default. */
function markerRadius(o: LineKindOptions): number | undefined {
  if (!o.pointMarkersVisible) return undefined;
  return o.pointMarkersRadius || o.lineWidth / 2 + 2;
}

/** The Line kind — also exposes `createBuffer()` (the engine / tests build the
 *  buffer whose `item(i)` factory reads this kind's parallel colour array). */
export interface LineKind extends SeriesKindShape {
  /** Build a fresh `ItemBuffer<LineItem>` wired to this kind's colour array. */
  createBuffer(): ItemBuffer<LineItem>;
}

// Local alias of the SeriesKind contract specialised to LineItem. (The shared
// `SeriesKind<Item>` interface lives in kind.ts; we re-spell the members here only
// to add `createBuffer` without importing a value from kind.ts — it is type-only.)
interface SeriesKindShape {
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<LineItem>): void;
  convert(
    items: ItemBuffer<LineItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;
  emit(items: ItemBuffer<LineItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;
  hitTest(items: ItemBuffer<LineItem>, x: Coordinate, y: Coordinate): HitCandidate | null;
  readonly extendedRange: boolean;
}

/**
 * Build a Line `SeriesKind`. The kind is stateful: it owns the resolved colour
 * string per buffer slot (filled in `itemsFromStore`) and the last frame's
 * `hr`/`vr`/`barSpacing` (captured in `convert`, replayed by `hitTest` so the
 * Curved flatten is identical to what `emit` drew).
 */
export function createLineKind(options: SeriesOptions): LineKind {
  const o = resolveLineOptions(options);
  // Resolved stroke colour per buffer slot. row.color is not reachable through the
  // read-only PlotStoreView in this milestone, so every row resolves to the option
  // colour via the shared colorer (study 06 §4.3 line branch).
  const colors: string[] = [];
  // Last-convert frame geometry + window, replayed by hitTest so its geometry is
  // identical to what emit drew (same converted slice, same curve flatten).
  let lastHr = 1;
  let lastVr = 1;
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;

  // Raw close value per buffer slot (single-value line stores only the converted y
  // on the buffer; we cache the value so convert maps it through PriceConverter
  // without re-reading the store).
  const values: number[] = [];
  const colorAt = (i: number): string => colors[i] ?? o.color;

  const factory = (_buf: ItemBuffer<LineItem>, i: number): LineItem => ({ color: colorAt(i) });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<LineItem>): void {
    // Normal path: rebuild the item list from the store. (The ±1 windowing and the
    // diff-kind fast paths are the engine's concern.) Per-point row.color is not
    // reachable through the read-only PlotStoreView in this milestone, so every row
    // resolves to the option colour via the shared colorer (study 06 §4.3).
    const n = store.length;
    items.ensure(n);
    items.length = n;
    if (colors.length < n) colors.length = n;
    if (values.length < n) values.length = n;
    const ti = items.timeIndex;
    for (let i = 0; i < n; i++) {
      ti[i] = store.timeIndex(i) as number;
      const value = store.current(i);
      values[i] = value;
      // Line: barColor = lineColor = row.color ?? options.color (study 06 §4.3).
      colors[i] = resolveBarColors('line', { open: 0, close: value }, {}, options).barColor;
    }
  }

  function convert(
    items: ItemBuffer<LineItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void {
    lastHr = frame.frame.hr;
    lastVr = frame.frame.vr;
    lastBarSpacing = horz.barSpacing;
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    lastFrom = from;
    lastTo = to;
    const x = items.x;
    const y = items.y;
    const ti = items.timeIndex;
    // Points-array fast path (study 04 §4.4): two tight loops, NaN price → NaN y.
    for (let i = from; i < to; i++) {
      x[i] = horz.indexToCoordinate(ti[i]!);
    }
    for (let i = from; i < to; i++) {
      y[i] = price.priceToCoordinate(values[i] ?? Number.NaN); // NaN propagates as a gap
    }
  }

  function emit(items: ItemBuffer<LineItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    if (!o.lineVisible && markerRadius(o) === undefined) return;
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const hr = frame.frame.hr;
    const vr = frame.frame.vr;

    out.beginList('bitmap');
    if (o.lineVisible) {
      const poly = out.polyline(o.lineWidth * vr, o.lineStyle, 'round');
      walkLine(items.x, items.y, colorAt, from, to, hr, vr, lastBarSpacing, o.lineType,
        (x, y, fill) => poly.vertex(x, y, fill), () => poly.gap());
    }
    const r = markerRadius(o);
    if (r !== undefined) emitMarkers(out.circles(), items.x, items.y, colorAt, from, to, hr, vr, r);
  }

  function decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void {
    out.beginList('bitmap');
    decimateColumns(store, window, frame, horz, price, out, {
      shape: 'line',
      color: o.color,
      lineWidth: o.lineWidth * frame.frame.vr,
    });
  }

  function hitTest(items: ItemBuffer<LineItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    // Operate over the SAME converted slice emit drew (the last-convert window). The
    // buffer's x/y are only valid in [lastFrom, lastTo); outside it they are stale.
    const to = lastTo > items.length ? items.length : lastTo;
    const params: LineHitParams = {
      type: o.lineType,
      lineHalf: o.lineVisible ? o.lineWidth / 2 : 0.5, // line treated as width 1 when hidden
      markerRadius: markerRadius(o),
      tolerance: o.hitTestTolerance,
      barSpacing: lastBarSpacing,
      hr: lastHr,
      vr: lastVr,
    };
    return hitTestLine(items.x, items.y, lastFrom, to, x as number, y as number, params);
  }

  function createBuffer(): ItemBuffer<LineItem> {
    return new ReusableItemBuffer<LineItem>(0, factory);
  }

  if (__DEV__) {
    assert(o.lineWidth >= 1 && o.lineWidth <= 4, 'line lineWidth must be 1–4 (study 06 §4.5)');
  }

  return {
    itemsFromStore,
    convert,
    emit,
    decimate,
    hitTest,
    extendedRange: true,
    createBuffer,
  };
}
