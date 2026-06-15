// Spec of record: 02-public-api-spec.md §5 (merge + three-layer defaults + the four
// boundary normalizations) and §6 (concrete defaults), with §4.3 (snapshot-out) and
// §5.5 (interactive state is not options). Every assertion is hand-derived from the
// cited contract, not echoed from the implementation. Headless: no DOM, no canvas.
import { describe, expect, test, vi } from 'vitest';
import { candlestickNormalizeOptions } from '../model';
import { precisionByMinMove } from '../fmt';
import {
  applyChartOptions,
  applySeriesOptions,
  cloneOptions,
  createChartOptions,
  createSeriesOptions,
  effectiveDefaults,
  normalizeChartPatch,
  normalizeHandleScale,
  normalizeHandleScroll,
  normalizePriceFormat,
  normalizeRightOffsetPixels,
  normalizeSeriesPatch,
  snapshot,
} from './options';

// --- minimal hand-built fixtures (NOT the real library defaults — derived locally
//     so the tests assert the pipeline's behavior, not the spec table's values) -----

interface ScrollFlags {
  mouseWheel: boolean;
  pressedMouseMove: boolean;
  horzTouchDrag: boolean;
  vertTouchDrag: boolean;
}
interface ScaleFlags {
  mouseWheel: boolean;
  pinch: boolean;
  axisPressedMouseMove: { time: boolean; price: boolean };
  axisDoubleClickReset: { time: boolean; price: boolean };
}
interface TimeScaleOpts {
  rightOffset: number;
  rightOffsetPixels: number | undefined;
  barSpacing: number;
}
interface ChartOpts {
  handleScroll: ScrollFlags;
  handleScale: ScaleFlags;
  timeScale: TimeScaleOpts;
  localization: { dateFormat: string; locale: string };
}

function chartDefaults(): ChartOpts {
  return {
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: {
      mouseWheel: true,
      pinch: true,
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: { time: true, price: true },
    },
    timeScale: { rightOffset: 0, rightOffsetPixels: undefined, barSpacing: 6 },
    localization: { dateFormat: '', locale: '' },
  };
}

interface PriceFormat {
  type: string;
  precision: number;
  minMove: number;
}
interface SeriesOpts {
  upColor: string;
  downColor: string;
  borderUpColor: string;
  borderDownColor: string;
  wickUpColor: string;
  wickDownColor: string;
  priceFormat: PriceFormat;
}
function seriesDefaults(): SeriesOpts {
  return {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  };
}

// =============================================================================
// §4.3 — snapshot-out: fresh deep copy, deep-frozen in dev
// =============================================================================
describe('snapshot (§4.3 / A5)', () => {
  test('returns a deep copy, never the live object', () => {
    const live = { layout: { textColor: '#191919' }, width: 0 };
    const snap = snapshot(live);
    expect(snap).toEqual(live);
    expect(snap).not.toBe(live);
    expect(snap.layout).not.toBe(live.layout);
  });

  test('is deep-frozen in dev so an accidental write throws (§4.3)', () => {
    // tests run with __DEV__=true (vitest.config define).
    const snap = snapshot({ layout: { textColor: '#191919' } });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.layout)).toBe(true);
    expect(() => {
      (snap as { layout: { textColor: string } }).layout.textColor = '#000000';
    }).toThrow();
  });

  test('mutating the live object after snapshot does not change the snapshot', () => {
    const live = { n: 1, nested: { v: 10 } };
    const snap = snapshot(live);
    live.n = 99;
    live.nested.v = 99;
    expect(snap.n).toBe(1);
    expect(snap.nested.v).toBe(10);
  });

  test('cloneOptions shares functions/arrays by reference (never deep-copied)', () => {
    const fn = (): number => 1;
    const arr = [1, 2, 3];
    const copy = cloneOptions({ fn, arr, leaf: 5 });
    expect(copy.fn).toBe(fn);
    expect(copy.arr).toBe(arr);
    expect(copy.leaf).toBe(5);
  });
});

