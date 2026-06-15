// traderzview · api — the ISeries facade (spec 02 §8). A THIN wrapper over the
// model Series + chart-owned ports: it maps each handle method to a model/host call
// and owns NO business logic the model already has. Identity law (§2): one handle
// per series for its life, price-line handles cached per IPriceLine. Disposed-guard
// (§16.5): after the chart disposes, every method throws ChartError('disposed').
import type {
  BarPrice,
  Coordinate,
  DeepPartial,
  DeepReadonly,
  Logical,
  Unsubscribe,
} from '../core';
import type { PlotStoreView } from '../data';
import type { Series, SeriesOptions, IPrimitive } from '../model';
import { ChartErrorCode, throwChartError } from './errors';
import { EventHub, type StoreDiff } from './events';
import { normalizeSeriesPatch, type NormalizeOptionsHook } from './options';
import type { SeriesType } from './series-defs';

// --- supporting public shapes (§4.2 / §13.1 / §11.1) -------------------------------

/** Nearest-match direction for `dataByIndex` (§4.2 / §8.2). String union, no enum. */
export type MismatchDirection = 'none' | 'nearest-left' | 'nearest-right';

/** A whitespace row: a time slot that draws nothing (§13.1). */
export interface WhitespaceData<H = unknown> {
  time: H;
  customValues?: Record<string, unknown>;
}

/** Inclusive fractional logical range — what autoscale / barsInLogicalRange take (§8.2). */
export interface LogicalRange {
  from: Logical;
  to: Logical;
}

/** Bars-in-range info (§8.2). `from`/`to` present iff the series has ≥1 bar inside. */
export interface BarsInfo<H = unknown> {
  barsBefore: number;
  barsAfter: number;
  from?: H;
  to?: H;
}

/** A price formatter the legend consumes (§8.2). */
export interface IPriceFormatter {
  format(price: number): string;
}

/** Options of a price line (§6.11); `price` required at creation. */
export interface PriceLineOptions {
  price: number;
  color?: string;
  lineStyle?: string;
  lineWidth?: number;
  lineVisible?: boolean;
  axisLabelVisible?: boolean;
  title?: string;
  axisLabelColor?: string;
  axisLabelTextColor?: string;
  id?: string;
}

/** A price-line handle (§11.1). Cached identity per createPriceLine call (§2). */
export interface IPriceLine {
  applyOptions(patch: DeepPartial<PriceLineOptions>): void;
  options(): DeepReadonly<PriceLineOptions>;
}

// --- the public ISeries interface (§8.2) -------------------------------------------
// Loosely-typed handles stay short (`ISeries<SeriesType, H>`); defineSeries authors
// get full item/option inference via the trailing defaulted parameters (§8.1).

export interface ISeries<
  K extends SeriesType = SeriesType,
  H = unknown,
  TItem = unknown,
  TOptions = SeriesOptions,
> {
  seriesType(): K;

  // data — §15 owns validation
  setData(items: readonly (TItem | WhitespaceData<H>)[]): void;
  update(item: TItem | WhitespaceData<H>, options?: { historical?: boolean }): void;
  data(): readonly (TItem | WhitespaceData<H>)[];
  dataByIndex(logical: number, mismatch?: MismatchDirection): TItem | null;
  barsInLogicalRange(range: LogicalRange | null): BarsInfo<H> | null;
  store(): PlotStoreView;

  // options
  applyOptions(patch: DeepPartial<TOptions>): void;
  options(): DeepReadonly<TOptions>;

  // coordinates (null on empty data / empty scale — kept convention §16.1)
  priceToCoordinate(price: number): Coordinate | null;
  coordinateToPrice(coordinate: number): BarPrice | null;
  priceFormatter(): IPriceFormatter;

  // placement
  priceScale(): IPriceScaleHandle; // follows the series at call time (§2)
  pane(): IPaneHandle;
  moveToPane(paneIndex: number): void;
  order(): number;
  setOrder(order: number): void;

  // price lines
  createPriceLine(options: PriceLineOptions): IPriceLine;
  removePriceLine(line: IPriceLine): void;
  priceLines(): readonly IPriceLine[];

  // legend support
  lastValue(globalLast?: boolean): { noData: true } | { noData: false; price: BarPrice; color: string };

  // primitives — §12
  attachPrimitive(p: IPrimitive): void;
  detachPrimitive(p: IPrimitive): void;

  // events — typed StoreDiff (§14.3)
  subscribeDataChanged(h: (diff: StoreDiff) => void): Unsubscribe;
  unsubscribeDataChanged(h: (diff: StoreDiff) => void): void;
}

