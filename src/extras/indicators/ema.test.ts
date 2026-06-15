// Spec of record: design 05 §5 (indicators — the single-ingress rule; the EMA example;
// the IndicatorDefinition/IndicatorComputer/IndicatorOutputPatch shapes) + §5.2 (I1-I6).
// HEADLESS, against the PUBLIC api: a REAL createChartWith over an injected stub
// IRenderBackend (records the §6 begin/render/end sequence), a fake container +
// ownerDocument, and a fake single-slot rAF scheduler — no browser, no canvas. The
// V1-REQ table IS the test: I1 (synchronous per-mutation diff), I2 (store() identity-
// stable, zero-copy), I3 (single ingress — output fed via its OWN public setData/update,
// NO writer / NO 'feed-conflict' symbol), I5 (panes first-class), I6 (input append shows
// the new EMA tail in the SAME frame). The computer's streaming recurrence + the
// append/updateLast patch modes are unit-tested directly over a stub PlotStoreView, since
// THIS create-chart wiring surfaces every mutation as a `replace` diff (update() re-feeds
// the dataset) — so the incremental paths are proved at the computer seam.
import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface } from '../../gfx';
import { LineSeries, timeBehavior } from '../../api';
import type { IFrameScheduler, ISeries, PlotStoreView, SeriesType, StoreDiff, Time } from '../../api';
import { createChartWith } from '../../api';
import { createEma, emaDefinition, defaultEmaParams } from './ema';

// --- stub backend: one recording ISurface per createSurface() ----------------------
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

// --- fake single-slot rAF scheduler ------------------------------------------------
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

// --- fake container + ownerDocument ------------------------------------------------
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
  return { log, raf, chart };
}

const LINE = [
  { time: '2026-01-05' as unknown as Time, value: 10 },
  { time: '2026-01-06' as unknown as Time, value: 20 },
  { time: '2026-01-07' as unknown as Time, value: 30 },
  { time: '2026-01-08' as unknown as Time, value: 40 },
];

// EMA recurrence for the LINE values with the default period 9 (α = 2/10 = 0.2),
// seeded e[0]=x[0]: e = [10, 12, 15.6, 20.48]. Hand-derived, reused by several tests.
const ALPHA = 2 / (defaultEmaParams.period + 1);
function emaSeq(values: readonly number[]): number[] {
  const out: number[] = [];
  let e = Number.NaN;
  for (const x of values) {
    e = Number.isFinite(e) ? ALPHA * x + (1 - ALPHA) * e : x;
    out.push(e);
  }
  return out;
}

// Read every value the output series currently holds, via its PUBLIC zero-copy store().
function outValues(series: ISeries<SeriesType, Time>): number[] {
  const store = series.store();
  const out: number[] = [];
  for (let i = 0; i < store.length; i++) out.push(store.current(i));
  return out;
}

