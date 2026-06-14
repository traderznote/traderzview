import { describe, expect, test } from 'vitest';
import { InteractionRouter } from './router';
import type {
  GestureEvent,
  GestureKind,
  GesturePhase,
  GestureResponse,
  SurfaceKind,
} from './types';
import type { Coordinate } from '../../core';

// --- synthetic gestures (headless: plain objects, no DOM) ------------------------

function ev(
  kind: GestureKind,
  phase: GesturePhase,
  over: Partial<GestureEvent> = {},
): GestureEvent {
  const z = 0 as Coordinate;
  return {
    kind,
    phase,
    surface: 'pane' as SurfaceKind,
    paneIndex: 0,
    x: z,
    y: z,
    startX: z,
    startY: z,
    deltaX: 0,
    deltaY: 0,
    pointerType: 'mouse',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    ...over,
  };
}

// A handler that records every event it is offered and returns a fixed response.
function recorder(name: string, log: string[], response: GestureResponse) {
  return (e: GestureEvent): GestureResponse => {
    log.push(`${name}:${e.phase}`);
    return response;
  };
}

describe('InteractionRouter — §13.5 dispatch', () => {
  test('offers an opening event in DESCENDING priority order (rule 1)', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    // Registered low→high; the walk must visit high→low regardless of order.
    r.register({ kinds: ['tap'], priority: 0, handler: recorder('p0', log, 'pass') });
    r.register({ kinds: ['tap'], priority: 5, handler: recorder('p5', log, 'pass') });
    r.register({ kinds: ['tap'], priority: 2, handler: recorder('p2', log, 'pass') });

    r.dispatch(ev('tap', 'fire'));
    // All pass, so every handler is offered, in descending priority.
    expect(log).toEqual(['p5:fire', 'p2:fire', 'p0:fire']);
  });

  test('ties break most-recent-registration-first (rule 1)', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    r.register({ kinds: ['tap'], priority: 1, handler: recorder('first', log, 'pass') });
    r.register({ kinds: ['tap'], priority: 1, handler: recorder('second', log, 'pass') });

    r.dispatch(ev('tap', 'fire'));
    expect(log).toEqual(['second:fire', 'first:fire']);
  });

  test('first claim ends the walk (rule 1)', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    r.register({ kinds: ['tap'], priority: 9, handler: recorder('hi', log, 'pass') });
    r.register({ kinds: ['tap'], priority: 5, handler: recorder('mid', log, 'claim') });
    r.register({ kinds: ['tap'], priority: 1, handler: recorder('lo', log, 'pass') });

    r.dispatch(ev('tap', 'fire'));
    // hi passes, mid claims, lo is never offered.
    expect(log).toEqual(['hi:fire', 'mid:fire']);
  });

  test("'pass' continues to the next handler; nothing claims -> dropped (rule 3)", () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    r.register({ kinds: ['tap'], priority: 2, handler: recorder('a', log, 'pass') });
    r.register({ kinds: ['tap'], priority: 1, handler: recorder('b', log, 'pass') });

    r.dispatch(ev('tap', 'fire'));
    expect(log).toEqual(['a:fire', 'b:fire']); // both offered, event dropped

    // A tail with no active stream is silently dropped too.
    log.length = 0;
    r.dispatch(ev('drag', 'move'));
    expect(log).toEqual([]);
  });

  test('only matching kind + surface are offered', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    r.register({ kinds: ['drag'], priority: 1, handler: recorder('dragOnly', log, 'pass') });
    r.register({
      kinds: ['tap'],
      surfaces: ['price-axis'],
      priority: 1,
      handler: recorder('axisTap', log, 'pass'),
    });
    r.register({ kinds: ['tap'], priority: 1, handler: recorder('paneTap', log, 'pass') });

    r.dispatch(ev('tap', 'fire')); // pane tap
    // dragOnly: wrong kind. axisTap: wrong surface (default pane). paneTap matches.
    expect(log).toEqual(['paneTap:fire']);
  });

  test('claiming a streamed gesture grants EXCLUSIVE move/end, no leakage (rule 2)', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    r.register({ kinds: ['drag'], priority: 9, handler: recorder('observer', log, 'pass') });
    r.register({ kinds: ['drag'], priority: 0, handler: recorder('claimant', log, 'claim') });

    r.dispatch(ev('drag', 'start'));
    r.dispatch(ev('drag', 'move'));
    r.dispatch(ev('drag', 'end'));

    expect(log).toEqual(['observer:start', 'claimant:start', 'claimant:move', 'claimant:end']);

    // After 'end' the stream is closed: a fresh start re-walks the table.
    log.length = 0;
    r.dispatch(ev('drag', 'start'));
    expect(log).toEqual(['observer:start', 'claimant:start']);
  });

  test('a claimed DISCRETE gesture is merely consumed, opens no stream (rule 2)', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    r.register({ kinds: ['wheel'], priority: 0, handler: recorder('z', log, 'claim') });

    r.dispatch(ev('wheel', 'fire'));
    // A spurious tail with the same kind must NOT route anywhere (no open stream).
    r.dispatch(ev('wheel', 'move'));
    expect(log).toEqual(['z:fire']);
  });

  test('unregistering a mid-stream claimant delivers a final cancel (rule 5)', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    const off = r.register({ kinds: ['drag'], priority: 0, handler: recorder('tool', log, 'claim') });

    r.dispatch(ev('drag', 'start'));
    r.dispatch(ev('drag', 'move'));
    off(); // unregister mid-stream
    expect(log).toEqual(['tool:start', 'tool:move', 'tool:cancel']);

    // The cancel released the stream: a subsequent move (the now-dead handler)
    // is not delivered, and no error is thrown.
    log.length = 0;
    r.dispatch(ev('drag', 'move'));
    expect(log).toEqual([]);
  });

  test('the synthetic cancel carries real stream context (kind/surface/pane/latest position), not a zeroed placeholder', () => {
    const seen: GestureEvent[] = [];
    const r = new InteractionRouter();
    // kinds[0] is 'drag' but the live stream is a 'pinch' — the cancel must reflect the
    // STREAM, not the registration's first kind / first surface / zeroed coords.
    const off = r.register({
      kinds: ['drag', 'pinch'],
      surfaces: ['pane', 'price-axis'],
      priority: 0,
      handler: (e: GestureEvent): GestureResponse => {
        seen.push(e);
        return 'claim';
      },
    });
    r.dispatch(ev('pinch', 'start', { surface: 'price-axis', paneIndex: 2, x: 40 as Coordinate, y: 50 as Coordinate }));
    r.dispatch(ev('pinch', 'move', { surface: 'price-axis', paneIndex: 2, x: 44 as Coordinate, y: 58 as Coordinate }));
    off(); // unregister mid-stream → final synthetic cancel
    const cancel = seen[seen.length - 1]!;
    expect(cancel.phase).toBe('cancel');
    expect(cancel.kind).toBe('pinch'); // the stream's kind, NOT kinds[0] ('drag')
    expect(cancel.surface).toBe('price-axis'); // NOT surfaces[0] ('pane')
    expect(cancel.paneIndex).toBe(2); // NOT the old -1 placeholder
    expect(cancel.x).toBe(44); // latest move position, NOT 0
    expect(cancel.y).toBe(58);
    expect(cancel.deltaX).toBe(0); // a cancel reports no further motion
  });

  test('unregistering a NON-active handler delivers no cancel', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    const offIdle = r.register({ kinds: ['drag'], priority: 9, handler: recorder('idle', log, 'pass') });
    r.register({ kinds: ['drag'], priority: 0, handler: recorder('claimant', log, 'claim') });

    r.dispatch(ev('drag', 'start')); // idle passes, claimant claims
    log.length = 0;
    offIdle(); // idle was never the claimant -> no cancel
    expect(log).toEqual([]);
  });

  test('a priority-0 default is PREEMPTED by a higher-priority handler (rule 4)', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    // The built-in pan default at priority 0 (claims drags).
    r.register({ kinds: ['drag'], priority: 0, handler: recorder('pan-default', log, 'claim') });
    // A drawing tool registers higher while active and claims first.
    const offTool = r.register({ kinds: ['drag'], priority: 10, handler: recorder('tool', log, 'claim') });

    r.dispatch(ev('drag', 'start'));
    r.dispatch(ev('drag', 'move'));
    r.dispatch(ev('drag', 'end'));
    // Tool preempts: the default never sees the gesture.
    expect(log).toEqual(['tool:start', 'tool:move', 'tool:end']);

    // Tool deactivates (unregisters between streams); the default takes over again.
    log.length = 0;
    offTool();
    r.dispatch(ev('drag', 'start'));
    r.dispatch(ev('drag', 'end'));
    expect(log).toEqual(['pan-default:start', 'pan-default:end']);
  });

  test('dispose cancels the in-flight stream and clears the table (rule 5)', () => {
    const log: string[] = [];
    const r = new InteractionRouter();
    r.register({ kinds: ['drag'], priority: 0, handler: recorder('a', log, 'claim') });

    r.dispatch(ev('drag', 'start'));
    r.dispatch(ev('drag', 'move'));
    r.dispose();
    expect(log).toEqual(['a:start', 'a:move', 'a:cancel']);

    // After dispose the router is inert.
    log.length = 0;
    r.dispatch(ev('drag', 'start'));
    expect(log).toEqual([]);
  });
});
