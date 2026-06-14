// views/series/area.ts — the AREA SeriesKind (architecture §6; study 06 §4.6).
// TWO display lists per source, fill-then-line order: (1) a MEDIA-space `area` fill
// closed to a base level with a top→bottom LinearGradientY, then (2) a BITMAP-space
// `polyline` top line (the §4.5 line renderer over the same points, ×hr/vr UNROUNDED).
// Per-point fill overrides split the fill into adjoining `area` commands sharing the
// boundary vertex (design 03 §3.2.3); the top line + hit reuse the shared Simple-line
// walker / scaffold (line-base.ts) so its geometry equals line's. extendedRange true
// so an edge-crossing segment stays connected (study 10 §4.11). No DOM / backend
// import (§3.2 — views touch core/fmt/data/model/gfx only).
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter } from '../../model';
import { LineStyle } from '../../gfx';
import type { DisplayListBuilder, FillStyle, HitCandidate, LinearGradientY, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer, ItemFactory } from './buffer';
import type { ItemWindow } from './window';
import type { SeriesKind } from './kind';
import { decimateColumns } from './decimate';
import { LineType, walkLine, hitTestLine } from './line-base';
import type { LineHitParams } from './line-base';

// --- options ------------------------------------------------------------------

/** A per-point colour override for one row (the sparse colour sidecar the host
 *  feeds in; study 06 §2/§4.3). Any field absent ⇒ fall back to the option. */
export interface AreaPointColors {
  readonly lineColor?: string;
  readonly topColor?: string;
  readonly bottomColor?: string;
}

/** Area's resolved style options (study 06 §4.17 defaults). Plain data — the kind
 *  never reads `model`'s option bag directly; the host passes the resolved values. */
export interface AreaKindOptions {
  /** Area fill — top gradient stop (study 06 §4.6). */
  readonly topColor: string;
  /** Area fill — bottom gradient stop. */
  readonly bottomColor: string;
  /** Top-line stroke colour (= the bar/line colour, study 06 §4.3). */
  readonly lineColor: string;
  /** Top-line stroke width, media px (default 3). */
  readonly lineWidth: number;
  /** Top-line dash style. */
  readonly lineStyle: LineStyle;
  /** Draw the line at all (study 06 §4.5 `lineVisible`). */
  readonly lineVisible: boolean;
  /** Fill upward to y=0 instead of down to pane height (study 06 §4.6). */
  readonly invertFilledArea: boolean;
  /** Anchor the gradient top at the highest visible point's y (study 06 §4.6). */
  readonly relativeGradient: boolean;
  /** Hit-test tolerance, media px (default 3, study 06 §4.12). */
  readonly hitTestTolerance: number;
  /** Per-point colour sidecar; absent ⇒ all rows use the option colours. */
  readonly pointColors?: (index: number) => AreaPointColors | undefined;
}

const DEFAULT_AREA_OPTIONS: AreaKindOptions = {
  topColor: 'rgba( 46, 220, 135, 0.4)',
  bottomColor: 'rgba( 40, 221, 100, 0)',
  lineColor: '#33D778',
  lineWidth: 3,
  lineStyle: LineStyle.Solid,
  lineVisible: true,
  invertFilledArea: false,
  relativeGradient: false,
  hitTestTolerance: 3,
};

// --- item payload -------------------------------------------------------------

/** One screen-space area point. `x`/`y` are media px (filled by `convert`); the
 *  three resolved colours are baked once per row by `itemsFromStore` and read by
 *  `emit`. A reused flyweight (no per-item alloc on the hot path). */
export interface AreaItem {
  readonly x: number;
  readonly y: number;
  readonly timeIndex: number;
  /** Resolved top-line stroke colour for this point. */
  readonly lineColor: string;
  /** Resolved fill gradient TOP stop for this point. */
  readonly topColor: string;
  /** Resolved fill gradient BOTTOM stop for this point. */
  readonly bottomColor: string;
}

