// Spec of record: design 05 §7 (sessions/timezones — the non-time behaviors built on
// createChartWith + the three-layer defaults, the timezoneOffset hook with IANA→offset in
// extras ONLY, the session-highlighting BelowSeries + time-axis primitive over keysInRange)
// + the V1-REQ S1-S5 checklist (§7.2). Each test asserts ONE checkable requirement
// HEADLESSLY against the PUBLIC api seams — a real createChartWith over a stub backend (the
// demo-chart harness) for S2, the behaviors' OWN strategy surface called directly for
// S1/S3, and a stub ITimeScale modeling the doc-02 §9 keysInRange/keyToLogical contracts
// (S4 — the real join point's makeTimeScaleHandle stubs keysInRange→[], see missingSeams)
// for the session-highlight primitive (S4/S5). No DOM, no model, no real backend internals.
import { describe, expect, test } from 'vitest';
import type {
  HorzPoint,
  HorzScaleOptionGroups,
  IChart,
  IPrimitive,
  ITimeScale,
  PrimitiveContext,
  PrimitiveSource,
  Time,
} from '../../api';
import { LineSeries, createChartWith } from '../../api';
import type { DisplayList, IRenderBackend, ISurface, SceneSource } from '../../gfx';
import { priceAxisBehavior, yieldCurveBehavior } from './price-axis-behavior';
import { offsetFor, timezoneTimeBehavior } from './timezone-time-behavior';
import {
  createSessionHighlight,
  sessionHighlightDefaults,
  type SessionSpec,
} from './session-highlight';
import type { PrimitiveTarget } from '../shared';

// =====================================================================================
// The demo-chart headless harness (a recording stub IRenderBackend + fake DOM + fake rAF),
// reused verbatim from scripts/demo-chart.mjs / the sibling sync test so a REAL
// createChartWith join point runs with no browser + no canvas. S2 drives a NON-TIME chart
// (a priceAxisBehavior) through it.
// =====================================================================================
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
function makeRaf(): { scheduler: { schedule(cb: (n: number) => void): () => void; dispose(): void }; flush(t?: number): void } {
  let pending: ((n: number) => void) | null = null;
  let n = 0;
  return {
    scheduler: {
      schedule: (cb) => ((pending = cb), () => void (pending === cb && (pending = null))),
      dispose: () => void (pending = null),
    },
    flush: (t) => {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(t ?? n++);
    },
  };
}

// =====================================================================================
// S2 — behaviors are injectable per chart via createChartWith + the three-layer defaults.
// A NON-TIME chart (priceAxisBehavior — H is a plain price level) builds + renders through
// the SAME public join point a time chart uses; no bespoke factory, no core branch.
// =====================================================================================
describe('S2 — non-time behaviors drop straight onto createChartWith (no bespoke factory)', () => {
  test('a priceAxisBehavior chart builds, takes value-against-price data, and paints', () => {
    const log: string[] = [];
    const raf = makeRaf();
    const doc = makeDoc();
    const container = makeEl(doc);
    const chart = createChartWith<number>(
      container as unknown as HTMLElement,
      makeBackend(log),
      priceAxisBehavior({ precision: 2 }),
      { layout: { textColor: '#191919' } },
      { scheduler: raf.scheduler },
    );
    raf.flush(0);
    expect(log.length).toBeGreaterThan(0); // construction painted at least one frame

    // value-against-PRICE data: `time` is the horizontal PRICE level (a number), not a date.
    const series = chart.addSeries(LineSeries as never, undefined, undefined) as unknown as {
      setData(d: readonly { time: number; value: number }[]): void;
      seriesType(): string;
    };
    const before = log.length;
    series.setData([
      { time: 100, value: 3 },
      { time: 105, value: 7 },
      { time: 110, value: 5 },
      { time: 120, value: 9 },
    ]);
    raf.flush(16);
    const rendered = log.slice(before);
    expect(rendered.some((l) => l.includes('.beginFrame'))).toBe(true);
    expect(rendered.some((l) => l.includes('.renderLayer base') && !l.endsWith('cmds=0'))).toBe(true);
    chart.dispose();
  });

  test('augmentDefaults runs in the three-layer pipeline (a non-time chart clears the date format)', () => {
    // The behavior's augmentDefaults is layer-2 of the §4.3 defaults pipeline; a non-time
    // behavior seeds localization.dateFormat = '' (it is not a date). We assert the hook is
    // CALLED with a HorzScaleOptionGroups object and mutates it (the pipeline contract).
    const beh = yieldCurveBehavior();
    const groups = {
      timeScale: {} as never,
      localization: { dateFormat: 'yyyy-MM-dd', locale: 'en-US' } as never,
    } as unknown as HorzScaleOptionGroups<number>;
    beh.augmentDefaults(groups);
    expect(groups.localization.dateFormat).toBe('');
  });
});

