import { describe, expect, test } from 'vitest';
import { singleValueContract, barContract } from '../data';
import type { SeriesDataContract } from '../data';
import {
  LineSeries,
  AreaSeries,
  BaselineSeries,
  HistogramSeries,
  BarSeries,
  CandlestickSeries,
  defineSeries,
  defaultSeriesOptions,
  isBusinessDay,
  isUTCTimestamp,
} from './series-defs';
import type { SeriesDefinition } from './series-defs';

// Spec of record: 02-public-api-spec.md §13.1/§13.2/§6.9/§6.10, §4.1. Each built-in
// is the {contract, kind} pair (§13.2): contract = the data-side half (§4.5.1), kind
// = the view-side half built from options. Asserts are hand-derived from the spec —
// the lane counts/roles come from §13.1's item shapes, the defaults from §6.9/§6.10,
// the guard semantics from §4.1 + study 09's appendix.

// A SeriesKind<unknown> is a function-bag with the §6 engine members; a built def's
// createKind(options) must produce one. We only assert the shape, headlessly — no
// frame, no render. Minimal loose options bag (every factory tolerates an empty bag,
// merging its own defaults).
const EMPTY_OPTS = {};

function expectIsSeriesKind(kind: unknown): void {
  expect(kind).toBeTypeOf('object');
  const k = kind as Record<string, unknown>;
  for (const member of ['itemsFromStore', 'convert', 'emit', 'decimate', 'hitTest']) {
    expect(k[member]).toBeTypeOf('function');
  }
  expect(typeof k.extendedRange).toBe('boolean');
}

describe('the six built-in series definitions (§13.2)', () => {
  // [definition, expected type tag, expected data contract] — §13.1/§13.2 pairing.
  const cases: ReadonlyArray<readonly [SeriesDefinition<never, unknown, unknown>, string, SeriesDataContract]> = [
    [LineSeries as never, 'line', singleValueContract],
    [AreaSeries as never, 'area', singleValueContract],
    [BaselineSeries as never, 'baseline', singleValueContract],
    [HistogramSeries as never, 'histogram', singleValueContract],
    [BarSeries as never, 'bar', barContract],
    [CandlestickSeries as never, 'candlestick', barContract],
  ];

  for (const [def, type, contract] of cases) {
    test(`${type} carries type='${type}', the right contract, and a kind factory`, () => {
      expect(def.type).toBe(type);
      // The data half is the SAME contract object data exports (§4.5.1) — identity,
      // not a copy: single-value (1 lane) for line/area/baseline/histogram, bar
      // (4 lanes) for bar/candlestick.
      expect(def.contract).toBe(contract);
      // The view half is produced by createKind(options) and is a SeriesKind (§13.2).
      expect(def.createKind).toBeTypeOf('function');
      expectIsSeriesKind(def.createKind(EMPTY_OPTS));
    });
  }

  test('the single-value defs all share the 1-lane contract (§13.1 SingleValueData)', () => {
    for (const def of [LineSeries, AreaSeries, BaselineSeries, HistogramSeries]) {
      expect(def.contract.laneCount).toBe(1);
      expect(def.contract).toBe(singleValueContract);
    }
  });

  test('bar + candlestick share the 4-lane OHLC contract (§13.1 OhlcData)', () => {
    for (const def of [BarSeries, CandlestickSeries]) {
      expect(def.contract.laneCount).toBe(4);
      expect(def.contract).toBe(barContract);
      // roles: close=current(3), low=min(2), high=max(1) (data series-contract).
      expect(def.contract.roles).toEqual({ current: 3, min: 2, max: 1 });
    }
  });

  test('each createKind builds a FRESH kind per call (per-series, not a singleton)', () => {
    // Two series of the same type must not share one stateful kind instance — the
    // engine builds one per addSeries. A shared singleton would cross series state.
    const a = LineSeries.createKind(EMPTY_OPTS);
    const b = LineSeries.createKind(EMPTY_OPTS);
    expect(a).not.toBe(b);
  });

  test('only candlestick declares the borderColor/wickColor normalizeOptions hook (§5.3.3)', () => {
    expect(CandlestickSeries.normalizeOptions).toBeTypeOf('function');
    for (const def of [LineSeries, AreaSeries, BaselineSeries, HistogramSeries, BarSeries]) {
      expect(def.normalizeOptions).toBeUndefined();
    }
  });

  test('candlestick.normalizeOptions fans borderColor/wickColor out to up/down + drops them (§5.3.3)', () => {
    const patch: Record<string, unknown> = { borderColor: '#111', wickColor: '#222' };
    CandlestickSeries.normalizeOptions!(patch);
    expect(patch.borderUpColor).toBe('#111');
    expect(patch.borderDownColor).toBe('#111');
    expect(patch.wickUpColor).toBe('#222');
    expect(patch.wickDownColor).toBe('#222');
    expect('borderColor' in patch).toBe(false);
    expect('wickColor' in patch).toBe(false);
  });
});

