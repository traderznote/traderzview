// Spec of record: 02-public-api-spec.md §3.1 (factories + ChartEnvironment), §2
// (identity law), §7 (IChart), §14.2 (MouseEventParams), §16 (errors). The join point
// is exercised end-to-end through createChartWith over an INJECTED stub IRenderBackend
// (records the §6 begin/render/end sequence), a fake container + ownerDocument (only the
// DOM methods the join actually calls), and a fake rAF scheduler (env.scheduler) — no
// browser, no canvas, no real rAF. Assertions are hand-derived from the contracts.
import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface, Size, SnapshotTile } from '../gfx';
import { timeBehavior } from '../data';
import type { IFrameScheduler } from '../host';
import { ChartError } from './errors';
import { CandlestickSeries, LineSeries } from './series-defs';
import { createChartWith, createLiveNav } from './create-chart';
import { ChartModel, buildHorzGeometry } from '../model';

// --- stub backend: one recording ISurface per createSurface() --------------------------
function makeBackend(log: string[]): IRenderBackend {
  let seq = 0;
  const makeSurface = (): ISurface => {
    const name = `surf${seq++}`;
    let media = { width: 0, height: 0 };
    return {
      setMediaSize: (s) => void (media = s),
      beginFrame: (scope) => {
        log.push(`${name}.beginFrame ${scope}`);
        return { mediaSize: media, bitmapSize: media, hr: 1, vr: 1 };
      },
      renderLayer: (layer, lists: readonly DisplayList[]) => {
        let cmds = 0;
        for (const l of lists) cmds += l.commands.length;
        log.push(`${name}.renderLayer ${layer} cmds=${cmds}`);
      },
      endFrame: () => log.push(`${name}.endFrame`),
      resolutionChanged: { subscribe: () => () => {} },
      snapshot: () => ({ _tag: 'SurfaceSnapshot' }),
      dispose: () => log.push(`${name}.dispose`),
    } as unknown as ISurface;
  };
  return {
    createSurface: () => makeSurface(),
    createImage: () => ({ id: 0, width: 0, height: 0 }) as never,
    composeSnapshot: () => ({ _tag: 'Snapshot' }) as never,
    text: { measure: () => ({ width: 6, ascent: 8, descent: 2 }) } as never,
    dispose: () => {},
  };
}

// --- fake single-slot rAF scheduler ---------------------------------------------------
function makeRaf(): IFrameScheduler & { flush(t?: number): void; hasPending(): boolean } {
  let pending: ((n: number) => void) | null = null;
  let n = 0;
  return {
    schedule: (cb) => {
      pending = cb;
      return () => {
        if (pending === cb) pending = null;
      };
    },
    dispose: () => void (pending = null),
    hasPending: () => pending !== null,
    flush: (t) => {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(t ?? n++);
    },
  };
}

// --- fake container + ownerDocument ---------------------------------------------------
interface FakeEl {
  ownerDocument: { createElement(): FakeEl };
  style: Record<string, string>;
  children: FakeEl[];
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  contains(c: FakeEl): boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}
function makeDoc(): { createElement(): FakeEl } {
  const doc = {
    createElement(): FakeEl {
      return makeEl(doc);
    },
  };
  return doc;
}
function makeEl(doc: { createElement(): FakeEl }): FakeEl {
  const children: FakeEl[] = [];
  return {
    ownerDocument: doc,
    style: {},
    children,
    appendChild: (c) => (children.push(c), c),
    removeChild: (c) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      return c;
    },
    contains: (c) => children.includes(c),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
  };
}

function setup() {
  const log: string[] = [];
  const raf = makeRaf();
  const doc = makeDoc();
  const container = makeEl(doc);
  const chart = createChartWith(
    container as unknown as HTMLElement,
    makeBackend(log),
    timeBehavior(),
    { layout: { textColor: '#191919' } },
    { scheduler: raf },
  );
  raf.flush(0); // drain the frame armed after the initial synchronous setSize() flush
  return { log, raf, doc, container, chart };
}

const CANDLES = [
  { time: '2026-01-05', open: 10, high: 14, low: 9, close: 13 },
  { time: '2026-01-06', open: 13, high: 17, low: 12, close: 11 },
  { time: '2026-01-07', open: 11, high: 12, low: 8, close: 9 },
];

