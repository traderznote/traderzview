// traderzview · api — the ITimeScale facade (spec 02 §9). A THIN wrapper over the
// model time-scale (navigator + geometry + tick engine) and the host axis widget,
// reached through an injected port; it owns NO business logic the model already has.
// Identity law (§2): timeScale() is a singleton per chart — the chart caches the one
// handle this factory builds. Disposed-guard (§16.5): after chart.dispose() every
// method throws ChartError('disposed') at the facade boundary. The facade owns the
// two boundary rules §9 assigns it: from > to throws RangeError FIRST regardless of
// scale state, and empty-scale setters are silent no-ops (delegated to the port,
// which knows emptiness). NEVER imports backend-canvas (§3.1 import wall).
import type { Coordinate, DeepPartial, DeepReadonly, HorzKey, Logical, Unsubscribe } from '../core';
import type { TimeScaleOptions } from '../model';
import { ChartErrorCode, throwChartError } from './errors';
import { EventHub } from './events';
import { normalizeChartPatch } from './options';
import type { LogicalRange } from './series';

// --- supporting public shapes (§9) -------------------------------------------------

/** A time (horizontal) range, endpoints in the chart's H item type (§9). */
export interface TimeRange<H = unknown> {
  from: H;
  to: H;
}

// --- the public ITimeScale interface (§9) ------------------------------------------

/**
 * The time-scale handle (§9). Generic over the horizontal item `H` (Time in core
 * charts). Navigation, range get/set (logical + H-typed), the coordinate/time/logical
 * conversions, the off-grid key↔logical seam, live interactive state, axis geometry,
 * options, and the three time-scale events. Singleton per chart (§2); every method
 * throws after dispose() (§16.5).
 */
export interface ITimeScale<H = unknown> {
  // navigation
  scrollPosition(): number; // right offset in bars
  scrollToPosition(position: number, animated?: boolean): void;
  scrollToRealTime(): void;
  fitContent(): void;
  reset(): void;

  // ranges (logical CAN extrapolate; H-typed clamps to data — kept §9)
  getVisibleRange(): TimeRange<H> | null;
  setVisibleRange(range: TimeRange<H>): void;
  getVisibleLogicalRange(): LogicalRange | null;
  setVisibleLogicalRange(range: { from: number; to: number }): void;

  // conversions (null when the scale is empty — kept convention §16.1)
  logicalToCoordinate(logical: number): Coordinate | null;
  coordinateToLogical(x: number): Logical | null; // continuous float (§9)
  snapToBar(logical: number): Logical | null;
  timeToCoordinate(time: H): Coordinate | null; // exact match only
  coordinateToTime(x: number): H | null;
  timeToLogical(time: H, mismatch?: MismatchDirection): Logical | null;

  // key ↔ logical mapping (drawing-tools / multi-chart seam — §9)
  keyToLogical(key: number, opts?: { extrapolate?: boolean }): Logical | null;
  logicalToKey(logical: number, opts?: { extrapolate?: boolean }): HorzKey | null;
  keysInRange(range: { from: number; to: number }): readonly HorzKey[];

  // live interactive state (§5.5)
  barSpacing(): number;
  rightOffset(): number;

  // geometry of the axis widget
  width(): number;
  height(): number;

  // options
  applyOptions(patch: DeepPartial<TimeScaleOptions>): void;
  options(): DeepReadonly<TimeScaleOptions>;

  // events — §14
  subscribeVisibleTimeRangeChange(h: (r: TimeRange<H> | null) => void): Unsubscribe;
  unsubscribeVisibleTimeRangeChange(h: (r: TimeRange<H> | null) => void): void;
  subscribeVisibleLogicalRangeChange(h: (r: LogicalRange | null) => void): Unsubscribe;
  unsubscribeVisibleLogicalRangeChange(h: (r: LogicalRange | null) => void): void;
  subscribeSizeChange(h: (width: number, height: number) => void): Unsubscribe;
  unsubscribeSizeChange(h: (width: number, height: number) => void): void;
}

/** Nearest-match direction for `timeToLogical` (§4.2). Mirrors series.MismatchDirection
 *  (declared here too so time-scale.ts never imports the series facade). */
export type MismatchDirection = 'none' | 'nearest-left' | 'nearest-right';

// --- the chart-owned port (injected by create-chart.ts) ----------------------------

