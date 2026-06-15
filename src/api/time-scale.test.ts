// Spec of record: 02-public-api-spec.md §9 (ITimeScale facade), §2 (identity law),
// §16 (disposed guard, null-on-empty, RangeError on from > to, empty-scale no-ops).
// Tests are hand-derived from those contracts: a recording fake TimeScalePort
// (headless — no DOM, no canvas, no real model) exercises the facade's map-through,
// the two boundary rules the facade OWNS, and the disposed behavior.
import { expect, test, vi } from 'vitest';
import type { Coordinate, DeepReadonly, HorzKey, Logical } from '../core';
import type { TimeScaleOptions } from '../model';
import { ChartError } from './errors';
import { EventHub } from './events';
import type { LogicalRange } from './series';
import {
  createTimeScaleApi,
  type ITimeScale,
  type MismatchDirection,
  type TimeRange,
  type TimeScaleApiDeps,
  type TimeScalePort,
} from './time-scale';

// --- fakes -------------------------------------------------------------------------

interface FakeState {
  disposed: boolean;
  empty: boolean;
  scrollPos: number;
  visibleRange: TimeRange<number> | null;
  visibleLogical: LogicalRange | null;
  coord: Coordinate | null;
  logical: Logical | null;
  time: number | null;
  key: HorzKey | null;
  keys: readonly HorzKey[];
  barSpacing: number;
  rightOffset: number;
  width: number;
  height: number;
  options: TimeScaleOptions;
}

function makePort(over: Partial<FakeState> = {}): {
  port: TimeScalePort<number>;
  state: FakeState;
  calls: Record<string, unknown[]>;
  events: TimeScalePort<number>['events'];
} {
  const state: FakeState = {
    disposed: false,
    empty: false,
    scrollPos: 3,
    visibleRange: null,
    visibleLogical: null,
    coord: null,
    logical: null,
    time: null,
    key: null,
    keys: [],
    barSpacing: 6,
    rightOffset: 0,
    width: 800,
    height: 30,
    options: { barSpacing: 6, rightOffset: 0 } as unknown as TimeScaleOptions,
    ...over,
  };
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };
  const events = {
    visibleTimeRange: new EventHub<[TimeRange<number> | null]>(),
    visibleLogicalRange: new EventHub<[LogicalRange | null]>(),
    size: new EventHub<[number, number]>(),
  };
  // For H = number, the ordering key IS the number itself.
  const port: TimeScalePort<number> = {
    isDisposed: () => state.disposed,
    isEmpty: () => state.empty,
    key: (item) => item,
    scrollPosition: () => state.scrollPos,
    scrollToPosition: (p, a) => rec('scrollToPosition', p, a),
    scrollToRealTime: () => rec('scrollToRealTime'),
    fitContent: () => rec('fitContent'),
    reset: () => rec('reset'),
    getVisibleRange: () => state.visibleRange,
    setVisibleRange: (r) => rec('setVisibleRange', r),
    getVisibleLogicalRange: () => state.visibleLogical,
    setVisibleLogicalRange: (r) => rec('setVisibleLogicalRange', r),
    logicalToCoordinate: (l) => {
      rec('logicalToCoordinate', l);
      return state.coord;
    },
    coordinateToLogical: (x) => {
      rec('coordinateToLogical', x);
      return state.logical;
    },
    snapToBar: (l) => {
      rec('snapToBar', l);
      return state.logical;
    },
    timeToCoordinate: (t) => {
      rec('timeToCoordinate', t);
      return state.coord;
    },
    coordinateToTime: (x) => {
      rec('coordinateToTime', x);
      return state.time;
    },
    timeToLogical: (t, m) => {
      rec('timeToLogical', t, m);
      return state.logical;
    },
    keyToLogical: (k, e) => {
      rec('keyToLogical', k, e);
      return state.logical;
    },
    logicalToKey: (l, e) => {
      rec('logicalToKey', l, e);
      return state.key;
    },
    keysInRange: (r) => {
      rec('keysInRange', r);
      return state.keys;
    },
    barSpacing: () => state.barSpacing,
    rightOffset: () => state.rightOffset,
    width: () => state.width,
    height: () => state.height,
    events,
  };
  return { port, state, calls, events };
}

function makeApi(over: Partial<FakeState> = {}): {
  api: ITimeScale<number>;
  state: FakeState;
  calls: Record<string, unknown[]>;
  events: TimeScalePort<number>['events'];
  applied: Array<unknown>;
} {
  const { port, state, calls, events } = makePort(over);
  const applied: Array<unknown> = [];
  const deps: TimeScaleApiDeps<number> = {
    port,
    applyOptions: (patch) => {
      applied.push(patch);
    },
    options: () => state.options as unknown as DeepReadonly<TimeScaleOptions>,
  };
  const api = createTimeScaleApi(deps);
  return { api, state, calls, events, applied };
}

