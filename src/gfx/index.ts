// Public surface of the `gfx` module — THE SEAM. Exported as the `traderzview/gfx`
// subpath so third-party backends depend on it alone (architecture §3.1). gfx
// imports only core. Imported elsewhere only through this index.

// values (each const-object / function also carries its merged type)
export { LineStyle, PathVerb, dashPattern } from './commands';
export {
  applyBarParity,
  ceiledEven,
  ceiledOdd,
  crispRound,
  crispStrokePos,
  crispWidth,
  edgeToRect,
  evenCeil,
  evenFloor,
  optimalBarWidth,
  optimalCandlestickWidth,
  tickRect,
} from './crisp';
export { DisplayListBuilder } from './builder';
export { CachedTextMeasurer } from './text-measure';
export { ZBand } from './scene';
export { HitPriority } from './hit';

// type-only
export type {
  AreaCommand,
  CirclesCommand,
  DisplayList,
  DrawCommand,
  FillStyle,
  FontSpec,
  ImageCommand,
  ImageHandle,
  LinearGradientY,
  PathCommand,
  PolylineCommand,
  Rect,
  RectsCommand,
  Space,
  StrokeSpec,
  StyleRun,
  TextCommand,
  TextItem,
} from './commands';
export type { EdgeRect, TickRect } from './crisp';
export type { AreaWriter, CirclesWriter, PathWriter, PolylineWriter, RectsWriter } from './builder';
export type { ITextMeasurer, TextSize } from './text-measure';
export type {
  FrameInfo,
  FrameScope,
  IRenderBackend,
  ISurface,
  LayerId,
  Snapshot,
  SnapshotTile,
  SurfaceSnapshot,
} from './backend';
export type { SceneSource, ViewFrame } from './scene';
export type { HitCandidate } from './hit';
