// Spec of record: 02-public-api-spec.md §8 (ISeries facade), §2 (identity law),
// §16 (disposed guard + null-on-empty). Tests are hand-derived from those contracts:
// a tiny REAL model Series instance plus a fake SeriesPort (headless — no DOM, no
// canvas) exercise the facade's map-through, identity, and disposed behavior.
import { expect, test, vi } from 'vitest';
import type { BarPrice, Coordinate } from '../core';
import type { PlotStoreView } from '../data';
import { Series, type SeriesInit } from '../model';
import { ChartError } from './errors';
import { EventHub, type StoreDiff } from './events';
import {
  createSeriesApi,
  type BarsInfo,
  type IPaneHandle,
  type IPriceLine,
  type IPriceScaleHandle,
  type ISeries,
  type LogicalRange,
  type MismatchDirection,
  type PriceLineOptions,
  type SeriesPort,
} from './series';

// --- fakes -------------------------------------------------------------------------

const candlestickDefaults: SeriesInit = {
  kind: 'candlestick',
  defaultOptions: {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  },
  // The candlestick hook the model runs internally; the api also re-runs it (§5.3.3).
  normalizeOptions: (patch) => {
    if (typeof patch.borderColor === 'string') {
      if (patch.borderUpColor === undefined) patch.borderUpColor = patch.borderColor;
      if (patch.borderDownColor === undefined) patch.borderDownColor = patch.borderColor;
      delete patch.borderColor;
    }
  },
};

const lineDefaults: SeriesInit = {
  kind: 'line',
  defaultOptions: {
    color: '#2196f3',
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  },
};

const emptyStore: PlotStoreView = {
  length: 0,
  timeIndex: () => 0 as never,
  current: () => Number.NaN,
  min: () => Number.NaN,
  max: () => Number.NaN,
  lane: () => Number.NaN,
  firstIndexAt: () => null,
  nearestIndexAt: () => -1,
};

interface FakePortState {
  disposed: boolean;
  scaleHandle: IPriceScaleHandle;
  paneHandle: IPaneHandle;
  data: unknown[];
  byIndex: unknown | null;
  barsInfo: BarsInfo | null;
  coord: Coordinate | null;
  price: BarPrice | null;
  last: { price: number; color: string } | null;
}

// Records every call so map-through can be asserted; returns chart-owned cached
// handles (the chart's identity cache, modeled here as fixed objects).
function makePort(over: Partial<FakePortState> = {}): {
  port: SeriesPort;
  state: FakePortState;
  calls: Record<string, unknown[]>;
  priceLines: IPriceLine[];
} {
  const scaleHandle: IPriceScaleHandle = { id: () => 'right' };
  const paneHandle: IPaneHandle = { index: () => 0 };
  const state: FakePortState = {
    disposed: false,
    scaleHandle,
    paneHandle,
    data: [],
    byIndex: null,
    barsInfo: null,
    coord: null,
    price: null,
    last: null,
    ...over,
  };
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };
  const priceLines: IPriceLine[] = [];
  const dataChanged = new EventHub<[StoreDiff]>();

  const port: SeriesPort = {
    isDisposed: () => state.disposed,
    setData: (items) => rec('setData', items),
    update: (item, historical) => rec('update', item, historical),
    data: () => state.data,
    dataByIndex: (logical, mismatch) => {
      rec('dataByIndex', logical, mismatch);
      return state.byIndex;
    },
    barsInLogicalRange: (range) => {
      rec('barsInLogicalRange', range);
      return state.barsInfo;
    },
    store: () => emptyStore,
    priceToCoordinate: (p) => {
      rec('priceToCoordinate', p);
      return state.coord;
    },
    coordinateToPrice: (c) => {
      rec('coordinateToPrice', c);
      return state.price;
    },
    priceFormatter: () => ({ format: (p) => p.toFixed(2) }),
    priceScale: () => state.scaleHandle,
    pane: () => state.paneHandle,
    moveToPane: (i) => rec('moveToPane', i),
    order: () => 0,
    setOrder: (o) => rec('setOrder', o),
    optionsChanged: () => rec('optionsChanged'),
    createPriceLine: (opts) => {
      rec('createPriceLine', opts);
      const line: IPriceLine = { applyOptions: () => {}, options: () => opts as never };
      priceLines.push(line);
      return line;
    },
    removePriceLine: (line) => {
      rec('removePriceLine', line);
      const i = priceLines.indexOf(line);
      if (i >= 0) priceLines.splice(i, 1);
    },
    priceLines: () => priceLines.slice(),
    lastValue: (globalLast) => {
      rec('lastValue', globalLast);
      return state.last;
    },
    dataChanged,
  };
  return { port, state, calls, priceLines };
}

