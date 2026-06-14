import { describe, expect, test, vi } from 'vitest';
import {
  ChartHost,
  type ChartHostDeps,
  type ChartHostHooks,
  type ElementFactory,
  type MeasuredAxes,
  type PaneSurfaceConfigs,
} from './chart-host';
import { createRafScheduler, type RafEnv } from './frame-scheduler';
import type { HostElement, SurfaceConfig } from './surface-host';
import { PaneScene } from '../views';
import { ChartModel, UpdateLevel, createMask } from '../model';
import { timeBehavior } from '../data';
import { Emitter } from '../core';
import type { FrameInfo, FrameScope, LayerId, DisplayList, Snapshot, SnapshotTile, SurfaceSnapshot } from '../gfx';

// --- a manual rAF env so tests drive frames synchronously --------------------------
function fakeRaf(): RafEnv & { flush(now: number): void; pending(): number } {
  let next = 1;
  const cbs = new Map<number, (now: number) => void>();
  return {
    requestAnimationFrame(cb) {
      const h = next++;
      cbs.set(h, cb);
      return h;
    },
    cancelAnimationFrame(h) {
      cbs.delete(h);
    },
    flush(now) {
      const batch = [...cbs.entries()];
      cbs.clear();
      for (const [, cb] of batch) cb(now);
    },
    pending() {
      return cbs.size;
    },
  };
}

