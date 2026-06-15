// Spec of record: design 05 §6 (multi-chart SyncGroup — both range modes 'logical'/
// 'time', both crosshair modes 'time'/'time-price', the pane-0-first-series price
// derivation + the no-series fallback, the CORE echo-suppression guarantee) + the V1-REQ
// L1-L6 checklist (§6.2). Each test asserts ONE checkable requirement HEADLESSLY against
// the PUBLIC api seams — stub IChart/ITimeScale handles that model the doc-02 §9/§14
// contracts (L3: setters fire change events ONLY on an actual value change; range/
// crosshair forwarded by HorzKey, not pixel) EXACTLY, exactly as the sibling tool-host
// test stubs the public surface — plus ONE real createChartWith integration for L2 (two
// charts sharing one IFrameScheduler paint in one tick). No DOM, no model, no real
// backend on the unit path.
import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface } from '../../gfx';
// timeBehavior + IFrameScheduler reach us through the PUBLIC api barrel (re-exported per
// design 02 §3.2), NOT via deep host/data imports — keeping the §3.1 extras wall clean.
import { CandlestickSeries, createChartWith, timeBehavior } from '../../api';
import type { IChart, IFrameScheduler, ITimeScale, MouseEventParams, Time } from '../../api';
import { createSyncGroup, type SyncGroupOptions } from './sync-group';

// =====================================================================================
// A stub ITimeScale that models the doc-02 §9 contracts SyncGroup leans on:
//  • getVisibleLogicalRange / setVisibleLogicalRange hold a logical range as a plain
//    immutable value object (L1); a setVisibleLogicalRange that lands on the CURRENT
//    value is a VALUE NO-OP and fires NO change event (L3 — the core echo-suppression
//    guarantee, modeled at the public seam).
//  • logicalToKey / keyToLogical implement an affine slot mapping (the T5 pair): key =
//    base + logical * spacing, and the inverse, with extrapolation outside the range.
//    `empty` charts return null from both + null ranges (the skip-empty-timeline path).
//  • setCrosshairPosition is recorded (price | null, the HorzKey, optional series).
// The crosshair-move hub fires on demand via emitCrosshair (the source side); SyncGroup
// only LISTENS on it and PLACES via setCrosshairPosition (it never emits).
// =====================================================================================
interface CrosshairCall {
  price: number | null;
  key: number;
  series: unknown;
}