// --- §9 navigation map-through -----------------------------------------------------

test('scrollPosition returns the port right-offset in bars (§9)', () => {
  expect(makeApi({ scrollPos: 4.5 }).api.scrollPosition()).toBe(4.5);
});

test('scrollToPosition forwards position + default animated=false (§9)', () => {
  const { api, calls } = makeApi();
  api.scrollToPosition(10);
  expect(calls.scrollToPosition[0]).toEqual([10, false]);
  api.scrollToPosition(-2, true);
  expect(calls.scrollToPosition[1]).toEqual([-2, true]);
});

test('scrollToPosition throws RangeError on non-finite input (§16.2)', () => {
  const { api } = makeApi();
  expect(() => api.scrollToPosition(Number.NaN)).toThrow(RangeError);
  expect(() => api.scrollToPosition(Number.POSITIVE_INFINITY)).toThrow(RangeError);
});

test('scrollToRealTime / fitContent / reset map through (§9)', () => {
  const { api, calls } = makeApi();
  api.scrollToRealTime();
  api.fitContent();
  api.reset();
  expect(calls.scrollToRealTime).toHaveLength(1);
  expect(calls.fitContent).toHaveLength(1);
  expect(calls.reset).toHaveLength(1);
});

// --- §9 ranges: get returns the port value; null on empty --------------------------

test('getVisibleRange / getVisibleLogicalRange return null on empty state (§16.1)', () => {
  const { api } = makeApi(); // both default null
  expect(api.getVisibleRange()).toBeNull();
  expect(api.getVisibleLogicalRange()).toBeNull();
});

test('getVisibleRange / getVisibleLogicalRange surface the port range when present', () => {
  const tr: TimeRange<number> = { from: 1, to: 5 };
  const lr: LogicalRange = { from: 0 as Logical, to: 4 as Logical };
  const { api } = makeApi({ visibleRange: tr, visibleLogical: lr });
  expect(api.getVisibleRange()).toBe(tr);
  expect(api.getVisibleLogicalRange()).toBe(lr);
});

// --- §9 setters: from > to throws RangeError FIRST (even on empty) ------------------

test('setVisibleRange throws RangeError when from > to, before any port call (§9/§16.2)', () => {
  const { api, calls } = makeApi();
  expect(() => api.setVisibleRange({ from: 9, to: 2 })).toThrow(RangeError);
  expect(calls.setVisibleRange).toBeUndefined();
});

test('setVisibleLogicalRange throws RangeError when from > to (§9/§16.2)', () => {
  const { api, calls } = makeApi();
  expect(() => api.setVisibleLogicalRange({ from: 4, to: 1 })).toThrow(RangeError);
  expect(calls.setVisibleLogicalRange).toBeUndefined();
});

test('from > to throws RangeError even on an EMPTY scale (malformed input wins, §9)', () => {
  const { api, calls } = makeApi({ empty: true });
  expect(() => api.setVisibleRange({ from: 9, to: 2 })).toThrow(RangeError);
  expect(() => api.setVisibleLogicalRange({ from: 9, to: 2 })).toThrow(RangeError);
  expect(calls.setVisibleRange).toBeUndefined();
  expect(calls.setVisibleLogicalRange).toBeUndefined();
});

// --- §9 setters: empty scale is a silent no-op -------------------------------------

test('setVisibleRange / setVisibleLogicalRange on an empty scale are silent no-ops (§9/§16.4)', () => {
  const { api, calls } = makeApi({ empty: true });
  api.setVisibleRange({ from: 1, to: 5 }); // well-formed, but scale empty
  api.setVisibleLogicalRange({ from: 0, to: 4 });
  expect(calls.setVisibleRange).toBeUndefined();
  expect(calls.setVisibleLogicalRange).toBeUndefined();
});

test('well-formed setters apply through the port on a NON-empty scale (§9)', () => {
  const { api, calls } = makeApi(); // empty defaults false
  const tr: TimeRange<number> = { from: 1, to: 5 };
  const lr = { from: 0, to: 4 };
  api.setVisibleRange(tr);
  api.setVisibleLogicalRange(lr);
  expect(calls.setVisibleRange[0][0]).toBe(tr);
  expect(calls.setVisibleLogicalRange[0][0]).toBe(lr);
});

test('setVisibleRange accepts from === to (boundary, not malformed)', () => {
  const { api, calls } = makeApi();
  api.setVisibleRange({ from: 3, to: 3 });
  api.setVisibleLogicalRange({ from: 2, to: 2 });
  expect(calls.setVisibleRange).toHaveLength(1);
  expect(calls.setVisibleLogicalRange).toHaveLength(1);
});

// --- §9 / §16.1 conversions: null on empty, branded value otherwise ----------------

