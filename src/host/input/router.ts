// traderzview · host/input — InteractionRouter (architecture §9.1; public-api
// §13.5 dispatch contract). A priority-ordered handler registry: a recognized
// gesture's first event ('fire'/'start') is offered in DESCENDING priority
// (ties most-recent-first); first 'claim' ends the walk; a claimed STREAM gets
// exclusive move/end/cancel; 'pass' continues; unregistering a mid-stream
// claimant delivers it a final 'cancel'. Built-ins register at priority 0.
// Gesture vocabulary + contract types live in ./types (the §13.5 seam).
import { assert } from '../../core';
import type { Unsubscribe } from '../../core';
import type {
  GestureEvent,
  GestureKind,
  GestureRegistration,
  IInteractionRouter,
  SurfaceKind,
} from './types';

// streamed kinds have the 'start' ('move')* ('end' | 'cancel') life-cycle; the
// discrete ones are a single 'fire'. The router only needs the streamed set to
// know which claims open an exclusive stream (§13.5 rule 2).
const STREAMED: ReadonlySet<GestureKind> = new Set<GestureKind>(['drag', 'long-press', 'pinch']);

const DEFAULT_SURFACES: readonly SurfaceKind[] = ['pane'];

// One registration plus its insertion order, so ties break most-recent-first.
interface Entry {
  reg: GestureRegistration;
  surfaces: readonly SurfaceKind[];
  seq: number; // monotonic; higher = more recent
  live: boolean; // flipped false on unregister (tombstone until the walk re-sorts)
}

/**
 * Dispatch (`InteractionRouter`) — the registry the host feeds recognized
 * gestures into and drawing tools register handlers on (architecture §9.1).
 * Headless: the host supplies plain `GestureEvent`s, so this needs no DOM.
 *
 * Exactly one streamed gesture is in flight at a time (the recognizer never
 * overlaps two streams of the same pointer set), so a single `#active`
 * claimant slot is sufficient to route a claimed stream's tail events.
 */
export class InteractionRouter implements IInteractionRouter {
  readonly #entries: Entry[] = [];
  #seq = 0;
  #active: Entry | null = null; // the claimant of the in-flight streamed gesture
  #activeEvent: GestureEvent | null = null; // its latest event (opening, then each move) — sourced for a synthetic cancel
  #disposed = false;

  register(registration: GestureRegistration): Unsubscribe {
    if (__DEV__) {
      assert(!this.#disposed, 'InteractionRouter.register after dispose (public-api §13.5)');
      assert(registration.kinds.length > 0, 'GestureRegistration.kinds must be non-empty');
    }
    const entry: Entry = {
      reg: registration,
      surfaces: registration.surfaces ?? DEFAULT_SURFACES,
      seq: this.#seq++,
      live: true,
    };
    this.#entries.push(entry);
    return () => this.#unregister(entry);
  }

  /**
   * Feed one recognized gesture event. The host calls this for every phase of
   * every gesture; the router routes it per the §13.5 contract.
   */
  dispatch(e: GestureEvent): void {
    if (this.#disposed) return;
    const opening = e.phase === 'fire' || e.phase === 'start';
    if (!opening) {
      this.#dispatchTail(e);
      return;
    }
    // 'fire'/'start': walk the table in descending priority (ties most-recent
    // first). First 'claim' ends the walk; claiming a streamed gesture opens an
    // exclusive stream (§13.5 rules 1–3).
    for (const entry of this.#ordered()) {
      if (!entry.live) continue; // a prior synchronous handler may have unregistered it mid-walk
      if (!this.#matches(entry, e)) continue;
      if (entry.reg.handler(e) === 'claim') {
        if (e.phase === 'start' && STREAMED.has(e.kind)) {
          this.#active = entry;
          this.#activeEvent = e; // remember the opening event for a later synthetic cancel
        }
        return;
      }
    }
    // Nothing claimed: the event is dropped (§13.5 rule 3).
  }

  /** chart.dispose(): cancel any in-flight stream and clear the table (§13.5 rule 5). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const active = this.#active;
    const open = this.#activeEvent;
    this.#active = null;
    this.#activeEvent = null;
    if (active !== null && active.live && open !== null) active.reg.handler(cancelOf(open));
    this.#entries.length = 0;
  }

  // 'move'/'end'/'cancel': delivered ONLY to the active claimant; no other
  // registration sees any part of a claimed stream (§13.5 rule 2). 'end'/'cancel'
  // close the stream. If nothing claimed the 'start', the tail is dropped.
  #dispatchTail(e: GestureEvent): void {
    const active = this.#active;
    if (active === null) return;
    this.#activeEvent = e; // track the latest position so a synthetic cancel carries real context
    if (active.live) active.reg.handler(e);
    if (e.phase === 'end' || e.phase === 'cancel') {
      this.#active = null;
      this.#activeEvent = null;
    }
  }

  // Descending priority; ties broken most-recent-registration-first (higher seq).
  // Re-sorted per opening event (registrations are few; this stays cheap and the
  // sort sees live entries only).
  #ordered(): Entry[] {
    const live = this.#entries.filter((x) => x.live);
    live.sort((a, b) => b.reg.priority - a.reg.priority || b.seq - a.seq);
    return live;
  }

  #matches(entry: Entry, e: GestureEvent): boolean {
    return entry.reg.kinds.includes(e.kind) && entry.surfaces.includes(e.surface);
  }

  // Unregistering a claimant mid-stream delivers it a final 'cancel' (§13.5 rule 5).
  #unregister(entry: Entry): void {
    if (!entry.live) return;
    entry.live = false;
    const i = this.#entries.indexOf(entry);
    if (i >= 0) this.#entries.splice(i, 1);
    if (this.#active === entry) {
      const open = this.#activeEvent;
      this.#active = null;
      this.#activeEvent = null;
      if (!this.#disposed && open !== null) entry.reg.handler(cancelOf(open));
    }
  }
}

// A synthetic 'cancel' to terminate a stream whose claimant is going away. Carries
// the actual stream context (kind/surface/paneIndex/position from the latest event)
// so the claimant releases state against the right target (§13.5 rule 5/6) — NOT a
// zeroed placeholder. deltaX/deltaY are zeroed (a cancel reports no further motion).
function cancelOf(latest: GestureEvent): GestureEvent {
  return { ...latest, phase: 'cancel', deltaX: 0, deltaY: 0 };
}
