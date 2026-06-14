// The Series model object (architecture §4.6 series row; study 06 §3 is the spec of
// record). It owns the merged series options + a per-kind `normalizeOptions` hook,
// consumes `StoreDiff`s to keep last-value / price-line state current, resolves the
// per-type bar colors (the §4.3 precedence: per-point override → up/down or
// above/below-base → option default), contributes an autoscale range with
// MAX-merged margins through the ONE merge fn (`mergeMargins`, architecture §9.2.3),
// and holds the GENERIC per-series `IPrimitive[]` attachment list (the §9.1 slot-4
// seam) — with NO plugin-specific state on Series (architecture §4.6: markers etc.
// are plugins that attach through this same list, not Series fields).
//
// HARD walls (architecture §3.1): model imports only core / fmt / data / sibling
// model files; NEVER gfx/views/host/DOM. `PrimitiveSource.source` is typed `unknown`
// here precisely because the concrete `SceneSource` is a `gfx` type the model may
// not name — the host wires the real type at the views/host layer.
import { mergeOptions, type DeepPartial, type TimeIndex } from '../core';
import type { PlotStoreView, StoreDiff } from '../data';
import { mergeMargins, type AutoscaleMargins } from './price-scale/autoscale';

/** The built-in series kinds (design 02 §8.1). A string union, not an enum. */
export type SeriesKindName =
  | 'line'
  | 'area'
  | 'baseline'
  | 'histogram'
  | 'bar'
  | 'candlestick'
  | 'custom';

/** The autoscale contribution shape — the verbatim public hook payload (design 02
 *  §12.3 / §13.4; architecture §9.2.3). `margins` are pixel margins, MAX-merged. */
export interface AutoscaleInfo {
  priceRange: { minValue: number; maxValue: number } | null;
  margins?: { above: number; below: number };
}

/** The verbatim autoscaleInfoProvider seam (design 02 §13.4) — kept exactly:
 *  `(base: () => AutoscaleInfo | null) => AutoscaleInfo | null`. */
export type AutoscaleInfoProvider = (
  baseImplementation: () => AutoscaleInfo | null,
) => AutoscaleInfo | null;

/** Auto-placed primitive axis label (design 02 §12). Plain getters; no gfx. */
export interface AxisLabel {
  coordinate(): number;
  fixedCoordinate?(): number | undefined;
  text(): string;
  textColor(): string;
  backColor(): string;
  visible?(): boolean;
  tickVisible?(): boolean;
}

/** A scene source tagged with its destination surface (design 02 §12 / arch §9.1
 *  slot 4). `source` is `unknown` because the concrete `SceneSource` is a `gfx`
 *  type forbidden to `model` (§3.1) — the views/host layer narrows it. */
export interface PrimitiveSource {
  target: 'pane' | 'price-axis' | 'time-axis';
  axis?: 'left' | 'right';
  source: unknown;
}

/** The unified per-series primitive (architecture §4.6 / §9.1 slot 4; design 02
 *  §12.3). Only the model-relevant hooks are named here — the lifecycle
 *  (`attached`/`detached`) is host-driven and out of model scope. */
export interface IPrimitive {
  /** Extra range + MAX-merged margins for autoscale (series-attached, per frame). */
  autoscale?(range: LogicalRange): AutoscaleInfo | null;
  /** Scene sources to register (plumbed through to views; opaque to the model). */
  sources?(): readonly PrimitiveSource[];
  /** Auto-placed price-axis labels (overlap-shifted like series labels). */
  priceAxisLabels?(): readonly AxisLabel[];
  /** Auto-placed time-axis labels. */
  timeAxisLabels?(): readonly AxisLabel[];
}

/** Inclusive logical index range handed to autoscale (the visible bars). */
export interface LogicalRange {
  readonly from: TimeIndex;
  readonly to: TimeIndex;
}

/** The minimal per-point color overrides a colorer may consult (study 06 §2/§4.3).
 *  These come from the store's sparse color sidecar; the host passes the relevant
 *  fields in — the model never reaches into the sidecar itself. */
export interface PointColorOverrides {
  color?: string;
  lineColor?: string;
  borderColor?: string;
  wickColor?: string;
}

/** A bar's open/close — all a colorer needs for the up/down & above/below choice. */
export interface ColorerBar {
  readonly open: number;
  readonly close: number;
}

/** The resolved colors for one bar (study 06 §4.3). Only `barColor` is universal;
 *  candlesticks additionally resolve border + wick. */
export interface BarColors {
  barColor: string;
  barBorderColor?: string;
  barWickColor?: string;
}

/** Loosely-typed merged options — the strict per-type interfaces live at the API
 *  boundary (design 02 §6.10). The model owns the merged bag generically. */
export type SeriesOptions = Record<string, unknown>;