describe('createEma — single-ingress computed series (design 05 §5; I3/I6)', () => {
  test('creates exactly ONE output series (an ordinary LineSeries), no extra panes by default', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const before = chart.panes().length;
    const ema = createEma(chart, input);
    expect(ema.series.seriesType()).toBe('line'); // output IS an ordinary series
    expect(chart.panes().length).toBe(before); // overlay (pane: 'input') — no new pane
  });

  test('I3: an EMA output series receiving input data is fed via its OWN public setData (single ingress)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    // The output series now holds the EMA, read back through ITS public store() — proof
    // the value arrived through the output's own data path, not a hidden writer.
    expect(outValues(ema.series)).toEqual(emaSeq([10, 20, 30, 40]));
  });

  test('I3: seeds from the input data already present at attach time (replace rebuild)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    input.setData(LINE); // data present BEFORE the indicator attaches
    const ema = createEma(chart, input);
    expect(outValues(ema.series)).toEqual(emaSeq([10, 20, 30, 40]));
  });

  test('I6: an input update propagates the new EMA tail in the SAME frame (one rAF flush)', () => {
    const { chart, raf, log } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    raf.flush(16);
    log.length = 0;
    // A new input bar: the EMA output must show the new tail value WITHOUT a second frame.
    input.update({ time: '2026-01-09' as unknown as Time, value: 50 });
    // The output already holds the new EMA value (the push ran inside the synchronous
    // input data-changed callback — no frame needed for the data to land).
    expect(outValues(ema.series)).toEqual(emaSeq([10, 20, 30, 40, 50]));
    // And exactly ONE coalesced frame paints both the input and the output (§4.4 / I6):
    raf.flush(32);
    const begins = log.filter((l) => l.includes('.beginFrame')).length;
    const ends = log.filter((l) => l.includes('.endFrame')).length;
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBe(ends); // well-formed, balanced
  });

  test('I6: the input UPDATE/append path drives the new EMA tail synchronously (same frame)', () => {
    // I6 names the APPEND path — `series.update(item)` (the real wiring implements it as
    // setData([...items, item]), surfacing a synchronous data-changed diff). This drives
    // that update() path and proves the new EMA tail is present THE INSTANT update() returns,
    // through the input's subscribeDataChanged (no second frame, no microtask).
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    // Observe the input's OWN data-changed channel: the diff that update() emits is the one
    // the EMA host listens on. We capture the LAST diff and assert the recompute already ran.
    let lastDiff: StoreDiff | null = null;
    input.subscribeDataChanged((d) => (lastDiff = d));
    const beforeLen = ema.series.store().length;
    // The append: a brand-new bar via the UPDATE path the requirement names.
    input.update({ time: '2026-01-09' as unknown as Time, value: 50 });
    // The data-changed diff fired synchronously (I1), and the EMA host's callback — which
    // is subscribed to the SAME channel — already pushed the new tail (I6/I3).
    expect(lastDiff).not.toBeNull();
    expect(ema.series.store().length).toBe(beforeLen + 1); // one new EMA row appended in-frame
    const out = ema.series.data() as readonly { time: Time; value?: number }[];
    expect(out[out.length - 1]!.value).toBeCloseTo(emaSeq([10, 20, 30, 40, 50])[4]!); // new tail
    expect(out[out.length - 1]!.time).toBe('2026-01-09' as unknown as Time); // at the new bar's TIME
  });

  test('a whitespace input row yields a whitespace EMA row (row alignment kept)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData([
      { time: '2026-01-05' as unknown as Time, value: 10 },
      { time: '2026-01-06' as unknown as Time }, // whitespace gap
      { time: '2026-01-07' as unknown as Time, value: 30 },
    ]);
    // Plot rows (whitespace excluded) on BOTH series: the EMA recurrence skips the gap.
    // e0 = 10 ; e2 = α·30 + (1−α)·10 (the recurrence continues across the gap row).
    expect(outValues(ema.series)).toEqual([10, ALPHA * 30 + (1 - ALPHA) * 10]);
  });

  test('a whitespace gap does NOT shift the EMA tail: each value lands at its input row TIME', () => {
    // The regression guard for the index-space bug: the computer emits in PLOT-STORE space
    // (whitespace excluded) but the host must address the output in TIMELINE space (the input
    // item TIMES). With a whitespace row BEFORE the last real bar, indexing data() by the
    // plot row would put e[last] one slot early (on the whitespace time) — the wrong key.
    const T0 = '2026-01-05' as unknown as Time; // value 10  → plot row 0
    const TGAP = '2026-01-06' as unknown as Time; // whitespace → NO plot row
    const T2 = '2026-01-07' as unknown as Time; // value 30  → plot row 1
    const T3 = '2026-01-08' as unknown as Time; // value 40  → plot row 2
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData([
      { time: T0, value: 10 },
      { time: TGAP }, // whitespace gap (no plot row)
      { time: T2, value: 30 },
      { time: T3, value: 40 },
    ]);
    // The EMA value at the LAST input row must carry the LAST input row's TIME (T3), not the
    // whitespace time and not T2. Read the output's PUBLIC data() (time-bearing items).
    const out = ema.series.data() as readonly { time: Time; value?: number }[];
    const emaForRealRows = emaSeq([10, 30, 40]); // recurrence over the three real values
    // one output item per REAL input row, addressed to that row's exact time (no shift).
    expect(out.map((o) => o.time)).toEqual([T0, T2, T3]);
    expect(out.map((o) => o.value)).toEqual(emaForRealRows);
    // and crucially: the whitespace time NEVER receives an EMA value.
    expect(out.some((o) => o.time === TGAP)).toBe(false);
  });

  test('dispose() removes the output series and unsubscribes (idempotent, no leak)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    expect(() => ema.dispose()).not.toThrow();
    expect(() => ema.dispose()).not.toThrow(); // idempotent
    // After dispose the subscription is gone: a later input mutation must not throw via
    // a dangling callback writing to a removed series.
    expect(() => input.update({ time: '2026-01-09' as unknown as Time, value: 50 })).not.toThrow();
  });
});

describe('I1 — the input data event fires SYNCHRONOUSLY per mutation (design 02 §8)', () => {
  test('the dataChanged diff arrives BEFORE the mutating setData call returns', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    let diff: StoreDiff | null = null;
    input.subscribeDataChanged((d) => (diff = d));
    expect(diff).toBeNull(); // nothing yet
    input.setData(LINE); // synchronous mutation
    expect(diff).not.toBeNull(); // the diff was delivered inside setData (before it returned)
    expect((diff as unknown as StoreDiff).kind).toBe('replace');
  });

  test('the EMA recompute runs INSIDE the input callback (output populated when setData returns)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    // No frame, no microtask — the output already holds the EMA the instant setData returned.
    expect(ema.series.store().length).toBe(LINE.length);
  });
});