/** The area-kind scene-source half. The engine owns ONE of these per series and
 *  reuses its `ItemBuffer` every frame (perf §5.1). Options are captured at
 *  construction; the colour lanes are baked in `itemsFromStore`. */
class AreaKind implements SeriesKind<AreaItem> {
  readonly extendedRange = true; // line-like ±1 window (study 10 §4.11)

  readonly #opts: AreaKindOptions;
  // String colour lanes parallel to the buffer (Float32 lanes can't hold colours).
  // Grown lazily; never shrunk — same discipline as the ItemBuffer.
  #lineColors: string[] = [];
  #topColors: string[] = [];
  #bottomColors: string[] = [];
  // Bar width (media px) cached by `convert` so `emit`/`hitTest` — which the
  // SeriesKind contract does NOT hand `horz` — can size the single-point stub
  // (study 06 §4.4). `convert` always runs immediately before `emit` on the normal path.
  #barSpacing = 0;
  // The converted window [lastFrom, lastTo), captured in convert(); hitTest scans it
  // (NOT [0, length)) so on the decimated path — convert bypassed, lastFrom==lastTo==0
  // — the scan is empty and hitTest returns null, matching the contract + sibling kinds.
  #lastFrom = 0;
  #lastTo = 0;
  #lineColorAt = (i: number): string => this.#lineColors[i] ?? this.#opts.lineColor;

  constructor(opts: AreaKindOptions) {
    this.#opts = opts;
  }

  /** Flyweight factory for `ItemBuffer.item(i)`: reads the geometry lanes + the
   *  parallel colour lanes with no per-item allocation beyond the view object. */
  itemFactory(): ItemFactory<AreaItem> {
    return (b: ItemBuffer<AreaItem>, i: number): AreaItem => ({
      x: b.x[i]!,
      y: b.y[i]!,
      timeIndex: b.timeIndex[i]!,
      lineColor: this.#lineColors[i] ?? this.#opts.lineColor,
      topColor: this.#topColors[i] ?? this.#opts.topColor,
      bottomColor: this.#bottomColors[i] ?? this.#opts.bottomColor,
    });
  }