// Opaque handle types the facade returns through its ports — the chart owns their
// concrete shape + identity cache (§2). Typed minimally here so series.ts never
// imports the chart/pane/price-scale facade siblings (no cycle, lean walls).
export interface IPriceScaleHandle {
  id(): string;
}
export interface IPaneHandle {
  index(): number;
}

// --- the chart-owned ports (injected by create-chart.ts) ---------------------------

/**
 * Everything the series facade delegates to. The chart wires these so the facade
 * stays a pure map-through: data goes to the store/timeline, coordinate math to the
 * geometry, scale/pane lookups return the chart's CACHED handles (so priceScale()
 * follows the series and obeys §2), and disposed is the chart's shared flag.
 */
export interface SeriesPort<H = unknown> {
  /** The chart's shared disposed flag (§16.5) — true once chart.dispose() ran. */
  isDisposed(): boolean;

  // data pipeline (§15 validation lives in `data`; the port forwards the diff)
  setData(items: readonly unknown[]): void;
  update(item: unknown, historical: boolean): void;
  data(): readonly unknown[];
  dataByIndex(logical: number, mismatch: MismatchDirection): unknown | null;
  barsInLogicalRange(range: LogicalRange | null): BarsInfo<H> | null;
  store(): PlotStoreView;

  // coordinate conversions (null on empty data/scale — the model/geometry returns it)
  priceToCoordinate(price: number): Coordinate | null;
  coordinateToPrice(coordinate: number): BarPrice | null;
  priceFormatter(): IPriceFormatter;

  // placement — scale()/pane() return the chart's cached handles (§2)
  priceScale(): IPriceScaleHandle;
  pane(): IPaneHandle;
  moveToPane(paneIndex: number): void;
  order(): number;
  setOrder(order: number): void;

  // primitive re-homing on options-driven scale change is the registry's job (§12);
  // the facade just forwards attach/detach + re-applies options through the model.
  optionsChanged(): void;

  // price lines — the chart plumbs the model price-line source + identity cache
  createPriceLine(options: PriceLineOptions): IPriceLine;
  removePriceLine(line: IPriceLine): void;
  priceLines(): readonly IPriceLine[];

  // legend last value (resolved color), or null when empty
  lastValue(globalLast: boolean): { price: number; color: string } | null;

  /** The per-series dataChanged hub (the chart fires it as diffs arrive). */
  dataChanged: EventHub<[StoreDiff]>;
}

// --- the facade factory ------------------------------------------------------------

/**
 * Build the cached ISeries handle for one model Series (§2 identity: the chart calls
 * this once per addSeries and caches the result for the series' life). Every method
 * guards the shared disposed flag first (§16.5), then maps to the model or a port —
 * the candlestick shorthand + minMove→precision re-run on applyOptions via the
 * series-defs hook (§5.3.2/§5.3.3). `priceScale()` resolves through the port at CALL
 * time so it follows the series across moveToPane / priceScaleId changes (§2/§8.3).
 */
export function createSeriesApi<
  K extends SeriesType = SeriesType,
  H = unknown,
  TItem = unknown,
  TOptions = SeriesOptions,
