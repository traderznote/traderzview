import { describe, expect, test, vi } from 'vitest';
import { attachDomInput, type DomInputTarget, type WheelIntent } from './dom-input';
import { GestureMachine, type GesturePointer } from './gestures';
import type { GestureEvent } from './types';

// A fake DOM target that records listeners and lets a test dispatch synthetic events,
// modelling the browser's addEventListener / setPointerCapture surface (§7).
function fakeTarget() {
  const listeners = new Map<string, (e: never) => void>();
  const captured: number[] = [];
  const released: number[] = [];
  const target: DomInputTarget = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    setPointerCapture(id) {
      captured.push(id);
    },
    releasePointerCapture(id) {
      released.push(id);
    },
  };
  const dispatch = (type: string, e: unknown): void => {
    const l = listeners.get(type);
    if (l !== undefined) (l as (e: unknown) => void)(e);
  };
  return { target, listeners, captured, released, dispatch };
}

// A machine bound to a pane that records the GestureEvents it emits.
function paneMachine(now: () => number = () => 0) {
  const events: GestureEvent[] = [];
  const machine = new GestureMachine({ surface: 'pane', paneIndex: 0 }, now, (e) => events.push(e));
  return { machine, events };
}

const pointer = (over: Partial<GesturePointer & { pointerType: string }> = {}) => ({
  pointerId: 1,
  clientX: 100,
  clientY: 80,
  buttons: 1,
  pointerType: 'mouse',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
});

describe('attachDomInput — DOM Pointer-Events → GestureMachine (architecture §7)', () => {
  test('attaches the six listeners and the unsubscribe removes them', () => {
    const { target, listeners } = fakeTarget();
    const { machine } = paneMachine();
    const off = attachDomInput(target, machine, () => {}, () => ({ left: 0, top: 0 }));
    expect([...listeners.keys()].sort()).toEqual(
      ['pointercancel', 'pointerdown', 'pointerleave', 'pointermove', 'pointerup', 'wheel'].sort(),
    );
    off();
    expect(listeners.size).toBe(0);
  });

  test('pointerleave fires the onLeave callback (host clears the crosshair, §5.5)', () => {
    const { target, dispatch } = fakeTarget();
    const { machine } = paneMachine();
    let left = 0;
    attachDomInput(target, machine, () => {}, () => ({ left: 0, top: 0 }), { onLeave: () => left++ });
    dispatch('pointerleave', {});
    expect(left).toBe(1);
  });

  test('pointerdown captures the pointer; pointerup/cancel release it', () => {
    const { target, captured, released, dispatch } = fakeTarget();
    const { machine } = paneMachine();
    attachDomInput(target, machine, () => {}, () => ({ left: 0, top: 0 }));
    dispatch('pointerdown', pointer({ pointerId: 7 }));
    expect(captured).toEqual([7]);
    dispatch('pointerup', pointer({ pointerId: 7, buttons: 0 }));
    expect(released).toEqual([7]);
  });

  test('coords are localized to the surface content origin before reaching the machine', () => {
    const { target, dispatch } = fakeTarget();
    const { machine, events } = paneMachine();
    // Origin (20,10): a client (100,80) becomes a surface-local (80,70).
    attachDomInput(target, machine, () => {}, () => ({ left: 20, top: 10 }));
    // A buttonless move with no prior down is a hover — it carries x/y straight through.
    dispatch('pointermove', pointer({ buttons: 0, clientX: 100, clientY: 80 }));
    const hover = events.find((e) => e.kind === 'hover');
    expect(hover).toBeDefined();
    expect(hover!.x).toBe(80);
    expect(hover!.y).toBe(70);
  });

  test('a down→move(past slop)→up drives a drag stream into the machine', () => {
    const { target, dispatch } = fakeTarget();
    const { machine, events } = paneMachine();
    attachDomInput(target, machine, () => {}, () => ({ left: 0, top: 0 }));
    dispatch('pointerdown', pointer({ clientX: 10, clientY: 10 }));
    dispatch('pointermove', pointer({ clientX: 40, clientY: 10 })); // 30px > 5px slop ⇒ drag start
    dispatch('pointermove', pointer({ clientX: 60, clientY: 10 })); // drag move
    dispatch('pointerup', pointer({ clientX: 60, clientY: 10, buttons: 0 }));
    const phases = events.filter((e) => e.kind === 'drag').map((e) => e.phase);
    expect(phases).toEqual(['start', 'move', 'end']);
    // The move delta is in surface-local px (60 − 40 = 20).
    const move = events.find((e) => e.kind === 'drag' && e.phase === 'move');
    expect(move!.deltaX).toBe(20);
  });

  test('wheel preventDefaults and feeds the wheel sink with localized + normalized intent', () => {
    const { target, dispatch } = fakeTarget();
    const { machine } = paneMachine();
    const sinks: WheelIntent[] = [];
    attachDomInput(target, machine, (i) => sinks.push(i), () => ({ left: 5, top: 5 }));
    const preventDefault = vi.fn();
    dispatch('wheel', {
      deltaMode: 0,
      deltaX: 0,
      deltaY: 100,
      clientX: 55,
      clientY: 45,
      ctrlKey: false,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(sinks).toHaveLength(1);
    expect(sinks[0]!.x).toBe(50); // 55 − 5
    expect(sinks[0]!.y).toBe(40); // 45 − 5
    // deltaY 100 normalizes to a −1 zoom step (natural-scroll sign); scroll 0.
    expect(sinks[0]!.zoom).toBe(-1);
    expect(sinks[0]!.scroll).toBe(0);
  });

  test('setPointerCapture throwing does not abort the gesture (stale-id guard)', () => {
    const { target, dispatch } = fakeTarget();
    const { machine, events } = paneMachine();
    target.setPointerCapture = () => {
      throw new Error('InvalidPointerId');
    };
    attachDomInput(target, machine, () => {}, () => ({ left: 0, top: 0 }));
    expect(() => dispatch('pointerdown', pointer())).not.toThrow();
    dispatch('pointermove', pointer({ clientX: 40 }));
    expect(events.some((e) => e.kind === 'drag' && e.phase === 'start')).toBe(true);
  });
});