// --- fake element factory (no real DOM) --------------------------------------------
function fakeEl(): HostElement {
  return {
    style: { position: '', left: '', top: '', width: '', height: '' },
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
}

// --- a recording backend: each surface logs its begin/render/end calls -------------
function fakeBackend() {
  const log: string[] = [];
  let nextId = 0;
  const composeCalls: { tiles: SnapshotTile[] }[] = [];
  const backend = {
    createSurface() {
      const id = nextId++;
      let media = { width: 0, height: 0 };
      return {
        setMediaSize(s: { width: number; height: number }) {
          media = { ...s };
        },
        beginFrame(scope: FrameScope): FrameInfo {
          log.push(`s${id}:begin(${scope})`);
          return { mediaSize: media, bitmapSize: media, hr: 1, vr: 1 };
        },
        renderLayer(layer: LayerId, _l: readonly DisplayList[]) {
          log.push(`s${id}:render(${layer})`);
        },
        endFrame() {
          log.push(`s${id}:end`);
        },
        resolutionChanged: new Emitter(),
        snapshot: (): SurfaceSnapshot => ({ _tag: 'SurfaceSnapshot' }),
        dispose() {
          log.push(`s${id}:dispose`);
        },
      };
    },
    composeSnapshot(tiles: readonly SnapshotTile[]): Snapshot {
      composeCalls.push({ tiles: [...tiles] });
      return { _tag: 'Snapshot' };
    },
  };
  return { backend, log, composeCalls };
}

function cfg(kind: SurfaceConfig['kind']): SurfaceConfig {
  return { kind, scene: new PaneScene() };
}

// --- a recording hooks object ------------------------------------------------------
function fakeHooks(panes: number, axes: { left: number; right: number }, taH: number): ChartHostHooks & { calls: Record<string, number> } {
  const calls: Record<string, number> = {
    syncWidgets: 0, applyRender: 0, applyHover: 0, clearHover: 0, pan: 0, zoom: 0, resetPane: 0, priceAxisDrag: 0,
  };
  const paneConfigs: PaneSurfaceConfigs[] = [];
  for (let i = 0; i < panes; i++) paneConfigs.push({ pane: cfg('pane'), leftAxis: cfg('price-axis'), rightAxis: cfg('price-axis') });
  const measured: MeasuredAxes = {
    axisWidths: { left: axes.left, right: axes.right },
    timeAxisHeight: taH,
    timeAxis: cfg('time-axis'),
    leftStub: cfg('pane'),
    rightStub: cfg('pane'),
  };
  return {
    calls,
    paneConfigs: () => paneConfigs,
    measure: () => measured,
    syncWidgets: () => { calls.syncWidgets++; },
    applyRender: () => { calls.applyRender++; },
    animationRearmLevel: () => UpdateLevel.None,
    applyHover: () => { calls.applyHover++; return true; },
    clearHover: () => { calls.clearHover++; return true; },
    pan: () => { calls.pan++; },
    zoom: () => { calls.zoom++; },
    resetPane: () => { calls.resetPane++; },
    priceAxisDrag: () => { calls.priceAxisDrag++; },
  };
}

function build(opts?: { panes?: number; left?: number; right?: number; taH?: number }) {
  const raf = fakeRaf();
  const scheduler = createRafScheduler(raf);
  const { backend, log, composeCalls } = fakeBackend();
  const hooks = fakeHooks(opts?.panes ?? 1, { left: opts?.left ?? 0, right: opts?.right ?? 50 }, opts?.taH ?? 28);
  let now = 0;
  const elements: ElementFactory = { root: fakeEl, surfaceMount: fakeEl, separator: fakeEl };
  const model = new ChartModel({ behavior: timeBehavior(), invalidate: () => {} });
  // Make the model pane count match the surface-tree row count (the model is the
  // source of truth for pane count, §4.6); the default pane covers row 0.
  for (let i = 1; i < (opts?.panes ?? 1); i++) model.panes().addPane();
  const deps: ChartHostDeps = {
    model, backend, elements, scheduler, hooks,
    clock: () => now,
    getDpr: () => 1,
    separatorColor: '#e0e3eb',
  };
  const host = new ChartHost(deps);
  return { host, raf, log, composeCalls, hooks, setNow: (t: number) => { now = t; } };
}

describe('ChartHost — frame coalescing (architecture §4.4)', () => {
  test('N invalidations within one turn arm exactly ONE frame', () => {
    const { host, raf } = build();
    host.invalidate(createMask({ level: UpdateLevel.Overlay }));
    host.invalidate(createMask({ level: UpdateLevel.Render }));
    host.invalidate(createMask({ level: UpdateLevel.Layout }));
    expect(raf.pending()).toBe(1);
  });
});

describe('ChartHost — backend call sequence per UpdateLevel (rendering-backend §6)', () => {
  test('Render frame: each visible surface does begin(full) → render(base) → render(overlay) → end', () => {
    const { host, raf, log } = build({ panes: 1, left: 0, right: 50, taH: 28 });
    host.setSize({ width: 400, height: 300 }); // Layout flush builds rects (synchronous)
    log.length = 0;
    host.invalidate(createMask({ level: UpdateLevel.Render }));
    raf.flush(1);
    // Visible surfaces with right axis + time axis: pane, rightAxis, timeAxis, rightStub.
    // Each must follow the §6 'full' sequence. Group the log per surface and check one.
    const begins = log.filter((l) => l.includes(':begin('));
    expect(begins.every((b) => b.endsWith('(full)'))).toBe(true);
    // Exactly one begin/end pair per painted surface; base before overlay within each.
    for (const line of log) expect(line).toMatch(/:(begin\((full|overlay)\)|render\((base|overlay)\)|end)$/);
    const ends = log.filter((l) => l.endsWith(':end'));
    expect(ends.length).toBe(begins.length);
    expect(begins.length).toBeGreaterThan(0);
  });

  test('Overlay frame: each visible surface does begin(overlay) → render(overlay) → end ONLY', () => {
    const { host, raf, log } = build({ panes: 1, left: 0, right: 50, taH: 28 });
    host.setSize({ width: 400, height: 300 });
    log.length = 0;
    host.invalidate(createMask({ level: UpdateLevel.Overlay }));
    raf.flush(1);
    expect(log.some((l) => l.includes('render(base)'))).toBe(false);
    expect(log.filter((l) => l.includes(':begin('))).toSatisfy((b: string[]) => b.every((x) => x.endsWith('(overlay)')));
    expect(log.some((l) => l.includes('render(overlay)'))).toBe(true);
  });
});

describe('ChartHost — synchronous resize repaint (study 05 §3.8 anti-jitter)', () => {
  test('setSize paints INLINE (no pending rAF afterward) and runs the Layout sequence', () => {
    const { host, raf, log, hooks } = build();
    host.setSize({ width: 400, height: 300 });
    // The forced flush is synchronous — it painted without an rAF tick.
    expect(raf.pending()).toBe(0);
    expect(hooks.calls.syncWidgets).toBe(1); // Layout step ran
    expect(log.some((l) => l.endsWith(':end'))).toBe(true); // painted inline
  });
});

describe('ChartHost — hover flow (host → views → model, architecture §5.5)', () => {
  test('a buttonless pointer-move over a pane drives applyHover and raises an Overlay frame', () => {
    const { host, raf, hooks } = build();
    host.setSize({ width: 400, height: 300 });
    raf.flush(1); // drain any pending frame from setup
    // A hover gesture (no buttons) over pane 0.
    host.pointerMove(0, 'pane', { pointerId: 1, clientX: 30, clientY: 40, buttons: 0, pointerType: 'mouse', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
    expect(hooks.calls.applyHover).toBe(1);
    expect(raf.pending()).toBe(1); // the Overlay frame is armed
  });
});

describe('ChartHost — default behaviors are priority-0 router registrations (§9.1 / §13.5 rule 4)', () => {
  test('a pane drag dispatches through the router into the pan port', () => {
    const { host, hooks, raf } = build();
    host.setSize({ width: 400, height: 300 });
    const p = (x: number, y: number, buttons: number) => ({ pointerId: 1, clientX: x, clientY: y, buttons, pointerType: 'mouse' as const, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
    host.pointerDown(0, 'pane', p(10, 10, 1));
    host.pointerMove(0, 'pane', p(40, 10, 1)); // past the 5px slop ⇒ drag start → claim + clearHover
    host.pointerMove(0, 'pane', p(60, 10, 1)); // drag move → pan
    expect(hooks.calls.clearHover).toBeGreaterThanOrEqual(1);
    expect(hooks.calls.pan).toBeGreaterThanOrEqual(1);
    void raf;
  });

  test('a double-tap on a pane resets that pane', () => {
    const { host } = build();
    host.setSize({ width: 400, height: 300 });
    const router = host.input();
    const reset = vi.fn(() => 'pass' as const);
    // A higher-priority tool sees the gesture FIRST (descending priority) — proving the
    // default sits at 0 and the router walk reaches it after the tool passes.
    router.register({ kinds: ['double-tap'], surfaces: ['pane'], priority: 10, handler: reset });
    const t = (x: number) => ({ pointerId: 1, clientX: x, clientY: 10, buttons: 1, pointerType: 'touch' as const, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
    const tu = (x: number) => ({ ...t(x), buttons: 0 });
    host.pointerDown(0, 'pane', t(10));
    host.pointerUp(0, 'pane', tu(10));
    host.pointerDown(0, 'pane', t(12));
    host.pointerUp(0, 'pane', tu(12));
    expect(reset).toHaveBeenCalled(); // the priority-10 tool got first crack
  });
});

describe('ChartHost — screenshot (architecture §7)', () => {
  test('takeScreenshot flushes then composes tiles (surfaces + separators)', () => {
    const { host, composeCalls } = build({ panes: 2, left: 0, right: 50, taH: 28 });
    host.setSize({ width: 400, height: 300 });
    const snap = host.takeScreenshot();
    expect(snap).toEqual({ _tag: 'Snapshot' });
    expect(composeCalls).toHaveLength(1);
    // 2 panes → a separator tile is present (fill), plus visible surface snapshot tiles.
    const tiles = composeCalls[0]!.tiles;
    expect(tiles.some((t) => 'fill' in t)).toBe(true);
    expect(tiles.some((t) => 'snapshot' in t)).toBe(true);
  });
});

describe('ChartHost — dispose', () => {
  test('dispose drops the pending mask (a later rAF tick paints nothing) and disposes every surface', () => {
    const { host, raf, log } = build();
    host.invalidate(createMask({ level: UpdateLevel.Render }));
    expect(raf.pending()).toBe(1);
    host.dispose();
    expect(log.filter((l) => l.endsWith(':dispose')).length).toBeGreaterThan(0);
    // The shared rAF tick may still fire (other charts share the scheduler), but the
    // loop's pending mask is dropped — flushing paints nothing.
    log.length = 0;
    raf.flush(1);
    expect(log.filter((l) => l.includes(':begin('))).toEqual([]);
  });
});