>(
  type: K,
  model: Series,
  port: SeriesPort<H>,
  normalizeHook?: NormalizeOptionsHook,
): ISeries<K, H, TItem, TOptions> {
  const guard = (): void => {
    if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
  };

  const api: ISeries<K, H, TItem, TOptions> = {
    seriesType(): K {
      guard();
      return type;
    },

    // --- data ---------------------------------------------------------------------
    setData(items): void {
      guard();
      port.setData(items as readonly unknown[]);
    },
    update(item, options): void {
      guard();
      port.update(item, options?.historical ?? false);
    },
    data(): readonly (TItem | WhitespaceData<H>)[] {
      guard();
      return port.data() as readonly (TItem | WhitespaceData<H>)[];
    },
    dataByIndex(logical, mismatch): TItem | null {
      guard();
      return port.dataByIndex(logical, mismatch ?? 'none') as TItem | null;
    },
    barsInLogicalRange(range): BarsInfo<H> | null {
      guard();
      return port.barsInLogicalRange(range);
    },
    store(): PlotStoreView {
      guard();
      return port.store();
    },

    // --- options ------------------------------------------------------------------
    // The api boundary runs the §5.3 normalizations (minMove→precision §5.3.2 AND the
    // candlestick borderColor/wickColor shorthand via `normalizeHook` §5.3.3 — both
    // re-run on every applyOptions, fixing the reference's creation-only staleness);
    // the MODEL owns the merge + its own effective defaults (the leaf-null reset
    // target), so the facade forwards the normalized patch and never re-merges here.
    applyOptions(patch): void {
      guard();
      const normalized = normalizeSeriesPatch(patch as Record<string, unknown>, normalizeHook);
      model.applyOptions(normalized as DeepPartial<SeriesOptions>);
      port.optionsChanged();
    },
    options(): DeepReadonly<TOptions> {
      guard();
      return model.options() as DeepReadonly<TOptions>;
    },

    // --- coordinates --------------------------------------------------------------
    priceToCoordinate(price): Coordinate | null {
      guard();
      return port.priceToCoordinate(price);
    },
    coordinateToPrice(coordinate): BarPrice | null {
      guard();
      return port.coordinateToPrice(coordinate);
    },
    priceFormatter(): IPriceFormatter {
      guard();
      return port.priceFormatter();
    },

    // --- placement (priceScale resolves NOW so it follows the series, §2/§8.3) ----
    priceScale(): IPriceScaleHandle {
      guard();
      return port.priceScale();
    },
    pane(): IPaneHandle {
      guard();
      return port.pane();
    },
    moveToPane(paneIndex): void {
      guard();
      port.moveToPane(paneIndex);
    },
    order(): number {
      guard();
      return port.order();
    },
    setOrder(order): void {
      guard();
      port.setOrder(order);
    },

    // --- price lines (identity cached per IPriceLine in the port, §2) -------------
    createPriceLine(options): IPriceLine {
      guard();
      return port.createPriceLine(options);
    },
    removePriceLine(line): void {
      guard();
      port.removePriceLine(line);
    },
    priceLines(): readonly IPriceLine[] {
      guard();
      return port.priceLines();
    },

    // --- legend -------------------------------------------------------------------
    lastValue(globalLast): { noData: true } | { noData: false; price: BarPrice; color: string } {
      guard();
      const lv = port.lastValue(globalLast ?? false);
      if (lv === null) return { noData: true };
      return { noData: false, price: lv.price as BarPrice, color: lv.color };
    },

    // --- primitives ---------------------------------------------------------------
    attachPrimitive(p): void {
      guard();
      model.attachPrimitive(p);
    },
    detachPrimitive(p): void {
      guard();
      model.detachPrimitive(p);
    },

    // --- events -------------------------------------------------------------------
    subscribeDataChanged(h): Unsubscribe {
      guard();
      return port.dataChanged.subscribe(h);
    },
    unsubscribeDataChanged(h): void {
      guard();
      port.dataChanged.unsubscribe(h);
    },
  };

  return api;
}
