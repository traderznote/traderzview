import { describe, expect, test } from 'vitest';
import { PlotStore, barContract, singleValueContract, type StoreDiff } from '../data';
import type { TimeIndex } from '../core';
import {
  Series,
  resolveBarColors,
  candlestickNormalizeOptions,
  type AutoscaleInfo,
  type IPrimitive,
  type PrimitiveSource,
  type AxisLabel,
} from './series';

// study 06 §3 is the spec of record (series options, per-kind normalizeOptions,
// bar-colorer precedence per §4.3, autoscale provider with max-merged margins per
// §4.16 / architecture §9.2.3); design 02 §6.9/§6.10/§13.4 (defaults + the verbatim
// autoscaleInfoProvider seam); architecture §4.6 ("No plugin-specific state on Series",
// the generic IPrimitive[] attachment list).

describe('series options merge + per-kind normalizeOptions hook (study 06 §3)', () => {
  test('user options merge over the per-type defaults (design 02 §6.9/§6.10)', () => {
    const s = new Series({
      kind: 'line',
      defaultOptions: { color: '#2196f3', lineWidth: 3, title: '', priceLineColor: '' },
    });
    expect(s.options().color).toBe('#2196f3');
    expect(s.options().lineWidth).toBe(3);
    s.applyOptions({ color: '#ff0000' });
    expect(s.options().color).toBe('#ff0000');
    expect(s.options().lineWidth).toBe(3); // untouched key keeps its default
  });

  test('options() returns a snapshot, never the live object', () => {
    const s = new Series({ kind: 'line', defaultOptions: { color: '#000', lineWidth: 2 } });
    const a = s.options();
    s.applyOptions({ lineWidth: 4 });
    expect(a.lineWidth).toBe(2); // the earlier snapshot is not mutated
    expect(s.options().lineWidth).toBe(4);
  });

  test('candlestick normalizeOptions fans borderColor/wickColor out to up/down variants', () => {
    const patch: Record<string, unknown> = { borderColor: '#abc', wickColor: '#def' };
    candlestickNormalizeOptions(patch);
    expect(patch.borderUpColor).toBe('#abc');
    expect(patch.borderDownColor).toBe('#abc');
    expect(patch.wickUpColor).toBe('#def');
    expect(patch.wickDownColor).toBe('#def');
    // the write-only shorthands are NOT stored (design 02 §6.10)
    expect('borderColor' in patch).toBe(false);
    expect('wickColor' in patch).toBe(false);
  });

  test('the hook runs through applyOptions (creation + apply, study 06 §3 / design 02 §5.3.3)', () => {
    const s = new Series({
      kind: 'candlestick',
      defaultOptions: {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderUpColor: '#26a69a',
        borderDownColor: '#ef5350',
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      },
      normalizeOptions: candlestickNormalizeOptions,
    });
    s.applyOptions({ borderColor: '#111', wickColor: '#222' } as Record<string, unknown>);
    expect(s.options().borderUpColor).toBe('#111');
    expect(s.options().borderDownColor).toBe('#111');
    expect(s.options().wickUpColor).toBe('#222');
    expect(s.options().wickDownColor).toBe('#222');
  });
});

