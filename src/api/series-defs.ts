// traderzview · api — the six tree-shakable SeriesDefinition constants + the
// defineSeries custom-series entry point, the strict common-series defaults, and
// the Time type guards (spec 02 §13.1/§13.2/§6.9, §4.1). A definition is the pair
// {contract (data half, §4.5.1), kind (view half, §6)} the user passes to
// addSeries; the data contract comes from `data`, the view kind from a `views`
// factory. Kinds are options-derived (every create*Kind takes live options), so the
// definition carries `createKind(options)` — the §13.2 `kind` field made a factory.
// Pure data + type guards; no DOM, no backend (headless).
import type { SeriesDataContract } from '../data';
import type { Time, BusinessDay, UTCTimestamp } from '../data';
import { singleValueContract, barContract } from '../data';
import type { SeriesKind } from '../views';
import {
  createLineKind,
  createAreaKind,
  createBaselineKind,
  createHistogramKind,
  createBarKind,
  createCandlestickKind,
} from '../views';
import type { SeriesOptions } from '../model';
import { candlestickNormalizeOptions } from '../model';

// --- SeriesType (§4.2 / §8.1) — lowercase kebab string union, no enum -------------

/** Every built-in series tag plus 'custom' (spec 02 §8.1 / §4.2 table). */
export type SeriesType =
  | 'line'
  | 'area'
  | 'baseline'
  | 'bar'
  | 'candlestick'
  | 'histogram'
  | 'custom';

// --- SeriesDefinition (§13.2) ------------------------------------------------------

/** A series definition: the tree-shakable {contract, kind} pair passed to
 *  `addSeries` (spec 02 §13.2). `contract` is the data half (lane layout, §4.5.1);
 *  `createKind` builds the view half from live merged options (every built-in
 *  `create*Kind` is options-derived — the §13.2 `kind` field is a factory here, the
 *  only faithful shape given options flow into the kind). `defaultOptions` are the
 *  style defaults the library merges the commons into; `normalizeOptions` is the
 *  optional shorthand-expansion hook (only candlestick declares one, §5.3.3). */
export interface SeriesDefinition<K extends SeriesType, TItem, TOptions> {
  readonly type: K;
  readonly defaultOptions: TOptions;
  readonly contract: SeriesDataContract<TItem>;
  readonly createKind: (options: SeriesOptions) => SeriesKind<unknown>;
  readonly normalizeOptions?: (patch: Record<string, unknown>) => void;
}

/** Adapt one of the five bare-kind `views` factories (Line/Baseline/Histogram/Bar/
 *  Candlestick — each `(SeriesOptions) => <Item>Kind`) to the uniform
 *  `(options) => SeriesKind<unknown>` shape. The per-Item generic is internal to
 *  views; the definition carries the engine's erased `SeriesKind<unknown>`. */
function kindFactory(
  factory: (options: SeriesOptions) => unknown,
): (options: SeriesOptions) => SeriesKind<unknown> {
  return (options) => factory(options) as SeriesKind<unknown>;
}

/** Area's `views` factory is the lone outlier: it takes `Partial<AreaKindOptions>`
 *  (not the loose `SeriesOptions` bag) and returns `{kind, buffer}` rather than a
 *  bare kind. Adapt both ends — the loose options bag flows in (structurally a
 *  superset of the partial), and we unwrap `.kind` — to the uniform factory shape. */
function areaKindFactory(): (options: SeriesOptions) => SeriesKind<unknown> {
  type AreaArg = Parameters<typeof createAreaKind>[0];
  return (options) => createAreaKind(options as unknown as AreaArg).kind as SeriesKind<unknown>;
}

// --- the six built-in defaults (§6.9 commons + §6.10 per-type style) ---------------

/** The strict common-series defaults (spec 02 §6.9), merged into every definition's
 *  style defaults by the library (§13.2). Exported for custom-series authors who
 *  build their own strict defaults on top (§3.2; study 09 `customSeriesDefaultOptions`). */
export const defaultSeriesOptions = {
  title: '',
  visible: true,
  lastValueVisible: true,
  priceLineVisible: true,
  priceLineSource: 'last-bar',
  priceLineWidth: 1,
  priceLineColor: '',
  priceLineStyle: 'dashed',
  baseLineVisible: true,
  baseLineWidth: 1,
  baseLineColor: '#B2B5BE',
  baseLineStyle: 'solid',
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  hitTestTolerance: 3,
} as const;

/** The §6.10 Line style block — shared verbatim by Area and Baseline (each "plus the
 *  Line block above"). Spread into those definitions' defaults so all three carry it. */
const lineStyleDefaults = {
  color: '#2196f3',
  lineStyle: 'solid',
  lineWidth: 3,
  lineType: 'simple',
  lineVisible: true,
  pointMarkersVisible: false,
  pointMarkersRadius: undefined,
  crosshairMarkerVisible: true,
  crosshairMarkerRadius: 4,
  crosshairMarkerBorderColor: '',
  crosshairMarkerBorderWidth: 2,
  crosshairMarkerBackgroundColor: '',
  lastPriceAnimation: 'disabled',
} as const;

// --- the six built-in SeriesDefinition constants (separate exports, §3.2) ----------

/** Line: 1-lane single-value data + the Line view kind (§6.10). */
export const LineSeries: SeriesDefinition<'line', { time: Time; value: number }, typeof lineStyleDefaults> = {
  type: 'line',
  defaultOptions: { ...lineStyleDefaults },
  contract: singleValueContract as SeriesDataContract<{ time: Time; value: number }>,
  createKind: kindFactory(createLineKind),
};