/** The candlestick `normalizeOptions` hook (study 06 §3 "fillUpDownCandlesticksColors";
 *  design 02 §5.3.3 / §6.10): the write-only `borderColor`/`wickColor` shorthands fan
 *  out to both up/down variants and are then DROPPED (never stored, unlike the
 *  reference which kept stale aggregates). Runs at creation AND on every applyOptions. */
export function candlestickNormalizeOptions(patch: Record<string, unknown>): void {
  if (typeof patch.borderColor === 'string') {
    if (patch.borderUpColor === undefined) patch.borderUpColor = patch.borderColor;
    if (patch.borderDownColor === undefined) patch.borderDownColor = patch.borderColor;
    delete patch.borderColor;
  }
  if (typeof patch.wickColor === 'string') {
    if (patch.wickUpColor === undefined) patch.wickUpColor = patch.wickColor;
    if (patch.wickDownColor === undefined) patch.wickDownColor = patch.wickColor;
    delete patch.wickColor;
  }
}

/** Resolve the effective color(s) of one bar (study 06 §4.3). The precedence is
 *  always: per-point override → up/down (OHLC) or above/below-base → option default.
 *  Baseline is the documented exception — it uses ONLY close-vs-baseValue against
 *  the option colors and IGNORES per-point overrides (study 06 §4.3 / §5). */
export function resolveBarColors(
  kind: SeriesKindName,
  bar: ColorerBar,
  overrides: PointColorOverrides,
  options: SeriesOptions,
): BarColors {
  switch (kind) {
    case 'bar': {
      const isUp = bar.open <= bar.close;
      const upDown = (isUp ? options.upColor : options.downColor) as string;
      return { barColor: overrides.color ?? upDown };
    }
    case 'candlestick': {
      const isUp = bar.open <= bar.close;
      const barColor = overrides.color ?? ((isUp ? options.upColor : options.downColor) as string);
      const barBorderColor =
        overrides.borderColor ??
        ((isUp ? options.borderUpColor : options.borderDownColor) as string);
      const barWickColor =
        overrides.wickColor ?? ((isUp ? options.wickUpColor : options.wickDownColor) as string);
      return { barColor, barBorderColor, barWickColor };
    }
    case 'area': {
      // Area's bar/line color is the lineColor (study 06 §4.3).
      return { barColor: overrides.lineColor ?? (options.lineColor as string) };
    }
    case 'baseline': {
      // options-only, no per-point override; above = close >= baseValue.price.
      const baseValue = (options.baseValue as { price?: number } | undefined)?.price ?? 0;
      const above = bar.close >= baseValue;
      return { barColor: (above ? options.topLineColor : options.bottomLineColor) as string };
    }
    case 'line':
    case 'histogram':
    case 'custom':
    default:
      return { barColor: overrides.color ?? (options.color as string) };
  }
}

/** The last-value state the price line / axis label track (study 06 §3 / §4.14). */
export interface LastValue {
  readonly index: TimeIndex;
  readonly price: number;
}

export interface SeriesInit {
  readonly kind: SeriesKindName;
  /** Per-type style defaults already merged with the commons (design 02 §13.2). */
  readonly defaultOptions: SeriesOptions;
  /** Per-kind shorthand-expansion hook (study 06 §3); applied at creation + apply. */
  readonly normalizeOptions?: (patch: Record<string, unknown>) => void;
}

export class Series {
  readonly #kind: SeriesKindName;
  readonly #defaults: SeriesOptions;
  readonly #normalize?: (patch: Record<string, unknown>) => void;
  #options: SeriesOptions;
  #lastValue: LastValue | null = null;
  readonly #primitives: IPrimitive[] = [];

  constructor(init: SeriesInit) {
    this.#kind = init.kind;
    this.#normalize = init.normalizeOptions;
    // Normalize the defaults too, so creation and applyOptions share one path
    // (study 06 §3 / design 02 §5.3.3 — the reference's apply path was dead code).
    const defaults = { ...init.defaultOptions };
    this.#normalize?.(defaults);
    this.#defaults = defaults;
    this.#options = { ...defaults };
  }

  kind(): SeriesKindName {
    return this.#kind;
  }

