// Spec of record: 02-public-api-spec.md §10 (IPriceScale facade), §2 (identity law —
// dead handle after destroy, fresh handle on recreate), §16 (disposed guard, null on
// no-data, RangeError on from > to, empty-scale no-op). Headless: a recording fake
// PriceScalePort (no DOM, no canvas, no real model) exercises the facade's map-through,
// the §10 boundary rules the facade OWNS, the two guards (disposed, dead-scale), and a
// tiny chart-like (pane, scaleId)→handle cache mirroring chart.ts to prove identity.
import { expect, test } from 'vitest';
import type { BarPrice, DeepPartial, DeepReadonly } from '../core';
import type { PriceScaleOptions } from '../model';
import { ChartError } from './errors';
import {
  createPriceScaleApi,
  type IPriceScale,
  type PriceScalePort,
} from './price-scale';

// --- fakes -------------------------------------------------------------------------

interface FakeState {
  disposed: boolean;
  alive: boolean;
  empty: boolean;
  id: string;
  width: number;
  visibleRange: { from: BarPrice; to: BarPrice } | null;
  autoScale: boolean;
  options: PriceScaleOptions;
}

function makePort(over: Partial<FakeState> = {}): {
  port: PriceScalePort;
  state: FakeState;
  calls: Record<string, unknown[]>;
} {
  const state: FakeState = {
    disposed: false,
    alive: true,
    empty: false,
    id: 'right',
    width: 64,
    visibleRange: null,
    autoScale: true,
    options: { autoScale: true, visible: true } as unknown as PriceScaleOptions,
    ...over,
  };
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };
  const port: PriceScalePort = {
    isDisposed: () => state.disposed,
    isAlive: () => state.alive,
    isEmpty: () => state.empty,
    id: () => state.id,
    applyOptions: (p) => rec('applyOptions', p),
    options: () => state.options as unknown as DeepReadonly<PriceScaleOptions>,
    width: () => state.width,
    getVisibleRange: () => state.visibleRange,
    setVisibleRange: (r) => rec('setVisibleRange', r),
    autoScaleActive: () => state.autoScale,
  };
  return { port, state, calls };
}

function makeApi(over: Partial<FakeState> = {}): {
  api: IPriceScale;
  state: FakeState;
  calls: Record<string, unknown[]>;
} {
  const { port, state, calls } = makePort(over);
  return { api: createPriceScaleApi({ port }), state, calls };
}

// --- §10 map-through ---------------------------------------------------------------

test('id() / width() / autoScaleActive() / options() map through (§10)', () => {
  const { api, state } = makeApi({ id: 'left', width: 48, autoScale: false });
  expect(api.id()).toBe('left');
  expect(api.width()).toBe(48);
  expect(api.autoScaleActive()).toBe(false);
  expect(api.options()).toBe(state.options); // the port snapshot source
});

test('width() is 0 for an overlay scale (kept §10)', () => {
  expect(makeApi({ id: 'volume', width: 0 }).api.width()).toBe(0);
});

test('getVisibleRange returns null when the scale has no data (§10/§16.1)', () => {
  expect(makeApi().api.getVisibleRange()).toBeNull(); // visibleRange defaults null
});

test('getVisibleRange surfaces the port range when present (§10)', () => {
  const range = { from: 10 as BarPrice, to: 90 as BarPrice };
  expect(makeApi({ visibleRange: range }).api.getVisibleRange()).toBe(range);
});

test('applyOptions forwards the patch to the model unchanged (§10/§5.1)', () => {
  const { api, calls } = makeApi();
  const patch: DeepPartial<PriceScaleOptions> = { mode: 'logarithmic' as never, invertScale: true };
  api.applyOptions(patch);
  expect(calls.applyOptions[0][0]).toBe(patch);
});

// --- §10 setVisibleRange boundary rules --------------------------------------------

test('setVisibleRange forwards a well-formed range (the model disables autoscale, §10)', () => {
  const { api, calls } = makeApi();
  const range = { from: 5, to: 50 };
  api.setVisibleRange(range);
  expect(calls.setVisibleRange[0][0]).toBe(range);
});

test('setVisibleRange throws RangeError when from > to, before any port call (§10/§16.2)', () => {
  const { api, calls } = makeApi();
  expect(() => api.setVisibleRange({ from: 90, to: 10 })).toThrow(RangeError);
  expect(calls.setVisibleRange).toBeUndefined();
});

test('setVisibleRange accepts from === to (boundary, not malformed)', () => {
  const { api, calls } = makeApi();
  api.setVisibleRange({ from: 3, to: 3 });
  expect(calls.setVisibleRange).toHaveLength(1);
});

test('setVisibleRange on a scale with NO DATA is a silent no-op (§10/§16.4)', () => {
  const { api, calls } = makeApi({ empty: true });
  api.setVisibleRange({ from: 5, to: 50 }); // well-formed, but no data to scale against
  expect(calls.setVisibleRange).toBeUndefined();
});