function makeApi(
  init: SeriesInit = lineDefaults,
  over: Partial<FakePortState> = {},
): {
  api: ISeries;
  model: Series;
  port: SeriesPort;
  state: FakePortState;
  calls: Record<string, unknown[]>;
  priceLines: IPriceLine[];
} {
  const model = new Series(init);
  const { port, state, calls, priceLines } = makePort(over);
  const api = createSeriesApi(init.kind, model, port, init.normalizeOptions);
  return { api, model, port, state, calls, priceLines };
}

// --- §8.2 basic map-through --------------------------------------------------------

test('seriesType() returns the definition tag (§8.2)', () => {
  expect(makeApi(lineDefaults).api.seriesType()).toBe('line');
  expect(makeApi(candlestickDefaults).api.seriesType()).toBe('candlestick');
});

test('setData / update forward to the port; update default historical=false (§8.3)', () => {
  const { api, calls } = makeApi();
  const items = [{ time: 1, value: 10 }];
  api.setData(items);
  expect(calls.setData[0][0]).toBe(items);

  api.update({ time: 2, value: 11 });
  expect(calls.update[0]).toEqual([{ time: 2, value: 11 }, false]);

  api.update({ time: 2, value: 12 }, { historical: true });
  expect(calls.update[1][1]).toBe(true);
});

test('dataByIndex default mismatch is "none"; miss returns null (§8.2 / §16.1)', () => {
  const { api, calls } = makeApi();
  expect(api.dataByIndex(5)).toBeNull(); // state.byIndex defaults null
  expect(calls.dataByIndex[0]).toEqual([5, 'none']);

  const explicit: MismatchDirection = 'nearest-left';
  api.dataByIndex(5, explicit);
  expect(calls.dataByIndex[1]).toEqual([5, 'nearest-left']);
});

test('dataByIndex surfaces a materialized item when present', () => {
  const item = { time: 3, value: 9 };
  const { api } = makeApi(lineDefaults, { byIndex: item });
  expect(api.dataByIndex(0)).toBe(item);
});

test('barsInLogicalRange(null) returns null (§8.2 empty/null range)', () => {
  const { api } = makeApi();
  expect(api.barsInLogicalRange(null)).toBeNull();
});

test('barsInLogicalRange forwards the range and returns the port result', () => {
  const info: BarsInfo = { barsBefore: 2, barsAfter: 1, from: 1, to: 5 };
  const range: LogicalRange = { from: 0 as never, to: 4 as never };
  const { api, calls } = makeApi(lineDefaults, { barsInfo: info });
  expect(api.barsInLogicalRange(range)).toBe(info);
  expect(calls.barsInLogicalRange[0][0]).toBe(range);
});

// --- §16.1 null-on-empty for coordinate queries ------------------------------------

test('coordinate conversions return null on empty data/scale (§16.1 kept convention)', () => {
  const { api } = makeApi(); // coord/price default null
  expect(api.priceToCoordinate(100)).toBeNull();
  expect(api.coordinateToPrice(50)).toBeNull();
});

test('coordinate conversions return the branded value when the scale has data', () => {
  const { api } = makeApi(lineDefaults, { coord: 42 as Coordinate, price: 3.14 as BarPrice });
  expect(api.priceToCoordinate(100)).toBe(42);
  expect(api.coordinateToPrice(50)).toBe(3.14);
});