  /** A snapshot of the merged options — never the live object (architecture §4.3). */
  options(): SeriesOptions {
    return { ...this.#options };
  }

  /** Apply an options patch through the ONE path: normalize → merge (study 06 §3). */
  applyOptions(patch: DeepPartial<SeriesOptions>): void {
    const local = { ...(patch as Record<string, unknown>) };
    this.#normalize?.(local);
    this.#options = mergeOptions(this.#options, local as DeepPartial<SeriesOptions>, this.#defaults);
  }

  // --- StoreDiff consumption → last-value state (architecture §4.5 / study 06 §3) -

  /** Consume a `StoreDiff` to keep last-value / price-line state current. Every diff
   *  kind ends with "the last plot row changed", so we simply re-read the store's
   *  tail (the cheap path; a fuller implementation patches geometry per kind). */
  applyDiff(store: PlotStoreView, _diff: StoreDiff): void {
    const len = store.length;
    if (len === 0) {
      this.#lastValue = null;
      return;
    }
    const i = len - 1;
    this.#lastValue = { index: store.timeIndex(i), price: store.current(i) };
  }

  /** The current last value (price-line / axis-label source), or null when empty. */
  lastValue(): LastValue | null {
    return this.#lastValue;
  }

  /** The price-line color (study 06 §3): `priceLineColor` option when non-empty,
   *  else the last bar's resolved color. The last bar's open is unknown to the
   *  last-value cache, so single-value kinds (open == close) resolve correctly; for
   *  bar-likes the host passes the resolved color in via the colorer at draw time —
   *  here we derive the option default for the common single-value case. */
  priceLineColor(lastBarColor?: string): string {
    const opt = this.#options.priceLineColor;
    if (typeof opt === 'string' && opt !== '') return opt;
    if (lastBarColor !== undefined) return lastBarColor;
    return (this.#options.color as string) ?? '';
  }

  // --- autoscale provider (architecture §9.2.3 / study 06 §4.16) -----------------

  /** Contribute an autoscale range + MAX-merged margins. The base implementation
   *  scans the store's data range and merges every attached primitive's
   *  contribution through the ONE merge fn (`mergeMargins`); margins are MAX-merged
   *  and ranges unioned. A user `autoscaleInfoProvider` (design 02 §13.4) wraps the
   *  whole base computation VERBATIM — it receives `base` as a thunk it may call. */
  autoscaleInfo(store: PlotStoreView, range: LogicalRange): AutoscaleInfo | null {
    const base = (): AutoscaleInfo | null => this.#baseAutoscaleInfo(store, range);
    const provider = this.#options.autoscaleInfoProvider as AutoscaleInfoProvider | undefined;
    return typeof provider === 'function' ? provider(base) : base();
  }

  #baseAutoscaleInfo(store: PlotStoreView, range: LogicalRange): AutoscaleInfo | null {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let any = false;
    for (let i = 0; i < store.length; i++) {
      const lo = store.min(i);
      const hi = store.max(i);
      if (lo < min) min = lo;
      if (hi > max) max = hi;
      any = true;
    }

    const margins: AutoscaleMargins[] = [];
    let priceRange: { minValue: number; maxValue: number } | null = any
      ? { minValue: min, maxValue: max }
      : null;

    for (const p of this.#primitives) {
      const info = p.autoscale?.(range);
      if (!info) continue;
      if (info.priceRange) {
        priceRange = priceRange
          ? {
              minValue: Math.min(priceRange.minValue, info.priceRange.minValue),
              maxValue: Math.max(priceRange.maxValue, info.priceRange.maxValue),
            }
          : { minValue: info.priceRange.minValue, maxValue: info.priceRange.maxValue };
      }
      if (info.margins) margins.push(info.margins);
    }

    if (priceRange === null) return null;
    // MAX-merge with a zero baseline so the result is always defined (the ONE merge
    // fn — architecture §9.2.3). The series itself contributes no extra margins.
    const merged = mergeMargins([{ above: 0, below: 0 }, ...margins]);
    return { priceRange, margins: { above: merged.above, below: merged.below } };
  }

  // --- generic primitive-attachment list (architecture §4.6 / §9.1 slot 4) -------

  /** Attach a primitive. There is deliberately NO plugin-specific slot on Series:
   *  markers/watermarks/etc. all attach through this one generic list. */
  attachPrimitive(primitive: IPrimitive): void {
    this.#primitives.push(primitive);
  }

  /** Detach a primitive; a no-op if it was never attached. */
  detachPrimitive(primitive: IPrimitive): void {
    const i = this.#primitives.indexOf(primitive);
    if (i >= 0) this.#primitives.splice(i, 1);
  }

  primitives(): readonly IPrimitive[] {
    return this.#primitives.slice();
  }

  /** Flatten every attached primitive's scene sources (plumbing to views). */
  primitiveSources(): readonly PrimitiveSource[] {
    const out: PrimitiveSource[] = [];
    for (const p of this.#primitives) {
      const srcs = p.sources?.();
      if (srcs) out.push(...srcs);
    }
    return out;
  }

  /** Flatten every attached primitive's price-axis labels (back-label plumbing). */
  primitivePriceAxisLabels(): readonly AxisLabel[] {
    const out: AxisLabel[] = [];
    for (const p of this.#primitives) {
      const labels = p.priceAxisLabels?.();
      if (labels) out.push(...labels);
    }
    return out;
  }
}