function makeStubChart(cfg?: {
  base?: number; // the key at logical 0
  spacing?: number; // key units per slot
  empty?: boolean; // an empty timeline → null ranges, null key mappings
  panePrice?: (y: number) => number | null; // pane-0 series-0 coordinateToPrice
  noSeries?: boolean; // pane-0 has no series (the no-series fallback)
  echoCrosshair?: boolean; // a backend that RE-FIRES subscribeCrosshairMove on a
  // programmatic setCrosshairPosition (the adversarial ping-pong source — proves the
  // crosshair echo guard suppresses A→B→A so it converges in ONE hop).
}) {
  const base = cfg?.base ?? 1000;
  const spacing = cfg?.spacing ?? 100;
  const empty = cfg?.empty ?? false;

  let range: { from: number; to: number } | null = { from: 0, to: 4 };
  const rangeListeners = new Set<(r: { from: number; to: number } | null) => void>();
  const crosshairListeners = new Set<(p: MouseEventParams<Time>) => void>();
  const crosshairCalls: CrosshairCall[] = [];
  let rangeSets = 0; // total setVisibleLogicalRange calls (incl. value no-ops)
  let rangeFires = 0; // change events actually fired (L3 counter)
  let crosshairFires = 0; // crosshair-move events this chart's listeners SAW (echo counter)

  const seriesHandle = cfg?.noSeries
    ? null
    : { coordinateToPrice: (y: number): number | null => (cfg?.panePrice ?? ((yy) => 100 - yy))(y) };

  const ts: ITimeScale<Time> = {
    getVisibleLogicalRange: () => (empty ? null : range === null ? null : { ...range }),
    setVisibleLogicalRange: (r: { from: number; to: number }) => {
      rangeSets++;
      if (empty) return; // empty scale: silent no-op (doc 02 §9)
      // VALUE NO-OP → fire nothing (L3: events fire only on an ACTUAL change).
      if (range !== null && range.from === r.from && range.to === r.to) return;
      range = { from: r.from, to: r.to };
      rangeFires++;
      for (const h of [...rangeListeners]) h({ ...range });
    },
    subscribeVisibleLogicalRangeChange: (h) => {
      rangeListeners.add(h);
      return () => void rangeListeners.delete(h);
    },
    logicalToKey: (logical: number, opts?: { extrapolate?: boolean }) => {
      if (empty) return null;
      if (logical < 0 || logical > 4) return opts?.extrapolate ? base + logical * spacing : null;
      return base + logical * spacing;
    },
    keyToLogical: (key: number, opts?: { extrapolate?: boolean }) => {
      if (empty) return null;
      const logical = (key - base) / spacing;
      if (logical < 0 || logical > 4) return opts?.extrapolate ? logical : null;
      return logical;
    },
  } as unknown as ITimeScale<Time>;

  // local key→logical (mirrors the ts mapping) so an echoed move carries this chart's logical.
  const keyToLogicalLocal = (key: number): number => (key - base) / spacing;

  // Fire this chart's crosshair listeners (a move event) — bumps the echo counter so a
  // test can prove how many times this chart re-broadcast (one hop = exactly the user move).
  const fireCrosshair = (p: MouseEventParams<Time>): void => {
    crosshairFires++;
    for (const h of [...crosshairListeners]) h(p);
  };

  const chart = {
    timeScale: () => ts,
    panes: () => [{ series: () => (seriesHandle === null ? [] : [seriesHandle]) }],
    subscribeCrosshairMove: (h: (p: MouseEventParams<Time>) => void) => {
      crosshairListeners.add(h);
      return () => void crosshairListeners.delete(h);
    },
    setCrosshairPosition: (price: number | null, horzItem: Time, series?: unknown) => {
      crosshairCalls.push({ price, key: horzItem as unknown as number, series: series ?? null });
      // An adversarial backend echoes a programmatic set back out as a move event. WITHOUT
      // echo suppression this would bounce forever; the SyncGroup's crosshair guard must
      // swallow the re-entrant fire so the ping-pong converges in one hop (L3 / design 05 §6.2).
      if (cfg?.echoCrosshair) fireCrosshair({ logical: keyToLogicalLocal(horzItem as unknown as number) } as MouseEventParams<Time>);
    },
  } as unknown as IChart<Time>;

  return {
    chart,
    ts,
    // test drivers / probes
    setRange: (r: { from: number; to: number } | null) => {
      // a USER-initiated range change (pan/zoom): set + fire if changed.
      if (r === null) {
        for (const h of [...rangeListeners]) h(null);
        return;
      }
      if (range !== null && range.from === r.from && range.to === r.to) return;
      range = { ...r };
      rangeFires++;
      for (const h of [...rangeListeners]) h({ ...range });
    },
    emitCrosshair: (p: Partial<MouseEventParams<Time>>) => {
      // a USER-initiated crosshair move (counted via fireCrosshair).
      fireCrosshair(p as MouseEventParams<Time>);
    },
    getRange: () => range,
    crosshairCalls,
    stats: () => ({ rangeSets, rangeFires, crosshairFires }),
  };
}

// =====================================================================================
// L5 / range — 'logical' mode mirrors the raw range onto every OTHER chart.
// =====================================================================================
describe("L5 — range sync 'logical' (raw logical range mirrored to peers)", () => {
  test('a pan on A pushes the SAME logical range onto B and C', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const c = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart, c.chart], { range: 'logical' });

    a.setRange({ from: 1, to: 5 });
    expect(b.getRange()).toEqual({ from: 1, to: 5 });
    expect(c.getRange()).toEqual({ from: 1, to: 5 });
    group.dispose();
  });

  test('the source is NOT re-set by its own broadcast (no self-forward)', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'logical' });
    const before = a.stats().rangeSets;
    a.setRange({ from: 2, to: 6 });
    // A fired the change; SyncGroup set B (and only B) — A's own setVisibleLogicalRange
    // is never called by the group (it skips target === source).
    expect(a.stats().rangeSets).toBe(before);
    expect(b.getRange()).toEqual({ from: 2, to: 6 });
    group.dispose();
  });
});

