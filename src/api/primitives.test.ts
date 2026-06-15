// Spec of record: design 02 §12 (the public IPrimitive seam + PrimitiveContext) +
// design 05 §2.2 (the host lifecycle acceptance — attach schedules ONE Render frame;
// auto-detach fires detached() EXACTLY ONCE + unregisters the sources) + architecture
// §9.1 slot 4 (the views PrimitiveBinding seam). These tests drive the REAL
// createChartWith over the INJECTED stub backend (mirroring create-chart.test.ts): a
// recording ISurface, a fake container + ownerDocument, and a single-slot rAF. A tiny
// inline IPrimitive (a `target:'pane'` AboveSeries source + an attached/detached
// counter) is attached to a series / pane; assertions are hand-derived from §2.2.
import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface, SceneSource, ViewFrame } from '../gfx';
import { DisplayListBuilder, ZBand } from '../gfx';
import { timeBehavior } from '../data';
import type { IFrameScheduler } from '../host';
import { CandlestickSeries } from './series-defs';
import type { IPrimitive, PrimitiveContext, PrimitiveSource } from './primitives';
import { createChartWith } from './create-chart';

// --- the same stub harness create-chart.test.ts uses -----------------------------------
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
  const doc = { createElement: (): FakeEl => makeEl(doc) };
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

// --- a tiny inline test primitive ------------------------------------------------------
// A `target:'pane'` AboveSeries source emitting ONE rect command (so its presence is
// observable in the backend base-layer stream), plus attached/detached counters + the
// captured PrimitiveContext (to exercise requestUpdate/images/chart/pane). detached() is
// the host-driven auto-detach hook design 05 §2.2 fires EXACTLY once.
interface TestPrimitive extends IPrimitive {
  attachedCount: number;
  detachedCount: number;
  ctx: PrimitiveContext | null;
}
function makeTestPrimitive(): TestPrimitive {
  const builder = new DisplayListBuilder();
  builder.reset();
  builder.beginList('bitmap');
  builder.rects({}).quad(0, 0, 10, 10, '#abcdef'); // one rect command
  const lists = builder.finish();
  const source: SceneSource = {
    zBand: ZBand.AboveSeries, // a BASE-layer band → composites into renderLayer 'base'
    update: (_f: ViewFrame) => {},
    displayLists: () => lists,
  };
  const p: TestPrimitive = {
    attachedCount: 0,
    detachedCount: 0,
    ctx: null,
    attached(c): void {
      this.attachedCount++;
      this.ctx = c as unknown as PrimitiveContext;
    },
    detached(): void {
      this.detachedCount++;
      this.ctx = null;
    },
    sources(): readonly PrimitiveSource[] {
      return [{ target: 'pane', source } as unknown as PrimitiveSource];
    },
  };
  return p;
}

// the max base-layer command count seen across the recorded stream (the primitive's rect
// pushes this up while its source is registered).
function maxBaseCmds(log: string[]): number {
  const counts = log
    .filter((l) => l.includes('renderLayer base'))
    .map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0));
  return Math.max(0, ...counts);
}

