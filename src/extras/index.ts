// traderzview · extras — tree-shakable first-party plugins, the traderzview/extras
// subpath (design 02 §3.2). The four M12 plugins: series markers + up-down markers
// (study 08 §4.4/§4.7), text + image watermarks (§4.5/§4.6). Each is an IPrimitive over
// the PUBLIC api seams only — never model/views (arch §3.1; dep-cruiser E1). The §12.4
// adapter ({ detach, applyOptions } + factory methods) is the shared handle convention.
// M13 adds ToolHost/SyncGroup/EMA/behaviors here. `export type` keeps type-only names
// erasable (verbatimModuleSyntax). See dev-docs/design/05-extensibility-roadmap.md §2.7.

// --- series markers (design 05 §2.7 item 1; study 08 §4.4) -------------------------
export { createSeriesMarkers, defaultSeriesMarkersOptions } from './markers/series-markers';
export type {
  SeriesMarker,
  SeriesMarkerPosition,
  SeriesMarkerShape,
  SeriesMarkersOptions,
  SeriesMarkersHandle,
} from './markers/series-markers';

// --- up-down (price-change) markers (design 05 §2.7 item 2; study 08 §4.7) ----------
export { createUpDownMarkers, upDownMarkersDefaults } from './markers/up-down-markers';
export type {
  UpDownMarker,
  UpDownSign,
  UpDownMarkersOptions,
  UpDownMarkersMethods,
  UpDownMarkersHandle,
} from './markers/up-down-markers';

// --- text watermark (design 05 §2.7 item 3; study 08 §4.5) --------------------------
export { createTextWatermark, textWatermarkDefaults } from './watermark/text-watermark';
export type {
  TextWatermarkOptions,
  TextWatermarkLine,
  TextWatermarkHorzAlign,
  TextWatermarkVertAlign,
  TextWatermarkHandle,
} from './watermark/text-watermark';

// --- image watermark (design 05 §2.7 item 3; study 08 §4.6) -------------------------
export { createImageWatermark, imageWatermarkDefaults } from './watermark/image-watermark';
export type { ImageWatermarkOptions, ImageWatermarkHandle } from './watermark/image-watermark';

// === M13 — the four extensibility-seam proofs (design 05 §4–§7) =====================

// --- drawing-tool host (design 05 §4; V1-REQ T1–T8) ---------------------------------
export { createToolHost, TrendLineTool, trendLineDefaults } from './tools/tool-host';
export type {
  IToolHost,
  Anchor,
  SerializedShape,
  IShapePrimitive,
  ToolDefinition,
  ShapeHandle,
  ToolHostEvent,
  TrendLineStyle,
} from './tools/tool-host';

// --- EMA indicator (design 05 §5; I1–I6) --------------------------------------------
export { createEma, emaDefinition, defaultEmaParams } from './indicators/ema';
export type {
  EmaParams,
  EmaHandle,
  IndicatorDefinition,
  IndicatorComputer,
  IndicatorOutput,
  IndicatorOutputPatch,
  IndicatorPatchMode,
} from './indicators/ema';

// --- multi-chart SyncGroup (design 05 §6; L1–L6) ------------------------------------
export { createSyncGroup } from './sync/sync-group';
export type { SyncGroupOptions } from './sync/sync-group';

// --- non-time horizontal-scale behaviors (design 05 §7; S2/S3) ----------------------
export { priceAxisBehavior, yieldCurveBehavior } from './behaviors/price-axis-behavior';

// --- session-local time behavior + IANA offset (design 05 §7.1; S1) -----------------
export { timezoneTimeBehavior, offsetFor } from './behaviors/timezone-time-behavior';

// --- session-highlighting primitive (design 05 §7.1; S4/S5) -------------------------
export { createSessionHighlight, sessionHighlightDefaults } from './behaviors/session-highlight';
export type { SessionSpec, SessionHighlightOptions, SessionHighlightHandle } from './behaviors/session-highlight';