// =====================================================================================
// S3 — the weight scale is an OPEN integer scale: a non-time behavior mints intra-axis
// weights the core never enumerated (a "price decade", a "tenor year"), and the tick engine
// ranks them by magnitude (maxTickWeight). We call fillWeights/maxTickWeight directly — the
// strategy surface the core invokes.
// =====================================================================================
describe('S3 — open integer weight scale (behavior mints its own bands)', () => {
  function fill(beh: { fillWeights(p: readonly HorzPoint<number>[], s: number): void }, values: number[]): number[] {
    const points: HorzPoint<number>[] = values.map((v) => ({ item: v, key: v as never, weight: 0 }));
    beh.fillWeights(points, 0);
    return points.map((p) => p.weight);
  }

  test('priceAxisBehavior bolds the bigger decade boundary (a Hundred crossing > a Unit crossing)', () => {
    const beh = priceAxisBehavior() as unknown as {
      fillWeights(p: readonly HorzPoint<number>[], s: number): void;
      maxTickWeight(w: readonly number[]): number;
    };
    // 99 → 100 crosses the hundreds boundary (a big band); 100 → 101 only a unit.
    const w = fill(beh, [99, 100, 101]);
    expect(w[1]!).toBeGreaterThan(w[2]!); // the hundred crossing outranks the unit crossing
    // maxTickWeight ranks by magnitude — the largest minted weight wins.
    expect(beh.maxTickWeight(w)).toBe(Math.max(...w));
  });

  test('yieldCurveBehavior mints calendar-tenor bands (a Year crossing > a Day crossing)', () => {
    const beh = yieldCurveBehavior() as unknown as { fillWeights(p: readonly HorzPoint<number>[], s: number): void };
    // 364 → 365 crosses the year boundary; 365 → 366 only a day.
    const w = fill(beh, [364, 365, 366]);
    expect(w[1]!).toBeGreaterThan(w[2]!);
  });

  test('yieldCurveBehavior.formatTick renders human tenors (1Y / 6M / 30D)', () => {
    const beh = yieldCurveBehavior();
    const loc = { priceFormatter: undefined } as never;
    const fmt = {} as never;
    expect(beh.formatTick(365, 40, loc, fmt)).toBe('1Y');
    expect(beh.formatTick(180, 30, loc, fmt)).toBe('6M');
    expect(beh.formatTick(30, 20, loc, fmt)).toBe('1M');
    expect(beh.formatTick(5, 10, loc, fmt)).toBe('5D');
  });
});

