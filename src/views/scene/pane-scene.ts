// views/scene/pane-scene.ts — the one z-band scene registry (architecture §6).
//
// `PaneScene` is the `views`-side registry of the one-z-band scene model: one per
// pane surface (and a smaller-band variant per axis surface). It owns band
// membership, z-order within bands, per-source display-list caching, and
// `composite(layer): readonly DisplayList[]` — the "lists per band per layer" step.
// The host owns the `PaneScene ↔ SurfaceHost` pairing and calls `composite` →
// `ISurface.renderLayer` each paint. The model knows none of this.
//
// Per-source display-list caching is the granularity mechanism (perf §4.4.2,
// zero-tolerance): a Render frame asks each source for its lists; a CLEAN source
// returns the IDENTICAL cached array (the source caches; `displayLists()` is
// "CACHED until dirtied", §6), and `PaneScene` detects re-emission purely by array
// identity — a source whose returned array reference changed has re-emitted
// (counted in `sourcesReEmitted`). A clean source that returns a new array is the
// §4.4.2 violation; dev builds count it in `identityViolations`.
//
// Within a band, order = `(ownerZ, attachSeq)` — ownerZ is the owner's dense
// registration z-index, attachSeq the source's monotonic attach order (stable tie-
// break). Hovered-series-on-top is a COMPOSITION-TIME reorder of band `Series` only
// (study 01 §4.8): the hovered owner's `Series`-band sources sort last (drawn on
// top) without mutating registration order.
import { assert } from '../../core';
import type { IFrameCounters } from '../../core';
import { ZBand } from '../../gfx';
import type { DisplayList, LayerId, SceneSource, ViewFrame } from '../../gfx';

/** Per-registration metadata that drives within-band ordering + the hovered reorder. */
export interface SourceMeta {
  /** The owner's dense z-index within the band (series order, primitive z, …). */
  readonly ownerZ: number;
  /** Stable owner identity — the unit the hovered-on-top reorder lifts. Sources of
   *  the same series share one ownerId. */
  readonly ownerId: number;
}

interface Entry {
  readonly source: SceneSource;
  readonly ownerZ: number;
  readonly ownerId: number;
  readonly attachSeq: number; // monotonic, assigned at register()
  // Per-source cache: the array `displayLists()` last returned. Identity is the
  // re-emit signal (perf §4.4.2). `undefined` until first composited.
  cachedLists: readonly DisplayList[] | undefined;
}

const BASE_MAX = ZBand.Labels; // bands 0–5 render to base
const isBaseBand = (z: ZBand): boolean => z <= BASE_MAX;

/** Bands of the given layer (base = 0–5, overlay = 6–8). */
function bandInLayer(z: ZBand, layer: LayerId): boolean {
  return layer === 'base' ? isBaseBand(z) : !isBaseBand(z);
}

export class PaneScene {
  readonly #entries: Entry[] = [];
  #attachCounter = 0;
  #hoveredOwnerId: number | null = null;
  // Composition scratch, reused frame-to-frame (perf §5.1 A1): the flat output list
  // and the per-band ordering index. Grows by amortised doubling, never shrinks.
  #out: DisplayList[] = [];

  // --- dev / bench counters (perf §4.4.1/§4.4.2) ---------------------------------
  /** Sources whose `displayLists()` array reference changed in the last composite
   *  (= re-emitted). Overlay composites must count 0 base-band sources (§4.4.1). */
  sourcesReEmitted = 0;
  /** Zero-tolerance: a source that did NOT re-emit yet returned a different array
   *  than its cache (impossible if it caches correctly). Counted in dev only. */
  identityViolations = 0;
  // The shared per-frame accumulator (perf §9.6). Set by the host under __TV_PROFILE__;
  // composite() ++s the view lanes onto it so the host reads them at endFrame. Stays
  // undefined (and every ++ strips out) without the define.
  #counters: IFrameCounters | undefined;

  /** Wire the shared per-frame counters (perf §9.6; host-set, __TV_PROFILE__ only). */
  setCounters(counters: IFrameCounters): void {
    this.#counters = counters;
  }

  /** Register a scene source with its ordering metadata. Returns a handle (the
   *  entry index) callers keep for `unregister`. Attach order is recorded as the
   *  monotonic `attachSeq` tie-break. */
  register(source: SceneSource, meta: SourceMeta): number {
    const entry: Entry = {
      source,
      ownerZ: meta.ownerZ,
      ownerId: meta.ownerId,
      attachSeq: this.#attachCounter++,
      cachedLists: undefined,
    };
    this.#entries.push(entry);
    return entry.attachSeq;
  }

  /** Remove a previously registered source (by identity). No-op if absent. */
  unregister(source: SceneSource): void {
    const i = this.#entries.findIndex((e) => e.source === source);
    if (i >= 0) this.#entries.splice(i, 1);
  }

  /** Number of registered sources. */
  size(): number {
    return this.#entries.length;
  }

  /** Set (or clear) the hovered owner; only its `Series`-band sources are lifted on
   *  top at composite time. Clearing restores pure `(ownerZ, attachSeq)` order. */
  setHoveredOwner(ownerId: number | null): void {
    this.#hoveredOwnerId = ownerId;
  }