/**
 * Everything the time-scale facade delegates to. Create-chart wires it over the model
 * navigator/geometry/timeline + the host axis widget so the facade stays a pure
 * map-through. The port owns the clamp-on-data / extrapolation math the model already
 * implements; the facade adds only the §9 boundary rules (from > to RangeError, the
 * disposed guard) and the H-typed range-endpoint comparison via `key`.
 */
export interface TimeScalePort<H = unknown> {
  /** The chart's shared disposed flag (§16.5) — true once chart.dispose() ran. */
  isDisposed(): boolean;
  /** True when the scale has no points: setVisibleRange/setVisibleLogicalRange no-op (§9). */
  isEmpty(): boolean;
  /** behavior.key(item) — the sortable numeric key the H-typed from > to check uses (§9). */
  key(item: H): number;

  // navigation
  scrollPosition(): number;
  scrollToPosition(position: number, animated: boolean): void;
  scrollToRealTime(): void;
  fitContent(): void;
  reset(): void;

  // ranges (the model clamps the H-typed setter to data; logical CAN extrapolate)
  getVisibleRange(): TimeRange<H> | null;
  setVisibleRange(range: TimeRange<H>): void;
  getVisibleLogicalRange(): LogicalRange | null;
  setVisibleLogicalRange(range: { from: number; to: number }): void;

  // conversions (null on empty scale — the model/geometry returns it)
  logicalToCoordinate(logical: number): Coordinate | null;
  coordinateToLogical(x: number): Logical | null;
  snapToBar(logical: number): Logical | null;
  timeToCoordinate(time: H): Coordinate | null;
  coordinateToTime(x: number): H | null;
  timeToLogical(time: H, mismatch: MismatchDirection): Logical | null;

  // key ↔ logical seam (data/timeline owns the interpolation/extrapolation)
  keyToLogical(key: number, extrapolate: boolean): Logical | null;
  logicalToKey(logical: number, extrapolate: boolean): HorzKey | null;
  keysInRange(range: { from: number; to: number }): readonly HorzKey[];

  // live interactive state + axis geometry
  barSpacing(): number;
  rightOffset(): number;
  width(): number;
  height(): number;

  // the three time-scale event hubs (§14) — the chart owns + FIRES them
  readonly events: {
    readonly visibleTimeRange: EventHub<[TimeRange<H> | null]>;
    readonly visibleLogicalRange: EventHub<[LogicalRange | null]>;
    readonly size: EventHub<[number, number]>;
  };
}

/** The live bar spacing px→bars resolves against in normalizeChartPatch (§5.3.4). */
export interface TimeScaleApiDeps<H = unknown> {
  readonly port: TimeScalePort<H>;
  /** Apply the (normalized) timeScale option subset through the model. */
  applyOptions(patch: DeepPartial<TimeScaleOptions>): void;
  /** A fresh snapshot of the configured timeScale options (§4.3, NOT live state §5.5). */
  options(): DeepReadonly<TimeScaleOptions>;
}

// --- the facade factory ------------------------------------------------------------

/**
 * Build the singleton ITimeScale facade (§9). The chart calls this once and caches the
 * result (§2 identity). Every method guards the shared disposed flag first (§16.5),
 * then maps to the port; the two range setters apply the §9 boundary rules — from > to
 * throws RangeError FIRST (even on an empty scale), then an empty scale silently
 * no-ops, otherwise the port applies (and the model clamps the H-typed endpoints).
 */