// =====================================================================================
// L3 — echo suppression (the CORE guarantee): an A→B→A ping-pong converges in ONE hop.
// B's set-back onto A lands on A's CURRENT value → a value no-op → fires nothing → A
// never re-broadcasts. No infinite echo; no `source` field needed (design 05 §6.1).
// =====================================================================================
describe('L3 — echo-free ping-pong converges in one hop (no source field)', () => {
  test('a pan on A settles B once and does NOT bounce back to re-fire A', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'logical' });

    const aFiresBefore = a.stats().rangeFires;
    a.setRange({ from: 1, to: 5 }); // the only USER change
    // B was set to {1,5} exactly once and FIRED once (it changed from {0,4}).
    expect(b.getRange()).toEqual({ from: 1, to: 5 });
    expect(b.stats().rangeFires).toBe(1);
    // A fired exactly once (the user pan). The forward to B did NOT echo back to A:
    // B's broadcast set A to {1,5}, A's CURRENT value, so A's setter was a value no-op
    // and fired nothing extra (L3). One hop, converged.
    expect(a.stats().rangeFires).toBe(aFiresBefore + 1);
    group.dispose();
  });

  test('three charts all converge to the source range with no runaway', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const c = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart, c.chart], { range: 'logical' });
    a.setRange({ from: 0, to: 3 });
    expect(b.getRange()).toEqual({ from: 0, to: 3 });
    expect(c.getRange()).toEqual({ from: 0, to: 3 });
    // each non-source fired exactly once; the source fired exactly once (the pan).
    expect(a.stats().rangeFires).toBe(1);
    expect(b.stats().rangeFires).toBe(1);
    expect(c.stats().rangeFires).toBe(1);
    group.dispose();
  });
});

// =====================================================================================
// L3 / CROSSHAIR — the two-chart crosshair ping-pong converges echo-free in ONE hop
// (design 05 §6.2). Both charts model an adversarial backend that RE-FIRES
// subscribeCrosshairMove on a programmatic setCrosshairPosition; without echo suppression
// the A→B set would bounce B→A→B forever. The SyncGroup's crosshair guard swallows the
// re-entrant fire so it settles after exactly one hop.
// =====================================================================================
describe('L3 — crosshair ping-pong converges echo-free in one hop (design 05 §6.2)', () => {
  test('a crosshair move on A sets B once and does NOT bounce back to re-fire A', () => {
    const a = makeStubChart({ base: 1000, spacing: 100, echoCrosshair: true });
    const b = makeStubChart({ base: 1000, spacing: 100, echoCrosshair: true });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time' });

    // the ONLY user crosshair move: at logical 2 (key 1200) on A.
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 50 as never } });

    // B received exactly ONE programmatic crosshair set at the mapped key…
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.key).toBeCloseTo(1200);
    // …and B's echo of that set was SUPPRESSED (the guard held during A's fan-out), so it
    // never bounced back: A got NO programmatic set, and A fired only the original user move.
    expect(a.crosshairCalls.length).toBe(0); // A was never re-driven by B's echo
    expect(a.stats().crosshairFires).toBe(1); // exactly the user move — no runaway
    expect(b.stats().crosshairFires).toBe(1); // B fired exactly once (its single echo)
    group.dispose();
  });

  test('symmetric: a move on B settles A once with no runaway (guard works both ways)', () => {
    const a = makeStubChart({ base: 1000, spacing: 100, echoCrosshair: true });
    const b = makeStubChart({ base: 1000, spacing: 100, echoCrosshair: true });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time' });
    b.emitCrosshair({ logical: 3 as never, point: { x: 30 as never, y: 50 as never } });
    expect(a.crosshairCalls.length).toBe(1);
    expect(a.crosshairCalls[0]!.key).toBeCloseTo(1300);
    expect(b.crosshairCalls.length).toBe(0);
    expect(b.stats().crosshairFires).toBe(1);
    group.dispose();
  });
});

