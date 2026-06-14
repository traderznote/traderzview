import { describe, expect, test } from 'vitest';
import {
  FrameLoop,
  createRafScheduler,
  type FrameDriver,
  type IFrameScheduler,
  type RafEnv,
} from './frame-scheduler';
import { UpdateLevel, createMask, type UpdateMask } from '../model';
import { formatPaneId } from '../model';

// --- fakes (headless: no real rAF, no real clock, no DOM) ------------------------

// A manual rAF env: schedule() enqueues a callback; the test calls flush(now) to
// run exactly one tick (the cap-1 pending callback the chart holds). `now` is the
// shared timestamp the contract hands every callback in that tick.
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

interface Calls {
  syncWidgets: number;
  computeLayout: number;
  applySizes: number;
  applyRender: number;
  paint: UpdateLevel[]; // the level passed to each paint
  renderMasks: UpdateMask[]; // mask seen by each applyRender
}

// A recording driver. `onSync`/`onRender` hooks let a test re-enter the loop
// mid-frame (the re-entrant Layout case); `rearm` queues animation re-arm levels.
function fakeDriver(opts?: {
  onSync?: (c: Calls) => void;
  onRender?: (c: Calls) => void;
  rearm?: UpdateLevel[];
}): FrameDriver & { calls: Calls } {
  const calls: Calls = {
    syncWidgets: 0,
    computeLayout: 0,
    applySizes: 0,
    applyRender: 0,
    paint: [],
    renderMasks: [],
  };
  const rearmQueue = [...(opts?.rearm ?? [])];
  return {
    calls,
    syncWidgets() {
      calls.syncWidgets++;
      opts?.onSync?.(calls);
    },
    computeLayout() {
      calls.computeLayout++;
    },
    applySizes() {
      calls.applySizes++;
    },
    applyRender(mask) {
      calls.applyRender++;
      calls.renderMasks.push(mask);
      opts?.onRender?.(calls);
    },
    paint(level) {
      calls.paint.push(level);
    },
    animationRearmLevel() {
      return rearmQueue.length > 0 ? rearmQueue.shift()! : UpdateLevel.None;
    },
  };
}

const P0 = formatPaneId(0);
const overlay = () => createMask({ level: UpdateLevel.Overlay });
const render = () => createMask({ level: UpdateLevel.Render });
const layout = () => createMask({ level: UpdateLevel.Layout });

// =================================================================================
// IFrameScheduler contract (public-api §13.6)
// =================================================================================

describe('createRafScheduler (public-api §13.6)', () => {
  test('one tick services every callback scheduled before it, all with the same now', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const seen: number[] = [];
    s.schedule((n) => seen.push(n));
    s.schedule((n) => seen.push(n));
    s.schedule((n) => seen.push(n));
    expect(raf.pending()).toBe(1); // ONE underlying rAF for all three
    raf.flush(42);
    expect(seen).toEqual([42, 42, 42]); // same shared now, scheduling order
  });

  test('schedule during a tick lands in the NEXT tick', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const order: string[] = [];
    s.schedule(() => {
      order.push('a');
      s.schedule(() => order.push('b')); // re-entrant — must defer
    });
    raf.flush(1);
    expect(order).toEqual(['a']); // b did NOT run this tick
    raf.flush(2);
    expect(order).toEqual(['a', 'b']);
  });

  test('cancel before fire removes the callback; cancel after fire is a no-op', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const seen: string[] = [];
    const cancelA = s.schedule(() => seen.push('a'));
    s.schedule(() => seen.push('b'));
    cancelA();
    raf.flush(1);
    expect(seen).toEqual(['b']);
    expect(() => cancelA()).not.toThrow(); // post-fire/post-cancel cancel is a no-op
  });

  test('dispose cancels everything pending', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    let fired = false;
    s.schedule(() => {
      fired = true;
    });
    expect(raf.pending()).toBe(1);
    s.dispose();
    expect(raf.pending()).toBe(0);
    raf.flush(1);
    expect(fired).toBe(false);
  });
});

// =================================================================================
// FrameLoop — the per-chart loop (architecture §4.4)
// =================================================================================