describe('bar-colorer precedence (study 06 §4.3)', () => {
  test('Bar: per-point override beats up/down beats option default', () => {
    const opts = { upColor: '#26a69a', downColor: '#ef5350' };
    // up bar (open <= close), no override → upColor
    expect(resolveBarColors('bar', { open: 1, close: 2 }, {}, opts).barColor).toBe('#26a69a');
    // down bar, no override → downColor
    expect(resolveBarColors('bar', { open: 5, close: 2 }, {}, opts).barColor).toBe('#ef5350');
    // per-point override wins over the up/down choice
    expect(resolveBarColors('bar', { open: 1, close: 2 }, { color: '#fff' }, opts).barColor).toBe(
      '#fff',
    );
  });

  test('Candlestick: barColor / borderColor / wickColor each follow override → up/down', () => {
    const opts = {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#11',
      borderDownColor: '#22',
      wickUpColor: '#33',
      wickDownColor: '#44',
    };
    const up = resolveBarColors('candlestick', { open: 1, close: 2 }, {}, opts);
    expect(up).toEqual({ barColor: '#26a69a', barBorderColor: '#11', barWickColor: '#33' });
    const overridden = resolveBarColors(
      'candlestick',
      { open: 5, close: 2 },
      { color: '#c', borderColor: '#b', wickColor: '#w' },
      opts,
    );
    expect(overridden).toEqual({ barColor: '#c', barBorderColor: '#b', barWickColor: '#w' });
  });

  test('Line / Histogram: row.color ?? options.color', () => {
    expect(resolveBarColors('line', { open: 7, close: 7 }, {}, { color: '#lll' }).barColor).toBe(
      '#lll',
    );
    expect(
      resolveBarColors('histogram', { open: 7, close: 7 }, { color: '#ovr' }, { color: '#def' })
        .barColor,
    ).toBe('#ovr');
  });

  test('Baseline: above/below baseValue, options only — per-point override IGNORED (§4.3 / §5)', () => {
    const opts = { topLineColor: '#top', bottomLineColor: '#bot', baseValue: { price: 10 } };
    // close >= base → top
    expect(resolveBarColors('baseline', { open: 0, close: 12 }, { color: '#X' }, opts).barColor).toBe(
      '#top',
    );
    // close < base → bottom; override still ignored
    expect(resolveBarColors('baseline', { open: 0, close: 8 }, { color: '#X' }, opts).barColor).toBe(
      '#bot',
    );
  });
});

describe('StoreDiff consumption updates last-value state (architecture §4.5 / study 06 §3)', () => {
  test('replace / append / updateLast refresh the last value + resolved price-line color', () => {
    const store = new PlotStore(singleValueContract);
    const s = new Series({ kind: 'line', defaultOptions: { color: '#222', priceLineColor: '' } });

    const replace: StoreDiff = store.setData(
      [{ value: 10 }, { value: 20 }, { value: 30 }],
      [0, 1, 2],
    );
    s.applyDiff(store, replace);
    expect(s.lastValue()?.price).toBe(30);
    expect(s.lastValue()?.index).toBe(2);
    // priceLineColor is '' → derive from the last bar's resolved color (study 06 §3)
    expect(s.priceLineColor()).toBe('#222');

    const append: StoreDiff = store.append([{ value: 40 }], [3]);
    s.applyDiff(store, append);
    expect(s.lastValue()?.price).toBe(40);
    expect(s.lastValue()?.index).toBe(3);

    // overwrite the realtime bar in place
    const refreshed = new PlotStore(singleValueContract);
    refreshed.setData([{ value: 10 }, { value: 20 }, { value: 30 }, { value: 99 }], [0, 1, 2, 3]);
    s.applyDiff(refreshed, { kind: 'updateLast' });
    expect(s.lastValue()?.price).toBe(99);
  });

  test('an empty store clears the last value', () => {
    const store = new PlotStore(singleValueContract);
    const s = new Series({ kind: 'line', defaultOptions: { color: '#222' } });
    s.applyDiff(store, store.setData([], []));
    expect(s.lastValue()).toBeNull();
  });

  test('explicit priceLineColor option wins over the derived last-bar color', () => {
    const store = new PlotStore(singleValueContract);
    const s = new Series({
      kind: 'line',
      defaultOptions: { color: '#222', priceLineColor: '#abcdef' },
    });
    s.applyDiff(store, store.setData([{ value: 5 }], [0]));
    expect(s.priceLineColor()).toBe('#abcdef');
  });
});