describe('per-type style defaults (§6.10)', () => {
  test('Line defaults (§6.10 Line block)', () => {
    expect(LineSeries.defaultOptions).toMatchObject({
      color: '#2196f3',
      lineStyle: 'solid',
      lineWidth: 3,
      lineType: 'simple',
      lineVisible: true,
      pointMarkersVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      lastPriceAnimation: 'disabled',
    });
  });

  test('Area defaults = Line block + fill (§6.10)', () => {
    expect(AreaSeries.defaultOptions).toMatchObject({
      color: '#2196f3', // the Line block
      lineColor: '#33D778',
      topColor: 'rgba( 46, 220, 135, 0.4)',
      bottomColor: 'rgba( 40, 221, 100, 0)',
      invertFilledArea: false,
      relativeGradient: false,
    });
  });

  test('Baseline defaults = Line block + baseValue / two-sided fill (§6.10)', () => {
    expect(BaselineSeries.defaultOptions).toMatchObject({
      color: '#2196f3', // the Line block
      baseValue: { type: 'price', price: 0 },
      relativeGradient: false,
      topFillColor1: 'rgba(38, 166, 154, 0.28)',
      topLineColor: 'rgba(38, 166, 154, 1)',
      bottomFillColor2: 'rgba(239, 83, 80, 0.28)',
      bottomLineColor: 'rgba(239, 83, 80, 1)',
    });
  });

  test('Histogram defaults (§6.10)', () => {
    expect(HistogramSeries.defaultOptions).toEqual({ color: '#26a69a', base: 0 });
  });

  test('Bar defaults (§6.10)', () => {
    expect(BarSeries.defaultOptions).toEqual({
      upColor: '#26a69a',
      downColor: '#ef5350',
      openVisible: true,
      thinBars: true,
    });
  });

  test('Candlestick defaults (§6.10) — up/down/border/wick fully expanded, no shorthands stored', () => {
    expect(CandlestickSeries.defaultOptions).toEqual({
      upColor: '#26a69a',
      downColor: '#ef5350',
      wickVisible: true,
      borderVisible: true,
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
    // §6.10: the write-only shorthands are never part of the stored defaults.
    expect('borderColor' in CandlestickSeries.defaultOptions).toBe(false);
    expect('wickColor' in CandlestickSeries.defaultOptions).toBe(false);
  });
});

describe('defaultSeriesOptions — the strict common-series defaults (§6.9)', () => {
  test('carries exactly the §6.9 commons with their default values', () => {
    expect(defaultSeriesOptions).toEqual({
      title: '',
      visible: true,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineSource: 'last-bar',
      priceLineWidth: 1,
      priceLineColor: '',
      priceLineStyle: 'dashed',
      baseLineVisible: true,
      baseLineWidth: 1,
      baseLineColor: '#B2B5BE',
      baseLineStyle: 'solid',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      hitTestTolerance: 3,
    });
  });
});

describe('defineSeries — the custom-series entry point (§13.2)', () => {
  test('composes a {contract, kind} pair into a custom definition', () => {
    const myContract: SeriesDataContract<{ time: number; v: number }> = {
      laneCount: 1,
      roles: { current: 0, min: 0, max: 0 },
      isWhitespace: (item) => item.v === undefined,
      extractLanes: (item, out, offset) => {
        out[offset] = item.v ?? 0;
      },
    };
    // A stand-in custom kind: a function-bag matching the SeriesKind shape.
    const myKind = {
      itemsFromStore() {},
      convert() {},
      emit() {},
      decimate() {},
      hitTest: () => null,
      extendedRange: false,
    };

    const def = defineSeries({
      type: 'my-indicator', // author's tag; the result is still typed 'custom'
      defaultOptions: { color: '#abc', width: 7 },
      contract: myContract,
      kind: myKind as never,
    });

    // §13.2: defineSeries always returns SeriesDefinition<'custom', ...>.
    expect(def.type).toBe('custom');
    // The author's contract + options flow through unchanged (no casts, no merge).
    expect(def.contract).toBe(myContract);
    expect(def.defaultOptions).toEqual({ color: '#abc', width: 7 });
    // createKind returns the author-supplied live kind (custom authors build it
    // directly; options are ignored on this path).
    expect(def.createKind({})).toBe(myKind);
  });

  test('forwards an optional normalizeOptions hook', () => {
    const hook = (p: Record<string, unknown>) => {
      p.expanded = true;
    };
    const def = defineSeries({
      type: 'x',
      defaultOptions: {},
      contract: singleValueContract as SeriesDataContract<{ time: unknown }>,
      kind: {} as never,
      normalizeOptions: hook,
    });
    expect(def.normalizeOptions).toBe(hook);
    const patch: Record<string, unknown> = {};
    def.normalizeOptions!(patch);
    expect(patch.expanded).toBe(true);
  });

  test('omitting the hook leaves normalizeOptions undefined', () => {
    const def = defineSeries({
      type: 'x',
      defaultOptions: {},
      contract: singleValueContract as SeriesDataContract<{ time: unknown }>,
      kind: {} as never,
    });
    expect(def.normalizeOptions).toBeUndefined();
  });
});

describe('Time type guards (§13.1 / §4.1)', () => {
  test('isBusinessDay: true ONLY for the {year,month,day} object form', () => {
    expect(isBusinessDay({ year: 2026, month: 6, day: 15 })).toBe(true);
    expect(isBusinessDay(1_700_000_000)).toBe(false); // a timestamp number
    expect(isBusinessDay('2026-06-15')).toBe(false); // a date string
  });

  test('isUTCTimestamp: true ONLY for the number form', () => {
    expect(isUTCTimestamp(1_700_000_000)).toBe(true);
    expect(isUTCTimestamp({ year: 2026, month: 6, day: 15 })).toBe(false);
    expect(isUTCTimestamp('2026-06-15')).toBe(false);
  });

  test('the two guards partition the non-string Time forms', () => {
    // A number is a timestamp, never a business day; an object is a business day,
    // never a timestamp (§4.1: number = seconds; object = {y,m,d}).
    const ts = 1_700_000_000;
    const bd = { year: 2026, month: 6, day: 15 };
    expect(isUTCTimestamp(ts) && !isBusinessDay(ts)).toBe(true);
    expect(isBusinessDay(bd) && !isUTCTimestamp(bd)).toBe(true);
  });
});