test('priceFormatter() returns an IPriceFormatter', () => {
  const { api } = makeApi();
  expect(api.priceFormatter().format(1.5)).toBe('1.50');
});

// --- §8.2 placement: priceScale() FOLLOWS the series (§2) --------------------------

test('priceScale() resolves through the port at call time and follows the series (§2/§8.3)', () => {
  const { api, port, state } = makeApi();
  const first = api.priceScale();
  expect(first).toBe(state.scaleHandle); // resolves NOW
  // Simulate moveToPane changing the resolved scale; the facade must re-resolve.
  const moved: IPriceScaleHandle = { id: () => 'left' };
  state.scaleHandle = moved;
  void port; // resolution is through the live port, not a cached snapshot
  expect(api.priceScale()).toBe(moved);
});

test('pane() / moveToPane / order / setOrder map through (§8.2)', () => {
  const { api, state, calls } = makeApi();
  expect(api.pane()).toBe(state.paneHandle);
  api.moveToPane(2);
  expect(calls.moveToPane[0]).toEqual([2]);
  expect(api.order()).toBe(0);
  api.setOrder(3);
  expect(calls.setOrder[0]).toEqual([3]);
});

// --- §8.2 / §11.1 price lines: identity cached per handle (§2) ----------------------

test('createPriceLine returns a handle; priceLines() lists it; removePriceLine drops it', () => {
  const { api } = makeApi();
  const opts: PriceLineOptions = { price: 100 };
  const line = api.createPriceLine(opts);
  expect(api.priceLines()).toContain(line);
  api.removePriceLine(line);
  expect(api.priceLines()).not.toContain(line);
});

test('priceLines() returns a fresh array (caller may mutate freely, §4.3)', () => {
  const { api } = makeApi();
  api.createPriceLine({ price: 1 });
  const a = api.priceLines();
  const b = api.priceLines();
  expect(a).not.toBe(b);
  expect(a).toEqual(b);
});

// --- §8.2 legend lastValue ---------------------------------------------------------

test('lastValue() reports {noData:true} on empty (§8.2)', () => {
  const { api } = makeApi();
  expect(api.lastValue()).toEqual({ noData: true });
});

test('lastValue() reports the resolved price + color when present', () => {
  const { api, calls } = makeApi(lineDefaults, { last: { price: 12.5, color: '#abc' } });
  expect(api.lastValue(true)).toEqual({ noData: false, price: 12.5, color: '#abc' });
  expect(calls.lastValue[0]).toEqual([true]); // globalLast forwarded
  expect(makeApi().api.lastValue().noData).toBe(true); // default globalLast=false path
});

// --- §8.2 options: model owns merge; api re-runs §5.3 normalizations ----------------

test('options() returns the model snapshot (§4.3 fresh copy)', () => {
  const { api, model } = makeApi();
  const a = api.options() as Record<string, unknown>;
  expect(a.color).toBe('#2196f3');
  // A fresh copy each call — never the live object (§4.3).
  expect(api.options()).not.toBe(model.options());
});

test('applyOptions forwards to the model and notifies the port (§8.2)', () => {
  const { api, calls } = makeApi();
  api.applyOptions({ color: '#ff0000' } as never);
  expect((api.options() as Record<string, unknown>).color).toBe('#ff0000');
  expect(calls.optionsChanged).toHaveLength(1);
});

test('applyOptions re-runs minMove→precision (§5.3.2 — not creation-only)', () => {
  const { api } = makeApi();
  // minMove without precision → precision derived (precisionByMinMove(0.001) = 3).
  api.applyOptions({ priceFormat: { minMove: 0.001 } } as never);
  const pf = (api.options() as Record<string, { precision: number; minMove: number }>).priceFormat;
  expect(pf.minMove).toBe(0.001);
  expect(pf.precision).toBe(3);
});

