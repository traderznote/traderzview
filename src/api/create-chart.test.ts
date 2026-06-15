// Spec of record: 02-public-api-spec.md §3.1 (factories + ChartEnvironment), §2
// (identity law), §7 (IChart), §14.2 (MouseEventParams), §16 (errors). The join point
// is exercised end-to-end through createChartWith over an INJECTED stub IRenderBackend
// (records the §6 begin/render/end sequence), a fake container + ownerDocument (only the
// DOM methods the join actually calls), and a fake rAF scheduler (env.scheduler) — no
// browser, no canvas, no real rAF. Assertions are hand-derived from the contracts.
import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface } from '../gfx';
import { timeBehavior } from '../data';
import type { IFrameScheduler } from '../host';
import { ChartError } from './errors';
import { CandlestickSeries, LineSeries } from './series-defs';
import { createChartWith } from './create-chart';

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
