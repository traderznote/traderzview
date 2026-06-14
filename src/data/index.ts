// traderzview · data — union timeline, columnar plot store, horizontal-scale
// behaviors, typed diffs, validation. See dev-docs/design/01-architecture.md §4.5.
// Every other module imports `data` ONLY through this index (architecture §3.1;
// dependency-cruiser bans deep imports). `data` may import only `core` and `fmt`.

// Series data contracts (architecture §4.5.1).
export { singleValueContract, barContract } from './series-contract';
export type { SeriesDataContract } from './series-contract';

// Typed deltas (architecture §4.5 item 2).
export type { StoreDiff, TimelineDiff } from './diffs';

// Columnar per-series plot storage + its read-only face.
export { PlotStore } from './plot-store';
export type { PlotStoreView } from './plot-store';

// The union time pool + off-grid key↔logical seam (architecture §4.5 / §9.1 slot 2).
export { Timeline } from './timeline';
export type { PlotRow, SeriesApplyResult, FastPathResult } from './timeline';

// Horizontal-scale behavior seam + the built-in UTC time behavior (design 02 §13.3).
export { timeBehavior, TickMarkType } from './horz-behavior';
export type {
  IHorzScaleBehavior,
  HorzPoint,
  Time,
  UTCTimestamp,
  BusinessDay,
  TimeInternal,
} from './horz-behavior';

// Option groups declared in `data` so behaviors' augmentDefaults is typed without
// `data` importing `model` (architecture §4.5.5). `model` re-exports these.
export type {
  TimeScaleOptions,
  LocalizationOptions,
  HorzScaleOptionGroups,
  TimeScaleFormatOptions,
  TickMarkFormatter,
} from './options-groups';

// Validation tiers (design 02 §15).
export { validateSeriesData } from './validation';
export type { ValidationMode, ValidationOptions } from './validation';
