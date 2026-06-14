// views/series/baseline.ts — the Baseline SeriesKind (study 06 §4.7; design 03
// §8.5.3). Baseline = Area renderer + line renderer where BOTH the fill and the
// stroke are two-band vertical gradients HARD-SPLIT at the base-level Y (top band
// = topFill/topLine, bottom band = bottomFill/bottomLine, no fade). One MEDIA
// `area` fill closed to the base-level Y, then one BITMAP `polyline` top line — the
// shared Simple walkLine (line-base.ts), every vertex carrying the one hard-split
// line gradient so the stroke switches colour at the baseline with no extra command
// (§8.5.3: StyleRun.fill accepts gradients). No clip, no second fill. The fill never
// inverts. hitTest reuses the shared line scaffold over the converted slice. convert
// caches hr/vr/barSpacing/from/to so hit geometry equals drawn. extendedRange true.
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import { LineStyle } from '../../gfx';
import type { DisplayListBuilder, HitCandidate, LinearGradientY, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';
import type { SeriesKind } from './kind';
import { decimateColumns } from './decimate';
import { LineType, walkLine, hitTestLine } from './line-base';
import type { LineHitParams } from './line-base';

/** The Baseline per-item payload view (study 06 §4.3: above = close ≥ baseValue). */
export interface BaselineItem {
  readonly color: string;
}

const DEFAULT_HIT_TOLERANCE = 3;

/** Baseline's resolved style (study 06 §4.7/§4.17 defaults). */
export interface BaselineKindOptions {
  /** Split price; above (close ≥ this) uses top colours (study 06 §4.7). */
  readonly baseValue: number;
  readonly topFillColor1: string;
  readonly topFillColor2: string;
  readonly bottomFillColor1: string;
  readonly bottomFillColor2: string;
  readonly topLineColor: string;
  readonly bottomLineColor: string;
  /** Top-line stroke width, media px (default 3). */
  readonly lineWidth: number;
  readonly lineStyle: LineStyle;
  readonly lineVisible: boolean;
  /** Anchor the gradient band span at the visible slice's min/max y (study 06 §4.7). */
  readonly relativeGradient: boolean;
  readonly hitTestTolerance: number;
}

/** Merge user `SeriesOptions` with the Baseline defaults (study 06 §4.17). */
function resolveOptions(o: SeriesOptions): BaselineKindOptions {
  return {
    baseValue: ((o.baseValue as { price?: number } | undefined)?.price as number | undefined) ?? 0,
    topFillColor1: (o.topFillColor1 as string | undefined) ?? 'rgba(38, 166, 154, 0.28)',
    topFillColor2: (o.topFillColor2 as string | undefined) ?? 'rgba(38, 166, 154, 0.05)',
    bottomFillColor1: (o.bottomFillColor1 as string | undefined) ?? 'rgba(239, 83, 80, 0.05)',
    bottomFillColor2: (o.bottomFillColor2 as string | undefined) ?? 'rgba(239, 83, 80, 0.28)',
    topLineColor: (o.topLineColor as string | undefined) ?? 'rgba(38, 166, 154, 1)',
    bottomLineColor: (o.bottomLineColor as string | undefined) ?? 'rgba(239, 83, 80, 1)',
    lineWidth: (o.lineWidth as number | undefined) ?? 3,
    lineStyle: (o.lineStyle as LineStyle | undefined) ?? LineStyle.Solid,
    lineVisible: (o.lineVisible as boolean | undefined) ?? true,
    relativeGradient: (o.relativeGradient as boolean | undefined) ?? false,
    hitTestTolerance: (o.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

/** Build a two-band HARD-SPLIT vertical gradient (study 06 §4.7): two stops at the
 *  same ratio `r = clamp((baseY − top)/(bottom − top), 0, 1)` = a hard colour switch
 *  at the baseline Y, no fade. Coordinates are LIST space (design 03 §11.5). */
function splitGradient(top: number, bottom: number, baseY: number, c0: string, c1: string, c2: string, c3: string): LinearGradientY {
  const span = bottom - top;
  let r = span !== 0 ? (baseY - top) / span : 0;
  r = r < 0 ? 0 : r > 1 ? 1 : r;
  return {
    from: top,
    to: bottom,
    stops: [
      { offset: 0, color: c0 },
      { offset: r, color: c1 },
      { offset: r, color: c2 },
      { offset: 1, color: c3 },
    ],
  };
}

export interface BaselineKind extends SeriesKind<BaselineItem> {
  createBuffer(): ItemBuffer<BaselineItem>;
}

/**
 * Build a Baseline `SeriesKind`. Stateful like line.ts: it caches the per-slot
 * close value + resolved above/below stroke colour, and the last-convert geometry
 * (`hr`/`vr`/`barSpacing`/`from`/`to`) so `hitTest` replays the slice `emit` drew.
 */
export function createBaselineKind(options: SeriesOptions): BaselineKind {
  const o = resolveOptions(options);
  const values: number[] = [];
  const colors: string[] = []; // resolved above/below stroke colour per slot (study 06 §4.3)
  let lastHr = 1;
  let lastVr = 1;
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;
  // baseLevelCoordinate (media-px Y of baseValue): the SeriesKind contract gives emit
  // no price converter, so convert maps the baseValue once and caches it for emit.
  let lastBaseY = 0;

  const colorAt = (i: number): string => colors[i] ?? o.topLineColor;
  const factory = (_b: ItemBuffer<BaselineItem>, i: number): BaselineItem => ({ color: colorAt(i) });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<BaselineItem>): void {
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
      // Baseline: barColor = above ? topLineColor : bottomLineColor (study 06 §4.3,
      // options only — no per-point override).
      colors[i] = value >= o.baseValue ? o.topLineColor : o.bottomLineColor;
    }
  }

  function convert(
    items: ItemBuffer<BaselineItem>,
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
    lastBaseY = price.priceToCoordinate(o.baseValue as number); // baseLevelCoordinate (media)
    const x = items.x;
    const y = items.y;
    const ti = items.timeIndex;
    for (let i = from; i < to; i++) x[i] = horz.indexToCoordinate(ti[i]!);
    for (let i = from; i < to; i++) y[i] = price.priceToCoordinate(values[i] ?? Number.NaN);
  }

  function emit(items: ItemBuffer<BaselineItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const { hr, vr, mediaSize } = frame.frame;
    const x = items.x;
    const y = items.y;

    // Gradient band span: 0 → media height, or the visible slice's min/max y when
    // relativeGradient is on (study 06 §4.7). The hard split sits at the baseline Y.
    let top = 0;
    let bottom = mediaSize.height;
    if (o.relativeGradient) {
      let mn = Number.POSITIVE_INFINITY;
      let mx = Number.NEGATIVE_INFINITY;
      for (let i = from; i < to; i++) {
        const yi = y[i]!;
        if (Number.isNaN(yi)) continue;
        if (yi < mn) mn = yi;
        if (yi > mx) mx = yi;
      }
      if (mn !== Number.POSITIVE_INFINITY) {
        top = mn;
        bottom = mx;
      }
    }
    // baseLevelCoordinate (cached by convert): the polygon closes to it; the fill
    // NEVER inverts (study 06 §4.7).
    const baseY = lastBaseY;
    const fillGrad = splitGradient(top, bottom, baseY, o.topFillColor1, o.topFillColor2, o.bottomFillColor1, o.bottomFillColor2);

    // --- LIST 1: media-space hard-split area fill (the §4.6 area walk, one command).
    // Single visible point → a one-bar-wide horizontal stub centred on it (study 06
    // §4.4); otherwise one vertex per finite point (NaN gaps skipped).
    out.beginList('media');
    const w = out.area(baseY, fillGrad);
    if (to - from === 1) {
      const yi = y[from]!;
      if (!Number.isNaN(yi)) {
        const half = lastBarSpacing / 2;
        w.vertex(x[from]! - half, yi);
        w.vertex(x[from]! + half, yi);
      }
    } else {
      for (let i = from; i < to; i++) {
        const yi = y[i]!;
        if (!Number.isNaN(yi)) w.vertex(x[i]!, yi);
      }
    }

    // --- LIST 2: bitmap-space top line — shared Simple walk; every vertex carries
    // the ONE hard-split LINE gradient, so the stroke switches colour at the baseline
    // with no second command (design 03 §8.5.3). Band span in DEVICE px (×vr).
    if (o.lineVisible) {
      out.beginList('bitmap');
      const lineGrad = splitGradient(
        top * vr, bottom * vr, baseY * vr,
        o.topLineColor, o.topLineColor, o.bottomLineColor, o.bottomLineColor,
      );
      const poly = out.polyline(o.lineWidth * vr, o.lineStyle, 'round');
      walkLine(x, y, colorAt, from, to, hr, vr, lastBarSpacing, LineType.Simple,
        (vx, vy) => poly.vertex(vx, vy, lineGrad), () => poly.gap());
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
      shape: 'line',
      color: o.topLineColor,
      lineWidth: o.lineWidth * frame.frame.vr,
    });
  }

  function hitTest(items: ItemBuffer<BaselineItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    const to = lastTo > items.length ? items.length : lastTo;
    const params: LineHitParams = {
      type: LineType.Simple, // baseline's top line is always Simple
      lineHalf: o.lineVisible ? o.lineWidth / 2 : 0.5,
      markerRadius: undefined, // baseline has no point markers
      tolerance: o.hitTestTolerance,
      barSpacing: lastBarSpacing,
      hr: lastHr,
      vr: lastVr,
    };
    return hitTestLine(items.x, items.y, lastFrom, to, x as number, y as number, params);
  }

  function createBuffer(): ItemBuffer<BaselineItem> {
    return new ReusableItemBuffer<BaselineItem>(0, factory);
  }

  if (__DEV__) {
    assert(o.lineWidth >= 1 && o.lineWidth <= 4, 'baseline lineWidth must be 1–4 (study 06 §4.5)');
  }

  return { itemsFromStore, convert, emit, decimate, hitTest, extendedRange: true, createBuffer };
}