// =============================================================================
// §5.3.1 — handleScroll / handleScale boolean → object expansion
// =============================================================================
describe('normalizeHandleScroll (§5.3.1)', () => {
  test('true fans out to all four flags true', () => {
    expect(normalizeHandleScroll(true)).toEqual({
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: true,
    });
  });
  test('false fans out to all four flags false', () => {
    expect(normalizeHandleScroll(false)).toEqual({
      mouseWheel: false,
      pressedMouseMove: false,
      horzTouchDrag: false,
      vertTouchDrag: false,
    });
  });
  test('a partial object passes through untouched (the §5.1 merge fills the rest)', () => {
    const partial = { mouseWheel: false };
    expect(normalizeHandleScroll(partial)).toBe(partial);
  });
});

describe('normalizeHandleScale (§5.3.1)', () => {
  test('true fans out to all flags incl. both {time,price} axis members', () => {
    expect(normalizeHandleScale(true)).toEqual({
      mouseWheel: true,
      pinch: true,
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: { time: true, price: true },
    });
  });
  test('false fans out to all flags false', () => {
    expect(normalizeHandleScale(false)).toEqual({
      mouseWheel: false,
      pinch: false,
      axisPressedMouseMove: { time: false, price: false },
      axisDoubleClickReset: { time: false, price: false },
    });
  });
  test('boolean axis member expands to {time,price}; object member passes through', () => {
    const out = normalizeHandleScale({
      axisPressedMouseMove: false,
      axisDoubleClickReset: { time: true, price: false },
    }) as ScaleFlags;
    expect(out.axisPressedMouseMove).toEqual({ time: false, price: false });
    expect(out.axisDoubleClickReset).toEqual({ time: true, price: false });
  });
});

// =============================================================================
// §5.3.4 — rightOffsetPixels px → bars; px=0 / unset behaves as unset; px wins
// =============================================================================
describe('normalizeRightOffsetPixels (§5.3.4)', () => {
  test('px → bars = px / barSpacing, written onto rightOffset; pixel key dropped', () => {
    const out = normalizeRightOffsetPixels({ rightOffsetPixels: 60 }, 6);
    expect(out.rightOffset).toBe(10); // 60 / 6
    expect('rightOffsetPixels' in out).toBe(false);
  });
  test('configured px=0 behaves as unset: rightOffset untouched, pixel key dropped', () => {
    const out = normalizeRightOffsetPixels({ rightOffsetPixels: 0, rightOffset: 3 }, 6);
    expect(out.rightOffset).toBe(3);
    expect('rightOffsetPixels' in out).toBe(false);
  });
  test('unset px: pixel key dropped, rightOffset untouched', () => {
    const out = normalizeRightOffsetPixels({ rightOffset: 4 }, 6);
    expect(out.rightOffset).toBe(4);
    expect('rightOffsetPixels' in out).toBe(false);
  });
  test('px wins over a co-present rightOffset (px truthy)', () => {
    const out = normalizeRightOffsetPixels({ rightOffsetPixels: 30, rightOffset: 1 }, 6);
    expect(out.rightOffset).toBe(5); // 30 / 6, not 1
  });
  test('barSpacing 0 cannot resolve px: rightOffset untouched, key still dropped', () => {
    const out = normalizeRightOffsetPixels({ rightOffsetPixels: 30, rightOffset: 2 }, 0);
    expect(out.rightOffset).toBe(2);
    expect('rightOffsetPixels' in out).toBe(false);
  });
});

// =============================================================================
// §5.3.2 — minMove without precision → precisionByMinMove
// =============================================================================
describe('normalizePriceFormat (§5.3.2)', () => {
  test('minMove without precision derives precision (kept verbatim algorithm)', () => {
    const out = normalizePriceFormat({ minMove: 0.001 });
    expect(out.precision).toBe(precisionByMinMove(0.001)); // 3
    expect(out.precision).toBe(3);
  });
  test('explicit precision is respected even when minMove is present', () => {
    const out = normalizePriceFormat({ minMove: 0.001, precision: 5 });
    expect(out.precision).toBe(5);
  });
  test('no minMove: precision untouched', () => {
    const out = normalizePriceFormat({ type: 'price' });
    expect('precision' in out).toBe(false);
  });
});

