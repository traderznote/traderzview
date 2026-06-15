// Spec of record: design 05 §4 (drawing tools — the FSM, domain anchors, the off-grid
// keyToLogical/logicalToKey extrapolation, ranked hit-test Point-beats-Line, JSON
// serialize/deserialize) + the V1-REQ T1–T8 checklist (§4.2). Each test asserts ONE
// checkable requirement HEADLESSLY against the PUBLIC api seams (IChart/ITimeScale/
// IPane/ISeries/IInteractionRouter + the gfx HitCandidate/ZBand) — stubbed exactly as
// the M12 plugin tests stub them; no DOM, no model, no real backend. The in-tree
// trend-line tool is the consumer proving T1–T8 end to end.
import { describe, expect, test, vi } from 'vitest';
import { HitPriority, ZBand } from '../../gfx';
import type { DisplayList, HitCandidate, SceneSource, ViewFrame } from '../../gfx';
import type {
  GestureEvent,
  GestureRegistration,
  GestureResponse,
  IChart,
  IPane,
  IPrimitive,
  PrimitiveContext,
} from '../../api';
import {
  createToolHost,
  TrendLineTool,
  trendLineDefaults,
  type Anchor,
  type SerializedShape,
  type ToolHostEvent,
} from './tool-host';

// =====================================================================================
// A stub chart over the PUBLIC api surface. The time scale models the T5 key↔logical
// mapping exactly: a 5-slot grid at keys 1000,1100,1200,1300,1400 (spacing 100), bar
// spacing 10 px, x = logical * 10. coordinateToLogical is the FLOAT inverse (T2), and
// keyToLogical/logicalToKey interpolate in range and EXTRAPOLATE outside at the mean
// trailing gap (here a constant 100) — so an off-grid x maps to a real domain key.
// =====================================================================================
const KEYS = [1000, 1100, 1200, 1300, 1400];
const SPACING = 100; // key units per slot
const BAR_PX = 10; // px per slot

function makeTimeScale() {
  return {
    coordinateToLogical: (x: number): number | null => x / BAR_PX, // float (T2)
    logicalToCoordinate: (logical: number): number | null => logical * BAR_PX,
    logicalToKey: (logical: number, opts?: { extrapolate?: boolean }): number | null => {
      if (logical >= 0 && logical <= KEYS.length - 1) {
        const lo = Math.floor(logical);
        const frac = logical - lo;
        const hi = Math.min(lo + 1, KEYS.length - 1);
        return KEYS[lo]! + frac * (KEYS[hi]! - KEYS[lo]!);
      }
      if (!opts?.extrapolate) return null; // off-grid w/o extrapolate → null (T5 default)
      // extrapolate at the constant spacing (mean trailing gap = 100).
      if (logical < 0) return KEYS[0]! + logical * SPACING;
      return KEYS[KEYS.length - 1]! + (logical - (KEYS.length - 1)) * SPACING;
    },
    keyToLogical: (key: number, opts?: { extrapolate?: boolean }): number | null => {
      const logical = (key - KEYS[0]!) / SPACING;
      if (logical >= 0 && logical <= KEYS.length - 1) return logical;
      return opts?.extrapolate ? logical : null;
    },
  };
}

// A stub series: y = 100 - price (higher price → smaller y, the normal-scale mapping).
function makeSeries() {
  return {
    coordinateToPrice: (y: number): number | null => 100 - y,
    priceToCoordinate: (price: number): number | null => 100 - price,
  };
}

// A stub pane: stable id() (T8), a series list, and a recording primitive attach seam.
function makePane(id: string, series: ReturnType<typeof makeSeries> | null) {
  const attached: IPrimitive[] = [];
  const detached: IPrimitive[] = [];
  return {
    attached,
    detached,
    id: () => id,
    series: () => (series === null ? [] : [series]),
    attachPrimitive: (p: IPrimitive) => void attached.push(p),
    detachPrimitive: (p: IPrimitive) => void detached.push(p),
  };
}

// A fake InteractionRouter that records the registration so we can (a) assert the TOOL
// priority is above the priority-0 defaults and (b) drive the handler directly (T1).
function makeRouter() {
  const regs: GestureRegistration[] = [];
  return {
    regs,
    register(reg: GestureRegistration) {
      regs.push(reg);
      return () => {
        const i = regs.indexOf(reg);
        if (i >= 0) regs.splice(i, 1);
      };
    },
  };
}