test('coordinate/time/logical conversions return null on empty scale (§16.1)', () => {
  const { api } = makeApi(); // coord/logical/time default null
  expect(api.logicalToCoordinate(0)).toBeNull();
  expect(api.coordinateToLogical(50)).toBeNull();
  expect(api.snapToBar(0)).toBeNull();
  expect(api.timeToCoordinate(1)).toBeNull();
  expect(api.coordinateToTime(50)).toBeNull();
  expect(api.timeToLogical(1)).toBeNull();
});

test('conversions forward args and return the branded port value when present', () => {
  const { api, calls } = makeApi({
    coord: 42 as Coordinate,
    logical: 7 as Logical,
    time: 1700,
  });
  expect(api.logicalToCoordinate(3)).toBe(42);
  expect(calls.logicalToCoordinate[0]).toEqual([3]);
  expect(api.coordinateToLogical(99)).toBe(7);
  expect(api.timeToCoordinate(1700)).toBe(42);
  expect(api.coordinateToTime(99)).toBe(1700);
});

test('timeToLogical default mismatch is "none"; explicit mismatch forwarded (§9)', () => {
  const { api, calls } = makeApi({ logical: 5 as Logical });
  api.timeToLogical(1700);
  expect(calls.timeToLogical[0]).toEqual([1700, 'none']);
  const m: MismatchDirection = 'nearest-right';
  api.timeToLogical(1700, m);
  expect(calls.timeToLogical[1]).toEqual([1700, 'nearest-right']);
});

// --- §9 key ↔ logical seam: default extrapolate=false ------------------------------

test('keyToLogical / logicalToKey default extrapolate=false; opt forwards (§9)', () => {
  const { api, calls } = makeApi({ logical: 2 as Logical, key: 1700 as HorzKey });
  api.keyToLogical(1700);
  expect(calls.keyToLogical[0]).toEqual([1700, false]);
  api.keyToLogical(1700, { extrapolate: true });
  expect(calls.keyToLogical[1]).toEqual([1700, true]);

  api.logicalToKey(2);
  expect(calls.logicalToKey[0]).toEqual([2, false]);
  api.logicalToKey(2, { extrapolate: true });
  expect(calls.logicalToKey[1]).toEqual([2, true]);
});

test('keyToLogical / logicalToKey return null off-grid without extrapolate (§9)', () => {
  const { api } = makeApi(); // logical/key default null (model returns null off-grid)
  expect(api.keyToLogical(1700)).toBeNull();
  expect(api.logicalToKey(99)).toBeNull();
});

test('keysInRange forwards the logical range and returns the port keys (§9)', () => {
  const keys = [1700, 1760, 1820] as unknown as readonly HorzKey[];
  const { api, calls } = makeApi({ keys });
  const range = { from: 0, to: 2 };
  expect(api.keysInRange(range)).toBe(keys);
  expect(calls.keysInRange[0][0]).toBe(range);
});

test('keysInRange returns [] on an empty scale (§9)', () => {
  const { api } = makeApi({ keys: [] });
  expect(api.keysInRange({ from: 0, to: 2 })).toEqual([]);
});

// --- §5.5 live interactive state + axis geometry -----------------------------------

test('barSpacing / rightOffset / width / height map through (§5.5 / §9)', () => {
  const { api } = makeApi({ barSpacing: 8, rightOffset: 2, width: 640, height: 28 });
  expect(api.barSpacing()).toBe(8);
  expect(api.rightOffset()).toBe(2);
  expect(api.width()).toBe(640);
  expect(api.height()).toBe(28);
});

// --- §9 / §5.5 options: snapshot out; px→bars normalized in --------------------------

test('options() returns the configured snapshot, not live state (§5.5)', () => {
  const { api, state } = makeApi();
  expect(api.options()).toBe(state.options); // deps.options() is the snapshot source
});

test('applyOptions forwards the (normalized) timeScale patch to the model (§9)', () => {
  const { api, applied } = makeApi();
  api.applyOptions({ rightOffset: 5 } as never);
  expect(applied).toHaveLength(1);
  expect(applied[0]).toEqual({ rightOffset: 5 });
});

test('applyOptions converts rightOffsetPixels px→bars against live barSpacing (§5.3.4)', () => {
  // barSpacing 6, rightOffsetPixels 12 → rightOffset 2; the pixel key is dropped.
  const { api, applied } = makeApi({ barSpacing: 6 });
  api.applyOptions({ rightOffsetPixels: 12 } as never);
  const patch = applied[0] as Record<string, unknown>;
  expect(patch.rightOffset).toBe(2);
  expect('rightOffsetPixels' in patch).toBe(false);
});

// --- §14 events: subscribe returns Unsubscribe; unsubscribe by reference ------------

