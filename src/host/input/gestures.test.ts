import { describe, expect, test } from 'vitest';
import {
  GestureMachine,
  KineticTracker,
  KINETIC,
  GESTURE_THRESHOLDS,
  type GesturePointer,
  type SurfaceTarget,
} from './gestures';
import type { GestureEvent } from './types';

// ---------------------------------------------------------------------------
// Headless harness: a fake monotonic clock the machine reads, a synthetic
// PointerEvent-like factory, and a sink that records emitted GestureEvents.
// No DOM, no real timers, no rAF — the test drives time explicitly.
// ---------------------------------------------------------------------------

const PANE: SurfaceTarget = { surface: 'pane', paneIndex: 0 };

function harness(target: SurfaceTarget = PANE) {
  let now = 0;
  const events: GestureEvent[] = [];
  const m = new GestureMachine(target, () => now, (e) => events.push({ ...e }));
  return {
    m,
    events,
    at(t: number) {
      now = t;
    },
    advance(dt: number) {
      now += dt;
    },
    get now() {
      return now;
    },
  };
}

const ptr = (p: Partial<GesturePointer>): GesturePointer => ({
  pointerId: 1,
  clientX: 0,
  clientY: 0,
  buttons: 1,
  pointerType: 'mouse',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...p,
});

const kinds = (events: GestureEvent[]) => events.map((e) => `${e.kind}:${e.phase}`);

// =================================================================================
// Named constants (study 07 §3.3 / §4.11; architecture §7)
// =================================================================================

describe('gesture constants (study 07 §3.3 / §4.11)', () => {
  test('thresholds are the tuned 5/5/5/30 px + 240/500 ms values', () => {
    expect(GESTURE_THRESHOLDS.dragSlopPx).toBe(5);
    expect(GESTURE_THRESHOLDS.cancelTapPx).toBe(5);
    expect(GESTURE_THRESHOLDS.doubleClickPx).toBe(5);
    expect(GESTURE_THRESHOLDS.doubleTapPx).toBe(30);
    expect(GESTURE_THRESHOLDS.longPressMs).toBe(240);
    expect(GESTURE_THRESHOLDS.doubleTapWindowMs).toBe(500);
  });

  test('kinetic constants are 0.2 / 7 / 0.997 / 15 / 50 / ε=1', () => {
    expect(KINETIC.minSpeed).toBe(0.2);
    expect(KINETIC.maxSpeed).toBe(7);
    expect(KINETIC.dumping).toBe(0.997);
    expect(KINETIC.minMovePx).toBe(15);
    expect(KINETIC.maxStartDelayMs).toBe(50);
    expect(KINETIC.epsilon).toBe(1);
  });
});

// =================================================================================
// Tap vs drag arbitration — the 5 px drag slop (study 07 §4.1 / §4.4)
// =================================================================================

describe('GestureMachine drag slop = 5 px (study 07 §4.1)', () => {
  test('press + tiny move (< 5 px manhattan) + release = a tap, no drag', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 100, clientY: 100 }));
    h.m.pointerMove(ptr({ clientX: 102, clientY: 102 })); // manhattan 4 < 5: suppressed
    h.m.pointerUp(ptr({ clientX: 102, clientY: 102 }));
    expect(kinds(h.events)).toEqual(['tap:fire']);
  });

  test('manhattan exactly 5 px crosses the slop → drag starts (>= boundary)', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 100, clientY: 100 }));
    h.m.pointerMove(ptr({ clientX: 103, clientY: 102 })); // |3|+|2| = 5 → drag
    h.m.pointerMove(ptr({ clientX: 110, clientY: 100 }));
    h.m.pointerUp(ptr({ clientX: 110, clientY: 100 }));
    expect(kinds(h.events)).toEqual(['drag:start', 'drag:move', 'drag:end']);
    // no tap fires once the press became a drag
    expect(h.events.some((e) => e.kind === 'tap')).toBe(false);
  });

  test('drag:start anchors startX/startY at the down point; deltas are 0 at start', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 100, clientY: 100 }));
    h.m.pointerMove(ptr({ clientX: 110, clientY: 100 }));
    const start = h.events.find((e) => e.kind === 'drag' && e.phase === 'start')!;
    expect(start.startX).toBe(100);
    expect(start.deltaX).toBe(0);
    expect(start.deltaY).toBe(0);
  });

  test('drag:move deltas are relative to the PREVIOUS event of the stream', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 100, clientY: 100 }));
    h.m.pointerMove(ptr({ clientX: 110, clientY: 100 })); // start (x=110)
    h.m.pointerMove(ptr({ clientX: 130, clientY: 105 })); // move
    const move = h.events.find((e) => e.kind === 'drag' && e.phase === 'move')!;
    expect(move.deltaX).toBe(20); // 130 - 110
    expect(move.deltaY).toBe(5); // 105 - 100
  });
});

