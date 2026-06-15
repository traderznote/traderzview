// traderzview · api — event payloads + the subscription machinery the handle
// facades expose (spec 02 §14). Every payload is built LAZILY behind
// `hasListeners()` (§14.1 — crosshair-move at 60 Hz demands it): the hub never
// allocates a `MouseEventParams` when no one is listening. `seriesData` is keyed
// by the USER's series handles with whitespace rows excluded (§14.2); `HoverInfo.
// kind` is derived from `HoverTarget.sourceId` ownership — series / price-line /
// primitive, never 'marker' (§14.2). The public `StoreDiff` is the internal diff
// with its `TimeIndex` slots re-branded to `Logical` (§14.3 / §4.1).
import { Emitter } from '../core';
import type { Coordinate, Logical, TimeIndex, Unsubscribe } from '../core';
import type { HoverTarget } from '../model';
import type { StoreDiff as InternalStoreDiff } from '../data';

// --- §14.2 payload shapes ----------------------------------------------------------
// The series-handle type `S` is a parameter (the facade layer owns `ISeries`); api
// foundation ships before the facade, so payloads stay handle-agnostic. The facade
// instantiates `S = ISeries<SeriesType, H>` and `Item = DataItemFor<SeriesType, H>`.

/** The structured hovered-source record (§14.2). `kind` is the ONE discriminator —
 *  the reference's `type`/`sourceKind`/`objectKind` triple collapses to this, and
 *  there is deliberately no `'marker'` value (markers are an `extras` primitive and
 *  report `'primitive'` + their marker id as `externalId`). */
export interface HoverInfo<S = unknown> {
  readonly kind: 'series' | 'price-line' | 'primitive';
  /** The owning series handle when applicable (series / series-attached price-line). */
  readonly series?: S;
  /** `HitCandidate.externalId` for a primitive, or the price-line id. */
  readonly externalId?: string;
  readonly paneIndex: number;
}

/** Sanitized pointer data — no native event leaks (§14.2). All coords media px;
 *  every field readonly so the payload cannot be mutated by a handler. */
export interface PointerEventData {
  readonly clientX: Coordinate;
  readonly clientY: Coordinate;
  readonly pageX: Coordinate;
  readonly pageY: Coordinate;
  readonly screenX: Coordinate;
  readonly screenY: Coordinate;
  readonly localX: Coordinate;
  readonly localY: Coordinate;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly pointerType: 'mouse' | 'touch' | 'pen';
}

/** The click / dblClick / crosshairMove payload (§14.2). `time` is the user's
 *  original value (undefined outside data); `logical` undefined off-scale; `point`
 *  undefined outside the chart (e.g. on leave). `seriesData` is keyed by the user's
 *  series handles with whitespace excluded. */
export interface MouseEventParams<H = unknown, S = unknown, Item = unknown> {
  readonly time?: H;
  readonly logical?: Logical;
  readonly point?: { x: Coordinate; y: Coordinate };
  readonly paneIndex?: number;
  readonly seriesData: Map<S, Item>;
  readonly hoveredInfo?: HoverInfo<S>;
  readonly sourceEvent?: PointerEventData;
}

/** A chart mouse-event handler (§7 / §14). */
export type MouseEventHandler<H = unknown, S = unknown, Item = unknown> = (
  param: MouseEventParams<H, S, Item>,
) => void;

// --- §14.2 seriesData: keyed by user handles, whitespace excluded ------------------

/** One series' contribution to `seriesData`: the user's handle and the public data
 *  item at the hovered slot, or `null` when that slot is WHITESPACE (no value/OHLC).
 *  Whitespace rows never enter the map (§14.2 / §8.3). */
export interface SeriesDataCandidate<S, Item> {
  readonly series: S;
  /** The materialized public item at the hovered slot, or null for whitespace /
   *  no-data. A `null` (or `undefined`) item is skipped, keeping the map clean. */
  readonly item: Item | null | undefined;
}

/**
 * Build the `seriesData` map (§14.2): one entry per series that has a NON-whitespace
 * item at the hovered slot, keyed by the user's handle. Whitespace / no-data
 * candidates are excluded (a null/undefined `item`). The candidate ORDER is the
 * caller's (the map preserves insertion order, matching pane/series order).
 */
export function buildSeriesData<S, Item>(
  candidates: readonly SeriesDataCandidate<S, Item>[],
): Map<S, Item> {
  const map = new Map<S, Item>();
  for (const c of candidates) {
    if (c.item !== null && c.item !== undefined) map.set(c.series, c.item);
  }
  return map;
}

// --- §14.2 HoverInfo.kind derivation -----------------------------------------------

/** How a hovered source is owned (§14.2). The api layer always knows this for its
 *  OWN sources: the series' scene source → `'series'`; a series price-line source →
 *  `'price-line'`; anything attached via `attachPrimitive` → `'primitive'`. */
export interface HoverOwnership<S> {
  readonly kind: 'series' | 'price-line' | 'primitive';
  /** The owning series handle, when the source is series-owned (series / price-line). */
  readonly series?: S;
}