// =============================================================================
// §5.2 — three-layer defaults pipeline
// =============================================================================
describe('effectiveDefaults (§5.2 layer 1 + 2)', () => {
  test('clones library defaults and lets the behavior augment in place', () => {
    const lib = chartDefaults();
    const eff = effectiveDefaults<ChartOpts, { localization: { dateFormat: string } }>(lib, (g) => {
      g.localization.dateFormat = "dd MMM 'yy";
    });
    expect(eff.localization.dateFormat).toBe("dd MMM 'yy");
    // layer 1 untouched (each layer cloned).
    expect(lib.localization.dateFormat).toBe('');
    expect(eff).not.toBe(lib);
    expect(eff.localization).not.toBe(lib.localization);
  });
  test('no augment → a faithful clone', () => {
    const lib = chartDefaults();
    const eff = effectiveDefaults(lib, undefined);
    expect(eff).toEqual(lib);
    expect(eff).not.toBe(lib);
  });
});

// =============================================================================
// §5.2 + §5.3 — createChartOptions: normalizations at CREATION
// =============================================================================
describe('createChartOptions — normalizations at creation (§5.2 / §5.3)', () => {
  test('user handleScroll:false expands then merges over defaults', () => {
    const eff = createChartOptions<ChartOpts, never>(chartDefaults(), undefined, { handleScroll: false } as never, 6);
    expect(eff.handleScroll).toEqual({
      mouseWheel: false,
      pressedMouseMove: false,
      horzTouchDrag: false,
      vertTouchDrag: false,
    });
  });

  test('user handleScale partial with boolean axis expands {time,price} then merges', () => {
    const eff = createChartOptions<ChartOpts, never>(
      chartDefaults(),
      undefined,
      { handleScale: { axisDoubleClickReset: false } } as never,
      6,
    );
    expect(eff.handleScale.axisDoubleClickReset).toEqual({ time: false, price: false });
    // unmentioned flags keep their default (merge §5.1).
    expect(eff.handleScale.mouseWheel).toBe(true);
    expect(eff.handleScale.axisPressedMouseMove).toEqual({ time: true, price: true });
  });

  test('rightOffsetPixels normalized px→bars against the supplied barSpacing', () => {
    const eff = createChartOptions<ChartOpts, never>(
      chartDefaults(),
      undefined,
      { timeScale: { rightOffsetPixels: 30 } } as never,
      6,
    );
    expect(eff.timeScale.rightOffset).toBe(5); // 30 / 6
    // never stored — internal offset is bar-denominated (§5.3.4).
    expect(eff.timeScale.rightOffsetPixels).toBeUndefined();
  });

  test('behavior augmentation reaches the effective object at creation', () => {
    const eff = createChartOptions<ChartOpts, { localization: { dateFormat: string } }>(
      chartDefaults(),
      (g) => {
        g.localization.dateFormat = "dd MMM 'yy";
      },
      undefined,
      6,
    );
    expect(eff.localization.dateFormat).toBe("dd MMM 'yy");
  });

  test('user partial is never aliased into stored state (§5.1)', () => {
    const patch = { timeScale: { rightOffset: 7 } };
    const eff = createChartOptions<ChartOpts, never>(chartDefaults(), undefined, patch as never, 6);
    expect(eff.timeScale).not.toBe(patch.timeScale);
  });
});