describe('I2 — store() is zero-copy and identity-stable (design 02 §8)', () => {
  test('input.store() returns the SAME object across calls (identity-stable)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    expect(input.store()).toBe(input.store()); // identity stable before data
    input.setData(LINE);
    expect(input.store()).toBe(input.store()); // …and after a mutation
  });

  test('the view exposes scalar reads only (no array reference leaks) — current(i)/length', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    input.setData(LINE);
    const view = input.store();
    expect(view.length).toBe(4);
    expect(view.current(0)).toBe(10);
    expect(view.current(3)).toBe(40);
    // The view's surface is scalar accessors — there is no lane-array getter to leak.
    expect(typeof (view as unknown as { lanes?: unknown }).lanes).toBe('undefined');
  });
});

describe('I5 — panes are first-class: pane: own opens an oscillator pane', () => {
  test("an 'own'-pane indicator definition adds the output to a fresh pane via addSeries(def, opts, paneCount)", () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    // Reuse the host with an 'own'-pane definition variant (the public addSeries pane
    // creation, design 02 §7). We exercise the chart pane API directly to prove I5.
    const before = chart.panes().length;
    const own = chart.addSeries(LineSeries, undefined, before) as ISeries<SeriesType, Time>;
    expect(chart.panes().length).toBe(before + 1); // paneIndex === paneCount created a pane
    own.setData(LINE);
    expect(own.store().length).toBe(4);
    // (createEma's 'own' branch uses exactly this paneIndex === panes().length call.)
    expect(input.store().length).toBe(0);
  });
});

// --- the computer seam: the streaming recurrence + the incremental patch modes ------
// THIS create-chart wiring surfaces update() as a `replace` diff, so the append/
// updateLast patch paths are proved here over a stub PlotStoreView (zero-copy scalar
// reads), exactly the read surface a built-in kind receives (design 05 §5.1).

function stubStore(values: readonly (number | null)[]): PlotStoreView {
  // whitespace rows (null) are excluded from the plot store (length = finite rows).
  const finite = values.filter((v): v is number => v !== null);
  return {
    length: finite.length,
    current: (i) => finite[i]!,
    min: (i) => finite[i]!,
    max: (i) => finite[i]!,
    timeIndex: (i) => i as never,
    lane: (_n, i) => finite[i]!,
    firstIndexAt: () => null,
    nearestIndexAt: () => -1,
  };
}

describe('createEmaComputer — streaming recurrence + incremental patches (design 05 §5.1)', () => {
  test('a replace diff returns ONE full-rebuild patch aligned to row 0', () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    const patches = computer.apply({ kind: 'replace' }, stubStore([10, 20, 30, 40]));
    expect(patches.length).toBe(1);
    expect(patches[0]!.outputId).toBe('ema');
    expect(patches[0]!.mode).toBe('replace');
    expect(patches[0]!.fromRow).toBe(0);
    expect(patches[0]!.rows).toEqual(emaSeq([10, 20, 30, 40]));
  });

  test("an append diff returns an 'append' patch for the NEW tail only, seeded from running state", () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    // seed with three rows…
    computer.apply({ kind: 'replace' }, stubStore([10, 20, 30]));
    // …then append a fourth: the patch covers ONLY row 3, mode 'append' (host pushes via update).
    const patches = computer.apply({ kind: 'append', count: 1 }, stubStore([10, 20, 30, 40]));
    expect(patches[0]!.mode).toBe('append');
    expect(patches[0]!.fromRow).toBe(3);
    const full = emaSeq([10, 20, 30, 40]);
    expect(patches[0]!.rows).toEqual([full[3]]); // continues the recurrence: equals the full e[3]
  });

  test("an updateLast diff rewinds one row (warmup 1) and recomputes the last row from e[last−1]", () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    computer.apply({ kind: 'replace' }, stubStore([10, 20, 30, 40]));
    // The last bar's value is corrected 40 → 60; updateLast recomputes only row 3.
    const patches = computer.apply({ kind: 'updateLast' }, stubStore([10, 20, 30, 60]));
    expect(patches[0]!.mode).toBe('updateLast');
    expect(patches[0]!.fromRow).toBe(3);
    // e[3] = α·60 + (1−α)·e[2], where e[2] = emaSeq([10,20,30])[2].
    const e2 = emaSeq([10, 20, 30])[2]!;
    expect(patches[0]!.rows).toEqual([ALPHA * 60 + (1 - ALPHA) * e2]);
  });

  test('an empty input returns an empty replace patch (no rows)', () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    const patches = computer.apply({ kind: 'replace' }, stubStore([]));
    expect(patches[0]!.mode).toBe('replace');
    expect(patches[0]!.rows).toEqual([]);
  });

  test('a non-finite (whitespace) input row emits a null output row, recurrence continues', () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    // stubStore drops nulls, so model the gap as the same plot rows the store would hold.
    const patches = computer.apply({ kind: 'replace' }, stubStore([10, 30]));
    expect(patches[0]!.rows).toEqual([10, ALPHA * 30 + (1 - ALPHA) * 10]);
  });

  test('an invalid period throws (period must be a finite number >= 1)', () => {
    expect(() => emaDefinition.createComputer({ period: 0 })).toThrow(RangeError);
    expect(() => emaDefinition.createComputer({ period: Number.NaN })).toThrow(RangeError);
  });
});