// =================================================================================
// Long-press = 240 ms hold within 5 px (study 07 §4.2)
// =================================================================================

describe('GestureMachine long-press = 240 ms (study 07 §4.2)', () => {
  test('a 240 ms hold within slop fires long-press; tap is then cancelled', () => {
    const h = harness({ surface: 'pane', paneIndex: 0 });
    h.m.pointerDown(ptr({ clientX: 50, clientY: 50, pointerType: 'touch' }));
    h.advance(240);
    h.m.tick(); // the host pumps the clock; the machine fires the due long-press
    expect(kinds(h.events)).toContain('long-press:start');
    h.m.pointerUp(ptr({ clientX: 50, clientY: 50, pointerType: 'touch' }));
    // long-press cancels the tap (study 07 §4.2: "long-tap also cancels the tap")
    expect(h.events.some((e) => e.kind === 'tap')).toBe(false);
  });

  test('just under 240 ms then release = a tap (long-press did not arm yet)', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 50, clientY: 50, pointerType: 'touch' }));
    h.advance(239);
    h.m.tick();
    h.m.pointerUp(ptr({ clientX: 50, clientY: 50, pointerType: 'touch' }));
    expect(h.events.some((e) => e.kind === 'long-press')).toBe(false);
    expect(kinds(h.events)).toContain('tap:fire');
  });

  test('movement past 5 px before 240 ms kills the long-press timer (becomes a drag)', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 50, clientY: 50, pointerType: 'touch' }));
    h.advance(100);
    h.m.pointerMove(ptr({ clientX: 60, clientY: 50, pointerType: 'touch' })); // 10 px → drag
    h.advance(200); // well past 240 ms total
    h.m.tick();
    expect(h.events.some((e) => e.kind === 'long-press')).toBe(false);
    expect(kinds(h.events)).toContain('drag:start');
  });
});

// =================================================================================
// Tap / double-tap windows (study 07 §4.1 mouse 5 px, §4.2 touch 30 px, 500 ms)
// =================================================================================

describe('GestureMachine double-tap (study 07 §4.1/§4.2)', () => {
  test('two mouse clicks within 500 ms and within 5 px = tap then double-tap', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 10, clientY: 10 }));
    h.m.pointerUp(ptr({ clientX: 10, clientY: 10 })); // tap (first up)
    h.advance(100);
    h.m.pointerDown(ptr({ clientX: 12, clientY: 11 }));
    h.m.pointerUp(ptr({ clientX: 12, clientY: 11 })); // |2|+|1| = 3 < 5 → double-tap
    expect(kinds(h.events)).toEqual(['tap:fire', 'double-tap:fire']);
  });

  test('far second click within the window is swallowed — no double-tap, no second tap (study 07 §4.1)', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 10, clientY: 10 }));
    h.m.pointerUp(ptr({ clientX: 10, clientY: 10 }));
    h.advance(100);
    h.m.pointerDown(ptr({ clientX: 18, clientY: 10 })); // 8 px > 5 → not a double-click
    h.m.pointerUp(ptr({ clientX: 18, clientY: 10 }));
    // §4.1: the 2nd up is in the window with clickCount>1 → enters the double branch,
    // fails proximity, and just RESETS the window. No second 'tap' is emitted.
    expect(kinds(h.events)).toEqual(['tap:fire']);
  });

  test('touch uses the wider 30 px proximity: 20 px apart still double-taps', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 10, clientY: 10, pointerType: 'touch' }));
    h.m.pointerUp(ptr({ clientX: 10, clientY: 10, pointerType: 'touch' }));
    h.advance(100);
    h.m.pointerDown(ptr({ clientX: 30, clientY: 10, pointerType: 'touch' })); // 20 px < 30
    h.m.pointerUp(ptr({ clientX: 30, clientY: 10, pointerType: 'touch' }));
    expect(kinds(h.events)).toEqual(['tap:fire', 'double-tap:fire']);
  });

  test('touch 35 px apart exceeds the 30 px proximity → far second up swallowed (study 07 §4.1)', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 10, clientY: 10, pointerType: 'touch' }));
    h.m.pointerUp(ptr({ clientX: 10, clientY: 10, pointerType: 'touch' }));
    h.advance(100);
    h.m.pointerDown(ptr({ clientX: 45, clientY: 10, pointerType: 'touch' })); // 35 > 30
    h.m.pointerUp(ptr({ clientX: 45, clientY: 10, pointerType: 'touch' }));
    expect(kinds(h.events)).toEqual(['tap:fire']);
  });

  test('the 500 ms window starts at the first down — a slow second tap is two taps', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 10, clientY: 10 }));
    h.m.pointerUp(ptr({ clientX: 10, clientY: 10 }));
    h.advance(600); // window started at first down → elapsed > 500
    h.m.tick();
    h.m.pointerDown(ptr({ clientX: 10, clientY: 10 }));
    h.m.pointerUp(ptr({ clientX: 10, clientY: 10 }));
    expect(kinds(h.events)).toEqual(['tap:fire', 'tap:fire']);
  });
});