// =============================================================================
// §5.3 — normalizations at applyOptions (the same four, re-run)
// =============================================================================
describe('applyChartOptions — normalizations on applyOptions (§5.3)', () => {
  test('handleScroll boolean expands in applyOptions too (§5.3.1)', () => {
    const stored = chartDefaults();
    const next = applyChartOptions<ChartOpts>(stored, chartDefaults(), { handleScroll: false } as never, 6);
    expect(next.handleScroll).toEqual({
      mouseWheel: false,
      pressedMouseMove: false,
      horzTouchDrag: false,
      vertTouchDrag: false,
    });
  });

  test('rightOffsetPixels re-converted against the LIVE barSpacing in applyOptions (§5.3.4)', () => {
    const stored = chartDefaults();
    // live spacing has zoomed to 10 since creation; px resolves against it now.
    const next = applyChartOptions<ChartOpts>(stored, chartDefaults(), { timeScale: { rightOffsetPixels: 100 } } as never, 10);
    expect(next.timeScale.rightOffset).toBe(10); // 100 / 10
    expect(next.timeScale.rightOffsetPixels).toBeUndefined();
  });

  test('undefined patch values leave stored unchanged (§5.1 law 1)', () => {
    const stored = chartDefaults();
    stored.timeScale.rightOffset = 4;
    const next = applyChartOptions<ChartOpts>(stored, chartDefaults(), { timeScale: { rightOffset: undefined } } as never, 6);
    expect(next.timeScale.rightOffset).toBe(4);
  });
});

// =============================================================================
// §5.1 — null leaf resets to effective default (incl. behavior augmentation)
// =============================================================================
describe('null = reset-to-default, leaf-only (§5.1 / A6)', () => {
  test('null resets a chart leaf to its effective default', () => {
    const defaults = chartDefaults();
    const stored = applyChartOptions<ChartOpts>(defaults, defaults, { timeScale: { rightOffset: 9 } } as never, 6);
    expect(stored.timeScale.rightOffset).toBe(9);
    const reset = applyChartOptions<ChartOpts>(stored, defaults, { timeScale: { rightOffset: null } } as never, 6);
    expect(reset.timeScale.rightOffset).toBe(0); // back to the default
  });

  test('null resets to the BEHAVIOR-AUGMENTED default, not the bare library default', () => {
    // effective defaults carry the behavior's dateFormat (§5.2); a leaf-null restores THAT.
    const augment = (g: { localization: { dateFormat: string } }): void => {
      g.localization.dateFormat = "dd MMM 'yy";
    };
    const defaults = effectiveDefaults<ChartOpts, { localization: { dateFormat: string } }>(chartDefaults(), augment);
    const stored = applyChartOptions<ChartOpts>(defaults, defaults, { localization: { dateFormat: 'custom' } } as never, 6);
    expect(stored.localization.dateFormat).toBe('custom');
    const reset = applyChartOptions<ChartOpts>(stored, defaults, { localization: { dateFormat: null } } as never, 6);
    expect(reset.localization.dateFormat).toBe("dd MMM 'yy");
  });

  test('null resets a series price-format leaf to default', () => {
    const defaults = seriesDefaults();
    const stored = applySeriesOptions<SeriesOpts>(defaults, defaults, { priceFormat: { precision: 6 } } as never);
    expect(stored.priceFormat.precision).toBe(6);
    const reset = applySeriesOptions<SeriesOpts>(stored, defaults, { priceFormat: { precision: null } } as never);
    expect(reset.priceFormat.precision).toBe(2);
  });
});

// =============================================================================
// §5.3.2 — minMove→precision re-run at creation AND applyOptions
// =============================================================================
describe('series minMove → precision (§5.3.2)', () => {
  test('at creation: minMove without precision derives precision', () => {
    const eff = createSeriesOptions<SeriesOpts>(seriesDefaults(), { priceFormat: { minMove: 0.001 } } as never);
    expect(eff.priceFormat.precision).toBe(3);
    expect(eff.priceFormat.minMove).toBe(0.001);
  });

  test('on applyOptions: minMove re-runs precision (fixes the reference creation-only staleness)', () => {
    const defaults = seriesDefaults();
    let opts = createSeriesOptions<SeriesOpts>(defaults, undefined);
    expect(opts.priceFormat.precision).toBe(2); // default 0.01 → 2
    opts = applySeriesOptions<SeriesOpts>(opts, defaults, { priceFormat: { minMove: 0.5 } } as never);
    expect(opts.priceFormat.precision).toBe(precisionByMinMove(0.5)); // 1
    expect(opts.priceFormat.precision).toBe(1);
  });

  test('explicit precision in the same patch wins over derivation', () => {
    const eff = createSeriesOptions<SeriesOpts>(seriesDefaults(), {
      priceFormat: { minMove: 0.001, precision: 8 },
    } as never);
    expect(eff.priceFormat.precision).toBe(8);
  });
});

