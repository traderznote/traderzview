// traderzview · model — headless chart state: panes, price/time scales,
// crosshair, series. Never imports gfx (architecture §3.1). Every other module
// imports `model` ONLY through this index (dependency-cruiser bans deep imports).
// `export type` vs `export` is split per verbatimModuleSyntax.

// --- registry, invalidation model (chart-model.ts, §4.3/§4.4) --------------------
export { ChartModel, UpdateLevel, createMask, emptyMask, mergeMasks, invalidationLevelForPaths } from './chart-model';
export type { UpdateMask, MaskInit, InvalidateCallback, ChartModelInit } from './chart-model';

// --- panes (pane.ts / pane-manager.ts, §4.6) -------------------------------------
export { Pane, PriceScale } from './pane';
export type { PaneSeries } from './pane';
export { PaneManager } from './pane-manager';

// --- shared: ids, defaults, option-group re-exports, value-object builders -------
export {
  formatPaneId,
  buildHorzGeometry,
  buildPriceConverter,
  DEFAULT_CHART_OPTIONS,
  DEFAULT_TIME_SCALE_OPTIONS,
  DEFAULT_PRICE_SCALE_OPTIONS,
} from './shared';
export type {
  PaneId,
  ChartOptions,
  LayoutOptions,
  GridOptions,
  CrosshairOptions,
  PriceScaleOptions,
  PriceConverter,
  PriceConverterMode,
  PriceConverterParams,
  TimeScaleOptions,
  LocalizationOptions,
  HorzScaleOptionGroups,
} from './shared';

// --- series (series.ts, §4.6) ----------------------------------------------------
export { Series, resolveBarColors, candlestickNormalizeOptions } from './series';
export type {
  SeriesKindName,
  SeriesInit,
  SeriesOptions,
  AutoscaleInfo,
  AutoscaleInfoProvider,
  AxisLabel,
  PrimitiveSource,
  IPrimitive,
  LogicalRange as SeriesLogicalRange,
  PointColorOverrides,
  ColorerBar,
  BarColors,
  LastValue,
} from './series';

// --- crosshair (crosshair.ts, §4.6) ----------------------------------------------
export { Crosshair, CrosshairMode, magnetSnapPrice } from './crosshair';
export type {
  CrosshairPosition,
  MagnetCandidate,
  MagnetConverters,
  MagnetSnapArgs,
  HoverTarget,
} from './crosshair';

// --- time-scale: geometry value object, navigator, tick engine (§4.6) ------------
export { createHorzGeometry } from './time-scale/geometry';
export type { HorzGeometry, HorzGeometryParams, StrictRange, LogicalRange } from './time-scale/geometry';
export {
  reduceHorzCommands,
  createKineticAnimation,
  kineticTuningForBarSpacing,
  clampBarSpacing,
  clampRightOffset,
  compensateRightOffset,
  rightOffsetFromPixels,
  rightOffsetForPixels,
  fitContentWithPixels,
  KINETIC,
} from './time-scale/navigator';
export type {
  HorzScaleCommand,
  HorzAnimation,
  KineticTuning,
  BarSpacingClampParams,
  RightOffsetClampParams,
  CompensationInput,
} from './time-scale/navigator';
export { TickMarkEngine, maxLabelWidthFor, maxIndexesPerMark, indexPerLabel } from './time-scale/ticks';
export type { TickMark, BuildParams } from './time-scale/ticks';

// --- price-scale: geometry, modes, autoscale, ticks, navigator (§4.6) ------------
export { createPriceGeometry } from './price-scale/geometry';
export type { PriceGeometry, PriceGeometryParams } from './price-scale/geometry';
export {
  PriceScaleMode,
  refusesManualScale,
  isAutoScaleForced,
  toPercent,
  fromPercent,
  toIndexed,
  fromIndexed,
  toLog,
  fromLog,
  toLogRange,
  fromLogRange,
  defaultLogFormula,
  logFormulaForRange,
  canConvertFromLog,
} from './price-scale/modes';
export type { LogFormula, MinMax } from './price-scale/modes';
export {
  assembleRange,
  finiteMerge,
  mergeMargins,
} from './price-scale/autoscale';
export type { AutoscaleMargins, AutoscaleContributor, AssembledRange } from './price-scale/autoscale';
export { tickSpan, rebuildTickMarks } from './price-scale/ticks';
export type { PriceTick } from './price-scale/ticks';
export { PriceNavigator } from './price-scale/navigator';
export type { PriceNavigatorInit } from './price-scale/navigator';