test('from > to throws RangeError even on a no-data scale (malformed input wins, §10)', () => {
  const { api, calls } = makeApi({ empty: true });
  expect(() => api.setVisibleRange({ from: 90, to: 10 })).toThrow(RangeError);
  expect(calls.setVisibleRange).toBeUndefined();
});

// --- §10 setAutoScale is sugar over applyOptions -----------------------------------

test('setAutoScale(on) is sugar for applyOptions({ autoScale: on }) (§10)', () => {
  const { api, calls } = makeApi();
  api.setAutoScale(false);
  expect(calls.applyOptions[0][0]).toEqual({ autoScale: false });
  api.setAutoScale(true);
  expect(calls.applyOptions[1][0]).toEqual({ autoScale: true });
  // No separate setVisibleRange / autoscale code path is invoked.
  expect(calls.setVisibleRange).toBeUndefined();
});

// --- §2 identity law: dead handle after destroy + fresh handle on recreate ---------

test('a destroyed scale handle stays dead: every method throws no-such-scale (§2/§10)', () => {
  const { api, state } = makeApi({ id: 'volume' });
  state.alive = false; // the underlying overlay scale was destroyed (last series left)

  const callers: Array<() => unknown> = [
    () => api.applyOptions({}),
    () => api.options(),
    () => api.width(),
    () => api.getVisibleRange(),
    () => api.setVisibleRange({ from: 1, to: 2 }),
    () => api.setAutoScale(true),
    () => api.autoScaleActive(),
  ];
  for (const call of callers) {
    let thrown: unknown;
    try {
      call();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ChartError);
    expect((thrown as ChartError).code).toBe('no-such-scale');
  }
});

test('id() still answers on a destroyed (but not disposed) handle (§10 — it knows its id)', () => {
  // The dead handle remembers which id it WAS; id() is the one read that survives
  // destruction (only a disposed chart silences it). Cheap, and lets callers log it.
  const { api, state } = makeApi({ id: 'volume' });
  state.alive = false;
  expect(api.id()).toBe('volume');
});

test('re-creating a destroyed overlay id yields a FRESH handle, not the dead one (§2/§10)', () => {
  // Mirror chart.ts's per-(pane, scaleId) Map cache: identity covers LIVE objects, not
  // reincarnations. The chart caches one handle per id; when the id's scale is destroyed
  // the chart drops the cache entry, so the next priceScale(id) mints a fresh handle.
  const cache = new Map<string, IPriceScale>();
  const handleFor = (id: string): IPriceScale => {
    let h = cache.get(id);
    if (h === undefined) {
      h = createPriceScaleApi({ port: makePort({ id }).port });
      cache.set(id, h);
    }
    return h;
  };

  const first = handleFor('volume');
  expect(handleFor('volume')).toBe(first); // §2: same live id → same cached handle

  cache.delete('volume'); // the scale was destroyed → chart drops the dead entry
  const reborn = handleFor('volume');
  expect(reborn).not.toBe(first); // §10: a re-created id is a FRESH handle, never the dead one
});

test('cached-per-(pane, scaleId): distinct ids get distinct handles (§2)', () => {
  const left = createPriceScaleApi({ port: makePort({ id: 'left' }).port });
  const right = createPriceScaleApi({ port: makePort({ id: 'right' }).port });
  expect(left).not.toBe(right);
  expect(left.id()).toBe('left');
  expect(right.id()).toBe('right');
});

// --- §16.5 disposed guard: EVERY method throws ChartError('disposed') --------------

test('after dispose every method throws ChartError("disposed") (§16.5)', () => {
  const { api, state } = makeApi();
  state.disposed = true; // the chart's shared flag flips

  const callers: Array<() => unknown> = [
    () => api.id(),
    () => api.applyOptions({}),
    () => api.options(),
    () => api.width(),
    () => api.getVisibleRange(),
    () => api.setVisibleRange({ from: 1, to: 2 }),
    () => api.setAutoScale(true),
    () => api.autoScaleActive(),
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

test('disposed wins over dead-scale AND over the from > to check (§16.5 precedence)', () => {
  // A disposed chart throws 'disposed' even when the scale is also dead and the range
  // is malformed — the disposed guard is the first statement in every method.
  const { api, state } = makeApi();
  state.disposed = true;
  state.alive = false;
  let thrown: unknown;
  try {
    api.setVisibleRange({ from: 90, to: 1 });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ChartError);
  expect((thrown as ChartError).code).toBe('disposed');
});

test('dead-scale guard runs BEFORE the from > to check (§10 precedence)', () => {
  // A live-but-destroyed scale throws no-such-scale, NOT RangeError, even for a
  // malformed range — the dead guard precedes the boundary check.
  const { api, state } = makeApi();
  state.alive = false;
  let thrown: unknown;
  try {
    api.setVisibleRange({ from: 90, to: 1 });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ChartError);
  expect((thrown as ChartError).code).toBe('no-such-scale');
});

// --- §2 a single facade object is stable across calls ------------------------------

test('the facade is a single stable object; reads are consistent across calls (§2)', () => {
  const { api } = makeApi({ width: 72 });
  expect(api).toBe(api);
  expect(api.width()).toBe(api.width());
});
