// Public surface of the `core` module. Every other module imports core ONLY
// through this index (architecture §3.1; dependency-cruiser bans deep imports).

export { Emitter } from './emitter';
export type { ISubscription, Unsubscribe } from './emitter';
export type { Disposable } from './disposable';
export { reportError, setReportError } from './report-error';
export type { ReportError } from './report-error';
export { mergeOptions, changedPaths } from './options';
export type { DeepPartial, DeepReadonly } from './options';
export { lowerBound, upperBound } from './search';
export { assert } from './assert';
export type {
  Brand,
  Coordinate,
  BitmapCoordinate,
  TimeIndex,
  Logical,
  HorzKey,
  BarPrice,
  CursorStyle,
  Size,
  Rect,
} from './brands';
export type { IFrameCounters } from './profiling';