// =====================================================================================
// S1 — the timezoneOffset hook + offset-aware fillWeights/formatTick. The IANA→offset
// resolution lives in extras ONLY (offsetFor); the behavior consults it so day boundaries
// bucket on LOCAL midnight and labels render shifted wall-clock fields. UTC storage is
// never re-keyed.
// =====================================================================================
describe('S1 — timezoneTimeBehavior: offset hook drives bucketing + labels (extras-only IANA)', () => {
  // 2026-06-15 is during US EDT (UTC−4). A UTC timestamp at 03:30 UTC is 23:30 the PREVIOUS
  // local day in New York; at 04:30 UTC it is 00:30 the local day — a LOCAL day boundary the
  // UTC clock does not show (both are the same UTC date).
  const NY = 'America/New_York';

  test('offsetFor resolves a real IANA offset (New York EDT = −4h) in extras', () => {
    const off = offsetFor(NY);
    const utc = Math.floor(Date.UTC(2026, 5, 15, 12, 0, 0) / 1000); // 2026-06-15 12:00 UTC
    expect(off(utc)).toBe(-4 * 3600); // EDT
    // a winter instant is EST (−5h) — the DST segment cache returns the right offset.
    const winter = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
    expect(off(winter)).toBe(-5 * 3600);
  });

  test('the timezoneOffset hook is installed and returns seconds at the item instant', () => {
    const beh = timezoneTimeBehavior(NY);
    expect(typeof beh.timezoneOffset).toBe('function');
    const item = { timestamp: Math.floor(Date.UTC(2026, 5, 15, 12, 0, 0) / 1000) } as never;
    expect(beh.timezoneOffset!(item)).toBe(-4 * 3600);
  });

  test('fillWeights buckets on the SHIFTED instant — a LOCAL day boundary bolds where UTC does not', () => {
    const beh = timezoneTimeBehavior(NY);
    // two consecutive UTC instants on the SAME UTC date (2026-06-15) that straddle LOCAL
    // midnight: 03:30 UTC = 23:30 (Jun 14 local), 04:30 UTC = 00:30 (Jun 15 local).
    const t1 = Math.floor(Date.UTC(2026, 5, 15, 3, 30, 0) / 1000);
    const t2 = Math.floor(Date.UTC(2026, 5, 15, 4, 30, 0) / 1000);
    const points: HorzPoint<{ timestamp: number }>[] = [
      { item: { timestamp: t1 }, key: t1 as never, weight: 0 },
      { item: { timestamp: t2 }, key: t2 as never, weight: 0 },
    ];
    (beh as unknown as { fillWeights(p: readonly HorzPoint<{ timestamp: number }>[], s: number): void }).fillWeights(
      points,
      0,
    );
    // the second point crosses a LOCAL DAY boundary → a day-or-coarser weight (>= 50),
    // even though both share the same UTC calendar date.
    expect(points[1]!.weight).toBeGreaterThanOrEqual(50);
  });

  test('formatTick renders the LOCAL wall-clock time (not the UTC time)', () => {
    const beh = timezoneTimeBehavior(NY);
    // 16:00 UTC on 2026-06-15 EDT (−4h) = 12:00 local.
    const t = Math.floor(Date.UTC(2026, 5, 15, 16, 0, 0) / 1000);
    const item = { timestamp: t } as never;
    const loc = { tickMarkFormatter: undefined, locale: 'en-US' } as never;
    const fmt = { timeVisible: true, secondsVisible: false, tickMarkFormatter: undefined } as never;
    // an intraday (hour-band) weight → an HH:mm label in LOCAL time = 12:00.
    expect(beh.formatTick(item, 30, loc, fmt)).toBe('12:00');
  });

  test('an unresolvable IANA zone falls back to UTC (offset 0) without throwing', () => {
    const off = offsetFor('Not/AZone');
    expect(off(Math.floor(Date.now() / 1000))).toBe(0);
  });
});

// =====================================================================================
// S4 / S5 — the session-highlighting primitive. It walks keysInRange over the visible
// logical range (S4 — whitespace-inclusive real-slot keys), classifies each key in/out of
// session via a SessionSpec + the extras offset fn, and emits a BelowSeries pane band of
// per-session rects + a time-axis break-tick source (S5). Driven over a stub ITimeScale
// modeling the doc-02 §9 keysInRange/keyToLogical/logicalToCoordinate contracts EXACTLY
// (the real join point stubs keysInRange→[] — see missingSeams), plus a stub pane that
// records attachPrimitive (the §12.4 attach surface) and reports a size.
// =====================================================================================

// A stub pane the §12.4 adapter attaches onto, with a size() the source reads.
function makeStubPane(): PrimitiveTarget & { size(): { width: number; height: number }; attached: IPrimitive[] } {
  const attached: IPrimitive[] = [];
  return {
    attached,
    attachPrimitive: (p) => void attached.push(p),
    detachPrimitive: (p) => {
      const i = attached.indexOf(p);
      if (i >= 0) attached.splice(i, 1);
    },
    size: () => ({ width: 600, height: 400 }),
  };
}

