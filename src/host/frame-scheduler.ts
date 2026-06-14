// traderzview · host — per-chart frame scheduler (architecture §4.4; public-api
// §13.6 IFrameScheduler; rendering-backend §6 call sequence; perf §4.4 invariants).
// A single pending UpdateMask, a single rAF (injected raf/clock so tests drive
// frames synchronously), the cap-2 layout-until-stable loop, paint per UpdateLevel,
// Overlay-ticket re-arm that never promotes, and a synchronous resize/screenshot
// flush. Owns no DOM and no concrete backend — the frame work is INJECTED via
// FrameDriver; the backend reaches it only through the driver.
import { assert, type Unsubscribe } from '../core';
import { UpdateLevel, type UpdateMask, createMask, emptyMask, mergeMasks } from '../model';

// ---------------------------------------------------------------------------
// IFrameScheduler (public-api §13.6) — the injectable rAF loop. One underlying
// tick services every callback scheduled before it, in scheduling order, all
// receiving the SAME `now`; a `schedule` issued DURING a tick lands in the NEXT
// tick (single-pending discipline relies on this). `dispose` cancels everything.
// ---------------------------------------------------------------------------

export type FrameCallback = (now: number) => void; // rAF-epoch milliseconds

export interface IFrameScheduler {
  /** Run cb once at the next frame tick. Returns a cancel; cancelling after fire is a no-op. */
  schedule(cb: FrameCallback): Unsubscribe;
  dispose(): void; // cancels everything pending
}