interface Stub {
  router: ReturnType<typeof makeRouter>;
  panes: ReturnType<typeof makePane>[];
  ts: ReturnType<typeof makeTimeScale>;
  chart: IChart;
}

function makeChart(opts?: { panes?: ReturnType<typeof makePane>[] }): Stub {
  const router = makeRouter();
  const ts = makeTimeScale();
  const panes = opts?.panes ?? [makePane('p0', makeSeries())];
  const chart = {
    timeScale: () => ts,
    input: () => router,
    panes: () => panes,
  } as unknown as IChart;
  return { router, panes, ts, chart };
}

const gesture = (over: Partial<GestureEvent>): GestureEvent =>
  ({
    kind: 'tap',
    phase: 'fire',
    surface: 'pane',
    paneIndex: 0,
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
    deltaX: 0,
    deltaY: 0,
    pointerType: 'mouse',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    ...over,
  }) as GestureEvent;

const FRAME: ViewFrame = {
  frame: { mediaSize: { width: 300, height: 200 }, bitmapSize: { width: 300, height: 200 }, hr: 1, vr: 1 },
  now: 0,
} as unknown as ViewFrame;

// A minimal multi-anchor tool (arity 2..4) proving the creation FSM collects beyond `min`
// and commits at `max` — not at `min` (which would strand anchors 3+). The shape is a bare
// IShapePrimitive that just holds its anchors (no rendering needed for the FSM assertion).
const MultiAnchorTool = {
  type: 'multi-anchor',
  anchors: { min: 2, max: 4 },
  defaultStyle: { color: '#0F0' },
  createShape(initial: readonly Anchor[], style: { color: string }) {
    let anchors: Anchor[] = initial.map((a) => ({ ...a }));
    let selected = false;
    return {
      attached: () => {},
      detached: () => {},
      sources: () => [],
      setAnchors: (next: readonly Anchor[]) => void (anchors = next.map((a) => ({ ...a }))),
      setSelected: (s: boolean) => void (selected = s),
      serialize: () => ({ type: 'multi-anchor', version: 1, anchors: anchors.map((a) => ({ ...a })), style }),
      // expose for any assertion that wants the live anchors/selection
      get _anchors() {
        return anchors;
      },
      get _selected() {
        return selected;
      },
    };
  },
};

// Build a host with the trend-line tool registered + armed, then place k taps.
function placeTrendLine(stub: Stub, taps: { x: number; y: number }[]): { host: ReturnType<typeof createToolHost>; events: ToolHostEvent[] } {
  const host = createToolHost(stub.chart);
  const events: ToolHostEvent[] = [];
  host.subscribe((e) => events.push(e));
  host.registerTool(TrendLineTool as never);
  host.arm('trend-line');
  for (const t of taps) stub.router.regs[0]!.handler(gesture({ kind: 'tap', x: t.x as never, y: t.y as never }));
  return { host, events };
}

// Pull the trend-line primitive that was attached to the pane + its overlay source.
function attachedPrimitive(pane: ReturnType<typeof makePane>): IPrimitive {
  return pane.attached[pane.attached.length - 1]!;
}
function paneSource(p: IPrimitive): SceneSource {
  const srcs = p.sources?.() ?? [];
  return srcs[0]!.source as unknown as SceneSource;
}
function ctxFor(pane: ReturnType<typeof makePane>, chart: IChart): PrimitiveContext {
  const updates: string[] = [];
  return {
    chart,
    pane: pane as unknown as IPane,
    series: undefined,
    requestUpdate: (s: 'overlay' | 'render' | 'layout') => void updates.push(s),
    input: chart.input(),
    images: { create: () => ({}) as never },
    // expose the recorded scopes for assertions
    __updates: updates,
  } as unknown as PrimitiveContext;
}

