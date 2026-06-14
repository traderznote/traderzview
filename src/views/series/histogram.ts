// views/series/histogram.ts — the Histogram SeriesKind (study 06 §4.11 column
// geometry / §4.12 range hit; design 03 §8.5.4 emission). laneStride 0: x holds
// media-px centre X, y holds media-px value Y (NaN = gap); the per-item payload
// carries only the resolved fill colour (study 06 §4.3). extendedRange false —
// columns are self-contained, no off-screen neighbour needed.
//
// emit is the §4.11 two-phase recipe: PHASE 1 builds a device-px COLUMN geometry
// cache (spacing/columnWidth, odd-even left-bias, ALIGNMENT/FIX/EQUALIZE passes),
// keyed on (visibleRange, barSpacing, hr) — recomputed when that key changes (design
// 03 §8.5.4). PHASE 2 paints one bitmap `rects`, fillStyle per item (no batching,
// matching the reference), straddling the crisp base tick so a zero column still
// shows. hitTest reuses bar-base hitTestColumns (span = min/max(itemY, baseY)).
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import { resolveBarColors } from '../../model';
import { crispRound } from '../../gfx';
import type { DisplayListBuilder, HitCandidate, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';
import { decimateColumns } from './decimate';
import { hitTestColumns } from './bar-base';

/** The Histogram per-item payload view: the resolved fill colour for style runs. */
export interface HistogramItem {
  readonly color: string;
}

/** Shared hit-test tolerance default (study 06 §4.12). */
const DEFAULT_HIT_TOLERANCE = 3;
/** §4.11 constant `alignToMinimalWidthLimit`: equalize only when minWidth < this. */
const ALIGN_TO_MINIMAL_WIDTH_LIMIT = 4;

export interface HistogramKindOptions {
  /** Column fill colour (study 06 §4.17 default '#26a69a'). */
  readonly color: string;
  /** Base price the columns rise from / fall to (study 06 §4.17 default 0). */
  readonly base: number;
  /** Hit-test tolerance, media px (default 3). */
  readonly hitTestTolerance: number;
}

/** Merge user `SeriesOptions` with the Histogram defaults (study 06 §4.17). */
function resolveHistogramOptions(options: SeriesOptions): HistogramKindOptions {
  return {
    color: (options.color as string | undefined) ?? '#26a69a',
    base: (options.base as number | undefined) ?? 0,
    hitTestTolerance: (options.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

/** The Histogram kind — also exposes `createBuffer()` (the engine / tests build the
 *  buffer whose `item(i)` factory reads this kind's parallel colour array). */
export interface HistogramKind extends SeriesKindShape {
  /** Build a fresh `ItemBuffer<HistogramItem>` wired to this kind's colour array. */
  createBuffer(): ItemBuffer<HistogramItem>;
}

// Local alias of the SeriesKind contract specialised to HistogramItem (mirrors
// line.ts — re-spelled here only to add `createBuffer` without a value import).
interface SeriesKindShape {
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<HistogramItem>): void;
  convert(
    items: ItemBuffer<HistogramItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;
  emit(items: ItemBuffer<HistogramItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;
  hitTest(items: ItemBuffer<HistogramItem>, x: Coordinate, y: Coordinate): HitCandidate | null;
  readonly extendedRange: boolean;
}

/** PHASE-1 column geometry cache (§4.11): device-px left/right edges per slot, the
 *  cache key, and a per-column "centre rounded rightwards" flag the passes consult. */
interface ColumnCache {
  // Cache key = (visibleRange, barSpacing, hr); recompute when any of these change.
  from: number;
  to: number;
  barSpacing: number;
  hr: number;
  left: Int32Array; // device-px left edge per slot
  right: Int32Array; // device-px right edge per slot (inclusive)
  roundedUp: Uint8Array; // 1 iff round(x·hr) > x·hr (centre biased right)
}

/**
 * Build a Histogram `SeriesKind`. The kind is stateful: it owns the resolved fill
 * colour per buffer slot (filled in `itemsFromStore`), the raw value per slot, the
 * last frame's window + barSpacing + base-Y (captured in `convert`, replayed by
 * `hitTest`), and the §4.11 column-geometry cache (built in `emit`).
 */
export function createHistogramKind(options: SeriesOptions): HistogramKind {
  const o = resolveHistogramOptions(options);
  // Resolved fill colour + raw value per buffer slot (the columnar form of the
  // reference's {time, price} item; convert maps value → media-px Y per frame).
  const colors: string[] = [];
  const values: number[] = [];
  // Last-convert window + bar spacing + base-Y, replayed by hitTest so its geometry
  // matches emit's (the column hit uses spacing + base level; hr/vr are not read).
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;
  let lastBaseY = 0; // media-px Y of the base level (price.priceToCoordinate(o.base))
  // §4.11 PHASE-1 cache — grown lazily, recomputed when the key changes.
  const cache: ColumnCache = {
    from: -1,
    to: -1,
    barSpacing: Number.NaN,
    hr: Number.NaN,
    left: new Int32Array(0),
    right: new Int32Array(0),
    roundedUp: new Uint8Array(0),
  };
  const colorAt = (i: number): string => colors[i] ?? o.color;
  const factory = (_buf: ItemBuffer<HistogramItem>, i: number): HistogramItem => ({ color: colorAt(i) });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<HistogramItem>): void {
    // Normal path: rebuild the item list from the store. Per-point row.color is not
    // reachable through the read-only PlotStoreView this milestone, so every row
    // resolves to the option colour via the shared colorer (study 06 §4.3 histogram).
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
      colors[i] = resolveBarColors('histogram', { open: 0, close: value }, {}, options).barColor;
    }
  }

  function convert(
    items: ItemBuffer<HistogramItem>,
    window: ItemWindow,
    _frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void {
    lastBarSpacing = horz.barSpacing;
    lastBaseY = price.priceToCoordinate(o.base);
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    lastFrom = from;
    lastTo = to;
    const x = items.x;
    const y = items.y;
    const ti = items.timeIndex;
    for (let i = from; i < to; i++) {
      x[i] = horz.indexToCoordinate(ti[i]!);
    }
    for (let i = from; i < to; i++) {
      y[i] = price.priceToCoordinate(values[i] ?? Number.NaN); // NaN propagates as a gap
    }
  }

  // PHASE 1 (§4.11): (re)build the device-px column geometry cache for [from,to)
  // when the key (visibleRange, barSpacing, hr) differs from the last build.
  function buildColumns(items: ItemBuffer<HistogramItem>, from: number, to: number, barSpacing: number, hr: number): void {
    if (cache.from === from && cache.to === to && cache.barSpacing === barSpacing && cache.hr === hr) return;
    if (cache.left.length < to) {
      cache.left = new Int32Array(to);
      cache.right = new Int32Array(to);
      cache.roundedUp = new Uint8Array(to);
    }
    cache.from = from;
    cache.to = to;
    cache.barSpacing = barSpacing;
    cache.hr = hr;
    const { left, right, roundedUp } = cache;
    const x = items.x;
    const ti = items.timeIndex;
    // spacing: 1px gap between columns unless ultra-dense (≤1 device px per slot).
    const spacing = Math.ceil(barSpacing * hr) <= 1 ? 0 : Math.max(1, Math.floor(hr));
    const columnWidth = Math.round(barSpacing * hr) - spacing;
    const odd = columnWidth % 2 !== 0;
    const half = odd ? (columnWidth - 1) / 2 : columnWidth / 2;
    for (let i = from; i < to; i++) {
      const exact = x[i]! * hr;
      const center = Math.round(exact);
      roundedUp[i] = center > exact ? 1 : 0; // remember rightward rounding for the passes
      left[i] = center - half;
      right[i] = odd ? center + half : center + half - 1; // even → bias one px left
    }
    // ALIGNMENT PASS: keep exactly spacing+1 between adjacent columns (ti differ by 1).
    for (let i = from + 1; i < to; i++) {
      if (ti[i] !== ti[i - 1]! + 1) continue;
      if (left[i]! - right[i - 1]! !== spacing + 1) {
        if (roundedUp[i - 1]) right[i - 1] = left[i]! - spacing - 1;
        else left[i] = right[i - 1]! + spacing + 1;
      }
    }
    // FIX: a sub-1px slot can produce right < left → collapse to a 1px column.
    for (let i = from; i < to; i++) {
      if (right[i]! < left[i]!) right[i] = left[i]!;
    }
    // EQUALIZE: shave wider columns down to the narrowest, but only when a gap exists
    // and the narrowest is below the alignment limit (§4.11 alignToMinimalWidthLimit).
    let minWidth = Math.ceil(barSpacing * hr);
    for (let i = from; i < to; i++) {
      const w = right[i]! - left[i]! + 1;
      if (w < minWidth) minWidth = w;
    }
    if (spacing > 0 && minWidth < ALIGN_TO_MINIMAL_WIDTH_LIMIT) {
      for (let i = from; i < to; i++) {
        if (right[i]! - left[i]! + 1 > minWidth) {
          if (roundedUp[i]) right[i] = right[i]! - 1; // centre rounded up → shave from the right
          else left[i] = left[i]! + 1; // else shave from the left
        }
      }
    }
  }

  function emit(items: ItemBuffer<HistogramItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const hr = frame.frame.hr;
    const vr = frame.frame.vr;
    buildColumns(items, from, to, lastBarSpacing, hr); // PHASE 1
    const { left, right } = cache;
    const y = items.y;
    // PHASE 2 — paint. The base zone is `tickWidth` tall so a zero-height column
    // still paints a visible tick at the base line.
    const tickWidth = Math.max(1, Math.floor(vr));
    const baseY = crispRound(lastBaseY, vr);
    const topBase = baseY - Math.floor(tickWidth / 2);
    const bottomBase = topBase + tickWidth;

    out.beginList('bitmap');
    const rects = out.rects({});
    for (let i = from; i < to; i++) {
      const yi = y[i]!;
      if (Number.isNaN(yi)) continue; // whitespace / gap
      const yc = crispRound(yi, vr);
      // Above base → [y .. bottomBase]; at/below → [topBase .. y − tickWidth/2 + tickWidth].
      const top = yc <= topBase ? yc : topBase;
      const bottom = yc <= topBase ? bottomBase : yc - Math.floor(tickWidth / 2) + tickWidth;
      rects.quad(left[i]!, top, right[i]! - left[i]! + 1, bottom - top, colorAt(i)); // fillStyle per item
    }
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
      shape: 'histogram',
      color: o.color,
      baseY: crispRound(price.priceToCoordinate(o.base), frame.frame.vr), // device-px baseY
    });
  }

  function hitTest(items: ItemBuffer<HistogramItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    // Operate over the SAME converted slice emit drew. Histogram span (study 06
    // §4.12): [min(itemY, baseY) .. max(itemY, baseY)] in media px.
    const to = lastTo > items.length ? items.length : lastTo;
    const ys = items.y;
    const span = (i: number): { readonly top: number; readonly bottom: number } => {
      const yi = ys[i]!;
      return { top: Math.min(yi, lastBaseY), bottom: Math.max(yi, lastBaseY) };
    };
    return hitTestColumns(
      items.x,
      items.timeIndex,
      span,
      lastFrom,
      to,
      x as number,
      y as number,
      lastBarSpacing,
      o.hitTestTolerance,
    );
  }

  function createBuffer(): ItemBuffer<HistogramItem> {
    return new ReusableItemBuffer<HistogramItem>(0, factory);
  }

  if (__DEV__) {
    assert(Number.isFinite(o.base), 'histogram base must be finite (study 06 §4.17)');
  }

  return {
    itemsFromStore,
    convert,
    emit,
    decimate,
    hitTest,
    extendedRange: false,
    createBuffer,
  };
}
