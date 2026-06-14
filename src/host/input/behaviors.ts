// traderzview · host/input/behaviors — the built-in pan / zoom / crosshair /
// axis-drag behaviors as ordinary PRIORITY-0 router registrations (architecture
// §9.1; public-api §13.5 rule 4 — "the seam cannot rot"). Each is a thin handler
// that CLAIMS its gesture and forwards a normalized INTENT to the host ports; the
// real geometry (px→bar, autoscale, axis drag) lives in the model navigators (§4.6),
// reached through the ports — behaviors stay free of DOM and of per-frame geometry.
// A drawing tool registering at higher priority makes the default yield automatically.
import type { Unsubscribe } from '../../core';
import type { GestureEvent, GestureResponse, IInteractionRouter } from './types';

/**
 * The host services the behaviors drive — one intent per gesture, no model/geometry
 * detail leaks here. The host implements these against the model navigators + its
 * frame loop, and tests pass recording fakes to assert the gesture→intent mapping.
 */
export interface DefaultBehaviorPorts {
  /** Pan the time scale by a media-px horizontal delta (drag move on a pane, §4.6). */
  pan(deltaXpx: number): void;
  /** Zoom the time scale by a ±-step around media x (wheel / time-axis drag, §13.5). */
  zoom(step: number, atX: number): void;
  /** Reset (fit time scale + autoscale) the pane at `paneIndex` (double-click, §10). */
  resetPane(paneIndex: number): void;
  /** Drag the price axis at `paneIndex` by a media-px vertical delta (axis scale, §4.6). */
  priceAxisDrag(paneIndex: number, deltaYpx: number, axis: 'left' | 'right'): void;
  /** Suppress the crosshair while a stream is active (a pan/drag hides hover). */
  clearHover(): void;
}

/** Options that GATE which behaviors register (handleScroll/handleScale, §13.5 rule 4).
 *  Absent ⇒ all enabled (the chart-options defaults). */
export interface BehaviorGates {
  readonly handleScroll?: boolean;
  readonly handleScale?: boolean;
}

/**
 * Register the four built-in behaviors at priority 0 and return one Unsubscribe that
 * removes them all (chart.dispose drops them; the router's own dispose also clears the
 * table). The host builds the GestureEvent (its `wheelDeltaX/Y` are post-normalization
 * units from normalizeWheel, study 10 §4.4); behaviors read those fields directly.
 */
export function registerDefaultBehaviors(
  router: IInteractionRouter,
  ports: DefaultBehaviorPorts,
  gates: BehaviorGates = {},
): Unsubscribe {
  const subs: Unsubscribe[] = [];
  const scroll = gates.handleScroll !== false;
  const scale = gates.handleScale !== false;

  // 1. PAN — drag on a pane scrolls the time scale; claims the stream + hides hover.
  if (scroll) {
    subs.push(router.register({ kinds: ['drag'], surfaces: ['pane'], priority: 0, handler: (e) => panHandler(e, ports) }));
  }

  // 2. ZOOM — wheel on a pane: vertical (incl. ctrl+vertical) zooms; horizontal pans.
  //    Discrete (one 'fire'); claims to consume.
  if (scale || scroll) {
    subs.push(router.register({ kinds: ['wheel'], surfaces: ['pane'], priority: 0, handler: (e) => wheelHandler(e, ports, scale, scroll) }));
  }

  // 3. RESET — double-tap / double-click on a pane resets autoscale on its pane (study
  //    01: a router action, not model state — architecture §10).
  subs.push(router.register({ kinds: ['double-tap'], surfaces: ['pane'], priority: 0, handler: (e) => resetHandler(e, ports) }));

  // 4. AXIS DRAG — price-axis drag scales that scale; time-axis drag zooms the time
  //    scale. Claims the stream so the crosshair does not also react.
  if (scale) {
    subs.push(router.register({ kinds: ['drag'], surfaces: ['price-axis', 'time-axis'], priority: 0, handler: (e) => axisDragHandler(e, ports) }));
  }

  return () => {
    for (const u of subs) u();
  };
}

// --- handlers ----------------------------------------------------------------------

function panHandler(e: GestureEvent, ports: DefaultBehaviorPorts): GestureResponse {
  if (e.phase === 'start') ports.clearHover();
  else if (e.phase === 'move') ports.pan(e.deltaX);
  return 'claim'; // hold the exclusive stream through end/cancel
}

function wheelHandler(e: GestureEvent, ports: DefaultBehaviorPorts, scale: boolean, scroll: boolean): GestureResponse {
  const zoom = e.wheelDeltaY ?? 0; // ±1-clamped zoom step (ctrl folded in by the host)
  const dx = e.wheelDeltaX ?? 0; // normalized horizontal scroll px
  // Apply BOTH legs of a diagonal wheel (trackpad): zoom AND scroll, not either/or.
  let acted = false;
  if (scale && zoom !== 0) {
    ports.zoom(zoom, e.x);
    acted = true;
  }
  if (scroll && dx !== 0) {
    ports.pan(dx);
    acted = true;
  }
  return acted ? 'claim' : 'pass';
}

function resetHandler(e: GestureEvent, ports: DefaultBehaviorPorts): GestureResponse {
  ports.resetPane(e.paneIndex);
  return 'claim';
}

function axisDragHandler(e: GestureEvent, ports: DefaultBehaviorPorts): GestureResponse {
  if (e.phase === 'start') return 'claim';
  if (e.phase !== 'move') return 'claim';
  if (e.surface === 'time-axis') ports.zoom(-e.deltaX * 0.01, e.x); // axis drag = zoom
  else ports.priceAxisDrag(e.paneIndex, e.deltaY, e.axis ?? 'right');
  return 'claim';
}