describe('FrameLoop coalescing (architecture §4.4)', () => {
  test('N invalidations in one turn coalesce to ONE frame', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const d = fakeDriver();
    const loop = new FrameLoop(s, d);

    loop.invalidate(overlay());
    loop.invalidate(render());
    loop.invalidate(layout());
    loop.invalidate(render());

    expect(loop.hasPendingFrame()).toBe(true);
    expect(raf.pending()).toBe(1); // exactly one rAF for all four invalidations

    raf.flush(100);

    // One painted frame, at the MAX level (Layout) the merged mask carries.
    expect(d.calls.paint).toEqual([UpdateLevel.Layout]);
    expect(d.calls.syncWidgets).toBe(1);
    expect(d.calls.applyRender).toBe(1);
    expect(loop.hasPendingFrame()).toBe(false);
  });

  test('None-level invalidations never arm a frame', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const d = fakeDriver();
    const loop = new FrameLoop(s, d);
    loop.invalidate(createMask({ level: UpdateLevel.None }));
    expect(loop.hasPendingFrame()).toBe(false);
    expect(raf.pending()).toBe(0);
  });

  test('UpdateLevel→backend call sequence: Overlay paints overlay-only, no layout/render', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const d = fakeDriver();
    const loop = new FrameLoop(s, d);
    loop.invalidate(overlay());
    raf.flush(7);
    expect(d.calls.paint).toEqual([UpdateLevel.Overlay]);
    expect(d.calls.syncWidgets).toBe(0); // no Layout work
    expect(d.calls.applyRender).toBe(0); // no Render work
  });

  test('Render runs autoscale/render but no layout sync', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const d = fakeDriver();
    const loop = new FrameLoop(s, d);
    loop.invalidate(createMask({ level: UpdateLevel.Render, autoscalePanes: new Set([P0]) }));
    raf.flush(7);
    expect(d.calls.syncWidgets).toBe(0);
    expect(d.calls.applyRender).toBe(1);
    expect(d.calls.renderMasks[0]!.autoscalePanes.has(P0)).toBe(true);
    expect(d.calls.paint).toEqual([UpdateLevel.Render]);
  });
});

describe('FrameLoop cap-2 layout-until-stable (architecture §4.4)', () => {
  test('a re-entrant Layout mid-frame merges + re-runs within the cap-2 loop', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    // First syncWidgets re-enters with a fresh Layout mask (axis width grew); the
    // cap-2 loop must merge it and re-run layout ONCE more in the SAME frame.
    let reentered = false;
    const d = fakeDriver({
      onSync(c) {
        if (!reentered) {
          reentered = true;
          loop.invalidate(layout());
          expect(c.syncWidgets).toBe(1); // we are inside the first iteration
        }
      },
    });
    const loop = new FrameLoop(s, d);

    loop.invalidate(layout());
    raf.flush(50);

    expect(d.calls.syncWidgets).toBe(2); // re-ran exactly once (cap 2)
    expect(d.calls.computeLayout).toBe(2);
    expect(d.calls.applySizes).toBe(2);
    expect(d.calls.paint).toEqual([UpdateLevel.Layout]); // still ONE paint
    expect(raf.pending()).toBe(0); // the re-entrant mask was drained, not spilled
    expect(loop.hasPendingFrame()).toBe(false);
  });

  test('the cap-2 loop terminates under unbounded re-entry — one bounded frame', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    // Re-enter on EVERY syncWidgets (layout never stabilises). The cap-2 loop must
    // bound the work at 2 iterations and paint ONCE — the final re-entry is merged
    // into the painted mask (architecture §4.4 pseudocode: "merge it; continue",
    // capped). No infinite loop, no leftover pending frame.
    const d = fakeDriver({
      onSync() {
        loop.invalidate(layout());
      },
    });
    const loop = new FrameLoop(s, d);

    loop.invalidate(layout());
    raf.flush(50);

    expect(d.calls.syncWidgets).toBe(2); // hard cap — bounded, not unbounded
    expect(d.calls.paint).toEqual([UpdateLevel.Layout]); // exactly one paint
    expect(loop.hasPendingFrame()).toBe(false); // final re-entry merged, not spilled
  });

  test('a re-entrant Render during a Layout frame is absorbed, not spilled', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    let once = false;
    const d = fakeDriver({
      onSync() {
        if (!once) {
          once = true;
          loop.invalidate(render()); // lower level — merges, level stays Layout
        }
      },
    });
    const loop = new FrameLoop(s, d);
    loop.invalidate(layout());
    raf.flush(9);
    expect(d.calls.syncWidgets).toBe(2); // the Render re-entry still re-runs the loop
    expect(d.calls.paint).toEqual([UpdateLevel.Layout]);
    expect(loop.hasPendingFrame()).toBe(false);
  });
});

