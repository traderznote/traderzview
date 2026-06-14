// traderzview · views — scene sources → display lists, the SeriesKind engine,
// hit testing, axis layout. Headless (no DOM, no backend). May import only
// core/fmt/data/model/gfx (architecture §3.1). Every other module imports `views`
// ONLY through this index (dependency-cruiser bans deep imports); `api` re-exports
// the public engine types from here verbatim (§6). `export type` vs `export` is
// split per verbatimModuleSyntax.
// See dev-docs/design/01-architecture.md §6.

// --- the series-kind engine surface (architecture §6) ----------------------------
// `SeriesKind` + the engine helper types `ItemBuffer`/`ItemWindow` are part of the
// public custom-series seam, re-exported from the package root by `api`.
export type { SeriesKind } from './series/kind';
export type { ItemBuffer, ItemFactory } from './series/buffer';
export { ReusableItemBuffer } from './series/buffer';
export type { ItemWindow } from './series/window';
export { MutableItemWindow, itemWindow } from './series/window';

// --- the six built-in series kinds + the shared LineType (study 06 §4.4–§4.11) ----
export { createLineKind, LineType } from './series/line';
export type { LineItem, LineKind, LineKindOptions } from './series/line';
export { createAreaKind } from './series/area';
export type { AreaItem, AreaKindOptions, AreaPointColors } from './series/area';
export { createBaselineKind } from './series/baseline';
export type { BaselineItem, BaselineKind, BaselineKindOptions } from './series/baseline';
export { createHistogramKind } from './series/histogram';
export type { HistogramItem, HistogramKind, HistogramKindOptions } from './series/histogram';
export { createBarKind } from './series/bar';
export type { BarItem, BarKind, BarKindOptions } from './series/bar';
export { createCandlestickKind } from './series/candlestick';
export type { CandlestickItem, CandlestickKind, CandlestickKindOptions } from './series/candlestick';

// --- the non-series scene sources: grid, crosshair, price-line, last-value pill ---
export { createGridSource } from './series/grid';
export type { GridSource, GridSideStyle } from './series/grid';
export { createCrosshairSource } from './series/crosshair-source';
export type { CrosshairLineOptions, CrosshairSourceOptions } from './series/crosshair-source';
export { createPriceLineSource } from './series/price-line';
export type { PriceLineSource, PriceLineState, PriceLineOptions } from './series/price-line';
export { createLastValueLabelSource, generateContrastColors } from './series/last-value-label';
export type { LastValueLabelState, LastValueLabelOptions } from './series/last-value-label';

// --- the shared emit-time column-decimation helper (architecture §6 / perf §6.3) -
export { decimateColumns, shouldDecimate } from './series/decimate';
export type { DecimateOptions, DecimateResult, DecimateShape } from './series/decimate';

// --- the z-band scene registry + primitive binding (architecture §6) -------------
export { PaneScene } from './scene/pane-scene';
export type { SourceMeta } from './scene/pane-scene';
export { PrimitiveBinding, resolveSurface } from './scene/primitive-binding';
export type { OwnerPlacement, SurfaceKind, TaggedPrimitiveSource } from './scene/primitive-binding';

// --- the ranked hit-test service (architecture §5.5 / design 05 §2.4) -------------
export { hitTestPane, toHoverTarget } from './hit-test';
export type { HitResult, HitSource, RankedHit } from './hit-test';

// --- pure axis layout: optimal width/height, edge align, width ratchet (§5.4/§13.6)
export { layoutPriceAxis, layoutTimeAxis, boldWeight, AxisWidthRatchet } from './axis-layout';
export type {
  PriceAxisInput,
  PriceAxisLayout,
  PriceTickLabel,
  PriceLabelPlacement,
  CrosshairSample,
  TimeAxisInput,
  TimeAxisLayout,
  TimeMarkInput,
  TimeLabelPlacement,
} from './axis-layout';