/** Resolve a `HoverTarget.sourceId` to its ownership, or `null` when the target is
 *  not one of the library's own sources (then no `hoveredInfo` is reported). The
 *  create-chart wiring supplies this from its source registry (§14.2). */
export type HoverResolver<S> = (sourceId: string) => HoverOwnership<S> | null;

/**
 * Derive the `HoverInfo` for a `HoverTarget` (§14.2). `kind` comes from source
 * ownership (via `resolve`); `externalId` is the target's `externalId`
 * (`HitCandidate.externalId` for a primitive, the price-line id for a price-line) —
 * carried through verbatim, omitted when absent so equality stays clean. Returns
 * `null` when the source is unknown to the library (no `hoveredInfo` then).
 */
export function buildHoverInfo<S>(
  target: HoverTarget,
  paneIndex: number,
  resolve: HoverResolver<S>,
): HoverInfo<S> | null {
  const owner = resolve(target.sourceId);
  if (owner === null) return null;
  const info: { -readonly [K in keyof HoverInfo<S>]: HoverInfo<S>[K] } = {
    kind: owner.kind,
    paneIndex,
  };
  if (owner.series !== undefined) info.series = owner.series;
  if (target.externalId !== undefined) info.externalId = target.externalId;
  return info;
}

// --- §14.3 StoreDiff surfacing (TimeIndex → Logical brand) -------------------------

/** The public series-data event payload (§14.3) — the same five variants as the
 *  internal diff, with the `insert`/`reindex` slots surfaced as `Logical` (the
 *  internal `TimeIndex` is not public, §4.1; the numbers are identical and live on
 *  the axis `dataByIndex(logical)` consumes). */
export type StoreDiff =
  | { kind: 'replace' }
  | { kind: 'append'; count: number }
  | { kind: 'updateLast' }
  | { kind: 'insert'; atSlot: Logical }
  | { kind: 'reindex'; fromSlot: Logical };

/** Re-brand an internal `StoreDiff` (its slots are `TimeIndex`) to the public shape
 *  (slots `Logical`). A pure brand change — runtime values are identical (§14.3);
 *  for the slot-carrying variants a fresh object is returned so the public payload
 *  never aliases internal state. */
export function surfaceStoreDiff(diff: InternalStoreDiff): StoreDiff {
  switch (diff.kind) {
    case 'insert':
      return { kind: 'insert', atSlot: (diff.atSlot as number) as Logical };
    case 'reindex':
      return { kind: 'reindex', fromSlot: (diff.fromSlot as number) as Logical };
    default:
      // 'replace' | 'append' | 'updateLast' carry no slot — pass through unchanged.
      return diff;
  }
}

// --- §14.1 subscription hub: lazy build + subscribe/unsubscribe pairs ---------------

/**
 * One event channel (§14.1). Wraps a `core` Emitter to give the handle facades the
 * dual surface the spec mandates: `subscribe(h)` returns an `Unsubscribe`, AND a
 * matching `unsubscribe(h)` removes the SAME registration by handler reference; both
 * paths remove the listener. Delegate semantics (snapshot iterate, throwing listener
 * does not stop dispatch) come from the Emitter. The payload is built LAZILY — `emit`
 * invokes its thunk only when there are listeners, so a no-listener channel allocates
 * nothing per event (the 60 Hz crosshair-move requirement).
 */
export class EventHub<A extends unknown[]> {
  readonly #emitter = new Emitter<A>();
  // handler → its Emitter unsubscribe, so unsubscribe(handler) finds the registration
  // (the Emitter compares by listener identity, not handler identity).
  readonly #offs = new Map<(...args: A) => void, Unsubscribe>();

  /** Subscribe `handler`; returns an `Unsubscribe`. Re-subscribing the same handler
   *  reference is idempotent on the unsubscribe map (the latest registration wins for
   *  `unsubscribe(handler)`), matching reference by-reference comparison. */
  subscribe(handler: (...args: A) => void): Unsubscribe {
    const off = this.#emitter.subscribe(handler);
    this.#offs.set(handler, off);
    const unsub: Unsubscribe = () => {
      off();
      if (this.#offs.get(handler) === off) this.#offs.delete(handler);
    };
    return unsub;
  }

  /** Remove the registration for `handler` (reference parity, §14.1). No-op if the
   *  handler was never subscribed or already removed. */
  unsubscribe(handler: (...args: A) => void): void {
    const off = this.#offs.get(handler);
    if (off !== undefined) {
      off();
      this.#offs.delete(handler);
    }
  }

  /** True when at least one listener is registered — the gate every payload build
   *  checks first (§14.1). */
  hasListeners(): boolean {
    return this.#emitter.hasListeners();
  }

  /** Fire, building the payload LAZILY (§14.1): `build` runs only when there are
   *  listeners. Fired-then-thrown listeners do not stop dispatch (Emitter routes the
   *  error to `reportError`). */
  emit(build: () => A): void {
    this.#emitter.fireLazy(build);
  }

  /** Tear down every listener (chart dispose). */
  dispose(): void {
    this.#emitter.dispose();
    this.#offs.clear();
  }
}

// Re-export the internal-diff slot brand name for callers that bridge the two diffs.
export type { TimeIndex };
