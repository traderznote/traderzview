// traderzview · host/input — gesture vocabulary + router contract (public-api
// §13.5; architecture §9.1). Declared HERE in host/input; the api layer re-exports
// these plain types from the package root. No DOM types leak: gestures consume
// PointerEvent-like plain objects, so this file is lib.dom-free and headless.

import type { Coordinate, Unsubscribe } from '../../core';

/** Interactive surface a gesture lands on (§13.5). 'time-axis' has paneIndex −1;
 *  'price-axis' additionally carries `axis` ('left' | 'right'). */
export type SurfaceKind = 'pane' | 'price-axis' | 'time-axis';

/** Recognized gesture families (§13.5). Discrete kinds emit ONE 'fire' event;
 *  streamed kinds emit 'start' ('move')* ('end' | 'cancel'). */
export type GestureKind =
  | 'tap'
  | 'double-tap'
  | 'wheel'
  | 'hover'
  | 'drag'
  | 'long-press'
  | 'pinch';

export type GesturePhase = 'fire' | 'start' | 'move' | 'end' | 'cancel';

export type PointerKind = 'mouse' | 'touch' | 'pen';

export interface GestureModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** A recognized gesture, emitted by the machine in surface-local media px (§13.5). */
export interface GestureEvent {
  kind: GestureKind;
  phase: GesturePhase;
  surface: SurfaceKind;
  paneIndex: number; // hosting pane; −1 for 'time-axis'
  axis?: 'left' | 'right'; // 'price-axis' surfaces only
  x: Coordinate;
  y: Coordinate;
  startX: Coordinate;
  startY: Coordinate; // === x/y on 'fire'/'start'
  deltaX: number; // since the previous event of this stream; 0 at start
  deltaY: number;
  wheelDeltaX?: number; // 'wheel' only; post-normalization units
  wheelDeltaY?: number;
  pinchScale?: number; // 'pinch' only; cumulative scale since 'start'
  pointerType: PointerKind;
  modifiers: GestureModifiers;
}

export type GestureResponse = 'claim' | 'pass';

export interface GestureRegistration {
  kinds: readonly GestureKind[];
  surfaces?: readonly SurfaceKind[]; // default ['pane']
  priority: number; // built-in behaviors sit at 0; tools register higher
  handler: (e: GestureEvent) => GestureResponse;
}

export interface IInteractionRouter {
  register(registration: GestureRegistration): Unsubscribe;
}
