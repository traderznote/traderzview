import { describe, expect, test, vi } from 'vitest';
import { registerDefaultBehaviors, type DefaultBehaviorPorts } from './behaviors';
import { InteractionRouter } from './router';
import type { Coordinate } from '../../core';
import type { GestureEvent, GestureKind, GesturePhase, SurfaceKind } from './types';

function ports(): DefaultBehaviorPorts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pan: (dx) => calls.push(`pan(${dx})`),
    zoom: (s, x) => calls.push(`zoom(${s},${x})`),
    resetPane: (i) => calls.push(`resetPane(${i})`),
    priceAxisDrag: (i, dy, ax) => calls.push(`priceAxisDrag(${i},${dy},${ax})`),
    priceScroll: (i, dy) => calls.push(`priceScroll(${i},${dy})`),
    clearHover: () => calls.push('clearHover'),
  };
}

type EvOver = Partial<Omit<GestureEvent, 'x' | 'y'>> & { x?: number; y?: number };
function ev(kind: GestureKind, phase: GesturePhase, over: EvOver = {}): GestureEvent {
  const surface: SurfaceKind = over.surface ?? 'pane';
  return {
    kind, phase, surface,
    paneIndex: over.paneIndex ?? 0,
    x: (over.x ?? 0) as Coordinate, y: (over.y ?? 0) as Coordinate,
    startX: 0 as Coordinate, startY: 0 as Coordinate,
    deltaX: over.deltaX ?? 0, deltaY: over.deltaY ?? 0,
    wheelDeltaX: over.wheelDeltaX, wheelDeltaY: over.wheelDeltaY,
    pointerType: 'mouse',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    ...(over.axis !== undefined ? { axis: over.axis } : {}),
  };
}

describe('registerDefaultBehaviors — gesture→intent mapping (architecture §9.1)', () => {
  test('pane drag: start clears hover + claims; move pans by deltaX AND price-scrolls by deltaY', () => {
    const router = new InteractionRouter();
    const p = ports();
    registerDefaultBehaviors(router, p);
    router.dispatch(ev('drag', 'start', { paneIndex: 0 }));
    router.dispatch(ev('drag', 'move', { deltaX: 12, deltaY: -8, paneIndex: 0 }));
    expect(p.calls).toEqual(['clearHover', 'pan(12)', 'priceScroll(0,-8)']);
  });

  test('pane wheel: vertical zoom step → zoom; horizontal → pan', () => {
    const router = new InteractionRouter();
    const p = ports();
    registerDefaultBehaviors(router, p);
    router.dispatch(ev('wheel', 'fire', { wheelDeltaY: 1, x: 50 }));
    router.dispatch(ev('wheel', 'fire', { wheelDeltaX: -80 }));
    expect(p.calls).toEqual(['zoom(1,50)', 'pan(-80)']);
  });

  test('pane wheel diagonal: vertical zoom AND horizontal scroll both apply (not either/or)', () => {
    const router = new InteractionRouter();
    const p = ports();
    registerDefaultBehaviors(router, p);
    router.dispatch(ev('wheel', 'fire', { wheelDeltaY: 1, wheelDeltaX: -80, x: 50 }));
    expect(p.calls).toEqual(['zoom(1,50)', 'pan(-80)']); // both legs, one event
  });

  test('double-tap on a pane resets that pane', () => {
    const router = new InteractionRouter();
    const p = ports();
    registerDefaultBehaviors(router, p);
    router.dispatch(ev('double-tap', 'fire', { paneIndex: 1 }));
    expect(p.calls).toEqual(['resetPane(1)']);
  });

  test('price-axis drag scales the price navigator via the port', () => {
    const router = new InteractionRouter();
    const p = ports();
    registerDefaultBehaviors(router, p);
    router.dispatch(ev('drag', 'start', { surface: 'price-axis', axis: 'right' }));
    router.dispatch(ev('drag', 'move', { surface: 'price-axis', axis: 'right', deltaY: 7 }));
    expect(p.calls).toEqual(['priceAxisDrag(0,7,right)']);
  });

  test('gates: handleScroll:false drops pan, handleScale:false drops zoom + axis drag', () => {
    const router = new InteractionRouter();
    const p = ports();
    registerDefaultBehaviors(router, p, { handleScroll: false, handleScale: false });
    router.dispatch(ev('drag', 'start')); // no pan registration ⇒ dropped, no claim
    router.dispatch(ev('drag', 'move', { deltaX: 5 }));
    router.dispatch(ev('wheel', 'fire', { wheelDeltaY: 1 }));
    expect(p.calls).toEqual([]); // double-tap still works but none fired here
  });

  test('the all-removing Unsubscribe unregisters every behavior', () => {
    const router = new InteractionRouter();
    const p = ports();
    const off = registerDefaultBehaviors(router, p);
    off();
    router.dispatch(ev('double-tap', 'fire'));
    expect(p.calls).toEqual([]);
  });
});
