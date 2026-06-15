// traderzview · host/input/dom-input — the §7 DOM Pointer-Events + capture ADAPTER.
// The single missing seam between the browser and the headless GestureMachine: it
// attaches 'pointerdown/move/up/cancel' + 'wheel' to one surface mount element,
// translates each DOM PointerEvent → the machine's `GesturePointer` in SURFACE-LOCAL
// media px (clientX/Y minus the surface's content origin — the same coordinate space
// the gesture/hover/geometry path expects), and routes 'wheel' through `normalizeWheel`
// to the host's wheel sink. On pointerdown it calls setPointerCapture so a drag keeps
// delivering moves after the pointer leaves the element (architecture §7 "Pointer
// Events + capture"). NO gesture/router/behavior logic here — purely the DOM→machine
// feed; the recognizer (gestures.ts) and dispatch (router.ts) are untouched.
//
// `host` MAY use DOM/lib.dom types (§3.1), so this file names PointerEvent/WheelEvent.
// The target is narrowed to `DomInputTarget` (the few members touched) so a headless
// test can pass a fake element that records listeners + dispatches synthetic events.
import type { Unsubscribe } from '../../core';
import type { GestureMachine, GesturePointer } from './gestures';
import { normalizeWheel } from './wheel';
import type { PointerKind } from './types';

/** The surface's content origin in client coords (its top-left in the viewport). The
 *  host supplies a getter that reads the mount's `getBoundingClientRect()` so the
 *  translation tracks scroll/resize without re-attaching listeners. */
export interface ContentOrigin {
  readonly left: number;
  readonly top: number;
}

/** A normalized wheel intent, already surface-local. The host turns this into a
 *  `wheel` GestureEvent and dispatches it through the router (the behaviors read
 *  `wheelDeltaX/Y` = `scroll/zoom`). `ctrlKey` is folded into the zoom leg by the
 *  normalizer's caller per §13.5 (ctrl+vertical is a zoom intent). */
export interface WheelIntent {
  readonly scroll: number; // normalized horizontal px (→ pan)
  readonly zoom: number; // ±1-clamped zoom step (→ zoom around x)
  readonly x: number; // surface-local media x the zoom anchors on
  readonly y: number; // surface-local media y
  readonly ctrlKey: boolean;
}

/** The few DOM members the adapter touches on a surface mount. `HTMLElement` satisfies
 *  it structurally; a headless test passes a fake that records handlers + dispatches. */
export interface DomInputTarget {
  addEventListener(type: string, listener: (e: never) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (e: never) => void, options?: unknown): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

/** The DOM PointerEvent fields the adapter reads (a structural subset, so a synthetic
 *  plain object is a valid input in tests). */
interface PointerEventLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  buttons: number;
  pointerType: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The DOM WheelEvent fields the adapter reads, plus the bits to localize + cancel. */
interface WheelEventLike {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  preventDefault(): void;
}

/** Map a DOM pointerType string to the machine's `PointerKind` (default mouse). */
function pointerKindOf(t: string): PointerKind {
  return t === 'touch' ? 'touch' : t === 'pen' ? 'pen' : 'mouse';
}

/** Wheel-speed multiplier + the Chromium-on-Windows PIXEL ÷DPR correction (§7 / the
 *  wheel normalizer). The host passes the live values; defaults keep tests simple. */
export interface DomInputConfig {
  readonly wheelSpeed?: number;
  readonly windowsChromium?: boolean;
  readonly getDpr?: () => number;
}

/**
 * Attach the §7 Pointer-Events + wheel listeners to `target` and feed `machine`
 * (pointer phases) + `wheelSink` (normalized wheel). Returns an Unsubscribe that
 * removes every listener (the host tears one down per surface in dispose()).
 *
 * Coordinate contract: the machine + hover + model geometry all work in surface-local
 * media px, so every clientX/Y is translated by `getContentOrigin()` here — the ONE
 * place the DOM→local shift happens (mirrors how the host feeds applyHover the
 * surface-local x/y).
 */
export function attachDomInput(
  target: DomInputTarget,
  machine: GestureMachine,
  wheelSink: (intent: WheelIntent) => void,
  getContentOrigin: () => ContentOrigin,
  config: DomInputConfig = {},
): Unsubscribe {
  const speed = config.wheelSpeed ?? 1;
  const winChromium = config.windowsChromium ?? false;
  const getDpr = config.getDpr ?? (() => 1);

  const toPointer = (e: PointerEventLike): GesturePointer => {
    const origin = getContentOrigin();
    return {
      pointerId: e.pointerId,
      clientX: e.clientX - origin.left,
      clientY: e.clientY - origin.top,
      buttons: e.buttons,
      pointerType: pointerKindOf(e.pointerType),
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    };
  };

  const onPointerDown = (e: PointerEventLike): void => {
    // Capture so a drag keeps delivering moves after the pointer leaves the surface
    // (architecture §7). Guarded: a fake target / a released id throws harmlessly.
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      /* setPointerCapture can throw for a stale id; the gesture still proceeds */
    }
    machine.pointerDown(toPointer(e));
  };
  const onPointerMove = (e: PointerEventLike): void => {
    machine.pointerMove(toPointer(e));
  };
  const onPointerUp = (e: PointerEventLike): void => {
    machine.pointerUp(toPointer(e));
    try {
      target.releasePointerCapture?.(e.pointerId);
    } catch {
      /* releasing a non-captured id throws; nothing to do */
    }
  };
  const onPointerCancel = (e: PointerEventLike): void => {
    machine.pointerCancel(toPointer(e));
    try {
      target.releasePointerCapture?.(e.pointerId);
    } catch {
      /* as above */
    }
  };
  const onWheel = (e: WheelEventLike): void => {
    // preventDefault so the page does not scroll / pinch-zoom under the chart (§7).
    e.preventDefault();
    const n = normalizeWheel(e, speed, winChromium, getDpr());
    const origin = getContentOrigin();
    wheelSink({
      scroll: n.scroll,
      zoom: n.zoom,
      x: e.clientX - origin.left,
      y: e.clientY - origin.top,
      ctrlKey: n.ctrlKey,
    });
  };

  // `passive:false` on wheel is what makes preventDefault honored (it is preventable).
  const wheelOpts = { passive: false };
  target.addEventListener('pointerdown', onPointerDown as (e: never) => void);
  target.addEventListener('pointermove', onPointerMove as (e: never) => void);
  target.addEventListener('pointerup', onPointerUp as (e: never) => void);
  target.addEventListener('pointercancel', onPointerCancel as (e: never) => void);
  target.addEventListener('wheel', onWheel as (e: never) => void, wheelOpts);

  return () => {
    target.removeEventListener('pointerdown', onPointerDown as (e: never) => void);
    target.removeEventListener('pointermove', onPointerMove as (e: never) => void);
    target.removeEventListener('pointerup', onPointerUp as (e: never) => void);
    target.removeEventListener('pointercancel', onPointerCancel as (e: never) => void);
    target.removeEventListener('wheel', onWheel as (e: never) => void, wheelOpts);
  };
}