describe('autoscale provider — range + MAX-merged margins (architecture §9.2.3 / study 06 §4.16)', () => {
  function lineSeriesWith(values: number[]): { series: Series; store: PlotStore } {
    const store = new PlotStore(singleValueContract);
    store.setData(
      values.map((v) => ({ value: v })),
      values.map((_, i) => i),
    );
    const series = new Series({ kind: 'line', defaultOptions: { color: '#000' } });
    series.applyDiff(store, { kind: 'replace' });
    return { series, store };
  }

  test('base implementation: range over the data + zero margins by default', () => {
    const { series, store } = lineSeriesWith([10, 50, 30]);
    const info = series.autoscaleInfo(store, { from: 0 as TimeIndex, to: 2 as TimeIndex });
    expect(info?.priceRange).toEqual({ minValue: 10, maxValue: 50 });
    expect(info?.margins ?? { above: 0, below: 0 }).toEqual({ above: 0, below: 0 });
  });

  test('primitive contributors are MAX-merged with the series margins (the ONE merge fn)', () => {
    const { series, store } = lineSeriesWith([10, 50, 30]);
    // two primitives contribute extra range + margins; margins MAX-merge, ranges union.
    series.attachPrimitive(makePrimitive({ priceRange: { minValue: 5, maxValue: 40 }, margins: { above: 8, below: 2 } }));
    series.attachPrimitive(makePrimitive({ priceRange: { minValue: 20, maxValue: 70 }, margins: { above: 3, below: 9 } }));
    const info = series.autoscaleInfo(store, { from: 0 as TimeIndex, to: 2 as TimeIndex });
    // range = union(series 10..50, prim 5..40, prim 20..70) = 5..70
    expect(info?.priceRange).toEqual({ minValue: 5, maxValue: 70 });
    // margins = MAX over contributors (none below the series' 0): above max(0,8,3)=8, below max(0,2,9)=9
    expect(info?.margins).toEqual({ above: 8, below: 9 });
  });

  test('autoscaleInfoProvider seam wraps the base implementation VERBATIM (design 02 §13.4)', () => {
    const { series, store } = lineSeriesWith([10, 50, 30]);
    let sawBase: AutoscaleInfo | null = null;
    series.applyOptions({
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        sawBase = base(); // the provider may call the base implementation
        return { priceRange: { minValue: 0, maxValue: 100 }, margins: { above: 1, below: 1 } };
      },
    } as Record<string, unknown>);
    const info = series.autoscaleInfo(store, { from: 0 as TimeIndex, to: 2 as TimeIndex });
    expect(sawBase).toEqual({ priceRange: { minValue: 10, maxValue: 50 }, margins: { above: 0, below: 0 } });
    expect(info).toEqual({ priceRange: { minValue: 0, maxValue: 100 }, margins: { above: 1, below: 1 } });
  });
});

describe('generic IPrimitive[] attachment list — no plugin-specific field (architecture §4.6)', () => {
  test('attach / detach the generic list; Series carries no markers slot', () => {
    const s = new Series({ kind: 'line', defaultOptions: { color: '#000' } });
    expect(s.primitives()).toEqual([]);
    const p = makePrimitive({});
    s.attachPrimitive(p);
    expect(s.primitives()).toEqual([p]);
    s.detachPrimitive(p);
    expect(s.primitives()).toEqual([]);
    // No plugin-specific state: there is no `markers` (or similar) field on Series.
    expect((s as unknown as Record<string, unknown>).markers).toBeUndefined();
  });

  test('sources() and priceAxisLabels() hooks plumb through every attached primitive', () => {
    const s = new Series({ kind: 'line', defaultOptions: { color: '#000' } });
    const src: PrimitiveSource = { target: 'pane', source: {} as PrimitiveSource['source'] };
    const label: AxisLabel = {
      coordinate: () => 12,
      text: () => 'x',
      textColor: () => '#fff',
      backColor: () => '#000',
    };
    s.attachPrimitive(makePrimitive({ sources: [src], priceAxisLabels: [label] }));
    expect(s.primitiveSources()).toEqual([src]);
    expect(s.primitivePriceAxisLabels()).toEqual([label]);
  });

  test('detach is a no-op for an unknown primitive', () => {
    const s = new Series({ kind: 'line', defaultOptions: { color: '#000' } });
    const a = makePrimitive({});
    s.attachPrimitive(a);
    s.detachPrimitive(makePrimitive({}));
    expect(s.primitives()).toEqual([a]);
  });
});

// --- test helpers -------------------------------------------------------------

function makePrimitive(opts: {
  priceRange?: { minValue: number; maxValue: number } | null;
  margins?: { above: number; below: number };
  sources?: readonly PrimitiveSource[];
  priceAxisLabels?: readonly AxisLabel[];
}): IPrimitive {
  return {
    autoscale: (): AutoscaleInfo | null =>
      opts.priceRange === undefined && opts.margins === undefined
        ? null
        : { priceRange: opts.priceRange ?? null, margins: opts.margins },
    sources: (): readonly PrimitiveSource[] => opts.sources ?? [],
    priceAxisLabels: (): readonly AxisLabel[] => opts.priceAxisLabels ?? [],
  };
}
