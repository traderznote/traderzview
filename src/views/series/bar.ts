// views/series/bar.ts — the OHLC Bar SeriesKind (study 06 §4.8/§4.9/§4.12; design 03
// §8.5.5). laneStride 4: x = media-px centre X, extra = [openY,highY,lowY,closeY]
// media-px Y (NaN = gap); payload carries the resolved up/down colour (§4.3).
// extendedRange false — a fully off-screen bar contributes nothing (§3.3). emit →
// ONE bitmap `rects` (runs by colour): a hi–lo stick + (unless too dense) left open +
// right close ticks, crisp via gfx/crisp + bar-base parity. hitTest reuses
// hitTestColumns (span = min/max(highY,lowY)); decimate → decimateColumns ('barlike').
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
import { OHLC, OHLC_LANE_STRIDE, ohlc, barColumnWidth, hitTestColumns } from './bar-base';

/** The Bar per-item payload view: the resolved up/down fill colour for style runs. */
export interface BarItem {
  readonly color: string;
}

/** Shared hit-test tolerance default (study 06 §4.12). */
const DEFAULT_HIT_TOLERANCE = 3;

export interface BarKindOptions {
  /** Colour of an up bar (open ≤ close), study 06 §4.17 default '#26a69a'. */
  readonly upColor: string;
  /** Colour of a down bar (open > close), default '#ef5350'. */
  readonly downColor: string;
  /** Whether the left open tick is drawn (default true). */
  readonly openVisible: boolean;
  /** Cap the stick at 1 device px (`floor(hr)`) when true (default true). */
  readonly thinBars: boolean;
  /** Hit-test tolerance, media px (default 3). */
  readonly hitTestTolerance: number;
}