  // --- itemsFromStore: rows → buffer (geometry NaN until convert) -------------

  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<AreaItem>): void {
    // The normal path rebuilds/patches the buffer from the SoA store. `append`/
    // `updateLast` patch the tail; everything else does a full reload — the store
    // always holds the authoritative row set (data §4.5.2).
    switch (diff.kind) {
      case 'append':
        this.#patchFrom(store, items, store.length - diff.count);
        break;
      case 'updateLast':
        this.#patchFrom(store, items, store.length > 0 ? store.length - 1 : 0);
        break;
      default:
        this.#patchFrom(store, items, 0);
        break;
    }
  }

  /** Copy rows `[from, store.length)` into the buffer: TimeIndex into its lane, the
   *  raw close into the `extra` lane (stride 1 — `convert` reads it back), and this
   *  row's resolved colours into the parallel string lanes. Geometry (`x`/`y`) stays
   *  NaN until `convert` (the SeriesKind contract gives convert no store). */
  #patchFrom(store: PlotStoreView, items: ItemBuffer<AreaItem>, from: number): void {
    const n = store.length;
    items.ensure(n);
    items.length = n;
    const pc = this.#opts.pointColors;
    const value = items.extra; // stride 1: extra[i] = raw close (price space)
    for (let i = from; i < n; i++) {
      items.timeIndex[i] = store.timeIndex(i) as number;
      value[i] = store.current(i);
      const ov = pc ? pc(i) : undefined;
      this.#lineColors[i] = ov?.lineColor ?? this.#opts.lineColor;
      this.#topColors[i] = ov?.topColor ?? this.#opts.topColor;
      this.#bottomColors[i] = ov?.bottomColor ?? this.#opts.bottomColor;
    }
  }

  // --- convert: rows → media-px x/y over the visible window -------------------

  convert(
    items: ItemBuffer<AreaItem>,
    window: ItemWindow,
    _frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void {
    // Fill the visible slice only (points-array fast path, study 04 §4.4): TimeIndex
    // → media-px centre X; baked raw value (`extra` lane) → media-px Y. NaN stays NaN.
    this.#barSpacing = horz.barSpacing; // cached for emit/hit single-point stub
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    this.#lastFrom = from;
    this.#lastTo = to;
    const value = items.extra;
    for (let i = from; i < to; i++) {
      items.x[i] = horz.indexToCoordinate(items.timeIndex[i]!);
      const v = value[i]!;
      items.y[i] = Number.isNaN(v) ? Number.NaN : price.priceToCoordinate(v);
    }
  }

  // --- emit: two lists, fill-then-line (study 06 §4.6) ------------------------

  emit(items: ItemBuffer<AreaItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to - from < 1) return; // empty window → nothing to draw (study 06 §5)

    const { hr, vr, mediaSize } = frame.frame;
    const o = this.#opts;
    const x = items.x;
    const y = items.y;

    // Gradient top anchor: 0, or the highest visible point's y when relativeGradient
    // is on (the pane view scans the visible slice for min y — study 06 §4.6).
    let topY = 0;
    if (o.relativeGradient) {
      let min = Number.POSITIVE_INFINITY;
      for (let i = from; i < to; i++) {
        const yi = y[i]!;
        if (!Number.isNaN(yi) && yi < min) min = yi;
      }
      if (min !== Number.POSITIVE_INFINITY) topY = min;
    }
    // Base level the polygon closes to: top edge (0) when inverted, else pane height
    // (study 06 §4.6 `baseLevelCoordinate ?? (invertFilledArea ? 0 : mediaHeight)`).
    const baseY = o.invertFilledArea ? 0 : mediaSize.height;

    // --- LIST 1: media-space area fill ---------------------------------------
    out.beginList('media');
    if (to - from === 1) {
      const i = from;
      const yi = y[i]!;
      if (!Number.isNaN(yi)) {
        const half = this.#barSpacing / 2;
        const fill = this.#fillStyle(this.#topColors[i] ?? o.topColor, this.#bottomColors[i] ?? o.bottomColor, topY, baseY);
        const w = out.area(baseY, fill);
        w.vertex(x[i]! - half, yi);
        w.vertex(x[i]! + half, yi);
      }
    } else {
      this.#emitFill(x, y, from, to, topY, baseY, out);
    }

    // --- LIST 2: bitmap-space top line (study 06 §4.5) — shared Simple walk ---
    if (o.lineVisible) {
      out.beginList('bitmap');
      const poly = out.polyline(o.lineWidth * vr, o.lineStyle, 'round'); // lineJoin 'round'
      walkLine(x, y, this.#lineColorAt, from, to, hr, vr, this.#barSpacing, LineType.Simple,
        (vx, vy, fill) => poly.vertex(vx, vy, fill), () => poly.gap());
    }
  }

  /** walkLine-style styled-run fill (study 06 §4.4): a run spans [runFirst,
   *  changeVertex] inclusive; the next run RE-EMITS the boundary vertex (adjoining
   *  `area` commands share it, §3.2.3). The `area` writer opens LAZILY — only when a
   *  run gets its first vertex — so a change on the LAST visible item never emits a
   *  degenerate single-vertex area (the reference's guarded final flush). NaN closes
   *  a run (gap). */
  #emitFill(
    x: Float32Array,
    y: Float32Array,
    from: number,
    to: number,
    topY: number,
    baseY: number,
    out: DisplayListBuilder,
  ): void {
    const o = this.#opts;
    let runTop = '';
    let runBot = '';
    let w: ReturnType<DisplayListBuilder['area']> | null = null;
    // A deferred boundary vertex + the NEW run's colour (captured AT the change point
    // — the segment leaving the change vertex takes the new style, study 06 §4.4).
    let pendShareX = Number.NaN;
    let pendShareY = Number.NaN;
    let pendTop = '';
    let pendBot = '';
    for (let i = from; i < to; i++) {
      const yi = y[i]!;
      const xi = x[i]!;
      if (Number.isNaN(yi)) {
        w = null; // gap closes the run; drop any pending share (no continuation)
        pendShareX = Number.NaN;
        continue;
      }
      const ct = this.#topColors[i] ?? o.topColor;
      const cb = this.#bottomColors[i] ?? o.bottomColor;
      if (w !== null && (ct !== runTop || cb !== runBot)) {
        w.vertex(xi, yi); // CLOSE the current run at the boundary vertex
        w = null;
        pendShareX = xi; // DEFER it as the next run's anchor (new colour = ct/cb)
        pendShareY = yi;
        pendTop = ct;
        pendBot = cb;
        continue;
      }
      if (w === null) {
        // Open lazily. A deferred boundary carries the new colour captured above; a
        // fresh start (after a gap / at window start) uses this vertex's colour.
        runTop = Number.isNaN(pendShareX) ? ct : pendTop;
        runBot = Number.isNaN(pendShareX) ? cb : pendBot;
        w = out.area(baseY, this.#fillStyle(runTop, runBot, topY, baseY));
        if (!Number.isNaN(pendShareX)) {
          w.vertex(pendShareX, pendShareY); // shared boundary vertex first
          pendShareX = Number.NaN;
        }
      }
      w.vertex(xi, yi);
    }
  }

  /** Build the vertical top→bottom fill gradient for one styled run (study 06 §4.6).
   *  Coordinates are LIST space (media px here — design 03 §11.5: gradient coords are
   *  always list-space, no pixel-ratio multiplier). */
  #fillStyle(top: string, bottom: string, fromY: number, toY: number): FillStyle {
    const g: LinearGradientY = {
      from: fromY,
      to: toY,
      stops: [
        { offset: 0, color: top },
        { offset: 1, color: bottom },
      ],
    };
    return g;
  }

  // --- decimate: shared column helper (perf §6.3) -----------------------------

  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void {
    out.beginList('bitmap'); // decimated geometry is device-px (perf §6.3); match the siblings
    decimateColumns(store, window, frame, horz, price, out, {
      shape: 'area',
      color: this.#opts.lineColor,
      lineWidth: this.#opts.lineWidth,
    });
  }

  // --- hitTest: geometry EQUALS drawn geometry (§5.5) — shared Simple scaffold -

  hitTest(items: ItemBuffer<AreaItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    const o = this.#opts;
    const params: LineHitParams = {
      type: LineType.Simple, // area's top line is always Simple
      lineHalf: o.lineVisible ? o.lineWidth / 2 : 0.5,
      markerRadius: undefined, // area has no point markers
      tolerance: o.hitTestTolerance,
      barSpacing: this.#barSpacing,
      hr: 1,
      vr: 1, // unused for Simple
    };
    // Scan the converted window only (NaN-safe; empty on the decimated path → null).
    const to = this.#lastTo > items.length ? items.length : this.#lastTo;
    return hitTestLine(items.x, items.y, this.#lastFrom, to, x as number, y as number, params);
  }
}

// stride 1: the `extra` lane caches the raw close (price space) so `convert` — which
// does NOT receive the store (the SeriesKind contract) — can map value → Y. This is
// the columnar form of the reference's `{time, price, x:NaN, y:NaN}` item (§3.3).
const LANE_STRIDE = 1;

/** Create an Area `SeriesKind` plus its reusable `ItemBuffer`. The engine calls this
 *  once per series; merges caller options over the study-06 §4.17 defaults. */
export function createAreaKind(opts?: Partial<AreaKindOptions>): {
  readonly kind: SeriesKind<AreaItem>;
  readonly buffer: ItemBuffer<AreaItem>;
} {
  if (__DEV__ && opts?.lineWidth !== undefined) {
    assert(opts.lineWidth >= 1 && opts.lineWidth <= 4, 'area lineWidth must be 1–4 (study 06 §4.5)');
  }
  const kind = new AreaKind({ ...DEFAULT_AREA_OPTIONS, ...opts });
  const buffer = new ReusableItemBuffer<AreaItem>(LANE_STRIDE, kind.itemFactory());
  return { kind, buffer };
}