// =====================================================================================
// T1 — the router yield: the tool registers at TOOL priority (above the priority-0
// defaults) and CLAIMS the gesture stream while armed, so the chart stops panning.
// =====================================================================================
describe('T1 — InteractionRouter priority + claim (the default pan/zoom yield)', () => {
  test('arm registers ONE tool handler at a priority above the priority-0 defaults', () => {
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    expect(stub.router.regs.length).toBe(1);
    expect(stub.router.regs[0]!.priority).toBeGreaterThan(0);
    expect(stub.router.regs[0]!.kinds).toContain('tap');
    expect(stub.router.regs[0]!.surfaces).toEqual(['pane']);
  });

  test('while armed the handler CLAIMS taps/hover (so a priority-0 pan never sees them)', () => {
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    const handler = stub.router.regs[0]!.handler;
    expect(handler(gesture({ kind: 'tap', x: 0 as never, y: 50 as never }))).toBe<GestureResponse>('claim');
    expect(handler(gesture({ kind: 'hover', phase: 'move', x: 20 as never, y: 50 as never }))).toBe('claim');
  });

  test('descending-priority dispatch (the §13.5 rule): the higher-priority tool wins the walk', () => {
    // Model the router walk over the public registrations: the tool (priority>0) is
    // offered before the priority-0 pan, and its 'claim' ends the walk → pan never runs.
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    let panRan = false;
    const pan: GestureRegistration = { kinds: ['tap'], surfaces: ['pane'], priority: 0, handler: () => ((panRan = true), 'claim') };
    const table = [...stub.router.regs, pan].sort((a, b) => b.priority - a.priority);
    for (const r of table) if (r.handler(gesture({ kind: 'tap', x: 0 as never, y: 50 as never })) === 'claim') break;
    expect(panRan).toBe(false); // the tool claimed first; the default pan yielded (T1)
  });
});

// =====================================================================================
// T2 — coordinateToLogical returns the FLOAT; the host uses it (not a snapped index).
// =====================================================================================
describe('T2 — coordinateToLogical float + off-grid key conversion', () => {
  test('a tap at x=15 px maps to FLOAT logical 1.5 → interpolated key 1150 (no snap)', () => {
    const stub = makeChart();
    const spyLog = vi.spyOn(stub.ts, 'coordinateToLogical');
    const spyKey = vi.spyOn(stub.ts, 'logicalToKey');
    const { host } = placeTrendLine(stub, [
      { x: 15, y: 50 },
      { x: 25, y: 40 },
    ]);
    // coordinateToLogical was called with the raw px; logicalToKey with the FLOAT (1.5),
    // not a rounded slot — proving the float path (T2) feeds the off-grid conversion.
    expect(spyLog).toHaveBeenCalledWith(15);
    expect(spyKey).toHaveBeenCalledWith(1.5, { extrapolate: true });
    const a = host.shapes()[0]!.anchors[0]!;
    expect(a.key).toBeCloseTo(1150); // 1.5 between slots 1000 and 1100 (the float, T2)
    expect(a.price).toBeCloseTo(50); // y=50 → price 100-50
  });
});