/** Merge user `SeriesOptions` with the Bar defaults (study 06 §4.17). */
function resolveBarOptions(options: SeriesOptions): BarKindOptions {
  return {
    upColor: (options.upColor as string | undefined) ?? '#26a69a',
    downColor: (options.downColor as string | undefined) ?? '#ef5350',
    openVisible: (options.openVisible as boolean | undefined) ?? true,
    thinBars: (options.thinBars as boolean | undefined) ?? true,
    hitTestTolerance: (options.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

/** The Bar kind — also exposes `createBuffer()` (the engine / tests build the buffer
 *  whose `item(i)` factory reads this kind's parallel colour array). */
export interface BarKind extends SeriesKindShape {
  /** Build a fresh `ItemBuffer<BarItem>` wired to this kind's colour array. */
  createBuffer(): ItemBuffer<BarItem>;
}

// Local alias of the SeriesKind contract specialised to BarItem (mirrors line.ts —
// re-spelled here only to add `createBuffer` without a value import from kind.ts).
interface SeriesKindShape {
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<BarItem>): void;
  convert(
    items: ItemBuffer<BarItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;
  emit(items: ItemBuffer<BarItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;
  hitTest(items: ItemBuffer<BarItem>, x: Coordinate, y: Coordinate): HitCandidate | null;
  readonly extendedRange: boolean;
}

/**
 * Build a Bar `SeriesKind`. The kind is stateful: it owns the resolved up/down fill
 * colour per buffer slot + the raw OHLC (filled in `itemsFromStore`) and the last
 * frame's `hr`/`vr`/`barSpacing`/window (captured in `convert`, replayed by `hitTest`
 * so its column slots equal what `emit` drew).
 */
export function createBarKind(options: SeriesOptions): BarKind {
  const o = resolveBarOptions(options);
  // Options bag with the resolved up/down defaults applied, so resolveBarColors picks
  // the right branch even when the caller passed raw options (built once, no per-row
  // alloc — study 06 §4.3 precedence: per-point override → up/down → option).
  const colorOpts: SeriesOptions = { ...options, upColor: o.upColor, downColor: o.downColor };
  // Resolved fill colour + raw OHLC (stride-4 [o,h,l,c]) per buffer slot; convert
  // maps each price → media-px Y per frame (the columnar form of the {o,h,l,c} item).
  const colors: string[] = [];
  const raw: number[] = []; // stride-4 raw open/high/low/close per slot
  // Last-convert window + bar spacing, replayed by hitTest so its column slots equal
  // what emit drew (the column hit uses spacing + tolerance only; hr/vr are not read).
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;
  const colorAt = (i: number): string => colors[i] ?? o.upColor;
  const factory = (_buf: ItemBuffer<BarItem>, i: number): BarItem => ({ color: colorAt(i) });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<BarItem>): void {
    // Normal path: rebuild the item list from the store. open = lane 0, high = max
    // (role), low = min (role), close = current (role). Per-point row.color is not
    // reachable through the read-only PlotStoreView this milestone (study 06 §4.3).
    const n = store.length;
    items.ensure(n);
    items.length = n;
    if (colors.length < n) colors.length = n;
    if (raw.length < n * OHLC_LANE_STRIDE) raw.length = n * OHLC_LANE_STRIDE;
    const ti = items.timeIndex;
    for (let i = 0; i < n; i++) {
      ti[i] = store.timeIndex(i) as number;
      const open = store.lane(0, i);
      const close = store.current(i);
      const b = i * OHLC_LANE_STRIDE;
      raw[b + OHLC.Open] = open;
      raw[b + OHLC.High] = store.max(i);
      raw[b + OHLC.Low] = store.min(i);
      raw[b + OHLC.Close] = close;
      colors[i] = resolveBarColors('bar', { open, close }, {}, colorOpts).barColor;
    }
  }

  function convert(
    items: ItemBuffer<BarItem>,
    window: ItemWindow,
    _frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void {
    lastBarSpacing = horz.barSpacing;
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    lastFrom = from;
    lastTo = to;
    const x = items.x;
    const extra = items.extra;
    const ti = items.timeIndex;
    for (let i = from; i < to; i++) {
      x[i] = horz.indexToCoordinate(ti[i]!);
      // All four lanes map raw price → media-px Y; NaN price propagates as NaN Y (gap,
      // study 06 §4.1). raw and extra share the stride-4 [o,h,l,c] layout.
      const b = i * OHLC_LANE_STRIDE;
      for (let k = 0; k < OHLC_LANE_STRIDE; k++) extra[b + k] = price.priceToCoordinate(raw[b + k] ?? Number.NaN);
    }
  }

  function emit(items: ItemBuffer<BarItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const hr = frame.frame.hr;
    const vr = frame.frame.vr;
    const x = items.x;
    const extra = items.extra;
    // Width math (study 06 §4.9): column = optimalBarWidth + parity; stick = thinBars
    // ? min(col, floor(hr)) : col; ticks shown unless too dense (barSpacing < 1.5·hr).
    const barWidth = barColumnWidth(lastBarSpacing, hr);
    const lineWidth = o.thinBars ? Math.min(barWidth, Math.floor(hr)) : barWidth;
    const stick = Math.max(1, lineWidth);
    const half = Math.floor(stick / 2);
    const drawTicks = stick <= barWidth && lastBarSpacing >= Math.floor(1.5 * hr);
    const sideWidth = Math.ceil(barWidth * 1.5);

    out.beginList('bitmap');
    const rects = out.rects({});
    for (let i = from; i < to; i++) {
      const highY = ohlc(extra, i, OHLC.High);
      const lowY = ohlc(extra, i, OHLC.Low);
      if (Number.isNaN(highY) || Number.isNaN(lowY)) continue; // whitespace / gap
      const fill = colorAt(i);
      // Vertical stick: pad the hi–lo extent by half the stick thickness; min/max so an
      // inverted price scale still renders, height ≥ stick so a doji stays visible.
      const center = crispRound(x[i]!, hr);
      const left = center - half;
      const top = crispRound(Math.min(highY, lowY), vr) - half;
      const bottom = crispRound(Math.max(highY, lowY), vr) + half;
      const height = Math.max(bottom - top, stick);
      rects.quad(left, top, stick, height, fill);
      if (!drawTicks) continue;
      const right = left + stick - 1;
      const tickHi = top + height - stick; // clamp tick top inside [top, top+height−stick]
      // Open tick (left of the stick): [center−sideWidth .. left], centred on openY.
      if (o.openVisible) {
        const oTop = clampTo(crispRound(ohlc(extra, i, OHLC.Open), vr) - half, top, tickHi);
        rects.quad(center - sideWidth, oTop, left - (center - sideWidth), stick, fill);
      }
      // Close tick (right of the stick): [right+1 .. center+sideWidth], centred on closeY.
      const cTop = clampTo(crispRound(ohlc(extra, i, OHLC.Close), vr) - half, top, tickHi);
      rects.quad(right + 1, cTop, center + sideWidth - (right + 1), stick, fill);
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
    decimateColumns(store, window, frame, horz, price, out, { shape: 'barlike', color: o.upColor });
  }

  function hitTest(items: ItemBuffer<BarItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    // Operate over the SAME converted slice emit drew. Bar span (study 06 §4.12):
    // [min(highY,lowY) .. max(highY,lowY)] in media px (inversion-safe).
    const to = lastTo > items.length ? items.length : lastTo;
    const extra = items.extra;
    const span = (i: number): { readonly top: number; readonly bottom: number } => {
      const h = ohlc(extra, i, OHLC.High);
      const l = ohlc(extra, i, OHLC.Low);
      return { top: Math.min(h, l), bottom: Math.max(h, l) };
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

  function createBuffer(): ItemBuffer<BarItem> {
    return new ReusableItemBuffer<BarItem>(OHLC_LANE_STRIDE, factory);
  }

  if (__DEV__) {
    assert(typeof o.upColor === 'string' && typeof o.downColor === 'string', 'bar up/down colours must be strings');
  }

  return { itemsFromStore, convert, emit, decimate, hitTest, extendedRange: false, createBuffer };
}

/** Clamp `v` into `[lo, hi]` (study 06 §4.9 tick in-body clamp). */
function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