export function createTimeScaleApi<H = unknown>(deps: TimeScaleApiDeps<H>): ITimeScale<H> {
  const { port } = deps;
  const guard = (): void => {
    if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
  };
  const { visibleTimeRange, visibleLogicalRange, size } = port.events;

  const api: ITimeScale<H> = {
    // --- navigation ---------------------------------------------------------------
    scrollPosition(): number {
      guard();
      return port.scrollPosition();
    },
    scrollToPosition(position, animated): void {
      guard();
      // Non-finite scroll target is malformed numeric input (§16.2).
      if (!Number.isFinite(position)) {
        throw new RangeError(`scrollToPosition: position must be finite, got ${position}`);
      }
      port.scrollToPosition(position, animated ?? false);
    },
    scrollToRealTime(): void {
      guard();
      port.scrollToRealTime();
    },
    fitContent(): void {
      guard();
      port.fitContent();
    },
    reset(): void {
      guard();
      port.reset();
    },

    // --- ranges -------------------------------------------------------------------
    getVisibleRange(): TimeRange<H> | null {
      guard();
      return port.getVisibleRange();
    },
    setVisibleRange(range): void {
      guard();
      // from > to (compared via behavior.key for H-typed ranges) throws RangeError
      // FIRST, regardless of scale state (§9 / §16.2). Then an empty scale no-ops —
      // there is nothing to clamp against (§9 / §16.4); otherwise the port applies
      // (the model clamps the endpoints to data — cannot extrapolate, kept §9).
      if (port.key(range.from) > port.key(range.to)) {
        throw new RangeError('setVisibleRange: from must be <= to');
      }
      if (port.isEmpty()) return;
      port.setVisibleRange(range);
    },
    getVisibleLogicalRange(): LogicalRange | null {
      guard();
      return port.getVisibleLogicalRange();
    },
    setVisibleLogicalRange(range): void {
      guard();
      // from > to (numeric) throws RangeError FIRST, even on an empty scale (§9/§16.2).
      if (range.from > range.to) {
        throw new RangeError('setVisibleLogicalRange: from must be <= to');
      }
      if (port.isEmpty()) return; // empty scale: silent no-op (§9 / §16.4)
      port.setVisibleLogicalRange(range); // CAN extrapolate (kept §9)
    },

    // --- conversions (null on empty scale — kept §16.1) ---------------------------
    logicalToCoordinate(logical): Coordinate | null {
      guard();
      return port.logicalToCoordinate(logical);
    },
    coordinateToLogical(x): Logical | null {
      guard();
      return port.coordinateToLogical(x);
    },
    snapToBar(logical): Logical | null {
      guard();
      return port.snapToBar(logical);
    },
    timeToCoordinate(time): Coordinate | null {
      guard();
      return port.timeToCoordinate(time);
    },
    coordinateToTime(x): H | null {
      guard();
      return port.coordinateToTime(x);
    },
    timeToLogical(time, mismatch): Logical | null {
      guard();
      return port.timeToLogical(time, mismatch ?? 'none');
    },

    // --- key ↔ logical seam (off-grid; default extrapolate false, §9) -------------
    keyToLogical(key, opts): Logical | null {
      guard();
      return port.keyToLogical(key, opts?.extrapolate ?? false);
    },
    logicalToKey(logical, opts): HorzKey | null {
      guard();
      return port.logicalToKey(logical, opts?.extrapolate ?? false);
    },
    keysInRange(range): readonly HorzKey[] {
      guard();
      return port.keysInRange(range);
    },

    // --- live interactive state (§5.5) + geometry ---------------------------------
    barSpacing(): number {
      guard();
      return port.barSpacing();
    },
    rightOffset(): number {
      guard();
      return port.rightOffset();
    },
    width(): number {
      guard();
      return port.width();
    },
    height(): number {
      guard();
      return port.height();
    },

    // --- options (configured values; NOT patched with live barSpacing, §5.5) ------
    applyOptions(patch): void {
      guard();
      // Run the §5.3.4 rightOffsetPixels px→bars normalization at the boundary against
      // the LIVE bar spacing, then let the model own the merge (§5.1). normalizeChartPatch
      // also handles handleScroll/handleScale (no-ops for a timeScale-only patch).
      const normalized = normalizeChartPatch(
        { timeScale: patch } as Record<string, unknown>,
        port.barSpacing(),
      );
      deps.applyOptions((normalized as { timeScale: DeepPartial<TimeScaleOptions> }).timeScale);
    },
    options(): DeepReadonly<TimeScaleOptions> {
      guard();
      return deps.options();
    },

    // --- events (§14) -------------------------------------------------------------
    subscribeVisibleTimeRangeChange(h): Unsubscribe {
      guard();
      return visibleTimeRange.subscribe(h);
    },
    unsubscribeVisibleTimeRangeChange(h): void {
      guard();
      visibleTimeRange.unsubscribe(h);
    },
    subscribeVisibleLogicalRangeChange(h): Unsubscribe {
      guard();
      return visibleLogicalRange.subscribe(h);
    },
    unsubscribeVisibleLogicalRangeChange(h): void {
      guard();
      visibleLogicalRange.unsubscribe(h);
    },
    subscribeSizeChange(h): Unsubscribe {
      guard();
      return size.subscribe(h);
    },
    unsubscribeSizeChange(h): void {
      guard();
      size.unsubscribe(h);
    },
  };

  return api;
}
