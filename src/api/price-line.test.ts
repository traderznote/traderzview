// Spec of record: 02-public-api-spec.md §11.1 (IPriceLine facade), §2 (identity law —
// one handle per createPriceLine call; series.removePriceLine kills it), §16 (disposed
// guard, §4.3 snapshot-out options). Headless: a recording fake PriceLinePort (no DOM,
// no canvas, no real model) exercises the facade's map-through + the two guards the
// facade OWNS, plus a tiny series-like createPriceLine/priceLines/removePriceLine cache
// mirroring the wiring to prove the §2 identity law + the dead-handle-after-removal rule.
import { expect, test } from 'vitest';
import type { DeepPartial, DeepReadonly } from '../core';
import { ChartError } from './errors';
import { createPriceLineApi, type PriceLinePort } from './price-line';
// IPriceLine / PriceLineOptions are owned by ./series (the §11.1 public surface);
// ./price-line owns the factory + port (mirrors time-scale.test.ts importing
// LogicalRange from ./series).
import type { IPriceLine, PriceLineOptions } from './series';

// --- fakes -------------------------------------------------------------------------

interface FakeState {
  disposed: boolean;
  alive: boolean;
  options: PriceLineOptions;
}

function makePort(over: Partial<FakeState> = {}): {
  port: PriceLinePort;
  state: FakeState;
  calls: Record<string, unknown[]>;
} {
  const state: FakeState = {
    disposed: false,
    alive: true,
    options: { price: 100, color: '#FF0000', lineStyle: 'dashed', lineWidth: 1 },
    ...over,
  };
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };
  const port: PriceLinePort = {
    isDisposed: () => state.disposed,
    isAlive: () => state.alive,
    applyOptions: (p) => {
      rec('applyOptions', p);
      // The model owns the merge; the fake just records + reflects the patch for the
      // options()-round-trip assertions (shallow is enough for these flat options).
      state.options = { ...state.options, ...(p as PriceLineOptions) };
    },
    // Fresh copy each call — never the live object (§4.3).
    options: () => ({ ...state.options }) as DeepReadonly<PriceLineOptions>,
  };
  return { port, state, calls };
}

// A tiny stand-in for the series' price-line cache + lifecycle (mirrors the create-chart
// wiring behind series.createPriceLine / priceLines() / removePriceLine, §2). Each line
// gets its own port state; removePriceLine flips alive=false (permanent death).
function makeSeriesLike(disposedCell: { value: boolean }): {
  createPriceLine(options: PriceLineOptions): IPriceLine;
  priceLines(): readonly IPriceLine[];
  removePriceLine(line: IPriceLine): void;
  stateOf(line: IPriceLine): FakeState | undefined;
} {
  const lines: IPriceLine[] = [];
  const states = new Map<IPriceLine, FakeState>();
  return {
    createPriceLine(options): IPriceLine {
      const { port, state } = makePort({ options });
      // The chart's shared disposed flag is read live through the cell (§16.5).
      const wired: PriceLinePort = { ...port, isDisposed: () => disposedCell.value };
      const handle = createPriceLineApi({ port: wired });
      lines.push(handle);
      states.set(handle, state);
      return handle;
    },
    priceLines: () => lines.slice(), // fresh array (§4.3)
    removePriceLine(line): void {
      const i = lines.indexOf(line);
      if (i >= 0) lines.splice(i, 1);
      const s = states.get(line);
      if (s) s.alive = false; // handle is permanently dead (§11.1)
    },
    stateOf: (line) => states.get(line),
  };
}

// --- §11.1 map-through -------------------------------------------------------------

test('applyOptions forwards the patch to the port (§11.1)', () => {
  const { port, calls } = makePort();
  const api = createPriceLineApi({ port });
  const patch: DeepPartial<PriceLineOptions> = { color: '#00FF00', title: 'support' };
  api.applyOptions(patch);
  expect(calls.applyOptions[0][0]).toBe(patch); // forwarded unchanged (no §5.3 norms)
});

test('options() returns a fresh snapshot, never the live object (§4.3)', () => {
  const { api } = (() => {
    const { port } = makePort();
    return { api: createPriceLineApi({ port }) };
  })();
  const a = api.options();
  const b = api.options();
  expect(a).not.toBe(b); // fresh copy each call (§4.3)
  expect(a).toEqual(b);
  expect((a as PriceLineOptions).price).toBe(100);
});

test('applyOptions then options() reflects the merged value (§11.1)', () => {
  const { port } = makePort();
  const api = createPriceLineApi({ port });
  api.applyOptions({ color: '#123456' });
  expect((api.options() as PriceLineOptions).color).toBe('#123456');
});

// --- §2 identity law: one handle per createPriceLine call --------------------------

test('createPriceLine returns ONE stable handle; priceLines() lists the SAME object (§2)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const line = series.createPriceLine({ price: 50 });
  // Identity is "one handle per created line": the cached handle is the SAME object the
  // list reports — === across calls for the line's life.
  expect(series.priceLines()).toContain(line);
  expect(series.priceLines()[0]).toBe(series.priceLines()[0]);
  expect(series.priceLines()[0]).toBe(line);
});

test('priceLines() returns a fresh array the caller may mutate (§4.3 / §2)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  series.createPriceLine({ price: 1 });
  const a = series.priceLines();
  const b = series.priceLines();
  expect(a).not.toBe(b);
  expect(a).toEqual(b);
});

test('distinct createPriceLine calls yield distinct handles (one per call, §2)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const a = series.createPriceLine({ price: 1 });
  const b = series.createPriceLine({ price: 2 });
  expect(a).not.toBe(b);
});

// --- §11.1 dead handle: removePriceLine kills it, subsequent use throws -------------

test('removePriceLine drops the handle from priceLines() (§11.1)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const line = series.createPriceLine({ price: 7 });
  series.removePriceLine(line);
  expect(series.priceLines()).not.toContain(line);
});

test('after removePriceLine every method throws ChartError (dead handle, §11.1)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const line = series.createPriceLine({ price: 7 });
  series.removePriceLine(line);
  expect(series.stateOf(line)?.alive).toBe(false);

  expect(() => line.applyOptions({ color: '#fff' })).toThrow(ChartError);
  expect(() => line.options()).toThrow(ChartError);
});

test('a still-attached line keeps working after a SIBLING line is removed (§2 per-line)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const a = series.createPriceLine({ price: 1 });
  const b = series.createPriceLine({ price: 2 });
  series.removePriceLine(a);
  // a is dead; b is untouched (identity + lifecycle are per created line).
  expect(() => a.options()).toThrow(ChartError);
  expect(() => b.options()).not.toThrow();
  expect((b.options() as PriceLineOptions).price).toBe(2);
});

// --- §16.5 disposed guard: disposed wins chart-wide, FIRST --------------------------

test('after chart dispose every method throws ChartError("disposed") (§16.5)', () => {
  const { port, state } = makePort();
  const api = createPriceLineApi({ port });
  state.disposed = true; // the chart's shared flag flips

  for (const call of [() => api.applyOptions({ color: '#fff' }), () => api.options()]) {
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

test('disposed wins over a dead line — disposed checked FIRST (§16.5 chart-wide)', () => {
  const { port, state } = makePort({ alive: false });
  const api = createPriceLineApi({ port });
  state.disposed = true;
  let thrown: unknown;
  try {
    api.options();
  } catch (e) {
    thrown = e;
  }
  expect((thrown as ChartError).code).toBe('disposed'); // not a stray no-such-scale etc.
});
