// traderzview · api — public facade, identity maps, input normalization. Wires
// backend-canvas only inside the createChart factory.
// See dev-docs/design/02-public-api-spec.md.
// M9 — assembled incrementally; this index is the module's re-export point.

// --- event payloads + subscription machinery (spec 02 §14) -----------------------
export { EventHub, buildSeriesData, buildHoverInfo, surfaceStoreDiff } from './events';
export type {
  MouseEventParams,
  MouseEventHandler,
  HoverInfo,
  PointerEventData,
  StoreDiff,
  SeriesDataCandidate,
  HoverOwnership,
  HoverResolver,
} from './events';

// --- the ISeries handle facade (spec 02 §8) --------------------------------------
// `createSeriesApi` + the chart-owned ports (SeriesPort/IPriceScaleHandle/
// IPaneHandle) are wiring seams create-chart.ts consumes; the handle + data shapes
// (ISeries/IPriceLine/BarsInfo/MismatchDirection/…) are part of the §3.2 surface.
export { createSeriesApi } from './series';
// Core utility types that are part of the public surface (§3.2): patch shape + unsubscribe.
export type { DeepPartial, Unsubscribe } from '../core';
export type {
  ISeries,
  IPriceLine,
  IPriceFormatter,
  IPriceScaleHandle,
  IPaneHandle,
  SeriesPort,
  BarsInfo,
  LogicalRange,
  MismatchDirection,
  WhitespaceData,
  PriceLineOptions,
} from './series';

// --- the ITimeScale handle facade (spec 02 §9) -----------------------------------
// `createTimeScaleApi` + the chart-owned `TimeScalePort` are wiring seams
// create-chart.ts consumes; the handle + range shapes (ITimeScale/TimeRange) are part
// of the §3.2 public surface. The chart builds this ONCE and caches it (§2 singleton);
// the full §9 navigation/conversion surface lives here, not in chart.ts's structural
// placeholder. This is the canonical `ITimeScale` export.
export { createTimeScaleApi } from './time-scale';
export type {
  ITimeScale,
  TimeRange,
  TimeScalePort,
  TimeScaleApiDeps,
} from './time-scale';

// --- the IChart facade (spec 02 §7) ----------------------------------------------
// `createChartApi` is the join point: it owns the §2 identity caches + the §16.5
// disposed-guard, delegating model mutation + sibling-handle construction to the
// injected ChartWiring (create-chart.ts supplies the real one). The handle interfaces
// (IChart/IPane) are part of the §3.2 public surface; ITimeScale is re-exported above
// from ./time-scale and IPriceScale below from ./price-scale (their full §9/§10
// surfaces), not from ./chart's structural placeholders.
export { createChartApi } from './chart';
export type {
  IChart,
  ChartApiDeps,
  ChartHostFacade,
  ChartWiring,
  DisposedCell,
} from './chart';

// --- the IPriceScale handle facade (spec 02 §10) ---------------------------------
// The canonical full §10 IPriceScale lives here (chart.ts carries only a structural
// placeholder for its return type). createPriceScaleApi + PriceScalePort are the
// chart-owned wiring seams create-chart.ts consumes.
export { createPriceScaleApi } from './price-scale';
export type { IPriceScale, PriceScalePort, PriceScaleApiDeps } from './price-scale';

// --- the IPane handle facade (spec 02 §11) ---------------------------------------
// The full §11 IPane handle lives here (chart.ts carries only a structural placeholder
// for its return type); create-chart wires PanePort over the model Pane.
export { createPaneApi } from './pane';
export type { IPane, PanePort } from './pane';

// --- the IPriceLine wiring facade (spec 02 §11.1) --------------------------------
// IPriceLine + PriceLineOptions are owned by ./series (re-exported above); this file
// owns only the factory + the chart-wiring port/deps (single source of truth).
export { createPriceLineApi } from './price-line';
export type { PriceLinePort, PriceLineApiDeps } from './price-line';

// --- the join point: factories + version + the §3.2 engine/gfx/seam re-exports ----
export { createChart, createChartWith, canvasBackend, timeBehavior, version } from './create-chart';
export type { ChartEnvironment } from './create-chart';
export * from './re-exports';

// --- the six series definitions + defineSeries + the §4.1 time guards (spec §13) --
export {
  LineSeries,
  AreaSeries,
  BaselineSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  defineSeries,
  defaultSeriesOptions,
  isBusinessDay,
  isUTCTimestamp,
} from './series-defs';
export type { SeriesType, SeriesDefinition } from './series-defs';

// --- the error taxonomy (spec 02 §16) --------------------------------------------
export { ChartError, ChartErrorCode } from './errors';