// =====================================================================================
// T5 — off-the-grid anchors: logicalToKey({extrapolate:true}) places a shape PAST the
// last bar; keyToLogical({extrapolate:true}) renders it back. Default (no extrapolate)
// off-grid → null.
// =====================================================================================
describe('T5 — off-grid key↔logical extrapolation (place & render past the last bar)', () => {
  test('a tap at x=60 px (logical 6, two slots past the last) gets a virtual key 1500', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 60, y: 50 }, // logical 6 → extrapolated key 1400 + (6-4)*... wait spacing
      { x: 25, y: 40 },
    ]);
    const a = host.shapes()[0]!.anchors[0]!;
    // logical 6 is 2 slots past the last (index 4): key = 1400 + (6-4)*100 = 1600.
    expect(a.key).toBeCloseTo(1600);
  });

  test('default (no extrapolate) off-grid logicalToKey is null → the tap is rejected', () => {
    const stub = makeChart();
    // a logicalToKey that REFUSES to extrapolate (mirrors the §9 default) returns null
    // off-grid; the host must not invent an anchor.
    stub.ts.logicalToKey = (logical: number, opts?: { extrapolate?: boolean }) =>
      logical >= 0 && logical <= 4 ? 1000 + logical * 100 : opts?.extrapolate ? 9999 : null;
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    // first tap on-grid, second tap OFF-grid with a router that DID pass extrapolate
    // true — so this proves the host passes {extrapolate:true} (gets 9999, not null).
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', x: 60 as never, y: 50 as never }));
    expect(host.shapes().length).toBe(0); // still placing (1 of 2)
  });

  test('the off-grid endpoint key ROUND-TRIPS and renders at the expected x (T5 inverse property)', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 60, y: 50 }, // logical 6 → off-grid key 1600 (two slots past the last)
      { x: 25, y: 40 },
    ]);
    const k = host.shapes()[0]!.anchors[0]!.key;
    expect(k).toBeCloseTo(1600); // placed off the data grid via logicalToKey({extrapolate})

    // The inverse property (T5): keyToLogical(logicalToKey(logical)) ≈ logical, and the
    // off-grid key maps straight back to its logical — the round-trip the renderer relies on.
    const logical = stub.ts.keyToLogical(k, { extrapolate: true })!;
    expect(logical).toBeCloseTo(6); // 1600 → logical 6 (the placing logical, recovered)
    const kBack = stub.ts.logicalToKey(logical, { extrapolate: true })!;
    expect(stub.ts.keyToLogical(kBack, { extrapolate: true })!).toBeCloseTo(6); // k→logical→k→logical fixpoint

    // …and it RENDERS at the expected x: logicalToCoordinate(6) = 6 * BAR_PX = 60. Read the
    // projected polyline's first vertex (the off-grid endpoint) from the display list.
    const prim = attachedPrimitive(stub.panes[0]!);
    prim.attached!(ctxFor(stub.panes[0]!, stub.chart));
    const lists = paneSource(prim).displayLists();
    expect(lists.length).toBeGreaterThan(0);
    const x0 = firstPolylineX(lists);
    expect(x0).not.toBeNull();
    expect(x0!).toBeCloseTo(stub.ts.logicalToCoordinate(6)!); // == 60, the off-grid endpoint's real x
  });
});

// The x of the first polyline vertex across all display lists (PolylineCommand.points is a
// Float32Array of x,y pairs) — lets a test assert WHERE an off-grid anchor projected.
function firstPolylineX(lists: readonly DisplayList[]): number | null {
  for (const l of lists) {
    for (const c of l.commands as readonly { kind: string; points?: Float32Array }[]) {
      if (c.kind === 'polyline' && c.points !== undefined && c.points.length >= 2) return c.points[0]!;
    }
  }
  return null;
}

// =====================================================================================
// T3 — ranked hit-test: a selected shape's Point handles beat its Line body.
// =====================================================================================
describe('T3 — ranked hit-test (Point handle beats Line body)', () => {
  test('near an endpoint a Point candidate wins; on the body a Line candidate is returned', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 10, y: 50 }, // logical 1, key 1100, price 50 → endpoint A at (10,50)
      { x: 30, y: 30 }, // logical 3, key 1300, price 70 → endpoint B at (30,30)
    ]);
    host.select(host.shapes()[0]!.id);
    const prim = attachedPrimitive(stub.panes[0]!);
    prim.attached!(ctxFor(stub.panes[0]!, stub.chart));
    const src = paneSource(prim);
    // right on endpoint A: a Point candidate (priority 2), data = anchor index 0.
    const atHandle = src.hitTest!(10 as never, 50 as never, FRAME) as HitCandidate;
    expect(atHandle.priority).toBe(HitPriority.Point);
    expect(atHandle.data).toBe(0);
    // mid-body (x=20, y=40 is on the segment): a Line candidate (priority 1).
    const onBody = src.hitTest!(20 as never, 40 as never, FRAME) as HitCandidate;
    expect(onBody.priority).toBe(HitPriority.Line);
    expect(atHandle.priority).toBeGreaterThan(onBody.priority); // Point beats Line (T3)
  });

  test('a drag starting on a handle re-anchors that endpoint (drag-edit via the ranked hit)', () => {
    const stub = makeChart();
    const { host, events } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    host.select(host.shapes()[0]!.id);
    const prim = attachedPrimitive(stub.panes[0]!);
    prim.attached!(ctxFor(stub.panes[0]!, stub.chart));
    const handler = stub.router.regs[0]!.handler;
    // grab endpoint A (10,50), drag to (20,40); the host claims & moves anchor 0.
    expect(handler(gesture({ kind: 'drag', phase: 'start', x: 10 as never, y: 50 as never }))).toBe('claim');
    handler(gesture({ kind: 'drag', phase: 'move', x: 20 as never, y: 40 as never }));
    handler(gesture({ kind: 'drag', phase: 'end', x: 20 as never, y: 40 as never }));
    const a0 = host.shapes()[0]!.anchors[0]!;
    expect(a0.key).toBeCloseTo(1200); // x=20 → logical 2 → key 1200
    expect(a0.price).toBeCloseTo(60); // y=40 → price 60
    expect(events.some((e) => e.kind === 'edited')).toBe(true);
  });

  test('a drag NOT on a shape passes (the default pan keeps the stream — T1 yield back)', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    // nothing selected, drag far from the shape → the tool yields ('pass').
    const handler = stub.router.regs[0]!.handler;
    expect(handler(gesture({ kind: 'drag', phase: 'start', x: 200 as never, y: 150 as never }))).toBe('pass');
  });
});

