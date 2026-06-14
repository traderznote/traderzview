// traderzview · host — DOM host: surface tree, pure-function layout, pointer
// input + gesture router, frame scheduler. Receives IRenderBackend by injection.
// host MAY use DOM/lib.dom types; it NEVER imports a concrete backend (§3.1).
// See dev-docs/design/01-architecture.md §7. `export type` vs `export` split
// per verbatimModuleSyntax. Implemented across M8.

// --- frame scheduler: IFrameScheduler rAF loop + per-chart FrameLoop (§4.4) ------
export { createRafScheduler, FrameLoop } from './frame-scheduler';
export type { IFrameScheduler, FrameCallback, RafEnv, FrameDriver } from './frame-scheduler';

// --- pure Hi-DPI layout (design 01 §7 / study 10 §3.1) ---------------------------
export { computeLayout } from './layout';
export type { AxisWidths, LayoutRects, PaneRects } from './layout';

// --- gesture machine + kinetic tracker: pointer FSM → GestureEvents (study 07) ----
export { GestureMachine, KineticTracker, GESTURE_THRESHOLDS, KINETIC } from './input/gestures';
export type {
  GesturePointer,
  SurfaceTarget,
  GestureSink,
  Clock,
  TrackingExitMode,
  KineticFling,
} from './input/gestures';

// --- wheel normalization: WheelEvent-like → { scroll, zoom } (study 10 §4.4) ------
export { normalizeWheel, WHEEL_DELTA_PAGE, WHEEL_DELTA_LINE } from './input/wheel';
export type { WheelLike, NormalizedWheel } from './input/wheel';

// --- interaction router: priority registry + gesture dispatch (§9.1 / §13.5) -----
export { InteractionRouter } from './input/router';
export type {
  IInteractionRouter,
  GestureRegistration,
  GestureEvent,
  GestureResponse,
  GestureKind,
  GesturePhase,
  GestureModifiers,
  PointerKind,
  SurfaceKind,
} from './input/types';

// --- built-in pan/zoom/crosshair/axis-drag behaviors (§9.1 / §13.5 rule 4) --------
export { registerDefaultBehaviors } from './input/behaviors';
export type { DefaultBehaviorPorts, BehaviorGates } from './input/behaviors';

// --- the one surface widget: mount + injected ISurface + paint dispatch (§7) ------
export { SurfaceHost } from './surface-host';
export type { HostElement, SurfaceConfig, SurfaceFactory } from './surface-host';

// --- screenshot: single-pass tile collection → backend.composeSnapshot (§7) -------
export { captureScreenshot } from './screenshot';
export type { SnapshotComposer } from './screenshot';

// --- the root host: surface tree + frame loop + input + hover flow (§7 / §5.5) ----
export { ChartHost } from './chart-host';
export type {
  ChartHostDeps,
  ChartHostHooks,
  ElementFactory,
  HostBackend,
  MeasuredAxes,
  PaneSurfaceConfigs,
} from './chart-host';