// =====================================================================================
// Guard granularity (the per-CHANNEL fix): the range fan-out and the crosshair fan-out
// must NOT suppress each other. A crosshair event that arrives WHILE a range fan-out is in
// flight (and vice-versa) is an independent signal and must still forward. Modeled by
// making a target's range-set synchronously trigger a crosshair move (a backend coupling),
// then asserting the crosshair STILL fans out (it would be wrongly swallowed by a single
// shared `forwarding` flag).
// =====================================================================================
describe('guard is per-channel: range + crosshair fan-outs do not suppress each other', () => {
  test('a crosshair fired DURING a range fan-out still forwards (not swallowed)', () => {
    const a = makeStubChart({ base: 1000, spacing: 100 });
    const b = makeStubChart({ base: 1000, spacing: 100 });
    const c = makeStubChart({ base: 1000, spacing: 100 }); // the crosshair target
    const group = createSyncGroup([a.chart, b.chart, c.chart], { range: 'logical', crosshair: 'time' });

    // Couple B's range setter to emit a crosshair move: when SyncGroup sets B's range (inside
    // the RANGE fan-out), B synchronously fires a crosshair — a different channel. A single
    // shared guard would be `true` here and drop it; the per-channel guard lets it through.
    const realSet = b.ts.setVisibleLogicalRange.bind(b.ts);
    let coupled = false;
    b.ts.setVisibleLogicalRange = (r: { from: number; to: number }) => {
      realSet(r);
      if (!coupled) {
        coupled = true; // once, to avoid its own recursion in this synthetic coupling
        b.emitCrosshair({ logical: 1 as never, point: { x: 10 as never, y: 50 as never } });
      }
    };

    // A user pan on A → SyncGroup's RANGE fan-out sets B (and C). B's set fires a CROSSHAIR
    // mid-fan-out; the crosshair guard is independent, so it forwards to its peers.
    a.setRange({ from: 1, to: 3 });

    expect(b.getRange()).toEqual({ from: 1, to: 3 }); // range fan-out worked
    // The crosshair B emitted during the range fan-out reached the OTHER charts (A and C),
    // proving the crosshair channel was NOT suppressed by the in-flight range guard.
    expect(a.crosshairCalls.length + c.crosshairCalls.length).toBeGreaterThan(0);
    expect(c.crosshairCalls.some((x) => Math.abs(x.key - 1100) < 1e-6)).toBe(true); // logical 1 → key 1100
    group.dispose();
  });
});

// =====================================================================================
// L5 / range — 'time' mode maps endpoints through the T5 pair (logicalToKey on the
// source → keyToLogical(.., {extrapolate:true}) on each target) for DIFFERENT datasets,
// and SKIPS targets with empty timelines.
// =====================================================================================
describe("L5 — range sync 'time' (HorzKey endpoint mapping across different datasets)", () => {
  test('A (base 1000) and B (base 2000) align by KEY, not by raw logical', () => {
    // A: key = 1000 + logical*100. B: key = 2000 + logical*100. A pans to logical [1,3]
    // → keys [1100, 1300] → B logical [(1100-2000)/100, (1300-2000)/100] = [-9, -7].
    const a = makeStubChart({ base: 1000, spacing: 100 });
    const b = makeStubChart({ base: 2000, spacing: 100 });
    const group = createSyncGroup([a.chart, b.chart], { range: 'time' });
    a.setRange({ from: 1, to: 3 });
    const r = b.getRange()!;
    expect(r.from).toBeCloseTo(-9);
    expect(r.to).toBeCloseTo(-7);
    group.dispose();
  });

  test('a target with an EMPTY timeline is skipped (no key to map)', () => {
    const a = makeStubChart({ base: 1000 });
    const empty = makeStubChart({ empty: true });
    const group = createSyncGroup([a.chart, empty.chart], { range: 'time' });
    a.setRange({ from: 1, to: 3 });
    // the public seam reports null for an empty scale, and SyncGroup never even calls
    // setVisibleLogicalRange on it (keyToLogical on the empty target returned null).
    expect(empty.ts.getVisibleLogicalRange()).toBeNull();
    expect(empty.stats().rangeSets).toBe(0);
    group.dispose();
  });

  test("range: 'off' wires no range sync (B never moves)", () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'off' });
    a.setRange({ from: 1, to: 5 });
    expect(b.getRange()).toEqual({ from: 0, to: 4 }); // untouched
    group.dispose();
  });
});