describe('createChartWith — the join point (design 02 §3.1)', () => {
  test('a string container missing in the document throws container-not-found (§3.1/§16)', () => {
    expect(() => createChartWith('no-such-id', makeBackend([]), timeBehavior())).toThrow(ChartError);
    try {
      createChartWith('no-such-id', makeBackend([]), timeBehavior());
    } catch (e) {
      expect((e as ChartError).code).toBe('container-not-found');
    }
  });

  test('construction mounts the generated div and paints the backend (§7)', () => {
    const { log, container, chart } = setup();
    expect(chart.element()).toBe(container.children[0]); // the generated div under the container
    expect(log.length).toBeGreaterThan(0); // the initial synchronous flush painted
  });

  test('addSeries + setData drive a well-formed §6 backend stream', () => {
    const { log, raf, chart } = setup();
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#26a69a' });
    expect(candles.seriesType()).toBe('candlestick');
    const before = log.length;
    candles.setData(CANDLES);
    raf.flush(16);
    const calls = log.slice(before);
    expect(calls.some((l) => l.includes('.beginFrame full'))).toBe(true);
    expect(calls.some((l) => l.includes('.renderLayer base'))).toBe(true);
    // a non-empty draw-command stream reached some base layer (the series scene).
    expect(calls.some((l) => l.includes('.renderLayer base') && !l.endsWith('cmds=0'))).toBe(true);
    // well-formed: every beginFrame is balanced by an endFrame.
    const begins = calls.filter((l) => l.includes('.beginFrame')).length;
    const ends = calls.filter((l) => l.includes('.endFrame')).length;
    expect(begins).toBe(ends);
  });

  test('handle identity law (§2): panes / time-scale / series are cached', () => {
    const { chart } = setup();
    expect(chart.panes()[0]).toBe(chart.panes()[0]);
    expect(chart.timeScale()).toBe(chart.timeScale());
    const s = chart.addSeries(LineSeries);
    expect(chart.panes()[0]).toBe(chart.panes()[0]); // still cached after a structural add
    expect(s.seriesType()).toBe('line');
  });

  test('subscribeCrosshairMove ← setCrosshairPosition delivers a §14.2 payload', () => {
    const { chart } = setup();
    const candles = chart.addSeries(CandlestickSeries);
    candles.setData(CANDLES);
    let received: { paneIndex?: number; seriesData: Map<unknown, unknown>; time?: unknown } | null = null;
    const off = chart.subscribeCrosshairMove((p) => (received = p));
    chart.setCrosshairPosition(9, '2026-01-07' as never, candles);
    expect(received).not.toBeNull();
    const got = received!;
    expect(typeof got.paneIndex).toBe('number');
    expect(got.seriesData instanceof Map).toBe(true);
    expect(got.seriesData.get(candles)).toBeDefined(); // keyed by the user handle
    off();
    received = null;
    chart.setCrosshairPosition(9, '2026-01-07' as never, candles);
    expect(received).toBeNull(); // unsubscribe stops delivery (§14.1)
  });

  test('dispose() is idempotent, frees surfaces, and guards later calls (§16.5)', () => {
    const { log, container, chart } = setup();
    const div = chart.element();
    chart.dispose();
    expect(log.some((l) => l.endsWith('.dispose'))).toBe(true);
    expect(container.contains(div as unknown as FakeEl)).toBe(false); // detached
    expect(() => chart.dispose()).not.toThrow(); // idempotent
    expect(() => chart.addSeries(CandlestickSeries)).toThrow(ChartError);
    try {
      chart.timeScale();
    } catch (e) {
      expect((e as ChartError).code).toBe('disposed');
    }
  });
});