describe('host primitive binding — series-attached lifecycle (design 05 §2.2 / design 02 §12)', () => {
  test('attach calls attached(ctx) ONCE, registers the source, schedules a Render frame, and paints', () => {
    const { chart, log, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const baseBefore = maxBaseCmds(log);
    log.length = 0;

    const p = makeTestPrimitive();
    s.attachPrimitive(p);
    expect(p.attachedCount).toBe(1); // §12: attached(ctx) fired exactly once
    expect(p.ctx).not.toBeNull();
    expect(raf.hasPending()).toBe(true); // §2.2 item 1: attach schedules ONE Render frame
    raf.flush(32);
    // the registered AboveSeries source's rect reached the base layer (it now paints).
    expect(maxBaseCmds(log)).toBeGreaterThan(baseBefore);
  });

  test('the PrimitiveContext carries chart/pane + requestUpdate maps onto the frame loop', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const p = makeTestPrimitive();
    s.attachPrimitive(p);
    raf.flush(32);
    const ctx = p.ctx!;
    expect(ctx.chart).toBe(chart); // ctx.chart is the live chart handle
    expect(typeof ctx.pane.index).toBe('function'); // a real pane handle
    // requestUpdate schedules a frame on the shared loop.
    expect(raf.hasPending()).toBe(false);
    ctx.requestUpdate('render');
    expect(raf.hasPending()).toBe(true);
    raf.flush(48);
  });

  test('removeSeries auto-detaches the primitive EXACTLY ONCE and unregisters its source', () => {
    const { chart, log, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    const p = makeTestPrimitive();
    s.attachPrimitive(p);
    raf.flush(16);
    const withPrim = maxBaseCmds(log);
    log.length = 0;

    chart.removeSeries(s);
    expect(p.detachedCount).toBe(1); // §2.2 item 2: detached() fired exactly once
    raf.flush(32);
    // the source is unregistered — its rect no longer reaches the base layer.
    expect(maxBaseCmds(log)).toBeLessThan(withPrim);
  });

  test('detach is idempotent — a double removeSeries does NOT double-call detached()', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const p = makeTestPrimitive();
    s.attachPrimitive(p);
    raf.flush(16);
    chart.removeSeries(s);
    chart.removeSeries(s); // the series is already gone — a no-op, no second detached()
    expect(p.detachedCount).toBe(1);
  });

  test('the explicit detachPrimitive() path also fires detached() exactly once', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const p = makeTestPrimitive();
    s.attachPrimitive(p);
    raf.flush(16);
    s.detachPrimitive(p);
    expect(p.detachedCount).toBe(1);
    s.detachPrimitive(p); // already detached — idempotent
    expect(p.detachedCount).toBe(1);
  });
});

describe('host primitive binding — pane-attached lifecycle (the no-op attachPrimitive fix)', () => {
  test('a pane-attached primitive attaches once, registers its source, and paints', () => {
    const { chart, log, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const baseBefore = maxBaseCmds(log);
    log.length = 0;

    const pane = chart.panes()[0]!;
    const p = makeTestPrimitive();
    pane.attachPrimitive(p); // was a no-op before the M12 fix
    expect(p.attachedCount).toBe(1);
    expect(raf.hasPending()).toBe(true); // §2.2 item 1
    raf.flush(32);
    expect(maxBaseCmds(log)).toBeGreaterThan(baseBefore);

    pane.detachPrimitive(p);
    expect(p.detachedCount).toBe(1); // explicit detach fires detached() once
  });

  test('removePane auto-detaches the removed pane\'s primitive EXACTLY ONCE (§2.2 item 2)', () => {
    const { chart, raf } = setup();
    // add a second pane (the first cannot be removed — removing the last pane is a no-op).
    const pane1 = chart.addPane() as unknown as { index(): number; attachPrimitive(p: IPrimitive): void };
    expect(chart.panes().length).toBe(2);
    const p = makeTestPrimitive();
    pane1.attachPrimitive(p);
    raf.flush(16);
    expect(p.attachedCount).toBe(1);

    chart.removePane(pane1.index());
    expect(p.detachedCount).toBe(1); // detached once when its pane was removed
  });
});

describe('host primitive binding — dispose detaches every primitive (design 05 §2.2)', () => {
  test('chart.dispose() calls detached() once for EVERY attached primitive (series + pane)', () => {
    const { chart, raf } = setup();
    const s1 = chart.addSeries(CandlestickSeries);
    const s2 = chart.addSeries(CandlestickSeries);
    const pane = chart.panes()[0]!;
    const a = makeTestPrimitive();
    const b = makeTestPrimitive();
    const c = makeTestPrimitive();
    s1.attachPrimitive(a);
    s2.attachPrimitive(b);
    pane.attachPrimitive(c);
    raf.flush(16);

    chart.dispose();
    expect(a.detachedCount).toBe(1);
    expect(b.detachedCount).toBe(1);
    expect(c.detachedCount).toBe(1);
  });

  test('dispose after an explicit detach does NOT double-call detached() (idempotent)', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const p = makeTestPrimitive();
    s.attachPrimitive(p);
    raf.flush(16);
    s.detachPrimitive(p);
    expect(p.detachedCount).toBe(1);
    chart.dispose(); // p is already detached — no second call
    expect(p.detachedCount).toBe(1);
  });
});