// =====================================================================================
// L4 / L5 — crosshair sync 'time' (the A-1 time-line-only form): the source crosshair
// logical → HorzKey via logicalToKey; each target gets setCrosshairPosition(null, key)
// (no price). Addressed by KEY, not pixel (L4).
// =====================================================================================
describe("L5 — crosshair sync 'time' (time-line-only, addressed by key not pixel)", () => {
  test('a crosshair move on A places a time-line (price null) on B at the mapped key', () => {
    const a = makeStubChart({ base: 1000, spacing: 100 });
    const b = makeStubChart({ base: 1000, spacing: 100 });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time' });
    // crosshair at logical 2 (key 1200), with a pixel point — 'time' ignores the price.
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 50 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull(); // time-line-only (A-1)
    expect(b.crosshairCalls[0]!.key).toBeCloseTo(1200); // by KEY (L4), not pixel x=20
    expect(b.crosshairCalls[0]!.series).toBeNull(); // no series for the null-price form
    group.dispose();
  });

  test('a crosshair with no logical (off-scale/leave) forwards nothing', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { crosshair: 'time', range: 'off' });
    a.emitCrosshair({ point: { x: 5 as never, y: 5 as never } }); // no `logical`
    expect(b.crosshairCalls.length).toBe(0);
    group.dispose();
  });

  test("crosshair: 'off' wires no crosshair sync", () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { crosshair: 'off', range: 'off' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 50 as never } });
    expect(b.crosshairCalls.length).toBe(0);
    group.dispose();
  });
});

// =====================================================================================
// L5 — crosshair sync 'time-price': the SOURCE price is read from source.panes()[0].
// series()[0].coordinateToPrice(point.y) and placed on each TARGET's pane-0 first series;
// the no-pane-0-series target falls back to the time-line-only form (selected here); a
// move with no point also falls back to 'time'.
// =====================================================================================
describe("L5 — crosshair sync 'time-price' (source price derivation + no-series fallback)", () => {
  test('the source price (coordinateToPrice on point.y) is placed on B at the mapped key', () => {
    // A's pane-0 series: coordinateToPrice(y) = 100 - y. y=40 → price 60.
    const a = makeStubChart({ base: 1000, spacing: 100, panePrice: (y) => 100 - y });
    const b = makeStubChart({ base: 1000, spacing: 100 });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 40 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeCloseTo(60); // derived from the SOURCE series
    expect(b.crosshairCalls[0]!.key).toBeCloseTo(1200); // mapped by key (L4)
    expect(b.crosshairCalls[0]!.series).not.toBeNull(); // placed on B's pane-0 first series
    group.dispose();
  });

  test('a target with NO pane-0 series falls back to the time-line-only form (SyncGroup-selected)', () => {
    const a = makeStubChart({ panePrice: (y) => 100 - y });
    const b = makeStubChart({ noSeries: true }); // B has no pane-0 series
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 40 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    // because the numeric form silently no-ops on a missing series (doc 02 §16.4),
    // SyncGroup itself selects the price:null time-line-only form so B still gets a line.
    expect(b.crosshairCalls[0]!.price).toBeNull();
    expect(b.crosshairCalls[0]!.series).toBeNull();
    group.dispose();
  });

  test('a move with NO point (leave/programmatic) falls back to the time-line-only form', () => {
    const a = makeStubChart({ panePrice: (y) => 100 - y });
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never }); // no point → no price → 'time' fallback
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull();
    group.dispose();
  });

  test('a source with NO pane-0 series (no derivable price) falls back to the time-line-only form', () => {
    const a = makeStubChart({ noSeries: true });
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 40 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull(); // no source price → time-line-only
    group.dispose();
  });

  test('an off-scale source price (coordinateToPrice null) falls back to the time-line-only form', () => {
    const a = makeStubChart({ panePrice: () => null }); // off-scale → null price
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 40 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull();
    group.dispose();
  });
});

