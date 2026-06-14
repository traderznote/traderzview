// views/scene/primitive-binding.ts — the one internal wrapper that registers a
// tagged `PrimitiveSource` into the right surface (architecture §6 / §9.1 slot 4).
//
// The reference exposed four parallel view getters (priceAxisViews / timeAxisViews
// / pricePaneViews(z) / timePaneViews(z), study 08 §2). traderzview collapses all
// four into ONE tagged registration: each `SceneSource` a primitive registers is
// paired with a target-surface tag (`'pane' | 'price-axis' | 'time-axis'`, plus an
// `axis: 'left' | 'right'` selector for pane-attached price-axis sources). The
// `attached()` context carries no single scene handle — a primitive may target
// several surfaces at once — so the binding resolves the destination surface from
// the source's own `target` tag, never inferred by the backend.
//
// Re-homing on `moveToPane` / `priceScaleId` change is AUTOMATIC and does NOT
// re-fire `attached` / `detached`: the binding just recomputes its `surfaceKey`
// from the owner's current pane + scale and hands the SAME wrapped source to the
// (possibly different) `PaneScene`. The lifecycle is host-driven and untouched here.
import { assert } from '../../core';
import type { SceneSource, ZBand } from '../../gfx';

/** The destination surfaces a primitive source can be homed on (architecture §6:
 *  one pane scene + a left/right price-axis scene + the shared time-axis scene). */
export type SurfaceKind = 'pane' | 'price-axis-left' | 'price-axis-right' | 'time-axis';

/** A tagged primitive source as views sees it: the model's `PrimitiveSource` with
 *  its `source` narrowed from `unknown` to the gfx `SceneSource` (model may not
 *  name a gfx type, §3.1 — views does the narrowing). */
export interface TaggedPrimitiveSource {
  readonly target: 'pane' | 'price-axis' | 'time-axis';
  readonly axis?: 'left' | 'right';
  readonly source: SceneSource;
}

/** The owner placement the binding reads to resolve a price-axis target's surface.
 *  Series-attached price-axis sources follow the series' CURRENT scale and render
 *  NOWHERE while the series sits on an overlay scale (doc 02 targeting rule); a
 *  pane-attached source defaults to the right axis. */
export interface OwnerPlacement {
  /** The pane id the owner currently lives on (drives which `PaneScene` to home to,
   *  resolved by the host; the binding only needs the value to detect a change). */
  readonly paneId: string;
  /** The owner's price-scale id, or null when it is series-attached to an overlay
   *  scale (a price-axis target then resolves to no surface). */
  readonly priceScaleId: string | null;
  /** Which physical axis the owner's scale renders on (`left`/`right`), or null
   *  when it has no axis (overlay scale). */
  readonly axisSide: 'left' | 'right' | null;
}

/**
 * Wraps one tagged primitive source and resolves the surface it currently homes to.
 * Created once at `attached`-time; `rehome` recomputes the surface key in place when
 * the owner moves pane / changes scale — WITHOUT detaching or re-firing lifecycle.
 */
export class PrimitiveBinding {
  readonly tagged: TaggedPrimitiveSource;
  #placement: OwnerPlacement;
  #surfaceKey: SurfaceKind | null;

  constructor(tagged: TaggedPrimitiveSource, placement: OwnerPlacement) {
    this.tagged = tagged;
    this.#placement = placement;
    this.#surfaceKey = resolveSurface(tagged, placement);
  }

  /** The gfx scene source this binding contributes (registered into the resolved
   *  surface's `PaneScene`). Same object identity across re-homes. */
  source(): SceneSource {
    return this.tagged.source;
  }

  /** Its z-band within whichever surface it homes to. */
  zBand(): ZBand {
    return this.tagged.source.zBand;
  }

  /** The surface this source currently belongs to, or null when it renders nowhere
   *  (a series-attached price-axis source on an overlay scale). */
  surfaceKey(): SurfaceKind | null {
    return this.#surfaceKey;
  }

  /** Recompute the home surface from the owner's NEW placement. Returns the previous
   *  surface key (the host detaches the source from it and attaches to the new one;
   *  this is a re-home, not a primitive `detached`/`attached` cycle). A no-op return
   *  of the same key means the source stays put. */
  rehome(placement: OwnerPlacement): SurfaceKind | null {
    const prev = this.#surfaceKey;
    this.#placement = placement;
    this.#surfaceKey = resolveSurface(this.tagged, placement);
    return prev;
  }

  /** Whether the last `rehome` actually moved the source to a different surface. */
  movedFrom(prevKey: SurfaceKind | null): boolean {
    return prevKey !== this.#surfaceKey;
  }

  /** The placement currently in effect (for assertions / host bookkeeping). */
  placement(): OwnerPlacement {
    return this.#placement;
  }
}

/** Resolve which surface a tagged source homes to, per the doc 02 targeting rules.
 *  Pure; the binding caches the result and recomputes only on `rehome`. */
export function resolveSurface(tagged: TaggedPrimitiveSource, placement: OwnerPlacement): SurfaceKind | null {
  switch (tagged.target) {
    case 'pane':
      return 'pane';
    case 'time-axis':
      return 'time-axis';
    case 'price-axis': {
      // An explicit `axis` selector wins; otherwise follow the owner's current scale
      // side. A series-attached price-axis source on an overlay scale (no axis side)
      // renders nowhere.
      const side = tagged.axis ?? placement.axisSide;
      if (side === null || side === undefined) return null;
      if (__DEV__) assert(side === 'left' || side === 'right', "price-axis side must be 'left' or 'right'");
      return side === 'left' ? 'price-axis-left' : 'price-axis-right';
    }
  }
}