  hoveredOwner(): number | null {
    return this.#hoveredOwnerId;
  }

  /**
   * Make every source in `layer` valid for this frame, then composite their cached
   * display lists in `(band, ownerZ, attachSeq)` order — with the hovered owner's
   * `Series`-band sources lifted on top. Returns a flat, ordered `readonly
   * DisplayList[]` the host hands to `ISurface.renderLayer`.
   *
   * A clean source's individual `DisplayList` objects are reused BY REFERENCE (the
   * source returned its identical cached array). The returned composite array is a
   * reused scratch buffer (valid until the next composite of either layer).
   */
  composite(layer: LayerId, frame: ViewFrame): readonly DisplayList[] {
    this.sourcesReEmitted = 0;
    this.#out.length = 0;

    const order = this.#orderedEntries(layer);
    for (let k = 0; k < order.length; k++) {
      const e = order[k]!;
      e.source.update(frame); // make-valid; cheap when not dirty
      const lists = e.source.displayLists();
      // Re-emit detection by ARRAY IDENTITY (perf §4.4.2). A changed reference means
      // the source rebuilt its lists this frame (first emit included); an unchanged
      // reference is a clean source whose cached array we reuse verbatim.
      const reEmitted = lists !== e.cachedLists;
      if (reEmitted) {
        this.sourcesReEmitted++;
        e.cachedLists = lists;
      }
      // perf §9.6 view lanes: a dirty re-emit bumps sourcesReEmitted; a clean source
      // returning its cached array bumps sourcesCached; both contribute their lists +
      // commands to displayLists/drawCommands. Strips out without the define.
      if (__TV_PROFILE__ && this.#counters !== undefined) {
        const c = this.#counters;
        if (reEmitted) c.sourcesReEmitted++;
        else c.sourcesCached++;
        c.displayLists += lists.length;
        for (let j = 0; j < lists.length; j++) c.drawCommands += lists[j]!.commands.length;
      }
      for (let j = 0; j < lists.length; j++) this.#out.push(lists[j]!);
    }
    return this.#out;
  }

  /** The composite order for a layer, applying the hovered-on-top `Series` reorder.
   *  Returns a freshly built, ordered array of entries (setup-cheap; the per-frame
   *  hot path is `composite`, which sorts the small in-layer slice). */
  #orderedEntries(layer: LayerId): Entry[] {
    const inLayer: Entry[] = [];
    for (let i = 0; i < this.#entries.length; i++) {
      const e = this.#entries[i]!;
      if (bandInLayer(e.source.zBand, layer)) inLayer.push(e);
    }
    const hovered = this.#hoveredOwnerId;
    inLayer.sort((a, b) => compareEntries(a, b, hovered));
    return inLayer;
  }

  /** The cached lists last returned by a source — test/inspection hook (the §4.4.2
   *  identity that a clean source must preserve). `undefined` before first composite. */
  cachedListsOf(source: SceneSource): readonly DisplayList[] | undefined {
    const e = this.#entries.find((x) => x.source === source);
    return e?.cachedLists;
  }

  /** Verify the §4.4.2 zero-tolerance invariant against a snapshot: for each source
   *  the caller believes is clean, assert its current cache is the SAME reference as
   *  `before` recorded. Dev counter `identityViolations` is bumped on a mismatch. */
  assertCleanIdentity(source: SceneSource, before: readonly DisplayList[] | undefined): boolean {
    const now = this.cachedListsOf(source);
    const ok = now === before;
    if (!ok) {
      this.identityViolations++;
      if (__TV_PROFILE__ && this.#counters !== undefined) this.#counters.cachedListIdentityViolations++;
      if (__DEV__) assert(ok, 'clean source returned a non-identical display-list array (perf §4.4.2)');
    }
    return ok;
  }
}

/** `(ownerZ, attachSeq)` comparator with the hovered-on-top `Series` reorder. The
 *  hovered owner's `Series`-band sources sort AFTER all others (drawn last/on top);
 *  the reorder applies to band `Series` only (study 01 §4.8). Internal — the
 *  ordering is observable through `composite`'s output. */
function compareEntries(a: Entry, b: Entry, hoveredOwnerId: number | null): number {
  // Primary: band index. The hovered lift is band-LOCAL — it must never float a
  // Series source above the AboveSeries/Labels bands (§6: "reorder of band Series").
  if (a.source.zBand !== b.source.zBand) return a.source.zBand - b.source.zBand;
  // Within the Series band only, the hovered owner's sources sort last (on top).
  if (hoveredOwnerId !== null && a.source.zBand === ZBand.Series) {
    const aLift = a.ownerId === hoveredOwnerId;
    const bLift = b.ownerId === hoveredOwnerId;
    if (aLift !== bLift) return aLift ? 1 : -1;
  }
  // Then ownerZ; then attachSeq (stable tie-break).
  if (a.ownerZ !== b.ownerZ) return a.ownerZ - b.ownerZ;
  return a.attachSeq - b.attachSeq;
}