// =====================================================================================
// L1 — the geometry/range values SyncGroup carries are immutable plain value objects:
// getVisibleLogicalRange hands a fresh {from,to}; SyncGroup forwards a fresh object, so
// a target mutating its received range cannot corrupt the source.
// =====================================================================================
describe('L1 — logical-range value objects are independent (no shared mutable state)', () => {
  test('the range forwarded to B is a distinct object from A`s live range', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'logical' });
    a.setRange({ from: 1, to: 5 });
    const ar = a.getRange()!;
    const br = b.getRange()!;
    expect(br).toEqual(ar);
    expect(br).not.toBe(ar); // distinct value objects (L1: serializable/shareable, not aliased)
    group.dispose();
  });
});

// =====================================================================================
// dispose — idempotent; after teardown a source change forwards NOTHING.
// =====================================================================================
describe('SyncGroup.dispose — idempotent teardown drops all subscriptions', () => {
  test('after dispose a pan on A does not move B', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'logical', crosshair: 'time' });
    group.dispose();
    group.dispose(); // idempotent — no throw
    a.setRange({ from: 1, to: 5 });
    a.emitCrosshair({ logical: 2 as never, point: { x: 1 as never, y: 1 as never } });
    expect(b.getRange()).toEqual({ from: 0, to: 4 }); // untouched
    expect(b.crosshairCalls.length).toBe(0);
  });
});

// =====================================================================================
// L2 — two charts sharing ONE injected IFrameScheduler paint in ONE tick. Built over the
// REAL createChartWith join point (a stub IRenderBackend records the §6 begin/render/end
// sequence; a fake container + a shared multi-slot rAF), exactly as the EMA/demo-chart
// harness. The two real charts are wired into a SyncGroup (proving the group composes
// with the live public handles), then BOTH charts' invalidations are armed on the ONE
// shared scheduler; a SINGLE flush paints BOTH (no per-chart stagger / second tick).
//
// NOTE (the integration scope): the genuine L2 subject is the SHARED SCHEDULER's one-tick
// coalescing — which IS fully wired (createChartWith accepts the injected IFrameScheduler;
// both charts schedule onto it; one flush drains both). The range-FORWARD→frame path
// (SyncGroup's setVisibleLogicalRange arming a frame on the target) cannot be integration-
// tested through the real join point YET, because create-chart.ts's makeTimeScaleHandle
// stubs the entire range/key surface (getVisibleLogicalRange → null, setVisibleLogicalRange
// → no-op, the visibleLogicalRange hub is never fired) pending the M11 time-scale-geometry
// landing — see missingSeams. That forwarding logic is proven above over the stub charts
// that model the documented doc-02 §9 contracts (L3/L5); here we prove only what the wired
// join point supports: shared-scheduler single-tick paint of two grouped charts.
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