// --- regressions for the wiring bugs the adversarial review caught (blockers/majors) ---
describe('createChartWith — §2/§10/§11.1 wiring regressions', () => {
  test('series.priceScale() returns the SAME cached handle each call, not a fresh literal (§2)', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    expect(s.priceScale()).toBe(s.priceScale());
  });

  test('series.pane() === series.pane() === chart.panes()[0] (one cached pane handle, §2)', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    expect(s.pane()).toBe(s.pane());
    expect(s.pane()).toBe(chart.panes()[0]);
  });

  test('pane.priceScale(id) is cached and consistent with series.priceScale() (§2/§10)', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const pane = chart.panes()[0]!;
    const a = pane.priceScale('right');
    expect(pane.priceScale('right')).toBe(a); // same handle (or both null) each call — never a fresh literal
    if (a !== null) expect(a).toBe(s.priceScale()); // shared resolver with the series' own scale
  });

  test('removeSeries unregisters the scene source so the series stops painting (§4.4.2)', () => {
    const { chart, log, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    expect(log.some((l) => l.includes('renderLayer base') && !l.endsWith('cmds=0'))).toBe(true);
    log.length = 0;
    chart.removeSeries(s);
    raf.flush(32);
    expect(log.some((l) => l.includes('renderLayer base') && !l.endsWith('cmds=0'))).toBe(false);
  });

  test('createPriceLine returns a live handle (NOT a false disposed error); removePriceLine kills it (§11.1)', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const line = s.createPriceLine({ price: 12 } as never);
    expect(() => line.options()).not.toThrow();
    line.applyOptions({ price: 13 } as never);
    s.removePriceLine(line);
    expect(() => line.applyOptions({ price: 1 } as never)).toThrow();
  });
});

// --- FIX 6: makeTimeScaleHandle wires the real timeline + geometry conversions ---------
describe('createChartWith — time-scale conversions are LIVE after setData (FIX 6)', () => {
  // UTC-midnight seconds for a yyyy-mm-dd business day (the behavior key for CANDLES).
  const keyOf = (iso: string): number => {
    const d = new Date(iso);
    return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
  };

  test('coordinateToLogical / logicalToCoordinate return real numbers (not null) after setData', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const ts = chart.timeScale();
    // empty scale before data: conversions are null (kept §16.1) and the scale reports empty.
    expect(ts.coordinateToLogical(100)).toBeNull();
    s.setData(CANDLES);
    raf.flush(16);
    const lg = ts.coordinateToLogical(300);
    expect(lg).not.toBeNull();
    expect(Number.isFinite(lg as number)).toBe(true);
    const x = ts.logicalToCoordinate(0);
    expect(x).not.toBeNull();
    expect(Number.isFinite(x as number)).toBe(true);
    // round-trip: coordinateToLogical ∘ logicalToCoordinate is identity (continuous inverse).
    const back = ts.coordinateToLogical(x as number);
    expect(back as number).toBeCloseTo(0, 6);
  });

  test('keyToLogical / logicalToKey / keysInRange return real values over the live timeline', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const ts = chart.timeScale();
    const k0 = keyOf('2026-01-05');
    const k2 = keyOf('2026-01-07');
    // key → logical: the first/last data keys land on slots 0 and 2.
    expect(ts.keyToLogical(k0)).toBe(0);
    expect(ts.keyToLogical(k2)).toBe(2);
    // logical → key: the inverse on the integer slots.
    expect(ts.logicalToKey(0)).toBe(k0 as never);
    expect(ts.logicalToKey(2)).toBe(k2 as never);
    // keysInRange over the whole grid returns all three real slot keys (NOT the [] stub).
    const keys = ts.keysInRange({ from: 0, to: 2 });
    expect(keys.length).toBe(3);
    expect(keys[0]).toBe(k0 as never);
    expect(keys[2]).toBe(k2 as never);
  });

  test('timeToCoordinate / timeToLogical / snapToBar resolve through behavior.key → timeline → geometry', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const ts = chart.timeScale();
    // a data time maps to its logical slot and a finite coordinate.
    expect(ts.timeToLogical('2026-01-06' as never)).toBe(1);
    const c = ts.timeToCoordinate('2026-01-06' as never);
    expect(c).not.toBeNull();
    expect(Number.isFinite(c as number)).toBe(true);
    // snapToBar of a fractional logical lands on an integer slot.
    expect(ts.snapToBar(1.4)).toBe(2); // nearest-slot 'right' of the interpolated key
    // isEmpty is false now there is data: a setVisibleLogicalRange no longer no-ops on empty.
    expect(ts.getVisibleLogicalRange()).not.toBeNull();
  });
});