// A stub ITimeScale modeling the S4 contract: keysInRange returns the REAL slot keys whose
// index is in [ceil(from), floor(to)] (whitespace included — they are real keys here);
// keyToLogical/logicalToCoordinate place a key linearly. `keys` is the full timeline (one
// key per hour here, so a closed overnight period is a real-but-out-of-session run).
function makeStubTimeScale(keys: number[], range: { from: number; to: number } | null): ITimeScale {
  return {
    getVisibleLogicalRange: () => (range === null ? null : { from: range.from as never, to: range.to as never }),
    keysInRange: (r: { from: number; to: number }) => {
      const from = Math.max(0, Math.ceil(r.from));
      const to = Math.min(keys.length - 1, Math.floor(r.to));
      const out: number[] = [];
      for (let i = from; i <= to; i++) out.push(keys[i]!);
      return out as never;
    },
    keyToLogical: (key: number) => {
      const i = keys.indexOf(key);
      return (i < 0 ? null : i) as never;
    },
    logicalToCoordinate: (logical: number) => (logical * 10) as never, // 10px per slot
  } as unknown as ITimeScale;
}

// A minimal PrimitiveContext the adapter's onChange → ctx.requestUpdate uses; the source
// reads ctx.pane.size() (we point it at the stub pane). The frame is a tiny ViewFrame.
function attachAndContext(
  paneSource: SceneSource,
  pane: { size(): { width: number; height: number } },
): { ctx: PrimitiveContext; frame: { frame: { mediaSize: { width: number; height: number }; bitmapSize: { width: number; height: number }; hr: number; vr: number }; now: number } } {
  let updates = 0;
  const ctx = {
    pane: pane as never,
    requestUpdate: () => void updates++,
  } as unknown as PrimitiveContext;
  void paneSource;
  const frame = {
    frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 },
    now: 0,
  };
  return { ctx, frame };
}