describe('FrameLoop animation re-arm (architecture §4.4 — never promote)', () => {
  test('an Overlay ticket re-arms at Overlay only and NEVER promotes', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    // The pulse stays unfinished for 3 frames (re-arm Overlay×3), then finishes.
    const d = fakeDriver({
      rearm: [UpdateLevel.Overlay, UpdateLevel.Overlay, UpdateLevel.Overlay, UpdateLevel.None],
    });
    const loop = new FrameLoop(s, d);

    loop.invalidate(overlay());
    raf.flush(1);
    raf.flush(2);
    raf.flush(3);
    raf.flush(4); // animationRearmLevel returns None here → no further frame

    // Four Overlay frames, zero autoscale/render/layout work — the hard rule.
    expect(d.calls.paint).toEqual([
      UpdateLevel.Overlay,
      UpdateLevel.Overlay,
      UpdateLevel.Overlay,
      UpdateLevel.Overlay,
    ]);
    expect(d.calls.applyRender).toBe(0); // never promoted to Render/autoscale
    expect(d.calls.syncWidgets).toBe(0);
    expect(loop.hasPendingFrame()).toBe(false); // stops once finished
  });

  test('a horz animation re-arms at Render (geometry moved, base repaint required)', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const d = fakeDriver({ rearm: [UpdateLevel.Render, UpdateLevel.None] });
    const loop = new FrameLoop(s, d);
    loop.invalidate(render());
    raf.flush(1);
    expect(loop.hasPendingFrame()).toBe(true); // re-armed for the next animation frame
    raf.flush(2);
    expect(d.calls.paint).toEqual([UpdateLevel.Render, UpdateLevel.Render]);
    expect(d.calls.applyRender).toBe(2);
    expect(loop.hasPendingFrame()).toBe(false);
  });
});

describe('FrameLoop synchronous flush (architecture §4.4 / study 05 §3.8)', () => {
  test('a synchronous resize cancels the pending rAF and paints inline', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const d = fakeDriver();
    const loop = new FrameLoop(s, d);

    // A frame is already pending (e.g. a crosshair Overlay invalidation).
    loop.invalidate(overlay());
    expect(loop.hasPendingFrame()).toBe(true);

    // Forced resize inside the ResizeObserver callback: Layout, synchronous.
    loop.flushSync(layout(), 500);

    // Painted inline, at Layout, merging the pending Overlay — no rAF fired.
    expect(d.calls.paint).toEqual([UpdateLevel.Layout]);
    expect(d.calls.syncWidgets).toBe(1);
    expect(loop.hasPendingFrame()).toBe(false); // the chart's pending callback was cancelled

    // The cancelled callback must NOT double-paint when the underlying rAF fires.
    raf.flush(600);
    expect(d.calls.paint).toEqual([UpdateLevel.Layout]);
  });

  test('flushSync with no pending frame still paints inline at the given level', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const d = fakeDriver();
    const loop = new FrameLoop(s, d);
    loop.flushSync(layout(), 10);
    expect(d.calls.paint).toEqual([UpdateLevel.Layout]);
    expect(d.calls.syncWidgets).toBe(1);
  });
});

describe('FrameLoop dispose', () => {
  test('dispose cancels the pending rAF and drops the pending mask', () => {
    const raf = fakeRaf();
    const s = createRafScheduler(raf);
    const d = fakeDriver();
    const loop = new FrameLoop(s, d);
    loop.invalidate(render());
    loop.dispose();
    expect(loop.hasPendingFrame()).toBe(false); // the chart's callback was cancelled
    raf.flush(1);
    expect(d.calls.paint).toEqual([]); // never painted after dispose
    loop.invalidate(render()); // post-dispose invalidate is inert
    expect(loop.hasPendingFrame()).toBe(false);
  });
});