// The host injects these instead of touching the globals, so unit tests drive
// frames synchronously through a fake. Mirrors the rAF/cancelRAF pair.
export interface RafEnv {
  requestAnimationFrame(cb: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

/**
 * The default per-chart scheduler. Wraps one `requestAnimationFrame` and fans a
 * single tick out to every callback scheduled before it (so N charts sharing one
 * scheduler paint in one frame with one shared timestamp — architecture §9.3).
 * Callbacks scheduled while a tick is dispatching are held for the NEXT tick.
 */
export function createRafScheduler(env: RafEnv): IFrameScheduler {
  let queue: FrameCallback[] = [];
  let handle: number | null = null;
  let disposed = false;

  const tick = (now: number): void => {
    handle = null;
    // Snapshot: schedules issued during dispatch must land in the NEXT tick.
    const batch = queue;
    queue = [];
    for (let i = 0; i < batch.length; i++) batch[i]!(now);
  };

  const ensureFrame = (): void => {
    if (handle === null && !disposed) handle = env.requestAnimationFrame(tick);
  };

  return {
    schedule(cb: FrameCallback): Unsubscribe {
      if (__DEV__) assert(!disposed, 'IFrameScheduler.schedule after dispose (architecture §13.6)');
      queue.push(cb);
      ensureFrame();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        const i = queue.indexOf(cb);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    dispose(): void {
      disposed = true;
      queue = [];
      if (handle !== null) {
        env.cancelAnimationFrame(handle);
        handle = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// FrameDriver — the frame work the loop drives, INJECTED by the host so the
// scheduler is headless and testable. The host wires these to views (layout +
// scene paint), model (autoscale + horz-command replay + axis models) and the
// injected backend (rendering-backend §6 begin/render/end). Each Layout step
// MAY synchronously call back into FrameLoop.invalidate (e.g. an axis-width grow
// dirties layout again) — that re-entrant mask is what the cap-2 loop merges.
// ---------------------------------------------------------------------------

export interface FrameDriver {
  /** Layout step (architecture §4.4 / study 10 §3.1): reconcile widgets, run the
   * pure computeLayout, apply surface sizes. Run ONLY at level === Layout. */
  syncWidgets(): void;
  computeLayout(): void;
  applySizes(): void;
  /** Render step: momentary autoscale, replay the horz-command queue, refresh
   * axis models. Run at level >= Render. Receives the frame timestamp. */
  applyRender(mask: UpdateMask, now: number): void;
  /** Paint via the injected backend per the rendering-backend §6 call sequence
   * (Overlay → overlay layer only; Render/Layout → both layers). */
  paint(level: UpdateLevel, now: number): void;
  /** After paint, the level at which an unfinished animation needs the NEXT frame:
   * None when nothing is animating; Overlay for an Overlay ticket (last-price
   * pulse — must NEVER promote); Render for a horz scroll/zoom animation. */
  animationRearmLevel(now: number): UpdateLevel;
}

const LAYOUT_CAP = 2; // architecture §4.4 / study 05 IMPROVE: layout-until-stable cap.

// ---------------------------------------------------------------------------
// FrameLoop — the single-pending-mask, single-rAF per-chart loop (architecture
// §4.4). Invalidations within one event-loop turn coalesce into ONE frame.
// ---------------------------------------------------------------------------

export class FrameLoop {
  readonly #scheduler: IFrameScheduler;
  readonly #driver: FrameDriver;
  #pending: UpdateMask = emptyMask();
  #cancel: Unsubscribe | null = null; // the one pending scheduler callback
  #inFrame = false; // true while frame() runs — re-entrant masks coalesce, don't re-arm
  #disposed = false;

  constructor(scheduler: IFrameScheduler, driver: FrameDriver) {
    this.#scheduler = scheduler;
    this.#driver = driver;
  }

  /** Merge an UpdateMask into the single pending mask and arm one rAF if needed
   * (architecture §4.4: many invalidations per turn collapse into one frame). */
  invalidate(mask: UpdateMask): void {
    if (this.#disposed || mask.level === UpdateLevel.None) return;
    this.#pending = mergeMasks(this.#pending, mask);
    // A re-entrant invalidate during frame() must NOT arm a second callback; the
    // cap-2 loop drains it in the same frame, and the post-loop check re-arms once.
    if (!this.#inFrame) this.#arm();
  }

  /** True while exactly one frame is pending (for tests + the resize fast-path). */
  hasPendingFrame(): boolean {
    return this.#cancel !== null;
  }

  #arm(): void {
    if (this.#cancel !== null || this.#disposed) return; // never more than one pending
    this.#cancel = this.#scheduler.schedule((now) => {
      this.#cancel = null;
      this.#runFrame(now);
    });
  }

  /** The rAF-driven frame. Consumes the pending mask, runs the cap-2 layout loop,
   * paints, then re-arms only for an unfinished animation (architecture §4.4). */
  #runFrame(now: number): void {
    // Take + clear the pending mask; re-entrant invalidates during the loop refill
    // #pending and are merged back in by the cap-2 loop below.
    let work = this.#pending;
    this.#pending = emptyMask();
    if (work.level === UpdateLevel.None) return;

    this.#inFrame = true;
    try {
      for (let i = 0; i < LAYOUT_CAP; i++) {
        if (work.level === UpdateLevel.Layout) {
          this.#driver.syncWidgets();
          this.#driver.computeLayout();
          this.#driver.applySizes();
        }
        if (work.level >= UpdateLevel.Render) {
          this.#driver.applyRender(work, now);
        }
        // A mask that arrived during the steps above (e.g. axis width grew →
        // Layout) merges in and the loop re-runs — capped at 2 iterations.
        if (this.#pending.level === UpdateLevel.None) break;
        work = mergeMasks(work, this.#pending);
        this.#pending = emptyMask();
      }
      this.#driver.paint(work.level, now);
    } finally {
      this.#inFrame = false;
    }

    // Anything still pending after the cap-2 loop spills to the next frame.
    if (this.#pending.level !== UpdateLevel.None) {
      this.#arm();
      return;
    }
    // Re-arm for an unfinished animation. Overlay tickets re-arm at Overlay ONLY
    // (never promote to a Render/autoscale frame — architecture §4.4 hard rule);
    // horz animations re-arm at Render. Routed through invalidate() so the level
    // merges with any future ticket correctly.
    const rearm = this.#driver.animationRearmLevel(now);
    if (rearm !== UpdateLevel.None) this.invalidate(createMask({ level: rearm }));
  }

  /**
   * Synchronous flush (architecture §4.4 / study 05 §3.8): a forced resize inside
   * the ResizeObserver callback or a pre-screenshot flush CANCELS the pending rAF,
   * merges `mask` into the pending mask, and runs the frame INLINE (the anti-jitter
   * trick — no visible one-frame lag between container and canvas). The scheduler
   * is not involved; `now` is the synchronous clock reading the caller supplies.
   */
  flushSync(mask: UpdateMask, now: number): void {
    if (this.#disposed) return;
    if (this.#cancel !== null) {
      this.#cancel(); // cancel the pending rAF — we paint inline instead
      this.#cancel = null;
    }
    if (mask.level !== UpdateLevel.None) this.#pending = mergeMasks(this.#pending, mask);
    this.#runFrame(now);
  }

  /** Cancel the pending frame and drop the pending mask (chart.dispose path). */
  dispose(): void {
    this.#disposed = true;
    if (this.#cancel !== null) {
      this.#cancel();
      this.#cancel = null;
    }
    this.#pending = emptyMask();
  }
}