/** Area: 1-lane single-value data + the Area view kind (Line block + fill, §6.10). */
export const AreaSeries: SeriesDefinition<
  'area',
  { time: Time; value: number },
  typeof lineStyleDefaults & {
    topColor: string; bottomColor: string; invertFilledArea: boolean;
    relativeGradient: boolean; lineColor: string;
  }
> = {
  type: 'area',
  defaultOptions: {
    ...lineStyleDefaults,
    topColor: 'rgba( 46, 220, 135, 0.4)',
    bottomColor: 'rgba( 40, 221, 100, 0)',
    invertFilledArea: false,
    relativeGradient: false,
    lineColor: '#33D778',
  },
  contract: singleValueContract as SeriesDataContract<{ time: Time; value: number }>,
  createKind: areaKindFactory(),
};

/** Baseline: 1-lane single-value data + the Baseline view kind (Line block + the
 *  baseValue / two-sided fill block, §6.10). */
export const BaselineSeries: SeriesDefinition<
  'baseline',
  { time: Time; value: number },
  typeof lineStyleDefaults & {
    baseValue: { type: 'price'; price: number }; relativeGradient: boolean;
    topFillColor1: string; topFillColor2: string; topLineColor: string;
    bottomFillColor1: string; bottomFillColor2: string; bottomLineColor: string;
  }
> = {
  type: 'baseline',
  defaultOptions: {
    ...lineStyleDefaults,
    baseValue: { type: 'price', price: 0 },
    relativeGradient: false,
    topFillColor1: 'rgba(38, 166, 154, 0.28)',
    topFillColor2: 'rgba(38, 166, 154, 0.05)',
    topLineColor: 'rgba(38, 166, 154, 1)',
    bottomFillColor1: 'rgba(239, 83, 80, 0.05)',
    bottomFillColor2: 'rgba(239, 83, 80, 0.28)',
    bottomLineColor: 'rgba(239, 83, 80, 1)',
  },
  contract: singleValueContract as SeriesDataContract<{ time: Time; value: number }>,
  createKind: kindFactory(createBaselineKind),
};

/** Histogram: 1-lane single-value data + the Histogram view kind (§6.10). */
export const HistogramSeries: SeriesDefinition<
  'histogram',
  { time: Time; value: number },
  { color: string; base: number }
> = {
  type: 'histogram',
  defaultOptions: { color: '#26a69a', base: 0 },
  contract: singleValueContract as SeriesDataContract<{ time: Time; value: number }>,
  createKind: kindFactory(createHistogramKind),
};

/** Bar: 4-lane OHLC data + the Bar view kind (§6.10). */
export const BarSeries: SeriesDefinition<
  'bar',
  { time: Time; open: number; high: number; low: number; close: number },
  { upColor: string; downColor: string; openVisible: boolean; thinBars: boolean }
> = {
  type: 'bar',
  defaultOptions: { upColor: '#26a69a', downColor: '#ef5350', openVisible: true, thinBars: true },
  contract: barContract as SeriesDataContract<{
    time: Time; open: number; high: number; low: number; close: number;
  }>,
  createKind: kindFactory(createBarKind),
};

/** Candlestick: 4-lane OHLC data + the Candlestick view kind, plus the borderColor/
 *  wickColor shorthand-expansion hook (§5.3.3 / §6.10). */
export const CandlestickSeries: SeriesDefinition<
  'candlestick',
  { time: Time; open: number; high: number; low: number; close: number },
  {
    upColor: string; downColor: string; wickVisible: boolean; borderVisible: boolean;
    borderUpColor: string; borderDownColor: string; wickUpColor: string; wickDownColor: string;
  }
> = {
  type: 'candlestick',
  defaultOptions: {
    upColor: '#26a69a',
    downColor: '#ef5350',
    wickVisible: true,
    borderVisible: true,
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  },
  contract: barContract as SeriesDataContract<{
    time: Time; open: number; high: number; low: number; close: number;
  }>,
  createKind: kindFactory(createCandlestickKind),
  normalizeOptions: candlestickNormalizeOptions,
};

// --- defineSeries: the only custom-series entry point (§13.2) ----------------------

/** Compose a custom `SeriesDefinition` from a {contract, kind} pair (spec 02 §13.2).
 *  The author's `TItem`/`TOptions` flow through with no casts; the result is tagged
 *  `'custom'` and `addSeries` maps it through the §8.1 aliases. `kind` is the live
 *  `SeriesKind` instance (custom authors build it directly, not via a views factory),
 *  so `createKind` returns it ignoring options — the engine's uniform factory shape. */
export function defineSeries<TItem extends { time: unknown }, TOptions>(def: {
  type: string;
  defaultOptions: TOptions;
  contract: SeriesDataContract<TItem>;
  kind: SeriesKind<unknown>;
  normalizeOptions?: (patch: Record<string, unknown>) => void;
}): SeriesDefinition<'custom', TItem, TOptions> {
  return {
    type: 'custom',
    defaultOptions: def.defaultOptions,
    contract: def.contract,
    createKind: () => def.kind,
    normalizeOptions: def.normalizeOptions,
  };
}

// --- Time type guards (§13.1 / §4.1; study 09 §appendix) ---------------------------

/** True iff `time` is a `BusinessDay` — i.e. an object `{year,month,day}`, as opposed
 *  to a number (timestamp/seconds) or a `YYYY-MM-DD` string (spec 02 §13.1; study 09:
 *  "true iff the value is an object"). */
export function isBusinessDay(time: Time): time is BusinessDay {
  return typeof time === 'object' && time !== null;
}

/** True iff `time` is a `UTCTimestamp` — i.e. a number (unix seconds, §4.1; study 09:
 *  "true iff the value is a number"). */
export function isUTCTimestamp(time: Time): time is UTCTimestamp {
  return typeof time === 'number';
}