// =============================================================================
// §5.3.3 — candlestick shorthand fan-out via the definition's normalizeOptions hook
// =============================================================================
describe('candlestick borderColor/wickColor shorthand (§5.3.3 / §6.10)', () => {
  test('normalizeSeriesPatch invokes the hook on the patch', () => {
    const hook = vi.fn();
    const patch = { upColor: '#fff' };
    normalizeSeriesPatch(patch, hook);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('at creation: borderColor fans out to up/down and is NOT stored (§6.10)', () => {
    const eff = createSeriesOptions<SeriesOpts>(
      seriesDefaults(),
      { borderColor: '#123456' } as never,
      candlestickNormalizeOptions,
    );
    expect(eff.borderUpColor).toBe('#123456');
    expect(eff.borderDownColor).toBe('#123456');
    // the write-only aggregate is never stored — options() never returns it.
    expect('borderColor' in eff).toBe(false);
  });

  test('at creation: wickColor fans out to up/down and is NOT stored', () => {
    const eff = createSeriesOptions<SeriesOpts>(
      seriesDefaults(),
      { wickColor: '#abcdef' } as never,
      candlestickNormalizeOptions,
    );
    expect(eff.wickUpColor).toBe('#abcdef');
    expect(eff.wickDownColor).toBe('#abcdef');
    expect('wickColor' in eff).toBe(false);
  });

  test('on applyOptions: shorthand expansion runs (the reference path was dead; we wire it)', () => {
    const defaults = seriesDefaults();
    let opts = createSeriesOptions<SeriesOpts>(defaults, undefined, candlestickNormalizeOptions);
    opts = applySeriesOptions<SeriesOpts>(opts, defaults, { borderColor: '#999999' } as never, candlestickNormalizeOptions);
    expect(opts.borderUpColor).toBe('#999999');
    expect(opts.borderDownColor).toBe('#999999');
    expect('borderColor' in opts).toBe(false);
  });

  test('an explicit borderUpColor in the same patch is not overwritten by the shorthand', () => {
    const eff = createSeriesOptions<SeriesOpts>(
      seriesDefaults(),
      { borderColor: '#111111', borderUpColor: '#222222' } as never,
      candlestickNormalizeOptions,
    );
    expect(eff.borderUpColor).toBe('#222222');
    expect(eff.borderDownColor).toBe('#111111');
  });
});

// =============================================================================
// §5.5 — interactive-state accessors are NOT in options()
// =============================================================================
describe('interactive state is not options (§5.5 / A5)', () => {
  test('options snapshot carries CONFIGURED values, never live barSpacing/rightOffset patches', () => {
    // Build the stored chart options exactly as a facade would, then snapshot it.
    const defaults = chartDefaults();
    const stored = createChartOptions<ChartOpts, never>(defaults, undefined, { timeScale: { barSpacing: 6 } } as never, 6);
    const snap = snapshot(stored);
    // The snapshot reflects what was configured (barSpacing 6), not a post-pan value.
    expect(snap.timeScale.barSpacing).toBe(6);
    // rightOffsetPixels is normalized away — it is not a stored option key (§5.3.4).
    expect('rightOffsetPixels' in snap.timeScale).toBe(true); // present as the configured `undefined`
    expect(snap.timeScale.rightOffsetPixels).toBeUndefined();
  });

  test('snapshotting twice yields distinct frozen copies (fresh per options() call, §4.3)', () => {
    const stored = chartDefaults();
    const a = snapshot(stored);
    const b = snapshot(stored);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});
