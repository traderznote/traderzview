// views/series/candlestick.ts — the Candlestick SeriesKind (study 06 §4.8 width /
// §4.10 candle renderer / §4.12 range hit; design 03 §8.5.6 emission). laneStride 4:
// x = media-px centre X, extra = [openY,highY,lowY,closeY] media-px Y (NaN = gap);
// payload carries the resolved up/down body + border + wick colours (§4.3).
// extendedRange false — a candle is self-contained (§3.3). emit → ONE bitmap list,
// THREE `rects` passes (wicks → borders → bodies), each batched by its colour and
// drawn with integer device coords; neighbour-overlap clamped via prevRightEdge.
// hitTest reuses hitTestColumns (span = min/max(highY,lowY)); decimate → ('barlike').
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import { resolveBarColors } from '../../model';
import type { DisplayListBuilder, HitCandidate, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';
import { decimateColumns } from './decimate';
import { OHLC, OHLC_LANE_STRIDE, ohlc, setOhlc, candleColumnWidth, hitTestColumns } from './bar-base';

/** The Candlestick per-item payload view: the resolved body/border/wick colours (§4.3). */
export interface CandlestickItem {
  readonly color: string;
  readonly borderColor: string;
  readonly wickColor: string;
}

/** Shared hit-test tolerance default (study 06 §4.12). */
const DEFAULT_HIT_TOLERANCE = 3;

export interface CandlestickKindOptions {
  /** Body colour of an up candle (open ≤ close), study 06 §4.17 default '#26a69a'. */
  readonly upColor: string;
  /** Body colour of a down candle (open > close), default '#ef5350'. */
  readonly downColor: string;
  /** Whether the hi–lo wick is drawn (default true). */
  readonly wickVisible: boolean;
  /** Whether a border is drawn around the body (default true). */
  readonly borderVisible: boolean;
  /** Hit-test tolerance, media px (default 3). */
  readonly hitTestTolerance: number;
}

/** Merge user `SeriesOptions` with the Candlestick defaults (study 06 §4.17). */
function resolveCandlestickOptions(options: SeriesOptions): CandlestickKindOptions {
  return {
    upColor: (options.upColor as string | undefined) ?? '#26a69a',
    downColor: (options.downColor as string | undefined) ?? '#ef5350',
    wickVisible: (options.wickVisible as boolean | undefined) ?? true,
    borderVisible: (options.borderVisible as boolean | undefined) ?? true,
    hitTestTolerance: (options.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

/** The Candlestick kind — also exposes `createBuffer()` (the engine / tests build the
 *  buffer whose `item(i)` factory reads this kind's parallel colour arrays). */
export interface CandlestickKind extends SeriesKindShape {
  createBuffer(): ItemBuffer<CandlestickItem>;
}

// Local alias of the SeriesKind contract specialised to CandlestickItem (mirrors
// bar.ts — re-spelled here only to add `createBuffer` without a value import).
interface SeriesKindShape {
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<CandlestickItem>): void;
  convert(
    items: ItemBuffer<CandlestickItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;
  emit(items: ItemBuffer<CandlestickItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;
  hitTest(items: ItemBuffer<CandlestickItem>, x: Coordinate, y: Coordinate): HitCandidate | null;
  readonly extendedRange: boolean;
}

/**
 * Build a Candlestick `SeriesKind` (stateful: owns the resolved body/border/wick
 * colours + raw OHLC per slot, and the last `convert` frame geometry/window that
 * `hitTest` replays so its column slots equal what `emit` drew).
 */
export function createCandlestickKind(options: SeriesOptions): CandlestickKind {
  const o = resolveCandlestickOptions(options);
  // Options bag with the resolved up/down/border/wick defaults applied, so
  // resolveBarColors('candlestick') picks the right branch even when the caller
  // omitted them (§4.3 precedence: per-point override → up/down → option default).
  const colorOpts: SeriesOptions = {
    ...options,
    upColor: o.upColor,
    downColor: o.downColor,
    borderUpColor: (options.borderUpColor as string | undefined) ?? '#26a69a',
    borderDownColor: (options.borderDownColor as string | undefined) ?? '#ef5350',
    wickUpColor: (options.wickUpColor as string | undefined) ?? '#26a69a',
    wickDownColor: (options.wickDownColor as string | undefined) ?? '#ef5350',
  };
  // Resolved colours (parallel arrays) + raw OHLC (stride-4 [o,h,l,c]) per slot;
  // convert maps each price → media-px Y per frame (the {o,h,l,c} item, columnar).
  const body: string[] = [];
  const border: string[] = [];
  const wick: string[] = [];
  const raw: number[] = [];
  // Last-convert window + bar spacing, replayed by hitTest (the column hit uses
  // spacing + tolerance only; hr/vr are not read on this path).
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;
  const bodyAt = (i: number): string => body[i] ?? o.upColor;
  const borderAt = (i: number): string => border[i] ?? o.upColor;
  const wickAt = (i: number): string => wick[i] ?? o.upColor;
  const factory = (_buf: ItemBuffer<CandlestickItem>, i: number): CandlestickItem => ({
    color: bodyAt(i),
    borderColor: borderAt(i),
    wickColor: wickAt(i),
  });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<CandlestickItem>): void {
    // Normal path: rebuild the item list. open = lane 0, high = max, low = min, close
    // = current (roles). Per-point row.color is unreachable this milestone (§4.3).
    const n = store.length;
    items.ensure(n);
    items.length = n;
    if (body.length < n) body.length = n;
    if (border.length < n) border.length = n;
    if (wick.length < n) wick.length = n;
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
      const c = resolveBarColors('candlestick', { open, close }, {}, colorOpts);
      body[i] = c.barColor;
      border[i] = c.barBorderColor ?? c.barColor;
      wick[i] = c.barWickColor ?? c.barColor;
    }
  }

  function convert(
    items: ItemBuffer<CandlestickItem>,
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
      const b = i * OHLC_LANE_STRIDE;
      // NaN price propagates as NaN Y (gap). All four lanes filled (study 06 §4.1).
      setOhlc(extra, i, OHLC.Open, price.priceToCoordinate(raw[b + OHLC.Open] ?? Number.NaN));
      setOhlc(extra, i, OHLC.High, price.priceToCoordinate(raw[b + OHLC.High] ?? Number.NaN));
      setOhlc(extra, i, OHLC.Low, price.priceToCoordinate(raw[b + OHLC.Low] ?? Number.NaN));
      setOhlc(extra, i, OHLC.Close, price.priceToCoordinate(raw[b + OHLC.Close] ?? Number.NaN));
    }
  }

  function emit(items: ItemBuffer<CandlestickItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const hr = frame.frame.hr;
    const vr = frame.frame.vr;
    const x = items.x;
    const extra = items.extra;
    // Width math (study 06 §4.8/§4.10): bodyWidth = optimalCandlestickWidth + parity
    // vs floor(hr) (candleColumnWidth, bar-base). NaN high/low (or open/close) = gap.
    const barWidth = candleColumnWidth(lastBarSpacing, hr);
    const finite = (i: number): boolean =>
      !Number.isNaN(ohlc(extra, i, OHLC.High)) && !Number.isNaN(ohlc(extra, i, OHLC.Low));

    // Border thickness derivation (§4.10): a single pixel at most, halved when the body
    // is too narrow to host a frame, then floored to ≥ floor(hr).
    let bw = Math.floor(1 * hr);
    if (barWidth <= 2 * bw) bw = Math.floor((barWidth - 1) * 0.5);
    bw = Math.max(Math.floor(hr), bw);
    if (barWidth <= 2 * bw) bw = Math.max(Math.floor(hr), Math.floor(1 * hr));

    out.beginList('bitmap');

    // PASS 1 — wicks (centred upper + lower stick), runs fold by wick colour.
    if (o.wickVisible) {
      let wickWidth = Math.min(Math.floor(hr), Math.floor(lastBarSpacing * hr));
      wickWidth = Math.max(Math.floor(hr), Math.min(wickWidth, barWidth));
      const wickOffset = Math.floor(wickWidth / 2);
      const wicks = out.rects({});
      let prevRightEdge: number | null = null;
      for (let i = from; i < to; i++) {
        if (!finite(i)) continue;
        const openY = ohlc(extra, i, OHLC.Open);
        const closeY = ohlc(extra, i, OHLC.Close);
        const top = Math.round(Math.min(openY, closeY) * vr); // body top (smaller Y)
        const bottom = Math.round(Math.max(openY, closeY) * vr);
        const high = Math.round(ohlc(extra, i, OHLC.High) * vr);
        const low = Math.round(ohlc(extra, i, OHLC.Low) * vr);
        let left = Math.round(x[i]! * hr) - wickOffset;
        const right = left + wickWidth - 1;
        if (prevRightEdge !== null) left = clampTo(left, prevRightEdge + 1, right);
        const fill = wickAt(i);
        wicks.quad(left, high, wickWidth, Math.max(top - high, 0), fill); // upper wick
        wicks.quad(left, bottom + 1, wickWidth, Math.max(low - bottom, 0), fill); // lower wick
        prevRightEdge = right;
      }
    }

    // PASS 2 — borders (hollow frame, or a filled rect when too thin), by border colour.
    if (o.borderVisible) {
      const borders = out.rects({});
      const halfBar = Math.floor(barWidth / 2);
      let prevRightEdge: number | null = null;
      for (let i = from; i < to; i++) {
        if (!finite(i)) continue;
        let left = Math.round(x[i]! * hr) - halfBar;
        const right = left + barWidth - 1; // compute right BEFORE clamping left
        const top = Math.round(Math.min(ohlc(extra, i, OHLC.Open), ohlc(extra, i, OHLC.Close)) * vr);
        const bottom = Math.round(Math.max(ohlc(extra, i, OHLC.Open), ohlc(extra, i, OHLC.Close)) * vr);
        if (prevRightEdge !== null) left = clampTo(left, prevRightEdge + 1, right);
        const w = right - left + 1;
        const fill = borderAt(i);
        if (lastBarSpacing * hr > 2 * bw) {
          borders.quad(left + bw, top, w - 2 * bw, bw, fill); // top edge
          borders.quad(left + bw, bottom - bw + 1, w - 2 * bw, bw, fill); // bottom edge (mirrored)
          borders.quad(left, top, bw, bottom - top + 1, fill); // left edge (full height)
          borders.quad(right - bw + 1, top, bw, bottom - top + 1, fill); // right edge
        } else {
          borders.quad(left, top, w, bottom - top + 1, fill); // too thin for a hollow body
        }
        prevRightEdge = right;
      }
    }

    // PASS 3 — bodies (open→close fill), inset by bw when bordered, by body colour.
    // Skip the WHOLE pass when the border already fills the candle (§4.10).
    if (o.borderVisible && barWidth <= 2 * bw) return;
    const bodies = out.rects({});
    const halfBar = Math.floor(barWidth / 2);
    let prevRightEdge: number | null = null;
    for (let i = from; i < to; i++) {
      if (!finite(i)) continue;
      let left = Math.round(x[i]! * hr) - halfBar;
      let right = left + barWidth - 1;
      let top = Math.round(Math.min(ohlc(extra, i, OHLC.Open), ohlc(extra, i, OHLC.Close)) * vr);
      let bottom = Math.round(Math.max(ohlc(extra, i, OHLC.Open), ohlc(extra, i, OHLC.Close)) * vr);
      if (prevRightEdge !== null) left = clampTo(left, prevRightEdge + 1, right);
      prevRightEdge = right;
      if (o.borderVisible) {
        left += bw;
        right -= bw;
        top += bw;
        bottom -= bw;
      }
      if (top > bottom) continue; // border swallowed the body
      bodies.quad(left, top, Math.max(right - left + 1, 0), bottom - top + 1, bodyAt(i));
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

  function hitTest(items: ItemBuffer<CandlestickItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    // Operate over the SAME converted slice emit drew. Candle span (study 06 §4.12):
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

  function createBuffer(): ItemBuffer<CandlestickItem> {
    return new ReusableItemBuffer<CandlestickItem>(OHLC_LANE_STRIDE, factory);
  }

  if (__DEV__) {
    assert(typeof o.upColor === 'string' && typeof o.downColor === 'string', 'candle up/down colours must be strings');
  }

  return { itemsFromStore, convert, emit, decimate, hitTest, extendedRange: false, createBuffer };
}

/** Clamp `v` into `[lo, hi]` (study 06 §4.10 neighbour-overlap clamp). */
function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