describe('S4/S5 — session-highlight: BelowSeries rects per span over keysInRange + time-axis breaks', () => {
  // A 24-hour timeline (one key per hour), UTC. Session: weekdays 00:00–08:00 in UTC
  // (tz 'UTC', so local == UTC) — keys at hours [0..7] are in session, [8..23] are out.
  // 2026-06-15 is a Monday (weekday 1).
  const DAY0 = Math.floor(Date.UTC(2026, 5, 15, 0, 0, 0) / 1000);
  const HOUR = 3600;
  const KEYS = Array.from({ length: 24 }, (_, h) => DAY0 + h * HOUR);
  const SPEC: SessionSpec = { days: [1], openMinutes: 0, closeMinutes: 8 * 60, tz: 'UTC' };

  function setup(range: { from: number; to: number } | null) {
    const pane = makeStubPane();
    const chart = { timeScale: () => makeStubTimeScale(KEYS, range) } as { timeScale(): ITimeScale };
    const handle = createSessionHighlight(chart, pane, SPEC);
    // the §12.4 adapter attached the primitive on construction.
    expect(pane.attached.length).toBe(1);
    const primitive = pane.attached[0]!;
    const sources = (primitive.sources?.() ?? []) as readonly PrimitiveSource[];
    return { pane, handle, primitive, sources };
  }

  test('the primitive registers TWO sources: a BelowSeries pane band + a time-axis source (S5)', () => {
    const { sources } = setup({ from: 0, to: 23 });
    const targets = sources.map((s) => (s as unknown as { target: string }).target);
    expect(targets).toContain('pane');
    expect(targets).toContain('time-axis');
    // the pane band is BelowSeries (under all series by band, §2.7/§7.1).
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    expect(paneSrc.zBand).toBe(2); // ZBand.BelowSeries
  });

  test('keysInRange (whitespace-inclusive) → ONE rect for the contiguous in-session run (S4)', () => {
    const { sources, primitive } = setup({ from: 0, to: 23 });
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    const { frame } = attachAndContext(paneSrc, { size: () => ({ width: 600, height: 400 }) });
    // wire ctx so paneHeight reads the stub pane size (attached() captures it).
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) } } as never as PrimitiveContext);
    paneSrc.update(frame as never);
    const lists = paneSrc.displayLists();
    // exactly one rects command spanning the [00:00, 07:00] in-session run.
    const rectCmds = countRects(lists);
    expect(rectCmds).toBe(1);
  });

  test('the in-session band covers the FULL span: half a bar wider than center→center (S4)', () => {
    // The in-session run is hours [0..7] — 8 contiguous slots. xOf gives slot CENTERS at
    // logical 0..7 → x = 0..70 (10px/slot in the stub). A center→center rect would be x=0,
    // w=70 (short by one bar). The fix widens by half a bar (5px) at EACH end: the rect must
    // start at -5 (left edge of slot 0) and be 80px wide (8 full bars, to the right edge of slot 7).
    const { sources, primitive } = setup({ from: 0, to: 23 });
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) } } as never as PrimitiveContext);
    paneSrc.update(
      { frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 }, now: 0 } as never,
    );
    const quad = firstRectQuad(paneSrc.displayLists());
    expect(quad).not.toBeNull();
    const [x, , w] = quad!;
    expect(x).toBeCloseTo(-5); // start-of-first-slot = center(0) − halfBar(5)
    expect(w).toBeCloseTo(80); // end-of-last-slot − start-of-first-slot = (70+5) − (0−5)
    // i.e. exactly 8 bars × 10px — NOT the short 70px center-to-center span.
  });

  test('an out-of-session-only visible range yields NO rects (no false highlight)', () => {
    // restrict the visible range to hours [10..20] — all OUT of the 00:00–08:00 session.
    const { sources, primitive } = setup({ from: 10, to: 20 });
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) } } as never as PrimitiveContext);
    paneSrc.update(
      { frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 }, now: 0 } as never,
    );
    expect(countRects(paneSrc.displayLists())).toBe(0);
  });

  test('a null visible range (empty scale) yields no rects', () => {
    const { sources, primitive } = setup(null);
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) } } as never as PrimitiveContext);
    paneSrc.update(
      { frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 }, now: 0 } as never,
    );
    expect(countRects(paneSrc.displayLists())).toBe(0);
  });

  test('the time-axis break source emits a tick at the session OPEN (S5), and showBreaks:false silences it', () => {
    const { sources, primitive, handle } = setup({ from: 0, to: 23 });
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    const axisSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'time-axis') as unknown as {
      source: SceneSource;
    }).source;
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) }, requestUpdate: () => {} } as never as PrimitiveContext);
    const frame = { frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 }, now: 0 } as never;
    paneSrc.update(frame); // the pane source owns the recompute; build() fills both caches
    expect(countRects(axisSrc.displayLists())).toBe(1); // one break tick at the open

    // showBreaks:false → no axis ticks (the pane band stays).
    handle.applyOptions({ showBreaks: false });
    paneSrc.update(frame);
    expect(countRects(axisSrc.displayLists())).toBe(0);
    expect(countRects(paneSrc.displayLists())).toBe(1);
  });

  test('detach is idempotent and removes the primitive from the pane', () => {
    const { pane, handle } = setup({ from: 0, to: 23 });
    handle.detach();
    expect(pane.attached.length).toBe(0);
    handle.detach(); // idempotent — no throw
    expect(pane.attached.length).toBe(0);
  });

  test('defaults are the §7.1 kept values', () => {
    expect(sessionHighlightDefaults.visible).toBe(true);
    expect(sessionHighlightDefaults.showBreaks).toBe(true);
  });
});

// Count rects commands across all display lists (the session band / break ticks are rects).
function countRects(lists: readonly DisplayList[]): number {
  let n = 0;
  for (const l of lists) {
    for (const c of l.commands as readonly { kind: string }[]) {
      if (c.kind === 'rects') n++;
    }
  }
  return n;
}

// The first rect quad's [x, y, w, h] across all display lists (RectsCommand.coords is a
// Float32Array of x,y,w,h quads) — lets a test assert the session band's exact geometry.
function firstRectQuad(lists: readonly DisplayList[]): [number, number, number, number] | null {
  for (const l of lists) {
    for (const c of l.commands as readonly { kind: string; coords?: Float32Array }[]) {
      if (c.kind === 'rects' && c.coords !== undefined && c.coords.length >= 4) {
        return [c.coords[0]!, c.coords[1]!, c.coords[2]!, c.coords[3]!];
      }
    }
  }
  return null;
}

// A type-level touch so the IChart/Time/SceneSource imports are exercised by name.
const _types: [IChart<Time> | null, SceneSource | null] = [null, null];
void _types;