// A multi-slot scheduler (queues every armed callback; one flush drains them all) — the
// SHARED scheduler L2 mandates. flush() runs every callback pending at flush time.
function makeSharedRaf(): IFrameScheduler & { flush(t?: number): void; pendingCount(): number } {
  let pending: ((n: number) => void)[] = [];
  let n = 0;
  return {
    schedule: (cb) => {
      pending.push(cb);
      return () => {
        pending = pending.filter((p) => p !== cb);
      };
    },
    dispose: () => void (pending = []),
    pendingCount: () => pending.length,
    flush: (t) => {
      const run = pending;
      pending = [];
      for (const cb of run) cb(t ?? n++);
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

const CANDLES = [
  { time: '2026-01-05' as unknown as Time, open: 10, high: 14, low: 9, close: 13 },
  { time: '2026-01-06' as unknown as Time, open: 13, high: 17, low: 12, close: 11 },
  { time: '2026-01-07' as unknown as Time, open: 11, high: 12, low: 8, close: 9 },
  { time: '2026-01-08' as unknown as Time, open: 9, high: 15, low: 9, close: 14 },
  { time: '2026-01-09' as unknown as Time, open: 14, high: 16, low: 13, close: 15 },
];

function makeRealChart(raf: IFrameScheduler, log: string[]): IChart<Time> {
  const doc = makeDoc();
  const container = makeEl(doc);
  return createChartWith(
    container as unknown as HTMLElement,
    makeBackend(log),
    timeBehavior(),
    { layout: { textColor: '#191919' } },
    { scheduler: raf },
  ) as unknown as IChart<Time>;
}

describe('L2 — two grouped charts sharing one IFrameScheduler paint in one tick', () => {
  test('both charts arm on the ONE shared scheduler and a SINGLE flush paints both', () => {
    const raf = makeSharedRaf();
    const logA: string[] = [];
    const logB: string[] = [];
    const a = makeRealChart(raf, logA);
    const b = makeRealChart(raf, logB);
    raf.flush(0); // drain the construction frames

    // The two REAL public handles compose into a SyncGroup without error (the group is
    // built over IChart/ITimeScale exactly as shipped — L5's value export over live seams).
    const group = createSyncGroup([a, b], { range: 'logical', crosshair: 'time' });

    const sa = a.addSeries(CandlestickSeries);
    const sb = b.addSeries(CandlestickSeries);
    logA.length = 0;
    logB.length = 0;
    // Mutate BOTH charts (each arms a frame on the SAME injected scheduler). This is the
    // L2 mechanism: one scheduler, both charts' invalidations queued on it together.
    sa.setData(CANDLES);
    sb.setData(CANDLES);
    expect(raf.pendingCount()).toBeGreaterThanOrEqual(1); // armed on the shared scheduler

    // ONE flush drains every queued callback → BOTH charts paint in the SAME tick.
    raf.flush(1);
    expect(logA.some((l) => l.includes('.beginFrame'))).toBe(true);
    expect(logB.some((l) => l.includes('.beginFrame'))).toBe(true);
    // after that single tick the shared scheduler is idle — no per-chart stagger.
    expect(raf.pendingCount()).toBe(0);

    group.dispose();
    a.dispose();
    b.dispose();
  });

  test('the shared scheduler is the SAME object both charts scheduled onto (one tick, not two)', () => {
    // Two charts, two backends, ONE scheduler. Each arms its own callback, but a single
    // flush() runs them together — the definition of "paint in one tick" (L2). A private
    // per-chart scheduler would need two separate flushes; the shared one needs exactly one.
    const raf = makeSharedRaf();
    const logA: string[] = [];
    const logB: string[] = [];
    const a = makeRealChart(raf, logA);
    const b = makeRealChart(raf, logB);
    raf.flush(0);
    const group = createSyncGroup([a, b], { range: 'logical', crosshair: 'off' });

    a.addSeries(CandlestickSeries).setData(CANDLES);
    b.addSeries(CandlestickSeries).setData(CANDLES);
    logA.length = 0;
    logB.length = 0;
    const ticks = drainTicks(raf); // count how many flushes it takes to fully settle
    expect(ticks).toBe(1); // both charts settled in ONE tick on the shared scheduler
    expect(logA.some((l) => l.includes('.endFrame'))).toBe(true);
    expect(logB.some((l) => l.includes('.endFrame'))).toBe(true);

    group.dispose();
    a.dispose();
    b.dispose();
  });
});

// Flush the shared scheduler until it stops re-arming; return the number of flushes used.
function drainTicks(raf: { flush(t?: number): void; pendingCount(): number }): number {
  let ticks = 0;
  while (raf.pendingCount() > 0 && ticks < 10) {
    raf.flush();
    ticks++;
  }
  return ticks;
}

// A type-level touch so the SyncGroupOptions export is exercised (both modes present).
const _modes: SyncGroupOptions[] = [
  { range: 'logical', crosshair: 'time' },
  { range: 'time', crosshair: 'time-price' },
  { range: 'off', crosshair: 'off' },
];
void _modes;