// =================================================================================
// Hover — move with no buttons down (study 07; §13.5 'hover' discrete)
// =================================================================================

describe('GestureMachine hover (no buttons down)', () => {
  test('a move with buttons === 0 emits a discrete hover:fire', () => {
    const h = harness();
    h.m.pointerMove(ptr({ clientX: 40, clientY: 40, buttons: 0 }));
    expect(kinds(h.events)).toEqual(['hover:fire']);
    expect(h.events[0]!.x).toBe(40);
  });

  test('a move while pressed is NOT a hover (it is a pending press / drag move)', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 40, clientY: 40 }));
    h.m.pointerMove(ptr({ clientX: 41, clientY: 40, buttons: 1 })); // < 5 px, pressed
    expect(h.events.some((e) => e.kind === 'hover')).toBe(false);
  });
});

// =================================================================================
// Pinch — two touch pointers (study 07 §4.4)
// =================================================================================

describe('GestureMachine pinch (study 07 §4.4)', () => {
  test('a second touch before any move starts a pinch; scale = dist/startDist', () => {
    const h = harness();
    h.m.pointerDown(ptr({ pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' }));
    h.m.pointerDown(ptr({ pointerId: 2, clientX: 100, clientY: 0, pointerType: 'touch' }));
    expect(kinds(h.events)).toContain('pinch:start');
    // move pointer 2 to x=200 → distance 200, startDistance 100 → scale 2.
    h.m.pointerMove(ptr({ pointerId: 2, clientX: 200, clientY: 0, pointerType: 'touch' }));
    const move = h.events.find((e) => e.kind === 'pinch' && e.phase === 'move')!;
    expect(move.pinchScale).toBeCloseTo(2, 10);
  });

  test('lifting one finger ends the pinch', () => {
    const h = harness();
    h.m.pointerDown(ptr({ pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' }));
    h.m.pointerDown(ptr({ pointerId: 2, clientX: 100, clientY: 0, pointerType: 'touch' }));
    h.m.pointerUp(ptr({ pointerId: 2, clientX: 100, clientY: 0, pointerType: 'touch' }));
    expect(kinds(h.events)).toContain('pinch:end');
  });

  test('a move before the 2nd finger forbids pinch (pinchPrevented; §4.2)', () => {
    const h = harness();
    h.m.pointerDown(ptr({ pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' }));
    h.m.pointerMove(ptr({ pointerId: 1, clientX: 20, clientY: 0, pointerType: 'touch' })); // drag
    h.m.pointerDown(ptr({ pointerId: 2, clientX: 100, clientY: 0, pointerType: 'touch' }));
    expect(h.events.some((e) => e.kind === 'pinch')).toBe(false);
  });
});

// =================================================================================
// Tracking mode (study 07 §4.13) — long-press on a touch pane → relative crosshair
// =================================================================================

describe('GestureMachine tracking mode (study 07 §4.13)', () => {
  test('long-press on a touch pane enters tracking; moves are relative to the anchor', () => {
    const h = harness({ surface: 'pane', paneIndex: 0 });
    h.m.pointerDown(ptr({ clientX: 50, clientY: 60, pointerType: 'touch' }));
    h.advance(240);
    h.m.tick(); // long-press fires → Tracking
    expect(kinds(h.events)).toContain('long-press:start');
    // a move while tracking emits long-press:move with deltas from the press point
    h.m.pointerMove(ptr({ clientX: 70, clientY: 90, pointerType: 'touch' }));
    const move = h.events.find((e) => e.kind === 'long-press' && e.phase === 'move')!;
    expect(move.deltaX).toBe(20); // 70 - 50
    expect(move.deltaY).toBe(30); // 90 - 60
  });

  test('OnTouchEnd exit mode: lifting the finger ends tracking with long-press:end', () => {
    const h = harness({ surface: 'pane', paneIndex: 0 });
    h.m.setTrackingExitMode('OnTouchEnd');
    h.m.pointerDown(ptr({ clientX: 50, clientY: 60, pointerType: 'touch' }));
    h.advance(240);
    h.m.tick();
    h.m.pointerMove(ptr({ clientX: 70, clientY: 90, pointerType: 'touch' }));
    h.m.pointerUp(ptr({ clientX: 70, clientY: 90, pointerType: 'touch' }));
    expect(kinds(h.events)).toContain('long-press:end');
  });

  test('OnNextTap exit mode (default): tracking survives the lift, exits on next tap', () => {
    const h = harness({ surface: 'pane', paneIndex: 0 });
    h.m.pointerDown(ptr({ clientX: 50, clientY: 60, pointerType: 'touch' }));
    h.advance(240);
    h.m.tick();
    h.m.pointerUp(ptr({ clientX: 50, clientY: 60, pointerType: 'touch' })); // no end yet
    expect(h.events.some((e) => e.kind === 'long-press' && e.phase === 'end')).toBe(false);
    // next tap (down+up, no move) exits tracking
    h.m.pointerDown(ptr({ clientX: 50, clientY: 60, pointerType: 'touch' }));
    h.m.pointerUp(ptr({ clientX: 50, clientY: 60, pointerType: 'touch' }));
    expect(h.events.some((e) => e.kind === 'long-press' && e.phase === 'end')).toBe(true);
  });
});

// =================================================================================
// Cancel
// =================================================================================

describe('GestureMachine cancel', () => {
  test('pointerCancel during a drag emits drag:cancel, not drag:end', () => {
    const h = harness();
    h.m.pointerDown(ptr({ clientX: 0, clientY: 0 }));
    h.m.pointerMove(ptr({ clientX: 20, clientY: 0 })); // drag:start
    h.m.pointerCancel(ptr({ clientX: 20, clientY: 0 }));
    expect(kinds(h.events)).toEqual(['drag:start', 'drag:cancel']);
  });
});

// =================================================================================
// KineticTracker (study 07 §4.11) — pixel-space sampling, weighted velocity, decay
// =================================================================================

describe('KineticTracker (study 07 §4.11)', () => {
  test('sub-minMove (< 15 px) samples are dropped → fewer than 2 → no fling', () => {
    const k = new KineticTracker();
    k.addPosition(0, 0);
    k.addPosition(10, 10); // 10 < 15 → ignored
    k.addPosition(20, 20); // |20-0| = 20 ≥ 15 → kept (newest = 0)
    const fling = k.start(20, 20);
    // two samples now (0@0, 20@20): a fling IS possible — verify the boundary the
    // other way: a single < 15 step yields only one sample, hence no fling.
    const k2 = new KineticTracker();
    k2.addPosition(0, 0);
    k2.addPosition(10, 10);
    expect(k2.start(10, 10)).toBeNull();
    expect(fling).not.toBeNull();
  });

  test('release later than 50 ms after the newest sample = no fling', () => {
    const k = new KineticTracker();
    k.addPosition(0, 0);
    k.addPosition(20, 10);
    k.addPosition(40, 20);
    expect(k.start(40, 71)).toBeNull(); // 71 - 20 = 51 > 50
    // …and exactly at the 50 ms boundary it still flings
    const k2 = new KineticTracker();
    k2.addPosition(0, 0);
    k2.addPosition(20, 10);
    k2.addPosition(40, 20);
    expect(k2.start(40, 70)).not.toBeNull(); // 70 - 20 = 50 ≤ 50
  });

  test('distance-weighted velocity of a constant 2 px/ms drag is exactly 2', () => {
    const k = new KineticTracker();
    // positions 0,20,40,60 at t=0,10,20,30 → each segment 20/10 = 2 px/ms.
    k.addPosition(0, 0);
    k.addPosition(20, 10);
    k.addPosition(40, 20);
    k.addPosition(60, 30);
    const f = k.start(60, 30)!;
    expect(f).not.toBeNull();
    expect(f.velocity).toBeCloseTo(2, 10);
  });

  test('|v0| below minSpeed (0.2 px/ms) produces no fling', () => {
    const k = new KineticTracker();
    // 16 px over 200 ms = 0.08 px/ms < 0.2 (but ≥ minMove so it is sampled).
    k.addPosition(0, 0);
    k.addPosition(16, 200);
    expect(k.start(16, 200)).toBeNull();
  });

  test('maxSpeed clamps a segment to 7 px/ms', () => {
    const k = new KineticTracker();
    // 100 px over 5 ms = 20 px/ms → clamped to 7.
    k.addPosition(0, 0);
    k.addPosition(100, 5);
    const f = k.start(100, 5)!;
    expect(f.velocity).toBeCloseTo(7, 10);
  });

  test('closed-form position + finished match the exact §4.11 decay integral', () => {
    const k = new KineticTracker();
    k.addPosition(0, 0);
    k.addPosition(20, 10);
    k.addPosition(40, 20);
    k.addPosition(60, 30);
    const f = k.start(60, 30)!;
    const D = 0.997;
    const lnD = Math.log(D);
    const v0 = 2;
    // position(t) = startPos + v0 * (D^(t-t0) - 1) / lnD ; startPos=60, t0=30.
    const expectAt = (elapsed: number) => 60 + (v0 * (Math.pow(D, elapsed) - 1)) / lnD;
    expect(f.positionAt(30)).toBeCloseTo(60, 9); // elapsed 0
    expect(f.positionAt(130)).toBeCloseTo(expectAt(100), 6);
    expect(f.positionAt(230)).toBeCloseTo(expectAt(200), 6);
    // duration = ln((ε * lnD) / -|v0|) / lnD ; ε = 1.
    const expectedDuration = Math.log((1 * lnD) / -Math.abs(v0)) / lnD;
    expect(f.duration).toBeCloseTo(expectedDuration, 6);
    // finished is false before the duration, true at/after it (min-clamp equality).
    expect(f.finished(30 + expectedDuration - 1)).toBe(false);
    expect(f.finished(30 + expectedDuration)).toBe(true);
    expect(f.finished(30 + expectedDuration + 1000)).toBe(true);
  });

  test('a direction reversal truncates the velocity history at the reversal', () => {
    const k = new KineticTracker();
    // forward then backward: positions 0,20,40,20 — the last (40→20) reverses sign
    // relative to the most-recent forward segment. Newest-first the first segment
    // (20-40) is negative, so v0 follows the final (reversed) direction only.
    k.addPosition(0, 0);
    k.addPosition(20, 10);
    k.addPosition(40, 20);
    k.addPosition(20, 30); // reversal
    const f = k.start(20, 30)!;
    // newest segment speed = (20-40)/(30-20) = -2; the older same-sign run is just
    // this one segment (the next is +sign), so v0 = -2.
    expect(f.velocity).toBeCloseTo(-2, 10);
  });

  test('same-timestamp samples overwrite the newest position rather than append', () => {
    const k = new KineticTracker();
    k.addPosition(0, 0);
    k.addPosition(20, 10);
    k.addPosition(40, 10); // same t as previous newest → overwrite (now 40@10)
    k.addPosition(60, 20);
    const f = k.start(60, 20)!;
    // samples: 0@0, 40@10, 60@20. Segment (60-40)/(20-10)=2; (40-0)/(10-0)=4 clamped? 4≤7.
    // v0 = (20/60)*2 + (40/60)*4 = 0.6667 + 2.6667 = 3.3333.
    expect(f.velocity).toBeCloseTo(10 / 3, 9);
  });
});