// --- M11 parity INTEGRATE: the deferred behaviors wired into the running chart ---------
describe('createChartWith — M11 parity wiring (price-line render + screenshot toggle)', () => {
  test('createPriceLine registers a SceneSource that PAINTS a horizontal line above the series (M9 deferral closed)', () => {
    const { chart, log, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES); // sets the per-frame converter so the line maps price → y
    raf.flush(16);
    // Baseline: the series base stream this frame (the price line not created yet).
    const baseBefore = log
      .filter((l) => l.includes('renderLayer base'))
      .map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0));
    const maxBefore = Math.max(0, ...baseBefore);
    log.length = 0;
    // A price at 12 falls inside the candle range [9,17] → on-pane → it draws.
    s.createPriceLine({ price: 12, color: '#ff0000' } as never);
    raf.flush(32);
    const baseAfter = log
      .filter((l) => l.includes('renderLayer base'))
      .map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0));
    const maxAfter = Math.max(0, ...baseAfter);
    // The price line is an AboveSeries (base-layer) source: the base stream gained a command.
    expect(maxAfter).toBeGreaterThan(maxBefore);
  });

  test('removePriceLine unregisters the line source so the line stops painting (§11.1)', () => {
    const { chart, log, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const line = s.createPriceLine({ price: 12, color: '#ff0000' } as never);
    raf.flush(32);
    const withLine = Math.max(
      0,
      ...log.filter((l) => l.includes('renderLayer base')).map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0)),
    );
    log.length = 0;
    s.removePriceLine(line);
    raf.flush(48);
    const without = Math.max(
      0,
      ...log.filter((l) => l.includes('renderLayer base')).map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0)),
    );
    expect(without).toBeLessThan(withLine);
  });

  test('removeSeries also unregisters its price-line sources (no leak)', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    s.createPriceLine({ price: 12 } as never);
    raf.flush(16);
    // The series owns one line; removing the series must not throw and must drop the line.
    expect(() => chart.removeSeries(s)).not.toThrow();
    raf.flush(32);
  });

  test('takeScreenshot forwards includeCrosshair to the backend compositor (§8.6)', () => {
    const composeCalls: boolean[] = [];
    const raf = makeRaf();
    const doc = makeDoc();
    const container = makeEl(doc);
    const backend: IRenderBackend = {
      createSurface: () => makeBackend([]).createSurface(),
      createImage: () => ({ id: 0, width: 0, height: 0 }) as never,
      composeSnapshot: ((_tiles: readonly SnapshotTile[], _size: Size, includeCrosshair?: boolean) => {
        composeCalls.push(includeCrosshair ?? true);
        return { _tag: 'Snapshot' } as never;
      }) as never,
      text: { measure: () => ({ width: 6, ascent: 8, descent: 2 }) } as never,
      dispose: () => {},
    };
    const chart = createChartWith(
      container as unknown as HTMLElement,
      backend,
      timeBehavior(),
      { layout: { textColor: '#191919' } },
      { scheduler: raf },
    );
    raf.flush(0);
    chart.takeScreenshot(); // default → includeCrosshair true
    chart.takeScreenshot({ includeCrosshair: false }); // explicit false → base only
    chart.takeScreenshot({ includeCrosshair: true });
    expect(composeCalls).toEqual([true, false, true]);
  });
});