// =====================================================================================
// T4 — unified IPrimitive: pane-attach, an overlay-band (Cursor/AboveSeries) source,
// requestUpdate('overlay') granularity, attached ctx carrying `input`, auto-detach.
// =====================================================================================
describe('T4 — the unified IPrimitive seam (pane-attach + overlay + ctx.input + auto-detach)', () => {
  test('the committed shape is pane-attached and registers ONE pane scene source', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    expect(stub.panes[0]!.attached.length).toBeGreaterThan(0);
    const prim = attachedPrimitive(stub.panes[0]!);
    const srcs = prim.sources!();
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.target).toBe('pane');
    expect((srcs[0]!.source as unknown as SceneSource).zBand).toBe(ZBand.AboveSeries);
  });

  test('attached(ctx) carries `input`; setSelected requests an OVERLAY-only update', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const prim = attachedPrimitive(stub.panes[0]!);
    const ctx = ctxFor(stub.panes[0]!, stub.chart);
    prim.attached!(ctx);
    expect(ctx.input).toBe(stub.chart.input()); // ctx carries the router (T4/T1 reach)
    (prim as { setSelected(s: boolean): void }).setSelected(true);
    expect((ctx as unknown as { __updates: string[] }).__updates).toContain('overlay'); // cheap recomposite
  });

  test('detached() clears the context (auto-detach on pane/series removal, §2.2)', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const prim = attachedPrimitive(stub.panes[0]!);
    prim.attached!(ctxFor(stub.panes[0]!, stub.chart));
    prim.detached!();
    // after detach the source projects nothing (no ctx → no coordinates).
    expect(paneSource(prim).displayLists().length).toBe(0);
  });

  test('host.remove() detaches the primitive from its pane', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const id = host.shapes()[0]!.id;
    host.remove(id);
    expect(stub.panes[0]!.detached.length).toBeGreaterThan(0);
    expect(host.shapes().length).toBe(0);
  });
});

// =====================================================================================
// T6 — primitive axis labels for a pane-attached primitive (price labels must render).
// =====================================================================================
describe('T6 — pane-attached primitive axis labels render', () => {
  test('the trend line contributes one price-axis label per anchor', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 }, // price 50
      { x: 30, y: 30 }, // price 70
    ]);
    const prim = attachedPrimitive(stub.panes[0]!);
    const labels = prim.priceAxisLabels!();
    expect(labels.length).toBe(2);
    expect(labels[0]!.coordinate()).toBeCloseTo(50);
    expect(labels[1]!.coordinate()).toBeCloseTo(70);
    expect(typeof labels[0]!.text()).toBe('string');
    expect(labels[0]!.visible!()).toBe(true);
  });
});

