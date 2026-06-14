// views/series/price-line.ts — the Price-line SceneSource (study 06 §4.13 horizontal-
// line family; design 03 §8.5 recipe 8). A horizontal line at a series price (last
// value or custom), drawn ABOVE the series: ONE bitmap `polyline` across the full
// width at the crisp device y (off-pane skip: y·vr outside [0, bitmapH] → nothing).
// `axisLabel()` exposes the same text/color for an axis-label source. The y, color and
// text are fed each frame by `provider` (the model walk stays out of views, §3.1); the
// source only crisps + caches (perf §4.4.2: clean → byte-identical array; change → re-emit).
import type { Coordinate } from '../../core';
import { crispStrokePos, crispWidth, DisplayListBuilder, HitPriority, LineStyle, ZBand } from '../../gfx';
import type { DisplayList, HitCandidate, SceneSource, ViewFrame } from '../../gfx';
import type { AxisLabel } from '../../model';

/** Per-frame state supplied by the model-side owner: `y` the line's media-px coord
 *  (`priceToCoordinate`); `barColor` the last-bar resolved color (§4.13 fallback when
 *  `color` is empty); `text` the axis label. Null `y` (no data) hides the line. */
export interface PriceLineState {
  readonly y: number | null;
  readonly barColor: string;
  readonly text: string;
}

/** Style + visibility (study 06 §4.13 / §4.17 defaults). `color` empty → fall back
 *  to the resolved last-bar color; `externalId` is echoed on a custom-line hit. */
export interface PriceLineOptions {
  readonly visible: boolean;
  /** `priceLineColor`; '' → last bar's resolved color (§4.13). */
  readonly color: string;
  /** Media-px width, ≥ 1 (default 1). */
  readonly lineWidth: number;
  /** Dash style (default Dashed). */
  readonly lineStyle: LineStyle;
  /** Whether the price-axis label is shown (default true). */
  readonly axisLabelVisible: boolean;
  /** Echoed to hits as the custom-line id (study 06 §4.13). */
  readonly externalId?: string;
}

const DEFAULTS: PriceLineOptions = {
  visible: true,
  color: '',
  lineWidth: 1,
  lineStyle: LineStyle.Dashed,
  axisLabelVisible: true,
};

/** Merge a partial over the §4.13 defaults. */
function resolve(o?: Partial<PriceLineOptions>): PriceLineOptions {
  return {
    visible: o?.visible ?? DEFAULTS.visible,
    color: o?.color ?? DEFAULTS.color,
    lineWidth: o?.lineWidth ?? DEFAULTS.lineWidth,
    lineStyle: o?.lineStyle ?? DEFAULTS.lineStyle,
    axisLabelVisible: o?.axisLabelVisible ?? DEFAULTS.axisLabelVisible,
    externalId: o?.externalId,
  };
}

/** Fixed hit threshold added to the line width (study 06 §4.13). */
const HIT_PAD = 7;
const EMPTY: readonly DisplayList[] = Object.freeze([]);

/** The Price-line scene source plus its axis-label hook. `axisLabel()` mirrors the
 *  line (text/color/coordinate) off the SAME provider state so they never disagree. */
export interface PriceLineSource extends SceneSource {
  axisLabel(): AxisLabel;
}

/** Build a Price-line `SceneSource` (band AboveSeries). `provider` returns the live
 *  `PriceLineState` each frame; the source crisps `y` into a bitmap line, caches the
 *  lists, and re-emits only when an input (state or device geometry) changes. */
export function createPriceLineSource(
  provider: () => PriceLineState,
  options?: Partial<PriceLineOptions>,
): PriceLineSource {
  const o = resolve(options);
  const builder = new DisplayListBuilder();
  let cached: readonly DisplayList[] = EMPTY;
  let sig: string | null = null; // null forces the first build

  // The resolved fill: option color when non-empty, else the last-bar color (§4.13).
  const fillOf = (s: PriceLineState): string => (o.color !== '' ? o.color : s.barColor);
  // Drawable iff visible, has a finite y, and that y is on-pane in device space.
  function drawable(s: PriceLineState, vr: number, bh: number): boolean {
    if (!o.visible || s.y === null || !Number.isFinite(s.y)) return false;
    const yDev = s.y * vr;
    return yDev >= 0 && yDev <= bh;
  }

  function signature(s: PriceLineState, f: ViewFrame['frame']): string {
    if (!drawable(s, f.vr, f.bitmapSize.height)) return 'hidden';
    return `${s.y}|${fillOf(s)}|${f.vr}|${f.bitmapSize.width}|${f.bitmapSize.height}`;
  }

  function build(s: PriceLineState, f: ViewFrame['frame']): readonly DisplayList[] {
    if (!drawable(s, f.vr, f.bitmapSize.height)) return EMPTY;
    // A horizontal line: width is the cross-axis (vr) extent; crisp y via the same
    // half-pixel odd-width shift the renderer recipe uses (§4.13 / study 05 §4.4).
    const w = crispWidth(o.lineWidth, f.vr);
    const py = crispStrokePos(s.y as number, f.vr, w);
    const fill = fillOf(s);
    builder.reset();
    builder.beginList('bitmap');
    const poly = builder.polyline(w, o.lineStyle, 'miter');
    poly.vertex(0, py, fill);
    poly.vertex(f.bitmapSize.width, py, fill);
    return builder.finish();
  }

  return {
    zBand: ZBand.AboveSeries,
    update(frame: ViewFrame): void {
      const s = provider();
      const next = signature(s, frame.frame);
      if (next === sig) return; // clean: keep the cached array reference
      sig = next;
      cached = build(s, frame.frame);
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
    // Horizontal line: distance is purely vertical; |y − lineY| ≤ lineWidth + 7
    // (media px, fixed pad), priority Point (study 06 §4.13). Misses when hidden.
    hitTest(_x: Coordinate, y: Coordinate): HitCandidate | null {
      const s = provider();
      if (!o.visible || s.y === null || !Number.isFinite(s.y)) return null;
      const d = Math.abs((y as number) - s.y);
      if (d > o.lineWidth + HIT_PAD) return null;
      return { distance: d, priority: HitPriority.Point, externalId: o.externalId };
    },
    axisLabel(): AxisLabel {
      return {
        coordinate: () => provider().y ?? Number.NaN,
        text: () => provider().text,
        textColor: () => fillOf(provider()),
        backColor: () => fillOf(provider()),
        visible: () => o.visible && o.axisLabelVisible && provider().y !== null,
      };
    },
  };
}