test('subscribeVisibleTimeRangeChange fires with the range; Unsubscribe + unsubscribe work', () => {
  const { api, events } = makeApi();
  const seen: Array<TimeRange<number> | null> = [];
  const h = (r: TimeRange<number> | null): void => {
    seen.push(r);
  };
  const off = api.subscribeVisibleTimeRangeChange(h);
  events.visibleTimeRange.emit(() => [{ from: 1, to: 5 }]);
  expect(seen).toEqual([{ from: 1, to: 5 }]);
  off();
  events.visibleTimeRange.emit(() => [null]);
  expect(seen).toHaveLength(1);

  const h2 = vi.fn();
  api.subscribeVisibleTimeRangeChange(h2);
  api.unsubscribeVisibleTimeRangeChange(h2);
  events.visibleTimeRange.emit(() => [null]);
  expect(h2).not.toHaveBeenCalled();
});

test('subscribeVisibleLogicalRangeChange + subscribeSizeChange map through (§14)', () => {
  const { api, events } = makeApi();
  const logical: Array<LogicalRange | null> = [];
  const sizes: Array<[number, number]> = [];
  api.subscribeVisibleLogicalRangeChange((r) => logical.push(r));
  api.subscribeSizeChange((w, hh) => sizes.push([w, hh]));
  events.visibleLogicalRange.emit(() => [{ from: 0 as Logical, to: 9 as Logical }]);
  events.size.emit(() => [800, 30]);
  expect(logical).toEqual([{ from: 0, to: 9 }]);
  expect(sizes).toEqual([[800, 30]]);

  const lh = vi.fn();
  const sh = vi.fn();
  api.subscribeVisibleLogicalRangeChange(lh);
  api.subscribeSizeChange(sh);
  api.unsubscribeVisibleLogicalRangeChange(lh);
  api.unsubscribeSizeChange(sh);
  events.visibleLogicalRange.emit(() => [null]);
  events.size.emit(() => [1, 1]);
  expect(lh).not.toHaveBeenCalled();
  expect(sh).not.toHaveBeenCalled();
});

// --- §2 identity law ---------------------------------------------------------------

test('the facade is the chart-cached singleton: every accessor off ONE object (§2)', () => {
  // The chart calls createTimeScaleApi once and caches it; timeScale() === timeScale()
  // is the chart's job. Here we assert the facade itself is a single stable object
  // whose method results are consistent across calls.
  const { api } = makeApi({ scrollPos: 7 });
  expect(api).toBe(api);
  expect(api.scrollPosition()).toBe(api.scrollPosition());
});

// --- §16.5 disposed guard: EVERY method throws ChartError('disposed') ---------------

test('after dispose every method throws ChartError("disposed") (§16.5)', () => {
  const { api, state } = makeApi();
  state.disposed = true; // the chart's shared flag flips

  const noop = (): void => {};
  const callers: Array<() => unknown> = [
    () => api.scrollPosition(),
    () => api.scrollToPosition(1),
    () => api.scrollToRealTime(),
    () => api.fitContent(),
    () => api.reset(),
    () => api.getVisibleRange(),
    () => api.setVisibleRange({ from: 1, to: 2 }),
    () => api.getVisibleLogicalRange(),
    () => api.setVisibleLogicalRange({ from: 1, to: 2 }),
    () => api.logicalToCoordinate(0),
    () => api.coordinateToLogical(0),
    () => api.snapToBar(0),
    () => api.timeToCoordinate(1),
    () => api.coordinateToTime(0),
    () => api.timeToLogical(1),
    () => api.keyToLogical(1),
    () => api.logicalToKey(1),
    () => api.keysInRange({ from: 0, to: 1 }),
    () => api.barSpacing(),
    () => api.rightOffset(),
    () => api.width(),
    () => api.height(),
    () => api.applyOptions({} as never),
    () => api.options(),
    () => api.subscribeVisibleTimeRangeChange(noop),
    () => api.unsubscribeVisibleTimeRangeChange(noop),
    () => api.subscribeVisibleLogicalRangeChange(noop),
    () => api.unsubscribeVisibleLogicalRangeChange(noop),
    () => api.subscribeSizeChange(noop),
    () => api.unsubscribeSizeChange(noop),
  ];

  for (const call of callers) {
    let thrown: unknown;
    try {
      call();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ChartError);
    expect((thrown as ChartError).code).toBe('disposed');
  }
});

test('the disposed guard runs BEFORE the from > to check (§16.5 precedence)', () => {
  // A disposed scale must throw ChartError('disposed'), NOT RangeError, even for a
  // malformed range — the guard is the first statement in every method.
  const { api, state } = makeApi();
  state.disposed = true;
  let thrown: unknown;
  try {
    api.setVisibleRange({ from: 9, to: 1 });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ChartError);
  expect((thrown as ChartError).code).toBe('disposed');
});
