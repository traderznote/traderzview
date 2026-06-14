// views/hit-test.ts — the ranked hit-test SERVICE (architecture §5.5; design 05
// §2.4). NOT a SceneSource: it iterates a pane's hit sources, calls each
// `source.hitTest(x, y, frame)`, collects the `HitCandidate`s, and RANKS them by
// the ONE arbitration rule — (1) priority tier: Point beats non-Point (Line vs
// Range fall through to distance); (2) min distance; (3) paint order as the final
// tie-break ONLY (visually higher source wins: higher band, then later within
// band). It returns the ranked array (the crosshair consumes [0]) plus the winning
// `HoverTarget` (a `model` plain-data shape, every field a `core` type). The host
// builds the ordered `HitSource[]` from a `PaneScene`; the ranking lives here.
import type { Coordinate } from '../core';
import type { HitCandidate, SceneSource, ViewFrame } from '../gfx';
import { HitPriority } from '../gfx';
import type { HoverTarget } from '../model';

/** One pane hit source: its `SceneSource` plus the identity the winning candidate
 *  is stamped with. The ARRAY ORDER is the paint order — ascending = visually lower
 *  first, so a LATER entry is drawn on top and wins exact (tier, distance) ties
 *  (the §2.3 `(band, ownerZ, attachSeq)` total order, materialised by the caller). */
export interface HitSource {
  readonly source: SceneSource;
  /** Stable source identity copied into `HoverTarget.sourceId`. */
  readonly sourceId: string;
  /** Owning series id, when the source is series-attached. */
  readonly seriesId?: string;
}

/** A candidate paired with the source that produced it, in ranked order. */
export interface RankedHit {
  readonly candidate: HitCandidate;
  readonly sourceId: string;
  readonly seriesId?: string;
}

/** The ranked result: candidates best-first, plus the `HoverTarget` for index 0
 *  (null when nothing was hit). */
export interface HitResult {
  readonly ranked: readonly RankedHit[];
  readonly target: HoverTarget | null;
}

/** Point sits above Line/Range; Line and Range are equal at the tier step (design
 *  05 §2.4 — they fall through to distance). */
function tier(p: HitPriority): number {
  return p === HitPriority.Point ? 1 : 0;
}

/** The §2.4 comparator over (source-paint-index, candidate). Returns < 0 when `a`
 *  ranks BEFORE `b` (a is the better hit). Total + stable: paint index is unique per
 *  source, so it is a deterministic final tie-break — never shielding a nearer or
 *  higher-priority candidate (distance is consulted before paint order). */
function compare(aPaint: number, a: HitCandidate, bPaint: number, b: HitCandidate): number {
  const ta = tier(a.priority);
  const tb = tier(b.priority);
  if (ta !== tb) return tb - ta; // higher tier first
  if (a.distance !== b.distance) return a.distance - b.distance; // nearer first
  return bPaint - aPaint; // exact tie → visually higher (larger paint index) wins
}

/**
 * Rank every source's hit candidate for the pointer at media `(x, y)`. Each source
 * is queried at most once; sources without a `hitTest` or returning `null` are
 * skipped. The result is sorted by the §2.4 comparator (best-first) and the winner
 * (index 0) is copied into a `HoverTarget`. Allocation is proportional to the number
 * of HITS, not sources — a miss-heavy pane allocates nothing beyond the empty result.
 */
export function hitTestPane(
  sources: readonly HitSource[],
  x: Coordinate,
  y: Coordinate,
  frame: ViewFrame,
): HitResult {
  // Collect (paintIndex, source, candidate) for every hit. paintIndex = array index
  // (the materialised §2.3 order); larger = visually higher.
  const hits: { paint: number; src: HitSource; cand: HitCandidate }[] = [];
  for (let i = 0; i < sources.length; i++) {
    const hs = sources[i]!;
    const cand = hs.source.hitTest?.(x, y, frame) ?? null;
    if (cand !== null) hits.push({ paint: i, src: hs, cand });
  }
  if (hits.length === 0) return EMPTY;

  hits.sort((a, b) => compare(a.paint, a.cand, b.paint, b.cand));

  const ranked: RankedHit[] = hits.map((h) => ({
    candidate: h.cand,
    sourceId: h.src.sourceId,
    seriesId: h.src.seriesId,
  }));
  return { ranked, target: toHoverTarget(ranked[0]!) };
}

/** Copy a ranked hit into the model `HoverTarget` the host hands to
 *  `crosshair.setHover` (architecture §5.5 — every field a `core` type). Optional
 *  fields are omitted (not set to `undefined`) so equality stays clean. */
export function toHoverTarget(hit: RankedHit): HoverTarget {
  const c = hit.candidate;
  const t: { -readonly [K in keyof HoverTarget]: HoverTarget[K] } = { sourceId: hit.sourceId };
  if (hit.seriesId !== undefined) t.seriesId = hit.seriesId;
  if (c.externalId !== undefined) t.externalId = c.externalId;
  if (c.cursor !== undefined) t.cursor = c.cursor;
  if (c.data !== undefined) t.data = c.data;
  return t;
}

const EMPTY: HitResult = { ranked: [], target: null };
