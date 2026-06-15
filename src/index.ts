// traderzview · public entry (design 02 §3.2). The complete package root: the
// factories, the six series definitions + defineSeries, the time guards, and the full
// type surface (handles, options, events, the engine/gfx/seam re-exports). Everything
// is forwarded from `api` (architecture §3.1: the root imports `api`/`extras` only);
// `export type` keeps the type-only names erasable (verbatimModuleSyntax).

// --- values (design 02 §3.2) -------------------------------------------------------
export {
  createChart,
  createChartWith,
  canvasBackend,
  timeBehavior,
  version,
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
  ChartError,
  ChartErrorCode,
} from './api/index';

export type { DeepPartial, Unsubscribe, IPriceFormatter } from './api/index'; // core utility types (§3.2)

// --- handle interfaces (§7–§11) ----------------------------------------------------
export type {
  IChart,
  ISeries,
  ITimeScale,
  IPriceScale,
  IPane,
  IPriceLine,
  ChartEnvironment,
} from './api/index';

// --- options + data + event types (§4–§6, §13.1, §14) ------------------------------
export type {
  ChartOptions,
  LayoutOptions,
  GridOptions,
  CrosshairOptions,
  PriceScaleOptions,
  TimeScaleOptions,
  LocalizationOptions,
  PriceLineOptions,
  SeriesType,
  SeriesDefinition,
  WhitespaceData,
  BarsInfo,
  LogicalRange,
  TimeRange,
  MismatchDirection,
  MouseEventParams,
  MouseEventHandler,
  HoverInfo,
  PointerEventData,
  StoreDiff,
  Time,
  UTCTimestamp,
  BusinessDay,
} from './api/index';

// --- the engine / gfx / seam re-exports (§3.2 / §12 / §13.3 / §13.5 / §13.6) -------
export type {
  SeriesKind,
  SeriesDataContract,
  ItemBuffer,
  ItemWindow,
  PlotStoreView,
  HorzGeometry,
  PriceConverter,
  SceneSource,
  ViewFrame,
  HitCandidate,
  Snapshot,
  IRenderBackend,
  IHorzScaleBehavior,
  HorzPoint,
  HorzScaleOptionGroups,
  TimeScaleFormatOptions,
  IPrimitive,
  PrimitiveSource,
  AxisLabel,
  AutoscaleInfo,
  IInteractionRouter,
  GestureEvent,
  GestureRegistration,
  GestureResponse,
  GestureKind,
  GesturePhase,
  SurfaceKind,
  IFrameScheduler,
  FrameCallback,
} from './api/index';