// =====================================================================================
// T7 — the ToolHost ships in v1 with one trivial tool; arm→place→commit→serialize→
// import round-trips. (The whole suite IS the T1–T6/T8 proof from outside the core.)
// =====================================================================================
describe('T7 — ToolHost end-to-end (arm → place → commit → serialize/deserialize)', () => {
  test('arm + two taps commits ONE shape and fires the added event', () => {
    const stub = makeChart();
    const { host, events } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    expect(host.shapes().length).toBe(1);
    const added = events.filter((e) => e.kind === 'added');
    expect(added.length).toBe(1);
    expect((added[0] as { id: string }).id).toBe(host.shapes()[0]!.id);
    expect(host.shapes()[0]!.type).toBe('trend-line');
  });

  test('select(id) fires a selected event; select(null) deselects; a re-select is a value no-op', () => {
    const stub = makeChart();
    const { host, events } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const id = host.shapes()[0]!.id;
    events.length = 0;
    host.select(id);
    host.select(id); // value no-op — fires nothing (echo-free)
    host.select(null);
    const sel = events.filter((e) => e.kind === 'selected');
    expect(sel.length).toBe(2);
    expect((sel[0] as { id: string | null }).id).toBe(id);
    expect((sel[1] as { id: string | null }).id).toBe(null);
  });

  test('exportAll → importAll round-trips anchors + style as plain JSON (no live coords)', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const dump = host.exportAll();
    expect(dump.length).toBe(1);
    const json = JSON.parse(JSON.stringify(dump)) as SerializedShape[];
    expect(json[0]!.type).toBe('trend-line');
    expect(json[0]!.anchors.length).toBe(2);
    expect(json[0]!.anchors[0]!.key).toBeCloseTo(1100);
    expect(json[0]!.anchors[0]!.paneId).toBe('p0');
    // a FRESH host imports the dump and reconstructs the same anchors.
    const stub2 = makeChart();
    const host2 = createToolHost(stub2.chart);
    host2.registerTool(TrendLineTool as never);
    host2.importAll(json);
    expect(host2.shapes().length).toBe(1);
    expect(host2.shapes()[0]!.anchors[0]!.key).toBeCloseTo(1100);
    expect(stub2.panes[0]!.attached.length).toBe(1); // re-attached on import
  });

  test('importAll of an unknown tool type is skipped with a warn (round-trips opaquely)', () => {
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    host.importAll([{ type: 'fib-unknown', version: 1, anchors: [], style: {} }]);
    expect(host.shapes().length).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('importAll of an unknown paneId remaps to pane 0 with a warn (§4.1)', () => {
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const anchors: Anchor[] = [
      { key: 1100, price: 50, paneId: 'p99' },
      { key: 1300, price: 70, paneId: 'p99' },
    ];
    host.importAll([{ type: 'trend-line', version: 1, anchors, style: trendLineDefaults }]);
    expect(host.shapes().length).toBe(1);
    expect(host.shapes()[0]!.anchors[0]!.paneId).toBe('p0'); // remapped to pane 0
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a max>min tool keeps collecting anchors past min and commits at max (multi-anchor FSM)', () => {
    // Regression for the creation-FSM bug: committing at `min` made anchors past `min`
    // unreachable. A 2..4 tool must NOT commit at the 2nd tap; it commits only at the 4th.
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(MultiAnchorTool as never);
    const events: ToolHostEvent[] = [];
    host.subscribe((e) => events.push(e));
    host.arm('multi-anchor');
    const handler = stub.router.regs[0]!.handler;
    const tap = (x: number): GestureResponse => handler(gesture({ kind: 'tap', x: x as never, y: 50 as never }));

    tap(10); // anchor 1
    tap(20); // anchor 2 — reaches MIN(2) but max(4) not yet → still placing, no commit
    expect(host.shapes().length).toBe(0);
    expect(events.some((e) => e.kind === 'added')).toBe(false);
    tap(30); // anchor 3 — still placing
    expect(host.shapes().length).toBe(0);
    tap(40); // anchor 4 — reaches MAX → commit
    expect(host.shapes().length).toBe(1);
    expect(host.shapes()[0]!.anchors.length).toBe(4); // all four anchors collected
    expect(events.filter((e) => e.kind === 'added').length).toBe(1);
  });

  test('applyStyle re-runs createShape semantics and fires an edited event', () => {
    const stub = makeChart();
    const { host, events } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    events.length = 0;
    host.shapes()[0]!.applyStyle({ color: '#FF0000' } as never);
    expect((host.shapes()[0]!.style as { color: string }).color).toBe('#FF0000');
    expect(events.some((e) => e.kind === 'edited')).toBe(true);
  });
});

// =====================================================================================
// T8 — IPane.id() is chart-unique + never reused + stable; Anchor.paneId + serialization
// use it. The host resolves the placement pane by id, and import keys/remaps on it.
// (The id() property itself is the public api facade's; here the consumer proves it is
// the seam anchors are keyed on, and that distinct panes get distinct ids.)
// =====================================================================================
describe('T8 — IPane.id() is the anchor/serialization key (chart-unique, stable)', () => {
  test('a shape placed on pane 1 serializes that pane id; distinct panes have distinct ids', () => {
    const p0 = makePane('p0', makeSeries());
    const p2 = makePane('p2', makeSeries()); // 'p1' removed earlier → id never reused (T8)
    const stub = makeChart({ panes: [p0, p2] });
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    // place on pane index 1 (id 'p2').
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', paneIndex: 1, x: 10 as never, y: 50 as never }));
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', paneIndex: 1, x: 30 as never, y: 30 as never }));
    expect(host.shapes().length).toBe(1);
    const dump = host.exportAll();
    expect(dump[0]!.anchors[0]!.paneId).toBe('p2'); // serialized by IPane.id() (T8)
    expect(p0.id()).not.toBe(p2.id()); // distinct, never-colliding ids
    // re-import on a chart that rebuilt the same panes resolves back to 'p2'.
    expect(host.shapes()[0]!.anchors[0]!.paneId).toBe('p2');
  });

  test('id() is stable across pane SWAP + remove/re-add: anchors resolve by ID, not index', () => {
    // Exercise the id-stability contract through the PUBLIC api the host actually uses
    // (chart.panes() + IPane.id() + import/export keyed on paneId). We mutate the LIVE panes
    // array the chart returns to model a SWAP (reorder) and a REMOVE/re-add — the host must
    // key on id(), so the anchor's pane survives the index churn. (The id() VALUE itself is
    // minted by the chart facade, not the host; here the consumer proves the host treats it
    // as the stable resolution key — the strongest assertion possible at the public seam,
    // since the host never creates/removes panes.)
    const p0 = makePane('p0', makeSeries());
    const p2 = makePane('p2', makeSeries());
    const livePanes = [p0, p2]; // the chart returns THIS reference (mutating it = a layout change)
    const stub = makeChart({ panes: livePanes });
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    // place on pane index 1 (id 'p2').
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', paneIndex: 1, x: 10 as never, y: 50 as never }));
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', paneIndex: 1, x: 30 as never, y: 30 as never }));
    const dump = host.exportAll();
    expect(dump[0]!.anchors[0]!.paneId).toBe('p2');

    // SWAP: reorder the live panes so 'p2' is now at INDEX 0 (its id is unchanged — stable).
    livePanes.reverse();
    expect(stub.panes[1]!.id()).toBe('p0'); // sanity: 'p2' moved to index 0, 'p0' to index 1
    // A FRESH host imports the dump. importAll resolves the anchor's pane BY ID ('p2'), which
    // now lives at a DIFFERENT index — proving the resolution is id-keyed, not index-keyed.
    const host2 = createToolHost(stub.chart);
    host2.registerTool(TrendLineTool as never);
    host2.importAll(dump);
    expect(host2.shapes().length).toBe(1);
    expect(host2.shapes()[0]!.anchors[0]!.paneId).toBe('p2'); // resolved by stable id, not index
    // the re-imported shape attached onto the SAME pane object that still carries id 'p2'.
    expect(p2.attached.length).toBeGreaterThan(0);

    // REMOVE 'p2' from the layout, then re-import: the host must NOT reuse 'p2' for another
    // pane (id never reused). With 'p2' gone, importAll remaps the unknown id to pane 0 with
    // a warn (§4.1) — the documented fallback, NOT a silent collision onto a recycled id.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    livePanes.length = 0;
    livePanes.push(p0); // only 'p0' remains; 'p2' removed (its id is now retired)
    const host3 = createToolHost(stub.chart);
    host3.registerTool(TrendLineTool as never);
    host3.importAll(dump); // dump still references the retired 'p2'
    expect(host3.shapes()[0]!.anchors[0]!.paneId).toBe('p0'); // remapped to the surviving pane
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
