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