test('applyOptions re-runs the candlestick shorthand and DROPS it (§5.3.3 / §6.10)', () => {
  const { api } = makeApi(candlestickDefaults);
  api.applyOptions({ borderColor: '#123456' } as never);
  const o = api.options() as Record<string, unknown>;
  // shorthand fanned out to both variants...
  expect(o.borderUpColor).toBe('#123456');
  expect(o.borderDownColor).toBe('#123456');
  // ...and the write-only aggregate is never stored (unlike the reference).
  expect('borderColor' in o).toBe(false);
});

// --- §12 primitives ----------------------------------------------------------------

test('attachPrimitive / detachPrimitive delegate to the model list (§12)', () => {
  const { api, model } = makeApi();
  const prim = { sources: () => [] };
  api.attachPrimitive(prim);
  expect(model.primitives()).toContain(prim);
  api.detachPrimitive(prim);
  expect(model.primitives()).not.toContain(prim);
});

// --- §14 events: subscribe returns Unsubscribe; unsubscribe by reference ------------

test('subscribeDataChanged fires with the typed StoreDiff; Unsubscribe + unsubscribe both work', () => {
  const { api, port } = makeApi();
  const seen: StoreDiff[] = [];
  const h = (d: StoreDiff): void => {
    seen.push(d);
  };
  const off = api.subscribeDataChanged(h);
  port.dataChanged.emit(() => [{ kind: 'replace' }]);
  expect(seen).toEqual([{ kind: 'replace' }]);

  off(); // Unsubscribe handle
  port.dataChanged.emit(() => [{ kind: 'updateLast' }]);
  expect(seen).toHaveLength(1);

  const h2 = vi.fn();
  api.subscribeDataChanged(h2);
  api.unsubscribeDataChanged(h2); // by-reference removal (§14.1)
  port.dataChanged.emit(() => [{ kind: 'append', count: 1 }]);
  expect(h2).not.toHaveBeenCalled();
});

// --- §2 identity law ---------------------------------------------------------------

test('store() returns an identity-stable view across calls (§8.3)', () => {
  const { api } = makeApi();
  expect(api.store()).toBe(api.store());
});

test('the same handle is returned for the series life — every method off ONE object (§2)', () => {
  const { api } = makeApi();
  // Identity is "one handle per series": every accessor is a method on the same api
  // object, and the handles it hands out (priceScale/pane) are the chart's cached
  // objects, returned === across calls while the series stays put.
  expect(api.priceScale()).toBe(api.priceScale());
  expect(api.pane()).toBe(api.pane());
});

// --- §16.5 disposed guard: EVERY method throws ChartError('disposed') ---------------

test('after dispose every method throws ChartError("disposed") (§16.5)', () => {
  const { api, state, priceLines } = makeApi();
  // Create a price line BEFORE dispose so removePriceLine has a target to attempt.
  const line = api.createPriceLine({ price: 1 });
  void priceLines;
  state.disposed = true; // the chart's shared flag flips

  const prim = {};
  const noop = (): void => {};
  const callers: Array<() => unknown> = [
    () => api.seriesType(),
    () => api.setData([]),
    () => api.update({ time: 1 } as never),
    () => api.data(),
    () => api.dataByIndex(0),
    () => api.barsInLogicalRange(null),
    () => api.store(),
    () => api.applyOptions({} as never),
    () => api.options(),
    () => api.priceToCoordinate(1),
    () => api.coordinateToPrice(1),
    () => api.priceFormatter(),
    () => api.priceScale(),
    () => api.pane(),
    () => api.moveToPane(0),
    () => api.order(),
    () => api.setOrder(0),
    () => api.createPriceLine({ price: 2 }),
    () => api.removePriceLine(line),
    () => api.priceLines(),
    () => api.lastValue(),
    () => api.attachPrimitive(prim),
    () => api.detachPrimitive(prim),
    () => api.subscribeDataChanged(noop),
    () => api.unsubscribeDataChanged(noop),
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