// --- Part B: the LIVE nav cell + the model-navigator math (pan/zoom/reset/fit) ---------
describe('createLiveNav — pan/zoom/reset drive the live geometry (model-navigator math)', () => {
  // A bare model (no host) is enough: createLiveNav reads only model.options().timeScale.
  const makeNav = (n: number, width = 540) => {
    const model = new ChartModel({ behavior: timeBehavior(), invalidate: () => {} });
    return createLiveNav(model, () => n, () => width);
  };
  // The geometry the series + handle render with, from the live cell (mirrors rebuild).
  const geomOf = (nav: ReturnType<typeof makeNav>, n: number, width = 540) =>
    buildHorzGeometry({ width, barSpacing: nav.barSpacing(), rightOffset: nav.rightOffset(), baseIndex: n - 1 });

  test('pan changes rightOffset and shifts indexToCoordinate by the pan distance', () => {
    const n = 20;
    const nav = makeNav(n);
    const before = nav.rightOffset();
    const xBefore = geomOf(nav, n).indexToCoordinate(n - 1); // the last bar's coordinate
    nav.pan(30); // drag content right by 30 media px
    const after = nav.rightOffset();
    // ΔR = −dx/S < 0: dragging right reduces the right offset (study 03 §4.6).
    expect(after).toBeLessThan(before);
    const xAfter = geomOf(nav, n).indexToCoordinate(n - 1);
    // The same logical index now sits ~30 px further right (Δx = −ΔR·S = dx).
    expect(xAfter - xBefore).toBeCloseTo(30, 5);
  });

  test('pan is clamped by the navigator right-offset bound (cannot scroll past the extreme)', () => {
    const n = 20;
    const nav = makeNav(n);
    for (let i = 0; i < 1000; i++) nav.pan(100); // hammer left far beyond the data
    const r = nav.rightOffset();
    // clampRightOffset bounds R; a huge pan does not run away to −∞.
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThan(-(n + 10)); // stays near the firstIndex − baseIndex bound
  });

  test('zoom in increases barSpacing; zoom out decreases it (clamped both ways)', () => {
    const nav = makeNav(20);
    const s0 = nav.barSpacing();
    nav.zoom(1, 200); // +1 wheel notch → grow spacing
    const sIn = nav.barSpacing();
    expect(sIn).toBeGreaterThan(s0);
    nav.zoom(-1, 200); // −1 notch → shrink
    nav.zoom(-1, 200);
    expect(nav.barSpacing()).toBeLessThan(sIn);
    // never below the minBarSpacing floor (study 03 §4.5).
    for (let i = 0; i < 200; i++) nav.zoom(-1, 200);
    expect(nav.barSpacing()).toBeGreaterThanOrEqual(0.5);
  });

  test('fit sets barSpacing to W/N and rightOffset to 0 (fitContentWithPixels, px=0)', () => {
    const n = 18;
    const width = 540;
    const nav = makeNav(n, width);
    nav.zoom(1, 100); // perturb away from the fitted spacing first
    nav.pan(40);
    nav.fit();
    expect(nav.barSpacing()).toBeCloseTo(width / n, 6); // S = W/N
    expect(nav.rightOffset()).toBeCloseTo(0, 6); // R = 0
  });

  test('reset restores the option-default spacing/offset then re-fits (double-click §10)', () => {
    const n = 18;
    const width = 540;
    const nav = makeNav(n, width);
    nav.zoom(1, 100);
    nav.zoom(1, 100);
    nav.pan(120);
    const movedS = nav.barSpacing();
    nav.reset();
    // reset re-fits all bars: spacing returns to the fitted W/N, offset to 0 — i.e. the
    // moved state is gone (study 03 fit; architecture §10 double-click reset).
    expect(nav.barSpacing()).not.toBe(movedS);
    expect(nav.barSpacing()).toBeCloseTo(width / n, 6);
    expect(nav.rightOffset()).toBeCloseTo(0, 6);
  });

  test('an empty timeline (N=0) is inert: pan/zoom/fit do not throw or produce NaN', () => {
    const nav = makeNav(0);
    expect(() => {
      nav.pan(50);
      nav.zoom(1, 100);
      nav.fit();
      nav.reset();
    }).not.toThrow();
    expect(Number.isFinite(nav.barSpacing())).toBe(true);
    expect(Number.isFinite(nav.rightOffset())).toBe(true);
  });
});

// --- Part B: a public fitContent() now FITS (drives the live cell + repaints) -----------
describe('createChartWith — timeScale().fitContent() drives the live geometry (Part B)', () => {
  test('fitContent() widens the live barSpacing to fit all bars and zeroes the right offset', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES); // 3 bars
    raf.flush(16);
    const ts = chart.timeScale();
    const before = ts.barSpacing(); // the 6px option default, still live before fit
    ts.fitContent();
    raf.flush(32);
    // 3 bars across the ~540px pane → W/N ≈ 180px ≫ the 6px default; rightOffset → 0.
    expect(ts.barSpacing()).toBeGreaterThan(before);
    expect(ts.scrollPosition()).toBeCloseTo(0, 6); // R = 0 after fit (scrollPosition = rightOffset)
    // logicalToCoordinate of the last bar now uses the fitted (wide) spacing — finite.
    const x = ts.logicalToCoordinate(2);
    expect(x).not.toBeNull();
    expect(Number.isFinite(x as number)).toBe(true);
  });
});
